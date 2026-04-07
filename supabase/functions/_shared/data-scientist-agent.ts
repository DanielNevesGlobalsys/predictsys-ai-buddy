/**
 * LIS AI OS — Data Scientist Agent
 * Formulates the predictive problem: target, problem_type, entity, time, grain, split, features.
 */

// ─── System Prompt ───

export const DS_SYSTEM_PROMPT = `Você é o Agente Cientista de Dados da plataforma PredictSys.
Seu papel é formular corretamente o problema preditivo e orientar tecnicamente a modelagem.

RESPONSABILIDADES CENTRAIS:

1. FORMULAÇÃO DO PROBLEMA
   - Interpretar a pergunta/intenção de negócio
   - Classificar objective_family (churn, demand, risk, scoring, ltv, propensity, anomaly, forecasting, other)
   - Definir problem_type (classification ou regression)
   - Definir business_mode (preventivo, reativo, exploratório, operacional)
   - Definir target_strategy (explicit, derived, weak_label, proxy)
   - Definir prediction_unit e decision_unit

2. RECOMENDAÇÃO DE TARGET
   - Sugerir o melhor target com base nos dados e contexto de negócio
   - Classificar target_kind: explicit (coluna direta), derived (calculado), weak (label fraco), invalid
   - Justificar tecnicamente por que esse target e não outro
   - Oferecer alternativas quando confiança < 0.8

3. ENTITY / TIME / GRAIN / SPLIT
   - Sugerir entity_key com base na unidade de decisão
   - Sugerir time_column com base em colunas temporais detectadas
   - Sugerir grain: original_row, entity_snapshot, entity_time, entity_event
   - Sugerir split_strategy: temporal, random, stratified, group
   - Justificar cada escolha

4. FEATURES
   - Recomendar features relevantes para o problema
   - Identificar features a bloquear (leakage, identifiers, constants)
   - Identificar features com risco de leakage
   - Identificar features de baixo valor preditivo
   - Justificar

5. RISCOS DE MODELAGEM
   - Target mal formulado (numérico contínuo como classificação, etc.)
   - Grain incoerente com a unidade de decisão
   - Split inadequado (temporal sem time, random com dados temporais)
   - Entity fraca ou ausente
   - Over-reliance em colunas problemáticas

6. ALTERNATIVAS
   - Quando confiança < 0.8, propor alternativas viáveis

REGRAS ABSOLUTAS:
- A pergunta de negócio GUIA o problema técnico, não apenas a forma das colunas
- Nunca promover automaticamente estado incompatível — apenas sugerir
- Grain deve seguir a unidade de decisão de negócio
- Nunca recomendar target sem justificativa forte
- Features não são só colunas correlacionadas — considerar relevância de negócio, leakage, estabilidade
- Se houver incerteza, devolver alternativas

Responda SEMPRE usando a função ds_decision com o schema estruturado fornecido.
Seja preciso, técnico e bem fundamentado.`;

// ─── Tool Schema ───

export const DS_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "ds_decision",
    description: "Structured Data Scientist agent decision for predictive problem formulation",
    parameters: {
      type: "object",
      properties: {
        problem_formulation: {
          type: "object",
          properties: {
            objective_family: {
              type: "string",
              enum: ["churn", "demand", "risk", "scoring", "ltv", "propensity", "anomaly", "forecasting", "other"],
            },
            problem_type: { type: "string", enum: ["classification", "regression"] },
            business_mode: { type: "string", enum: ["preventivo", "reativo", "exploratorio", "operacional"] },
            target_strategy: { type: "string", enum: ["explicit", "derived", "weak_label", "proxy"] },
            prediction_unit: { type: "string", description: "What is being predicted (e.g. cliente, transação, produto)" },
            decision_unit: { type: "string", description: "What unit the business decision acts on" },
          },
          required: ["objective_family", "problem_type", "business_mode", "target_strategy", "prediction_unit", "decision_unit"],
        },
        target_recommendation: {
          type: "object",
          properties: {
            recommended_target: { type: "string" },
            target_kind: { type: "string", enum: ["explicit", "derived", "weak", "invalid"] },
            target_reasoning: { type: "array", items: { type: "string" } },
            target_alternatives: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  problem_type: { type: "string" },
                  reasoning: { type: "string" },
                },
                required: ["column", "problem_type", "reasoning"],
              },
            },
            target_confidence: { type: "number" },
          },
          required: ["recommended_target", "target_kind", "target_reasoning", "target_alternatives", "target_confidence"],
        },
        entity_time_grain_recommendation: {
          type: "object",
          properties: {
            recommended_entity_key: { type: "array", items: { type: "string" } },
            recommended_time_column: { type: "string" },
            recommended_grain: { type: "string", enum: ["original_row", "entity_snapshot", "entity_time", "entity_event"] },
            recommended_split_strategy: { type: "string", enum: ["temporal", "random", "stratified", "group"] },
            reasoning: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
          },
          required: ["recommended_entity_key", "recommended_time_column", "recommended_grain", "recommended_split_strategy", "reasoning", "confidence"],
        },
        feature_reasoning: {
          type: "object",
          properties: {
            recommended_features: { type: "array", items: { type: "string" } },
            blocked_features: { type: "array", items: { type: "string" } },
            warning_features: { type: "array", items: { type: "string" } },
            leakage_risk_features: { type: "array", items: { type: "string" } },
            low_value_features: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["recommended_features", "blocked_features", "warning_features", "leakage_risk_features", "low_value_features", "reasoning"],
        },
        modeling_risk_assessment: {
          type: "object",
          properties: {
            target_risks: { type: "array", items: { type: "string" } },
            grain_risks: { type: "array", items: { type: "string" } },
            split_risks: { type: "array", items: { type: "string" } },
            data_risks: { type: "array", items: { type: "string" } },
            general_risks: { type: "array", items: { type: "string" } },
          },
          required: ["target_risks", "grain_risks", "split_risks", "data_risks", "general_risks"],
        },
        alternatives: {
          type: "object",
          properties: {
            alternative_targets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  problem_type: { type: "string" },
                  reasoning: { type: "string" },
                },
                required: ["column", "problem_type", "reasoning"],
              },
            },
            alternative_grains: { type: "array", items: { type: "string" } },
            alternative_splits: { type: "array", items: { type: "string" } },
            alternative_problem_types: { type: "array", items: { type: "string" } },
          },
          required: ["alternative_targets", "alternative_grains", "alternative_splits", "alternative_problem_types"],
        },
        actions_recommended: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              target: { type: "string" },
              priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
              auto_applicable: { type: "boolean" },
            },
            required: ["action", "target", "priority", "auto_applicable"],
          },
        },
        confidence: { type: "number", description: "Overall confidence 0.0 to 1.0" },
      },
      required: [
        "problem_formulation", "target_recommendation",
        "entity_time_grain_recommendation", "feature_reasoning",
        "modeling_risk_assessment", "alternatives",
        "actions_recommended", "confidence",
      ],
      additionalProperties: false,
    },
  },
};

// ─── Context Interface ───

export interface DSContext {
  project_id: string;
  stage: string;
  execution_mode: string;
  // Official state
  official_target: string | null;
  official_problem_type: string | null;
  official_entity_key: string[];
  official_time_column: string | null;
  official_grain: string | null;
  official_split_strategy: string | null;
  // Dataset info
  columns: Array<{ name: string; dtype: string; nullPct: number; unique: number }>;
  row_count: number;
  col_count: number;
  // EDA profile
  eda_summary: Record<string, unknown>;
  // Current features
  features_current: string[];
  blocked_features: string[];
  leakage_flags: string[];
  // Intent
  intent_summary: string | null;
  // Candidates
  target_candidates: string[];
}

// ─── Context Builder ───

export async function buildDSContext(
  svc: any,
  projectId: string,
  stage: string,
  executionMode: string,
): Promise<DSContext> {
  const [settingsRes, selectionRes, columnsRes, aiCtxRes, datasetStateRes] = await Promise.all([
    svc.from("project_settings")
      .select("ingestion_rows_detected, ingestion_cols_detected, eda_profile_json")
      .eq("project_id", projectId)
      .maybeSingle(),
    svc.from("project_model_selection")
      .select("target_column, problem_type, selected_features, excluded_features, entity_key, time_column, grain, split_strategy, leakage_columns, blocked_features")
      .eq("project_id", projectId)
      .maybeSingle(),
    svc.from("project_columns")
      .select("column_name, inferred_type, null_percentage, unique_count")
      .eq("project_id", projectId),
    svc.from("project_ai_context")
      .select("context")
      .eq("project_id", projectId)
      .maybeSingle(),
    svc.from("project_dataset_state")
      .select("row_count, col_count")
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);

  const sel = selectionRes.data || {};
  const cols = (columnsRes.data || []).map((c: any) => ({
    name: c.column_name,
    dtype: c.inferred_type || "unknown",
    nullPct: c.null_percentage ?? 0,
    unique: c.unique_count ?? 0,
  }));

  const ps = settingsRes.data || {};
  const ds = datasetStateRes.data || {};
  const aiCtx = aiCtxRes.data?.context || {};

  const selectedFeatures: string[] = Array.isArray(sel.selected_features)
    ? sel.selected_features
    : [];
  const blockedFeatures: string[] = Array.isArray(sel.blocked_features)
    ? sel.blocked_features : [];
  const leakageCols: string[] = Array.isArray(sel.leakage_columns)
    ? sel.leakage_columns : [];

  let entityKey: string[] = [];
  if (sel.entity_key) {
    entityKey = Array.isArray(sel.entity_key) ? sel.entity_key : [sel.entity_key];
  }

  // Extract target candidates from AI context or column inference
  const targetCandidates: string[] = [];
  if (aiCtx.target_candidates) {
    targetCandidates.push(...(Array.isArray(aiCtx.target_candidates) ? aiCtx.target_candidates : []));
  }

  return {
    project_id: projectId,
    stage,
    execution_mode: executionMode,
    official_target: sel.target_column || null,
    official_problem_type: sel.problem_type || null,
    official_entity_key: entityKey,
    official_time_column: sel.time_column || null,
    official_grain: sel.grain || null,
    official_split_strategy: sel.split_strategy || null,
    columns: cols,
    row_count: ds.row_count || ps.ingestion_rows_detected || 0,
    col_count: ds.col_count || ps.ingestion_cols_detected || 0,
    eda_summary: ps.eda_profile_json || {},
    features_current: selectedFeatures,
    blocked_features: [...new Set([...blockedFeatures, ...leakageCols])],
    leakage_flags: leakageCols,
    intent_summary: (aiCtx as any).intent_summary || (aiCtx as any).business_question || null,
    target_candidates: targetCandidates,
  };
}

// ─── Prompt Builder ───

export function buildDSPrompt(ctx: DSContext): string {
  const colSummary = ctx.columns.slice(0, 60).map(c =>
    `  ${c.name} (${c.dtype}, null=${c.nullPct}%, unique=${c.unique})`
  ).join("\n");

  return `## Contexto do Projeto

### Dataset
- Linhas: ${ctx.row_count}
- Colunas: ${ctx.col_count}

### Colunas do Dataset (${ctx.columns.length} total)
${colSummary}${ctx.columns.length > 60 ? "\n  ... (truncado)" : ""}

### Estado Oficial Atual
- Target oficial: ${ctx.official_target || "não definido"}
- Problem type oficial: ${ctx.official_problem_type || "não definido"}
- Entity key: ${ctx.official_entity_key.length > 0 ? ctx.official_entity_key.join(", ") : "não definida"}
- Time column: ${ctx.official_time_column || "não definida"}
- Grain: ${ctx.official_grain || "não definido"}
- Split strategy: ${ctx.official_split_strategy || "não definida"}

### Features Atuais
- Selecionadas (${ctx.features_current.length}): ${ctx.features_current.slice(0, 30).join(", ") || "nenhuma"}${ctx.features_current.length > 30 ? "..." : ""}
- Bloqueadas/leakage (${ctx.blocked_features.length}): ${ctx.blocked_features.join(", ") || "nenhuma"}

### Intenção de Negócio
${ctx.intent_summary || "Não definida pelo usuário. Inferir a partir dos dados."}

### Candidatos a Target
${ctx.target_candidates.length > 0 ? ctx.target_candidates.join(", ") : "Nenhum sugerido anteriormente"}

### EDA Summary
${Object.keys(ctx.eda_summary).length > 0 ? JSON.stringify(ctx.eda_summary, null, 2).slice(0, 2000) : "EDA não executada ainda"}

## Etapa Atual: ${ctx.stage}
## Modo de Execução: ${ctx.execution_mode}

Analise o dataset, o contexto de negócio e o estado atual.
Formule o problema preditivo e produza sua decisão usando a função ds_decision.
Justifique cada escolha tecnicamente.`;
}

// ─── Response Validation ───

export interface DSDecision {
  problem_formulation: {
    objective_family: string;
    problem_type: string;
    business_mode: string;
    target_strategy: string;
    prediction_unit: string;
    decision_unit: string;
  };
  target_recommendation: {
    recommended_target: string;
    target_kind: string;
    target_reasoning: string[];
    target_alternatives: Array<{ column: string; problem_type: string; reasoning: string }>;
    target_confidence: number;
  };
  entity_time_grain_recommendation: {
    recommended_entity_key: string[];
    recommended_time_column: string;
    recommended_grain: string;
    recommended_split_strategy: string;
    reasoning: string[];
    confidence: number;
  };
  feature_reasoning: {
    recommended_features: string[];
    blocked_features: string[];
    warning_features: string[];
    leakage_risk_features: string[];
    low_value_features: string[];
    reasoning: string[];
  };
  modeling_risk_assessment: {
    target_risks: string[];
    grain_risks: string[];
    split_risks: string[];
    data_risks: string[];
    general_risks: string[];
  };
  alternatives: {
    alternative_targets: Array<{ column: string; problem_type: string; reasoning: string }>;
    alternative_grains: string[];
    alternative_splits: string[];
    alternative_problem_types: string[];
  };
  actions_recommended: Array<{
    action: string;
    target: string;
    priority: string;
    auto_applicable: boolean;
  }>;
  confidence: number;
}

export function validateDSResponse(raw: unknown): DSDecision {
  const r = (raw as Record<string, unknown>) || {};

  const pf = (r.problem_formulation as Record<string, unknown>) || {};
  const tr = (r.target_recommendation as Record<string, unknown>) || {};
  const etg = (r.entity_time_grain_recommendation as Record<string, unknown>) || {};
  const fr = (r.feature_reasoning as Record<string, unknown>) || {};
  const mra = (r.modeling_risk_assessment as Record<string, unknown>) || {};
  const alt = (r.alternatives as Record<string, unknown>) || {};

  return {
    problem_formulation: {
      objective_family: String(pf.objective_family || "other"),
      problem_type: ["classification", "regression"].includes(pf.problem_type as string) ? String(pf.problem_type) : "classification",
      business_mode: String(pf.business_mode || "exploratorio"),
      target_strategy: String(pf.target_strategy || "explicit"),
      prediction_unit: String(pf.prediction_unit || ""),
      decision_unit: String(pf.decision_unit || ""),
    },
    target_recommendation: {
      recommended_target: String(tr.recommended_target || ""),
      target_kind: ["explicit", "derived", "weak", "invalid"].includes(tr.target_kind as string) ? String(tr.target_kind) : "explicit",
      target_reasoning: asStringArray(tr.target_reasoning),
      target_alternatives: asTargetAltArray(tr.target_alternatives),
      target_confidence: typeof tr.target_confidence === "number" ? Math.max(0, Math.min(1, tr.target_confidence)) : 0,
    },
    entity_time_grain_recommendation: {
      recommended_entity_key: asStringArray(etg.recommended_entity_key),
      recommended_time_column: String(etg.recommended_time_column || ""),
      recommended_grain: String(etg.recommended_grain || "original_row"),
      recommended_split_strategy: String(etg.recommended_split_strategy || "random"),
      reasoning: asStringArray(etg.reasoning),
      confidence: typeof etg.confidence === "number" ? Math.max(0, Math.min(1, etg.confidence)) : 0,
    },
    feature_reasoning: {
      recommended_features: asStringArray(fr.recommended_features),
      blocked_features: asStringArray(fr.blocked_features),
      warning_features: asStringArray(fr.warning_features),
      leakage_risk_features: asStringArray(fr.leakage_risk_features),
      low_value_features: asStringArray(fr.low_value_features),
      reasoning: asStringArray(fr.reasoning),
    },
    modeling_risk_assessment: {
      target_risks: asStringArray(mra.target_risks),
      grain_risks: asStringArray(mra.grain_risks),
      split_risks: asStringArray(mra.split_risks),
      data_risks: asStringArray(mra.data_risks),
      general_risks: asStringArray(mra.general_risks),
    },
    alternatives: {
      alternative_targets: asTargetAltArray(alt.alternative_targets),
      alternative_grains: asStringArray(alt.alternative_grains),
      alternative_splits: asStringArray(alt.alternative_splits),
      alternative_problem_types: asStringArray(alt.alternative_problem_types),
    },
    actions_recommended: asActionArray(r.actions_recommended),
    confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0,
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}

function asTargetAltArray(v: unknown): Array<{ column: string; problem_type: string; reasoning: string }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && x.column)
    .map((x: any) => ({
      column: String(x.column),
      problem_type: String(x.problem_type || "classification"),
      reasoning: String(x.reasoning || ""),
    }));
}

function asActionArray(v: unknown): DSDecision["actions_recommended"] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && x.action)
    .map((x: any) => ({
      action: String(x.action),
      target: String(x.target || ""),
      priority: ["critical", "high", "medium", "low"].includes(x.priority) ? x.priority : "medium",
      auto_applicable: Boolean(x.auto_applicable),
    }));
}
