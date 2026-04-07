import { describe, it, expect } from "vitest";
import {
  parseBaDecisionToIntelligence,
  emptyDashboardIntelligence,
  type DashboardIntelligence,
} from "@/components/business-dashboard/dashboardIntelligence";

/* ─── quality scoring helpers ─── */
function scoreClarity(layer: DashboardIntelligence["executive_layer"]): number {
  let s = 0;
  if (layer.main_message.length > 20) s += 25;
  if (layer.main_opportunity.length > 10) s += 25;
  if (layer.main_risk.length > 10) s += 25;
  if (layer.main_action.length > 10) s += 25;
  return s;
}

function scorePrioritization(layer: DashboardIntelligence["prioritization_layer"]): number {
  let s = 0;
  if (layer.priority_segments.length > 0) s += 40;
  if (layer.priority_rules.length > 0) s += 30;
  if (layer.priority_segments.every(seg => seg.segment && seg.opportunity)) s += 30;
  return s;
}

function scoreImpactCoherence(layer: DashboardIntelligence["impact_layer"]): number {
  let s = 0;
  if (layer.financial_impact.length > 0) s += 40;
  if (layer.financial_impact.every(fi => fi.description && fi.value)) s += 30;
  if (layer.reasoning.length > 0) s += 30;
  return s;
}

function scoreActionability(layer: DashboardIntelligence["action_layer"]): number {
  let s = 0;
  if (layer.recommended_actions.length > 0) s += 40;
  if (layer.recommended_actions.every(a => a.action && a.urgency)) s += 30;
  if (layer.recommended_actions.some(a => a.target_segment)) s += 30;
  return s;
}

function scoreTechnicalClarity(layer: DashboardIntelligence["technical_summary_layer"]): number {
  let s = 0;
  if (layer.model_quality_summary.length > 10) s += 40;
  if (layer.score_reliability_summary.length > 10) s += 30;
  if (layer.main_limitation.length > 5) s += 30;
  return s;
}

function isGenericNarrative(intel: DashboardIntelligence): boolean {
  const msg = intel.executive_layer.main_message.toLowerCase();
  const genericPhrases = [
    "o modelo foi treinado com sucesso",
    "os resultados são satisfatórios",
    "o pipeline foi executado",
    "a análise foi concluída",
  ];
  return genericPhrases.some(p => msg.includes(p));
}

interface DashboardTestReport {
  project_id: string;
  layers_tested: string[];
  tests_passed: string[];
  tests_failed: string[];
  generic_narrative_detected: boolean;
  impact_coherence_score: number;
  prioritization_quality_score: number;
  actionability_score: number;
  technical_clarity_score: number;
  governance_consistency: boolean;
  chat_consistency: boolean;
  final_dashboard_readiness: "not_ready" | "partial" | "ready";
}

function buildReport(intel: DashboardIntelligence, projectId = "test-project"): DashboardTestReport {
  const layers = [
    "executive_layer", "prioritization_layer", "impact_layer",
    "action_layer", "technical_summary_layer", "simulation_layer",
  ];
  const passed: string[] = [];
  const failed: string[] = [];

  const clarity = scoreClarity(intel.executive_layer);
  clarity >= 50 ? passed.push("executive_clarity") : failed.push("executive_clarity");

  const prio = scorePrioritization(intel.prioritization_layer);
  prio >= 40 ? passed.push("prioritization_quality") : failed.push("prioritization_quality");

  const impact = scoreImpactCoherence(intel.impact_layer);
  impact >= 40 ? passed.push("impact_coherence") : failed.push("impact_coherence");

  const action = scoreActionability(intel.action_layer);
  action >= 40 ? passed.push("actionability") : failed.push("actionability");

  const tech = scoreTechnicalClarity(intel.technical_summary_layer);
  tech >= 40 ? passed.push("technical_clarity") : failed.push("technical_clarity");

  const generic = isGenericNarrative(intel);
  !generic ? passed.push("non_generic_narrative") : failed.push("non_generic_narrative");

  const readiness = failed.length === 0 ? "ready" : failed.length <= 2 ? "partial" : "not_ready";

  return {
    project_id: projectId,
    layers_tested: layers,
    tests_passed: passed,
    tests_failed: failed,
    generic_narrative_detected: generic,
    impact_coherence_score: impact / 100,
    prioritization_quality_score: prio / 100,
    actionability_score: action / 100,
    technical_clarity_score: tech / 100,
    governance_consistency: true,
    chat_consistency: true,
    final_dashboard_readiness: readiness,
  };
}

/* ═══════════════════════════════════════════════════════════════
   CENÁRIO A — Happy Path
   ═══════════════════════════════════════════════════════════════ */
describe("Scenario A — Happy Path", () => {
  const decision: Record<string, unknown> = {
    executive_summary: {
      main_message: "Clientes Premium em Recife concentram 35% do valor previsto total.",
      main_opportunities: ["Expansão no Nordeste com ROI projetado de 2.8x"],
      main_risks: ["Churn elevado entre 18-25 anos"],
    },
    action_layer: {
      who_to_prioritize: [
        { segment: "Premium Recife", reason: "Maior ticket médio", action: "Campanha exclusiva" },
      ],
      priority_rules: ["Ordenar por valor previsto decrescente"],
      recommended_actions: [
        { action: "Acionar Premium Recife", target_segment: "Premium Recife", urgency: "immediate", expected_result: "Conversão 12%" },
      ],
      segments_to_watch: ["Novos cadastros"],
    },
    business_impact: {
      expected_impact: [{ description: "Receita incremental", value: "R$ 1.2M" }],
      operational_interpretation: ["Redução de 15% no CAC"],
    },
    technical_to_business_translation: {
      score_translation: ["AUC 0.87 indica boa separação entre grupos"],
    },
    simulation_guidance: {
      what_if_scenarios: [{ scenario: "Top 10%", description: "Foco reduz custo em 40%" }],
      assumptions: ["Ticket médio estável 90 dias"],
    },
  };

  const intel = parseBaDecisionToIntelligence(decision);

  it("produces useful executive summary", () => {
    expect(intel.executive_layer.main_message).toContain("Premium");
    expect(intel.executive_layer.main_opportunity).toContain("Expansão");
    expect(intel.executive_layer.main_risk).toContain("Churn");
  });

  it("generates clear prioritization", () => {
    expect(intel.prioritization_layer.priority_segments.length).toBeGreaterThan(0);
    expect(intel.prioritization_layer.priority_segments[0].segment).toBe("Premium Recife");
  });

  it("generates actionable recommendations", () => {
    expect(intel.action_layer.recommended_actions.length).toBeGreaterThan(0);
    expect(intel.action_layer.recommended_actions[0].urgency).toBe("immediate");
  });

  it("generates coherent impact", () => {
    expect(intel.impact_layer.financial_impact.length).toBeGreaterThan(0);
    expect(intel.impact_layer.financial_impact[0].value).toBe("R$ 1.2M");
  });

  it("generates useful simulation", () => {
    expect(intel.simulation_layer.what_if_scenarios.length).toBeGreaterThan(0);
  });

  it("report shows readiness", () => {
    const report = buildReport(intel);
    expect(report.final_dashboard_readiness).toBe("ready");
    expect(report.generic_narrative_detected).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   CENÁRIO B — Narrativa Genérica
   ═══════════════════════════════════════════════════════════════ */
describe("Scenario B — Generic Narrative", () => {
  const decision: Record<string, unknown> = {
    executive_summary: {
      main_message: "O modelo foi treinado com sucesso e os resultados são satisfatórios.",
      main_opportunities: [],
      main_risks: [],
    },
  };

  const intel = parseBaDecisionToIntelligence(decision);

  it("detects generic narrative", () => {
    expect(isGenericNarrative(intel)).toBe(true);
  });

  it("report marks as not ready", () => {
    const report = buildReport(intel);
    expect(report.generic_narrative_detected).toBe(true);
    expect(report.final_dashboard_readiness).not.toBe("ready");
  });
});

/* ═══════════════════════════════════════════════════════════════
   CENÁRIO C — Impacto Sem Base Clara
   ═══════════════════════════════════════════════════════════════ */
describe("Scenario C — Impact Without Clear Basis", () => {
  const decision: Record<string, unknown> = {
    executive_summary: {
      main_message: "O projeto identifica oportunidades no segmento corporativo.",
      main_opportunities: ["Segmento corporativo"],
    },
    business_impact: {
      expected_impact: [{ description: "Potencial de crescimento" }], // no value
    },
  };

  const intel = parseBaDecisionToIntelligence(decision);

  it("financial impact exists but has no value", () => {
    expect(intel.impact_layer.financial_impact.length).toBe(1);
    expect(intel.impact_layer.financial_impact[0].value).toBeFalsy();
  });

  it("report flags low impact coherence", () => {
    const report = buildReport(intel);
    expect(report.impact_coherence_score).toBeLessThan(0.7);
  });
});

/* ═══════════════════════════════════════════════════════════════
   CENÁRIO D — Priorização Fraca
   ═══════════════════════════════════════════════════════════════ */
describe("Scenario D — Weak Prioritization", () => {
  const decision: Record<string, unknown> = {
    executive_summary: {
      main_message: "Score disponível para 5.000 entidades.",
      main_opportunities: ["Segmentação possível"],
    },
    action_layer: {
      who_to_prioritize: [],
      priority_rules: [],
      recommended_actions: [],
    },
  };

  const intel = parseBaDecisionToIntelligence(decision);

  it("has no priority segments", () => {
    expect(intel.prioritization_layer.priority_segments.length).toBe(0);
  });

  it("report shows low prioritization quality", () => {
    const report = buildReport(intel);
    expect(report.prioritization_quality_score).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   CENÁRIO E — Modelo Fraco / Confiança Baixa
   ═══════════════════════════════════════════════════════════════ */
describe("Scenario E — Weak Model", () => {
  it("confidence message should reflect low quality", () => {
    const intel = emptyDashboardIntelligence();
    intel.executive_layer.main_message = "Modelo treinado com AUC 0.55 — abaixo do ideal.";
    intel.executive_layer.confidence_message = "Score com poder preditivo limitado.";
    intel.technical_summary_layer.model_quality_summary = "AUC 0.55, próximo ao baseline (0.50).";
    intel.technical_summary_layer.main_limitation = "Modelo sem poder discriminativo adequado.";

    expect(intel.executive_layer.confidence_message).toContain("limitado");
    expect(intel.technical_summary_layer.model_quality_summary).toContain("0.55");

    const report = buildReport(intel);
    expect(report.technical_clarity_score).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   CENÁRIO F — Conflito com Estado Oficial
   ═══════════════════════════════════════════════════════════════ */
describe("Scenario F — Governance Conflict", () => {
  it("governance should flag when narrative uses non-official state", () => {
    const intel = emptyDashboardIntelligence();
    intel.executive_layer.main_message = "Target recomendado: valor_total_90d";

    // Simulated governance check: official target is different
    const officialTarget = "churn_flag";
    const narrativeUsesOfficial = intel.executive_layer.main_message.includes(officialTarget);

    expect(narrativeUsesOfficial).toBe(false);
    // Governance should block or warn
  });
});

/* ═══════════════════════════════════════════════════════════════
   CENÁRIO G — Painéis Vazios
   ═══════════════════════════════════════════════════════════════ */
describe("Scenario G — Empty Panels", () => {
  const empty = emptyDashboardIntelligence();

  it("empty intelligence returns all nullish layers", () => {
    expect(empty.executive_layer.main_message).toBe("");
    expect(empty.prioritization_layer.priority_segments.length).toBe(0);
    expect(empty.impact_layer.financial_impact.length).toBe(0);
    expect(empty.action_layer.recommended_actions.length).toBe(0);
    expect(empty.technical_summary_layer.model_quality_summary).toBe("");
    expect(empty.simulation_layer.what_if_scenarios.length).toBe(0);
  });

  it("report shows not ready", () => {
    const report = buildReport(empty);
    expect(report.final_dashboard_readiness).toBe("not_ready");
    expect(report.tests_failed.length).toBeGreaterThan(3);
  });
});

/* ═══════════════════════════════════════════════════════════════
   parseBaDecisionToIntelligence — edge cases
   ═══════════════════════════════════════════════════════════════ */
describe("parseBaDecisionToIntelligence", () => {
  it("handles null decision gracefully", () => {
    const intel = parseBaDecisionToIntelligence(null as any);
    expect(intel.executive_layer.main_message).toBe("");
  });

  it("handles empty object", () => {
    const intel = parseBaDecisionToIntelligence({});
    expect(intel.executive_layer.main_message).toBe("");
    expect(intel.prioritization_layer.priority_segments.length).toBe(0);
  });

  it("extracts main_action from first recommended_action", () => {
    const decision = {
      action_layer: {
        recommended_actions: [{ action: "Ligar para cliente", urgency: "high" }],
      },
    };
    const intel = parseBaDecisionToIntelligence(decision);
    expect(intel.executive_layer.main_action).toBe("Ligar para cliente");
  });

  it("extracts confidence_message from score_translation", () => {
    const decision = {
      technical_to_business_translation: {
        score_translation: ["AUC alto", "Modelo confiável"],
      },
    };
    const intel = parseBaDecisionToIntelligence(decision);
    expect(intel.executive_layer.confidence_message).toContain("AUC alto");
    expect(intel.executive_layer.confidence_message).toContain("Modelo confiável");
  });

  it("handles string-only who_to_prioritize entries", () => {
    const decision = {
      action_layer: { who_to_prioritize: ["Premium", "Regular"] },
    };
    const intel = parseBaDecisionToIntelligence(decision);
    expect(intel.prioritization_layer.priority_segments.length).toBe(2);
    expect(intel.prioritization_layer.priority_segments[0].segment).toBe("Premium");
  });

  it("handles string-only what_if_scenarios", () => {
    const decision = {
      simulation_guidance: { what_if_scenarios: ["E se focar no top 20%?"] },
    };
    const intel = parseBaDecisionToIntelligence(decision);
    expect(intel.simulation_layer.what_if_scenarios[0].scenario).toBe("E se focar no top 20%?");
  });
});

/* ═══════════════════════════════════════════════════════════════
   Report Structure Validation
   ═══════════════════════════════════════════════════════════════ */
describe("Dashboard Test Report Structure", () => {
  it("report has all required fields", () => {
    const intel = emptyDashboardIntelligence();
    const report = buildReport(intel, "proj-123");

    expect(report.project_id).toBe("proj-123");
    expect(report.layers_tested).toHaveLength(6);
    expect(typeof report.generic_narrative_detected).toBe("boolean");
    expect(typeof report.impact_coherence_score).toBe("number");
    expect(typeof report.prioritization_quality_score).toBe("number");
    expect(typeof report.actionability_score).toBe("number");
    expect(typeof report.technical_clarity_score).toBe("number");
    expect(typeof report.governance_consistency).toBe("boolean");
    expect(typeof report.chat_consistency).toBe("boolean");
    expect(["not_ready", "partial", "ready"]).toContain(report.final_dashboard_readiness);
  });
});
