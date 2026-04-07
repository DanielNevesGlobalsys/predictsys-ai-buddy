/**
 * LIS AI OS — Orchestration Configuration
 * Stage routing, execution policies, and application rules.
 */

// ─── Application Policy Types ───

export type ApplicationPolicy = "insight" | "recommendation" | "warning" | "block" | "auto_apply";
export type ExecutionMode = "shadow" | "assisted" | "auto";

export interface StageOrchestration {
  stage: string;
  primary_agent: string;
  secondary_agents: string[];
  validator_agent: string;
  default_mode: ExecutionMode;
  application_policy: ApplicationPolicy;
  auto_apply_allowed: boolean;
  description: string;
}

// ─── Official Stage Routing Map ───

export const STAGE_ORCHESTRATION: Record<string, StageOrchestration> = {
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

// ─── Orchestrated Run Contract ───

export interface OrchestratedRunContract {
  project_id: string;
  stage: string;
  primary_agent: string;
  secondary_agents: string[];
  validator_agent: string;
  execution_mode: ExecutionMode;
  application_policy: ApplicationPolicy;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  primary_decision: Record<string, unknown> | null;
  validator_decision: Record<string, unknown> | null;
  applied: boolean;
  applied_at: string | null;
  blocked_by: string | null;
  superseded_by: string | null;
  audit_metadata: Record<string, unknown>;
}

// ─── Resolve Orchestration for Stage ───

export function resolveOrchestration(
  stage: string,
  modeOverride?: ExecutionMode,
): StageOrchestration {
  const config = STAGE_ORCHESTRATION[stage] || STAGE_ORCHESTRATION.general;
  if (modeOverride) {
    return { ...config, default_mode: modeOverride };
  }
  return config;
}

// ─── Determine if output should block pipeline ───

export function shouldBlock(
  policy: ApplicationPolicy,
  agentStatus: string,
  validatorStatus?: string,
): boolean {
  if (policy === "block" && (agentStatus === "blocked" || validatorStatus === "blocked")) {
    return true;
  }
  if (validatorStatus === "blocked") {
    return true;
  }
  return false;
}

// ─── Determine if output can be auto-applied ───

export function canAutoApply(
  config: StageOrchestration,
  confidence: number,
  agentStatus: string,
  validatorStatus?: string,
): boolean {
  if (!config.auto_apply_allowed) return false;
  if (agentStatus === "blocked" || agentStatus === "failed") return false;
  if (validatorStatus === "blocked") return false;
  if (confidence < 0.7) return false;
  return true;
}

// ─── Build orchestrated run summary ───

export function buildRunSummary(
  config: StageOrchestration,
  primaryResult: Record<string, unknown>,
  validatorResult?: Record<string, unknown>,
): OrchestratedRunContract {
  const primaryStatus = (primaryResult.status as string) || "completed";
  const validatorStatus = validatorResult ? (validatorResult.status as string) : undefined;
  const confidence = (primaryResult.confidence as number) || 0;

  const blocked = shouldBlock(config.application_policy, primaryStatus, validatorStatus);
  const autoApplied = !blocked && canAutoApply(config, confidence, primaryStatus, validatorStatus);

  return {
    project_id: "",
    stage: config.stage,
    primary_agent: config.primary_agent,
    secondary_agents: config.secondary_agents,
    validator_agent: config.validator_agent,
    execution_mode: config.default_mode,
    application_policy: config.application_policy,
    status: blocked ? "blocked" : "completed",
    primary_decision: primaryResult,
    validator_decision: validatorResult || null,
    applied: autoApplied,
    applied_at: autoApplied ? new Date().toISOString() : null,
    blocked_by: blocked ? (validatorStatus === "blocked" ? config.validator_agent : config.primary_agent) : null,
    superseded_by: null,
    audit_metadata: {
      confidence,
      auto_apply_eligible: config.auto_apply_allowed,
      auto_applied: autoApplied,
    },
  };
}

// ─── Get agents for a stage ───

export function getStageAgents(stage: string): {
  primary: string;
  secondary: string[];
  validator: string;
} {
  const config = STAGE_ORCHESTRATION[stage] || STAGE_ORCHESTRATION.general;
  return {
    primary: config.primary_agent,
    secondary: config.secondary_agents,
    validator: config.validator_agent,
  };
}
