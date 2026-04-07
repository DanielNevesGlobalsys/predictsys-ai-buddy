import { describe, it, expect } from "vitest";
import {
  parseBaDecisionToIntelligence,
  type DashboardIntelligence,
} from "@/components/business-dashboard/dashboardIntelligence";

/**
 * Simulates chat answering questions using persisted intelligence.
 * The chat should answer from agent data, not generically.
 */
function answerFromIntelligence(
  question: string,
  intel: DashboardIntelligence,
): { answered: boolean; source: string; answer: string } {
  const q = question.toLowerCase();

  if (q.includes("prioriz") || q.includes("quem") || q.includes("primeiro")) {
    if (intel.prioritization_layer.priority_segments.length > 0) {
      const top = intel.prioritization_layer.priority_segments[0];
      return {
        answered: true,
        source: "business_analyst_agent.prioritization_layer",
        answer: `O segmento "${top.segment}" é prioridade porque: ${top.opportunity}. Ação sugerida: ${top.action}.`,
      };
    }
  }

  if (q.includes("oportunidade") || q.includes("principal")) {
    if (intel.executive_layer.main_opportunity) {
      return {
        answered: true,
        source: "business_analyst_agent.executive_layer",
        answer: intel.executive_layer.main_opportunity,
      };
    }
  }

  if (q.includes("ação") || q.includes("recomen") || q.includes("fazer")) {
    if (intel.action_layer.recommended_actions.length > 0) {
      const top = intel.action_layer.recommended_actions[0];
      return {
        answered: true,
        source: "business_analyst_agent.action_layer",
        answer: `Ação recomendada: ${top.action} (${top.urgency}) para ${top.target_segment}. Resultado esperado: ${top.expected_result}.`,
      };
    }
  }

  if (q.includes("impacto") || q.includes("quanto")) {
    if (intel.impact_layer.financial_impact.length > 0) {
      const fi = intel.impact_layer.financial_impact[0];
      return {
        answered: true,
        source: "business_analyst_agent.impact_layer",
        answer: `${fi.description}: ${fi.value}`,
      };
    }
  }

  if (q.includes("confiável") || q.includes("modelo") || q.includes("qualidade")) {
    if (intel.technical_summary_layer.model_quality_summary) {
      return {
        answered: true,
        source: "ml_engineer_agent.technical_summary_layer",
        answer: `${intel.technical_summary_layer.model_quality_summary}. ${intel.technical_summary_layer.main_limitation || ""}`.trim(),
      };
    }
  }

  if (q.includes("risco") || q.includes("cuidado")) {
    if (intel.executive_layer.main_risk) {
      return {
        answered: true,
        source: "business_analyst_agent.executive_layer",
        answer: intel.executive_layer.main_risk,
      };
    }
  }

  return { answered: false, source: "", answer: "" };
}

/* ═══════════════════════════════════════════════════════════════ */

const FULL_DECISION: Record<string, unknown> = {
  executive_summary: {
    main_message: "Clientes Premium em Recife concentram 35% do valor previsto.",
    main_opportunities: ["Expansão Nordeste com ROI 2.8x"],
    main_risks: ["Churn elevado 18-25 anos"],
  },
  action_layer: {
    who_to_prioritize: [
      { segment: "Premium Recife", reason: "Maior ticket", action: "Campanha exclusiva" },
    ],
    priority_rules: ["Valor previsto decrescente"],
    recommended_actions: [
      { action: "Acionar Premium Recife", target_segment: "Premium Recife", urgency: "immediate", expected_result: "Conversão 12%" },
    ],
    segments_to_watch: ["Novos cadastros"],
  },
  business_impact: {
    expected_impact: [{ description: "Receita incremental", value: "R$ 1.2M" }],
  },
  technical_to_business_translation: {
    score_translation: ["AUC 0.87 indica boa separação"],
  },
};

const intel = parseBaDecisionToIntelligence(FULL_DECISION);

// Inject technical layer from ML Engineer
intel.technical_summary_layer = {
  model_quality_summary: "AUC 0.87, acima do baseline.",
  score_reliability_summary: "Score estável.",
  main_limitation: "Faixa 60+ sub-representada.",
};

describe("Chat Consistency — Dashboard Intelligence", () => {
  const questions = [
    { q: "Por que esse segmento foi priorizado?", expectSource: "prioritization" },
    { q: "Qual é a principal oportunidade do projeto?", expectSource: "executive" },
    { q: "Qual ação é recomendada primeiro?", expectSource: "action" },
    { q: "Quanto impacto isso pode gerar?", expectSource: "impact" },
    { q: "Esse modelo é confiável?", expectSource: "technical" },
    { q: "Por que o dashboard mostra esse risco?", expectSource: "executive" },
  ];

  for (const { q, expectSource } of questions) {
    it(`answers "${q}" from persisted intelligence`, () => {
      const result = answerFromIntelligence(q, intel);
      expect(result.answered).toBe(true);
      expect(result.source).toBeTruthy();
      expect(result.answer.length).toBeGreaterThan(10);
      expect(result.source.toLowerCase()).toContain(expectSource);
    });
  }

  it("does not answer unknown questions from intelligence", () => {
    const result = answerFromIntelligence("Qual o tempo médio de entrega?", intel);
    expect(result.answered).toBe(false);
  });

  it("fails gracefully with empty intelligence", () => {
    const empty: DashboardIntelligence = {
      executive_layer: { main_message: "", main_opportunity: "", main_risk: "", main_action: "", confidence_message: "" },
      prioritization_layer: { priority_entities: [], priority_segments: [], priority_rules: [], reasoning: [] },
      impact_layer: { financial_impact: [], operational_impact: [], expected_return: [], reasoning: [] },
      action_layer: { recommended_actions: [], action_sequences: [], segments_to_watch: [] },
      technical_summary_layer: { model_quality_summary: "", score_reliability_summary: "", main_limitation: "" },
      dashboard_design_layer: { keep_blocks: [], remove_blocks: [], new_blocks: [], chart_recommendations: [], reasoning: [] },
      simulation_layer: { what_if_scenarios: [], controls_recommended: [], assumptions: [] },
    };
    const result = answerFromIntelligence("Qual a principal oportunidade?", empty);
    expect(result.answered).toBe(false);
  });
});
