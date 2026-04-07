/**
 * LIS AI OS — Scenario Tests
 * Tests the 7 integration scenarios: happy path, governance conflict,
 * leakage, builder stale, scoring incompatible, weak narrative, bad dataset.
 */
import { describe, it, expect } from "vitest";
import {
  STAGE_ORCHESTRATION_MAP,
  type ApplicationPolicy,
} from "@/types/lisOrchestration";

// ─── Helpers to simulate orchestrated decisions ───

interface SimulatedDecision {
  status: "success" | "warning" | "blocked" | "failed";
  confidence: number;
  blocking_issues: string[];
  warnings: string[];
}

function simulatePolicy(
  policy: ApplicationPolicy,
  primaryDecision: SimulatedDecision,
  validatorDecision?: SimulatedDecision,
): {
  shouldBlock: boolean;
  canAutoApply: boolean;
  effectiveStatus: string;
} {
  const isBlocked =
    validatorDecision?.status === "blocked" ||
    (policy === "block" && primaryDecision.status === "blocked");

  const canAutoApply =
    !isBlocked &&
    primaryDecision.confidence >= 0.7 &&
    primaryDecision.status !== "failed" &&
    ["auto_apply"].includes(policy);

  return {
    shouldBlock: isBlocked,
    canAutoApply,
    effectiveStatus: isBlocked ? "blocked" : primaryDecision.status,
  };
}

// ─── Scenario A: Happy Path ───

describe("Scenario A — Happy Path", () => {
  it("all stages produce success without blocks", () => {
    const stages = ["intent", "eda", "targeting", "builder", "training", "scoring", "dashboard"];
    for (const stage of stages) {
      const config = STAGE_ORCHESTRATION_MAP[stage];
      const primary: SimulatedDecision = { status: "success", confidence: 0.85, blocking_issues: [], warnings: [] };
      const validator: SimulatedDecision = { status: "success", confidence: 0.9, blocking_issues: [], warnings: [] };

      const result = simulatePolicy(config.application_policy, primary, validator);
      expect(result.shouldBlock).toBe(false);
      expect(result.effectiveStatus).toBe("success");
    }
  });
});

// ─── Scenario B: Governance Conflict ───

describe("Scenario B — Governance Conflict", () => {
  it("governance blocks when target is incompatible", () => {
    const config = STAGE_ORCHESTRATION_MAP.targeting;
    const primary: SimulatedDecision = { status: "success", confidence: 0.8, blocking_issues: [], warnings: [] };
    const validator: SimulatedDecision = {
      status: "blocked",
      confidence: 0.95,
      blocking_issues: ["Target recomendado difere do oficial"],
      warnings: [],
    };

    const result = simulatePolicy(config.application_policy, primary, validator);
    expect(result.shouldBlock).toBe(true);
    expect(result.effectiveStatus).toBe("blocked");
  });

  it("official target wins over recommendation", () => {
    // Governance validator blocks → recommendation does not get applied
    const config = STAGE_ORCHESTRATION_MAP.targeting;
    expect(config.auto_apply_allowed).toBe(false);
  });
});

// ─── Scenario C: Leakage Ativo ───

describe("Scenario C — Active Leakage", () => {
  it("governance blocks builder/training when leakage detected", () => {
    for (const stage of ["builder", "training"]) {
      const config = STAGE_ORCHESTRATION_MAP[stage];
      const primary: SimulatedDecision = { status: "warning", confidence: 0.6, blocking_issues: [], warnings: ["Possible leakage"] };
      const validator: SimulatedDecision = {
        status: "blocked",
        confidence: 0.95,
        blocking_issues: ["Feature bloqueada ainda presente nas features finais"],
        warnings: [],
      };

      const result = simulatePolicy(config.application_policy, primary, validator);
      expect(result.shouldBlock).toBe(true);
    }
  });
});

// ─── Scenario D: Builder Stale ───

describe("Scenario D — Builder Stale", () => {
  it("governance blocks training when builder is stale", () => {
    const config = STAGE_ORCHESTRATION_MAP.training;
    const primary: SimulatedDecision = { status: "success", confidence: 0.8, blocking_issues: [], warnings: [] };
    const validator: SimulatedDecision = {
      status: "blocked",
      confidence: 0.95,
      blocking_issues: ["Builder stale: selection mudou sem rebuild"],
      warnings: [],
    };

    const result = simulatePolicy(config.application_policy, primary, validator);
    expect(result.shouldBlock).toBe(true);
  });
});

// ─── Scenario E: Scoring Incompatível ───

describe("Scenario E — Incompatible Scoring", () => {
  it("data engineer detects feature space mismatch", () => {
    const config = STAGE_ORCHESTRATION_MAP.scoring;
    const primary: SimulatedDecision = {
      status: "blocked",
      confidence: 0.9,
      blocking_issues: ["Feature space do scoring não bate com treino"],
      warnings: [],
    };
    const validator: SimulatedDecision = {
      status: "blocked",
      confidence: 0.95,
      blocking_issues: ["Schema incompatível entre treino e scoring"],
      warnings: [],
    };

    const result = simulatePolicy(config.application_policy, primary, validator);
    expect(result.shouldBlock).toBe(true);
  });
});

// ─── Scenario F: Weak Narrative ───

describe("Scenario F — Weak Dashboard Narrative", () => {
  it("business analyst recommends dashboard improvements", () => {
    const config = STAGE_ORCHESTRATION_MAP.dashboard;
    const primary: SimulatedDecision = {
      status: "warning",
      confidence: 0.6,
      blocking_issues: [],
      warnings: ["Dashboard com blocos pouco acionáveis"],
    };
    const validator: SimulatedDecision = { status: "success", confidence: 0.8, blocking_issues: [], warnings: [] };

    const result = simulatePolicy(config.application_policy, primary, validator);
    expect(result.shouldBlock).toBe(false);
    expect(result.effectiveStatus).toBe("warning");
  });

  it("dashboard allows auto_apply when confidence is high", () => {
    const config = STAGE_ORCHESTRATION_MAP.dashboard;
    expect(config.auto_apply_allowed).toBe(true);
  });
});

// ─── Scenario G: Problematic Dataset ───

describe("Scenario G — Problematic Dataset", () => {
  it("data engineer detects parsing/schema risk", () => {
    const config = STAGE_ORCHESTRATION_MAP.ingestion;
    const primary: SimulatedDecision = {
      status: "warning",
      confidence: 0.5,
      blocking_issues: [],
      warnings: ["Delimiter incorreto detectado", "Schema instável"],
    };

    const result = simulatePolicy(config.application_policy, primary);
    expect(result.shouldBlock).toBe(false);
    expect(result.effectiveStatus).toBe("warning");
  });

  it("governance can escalate to block for critical schema issues", () => {
    const config = STAGE_ORCHESTRATION_MAP.ingestion;
    const primary: SimulatedDecision = { status: "warning", confidence: 0.3, blocking_issues: [], warnings: [] };
    const validator: SimulatedDecision = {
      status: "blocked",
      confidence: 0.95,
      blocking_issues: ["Base não sustenta o pipeline: 0 colunas numéricas"],
      warnings: [],
    };

    const result = simulatePolicy(config.application_policy, primary, validator);
    expect(result.shouldBlock).toBe(true);
  });
});

// ─── Execution Mode Behavior ───

describe("Execution Mode Behavior", () => {
  it("shadow mode does not enable auto_apply regardless of confidence", () => {
    const shadowStages = Object.entries(STAGE_ORCHESTRATION_MAP)
      .filter(([_, c]) => c.default_mode === "shadow");

    for (const [stage, config] of shadowStages) {
      expect(config.auto_apply_allowed).toBe(false);
    }
  });

  it("auto mode with governance can still block", () => {
    const config = STAGE_ORCHESTRATION_MAP.governance;
    const primary: SimulatedDecision = {
      status: "blocked",
      confidence: 0.99,
      blocking_issues: ["Violação crítica de governança"],
      warnings: [],
    };

    const result = simulatePolicy(config.application_policy, primary);
    expect(result.shouldBlock).toBe(true);
  });
});
