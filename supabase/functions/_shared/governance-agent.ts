/**
 * LIS AI OS — Governance Agent
 * Pipeline integrity guardian: validates contracts, targets, leakage, readiness.
 */

// ─── Governance-specific system prompt ───

export const GOVERNANCE_SYSTEM_PROMPT = `Você é o Agente de Governança da plataforma PredictSys — o guardião da integridade do pipeline preditivo.

SEU FOCO PRINCIPAL não é compliance jurídico genérico.
Seu foco é proteger a consistência técnica e decisória de todo o pipeline de ML.

RESPONSABILIDADES CENTRAIS:
1. GOVERNANÇA DE TARGET E PROBLEM_TYPE
   - Validar coerência entre target oficial e recomendado
   - Validar coerência entre problem_type oficial e recomendado
   - Detectar mudanças automáticas indevidas
   - Bloquear incompatibilidade (ex: target numérico contínuo + classification)

2. GOVERNANÇA DE ENTITY, TIME, GRAIN E SPLIT
   - Validar se entity, time_column, grain e split_strategy são coerentes
   - Se problema temporal com time válido → split temporal esperado
   - Se split temporal sem time oficial → bloquear

3. GOVERNANÇA DE LEAKAGE
   - Se coluna marcada como leakage ainda está em features_final → bloquear
   - Se builder ou treino usam colunas proibidas → bloquear

4. GOVERNANÇA DE READINESS
   - Avaliar readiness real para builder, training, scoring, dashboard
   - Se contract/selection/features mudaram e builder não foi regenerado → bloquear treino

5. INTEGRIDADE DE CONTRATOS
   - model_selection deve bater com modeling_contract
   - scoring deve usar mesmo feature space do treino
   - builder deve refletir a seleção oficial

6. COMPLIANCE SECUNDÁRIO (submódulo)
   - Detectar possível PII em nomes de colunas
   - Sinalizar risco LGPD como warning (não bloquear por isso)

REGRAS DE DECISÃO ABSOLUTAS:
- Oficial SEMPRE vence recomendado. Nunca promover automaticamente.
- Incompatibilidade target/problem_type → BLOCK
- Leakage ativo em features → BLOCK
- Scoring com feature space incompatível → BLOCK  
- Builder stale para treino → BLOCK
- Split temporal sem time_column → BLOCK
- UI vs pipeline divergente → WARNING

Responda SEMPRE usando a função governance_decision com o schema estruturado fornecido.
Seja objetivo, técnico e assertivo. Base suas análises nos dados reais.`;

// ─── Governance-specific tool schema ───

export const GOVERNANCE_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "governance_decision",
    description: "Structured governance agent decision for pipeline validation",
    parameters: {
      type: "object",
      properties: {
        pipeline_status: {
          type: "string",
          enum: ["ready", "warning", "blocked"],
          description: "Overall pipeline governance status",
        },
        governance_conflict: {
          type: "boolean",
          description: "Whether there is a conflict between official and recommended state",
        },
        conflict_type: {
          type: "string",
          description: "Type of governance conflict if any (target_mismatch, problem_type_mismatch, grain_mismatch, split_mismatch, empty string if none)",
        },
        conflict_summary: {
          type: "array",
          items: { type: "string" },
          description: "Human-readable summary of conflicts",
        },
        consistency_checks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              check: { type: "string", description: "Name of the consistency check" },
              status: { type: "string", enum: ["pass", "warn", "block"] },
              reason: { type: "string", description: "Explanation" },
            },
            required: ["check", "status", "reason"],
          },
          description: "Individual consistency checks performed",
        },
        leakage_assessment: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["clear", "warning", "blocked"] },
            blocking_columns: { type: "array", items: { type: "string" } },
            warning_columns: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["status", "blocking_columns", "warning_columns", "reasoning"],
        },
        readiness_assessment: {
          type: "object",
          properties: {
            target_ready: { type: "boolean" },
            entity_ready: { type: "boolean" },
            time_ready: { type: "boolean" },
            grain_ready: { type: "boolean" },
            builder_ready: { type: "boolean" },
            training_ready: { type: "boolean" },
            scoring_ready: { type: "boolean" },
            dashboard_ready: { type: "boolean" },
          },
          required: ["target_ready", "entity_ready", "time_ready", "grain_ready", "builder_ready", "training_ready", "scoring_ready", "dashboard_ready"],
        },
        official_state_summary: {
          type: "object",
          properties: {
            official_target: { type: "string" },
            official_problem_type: { type: "string" },
            official_entity_key: { type: "array", items: { type: "string" } },
            official_time_column: { type: "string" },
            official_grain: { type: "string" },
            official_split_strategy: { type: "string" },
          },
          required: ["official_target", "official_problem_type", "official_entity_key", "official_time_column", "official_grain", "official_split_strategy"],
        },
        blocking_reasons: {
          type: "array",
          items: { type: "string" },
          description: "Reasons that block the pipeline",
        },
        warnings: {
          type: "array",
          items: { type: "string" },
          description: "Non-blocking warnings",
        },
        actions_required: {
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
          description: "Actions required to unblock or fix issues",
        },
        compliance_notes: {
          type: "array",
          items: { type: "string" },
          description: "Secondary compliance/LGPD/PII notes",
        },
        confidence: {
          type: "number",
          description: "Confidence level 0.0 to 1.0",
        },
      },
      required: [
        "pipeline_status", "governance_conflict", "conflict_type", "conflict_summary",
        "consistency_checks", "leakage_assessment", "readiness_assessment",
        "official_state_summary", "blocking_reasons", "warnings",
        "actions_required", "compliance_notes", "confidence",
      ],
      additionalProperties: false,
    },
  },
};

// ─── Context builder for Governance Agent ───

export interface GovernanceContext {
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
  // Recommended state
  recommended_target: string | null;
  recommended_problem_type: string | null;
  // Selection & contracts
  selection_version: number;
  dataset_version: number;
  // Pipeline states
  builder_state: string;
  training_state: string;
  scoring_state: string;
  dashboard_state: string;
  // Features
  features_final: string[];
  blocked_features: string[];
  leakage_flags: string[];
  // Schema
  all_columns: string[];
  // Versions
  builder_version: number;
  training_version: number;
  scoring_version: number;
}

export async function buildGovernanceContext(
  svc: any,
  projectId: string,
  stage: string,
  executionMode: string,
): Promise<GovernanceContext> {
  // Fetch all needed data in parallel
  const [settingsRes, selectionRes, contractRes, columnsRes] = await Promise.all([
    svc.from("project_settings")
      .select("builder_state, training_state, scoring_state, dashboard_state, selection_version, dataset_version, builder_version, training_version, scoring_version")
      .eq("project_id", projectId)
      .maybeSingle(),
    svc.from("project_model_selection")
      .select("target_column, problem_type, selected_features, excluded_features, selection_version, entity_key, time_column, grain, split_strategy, leakage_columns, blocked_features")
      .eq("project_id", projectId)
      .maybeSingle(),
    svc.from("project_modeling_contracts")
      .select("target_column, problem_type, features, entity_key, time_column, grain, split_strategy")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.from("project_columns")
      .select("column_name")
      .eq("project_id", projectId),
  ]);

  const s = settingsRes.data || {};
  const sel = selectionRes.data || {};
  const contract = contractRes.data || {};
  const cols = (columnsRes.data || []).map((c: any) => c.column_name);

  const selectedFeatures: string[] = Array.isArray(sel.selected_features)
    ? sel.selected_features
    : (typeof sel.selected_features === "string" ? JSON.parse(sel.selected_features || "[]") : []);

  const excludedFeatures: string[] = Array.isArray(sel.excluded_features)
    ? sel.excluded_features
    : (typeof sel.excluded_features === "string" ? JSON.parse(sel.excluded_features || "[]") : []);

  const leakageCols: string[] = Array.isArray(sel.leakage_columns)
    ? sel.leakage_columns
    : [];

  const blockedFeatures: string[] = Array.isArray(sel.blocked_features)
    ? sel.blocked_features
    : [];

  // Determine entity_key array
  let entityKey: string[] = [];
  if (sel.entity_key) {
    entityKey = Array.isArray(sel.entity_key) ? sel.entity_key : [sel.entity_key];
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
    recommended_target: contract.target_column || null,
    recommended_problem_type: contract.problem_type || null,
    selection_version: sel.selection_version || s.selection_version || 0,
    dataset_version: s.dataset_version || 0,
    builder_state: s.builder_state || "draft",
    training_state: s.training_state || "idle",
    scoring_state: s.scoring_state || "idle",
    dashboard_state: s.dashboard_state || "idle",
    features_final: selectedFeatures,
    blocked_features: [...new Set([...blockedFeatures, ...leakageCols])],
    leakage_flags: leakageCols,
    all_columns: cols,
    builder_version: s.builder_version || 0,
    training_version: s.training_version || 0,
    scoring_version: s.scoring_version || 0,
  };
}

// ─── Build governance-specific prompt ───

export function buildGovernancePrompt(ctx: GovernanceContext): string {
  return `## Estado Oficial do Pipeline
\`\`\`json
${JSON.stringify({
  official_target: ctx.official_target,
  official_problem_type: ctx.official_problem_type,
  official_entity_key: ctx.official_entity_key,
  official_time_column: ctx.official_time_column,
  official_grain: ctx.official_grain,
  official_split_strategy: ctx.official_split_strategy,
  selection_version: ctx.selection_version,
  dataset_version: ctx.dataset_version,
}, null, 2)}
\`\`\`

## Estado Recomendado (Contratos de Modelagem)
\`\`\`json
${JSON.stringify({
  recommended_target: ctx.recommended_target,
  recommended_problem_type: ctx.recommended_problem_type,
}, null, 2)}
\`\`\`

## Pipeline States
\`\`\`json
${JSON.stringify({
  builder_state: ctx.builder_state,
  training_state: ctx.training_state,
  scoring_state: ctx.scoring_state,
  dashboard_state: ctx.dashboard_state,
  builder_version: ctx.builder_version,
  training_version: ctx.training_version,
  scoring_version: ctx.scoring_version,
}, null, 2)}
\`\`\`

## Features
- Features finais selecionadas (${ctx.features_final.length}): ${ctx.features_final.slice(0, 30).join(", ")}${ctx.features_final.length > 30 ? "..." : ""}
- Features bloqueadas/leakage (${ctx.blocked_features.length}): ${ctx.blocked_features.join(", ") || "nenhuma"}
- Leakage flags: ${ctx.leakage_flags.join(", ") || "nenhum"}

## Todas as colunas do dataset (${ctx.all_columns.length}): ${ctx.all_columns.slice(0, 50).join(", ")}${ctx.all_columns.length > 50 ? "..." : ""}

## Etapa Atual: ${ctx.stage}
## Modo de Execução: ${ctx.execution_mode}

Analise o estado completo do pipeline e produza sua decisão de governança usando a função governance_decision.
Verifique TODAS as regras obrigatórias: coerência target/problem_type, leakage, readiness, integridade de contratos, split/time/grain.`;
}

// ─── Validate governance response ───

export interface GovernanceDecision {
  pipeline_status: "ready" | "warning" | "blocked";
  governance_conflict: boolean;
  conflict_type: string;
  conflict_summary: string[];
  consistency_checks: Array<{
    check: string;
    status: "pass" | "warn" | "block";
    reason: string;
  }>;
  leakage_assessment: {
    status: "clear" | "warning" | "blocked";
    blocking_columns: string[];
    warning_columns: string[];
    reasoning: string[];
  };
  readiness_assessment: {
    target_ready: boolean;
    entity_ready: boolean;
    time_ready: boolean;
    grain_ready: boolean;
    builder_ready: boolean;
    training_ready: boolean;
    scoring_ready: boolean;
    dashboard_ready: boolean;
  };
  official_state_summary: {
    official_target: string;
    official_problem_type: string;
    official_entity_key: string[];
    official_time_column: string;
    official_grain: string;
    official_split_strategy: string;
  };
  blocking_reasons: string[];
  warnings: string[];
  actions_required: Array<{
    action: string;
    target: string;
    priority: "critical" | "high" | "medium" | "low";
    auto_applicable: boolean;
  }>;
  compliance_notes: string[];
  confidence: number;
}

export function validateGovernanceResponse(raw: unknown): GovernanceDecision {
  const r = (raw as Record<string, unknown>) || {};

  const validStatuses = ["ready", "warning", "blocked"];
  const pipeline_status = validStatuses.includes(r.pipeline_status as string)
    ? (r.pipeline_status as "ready" | "warning" | "blocked")
    : "blocked";

  const leakage = (r.leakage_assessment as Record<string, unknown>) || {};
  const readiness = (r.readiness_assessment as Record<string, unknown>) || {};
  const officialState = (r.official_state_summary as Record<string, unknown>) || {};

  return {
    pipeline_status,
    governance_conflict: Boolean(r.governance_conflict),
    conflict_type: String(r.conflict_type || ""),
    conflict_summary: asStringArray(r.conflict_summary),
    consistency_checks: asCheckArray(r.consistency_checks),
    leakage_assessment: {
      status: (["clear", "warning", "blocked"].includes(leakage.status as string)
        ? leakage.status as "clear" | "warning" | "blocked"
        : "clear"),
      blocking_columns: asStringArray(leakage.blocking_columns),
      warning_columns: asStringArray(leakage.warning_columns),
      reasoning: asStringArray(leakage.reasoning),
    },
    readiness_assessment: {
      target_ready: Boolean(readiness.target_ready),
      entity_ready: Boolean(readiness.entity_ready),
      time_ready: Boolean(readiness.time_ready),
      grain_ready: Boolean(readiness.grain_ready),
      builder_ready: Boolean(readiness.builder_ready),
      training_ready: Boolean(readiness.training_ready),
      scoring_ready: Boolean(readiness.scoring_ready),
      dashboard_ready: Boolean(readiness.dashboard_ready),
    },
    official_state_summary: {
      official_target: String(officialState.official_target || ""),
      official_problem_type: String(officialState.official_problem_type || ""),
      official_entity_key: asStringArray(officialState.official_entity_key),
      official_time_column: String(officialState.official_time_column || ""),
      official_grain: String(officialState.official_grain || ""),
      official_split_strategy: String(officialState.official_split_strategy || ""),
    },
    blocking_reasons: asStringArray(r.blocking_reasons),
    warnings: asStringArray(r.warnings),
    actions_required: asActionArray(r.actions_required),
    compliance_notes: asStringArray(r.compliance_notes),
    confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0,
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}

function asCheckArray(v: unknown): GovernanceDecision["consistency_checks"] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && x.check)
    .map((x: any) => ({
      check: String(x.check),
      status: ["pass", "warn", "block"].includes(x.status) ? x.status : "warn",
      reason: String(x.reason || ""),
    }));
}

function asActionArray(v: unknown): GovernanceDecision["actions_required"] {
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
