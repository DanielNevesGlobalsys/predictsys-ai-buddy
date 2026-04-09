// ═══════════════════════════════════════════════════════════════════
// PRE — Confidence Scoring
// Computes overall confidence and per-dimension scores
// ═══════════════════════════════════════════════════════════════════

import type {
  PREInputBundle,
  PredictiveResolution,
  ResolutionConfidence,
  ProblemDefinition,
  TargetDefinition,
  GrainType,
} from "@/types/predictiveResolution";

export function computeConfidence(
  problem: ProblemDefinition,
  target: TargetDefinition,
  grain: GrainType,
  hasTimeAnchor: boolean,
  hasEntityKey: boolean,
  contractExists: boolean,
): ResolutionConfidence {
  // Problem fit: how well the objective maps to a problem type
  let problemFit = 0.5;
  if (contractExists) problemFit += 0.3;
  if (problem.problem_type) problemFit += 0.2;
  problemFit = Math.min(problemFit, 1);

  // Target fit
  let targetFit = target.target_confidence;

  // Grain fit
  let grainFit = 0.5;
  if (hasEntityKey && hasTimeAnchor) grainFit = 0.9;
  else if (hasEntityKey) grainFit = 0.7;
  else if (grain === "original_row") grainFit = 0.6;

  // Time fit
  let timeFit = 0.5;
  if (hasTimeAnchor) timeFit = 0.9;
  else if (!["entity_time", "entity_product_time"].includes(grain)) timeFit = 0.7;

  const overall = (problemFit * 0.2 + targetFit * 0.4 + grainFit * 0.2 + timeFit * 0.2);

  return {
    overall: Math.round(overall * 100) / 100,
    scores: {
      problem_fit: Math.round(problemFit * 100) / 100,
      target_fit: Math.round(targetFit * 100) / 100,
      grain_fit: Math.round(grainFit * 100) / 100,
      time_fit: Math.round(timeFit * 100) / 100,
    },
  };
}

// ─── Full Resolution Builder ───────────────────────────────────

import {
  resolveProblemType,
  resolveEntityKey,
  resolveTimeAnchor,
  resolveTarget,
  resolveGrain,
  resolveDatasetStrategy,
  resolveFeaturePlan,
  validateResolution,
  buildExplanation,
} from "./predictiveResolutionRules";

export function buildPredictiveResolution(input: PREInputBundle): PredictiveResolution {
  const contract = input.intent_contract_v3;
  const columns = input.project_columns || [];
  const rulesTriggered: string[] = [];
  const inputsUsed: string[] = [];

  if (contract) inputsUsed.push("intent_contract_v3");
  if (input.business_intent_contract) inputsUsed.push("business_intent_contract");
  if (input.eda_profile_json) inputsUsed.push("eda_profile_json");
  if (input.tde_profile) inputsUsed.push("tde_profile");
  if (input.model_selection) inputsUsed.push("model_selection");
  if (columns.length > 0) inputsUsed.push("project_columns");
  if (input.dataset_sample) inputsUsed.push("dataset_sample");
  if (input.dataset_state) inputsUsed.push("dataset_state");

  // 1. Problem type — pass industry for agro override
  const objective = contract?.prediction_request?.objective
    || input.business_intent_contract?.objective
    || "generic_prediction";
  const industry = contract?.business_context?.industry
    || input.business_intent_contract?.industry
    || "";
  const problemType = resolveProblemType(objective, industry);
  rulesTriggered.push(`PROBLEM_TYPE_${problemType.toUpperCase()}`);
  if (industry) rulesTriggered.push(`INDUSTRY_${industry.toUpperCase()}`);

  // 2. Entity key
  const entityResult = resolveEntityKey(
    columns,
    contract?.prediction_request,
    input.tde_profile,
    input.model_selection,
  );
  if (entityResult.entity_key) rulesTriggered.push("ENTITY_KEY_RESOLVED");

  // 3. Time anchor
  const timeResult = resolveTimeAnchor(columns, contract, input.tde_profile);
  if (timeResult.time_anchor) rulesTriggered.push("TIME_ANCHOR_RESOLVED");

  // 4. Target — pass industry + objective for agro domain scoring
  const targetDef = resolveTarget(
    columns,
    problemType,
    contract?.data_expectations,
    input.tde_profile,
    input.eda_profile_json,
    input.model_selection,
    industry,
    objective,
  );
  rulesTriggered.push(`TARGET_MODE_${targetDef.mode.toUpperCase()}`);

  // 5. Data shape
  const dataShape = contract?.data_expectations?.expected_data_shape || "unknown";

  // 6. Grain
  const { grain, reasoning: grainReasoning } = resolveGrain(
    dataShape,
    problemType,
    objective,
    !!timeResult.time_anchor,
    !!entityResult.entity_key,
  );
  rulesTriggered.push(`GRAIN_${grain.toUpperCase()}`);

  // 7. Dataset strategy
  const datasetStrategy = resolveDatasetStrategy(grain, !!timeResult.time_anchor, dataShape);

  // 8. Feature plan
  const featurePlan = resolveFeaturePlan(
    columns,
    targetDef.target_name,
    entityResult.entity_key,
    timeResult.time_anchor,
    contract?.business_rules,
  );

  // 9. Horizon
  const horizonDays = contract?.prediction_request?.horizon?.value
    ? convertToHorizonDays(
        contract.prediction_request.horizon.value,
        contract.prediction_request.horizon.unit,
      )
    : 30;

  // Build problem definition
  const problemDef: ProblemDefinition = {
    problem_type: problemType,
    business_mode: objective,
    entity: {
      entity_key: entityResult.entity_key,
      grain,
      entity_label: contract?.prediction_request?.entity_label
        || contract?.prediction_request?.entity_granularity
        || "entidade",
    },
    dataset_shape_detected: dataShape,
    time_anchor: timeResult.time_anchor,
    horizon_days: horizonDays,
  };

  // 10. Validation
  const validation = validateResolution(problemDef, targetDef, entityResult, timeResult, grain);

  // 11. Explanation
  const explanation = buildExplanation(problemDef, targetDef, grain, objective);

  // 12. Confidence
  const confidence = computeConfidence(
    problemDef,
    targetDef,
    grain,
    !!timeResult.time_anchor,
    !!entityResult.entity_key,
    !!contract,
  );

  return {
    version: 1,
    mode: input.mode,
    problem_definition: problemDef,
    target_definition: targetDef,
    dataset_strategy: datasetStrategy,
    feature_plan: featurePlan,
    validation,
    explanation,
    confidence,
    inputs_used: inputsUsed,
    rules_triggered: rulesTriggered,
    created_at: new Date().toISOString(),
  };
}

function convertToHorizonDays(value: number, unit?: string): number {
  switch (unit) {
    case "weeks": return value * 7;
    case "months": return value * 30;
    default: return value;
  }
}
