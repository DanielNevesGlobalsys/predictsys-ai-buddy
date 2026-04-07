/**
 * LIS AI OS — Agent Types & Metadata Tests
 */
import { describe, it, expect } from "vitest";
import {
  LIS_AGENT_NAMES,
  LIS_STAGES,
  LIS_AGENTS_META,
  type LisAgentName,
  type LisStage,
} from "@/types/lisAgents";

describe("LIS Agent Names", () => {
  it("has exactly 5 agents", () => {
    expect(LIS_AGENT_NAMES).toHaveLength(5);
  });

  it("includes all required agents", () => {
    expect(LIS_AGENT_NAMES).toContain("governance_agent");
    expect(LIS_AGENT_NAMES).toContain("data_scientist_agent");
    expect(LIS_AGENT_NAMES).toContain("data_engineer_agent");
    expect(LIS_AGENT_NAMES).toContain("ml_engineer_agent");
    expect(LIS_AGENT_NAMES).toContain("business_analyst_agent");
  });
});

describe("LIS Stages", () => {
  it("includes all pipeline stages", () => {
    const required: LisStage[] = [
      "ingestion", "eda", "targeting", "features",
      "builder", "training", "scoring", "dashboard",
      "governance", "general",
    ];
    for (const stage of required) {
      expect(LIS_STAGES).toContain(stage);
    }
  });
});

describe("LIS Agents Metadata", () => {
  it("has metadata for every agent", () => {
    expect(LIS_AGENTS_META).toHaveLength(5);
    for (const name of LIS_AGENT_NAMES) {
      const meta = LIS_AGENTS_META.find((m) => m.name === name);
      expect(meta).toBeDefined();
    }
  });

  it("each agent has label, description, icon, stages, and color", () => {
    for (const meta of LIS_AGENTS_META) {
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.icon).toBeTruthy();
      expect(meta.stages.length).toBeGreaterThan(0);
      expect(meta.color).toBeTruthy();
    }
  });

  it("governance agent covers governance and ingestion stages", () => {
    const gov = LIS_AGENTS_META.find((m) => m.name === "governance_agent")!;
    expect(gov.stages).toContain("governance");
    expect(gov.stages).toContain("ingestion");
  });

  it("business_analyst covers dashboard stage", () => {
    const ba = LIS_AGENTS_META.find((m) => m.name === "business_analyst_agent")!;
    expect(ba.stages).toContain("dashboard");
  });
});
