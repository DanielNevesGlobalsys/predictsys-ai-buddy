/**
 * ML Engineer Agent — training quality, robustness, deploy readiness, scoring consistency
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── System Prompt ───

export const ML_SYSTEM_PROMPT = `Você é o Agente Engenheiro de ML da plataforma PredictSys.
Seu papel é avaliar a qualidade técnica do treinamento, robustez do modelo, coerência de métricas, estabilidade treino/scoring e prontidão para deploy.

Responsabilidades:
- Interpretar métricas do treino por problem_type (classificação: AUC, F1, precision, recall; regressão: R², RMSE, MAE)
- Comparar modelos treinados e avaliar o vencedor
- Detectar overfit (gap treino/validação alto), underfit (métricas baixas em ambos), instabilidade
- Detectar feature dominance suspeita (>60% importância em uma feature)
- Avaliar deploy readiness: ready, warning ou blocked
- Verificar consistência treino × scoring (feature space, builder, schema)
- Sugerir melhorias técnicas concretas (revisão de features, split, target, algoritmo, dados)
- Explicar tecnicamente a performance para alimentar dashboards

Regras:
1. Métrica principal deve seguir o problem_type — não interpretar regressão com AUC
2. Distinguir "executou" de "é robusto" — treino que roda não significa modelo bom
3. Overfit e underfit devem ser explicitados com evidência numérica quando disponível
4. Não recomendar deploy com inconsistência estrutural (schema, builder, feature space)
5. Sempre apontar o principal risco técnico, mesmo quando o modelo é bom
6. Sempre sugerir próxima ação concreta

Responda SEMPRE usando a função ml_decision. Seja preciso, técnico e quantitativo.`;

// ─── Tool Schema ───

export const ML_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "ml_decision",
    description: "ML Engineer Agent structured decision",
    parameters: {
      type: "object",
      properties: {
        training_assessment: {
          type: "object",
          properties: {
            model_quality: { type: "string", enum: ["poor", "acceptable", "good", "excellent"] },
            robustness_status: { type: "string", enum: ["weak", "moderate", "strong"] },
            primary_metric_name: { type: "string" },
            primary_metric_value: { type: "number" },
            secondary_metrics: { type: "object", additionalProperties: { type: "number" } },
            metric_interpretation: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["model_quality", "robustness_status", "primary_metric_name", "primary_metric_value", "reasoning"],
        },
        overfit_underfit_assessment: {
          type: "object",
          properties: {
            overfit_signals: { type: "array", items: { type: "string" } },
            underfit_signals: { type: "array", items: { type: "string" } },
            stability_risks: { type: "array", items: { type: "string" } },
            feature_dominance_risks: { type: "array", items: { type: "string" } },
          },
        },
        deploy_readiness: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ready", "warning", "blocked"] },
            reasons: { type: "array", items: { type: "string" } },
            required_actions: { type: "array", items: { type: "string" } },
            recommended_actions: { type: "array", items: { type: "string" } },
          },
          required: ["status", "reasons"],
        },
        training_scoring_consistency: {
          type: "object",
          properties: {
            consistent: { type: "boolean" },
            builder_alignment: { type: "boolean" },
            schema_alignment: { type: "boolean" },
            feature_space_alignment: { type: "boolean" },
            issues: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["consistent"],
        },
        model_improvement_opportunities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              area: { type: "string" },
              suggestion: { type: "string" },
              expected_impact: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["area", "suggestion", "expected_impact"],
          },
        },
        technical_summary: {
          type: "object",
          properties: {
            main_strength: { type: "string" },
            main_weakness: { type: "string" },
            main_risk: { type: "string" },
            main_recommendation: { type: "string" },
          },
          required: ["main_strength", "main_weakness", "main_risk", "main_recommendation"],
        },
        confidence: { type: "number", description: "0.0 to 1.0" },
      },
      required: [
        "training_assessment",
        "deploy_readiness",
        "training_scoring_consistency",
        "technical_summary",
        "confidence",
      ],
      additionalProperties: false,
    },
  },
};

// ─── Context Builder ───

export interface MLContext {
  project_id: string;
  stage: string;
  execution_mode: string;
  official_target: string;
  official_problem_type: string;
  official_entity_key: string[];
  official_time_column: string;
  official_grain: string;
  official_split_strategy: string;
  models: unknown[];
  model_metrics: unknown[];
  feature_importances: unknown[];
  builder_version: number;
  modeling_contract: Record<string, unknown> | null;
  scoring_status: string;
  trained_feature_space: string[];
  current_scoring_feature_space: string[];
}

export async function buildMLContext(
  svc: SupabaseClient,
  projectId: string,
  stage: string,
  executionMode: string,
): Promise<MLContext> {
  const [settingsRes, selectionRes, contractRes, modelsRes, metricsRes, importancesRes, predStateRes] = await Promise.all([
    svc.from("project_settings")
      .select("builder_state, dataset_version, selection_version, scoring_state, training_state")
      .eq("project_id", projectId).maybeSingle(),
    svc.from("project_model_selection")
      .select("target_column, problem_type, selected_features, excluded_features, selection_version, entity_key, time_column, grain, split_strategy")
      .eq("project_id", projectId).maybeSingle(),
    svc.from("project_modeling_contracts")
      .select("contract, version")
      .eq("project_id", projectId)
      .order("version", { ascending: false })
      .limit(1).maybeSingle(),
    svc.from("project_models")
      .select("id, algorithm, status, is_production, hyperparameters, created_at, deployed_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(10),
    svc.from("project_model_metrics")
      .select("project_model_id, metric_name, metric_value, dataset_split")
      .eq("project_id", projectId)
      .limit(100),
    svc.from("project_feature_importances")
      .select("project_model_id, feature_name, importance_value, importance_rank")
      .eq("project_id", projectId)
      .order("importance_rank", { ascending: true })
      .limit(60),
    svc.from("project_prediction_state")
      .select("status, predictions_count, coverage_pct")
      .eq("project_id", projectId).maybeSingle(),
  ]);

  const sel = selectionRes.data as any;
  const settings = settingsRes.data as any;
  const models = (modelsRes.data || []) as any[];
  const metrics = (metricsRes.data || []) as any[];
  const imps = (importancesRes.data || []) as any[];

  const prodModel = models.find(m => m.is_production);
  const trainedFeatures: string[] = prodModel?.hyperparameters?.savedFeatureNames || [];

  return {
    project_id: projectId,
    stage,
    execution_mode: executionMode,
    official_target: sel?.target_column || "",
    official_problem_type: sel?.problem_type || "",
    official_entity_key: Array.isArray(sel?.entity_key) ? sel.entity_key : sel?.entity_key ? [sel.entity_key] : [],
    official_time_column: sel?.time_column || "",
    official_grain: sel?.grain || "",
    official_split_strategy: sel?.split_strategy || "",
    models: models.map(m => ({
      id: m.id,
      algorithm: m.algorithm,
      status: m.status,
      is_production: m.is_production,
      selection_version: m.hyperparameters?.selection_version,
      deployed_at: m.deployed_at,
    })),
    model_metrics: metrics.map(m => ({
      model_id: m.project_model_id,
      metric: m.metric_name,
      value: m.metric_value,
      split: m.dataset_split,
    })),
    feature_importances: imps.map(f => ({
      model_id: f.project_model_id,
      feature: f.feature_name,
      importance: f.importance_value,
      rank: f.importance_rank,
    })),
    builder_version: settings?.dataset_version || 0,
    modeling_contract: contractRes.data?.contract || null,
    scoring_status: predStateRes.data?.status || settings?.scoring_state || "idle",
    trained_feature_space: trainedFeatures,
    current_scoring_feature_space: Array.isArray(sel?.selected_features) ? sel.selected_features : [],
  };
}

// ─── Prompt Builder ───

export function buildMLPrompt(ctx: MLContext): string {
  return `## Contexto do Projeto (ML Engineer)

### Estado Oficial
- Target: ${ctx.official_target || "não definido"}
- Problem Type: ${ctx.official_problem_type || "não definido"}
- Entity: ${ctx.official_entity_key.join(", ") || "não definida"}
- Time Column: ${ctx.official_time_column || "não definida"}
- Grain: ${ctx.official_grain || "não definido"}
- Split Strategy: ${ctx.official_split_strategy || "não definida"}

### Modelos (${ctx.models.length} modelos)
\`\`\`json
${JSON.stringify(ctx.models, null, 2)}
\`\`\`

### Métricas
\`\`\`json
${JSON.stringify(ctx.model_metrics, null, 2)}
\`\`\`

### Feature Importances (top)
\`\`\`json
${JSON.stringify(ctx.feature_importances.slice(0, 30), null, 2)}
\`\`\`

### Builder Version: ${ctx.builder_version}
### Scoring Status: ${ctx.scoring_status}

### Trained Feature Space (${ctx.trained_feature_space.length} features)
${ctx.trained_feature_space.length > 0 ? ctx.trained_feature_space.slice(0, 40).join(", ") : "nenhuma"}

### Current Scoring Feature Space (${ctx.current_scoring_feature_space.length} features)
${ctx.current_scoring_feature_space.length > 0 ? ctx.current_scoring_feature_space.slice(0, 40).join(", ") : "nenhuma"}

### Modeling Contract
\`\`\`json
${JSON.stringify(ctx.modeling_contract, null, 2)}
\`\`\`

### Etapa Atual: ${ctx.stage}
### Modo de Execução: ${ctx.execution_mode}

Avalie a qualidade do treino, robustez, deploy readiness e consistência treino/scoring. Produza sua decisão usando a função ml_decision.`;
}

// ─── Response Validation ───

export interface MLDecision {
  training_assessment: {
    model_quality: string;
    robustness_status: string;
    primary_metric_name: string;
    primary_metric_value: number;
    secondary_metrics: Record<string, number>;
    metric_interpretation: string[];
    reasoning: string[];
  };
  overfit_underfit_assessment: {
    overfit_signals: string[];
    underfit_signals: string[];
    stability_risks: string[];
    feature_dominance_risks: string[];
  };
  deploy_readiness: {
    status: string;
    reasons: string[];
    required_actions: string[];
    recommended_actions: string[];
  };
  training_scoring_consistency: {
    consistent: boolean;
    builder_alignment: boolean;
    schema_alignment: boolean;
    feature_space_alignment: boolean;
    issues: string[];
    reasoning: string[];
  };
  model_improvement_opportunities: Array<{
    area: string;
    suggestion: string;
    expected_impact: string;
  }>;
  technical_summary: {
    main_strength: string;
    main_weakness: string;
    main_risk: string;
    main_recommendation: string;
  };
  confidence: number;
}

export function validateMLResponse(raw: unknown): MLDecision {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return fallbackML("Invalid response object");

  const ta = (r.training_assessment as any) || {};
  const ou = (r.overfit_underfit_assessment as any) || {};
  const dr = (r.deploy_readiness as any) || {};
  const tsc = (r.training_scoring_consistency as any) || {};
  const ts = (r.technical_summary as any) || {};

  const validQualities = ["poor", "acceptable", "good", "excellent"];
  const validRobust = ["weak", "moderate", "strong"];
  const validDeploy = ["ready", "warning", "blocked"];

  return {
    training_assessment: {
      model_quality: validQualities.includes(ta.model_quality) ? ta.model_quality : "poor",
      robustness_status: validRobust.includes(ta.robustness_status) ? ta.robustness_status : "weak",
      primary_metric_name: ta.primary_metric_name || "unknown",
      primary_metric_value: typeof ta.primary_metric_value === "number" ? ta.primary_metric_value : 0,
      secondary_metrics: (typeof ta.secondary_metrics === "object" && ta.secondary_metrics) ? ta.secondary_metrics : {},
      metric_interpretation: asArr(ta.metric_interpretation),
      reasoning: asArr(ta.reasoning),
    },
    overfit_underfit_assessment: {
      overfit_signals: asArr(ou.overfit_signals),
      underfit_signals: asArr(ou.underfit_signals),
      stability_risks: asArr(ou.stability_risks),
      feature_dominance_risks: asArr(ou.feature_dominance_risks),
    },
    deploy_readiness: {
      status: validDeploy.includes(dr.status) ? dr.status : "blocked",
      reasons: asArr(dr.reasons),
      required_actions: asArr(dr.required_actions),
      recommended_actions: asArr(dr.recommended_actions),
    },
    training_scoring_consistency: {
      consistent: tsc.consistent !== false,
      builder_alignment: tsc.builder_alignment !== false,
      schema_alignment: tsc.schema_alignment !== false,
      feature_space_alignment: tsc.feature_space_alignment !== false,
      issues: asArr(tsc.issues),
      reasoning: asArr(tsc.reasoning),
    },
    model_improvement_opportunities: Array.isArray(r.model_improvement_opportunities)
      ? r.model_improvement_opportunities.map((o: any) => ({
          area: String(o.area || ""),
          suggestion: String(o.suggestion || ""),
          expected_impact: ["low", "medium", "high"].includes(o.expected_impact) ? o.expected_impact : "medium",
        }))
      : [],
    technical_summary: {
      main_strength: ts.main_strength || "",
      main_weakness: ts.main_weakness || "",
      main_risk: ts.main_risk || "",
      main_recommendation: ts.main_recommendation || "",
    },
    confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0,
  };
}

function fallbackML(reason: string): MLDecision {
  return {
    training_assessment: {
      model_quality: "poor", robustness_status: "weak",
      primary_metric_name: "unknown", primary_metric_value: 0,
      secondary_metrics: {}, metric_interpretation: [], reasoning: [reason],
    },
    overfit_underfit_assessment: {
      overfit_signals: [], underfit_signals: [], stability_risks: [], feature_dominance_risks: [],
    },
    deploy_readiness: { status: "blocked", reasons: [reason], required_actions: [], recommended_actions: [] },
    training_scoring_consistency: {
      consistent: false, builder_alignment: false, schema_alignment: false,
      feature_space_alignment: false, issues: [reason], reasoning: [],
    },
    model_improvement_opportunities: [],
    technical_summary: { main_strength: "", main_weakness: reason, main_risk: reason, main_recommendation: "" },
    confidence: 0,
  };
}

function asArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}
