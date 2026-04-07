/**
 * LIS AI OS — Rollout Configuration & Feature Flags
 * Controls gradual activation of agents, stages, and modes.
 */

import type { ExecutionMode, ApplicationPolicy } from "@/types/lisOrchestration";

// ─── Types ───

export type RolloutPhase = "phase1_observability" | "phase2_assisted" | "phase3_auto";
export type RolloutEnvironment = "dev" | "staging" | "prod";
export type UserVisibility = "standard" | "expert" | "admin";

export interface StageFlag {
  enabled: boolean;
  mode: ExecutionMode;
  agents: string[];
  auto_apply_allowed: boolean;
}

export interface RolloutConfig {
  enabled: boolean;
  phase: RolloutPhase;
  environment: RolloutEnvironment;
  organization_overrides: Record<string, Partial<RolloutConfig>>;
  project_overrides: Record<string, Partial<RolloutConfig>>;
  stage_flags: Record<string, StageFlag>;
  visibility_policy: Record<UserVisibility, VisibilityPolicy>;
  fallback_mode: ExecutionMode;
  graceful_degradation: boolean;
}

export interface VisibilityPolicy {
  show_agent_name: boolean;
  show_confidence: boolean;
  show_reasoning: boolean;
  show_warnings: boolean;
  show_blocks: boolean;
  show_audit_history: boolean;
  show_raw_output: boolean;
  show_feature_flags: boolean;
  show_mode_badge: boolean;
  show_execution_metadata: boolean;
}

export interface RolloutReport {
  environment: RolloutEnvironment;
  phase: RolloutPhase;
  organization_id: string | null;
  projects_monitored: number;
  agents_active: string[];
  stages_active: string[];
  execution_counts: Record<string, number>;
  recommendations_accepted: number;
  recommendations_rejected: number;
  blocks_triggered: number;
  critical_failures_prevented: number;
  ui_consistency_score: number;
  chat_consistency_score: number;
  operational_value_summary: string[];
  rollout_readiness_next_phase: "not_ready" | "partial" | "ready";
}

// ─── Phase Definitions ───

const PHASE1_STAGE_FLAGS: Record<string, StageFlag> = {
  intent:    { enabled: true,  mode: "assisted", agents: ["data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  ingestion: { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "governance_agent"],  auto_apply_allowed: false },
  eda:       { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  targeting: { enabled: true,  mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  features:  { enabled: true,  mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  builder:   { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "governance_agent"],  auto_apply_allowed: false },
  training:  { enabled: true,  mode: "shadow",   agents: ["ml_engineer_agent", "governance_agent"],    auto_apply_allowed: false },
  scoring:   { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  dashboard: { enabled: true,  mode: "assisted", agents: ["business_analyst_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  governance:{ enabled: true,  mode: "auto",     agents: ["governance_agent"], auto_apply_allowed: true },
};

const PHASE2_STAGE_FLAGS: Record<string, StageFlag> = {
  intent:    { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  ingestion: { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "governance_agent"],  auto_apply_allowed: false },
  eda:       { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  targeting: { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  features:  { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  builder:   { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "governance_agent"],  auto_apply_allowed: false },
  training:  { enabled: true, mode: "assisted", agents: ["ml_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  scoring:   { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  dashboard: { enabled: true, mode: "assisted", agents: ["business_analyst_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: true },
  governance:{ enabled: true, mode: "auto",     agents: ["governance_agent"], auto_apply_allowed: true },
};

const PHASE3_STAGE_FLAGS: Record<string, StageFlag> = {
  intent:    { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  ingestion: { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "governance_agent"],  auto_apply_allowed: false },
  eda:       { enabled: true, mode: "auto",     agents: ["data_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: true },
  targeting: { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  features:  { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  builder:   { enabled: true, mode: "auto",     agents: ["data_engineer_agent", "governance_agent"],  auto_apply_allowed: true },
  training:  { enabled: true, mode: "assisted", agents: ["ml_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  scoring:   { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
  dashboard: { enabled: true, mode: "auto",     agents: ["business_analyst_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: true },
  governance:{ enabled: true, mode: "auto",     agents: ["governance_agent"], auto_apply_allowed: true },
};

// ─── Visibility Policies ───

const VISIBILITY_POLICIES: Record<UserVisibility, VisibilityPolicy> = {
  standard: {
    show_agent_name: false,
    show_confidence: false,
    show_reasoning: false,
    show_warnings: true,
    show_blocks: true,
    show_audit_history: false,
    show_raw_output: false,
    show_feature_flags: false,
    show_mode_badge: false,
    show_execution_metadata: false,
  },
  expert: {
    show_agent_name: true,
    show_confidence: true,
    show_reasoning: true,
    show_warnings: true,
    show_blocks: true,
    show_audit_history: true,
    show_raw_output: false,
    show_feature_flags: false,
    show_mode_badge: true,
    show_execution_metadata: true,
  },
  admin: {
    show_agent_name: true,
    show_confidence: true,
    show_reasoning: true,
    show_warnings: true,
    show_blocks: true,
    show_audit_history: true,
    show_raw_output: true,
    show_feature_flags: true,
    show_mode_badge: true,
    show_execution_metadata: true,
  },
};

// ─── Default Config ───

function buildDefaultConfig(phase: RolloutPhase): RolloutConfig {
  const stageMap: Record<RolloutPhase, Record<string, StageFlag>> = {
    phase1_observability: PHASE1_STAGE_FLAGS,
    phase2_assisted: PHASE2_STAGE_FLAGS,
    phase3_auto: PHASE3_STAGE_FLAGS,
  };

  return {
    enabled: true,
    phase,
    environment: "prod",
    organization_overrides: {},
    project_overrides: {},
    stage_flags: stageMap[phase],
    visibility_policy: VISIBILITY_POLICIES,
    fallback_mode: "shadow",
    graceful_degradation: true,
  };
}

// ─── Current active config (Phase 1 by default) ───
let _activeConfig: RolloutConfig = buildDefaultConfig("phase1_observability");

export function getLisRolloutConfig(): RolloutConfig {
  return _activeConfig;
}

export function setLisRolloutPhase(phase: RolloutPhase): void {
  _activeConfig = buildDefaultConfig(phase);
  console.debug(`[LIS Rollout] Phase set to: ${phase}`);
}

// ─── Resolution helpers ───

export function resolveStageFlag(
  stage: string,
  organizationId?: string,
  projectId?: string,
): StageFlag | null {
  const config = getLisRolloutConfig();
  if (!config.enabled) return null;

  // Project override
  if (projectId && config.project_overrides[projectId]) {
    const projFlags = config.project_overrides[projectId].stage_flags;
    if (projFlags?.[stage]) return projFlags[stage];
  }

  // Org override
  if (organizationId && config.organization_overrides[organizationId]) {
    const orgFlags = config.organization_overrides[organizationId].stage_flags;
    if (orgFlags?.[stage]) return orgFlags[stage];
  }

  // Default
  const flag = config.stage_flags[stage];
  if (!flag) {
    // Fallback: disabled
    return { enabled: false, mode: config.fallback_mode, agents: [], auto_apply_allowed: false };
  }

  return flag;
}

export function isStageEnabled(
  stage: string,
  organizationId?: string,
  projectId?: string,
): boolean {
  const flag = resolveStageFlag(stage, organizationId, projectId);
  return flag?.enabled ?? false;
}

export function getStageMode(
  stage: string,
  organizationId?: string,
  projectId?: string,
): ExecutionMode {
  const flag = resolveStageFlag(stage, organizationId, projectId);
  return flag?.mode ?? getLisRolloutConfig().fallback_mode;
}

export function getVisibilityPolicy(role: UserVisibility): VisibilityPolicy {
  return VISIBILITY_POLICIES[role];
}

export function isAgentEnabledForStage(
  stage: string,
  agentName: string,
  organizationId?: string,
  projectId?: string,
): boolean {
  const flag = resolveStageFlag(stage, organizationId, projectId);
  if (!flag?.enabled) return false;
  return flag.agents.includes(agentName);
}

// ─── Phase transition criteria ───

export interface PhaseTransitionCriteria {
  min_executions: number;
  max_inconsistency_rate: number;
  min_recommendation_acceptance_rate: number;
  zero_destructive_auto_actions: boolean;
  min_ui_consistency_score: number;
  min_chat_consistency_score: number;
}

export const PHASE_TRANSITION_CRITERIA: Record<string, PhaseTransitionCriteria> = {
  phase1_to_phase2: {
    min_executions: 50,
    max_inconsistency_rate: 0.05,
    min_recommendation_acceptance_rate: 0,
    zero_destructive_auto_actions: true,
    min_ui_consistency_score: 0.8,
    min_chat_consistency_score: 0.7,
  },
  phase2_to_phase3: {
    min_executions: 200,
    max_inconsistency_rate: 0.02,
    min_recommendation_acceptance_rate: 0.6,
    zero_destructive_auto_actions: true,
    min_ui_consistency_score: 0.9,
    min_chat_consistency_score: 0.85,
  },
};

export function evaluatePhaseReadiness(
  report: RolloutReport,
  transition: string,
): { ready: boolean; reasons: string[] } {
  const criteria = PHASE_TRANSITION_CRITERIA[transition];
  if (!criteria) return { ready: false, reasons: ["Unknown transition"] };

  const reasons: string[] = [];
  const totalExec = Object.values(report.execution_counts).reduce((a, b) => a + b, 0);

  if (totalExec < criteria.min_executions) {
    reasons.push(`Execuções insuficientes: ${totalExec}/${criteria.min_executions}`);
  }
  if (report.ui_consistency_score < criteria.min_ui_consistency_score) {
    reasons.push(`UI consistency baixa: ${report.ui_consistency_score}`);
  }
  if (report.chat_consistency_score < criteria.min_chat_consistency_score) {
    reasons.push(`Chat consistency baixa: ${report.chat_consistency_score}`);
  }

  const totalRecs = report.recommendations_accepted + report.recommendations_rejected;
  if (totalRecs > 0) {
    const acceptRate = report.recommendations_accepted / totalRecs;
    if (acceptRate < criteria.min_recommendation_acceptance_rate) {
      reasons.push(`Taxa de aceitação baixa: ${(acceptRate * 100).toFixed(1)}%`);
    }
  }

  return { ready: reasons.length === 0, reasons };
}

// ─── Empty report factory ───

export function createEmptyRolloutReport(
  organizationId?: string,
): RolloutReport {
  const config = getLisRolloutConfig();
  return {
    environment: config.environment,
    phase: config.phase,
    organization_id: organizationId ?? null,
    projects_monitored: 0,
    agents_active: [],
    stages_active: [],
    execution_counts: {},
    recommendations_accepted: 0,
    recommendations_rejected: 0,
    blocks_triggered: 0,
    critical_failures_prevented: 0,
    ui_consistency_score: 0,
    chat_consistency_score: 0,
    operational_value_summary: [],
    rollout_readiness_next_phase: "not_ready",
  };
}
