// ═══════════════════════════════════════════════════════════════════
// PRE — Deterministic Rules Engine
// Resolves problem_type, target, entity_key, time_anchor, grain
// ═══════════════════════════════════════════════════════════════════

import type {
  PREInputBundle,
  ProblemDefinition,
  TargetDefinition,
  TargetCandidate,
  DatasetStrategy,
  FeaturePlan,
  ResolutionValidation,
  ResolutionExplanation,
  ResolutionIssue,
  GrainType,
  TemporalStrategy,
  TargetMode,
} from "@/types/predictiveResolution";

// ─── Objective → Problem Type ──────────────────────────────────

const CLASSIFICATION_OBJECTIVES = [
  "churn", "turnover", "no_show", "default_risk", "inadimplencia",
  "propensity", "anomaly_detection", "risk_scoring", "anomaly",
];

const REGRESSION_OBJECTIVES = [
  "demand_forecast", "revenue", "ticket", "value_forecast",
  "lifetime_value", "price_optimization",
];

export function resolveProblemType(objective: string | undefined): "classification" | "regression" {
  const obj = (objective || "").toLowerCase();
  if (REGRESSION_OBJECTIVES.some(r => obj.includes(r))) return "regression";
  return "classification";
}

// ─── Entity Key Resolution ─────────────────────────────────────

const ENTITY_PATTERNS = [
  "id_cliente", "customer_id", "client_id", "cpf", "cnpj",
  "patient_id", "id_paciente", "student_id", "id_aluno",
  "employee_id", "id_funcionario", "matricula", "account_id",
  "id_conta", "contract_id", "id_contrato", "user_id",
];

const BLOCKED_ENTITY_PATTERNS = [
  "nome", "name", "email", "telefone", "phone", "endereco",
  "address", "descricao", "description", "observacao", "obs",
];

export function resolveEntityKey(
  columns: Array<{ column_name: string; inferred_type: string }>,
  contractHints?: { entity_granularity?: string; entity_label?: string; has_entity_id?: boolean | string },
  tdeProfile?: any,
  modelSelection?: any,
): { entity_key: string | null; confidence: number; reasoning: string } {
  // 1. Existing model selection
  if (modelSelection?.entity_key) {
    return { entity_key: modelSelection.entity_key, confidence: 0.9, reasoning: "Herdado da seleção existente." };
  }

  // 2. TDE profile
  if (tdeProfile?.entity_key_candidates?.length) {
    const top = tdeProfile.entity_key_candidates[0];
    if (typeof top === "string") {
      return { entity_key: top, confidence: 0.8, reasoning: "Sugerido pelo TDE profile." };
    }
    if (top?.column) {
      return { entity_key: top.column, confidence: 0.8, reasoning: "Sugerido pelo TDE profile." };
    }
  }

  // 3. Pattern matching on columns
  const colNames = columns.map(c => c.column_name.toLowerCase());
  for (const pattern of ENTITY_PATTERNS) {
    const match = colNames.find(c => c.includes(pattern));
    if (match) {
      const original = columns.find(c => c.column_name.toLowerCase() === match);
      return {
        entity_key: original?.column_name || match,
        confidence: 0.7,
        reasoning: `Detectado por padrão de nomenclatura: ${pattern}.`,
      };
    }
  }

  return { entity_key: null, confidence: 0, reasoning: "Nenhum entity_key detectado automaticamente." };
}

// ─── Time Anchor Resolution ────────────────────────────────────

const TIME_PATTERNS = [
  "data_ref", "dt_ref", "reference_date", "data_referencia",
  "created_at", "data_criacao", "data_cadastro", "data_compra",
  "order_date", "purchase_date", "data_pedido", "data_evento",
  "event_date", "dt_evento", "data_internacao", "admission_date",
  "hire_date", "data_admissao", "data_contrato",
];

const BLOCKED_TIME_PATTERNS = [
  "data_cancelamento", "cancellation_date", "data_obito",
  "death_date", "data_encerramento", "close_date",
  "data_saida", "exit_date", "termination_date",
];

export function resolveTimeAnchor(
  columns: Array<{ column_name: string; inferred_type: string }>,
  contractHints?: any,
  tdeProfile?: any,
): { time_anchor: string | null; confidence: number; reasoning: string } {
  // Check TDE profile first
  if (tdeProfile?.time_anchor_candidates?.length) {
    const top = tdeProfile.time_anchor_candidates[0];
    const col = typeof top === "string" ? top : top?.column;
    if (col) {
      return { time_anchor: col, confidence: 0.8, reasoning: "Sugerido pelo TDE profile." };
    }
  }

  // Pattern matching
  const dateColumns = columns.filter(c =>
    ["date", "datetime", "timestamp", "temporal"].includes((c.inferred_type || "").toLowerCase())
  );

  for (const pattern of TIME_PATTERNS) {
    const match = dateColumns.find(c => c.column_name.toLowerCase().includes(pattern));
    if (match) {
      // Check it's not blocked
      if (BLOCKED_TIME_PATTERNS.some(b => match.column_name.toLowerCase().includes(b))) continue;
      return {
        time_anchor: match.column_name,
        confidence: 0.7,
        reasoning: `Detectado por padrão: ${pattern}.`,
      };
    }
  }

  // Fallback: first date column not blocked
  for (const col of dateColumns) {
    if (!BLOCKED_TIME_PATTERNS.some(b => col.column_name.toLowerCase().includes(b))) {
      return {
        time_anchor: col.column_name,
        confidence: 0.5,
        reasoning: `Primeira coluna temporal encontrada: ${col.column_name}.`,
      };
    }
  }

  return { time_anchor: null, confidence: 0, reasoning: "Nenhuma âncora temporal detectada." };
}

// ─── Target Resolution ─────────────────────────────────────────

const LEAKAGE_TOKENS = [
  "status_final", "resultado", "outcome", "target", "label",
  "churn", "churned", "cancelled", "cancelado", "inadimplente",
  "defaulted", "saiu", "left", "exited", "obito", "death",
];

export function resolveTarget(
  columns: Array<{ column_name: string; inferred_type: string }>,
  problemType: "classification" | "regression",
  contractHints?: any,
  tdeProfile?: any,
  edaProfile?: any,
  modelSelection?: any,
): TargetDefinition {
  const candidates: TargetCandidate[] = [];
  const rulesTriggered: string[] = [];

  // 1. Explicit from contract
  if (contractHints?.has_outcome_column === true && contractHints?.outcome_column_name) {
    const col = columns.find(c =>
      c.column_name.toLowerCase() === contractHints.outcome_column_name.toLowerCase()
    );
    if (col) {
      candidates.push({
        column: col.column_name,
        score: 0.95,
        mode: "explicit",
        reasoning: "Declarado explicitamente no contrato de intenção.",
        business_fit: 1, semantic_fit: 0.9, temporal_fit: 0.9,
        trainability_fit: 0.9, leakage_penalty: 0,
      });
      rulesTriggered.push("CONTRACT_EXPLICIT_TARGET");
    }
  }

  // 2. Existing model selection
  if (modelSelection?.target_column) {
    const col = columns.find(c => c.column_name === modelSelection.target_column);
    if (col && !candidates.some(c => c.column === col.column_name)) {
      candidates.push({
        column: col.column_name,
        score: 0.9,
        mode: "explicit",
        reasoning: "Herdado da seleção de modelo existente.",
        business_fit: 0.8, semantic_fit: 0.9, temporal_fit: 0.8,
        trainability_fit: 0.9, leakage_penalty: 0,
      });
      rulesTriggered.push("MODEL_SELECTION_INHERITED");
    }
  }

  // 3. TDE candidates
  if (tdeProfile?.target_candidates?.length) {
    for (const tc of tdeProfile.target_candidates.slice(0, 5)) {
      const colName = typeof tc === "string" ? tc : tc?.column || tc?.name;
      if (!colName || candidates.some(c => c.column === colName)) continue;
      const col = columns.find(c => c.column_name === colName);
      if (!col) continue;

      const leakPenalty = LEAKAGE_TOKENS.some(t => colName.toLowerCase().includes(t)) ? 0.3 : 0;
      candidates.push({
        column: colName,
        score: (tc?.score || 0.6) - leakPenalty,
        mode: "explicit",
        reasoning: `Sugerido pelo TDE: ${tc?.reason || "candidato detectado"}.`,
        business_fit: tc?.business_fit || 0.6,
        semantic_fit: tc?.semantic_fit || 0.6,
        temporal_fit: tc?.temporal_fit || 0.5,
        trainability_fit: tc?.trainability_fit || 0.6,
        leakage_penalty: leakPenalty,
      });
    }
  }

  // 4. Heuristic scan for binary columns (classification)
  if (problemType === "classification" && candidates.length < 3) {
    for (const col of columns) {
      if (candidates.some(c => c.column === col.column_name)) continue;
      const name = col.column_name.toLowerCase();
      const type = (col.inferred_type || "").toLowerCase();

      // Look for boolean / binary columns
      if (type === "boolean" || name.includes("flag") || name.includes("is_")) {
        const leakPenalty = LEAKAGE_TOKENS.some(t => name.includes(t)) ? 0.4 : 0;
        candidates.push({
          column: col.column_name,
          score: 0.5 - leakPenalty,
          mode: "explicit",
          reasoning: "Coluna binária detectada por heurística.",
          business_fit: 0.4, semantic_fit: 0.5, temporal_fit: 0.3,
          trainability_fit: 0.6, leakage_penalty: leakPenalty,
        });
      }
    }
  }

  // Sort by score
  candidates.sort((a, b) => b.score - a.score);

  const THRESHOLD = 0.6;
  const best = candidates[0];

  if (!best || best.score < THRESHOLD) {
    return {
      mode: "blocked",
      target_name: null,
      target_source_column: null,
      target_rule: null,
      target_kind: "unknown",
      target_confidence: 0,
      target_reasoning: "Nenhum target com confiança suficiente foi encontrado. Defina manualmente.",
      alternatives: candidates,
    };
  }

  return {
    mode: best.mode,
    target_name: best.column,
    target_source_column: best.column,
    target_rule: best.reasoning,
    target_kind: problemType === "regression" ? "continuous" : "binary",
    target_confidence: best.score,
    target_reasoning: best.reasoning,
    alternatives: candidates.slice(1),
  };
}

// ─── Grain Resolution ──────────────────────────────────────────

export function resolveGrain(
  dataShape: string,
  problemType: "classification" | "regression",
  objective: string,
  hasTimeAnchor: boolean,
  hasEntityKey: boolean,
): { grain: GrainType; reasoning: string } {
  const obj = (objective || "").toLowerCase();

  if (["churn", "turnover", "no_show", "default_risk", "inadimplencia"].some(o => obj.includes(o))) {
    if (hasEntityKey && hasTimeAnchor) {
      return { grain: "entity_time", reasoning: "Problema de evento futuro por entidade com âncora temporal." };
    }
    if (hasEntityKey) {
      return { grain: "entity_time", reasoning: "Problema por entidade — grain entity_time assumido." };
    }
  }

  if (["demand_forecast", "revenue", "value_forecast"].some(o => obj.includes(o))) {
    return {
      grain: hasEntityKey ? "entity_product_time" : "entity_time",
      reasoning: "Forecast de valor/volume — grain temporal necessário.",
    };
  }

  if (dataShape === "multiple_rows_per_entity" && hasEntityKey) {
    return { grain: "aggregated", reasoning: "Dataset transacional precisa de agregação por entidade." };
  }

  if (dataShape === "one_row_per_entity") {
    return { grain: "original_row", reasoning: "Uma linha por entidade — sem agregação necessária." };
  }

  return { grain: "original_row", reasoning: "Grain padrão: uma observação por linha." };
}

// ─── Dataset Strategy ──────────────────────────────────────────

export function resolveDatasetStrategy(
  grain: GrainType,
  hasTimeAnchor: boolean,
  dataShape: string,
): DatasetStrategy {
  const needsAgg = grain === "aggregated" || grain === "entity_product_time";
  const snapshotRequired = grain === "entity_time" && hasTimeAnchor && dataShape === "multiple_rows_per_entity";

  let temporal: TemporalStrategy = "none";
  if (snapshotRequired) temporal = "multi_period";
  else if (hasTimeAnchor) temporal = "snapshot";

  return {
    needs_aggregation: needsAgg,
    aggregation_level: needsAgg ? "entity" : null,
    snapshot_required: snapshotRequired,
    temporal_strategy: temporal,
    multi_table_strategy: null,
    split_suggestion: hasTimeAnchor ? "temporal" : "stratified",
  };
}

// ─── Feature Plan ──────────────────────────────────────────────

export function resolveFeaturePlan(
  columns: Array<{ column_name: string; inferred_type: string }>,
  targetColumn: string | null,
  entityKey: string | null,
  timeAnchor: string | null,
  businessRules?: any,
): FeaturePlan {
  const forbidden = new Set<string>(businessRules?.forbidden_features || []);
  const knownLeakage = new Set<string>(businessRules?.known_leakage_columns || []);
  const mandatory = new Set<string>(businessRules?.mandatory_features || []);

  const blocked: string[] = [];
  const leakageFlags: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];

  for (const col of columns) {
    const name = col.column_name;
    const lower = name.toLowerCase();

    // Never include target, entity key, or time anchor as features
    if (name === targetColumn || name === entityKey || name === timeAnchor) {
      exclude.push(name);
      continue;
    }

    // Business forbidden
    if (forbidden.has(name)) {
      blocked.push(name);
      continue;
    }

    // Known leakage
    if (knownLeakage.has(name)) {
      leakageFlags.push(name);
      blocked.push(name);
      continue;
    }

    // Heuristic leakage
    if (LEAKAGE_TOKENS.some(t => lower.includes(t)) && name !== targetColumn) {
      leakageFlags.push(name);
      exclude.push(name);
      continue;
    }

    // Block IDs, names, emails
    if (BLOCKED_ENTITY_PATTERNS.some(p => lower.includes(p))) {
      exclude.push(name);
      continue;
    }

    include.push(name);
  }

  // Add mandatory back
  for (const m of mandatory) {
    if (!include.includes(m) && !blocked.includes(m)) {
      include.push(m);
    }
  }

  return {
    include_features: include,
    exclude_features: exclude,
    blocked_features: blocked,
    leakage_flags: leakageFlags,
    feature_reasoning: `${include.length} features incluídas, ${exclude.length} excluídas, ${blocked.length} bloqueadas, ${leakageFlags.length} com risco de leakage.`,
  };
}

// ─── Validation ────────────────────────────────────────────────

export function validateResolution(
  problem: ProblemDefinition,
  target: TargetDefinition,
  entityResult: { entity_key: string | null },
  timeResult: { time_anchor: string | null },
  grain: GrainType,
): ResolutionValidation {
  const issues: ResolutionIssue[] = [];
  const blocking: string[] = [];

  // Entity key check
  if (!entityResult.entity_key) {
    issues.push({
      code: "NO_ENTITY_KEY",
      severity: "warn",
      message: "Nenhum identificador de entidade detectado.",
      suggestion: "Selecione manualmente a coluna que identifica cada entidade.",
    });
  }

  // Target check
  if (target.mode === "blocked") {
    issues.push({
      code: "NO_TARGET",
      severity: "block",
      message: "Nenhum target válido encontrado.",
      suggestion: "Defina o target manualmente ou use um template de derivação.",
    });
    blocking.push("NO_TARGET");
  }

  // Time anchor for temporal problems
  const needsTime = ["entity_time", "entity_product_time"].includes(grain);
  if (needsTime && !timeResult.time_anchor) {
    issues.push({
      code: "NO_TIME_ANCHOR",
      severity: "block",
      message: "Problema temporal sem âncora de tempo detectada.",
      suggestion: "Selecione a coluna temporal do dataset.",
    });
    blocking.push("NO_TIME_ANCHOR");
  }

  // Leakage on target
  if (target.target_name) {
    const lower = target.target_name.toLowerCase();
    if (LEAKAGE_TOKENS.some(t => lower.includes(t))) {
      issues.push({
        code: "TARGET_LEAKAGE_RISK",
        severity: "warn",
        message: `Target "${target.target_name}" pode conter vazamento de informação.`,
        suggestion: "Verifique se esta coluna seria conhecida antes do evento.",
      });
    }
  }

  // Low confidence
  if (target.target_confidence < 0.5 && target.mode !== "blocked") {
    issues.push({
      code: "LOW_TARGET_CONFIDENCE",
      severity: "warn",
      message: "Confiança baixa na definição do target.",
      suggestion: "Revise a coluna alvo manualmente.",
    });
  }

  return {
    training_ready: blocking.length === 0,
    issues_detected: issues,
    blocking_errors: blocking,
  };
}

// ─── Explanation ───────────────────────────────────────────────

export function buildExplanation(
  problem: ProblemDefinition,
  target: TargetDefinition,
  grain: GrainType,
  objective: string,
): ResolutionExplanation {
  return {
    why_this_problem: problem.problem_type === "classification"
      ? `O objetivo "${objective}" envolve prever um evento (sim/não), portanto classificação binária.`
      : `O objetivo "${objective}" envolve prever um valor numérico, portanto regressão.`,
    why_this_target: target.target_reasoning,
    why_this_grain: `Grain "${grain}" foi selecionado com base na estrutura do dataset e no tipo de problema.`,
    main_risks: [
      ...(target.mode === "blocked" ? ["Sem target definido — pipeline bloqueado."] : []),
      ...(problem.time_anchor === null ? ["Sem âncora temporal — limitações em problemas temporais."] : []),
      ...(problem.entity.entity_key === null ? ["Sem entity key — não é possível agregar por entidade."] : []),
    ],
  };
}
