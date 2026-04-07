/**
 * LIS AI OS — Orchestration Logic Unit Tests
 * Tests stage routing, policies, and orchestration functions.
 */
import { describe, it, expect } from "vitest";
import {
  STAGE_ORCHESTRATION_MAP,
  type StageOrchestrationConfig,
  type ApplicationPolicy,
} from "@/types/lisOrchestration";

// ─── Stage Routing Matrix ───

describe("LIS Stage Orchestration Map", () => {
  const EXPECTED_ROUTING: Record<string, {
    primary: string;
    validator: string;
    mode: string;
    policy: ApplicationPolicy;
  }> = {
    intent:     { primary: "data_scientist_agent",  validator: "governance_agent", mode: "assisted", policy: "recommendation" },
    ingestion:  { primary: "data_engineer_agent",   validator: "governance_agent", mode: "shadow",   policy: "insight" },
    eda:        { primary: "data_engineer_agent",   validator: "governance_agent", mode: "shadow",   policy: "insight" },
    targeting:  { primary: "data_scientist_agent",  validator: "governance_agent", mode: "assisted", policy: "recommendation" },
    features:   { primary: "data_scientist_agent",  validator: "governance_agent", mode: "assisted", policy: "recommendation" },
    builder:    { primary: "data_engineer_agent",   validator: "governance_agent", mode: "assisted", policy: "recommendation" },
    training:   { primary: "ml_engineer_agent",     validator: "governance_agent", mode: "shadow",   policy: "insight" },
    scoring:    { primary: "data_engineer_agent",   validator: "governance_agent", mode: "assisted", policy: "warning" },
    dashboard:  { primary: "business_analyst_agent", validator: "governance_agent", mode: "assisted", policy: "recommendation" },
    governance: { primary: "governance_agent",      validator: "governance_agent", mode: "auto",     policy: "block" },
    general:    { primary: "business_analyst_agent", validator: "governance_agent", mode: "assisted", policy: "insight" },
  };

  it("covers all expected stages", () => {
    for (const stage of Object.keys(EXPECTED_ROUTING)) {
      expect(STAGE_ORCHESTRATION_MAP).toHaveProperty(stage);
    }
  });

  for (const [stage, expected] of Object.entries(EXPECTED_ROUTING)) {
    describe(`Stage: ${stage}`, () => {
      const config = STAGE_ORCHESTRATION_MAP[stage];

      it("has correct primary agent", () => {
        expect(config.primary_agent).toBe(expected.primary);
      });

      it("has governance as validator", () => {
        expect(config.validator_agent).toBe(expected.validator);
      });

      it("has correct default mode", () => {
        expect(config.default_mode).toBe(expected.mode);
      });

      it("has correct application policy", () => {
        expect(config.application_policy).toBe(expected.policy);
      });

      it("has valid stage name", () => {
        expect(config.stage).toBe(stage);
      });

      it("has description", () => {
        expect(config.description).toBeTruthy();
      });
    });
  }

  it("auto_apply is only enabled for dashboard and governance", () => {
    for (const [stage, config] of Object.entries(STAGE_ORCHESTRATION_MAP)) {
      if (stage === "dashboard" || stage === "governance") {
        expect(config.auto_apply_allowed).toBe(true);
      } else {
        expect(config.auto_apply_allowed).toBe(false);
      }
    }
  });

  it("governance is always the validator", () => {
    for (const config of Object.values(STAGE_ORCHESTRATION_MAP)) {
      expect(config.validator_agent).toBe("governance_agent");
    }
  });
});

// ─── Application Policy Logic ───

describe("Application Policy Rules", () => {
  it("insight policy does not allow auto_apply", () => {
    const insightStages = Object.values(STAGE_ORCHESTRATION_MAP).filter(
      (c) => c.application_policy === "insight",
    );
    for (const stage of insightStages) {
      expect(stage.auto_apply_allowed).toBe(false);
    }
  });

  it("block policy stages have auto_apply for governance only", () => {
    const blockStages = Object.values(STAGE_ORCHESTRATION_MAP).filter(
      (c) => c.application_policy === "block",
    );
    for (const stage of blockStages) {
      expect(stage.primary_agent).toBe("governance_agent");
    }
  });

  it("recommendation stages use assisted mode by default", () => {
    const recStages = Object.values(STAGE_ORCHESTRATION_MAP).filter(
      (c) => c.application_policy === "recommendation",
    );
    for (const stage of recStages) {
      expect(stage.default_mode).toBe("assisted");
    }
  });
});

// ─── Execution Mode Rules ───

describe("Execution Modes", () => {
  it("shadow mode stages are observation-only (insight policy)", () => {
    const shadowStages = Object.values(STAGE_ORCHESTRATION_MAP).filter(
      (c) => c.default_mode === "shadow",
    );
    for (const stage of shadowStages) {
      expect(["insight", "warning"]).toContain(stage.application_policy);
    }
  });

  it("auto mode is only used for governance stage", () => {
    const autoStages = Object.values(STAGE_ORCHESTRATION_MAP).filter(
      (c) => c.default_mode === "auto",
    );
    expect(autoStages).toHaveLength(1);
    expect(autoStages[0].stage).toBe("governance");
  });
});

// ─── Agent Coverage ───

describe("Agent Coverage", () => {
  const ALL_AGENTS = [
    "governance_agent",
    "data_scientist_agent",
    "data_engineer_agent",
    "ml_engineer_agent",
    "business_analyst_agent",
  ];

  it("all 5 agents appear as primary in at least one stage", () => {
    const primaryAgents = new Set(
      Object.values(STAGE_ORCHESTRATION_MAP).map((c) => c.primary_agent),
    );
    for (const agent of ALL_AGENTS) {
      expect(primaryAgents.has(agent)).toBe(true);
    }
  });

  it("all stages have at least a primary and validator", () => {
    for (const config of Object.values(STAGE_ORCHESTRATION_MAP)) {
      expect(config.primary_agent).toBeTruthy();
      expect(config.validator_agent).toBeTruthy();
    }
  });
});
