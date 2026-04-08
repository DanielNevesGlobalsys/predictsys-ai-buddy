// ═══════════════════════════════════════════════════════════════════
// Intent Contract Types — SSOT for project_ai_context.context.intent_contract
// ═══════════════════════════════════════════════════════════════════

/** Supported industry verticals */
export type IndustryKey =
  | "retail"
  | "health"
  | "logistics"
  | "education"
  | "finance"
  | "agro"
  | "generic";

/** Problem archetypes */
export type ProblemType = "classification" | "regression" | "timeseries" | "segmentation";

/** Target type */
export type TargetExpected = "event" | "value" | "state_to_event";

// ─── Intent Base (universal) ───────────────────────────────────

export interface IntentBase {
  declared_objective: string;
  problem_type: ProblemType;
  target_expected: TargetExpected;
  requires_time_column: boolean;
  default_window_days: number;
  label_builder_required: boolean;
  recommended_metrics: string[];
  disallowed_metrics: string[];
  guardrails: {
    block_id_targets: boolean;
    block_leakage: boolean;
    block_constant_target: boolean;
  };
}

// ─── Domain Adapter (industry-specific) ────────────────────────

export interface DomainAdapterTemplate {
  template_id: string;
  display_name: string;
  problem_type: ProblemType;
  description: string;
}

export interface DomainAdapter {
  industry: IndustryKey;
  display_name: string;
  entity_candidates: string[];
  time_candidates: string[];
  event_candidates: string[];
  value_candidates: string[];
  leakage_watchlist: string[];
  recommended_templates: DomainAdapterTemplate[];
  default_window_days: number;
  column_dictionary: Record<string, string>; // common_name -> description
}

// ─── Full Intent Contract (v2 with adapter) ────────────────────

export interface IntentContractV2 {
  intent_base: IntentBase;
  domain_adapter: DomainAdapter;
  contract_version: number;
  migration_from_legacy?: boolean;
  legacy_version?: number | null;
  created_at: string;
  /** Agro-specific context — only populated when industry = "agro" */
  agro_context?: {
    agro_subdomain: string;
    business_cycle: string;
    forecast_unit: string;
    production_entity: string;
    has_seasonality: boolean;
    seasonality_grain: string;
    business_event_of_interest: string;
  };
}

// ─── Legacy compat: original flat contract ─────────────────────

export interface IntentContractLegacy {
  declared_objective: string;
  industry_hint: string;
  problem_type: string;
  target_expected: string;
  requires_time_column: boolean;
  default_window_days: number;
  label_builder_required: boolean;
  recommended_entity_key: string | null;
  recommended_metrics: string[];
  disallowed_metrics: string[];
  guardrails: {
    block_id_targets: boolean;
    block_leakage: boolean;
    block_constant_target: boolean;
  };
  version: number;
  created_at: string;
}

// ─── Normalizer: legacy -> v2 ──────────────────────────────────

export function normalizeIntentContract(
  raw: IntentContractV2 | IntentContractLegacy | any
): IntentContractV2 | null {
  if (!raw) return null;

  // Already v2 format
  if (raw.intent_base && raw.domain_adapter) {
    return raw as IntentContractV2;
  }

  // Legacy format — convert
  if (raw.declared_objective || raw.industry_hint) {
    const legacy = raw as IntentContractLegacy;
    return {
      intent_base: {
        declared_objective: legacy.declared_objective || "",
        problem_type: (legacy.problem_type as ProblemType) || "classification",
        target_expected: (legacy.target_expected as TargetExpected) || "event",
        requires_time_column: legacy.requires_time_column ?? true,
        default_window_days: legacy.default_window_days || 30,
        label_builder_required: legacy.label_builder_required ?? false,
        recommended_metrics: legacy.recommended_metrics || [],
        disallowed_metrics: legacy.disallowed_metrics || [],
        guardrails: legacy.guardrails || {
          block_id_targets: true,
          block_leakage: true,
          block_constant_target: true,
        },
      },
      domain_adapter: {
        industry: (legacy.industry_hint as IndustryKey) || "generic",
        display_name: INDUSTRY_DISPLAY_NAMES[(legacy.industry_hint as IndustryKey) || "generic"] || "Genérico",
        entity_candidates: legacy.recommended_entity_key ? [legacy.recommended_entity_key] : [],
        time_candidates: [],
        event_candidates: [],
        value_candidates: [],
        leakage_watchlist: [],
        recommended_templates: [],
        default_window_days: legacy.default_window_days || 30,
        column_dictionary: {},
      },
      contract_version: legacy.version || 1,
      created_at: legacy.created_at || new Date().toISOString(),
    };
  }

  return null;
}

// ─── Display name map ──────────────────────────────────────────

export const INDUSTRY_DISPLAY_NAMES: Record<IndustryKey, string> = {
  retail: "Varejo",
  health: "Saúde",
  logistics: "Logística",
  education: "Educação",
  finance: "Finanças",
  agro: "Agro",
  generic: "Genérico",
};

// ─── Gate validation ───────────────────────────────────────────

export interface IntentGateResult {
  status: "PASS" | "WARN" | "BLOCK";
  code: string;
  message: string;
  cta?: string;
}

export function validateIntentGates(
  industry: IndustryKey | undefined,
  objective: string | undefined,
  adapterFound: boolean
): IntentGateResult[] {
  const gates: IntentGateResult[] = [];

  if (!objective?.trim()) {
    gates.push({
      status: "BLOCK",
      code: "OBJECTIVE_EMPTY",
      message: "O objetivo preditivo é obrigatório para avançar.",
      cta: "Preencha o campo 'Objetivo Preditivo'",
    });
  }

  if (!industry) {
    gates.push({
      status: "BLOCK",
      code: "INDUSTRY_NOT_SELECTED",
      message: "Selecione o segmento/indústria do projeto.",
      cta: "Selecione uma indústria no seletor acima",
    });
  }

  if (industry && !adapterFound && industry !== "generic") {
    gates.push({
      status: "WARN",
      code: "ADAPTER_NOT_FOUND",
      message: `Adaptador para "${industry}" não encontrado. Será usado o adaptador genérico como fallback.`,
    });
  }

  return gates;
}
