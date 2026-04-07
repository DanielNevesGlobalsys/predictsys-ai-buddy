/**
 * LIS AI OS — Server-side Rollout Configuration
 * Mirrors frontend rollout logic for edge function gating.
 */

export type RolloutPhase = "phase1_observability" | "phase2_assisted" | "phase3_auto";
export type ExecutionModeRollout = "shadow" | "assisted" | "auto";

interface StageRolloutFlag {
  enabled: boolean;
  mode: ExecutionModeRollout;
  agents: string[];
  auto_apply_allowed: boolean;
}

// ─── Current Phase (Change here to promote globally) ───
const CURRENT_PHASE: RolloutPhase = "phase1_observability";

const PHASE_STAGE_FLAGS: Record<RolloutPhase, Record<string, StageRolloutFlag>> = {
  phase1_observability: {
    intent:     { enabled: true,  mode: "assisted", agents: ["data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
    ingestion:  { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    eda:        { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
    targeting:  { enabled: true,  mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    features:   { enabled: true,  mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    builder:    { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    training:   { enabled: true,  mode: "shadow",   agents: ["ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    scoring:    { enabled: true,  mode: "shadow",   agents: ["data_engineer_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    dashboard:  { enabled: true,  mode: "assisted", agents: ["business_analyst_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    governance: { enabled: true,  mode: "auto",     agents: ["governance_agent"], auto_apply_allowed: true },
    general:    { enabled: true,  mode: "assisted", agents: ["business_analyst_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  },
  phase2_assisted: {
    intent:     { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
    ingestion:  { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    eda:        { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
    targeting:  { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    features:   { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    builder:    { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    training:   { enabled: true, mode: "assisted", agents: ["ml_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
    scoring:    { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    dashboard:  { enabled: true, mode: "assisted", agents: ["business_analyst_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: true },
    governance: { enabled: true, mode: "auto",     agents: ["governance_agent"], auto_apply_allowed: true },
    general:    { enabled: true, mode: "assisted", agents: ["business_analyst_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  },
  phase3_auto: {
    intent:     { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
    ingestion:  { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    eda:        { enabled: true, mode: "auto",     agents: ["data_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: true },
    targeting:  { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    features:   { enabled: true, mode: "assisted", agents: ["data_scientist_agent", "data_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    builder:    { enabled: true, mode: "auto",     agents: ["data_engineer_agent", "governance_agent"], auto_apply_allowed: true },
    training:   { enabled: true, mode: "assisted", agents: ["ml_engineer_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
    scoring:    { enabled: true, mode: "assisted", agents: ["data_engineer_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: false },
    dashboard:  { enabled: true, mode: "auto",     agents: ["business_analyst_agent", "ml_engineer_agent", "governance_agent"], auto_apply_allowed: true },
    governance: { enabled: true, mode: "auto",     agents: ["governance_agent"], auto_apply_allowed: true },
    general:    { enabled: true, mode: "assisted", agents: ["business_analyst_agent", "data_scientist_agent", "governance_agent"], auto_apply_allowed: false },
  },
};

export function getCurrentPhase(): RolloutPhase {
  return CURRENT_PHASE;
}

export function isStageEnabled(stage: string): boolean {
  const flags = PHASE_STAGE_FLAGS[CURRENT_PHASE];
  return flags[stage]?.enabled ?? false;
}

export function isAgentAllowed(stage: string, agentName: string): boolean {
  const flags = PHASE_STAGE_FLAGS[CURRENT_PHASE];
  const stageFlag = flags[stage];
  if (!stageFlag?.enabled) return false;
  return stageFlag.agents.includes(agentName);
}

export function getEffectiveMode(stage: string, requestedMode: string): ExecutionModeRollout {
  const flags = PHASE_STAGE_FLAGS[CURRENT_PHASE];
  const stageFlag = flags[stage];
  if (!stageFlag) return "shadow";

  const modeRank: Record<string, number> = { shadow: 0, assisted: 1, auto: 2 };
  const maxAllowed = modeRank[stageFlag.mode] ?? 0;
  const requested = modeRank[requestedMode] ?? 0;

  // Clamp to the max allowed mode for this phase
  if (requested > maxAllowed) {
    return stageFlag.mode;
  }
  return requestedMode as ExecutionModeRollout;
}

export function isAutoApplyAllowed(stage: string): boolean {
  const flags = PHASE_STAGE_FLAGS[CURRENT_PHASE];
  return flags[stage]?.auto_apply_allowed ?? false;
}

export function getRolloutMetadata() {
  return {
    phase: CURRENT_PHASE,
    stages: PHASE_STAGE_FLAGS[CURRENT_PHASE],
  };
}
