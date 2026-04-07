/**
 * Data Engineer Agent — schema, builder, multi-table, compatibility
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── System Prompt ───

export const DE_SYSTEM_PROMPT = `Você é o Agente Engenheiro de Dados da plataforma PredictSys.
Seu papel é garantir que a estrutura de dados suporte o problema preditivo definido.

Responsabilidades:
- Validar e classificar o schema real (entity, tempo, valor, categórica, suspeita, leakage, alta nulidade, constante)
- Orientar dataset_build_mode (passthrough, aggregate, snapshot, rebuild)
- Validar se grain/time/entity são materializáveis
- Tratar cenários multi-table (anchor, join, aggregation, duplicação)
- Validar compatibilidade entre treino e scoring (feature space, derivadas, contrato)
- Detectar riscos de parsing, delimiter, storage path, schema drift
- Impedir materialização inconsistente
- Nunca reintroduzir features bloqueadas

Regras:
1. Schema real vence inferência superficial — use tipos, cobertura e parsing reais
2. Builder deve ser materializável — não recomende algo que o builder não consiga executar
3. Multi-table não pode ser flatten ingênuo — classifique tabelas, defina anchor e join strategy
4. Treino e scoring devem usar o mesmo feature space lógico
5. Parsing e storage são riscos de engenharia (delimiter, path, arquivo errado, dataset vazio)
6. Nunca reintroduzir features em blocked_features
7. Se a base não sustenta o problema, sinalize bloqueio

Responda SEMPRE usando a função de_decision. Seja preciso e técnico.`;

// ─── Tool Schema ───

export const DE_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "de_decision",
    description: "Data Engineer Agent structured decision",
    parameters: {
      type: "object",
      properties: {
        schema_assessment: {
          type: "object",
          properties: {
            dataset_shape: { type: "string", description: "e.g. '15000 rows x 28 cols'" },
            entity_columns: { type: "array", items: { type: "string" } },
            time_columns: { type: "array", items: { type: "string" } },
            value_columns: { type: "array", items: { type: "string" } },
            categorical_columns: { type: "array", items: { type: "string" } },
            schema_warnings: { type: "array", items: { type: "string" } },
            schema_blockers: { type: "array", items: { type: "string" } },
          },
          required: ["dataset_shape", "entity_columns", "time_columns", "value_columns", "categorical_columns"],
        },
        builder_plan: {
          type: "object",
          properties: {
            dataset_build_mode: { type: "string", enum: ["passthrough", "aggregate", "snapshot", "rebuild"] },
            requires_aggregation: { type: "boolean" },
            requires_snapshots: { type: "boolean" },
            requires_feature_rebuild: { type: "boolean" },
            required_transforms: { type: "array", items: { type: "string" } },
            required_validations: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["dataset_build_mode", "requires_aggregation", "requires_snapshots", "reasoning"],
        },
        multi_table_assessment: {
          type: "object",
          properties: {
            has_multi_table: { type: "boolean" },
            table_roles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  table_name: { type: "string" },
                  role: { type: "string", enum: ["fact", "dimension", "bridge", "aggregate", "unknown"] },
                  reasoning: { type: "string" },
                },
              },
            },
            anchor_table: { type: "string" },
            join_strategy: { type: "string" },
            aggregation_rules: { type: "array", items: { type: "string" } },
            duplication_risks: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["has_multi_table"],
        },
        training_scoring_compatibility: {
          type: "object",
          properties: {
            compatible: { type: "boolean" },
            missing_features: { type: "array", items: { type: "string" } },
            engineered_features_expected: { type: "array", items: { type: "string" } },
            schema_conflicts: { type: "array", items: { type: "string" } },
            builder_contract_conflicts: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["compatible"],
        },
        data_reliability_assessment: {
          type: "object",
          properties: {
            delimiter_risk: { type: "array", items: { type: "string" } },
            storage_path_risk: { type: "array", items: { type: "string" } },
            parsing_risk: { type: "array", items: { type: "string" } },
            nullability_risk: { type: "array", items: { type: "string" } },
            type_stability_risk: { type: "array", items: { type: "string" } },
          },
        },
        readiness_assessment: {
          type: "object",
          properties: {
            builder_ready: { type: "boolean" },
            training_ready: { type: "boolean" },
            scoring_ready: { type: "boolean" },
          },
          required: ["builder_ready", "training_ready", "scoring_ready"],
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
        confidence: { type: "number", description: "0.0 to 1.0" },
      },
      required: [
        "schema_assessment",
        "builder_plan",
        "multi_table_assessment",
        "training_scoring_compatibility",
        "readiness_assessment",
        "confidence",
      ],
      additionalProperties: false,
    },
  },
};

// ─── Context Builder ───

export interface DEContext {
  project_id: string;
  stage: string;
  execution_mode: string;
  dataset_metadata: Record<string, unknown>;
  project_columns: unknown[];
  eda_profile: Record<string, unknown> | null;
  builder_status: string;
  builder_version: number;
  model_selection: Record<string, unknown> | null;
  modeling_contract: Record<string, unknown> | null;
  official_target: string;
  official_problem_type: string;
  official_entity_key: string[];
  official_time_column: string;
  official_grain: string;
  official_split_strategy: string;
  dataset_build_mode: string;
  features_final: string[];
  blocked_features: string[];
  leakage_flags: string[];
  saved_feature_names: string[];
  multi_table_metadata: Record<string, unknown> | null;
  import_jobs_summary: Record<string, unknown> | null;
}

export async function buildDEContext(
  svc: SupabaseClient,
  projectId: string,
  stage: string,
  executionMode: string,
): Promise<DEContext> {
  const [settingsRes, selectionRes, contractRes, columnsRes, dsStateRes, modelsRes, importRes] = await Promise.all([
    svc.from("project_settings")
      .select("builder_state, dataset_version, selection_version, eda_profile_json, ingestion_rows_detected, ingestion_cols_detected, ingestion_source_type")
      .eq("project_id", projectId).maybeSingle(),
    svc.from("project_model_selection")
      .select("target_column, problem_type, selected_features, excluded_features, selection_version, entity_key, time_column, grain, split_strategy, dataset_build_mode, blocked_features, leakage_flags")
      .eq("project_id", projectId).maybeSingle(),
    svc.from("project_modeling_contracts")
      .select("contract, version")
      .eq("project_id", projectId)
      .order("version", { ascending: false })
      .limit(1).maybeSingle(),
    svc.from("project_columns")
      .select("column_name, inferred_type, role, null_pct, distinct_count, sample_values, is_blocked")
      .eq("project_id", projectId)
      .limit(200),
    svc.from("project_dataset_state")
      .select("source_type, row_count, col_count, active_dataset_ref, virtual_manifest")
      .eq("project_id", projectId).maybeSingle(),
    svc.from("project_models")
      .select("hyperparameters, status, is_production")
      .eq("project_id", projectId)
      .eq("is_production", true)
      .limit(1).maybeSingle(),
    svc.from("import_jobs")
      .select("file_name, status, delimiter, encoding, rows_processed, headers_json")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(3),
  ]);

  const sel = selectionRes.data as any;
  const settings = settingsRes.data as any;
  const contract = contractRes.data as any;
  const cols = (columnsRes.data || []) as any[];
  const dsState = dsStateRes.data as any;
  const prodModel = modelsRes.data as any;

  const selectedFeatures = sel?.selected_features || [];
  const excludedFeatures = sel?.excluded_features || [];
  const blockedFeatures = sel?.blocked_features || [];
  const leakageFlags = sel?.leakage_flags || [];
  const savedFeatureNames = prodModel?.hyperparameters?.savedFeatureNames || [];

  return {
    project_id: projectId,
    stage,
    execution_mode: executionMode,
    dataset_metadata: {
      source_type: dsState?.source_type || settings?.ingestion_source_type || "unknown",
      row_count: dsState?.row_count || settings?.ingestion_rows_detected || 0,
      col_count: dsState?.col_count || settings?.ingestion_cols_detected || 0,
      virtual_manifest: dsState?.virtual_manifest || false,
      active_dataset_ref: dsState?.active_dataset_ref || null,
    },
    project_columns: cols.map(c => ({
      name: c.column_name,
      type: c.inferred_type,
      role: c.role,
      null_pct: c.null_pct,
      distinct_count: c.distinct_count,
      sample_values: c.sample_values,
      is_blocked: c.is_blocked,
    })),
    eda_profile: settings?.eda_profile_json || null,
    builder_status: settings?.builder_state || "draft",
    builder_version: settings?.dataset_version || 0,
    model_selection: sel ? {
      target_column: sel.target_column,
      problem_type: sel.problem_type,
      selected_features: selectedFeatures,
      excluded_features: excludedFeatures,
      selection_version: sel.selection_version,
    } : null,
    modeling_contract: contract?.contract || null,
    official_target: sel?.target_column || "",
    official_problem_type: sel?.problem_type || "",
    official_entity_key: Array.isArray(sel?.entity_key) ? sel.entity_key : sel?.entity_key ? [sel.entity_key] : [],
    official_time_column: sel?.time_column || "",
    official_grain: sel?.grain || "",
    official_split_strategy: sel?.split_strategy || "",
    dataset_build_mode: sel?.dataset_build_mode || "passthrough",
    features_final: Array.isArray(selectedFeatures) ? selectedFeatures : [],
    blocked_features: Array.isArray(blockedFeatures) ? blockedFeatures : [],
    leakage_flags: Array.isArray(leakageFlags) ? leakageFlags : [],
    saved_feature_names: Array.isArray(savedFeatureNames) ? savedFeatureNames : [],
    multi_table_metadata: null,
    import_jobs_summary: importRes.data ? {
      recent_jobs: (importRes.data as any[]).map(j => ({
        file_name: j.file_name,
        status: j.status,
        delimiter: j.delimiter,
        encoding: j.encoding,
        rows_processed: j.rows_processed,
      })),
    } : null,
  };
}

// ─── Prompt Builder ───

export function buildDEPrompt(ctx: DEContext): string {
  return `## Contexto do Projeto (Data Engineer)

### Dataset
\`\`\`json
${JSON.stringify(ctx.dataset_metadata, null, 2)}
\`\`\`

### Colunas do Projeto (${ctx.project_columns.length} colunas)
\`\`\`json
${JSON.stringify(ctx.project_columns.slice(0, 60), null, 2)}
\`\`\`

### Estado Oficial
- Target: ${ctx.official_target || "não definido"}
- Problem Type: ${ctx.official_problem_type || "não definido"}
- Entity: ${ctx.official_entity_key.join(", ") || "não definida"}
- Time Column: ${ctx.official_time_column || "não definida"}
- Grain: ${ctx.official_grain || "não definido"}
- Split Strategy: ${ctx.official_split_strategy || "não definida"}
- Dataset Build Mode: ${ctx.dataset_build_mode}

### Builder
- Status: ${ctx.builder_status}
- Version: ${ctx.builder_version}

### Features
- Finais: ${ctx.features_final.length > 0 ? ctx.features_final.join(", ") : "nenhuma"}
- Bloqueadas: ${ctx.blocked_features.length > 0 ? ctx.blocked_features.join(", ") : "nenhuma"}
- Leakage: ${ctx.leakage_flags.length > 0 ? ctx.leakage_flags.join(", ") : "nenhuma"}
- Saved (modelo produção): ${ctx.saved_feature_names.length > 0 ? ctx.saved_feature_names.join(", ") : "nenhuma"}

### Modeling Contract
\`\`\`json
${JSON.stringify(ctx.modeling_contract, null, 2)}
\`\`\`

### Import Jobs
\`\`\`json
${JSON.stringify(ctx.import_jobs_summary, null, 2)}
\`\`\`

### Etapa Atual: ${ctx.stage}
### Modo de Execução: ${ctx.execution_mode}

Analise o schema, o builder, a compatibilidade treino/scoring e os riscos de engenharia. Produza sua decisão usando a função de_decision.`;
}

// ─── Response Validation ───

export interface DEDecision {
  schema_assessment: {
    dataset_shape: string;
    entity_columns: string[];
    time_columns: string[];
    value_columns: string[];
    categorical_columns: string[];
    schema_warnings: string[];
    schema_blockers: string[];
  };
  builder_plan: {
    dataset_build_mode: string;
    requires_aggregation: boolean;
    requires_snapshots: boolean;
    requires_feature_rebuild: boolean;
    required_transforms: string[];
    required_validations: string[];
    reasoning: string[];
  };
  multi_table_assessment: {
    has_multi_table: boolean;
    table_roles: Array<{ table_name: string; role: string; reasoning: string }>;
    anchor_table: string;
    join_strategy: string;
    aggregation_rules: string[];
    duplication_risks: string[];
    reasoning: string[];
  };
  training_scoring_compatibility: {
    compatible: boolean;
    missing_features: string[];
    engineered_features_expected: string[];
    schema_conflicts: string[];
    builder_contract_conflicts: string[];
    reasoning: string[];
  };
  data_reliability_assessment: {
    delimiter_risk: string[];
    storage_path_risk: string[];
    parsing_risk: string[];
    nullability_risk: string[];
    type_stability_risk: string[];
  };
  readiness_assessment: {
    builder_ready: boolean;
    training_ready: boolean;
    scoring_ready: boolean;
  };
  actions_recommended: Array<{
    action: string;
    target: string;
    priority: string;
    auto_applicable: boolean;
  }>;
  confidence: number;
}

export function validateDEResponse(raw: unknown): DEDecision {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return fallbackDE("Invalid response object");

  const sa = (r.schema_assessment as any) || {};
  const bp = (r.builder_plan as any) || {};
  const mt = (r.multi_table_assessment as any) || {};
  const tsc = (r.training_scoring_compatibility as any) || {};
  const dra = (r.data_reliability_assessment as any) || {};
  const ra = (r.readiness_assessment as any) || {};

  return {
    schema_assessment: {
      dataset_shape: sa.dataset_shape || "unknown",
      entity_columns: asArr(sa.entity_columns),
      time_columns: asArr(sa.time_columns),
      value_columns: asArr(sa.value_columns),
      categorical_columns: asArr(sa.categorical_columns),
      schema_warnings: asArr(sa.schema_warnings),
      schema_blockers: asArr(sa.schema_blockers),
    },
    builder_plan: {
      dataset_build_mode: bp.dataset_build_mode || "passthrough",
      requires_aggregation: Boolean(bp.requires_aggregation),
      requires_snapshots: Boolean(bp.requires_snapshots),
      requires_feature_rebuild: Boolean(bp.requires_feature_rebuild),
      required_transforms: asArr(bp.required_transforms),
      required_validations: asArr(bp.required_validations),
      reasoning: asArr(bp.reasoning),
    },
    multi_table_assessment: {
      has_multi_table: Boolean(mt.has_multi_table),
      table_roles: Array.isArray(mt.table_roles) ? mt.table_roles : [],
      anchor_table: mt.anchor_table || "",
      join_strategy: mt.join_strategy || "",
      aggregation_rules: asArr(mt.aggregation_rules),
      duplication_risks: asArr(mt.duplication_risks),
      reasoning: asArr(mt.reasoning),
    },
    training_scoring_compatibility: {
      compatible: tsc.compatible !== false,
      missing_features: asArr(tsc.missing_features),
      engineered_features_expected: asArr(tsc.engineered_features_expected),
      schema_conflicts: asArr(tsc.schema_conflicts),
      builder_contract_conflicts: asArr(tsc.builder_contract_conflicts),
      reasoning: asArr(tsc.reasoning),
    },
    data_reliability_assessment: {
      delimiter_risk: asArr(dra.delimiter_risk),
      storage_path_risk: asArr(dra.storage_path_risk),
      parsing_risk: asArr(dra.parsing_risk),
      nullability_risk: asArr(dra.nullability_risk),
      type_stability_risk: asArr(dra.type_stability_risk),
    },
    readiness_assessment: {
      builder_ready: ra.builder_ready !== false,
      training_ready: ra.training_ready !== false,
      scoring_ready: ra.scoring_ready !== false,
    },
    actions_recommended: Array.isArray(r.actions_recommended)
      ? r.actions_recommended.map((a: any) => ({
          action: String(a.action || ""),
          target: String(a.target || ""),
          priority: ["critical", "high", "medium", "low"].includes(a.priority) ? a.priority : "medium",
          auto_applicable: Boolean(a.auto_applicable),
        }))
      : [],
    confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0,
  };
}

function fallbackDE(reason: string): DEDecision {
  return {
    schema_assessment: {
      dataset_shape: "unknown",
      entity_columns: [], time_columns: [], value_columns: [], categorical_columns: [],
      schema_warnings: [reason], schema_blockers: [],
    },
    builder_plan: {
      dataset_build_mode: "passthrough", requires_aggregation: false, requires_snapshots: false,
      requires_feature_rebuild: false, required_transforms: [], required_validations: [], reasoning: [reason],
    },
    multi_table_assessment: {
      has_multi_table: false, table_roles: [], anchor_table: "", join_strategy: "",
      aggregation_rules: [], duplication_risks: [], reasoning: [],
    },
    training_scoring_compatibility: {
      compatible: false, missing_features: [], engineered_features_expected: [],
      schema_conflicts: [], builder_contract_conflicts: [], reasoning: [reason],
    },
    data_reliability_assessment: {
      delimiter_risk: [], storage_path_risk: [], parsing_risk: [], nullability_risk: [], type_stability_risk: [],
    },
    readiness_assessment: { builder_ready: false, training_ready: false, scoring_ready: false },
    actions_recommended: [],
    confidence: 0,
  };
}

function asArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}
