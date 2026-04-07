/**
 * LIS AI OS — Orchestration types (frontend)
 */

export type ApplicationPolicy = "insight" | "recommendation" | "warning" | "block" | "auto_apply";
export type ExecutionMode = "shadow" | "assisted" | "auto";

export interface StageOrchestrationConfig {
  stage: string;
  primary_agent: string;
  secondary_agents: string[];
  validator_agent: string;
  default_mode: ExecutionMode;
  application_policy: ApplicationPolicy;
  auto_apply_allowed: boolean;
  description: string;
}

export interface OrchestratedRunResult {
  project_id: string;
  stage: string;
  primary_agent: string;
  secondary_agents: string[];
  validator_agent: string;
  execution_mode: ExecutionMode;
  application_policy: ApplicationPolicy;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  primary_execution_id: string | null;
  validator_execution_id: string | null;
  primary_decision: Record<string, unknown> | null;
  validator_decision: Record<string, unknown> | null;
  applied: boolean;
  applied_at: string | null;
  blocked_by: string | null;
  confidence: number;
}

// ─── Stage Orchestration Map (mirrors backend) ───

export const STAGE_ORCHESTRATION_MAP: Record<string, StageOrchestrationConfig> = {
  intent: {
    stage: "intent",
    primary_agent: "data_scientist_agent",
    secondary_agents: [],
    validator_agent: "governance_agent",
    default_mode: "assisted",
    application_policy: "recommendation",
    auto_apply_allowed: false,
    description: "Formulação inicial do problema preditivo",
  },
  ingestion: {
    stage: "ingestion",
    primary_agent: "data_engineer_agent",
    secondary_agents: [],
    validator_agent: "governance_agent",
    default_mode: "shadow",
    application_policy: "insight",
    auto_apply_allowed: false,
    description: "Validação de schema e parsing na ingestão",
  },
  eda: {
    stage: "eda",
    primary_agent: "data_engineer_agent",
    secondary_agents: ["data_scientist_agent"],
    validator_agent: "governance_agent",
    default_mode: "shadow",
    application_policy: "insight",
    auto_apply_allowed: false,
    description: "Análise exploratória e validação do schema real",
  },
  targeting: {
    stage: "targeting",
    primary_agent: "data_scientist_agent",
    secondary_agents: ["data_engineer_agent"],
    validator_agent: "governance_agent",
    default_mode: "assisted",
    application_policy: "recommendation",
    auto_apply_allowed: false,
    description: "Seleção de target, entity, time, grain e features",
  },
  features: {
    stage: "features",
    primary_agent: "data_scientist_agent",
    secondary_agents: ["data_engineer_agent"],
    validator_agent: "governance_agent",
    default_mode: "assisted",
    application_policy: "recommendation",
    auto_apply_allowed: false,
    description: "Feature engineering e validação de leakage",
  },
  builder: {
    stage: "builder",
    primary_agent: "data_engineer_agent",
    secondary_agents: [],
    validator_agent: "governance_agent",
    default_mode: "assisted",
    application_policy: "recommendation",
    auto_apply_allowed: false,
    description: "Definição do dataset_build_mode e materialização",
  },
  training: {
    stage: "training",
    primary_agent: "ml_engineer_agent",
    secondary_agents: ["data_scientist_agent"],
    validator_agent: "governance_agent",
    default_mode: "shadow",
    application_policy: "insight",
    auto_apply_allowed: false,
    description: "Avaliação de qualidade, robustez e deploy readiness",
  },
  scoring: {
    stage: "scoring",
    primary_agent: "data_engineer_agent",
    secondary_agents: ["ml_engineer_agent"],
    validator_agent: "governance_agent",
    default_mode: "assisted",
    application_policy: "warning",
    auto_apply_allowed: false,
    description: "Validação de compatibilidade treino x scoring",
  },
  dashboard: {
    stage: "dashboard",
    primary_agent: "business_analyst_agent",
    secondary_agents: ["ml_engineer_agent"],
    validator_agent: "governance_agent",
    default_mode: "assisted",
    application_policy: "recommendation",
    auto_apply_allowed: true,
    description: "Tradução de score em decisão e narrativa executiva",
  },
  governance: {
    stage: "governance",
    primary_agent: "governance_agent",
    secondary_agents: [],
    validator_agent: "governance_agent",
    default_mode: "auto",
    application_policy: "block",
    auto_apply_allowed: true,
    description: "Auditoria e validação de governança do pipeline",
  },
  general: {
    stage: "general",
    primary_agent: "business_analyst_agent",
    secondary_agents: ["data_scientist_agent"],
    validator_agent: "governance_agent",
    default_mode: "assisted",
    application_policy: "insight",
    auto_apply_allowed: false,
    description: "Consultas genéricas e tradução de resultados",
  },
};
