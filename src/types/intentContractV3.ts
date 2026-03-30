// ═══════════════════════════════════════════════════════════════════
// Intent Contract V3 — Operational artifact for the PRE
// (Predictive Resolution Engine)
//
// Designed to feed automatic problem formulation:
//   target, grain, entity_key, horizon, feature plan
//
// 6 mandatory blocks:
//   1. business_context
//   2. prediction_request
//   3. risk_preferences
//   4. data_expectations
//   5. business_rules
//   6. user_confidence
// ═══════════════════════════════════════════════════════════════════

// ─── Enums & Literals ──────────────────────────────────────────

export type IndustryKeyV3 =
  | "retail"
  | "health"
  | "finance"
  | "education"
  | "logistics"
  | "hr"
  | "insurance"
  | "telecom"
  | "generic";

export type ObjectiveArchetype =
  | "churn"
  | "propensity"
  | "default_risk"
  | "demand_forecast"
  | "anomaly_detection"
  | "segmentation"
  | "lifetime_value"
  | "next_best_action"
  | "risk_scoring"
  | "turnover"
  | "custom";

export type PredictionNature = "will_it_happen" | "how_much" | "when" | "who_is_similar";

export type EntityGranularity =
  | "customer"
  | "patient"
  | "student"
  | "employee"
  | "contract"
  | "transaction"
  | "product"
  | "account"
  | "household"
  | "other";

export type HorizonUnit = "days" | "weeks" | "months";

export type ActionTiming = "preventive" | "reactive" | "continuous";

export type ToleranceLevel = "conservative" | "balanced" | "aggressive";

export type DataShape = "one_row_per_entity" | "multiple_rows_per_entity" | "time_series" | "unknown";

export type ConfidenceLevel = "high" | "medium" | "low" | "unsure";

// ─── Block 1: Business Context ─────────────────────────────────

export interface BusinessContextBlock {
  /** Industry vertical */
  industry: IndustryKeyV3;
  /** Free-text: what does your company/org do? */
  company_description?: string;
  /** What department/team will use the predictions? */
  department?: string;
  /** What business decision will this model support? */
  business_decision: string;
  /** What is the cost of getting it wrong? (free-text or structured) */
  cost_of_inaction?: string;
  /** Current process: how is this decision made today? */
  current_process?: "manual" | "rule_based" | "existing_model" | "none";
}

// ─── Block 2: Prediction Request ───────────────────────────────

export interface PredictionRequestBlock {
  /** High-level objective archetype */
  objective: ObjectiveArchetype;
  /** Custom text when objective = 'custom' */
  custom_objective_text?: string;
  /** Nature of prediction: event? value? timing? similarity? */
  prediction_nature: PredictionNature;
  /** What exactly do you want to predict? (free-text, guided) */
  prediction_question: string;
  /** Who/what is being predicted about? */
  entity_granularity: EntityGranularity;
  /** Custom entity label (e.g., "paciente", "aluno") */
  entity_label?: string;
  /** Time horizon for the prediction */
  horizon: {
    value: number;
    unit: HorizonUnit;
  };
  /** When should the action be taken? */
  action_timing: ActionTiming;
  /** What action will be taken based on the prediction? */
  intended_action?: string;
}

// ─── Block 3: Risk Preferences ─────────────────────────────────

export interface RiskPreferencesBlock {
  /** What's worse: missing a true case or flagging a false one? */
  worse_error: "miss_true_positive" | "flag_false_positive" | "both_equal";
  /** Tolerance for false alarms */
  false_alarm_tolerance: ToleranceLevel;
  /** Minimum confidence to act on a prediction */
  min_confidence_to_act?: number;
  /** Acceptable rate of missed cases (0-1) */
  acceptable_miss_rate?: number;
  /** Business metric to optimize */
  optimize_for?: "precision" | "recall" | "f1" | "revenue" | "cost_reduction" | "balanced";
}

// ─── Block 4: Data Expectations ────────────────────────────────

export interface DataExpectationsBlock {
  /** Shape of the data the user expects to provide */
  expected_data_shape: DataShape;
  /** Does the data already contain the outcome/result column? */
  has_outcome_column: boolean | "unsure";
  /** If yes, what is it called? */
  outcome_column_name?: string;
  /** Does the data have a date/time column? */
  has_time_column: boolean | "unsure";
  /** If yes, what does it represent? */
  time_column_meaning?: string;
  /** Does the data have a unique identifier per entity? */
  has_entity_id: boolean | "unsure";
  /** Approximate number of rows */
  approximate_rows?: "under_1k" | "1k_10k" | "10k_100k" | "100k_1m" | "over_1m" | "unknown";
  /** Known data quality issues */
  known_issues?: string[];
}

// ─── Block 5: Business Rules ───────────────────────────────────

export interface BusinessRulesBlock {
  /** Columns that MUST NOT be used as features (business reasons) */
  forbidden_features?: string[];
  /** Columns that MUST be included as features */
  mandatory_features?: string[];
  /** Known leakage columns (user knows these leak the outcome) */
  known_leakage_columns?: string[];
  /** Minimum positive rate the user considers valid */
  min_positive_rate?: number;
  /** Maximum positive rate the user considers valid */
  max_positive_rate?: number;
  /** Segments/cohorts to exclude from training */
  exclude_segments?: string[];
  /** Date range restrictions */
  date_range?: {
    start?: string;
    end?: string;
  };
  /** Domain-specific rules as free text */
  custom_rules?: string[];
}

// ─── Block 6: User Confidence ──────────────────────────────────

export interface UserConfidenceBlock {
  /** How confident is the user about their data quality? */
  data_quality_confidence: ConfidenceLevel;
  /** How confident is the user about the target definition? */
  target_definition_confidence: ConfidenceLevel;
  /** How much ML experience does the user have? */
  ml_experience: "none" | "basic" | "intermediate" | "expert";
  /** Does the user want the system to auto-decide when possible? */
  prefer_auto_decisions: boolean;
  /** Fields the user explicitly wants to control */
  manual_overrides?: string[];
}

// ─── Full Contract ─────────────────────────────────────────────

export interface IntentContractV3 {
  contract_version: 3;
  created_at: string;
  updated_at: string;
  business_context: BusinessContextBlock;
  prediction_request: PredictionRequestBlock;
  risk_preferences: RiskPreferencesBlock;
  data_expectations: DataExpectationsBlock;
  business_rules: BusinessRulesBlock;
  user_confidence: UserConfidenceBlock;
}

// ─── PRE Payload (output consumed by the engine) ───────────────

export interface PREPayload {
  /** Resolved problem type */
  problem_type: "binary_classification" | "multiclass" | "regression" | "clustering";
  /** Target strategy hint */
  target_strategy: "explicit" | "derived_event" | "derived_value" | "auto";
  /** Entity key detection hints */
  entity_hints: {
    granularity: EntityGranularity;
    label: string;
    has_id: boolean | "unsure";
  };
  /** Temporal configuration */
  temporal: {
    horizon_days: number;
    has_time_column: boolean | "unsure";
    time_meaning?: string;
    action_timing: ActionTiming;
  };
  /** Target resolution hints */
  target_hints: {
    has_outcome: boolean | "unsure";
    outcome_column?: string;
    prediction_nature: PredictionNature;
    prediction_question: string;
  };
  /** Feature governance */
  feature_governance: {
    forbidden: string[];
    mandatory: string[];
    known_leakage: string[];
  };
  /** Metric optimization */
  optimization: {
    worse_error: "miss_true_positive" | "flag_false_positive" | "both_equal";
    tolerance: ToleranceLevel;
    optimize_for: string;
    min_confidence?: number;
  };
  /** Automation level */
  automation: {
    prefer_auto: boolean;
    ml_experience: string;
    manual_overrides: string[];
  };
  /** Industry + objective for rule matching */
  domain: {
    industry: IndustryKeyV3;
    objective: ObjectiveArchetype;
    custom_objective?: string;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Contract → PRE Payload converter
// ═══════════════════════════════════════════════════════════════════

export function contractToPREPayload(contract: IntentContractV3): PREPayload {
  const { business_context, prediction_request, risk_preferences, data_expectations, business_rules, user_confidence } = contract;

  // Resolve problem type from prediction nature + objective
  const problem_type = resolveProblemType(prediction_request);

  // Resolve target strategy
  const target_strategy = resolveTargetStrategy(prediction_request, data_expectations);

  // Convert horizon to days
  const horizon_days = convertHorizonToDays(prediction_request.horizon);

  return {
    problem_type,
    target_strategy,
    entity_hints: {
      granularity: prediction_request.entity_granularity,
      label: prediction_request.entity_label || ENTITY_LABELS[prediction_request.entity_granularity] || prediction_request.entity_granularity,
      has_id: data_expectations.has_entity_id,
    },
    temporal: {
      horizon_days,
      has_time_column: data_expectations.has_time_column,
      time_meaning: data_expectations.time_column_meaning,
      action_timing: prediction_request.action_timing,
    },
    target_hints: {
      has_outcome: data_expectations.has_outcome_column,
      outcome_column: data_expectations.outcome_column_name,
      prediction_nature: prediction_request.prediction_nature,
      prediction_question: prediction_request.prediction_question,
    },
    feature_governance: {
      forbidden: business_rules.forbidden_features || [],
      mandatory: business_rules.mandatory_features || [],
      known_leakage: business_rules.known_leakage_columns || [],
    },
    optimization: {
      worse_error: risk_preferences.worse_error,
      tolerance: risk_preferences.false_alarm_tolerance,
      optimize_for: risk_preferences.optimize_for || "balanced",
      min_confidence: risk_preferences.min_confidence_to_act,
    },
    automation: {
      prefer_auto: user_confidence.prefer_auto_decisions,
      ml_experience: user_confidence.ml_experience,
      manual_overrides: user_confidence.manual_overrides || [],
    },
    domain: {
      industry: business_context.industry,
      objective: prediction_request.objective,
      custom_objective: prediction_request.custom_objective_text,
    },
  };
}

// ─── Internal resolvers ────────────────────────────────────────

function resolveProblemType(req: PredictionRequestBlock): PREPayload["problem_type"] {
  if (req.objective === "segmentation") return "clustering";
  switch (req.prediction_nature) {
    case "will_it_happen": return "binary_classification";
    case "how_much": return "regression";
    case "when": return "regression";
    case "who_is_similar": return "clustering";
    default: return "binary_classification";
  }
}

function resolveTargetStrategy(
  req: PredictionRequestBlock,
  data: DataExpectationsBlock
): PREPayload["target_strategy"] {
  if (data.has_outcome_column === true) return "explicit";
  if (req.prediction_nature === "how_much") return "derived_value";
  if (req.prediction_nature === "will_it_happen") return "derived_event";
  return "auto";
}

function convertHorizonToDays(horizon: PredictionRequestBlock["horizon"]): number {
  switch (horizon.unit) {
    case "days": return horizon.value;
    case "weeks": return horizon.value * 7;
    case "months": return horizon.value * 30;
    default: return horizon.value;
  }
}

const ENTITY_LABELS: Partial<Record<EntityGranularity, string>> = {
  customer: "Cliente",
  patient: "Paciente",
  student: "Aluno",
  employee: "Colaborador",
  contract: "Contrato",
  transaction: "Transação",
  product: "Produto",
  account: "Conta",
  household: "Domicílio",
};

// ═══════════════════════════════════════════════════════════════════
// Migration: v1/v2 → v3
// ═══════════════════════════════════════════════════════════════════

import type { IntentContractV2, IntentContractLegacy, IndustryKey } from "./intentContract";

const INDUSTRY_V1_TO_V3: Record<string, IndustryKeyV3> = {
  retail: "retail",
  health: "health",
  finance: "finance",
  education: "education",
  logistics: "logistics",
  generic: "generic",
};

const OBJECTIVE_V1_TO_V3: Record<string, ObjectiveArchetype> = {
  churn: "churn",
  propensity: "propensity",
  demand_forecast: "demand_forecast",
  anomaly: "anomaly_detection",
  segmentation: "segmentation",
  price_optimization: "custom",
  generic_prediction: "custom",
};

const NATURE_FROM_PROBLEM: Record<string, PredictionNature> = {
  classification: "will_it_happen",
  regression: "how_much",
  timeseries: "when",
  segmentation: "who_is_similar",
  clustering: "who_is_similar",
};

const GRANULARITY_FROM_INDUSTRY: Record<string, EntityGranularity> = {
  retail: "customer",
  health: "patient",
  education: "student",
  finance: "account",
  logistics: "transaction",
  hr: "employee",
  generic: "customer",
};

export function migrateV2toV3(v2: IntentContractV2): IntentContractV3 {
  const ib = v2.intent_base;
  const da = v2.domain_adapter;
  const now = new Date().toISOString();

  return {
    contract_version: 3,
    created_at: v2.created_at || now,
    updated_at: now,
    business_context: {
      industry: INDUSTRY_V1_TO_V3[da.industry] || "generic",
      business_decision: ib.declared_objective || "",
      current_process: "none",
    },
    prediction_request: {
      objective: OBJECTIVE_V1_TO_V3[inferObjectiveFromV2(ib)] || "custom",
      prediction_nature: NATURE_FROM_PROBLEM[ib.problem_type] || "will_it_happen",
      prediction_question: ib.declared_objective || "",
      entity_granularity: GRANULARITY_FROM_INDUSTRY[da.industry] || "customer",
      horizon: {
        value: ib.default_window_days || 30,
        unit: "days",
      },
      action_timing: "preventive",
    },
    risk_preferences: {
      worse_error: "both_equal",
      false_alarm_tolerance: "balanced",
      optimize_for: "balanced",
    },
    data_expectations: {
      expected_data_shape: "unknown",
      has_outcome_column: "unsure",
      has_time_column: ib.requires_time_column ? true : "unsure",
      has_entity_id: da.entity_candidates.length > 0 ? true : "unsure",
    },
    business_rules: {
      forbidden_features: [],
      mandatory_features: [],
      known_leakage_columns: da.leakage_watchlist || [],
    },
    user_confidence: {
      data_quality_confidence: "medium",
      target_definition_confidence: "medium",
      ml_experience: "basic",
      prefer_auto_decisions: true,
    },
  };
}

export function migrateLegacyToV3(legacy: IntentContractLegacy): IntentContractV3 {
  const now = new Date().toISOString();

  return {
    contract_version: 3,
    created_at: legacy.created_at || now,
    updated_at: now,
    business_context: {
      industry: INDUSTRY_V1_TO_V3[legacy.industry_hint] || "generic",
      business_decision: legacy.declared_objective || "",
      current_process: "none",
    },
    prediction_request: {
      objective: OBJECTIVE_V1_TO_V3[inferObjectiveFromLegacy(legacy)] || "custom",
      prediction_nature: NATURE_FROM_PROBLEM[legacy.problem_type] || "will_it_happen",
      prediction_question: legacy.declared_objective || "",
      entity_granularity: GRANULARITY_FROM_INDUSTRY[legacy.industry_hint] || "customer",
      horizon: {
        value: legacy.default_window_days || 30,
        unit: "days",
      },
      action_timing: "preventive",
    },
    risk_preferences: {
      worse_error: "both_equal",
      false_alarm_tolerance: "balanced",
      optimize_for: "balanced",
    },
    data_expectations: {
      expected_data_shape: "unknown",
      has_outcome_column: "unsure",
      has_time_column: legacy.requires_time_column ? true : "unsure",
      has_entity_id: legacy.recommended_entity_key ? true : "unsure",
    },
    business_rules: {
      forbidden_features: [],
      mandatory_features: [],
      known_leakage_columns: [],
    },
    user_confidence: {
      data_quality_confidence: "medium",
      target_definition_confidence: "medium",
      ml_experience: "basic",
      prefer_auto_decisions: true,
    },
  };
}

/** Universal normalizer: any version → v3 */
export function normalizeToV3(raw: any): IntentContractV3 | null {
  if (!raw) return null;

  // Already v3
  if (raw.contract_version === 3 && raw.business_context && raw.prediction_request) {
    return raw as IntentContractV3;
  }

  // v2 format
  if (raw.intent_base && raw.domain_adapter) {
    return migrateV2toV3(raw as IntentContractV2);
  }

  // Legacy (v1)
  if (raw.declared_objective || raw.industry_hint) {
    return migrateLegacyToV3(raw as IntentContractLegacy);
  }

  return null;
}

// ─── Helpers ───────────────────────────────────────────────────

function inferObjectiveFromV2(ib: IntentContractV2["intent_base"]): string {
  const obj = ib.declared_objective?.toLowerCase() || "";
  if (obj.includes("churn") || obj.includes("cancel") || obj.includes("evasão")) return "churn";
  if (obj.includes("inadimpl") || obj.includes("default")) return "propensity";
  if (obj.includes("demanda") || obj.includes("forecast")) return "demand_forecast";
  if (obj.includes("fraude") || obj.includes("anomal")) return "anomaly";
  if (obj.includes("segment")) return "segmentation";
  if (obj.includes("turnover") || obj.includes("rotatividade")) return "turnover";
  return "custom";
}

function inferObjectiveFromLegacy(legacy: IntentContractLegacy): string {
  const obj = legacy.declared_objective?.toLowerCase() || "";
  if (obj.includes("churn") || obj.includes("cancel")) return "churn";
  if (obj.includes("inadimpl") || obj.includes("default")) return "propensity";
  if (obj.includes("demanda")) return "demand_forecast";
  if (obj.includes("fraude") || obj.includes("anomal")) return "anomaly";
  if (obj.includes("segment")) return "segmentation";
  return "custom";
}

// ═══════════════════════════════════════════════════════════════════
// Factory: create empty contract with smart defaults
// ═══════════════════════════════════════════════════════════════════

export function createEmptyContractV3(
  industry?: IndustryKeyV3,
  objective?: ObjectiveArchetype
): IntentContractV3 {
  const now = new Date().toISOString();
  return {
    contract_version: 3,
    created_at: now,
    updated_at: now,
    business_context: {
      industry: industry || "generic",
      business_decision: "",
      current_process: "none",
    },
    prediction_request: {
      objective: objective || "custom",
      prediction_nature: "will_it_happen",
      prediction_question: "",
      entity_granularity: GRANULARITY_FROM_INDUSTRY[industry || "generic"] || "customer",
      horizon: {
        value: DEFAULT_HORIZONS[objective || "custom"] || 30,
        unit: "days",
      },
      action_timing: "preventive",
    },
    risk_preferences: {
      worse_error: "both_equal",
      false_alarm_tolerance: "balanced",
      optimize_for: "balanced",
    },
    data_expectations: {
      expected_data_shape: "unknown",
      has_outcome_column: "unsure",
      has_time_column: "unsure",
      has_entity_id: "unsure",
    },
    business_rules: {},
    user_confidence: {
      data_quality_confidence: "medium",
      target_definition_confidence: "medium",
      ml_experience: "basic",
      prefer_auto_decisions: true,
    },
  };
}

const DEFAULT_HORIZONS: Partial<Record<ObjectiveArchetype, number>> = {
  churn: 90,
  propensity: 30,
  default_risk: 30,
  demand_forecast: 30,
  anomaly_detection: 7,
  lifetime_value: 365,
  turnover: 90,
  risk_scoring: 30,
  custom: 30,
};

// ═══════════════════════════════════════════════════════════════════
// UI Field Specification
// ═══════════════════════════════════════════════════════════════════

export type UIFieldType =
  | "dropdown"
  | "text"
  | "textarea"
  | "number"
  | "radio"
  | "checkbox"
  | "toggle"
  | "hidden_default"
  | "slider"
  | "multi_select";

export interface UIFieldSpec {
  field_path: string;
  label_pt: string;
  description_pt: string;
  ui_type: UIFieldType;
  required: boolean;
  visible_by_default: boolean;
  options?: Array<{ value: string; label_pt: string; description_pt?: string }>;
  default_value?: any;
  validation?: string;
  depends_on?: string;
  group: "business_context" | "prediction_request" | "risk_preferences" | "data_expectations" | "business_rules" | "user_confidence";
}

export const UI_FIELD_SPECS: UIFieldSpec[] = [
  // ── Block 1: Business Context ──
  {
    field_path: "business_context.industry",
    label_pt: "Setor da empresa",
    description_pt: "Em qual setor sua empresa atua?",
    ui_type: "dropdown",
    required: true,
    visible_by_default: true,
    options: [
      { value: "retail", label_pt: "Varejo", description_pt: "Lojas, e-commerce, supermercados" },
      { value: "health", label_pt: "Saúde", description_pt: "Hospitais, clínicas, planos de saúde" },
      { value: "finance", label_pt: "Finanças", description_pt: "Bancos, fintechs, seguradoras" },
      { value: "education", label_pt: "Educação", description_pt: "Escolas, universidades, EdTechs" },
      { value: "logistics", label_pt: "Logística", description_pt: "Transporte, entregas, supply chain" },
      { value: "hr", label_pt: "RH / Pessoas", description_pt: "Gestão de pessoas, recrutamento" },
      { value: "insurance", label_pt: "Seguros", description_pt: "Seguradoras, corretoras" },
      { value: "telecom", label_pt: "Telecom", description_pt: "Operadoras, provedores" },
      { value: "generic", label_pt: "Outro", description_pt: "Setor não listado" },
    ],
    group: "business_context",
  },
  {
    field_path: "business_context.business_decision",
    label_pt: "Decisão de negócio",
    description_pt: "Qual decisão este modelo vai ajudar a tomar?",
    ui_type: "textarea",
    required: true,
    visible_by_default: true,
    group: "business_context",
  },
  {
    field_path: "business_context.company_description",
    label_pt: "Sobre a empresa",
    description_pt: "Descreva brevemente o que sua empresa faz (opcional)",
    ui_type: "textarea",
    required: false,
    visible_by_default: false,
    group: "business_context",
  },
  {
    field_path: "business_context.cost_of_inaction",
    label_pt: "Custo de não agir",
    description_pt: "O que acontece se você não tomar essa decisão a tempo?",
    ui_type: "textarea",
    required: false,
    visible_by_default: false,
    group: "business_context",
  },
  {
    field_path: "business_context.current_process",
    label_pt: "Processo atual",
    description_pt: "Como essa decisão é tomada hoje?",
    ui_type: "radio",
    required: false,
    visible_by_default: true,
    options: [
      { value: "manual", label_pt: "Manualmente", description_pt: "Baseado em intuição ou experiência" },
      { value: "rule_based", label_pt: "Regras fixas", description_pt: "Critérios pré-definidos (ex: >30 dias)" },
      { value: "existing_model", label_pt: "Modelo existente", description_pt: "Já uso um modelo preditivo" },
      { value: "none", label_pt: "Não existe", description_pt: "Não tenho processo definido" },
    ],
    default_value: "none",
    group: "business_context",
  },

  // ── Block 2: Prediction Request ──
  {
    field_path: "prediction_request.objective",
    label_pt: "O que você quer prever?",
    description_pt: "Escolha o tipo de previsão mais próximo do seu objetivo",
    ui_type: "dropdown",
    required: true,
    visible_by_default: true,
    options: [
      { value: "churn", label_pt: "Cancelamento / Evasão", description_pt: "Quem vai parar de comprar, usar ou frequentar" },
      { value: "propensity", label_pt: "Propensão / Conversão", description_pt: "Quem vai comprar, converter ou aderir" },
      { value: "default_risk", label_pt: "Inadimplência / Default", description_pt: "Quem vai atrasar ou não pagar" },
      { value: "demand_forecast", label_pt: "Previsão de demanda", description_pt: "Quanto será vendido, produzido ou consumido" },
      { value: "anomaly_detection", label_pt: "Detecção de anomalias", description_pt: "Identificar fraudes, outliers ou eventos atípicos" },
      { value: "segmentation", label_pt: "Segmentação", description_pt: "Agrupar entidades por similaridade" },
      { value: "lifetime_value", label_pt: "Valor do cliente (LTV)", description_pt: "Prever quanto um cliente gerará de receita" },
      { value: "turnover", label_pt: "Turnover / Rotatividade", description_pt: "Prever saída de colaboradores" },
      { value: "risk_scoring", label_pt: "Score de risco", description_pt: "Classificar entidades por nível de risco" },
      { value: "custom", label_pt: "Outro objetivo", description_pt: "Objetivo personalizado" },
    ],
    group: "prediction_request",
  },
  {
    field_path: "prediction_request.custom_objective_text",
    label_pt: "Descreva seu objetivo",
    description_pt: "Explique em suas palavras o que deseja prever",
    ui_type: "textarea",
    required: false,
    visible_by_default: false,
    depends_on: "prediction_request.objective=custom",
    group: "prediction_request",
  },
  {
    field_path: "prediction_request.prediction_nature",
    label_pt: "Tipo de resposta",
    description_pt: "Que tipo de resposta você espera do modelo?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "will_it_happen", label_pt: "Sim ou Não", description_pt: "O evento vai acontecer? (classificação)" },
      { value: "how_much", label_pt: "Um número", description_pt: "Qual será o valor? (regressão)" },
      { value: "when", label_pt: "Quando", description_pt: "Em quanto tempo vai acontecer?" },
      { value: "who_is_similar", label_pt: "Grupos similares", description_pt: "Quem se parece com quem? (segmentação)" },
    ],
    group: "prediction_request",
  },
  {
    field_path: "prediction_request.prediction_question",
    label_pt: "Pergunta preditiva",
    description_pt: "Formule como uma pergunta: 'Qual a probabilidade de...?'",
    ui_type: "textarea",
    required: true,
    visible_by_default: true,
    group: "prediction_request",
  },
  {
    field_path: "prediction_request.entity_granularity",
    label_pt: "Unidade de análise",
    description_pt: "Sobre quem/o quê é a previsão?",
    ui_type: "dropdown",
    required: true,
    visible_by_default: true,
    options: [
      { value: "customer", label_pt: "Cliente" },
      { value: "patient", label_pt: "Paciente" },
      { value: "student", label_pt: "Aluno" },
      { value: "employee", label_pt: "Colaborador" },
      { value: "contract", label_pt: "Contrato" },
      { value: "transaction", label_pt: "Transação" },
      { value: "product", label_pt: "Produto" },
      { value: "account", label_pt: "Conta" },
      { value: "household", label_pt: "Domicílio" },
      { value: "other", label_pt: "Outro" },
    ],
    group: "prediction_request",
  },
  {
    field_path: "prediction_request.horizon.value",
    label_pt: "Horizonte de previsão",
    description_pt: "Com quanta antecedência você precisa da previsão?",
    ui_type: "number",
    required: true,
    visible_by_default: true,
    default_value: 30,
    group: "prediction_request",
  },
  {
    field_path: "prediction_request.horizon.unit",
    label_pt: "Unidade do horizonte",
    description_pt: "",
    ui_type: "dropdown",
    required: true,
    visible_by_default: true,
    options: [
      { value: "days", label_pt: "Dias" },
      { value: "weeks", label_pt: "Semanas" },
      { value: "months", label_pt: "Meses" },
    ],
    default_value: "days",
    group: "prediction_request",
  },
  {
    field_path: "prediction_request.action_timing",
    label_pt: "Quando agir?",
    description_pt: "Quando a ação será tomada em relação ao evento?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "preventive", label_pt: "Antes do evento", description_pt: "Prevenir que aconteça" },
      { value: "reactive", label_pt: "Após o evento", description_pt: "Reagir depois de acontecer" },
      { value: "continuous", label_pt: "Monitoramento contínuo", description_pt: "Acompanhar em tempo real" },
    ],
    default_value: "preventive",
    group: "prediction_request",
  },

  // ── Block 3: Risk Preferences ──
  {
    field_path: "risk_preferences.worse_error",
    label_pt: "Qual erro é pior?",
    description_pt: "O que causa mais dano ao negócio?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "miss_true_positive", label_pt: "Deixar passar um caso real", description_pt: "Ex: não detectar um cliente que vai cancelar" },
      { value: "flag_false_positive", label_pt: "Alarme falso", description_pt: "Ex: marcar como risco quem não é" },
      { value: "both_equal", label_pt: "Ambos são igualmente ruins", description_pt: "Sem preferência clara" },
    ],
    default_value: "both_equal",
    group: "risk_preferences",
  },
  {
    field_path: "risk_preferences.false_alarm_tolerance",
    label_pt: "Tolerância a alarmes falsos",
    description_pt: "Quanto de alarme falso você aceita para não perder casos reais?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "conservative", label_pt: "Conservador", description_pt: "Poucos alarmes falsos, pode perder casos reais" },
      { value: "balanced", label_pt: "Equilibrado", description_pt: "Balanço entre precisão e cobertura" },
      { value: "aggressive", label_pt: "Agressivo", description_pt: "Captura máxima, aceita mais alarmes falsos" },
    ],
    default_value: "balanced",
    group: "risk_preferences",
  },
  {
    field_path: "risk_preferences.optimize_for",
    label_pt: "Otimizar para",
    description_pt: "Qual métrica é mais importante?",
    ui_type: "dropdown",
    required: false,
    visible_by_default: false,
    options: [
      { value: "precision", label_pt: "Precisão", description_pt: "Minimizar alarmes falsos" },
      { value: "recall", label_pt: "Cobertura (Recall)", description_pt: "Não perder casos reais" },
      { value: "f1", label_pt: "F1 (equilibrado)" },
      { value: "revenue", label_pt: "Receita", description_pt: "Maximizar retorno financeiro" },
      { value: "cost_reduction", label_pt: "Redução de custo", description_pt: "Minimizar gastos" },
      { value: "balanced", label_pt: "Automático", description_pt: "O sistema decide" },
    ],
    default_value: "balanced",
    group: "risk_preferences",
  },

  // ── Block 4: Data Expectations ──
  {
    field_path: "data_expectations.expected_data_shape",
    label_pt: "Formato dos dados",
    description_pt: "Como seus dados estão organizados?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "one_row_per_entity", label_pt: "Uma linha por entidade", description_pt: "Ex: uma linha por cliente com resumo" },
      { value: "multiple_rows_per_entity", label_pt: "Múltiplas linhas por entidade", description_pt: "Ex: transações, eventos, registros" },
      { value: "time_series", label_pt: "Série temporal", description_pt: "Dados ordenados no tempo" },
      { value: "unknown", label_pt: "Não sei", description_pt: "O sistema detectará automaticamente" },
    ],
    default_value: "unknown",
    group: "data_expectations",
  },
  {
    field_path: "data_expectations.has_outcome_column",
    label_pt: "Resultado já existe nos dados?",
    description_pt: "Seus dados já têm uma coluna com o resultado que quer prever?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "true", label_pt: "Sim" },
      { value: "false", label_pt: "Não" },
      { value: "unsure", label_pt: "Não sei" },
    ],
    default_value: "unsure",
    group: "data_expectations",
  },
  {
    field_path: "data_expectations.has_time_column",
    label_pt: "Possui coluna de data?",
    description_pt: "Seus dados têm alguma coluna de data ou timestamp?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "true", label_pt: "Sim" },
      { value: "false", label_pt: "Não" },
      { value: "unsure", label_pt: "Não sei" },
    ],
    default_value: "unsure",
    group: "data_expectations",
  },
  {
    field_path: "data_expectations.has_entity_id",
    label_pt: "Possui identificador único?",
    description_pt: "Existe uma coluna que identifica cada entidade (CPF, ID, matrícula)?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "true", label_pt: "Sim" },
      { value: "false", label_pt: "Não" },
      { value: "unsure", label_pt: "Não sei" },
    ],
    default_value: "unsure",
    group: "data_expectations",
  },
  {
    field_path: "data_expectations.approximate_rows",
    label_pt: "Volume aproximado",
    description_pt: "Quantas linhas (aproximadamente) tem seu dataset?",
    ui_type: "dropdown",
    required: false,
    visible_by_default: true,
    options: [
      { value: "under_1k", label_pt: "Menos de 1.000" },
      { value: "1k_10k", label_pt: "1.000 a 10.000" },
      { value: "10k_100k", label_pt: "10.000 a 100.000" },
      { value: "100k_1m", label_pt: "100.000 a 1 milhão" },
      { value: "over_1m", label_pt: "Mais de 1 milhão" },
      { value: "unknown", label_pt: "Não sei" },
    ],
    default_value: "unknown",
    group: "data_expectations",
  },

  // ── Block 5: Business Rules (advanced, hidden by default) ──
  {
    field_path: "business_rules.forbidden_features",
    label_pt: "Colunas proibidas",
    description_pt: "Colunas que NÃO devem ser usadas como features (por motivos de negócio)",
    ui_type: "multi_select",
    required: false,
    visible_by_default: false,
    group: "business_rules",
  },
  {
    field_path: "business_rules.known_leakage_columns",
    label_pt: "Colunas com vazamento de dados",
    description_pt: "Colunas que contêm informação do futuro (ex: data de cancelamento para prever churn)",
    ui_type: "multi_select",
    required: false,
    visible_by_default: false,
    group: "business_rules",
  },
  {
    field_path: "business_rules.custom_rules",
    label_pt: "Regras de negócio adicionais",
    description_pt: "Regras específicas que o modelo deve respeitar",
    ui_type: "textarea",
    required: false,
    visible_by_default: false,
    group: "business_rules",
  },

  // ── Block 6: User Confidence ──
  {
    field_path: "user_confidence.ml_experience",
    label_pt: "Sua experiência com ML",
    description_pt: "Qual seu nível de experiência com machine learning?",
    ui_type: "radio",
    required: true,
    visible_by_default: true,
    options: [
      { value: "none", label_pt: "Nenhuma", description_pt: "Nunca trabalhei com ML" },
      { value: "basic", label_pt: "Básica", description_pt: "Conheço os conceitos" },
      { value: "intermediate", label_pt: "Intermediária", description_pt: "Já construí modelos" },
      { value: "expert", label_pt: "Avançada", description_pt: "Trabalho com ML regularmente" },
    ],
    default_value: "basic",
    group: "user_confidence",
  },
  {
    field_path: "user_confidence.prefer_auto_decisions",
    label_pt: "Decisões automáticas",
    description_pt: "Quer que o sistema tome decisões técnicas automaticamente quando possível?",
    ui_type: "toggle",
    required: true,
    visible_by_default: true,
    default_value: true,
    group: "user_confidence",
  },
  {
    field_path: "user_confidence.data_quality_confidence",
    label_pt: "Confiança nos dados",
    description_pt: "Quão confiante você está na qualidade dos seus dados?",
    ui_type: "radio",
    required: false,
    visible_by_default: false,
    options: [
      { value: "high", label_pt: "Alta", description_pt: "Dados limpos e confiáveis" },
      { value: "medium", label_pt: "Média", description_pt: "Podem ter problemas pontuais" },
      { value: "low", label_pt: "Baixa", description_pt: "Sei que há problemas significativos" },
      { value: "unsure", label_pt: "Não sei" },
    ],
    default_value: "medium",
    group: "user_confidence",
  },
];
