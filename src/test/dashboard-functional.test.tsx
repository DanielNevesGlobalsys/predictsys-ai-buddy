import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ExecutiveSummaryPanel from "@/components/dashboard/ExecutiveSummaryPanel";
import PrioritizationPanel from "@/components/dashboard/PrioritizationPanel";
import ImpactPanel from "@/components/dashboard/ImpactPanel";
import ActionRecommendationPanel from "@/components/dashboard/ActionRecommendationPanel";
import ModelConfidencePanel from "@/components/dashboard/ModelConfidencePanel";
import ScenarioSimulationPanel from "@/components/dashboard/ScenarioSimulationPanel";
import {
  emptyDashboardIntelligence,
  parseBaDecisionToIntelligence,
  type DashboardIntelligence,
} from "@/components/business-dashboard/dashboardIntelligence";

/* ─── helpers ─── */
function fullIntelligence(): DashboardIntelligence {
  return {
    executive_layer: {
      main_message: "Clientes Premium em Recife concentram a maior oportunidade de crescimento.",
      main_opportunity: "Crescimento de 18% no segmento Premium.",
      main_risk: "Churn elevado na faixa 18-25 anos.",
      main_action: "Priorizar retenção no segmento jovem.",
      confidence_message: "Modelo com AUC 0.87 — confiança operacional alta.",
    },
    prioritization_layer: {
      priority_entities: [{ entity_id: "C001", score: 0.92, reason: "Alto valor previsto" }],
      priority_segments: [
        { segment: "Premium Recife", count: 340, opportunity: "Maior ticket médio", action: "Campanha exclusiva" },
        { segment: "Regular SP", count: 1200, opportunity: "Volume", action: "Cross-sell" },
      ],
      priority_rules: ["Priorizar por valor previsto decrescente", "Focar em cobertura acima de 80%"],
      reasoning: ["Score ordena por probabilidade de evento"],
    },
    impact_layer: {
      financial_impact: [
        { description: "Receita incremental projetada", value: "R$ 1.2M", segment: "Premium" },
      ],
      operational_impact: ["Redução de 15% no custo de aquisição"],
      expected_return: [{ scenario: "Top 20%", estimate: "ROI 3.2x em 90 dias" }],
      reasoning: ["Baseado em ticket médio e probabilidade de conversão"],
    },
    action_layer: {
      recommended_actions: [
        { action: "Acionar campanha Premium", target_segment: "Premium Recife", urgency: "immediate", expected_result: "Conversão de 12%" },
        { action: "Revisar carteira Regular", target_segment: "Regular SP", urgency: "medium", expected_result: "Redução de churn 5%" },
      ],
      action_sequences: ["1. Campanha Premium → 2. Revisão Regular"],
      segments_to_watch: ["Novos cadastros", "Inativos 60d+"],
    },
    technical_summary_layer: {
      model_quality_summary: "AUC 0.87, acima do baseline de 0.72.",
      score_reliability_summary: "Score estável entre treino e validação.",
      main_limitation: "Baixa representatividade da faixa 60+ anos.",
    },
    dashboard_design_layer: {
      keep_blocks: ["score_distribution"], remove_blocks: ["raw_metrics"],
      new_blocks: ["executive_summary", "priority_ranking"],
      chart_recommendations: ["Substituir histograma por ranking"],
      reasoning: ["Foco em ação, não em métrica crua"],
    },
    simulation_layer: {
      what_if_scenarios: [
        { scenario: "Priorizar top 10%", description: "Foco em alta probabilidade reduz custo operacional em 40%." },
      ],
      controls_recommended: ["Testar A/B antes de escalar"],
      assumptions: ["Ticket médio estável nos próximos 90 dias"],
    },
  };
}

/* ═══════════════════════════════════════════════════════════════
   CAMADA 1 — Executive Summary
   ═══════════════════════════════════════════════════════════════ */
describe("ExecutiveSummaryPanel", () => {
  it("renders main message when present", () => {
    const intel = fullIntelligence();
    render(<ExecutiveSummaryPanel layer={intel.executive_layer} />);
    expect(screen.getByText(/Clientes Premium em Recife/)).toBeInTheDocument();
  });

  it("renders opportunity, risk, and action items", () => {
    const intel = fullIntelligence();
    render(<ExecutiveSummaryPanel layer={intel.executive_layer} />);
    expect(screen.getByText(/Crescimento de 18%/)).toBeInTheDocument();
    expect(screen.getByText(/Churn elevado/)).toBeInTheDocument();
    expect(screen.getByText(/retenção no segmento jovem/)).toBeInTheDocument();
  });

  it("renders confidence message", () => {
    const intel = fullIntelligence();
    render(<ExecutiveSummaryPanel layer={intel.executive_layer} />);
    expect(screen.getByText(/AUC 0.87/)).toBeInTheDocument();
  });

  it("returns null when main_message is empty", () => {
    const empty = emptyDashboardIntelligence();
    const { container } = render(<ExecutiveSummaryPanel layer={empty.executive_layer} />);
    expect(container.firstChild).toBeNull();
  });

  it("handles partial data — only message, no items", () => {
    const layer = { ...emptyDashboardIntelligence().executive_layer, main_message: "Resumo parcial" };
    render(<ExecutiveSummaryPanel layer={layer} />);
    expect(screen.getByText("Resumo parcial")).toBeInTheDocument();
    expect(screen.queryByText("Oportunidade")).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════
   CAMADA 2 — Prioritization
   ═══════════════════════════════════════════════════════════════ */
describe("PrioritizationPanel", () => {
  it("renders segment ranking with numbered badges", () => {
    const intel = fullIntelligence();
    render(<PrioritizationPanel layer={intel.prioritization_layer} />);
    expect(screen.getByText("Premium Recife")).toBeInTheDocument();
    expect(screen.getByText("Regular SP")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders priority rules", () => {
    const intel = fullIntelligence();
    render(<PrioritizationPanel layer={intel.prioritization_layer} />);
    expect(screen.getByText(/valor previsto decrescente/)).toBeInTheDocument();
  });

  it("renders action badges for segments", () => {
    const intel = fullIntelligence();
    render(<PrioritizationPanel layer={intel.prioritization_layer} />);
    expect(screen.getByText("Campanha exclusiva")).toBeInTheDocument();
    expect(screen.getByText("Cross-sell")).toBeInTheDocument();
  });

  it("returns null when no segments and no rules", () => {
    const empty = emptyDashboardIntelligence();
    const { container } = render(<PrioritizationPanel layer={empty.prioritization_layer} />);
    expect(container.firstChild).toBeNull();
  });

  it("limits display to 5 segments", () => {
    const layer = emptyDashboardIntelligence().prioritization_layer;
    layer.priority_segments = Array.from({ length: 8 }, (_, i) => ({
      segment: `Seg ${i}`, count: i * 10, opportunity: "", action: "",
    }));
    render(<PrioritizationPanel layer={layer} />);
    expect(screen.getByText("Seg 0")).toBeInTheDocument();
    expect(screen.getByText("Seg 4")).toBeInTheDocument();
    expect(screen.queryByText("Seg 5")).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════
   CAMADA 3 — Impact
   ═══════════════════════════════════════════════════════════════ */
describe("ImpactPanel", () => {
  it("renders financial impact with value", () => {
    const intel = fullIntelligence();
    render(<ImpactPanel layer={intel.impact_layer} />);
    expect(screen.getByText("Receita incremental projetada")).toBeInTheDocument();
    expect(screen.getByText("R$ 1.2M")).toBeInTheDocument();
  });

  it("renders operational impact", () => {
    const intel = fullIntelligence();
    render(<ImpactPanel layer={intel.impact_layer} />);
    expect(screen.getByText(/Redução de 15%/)).toBeInTheDocument();
  });

  it("renders expected return scenarios", () => {
    const intel = fullIntelligence();
    render(<ImpactPanel layer={intel.impact_layer} />);
    expect(screen.getByText(/ROI 3.2x/)).toBeInTheDocument();
  });

  it("returns null when all arrays empty", () => {
    const empty = emptyDashboardIntelligence();
    const { container } = render(<ImpactPanel layer={empty.impact_layer} />);
    expect(container.firstChild).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════
   CAMADA 4 — Action Recommendation
   ═══════════════════════════════════════════════════════════════ */
describe("ActionRecommendationPanel", () => {
  it("renders actions with urgency badges", () => {
    const intel = fullIntelligence();
    render(<ActionRecommendationPanel layer={intel.action_layer} />);
    expect(screen.getByText("Acionar campanha Premium")).toBeInTheDocument();
    expect(screen.getByText("immediate")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
  });

  it("renders target segment for each action", () => {
    const intel = fullIntelligence();
    render(<ActionRecommendationPanel layer={intel.action_layer} />);
    expect(screen.getByText("Premium Recife")).toBeInTheDocument();
    expect(screen.getByText("Regular SP")).toBeInTheDocument();
  });

  it("renders expected result", () => {
    const intel = fullIntelligence();
    render(<ActionRecommendationPanel layer={intel.action_layer} />);
    expect(screen.getByText(/Conversão de 12%/)).toBeInTheDocument();
  });

  it("renders segments to watch", () => {
    const intel = fullIntelligence();
    render(<ActionRecommendationPanel layer={intel.action_layer} />);
    expect(screen.getByText("Novos cadastros")).toBeInTheDocument();
    expect(screen.getByText("Inativos 60d+")).toBeInTheDocument();
  });

  it("returns null when no actions", () => {
    const empty = emptyDashboardIntelligence();
    const { container } = render(<ActionRecommendationPanel layer={empty.action_layer} />);
    expect(container.firstChild).toBeNull();
  });

  it("limits display to 6 actions", () => {
    const layer = emptyDashboardIntelligence().action_layer;
    layer.recommended_actions = Array.from({ length: 10 }, (_, i) => ({
      action: `Ação ${i}`, target_segment: "", urgency: "normal", expected_result: "",
    }));
    render(<ActionRecommendationPanel layer={layer} />);
    expect(screen.getByText("Ação 0")).toBeInTheDocument();
    expect(screen.getByText("Ação 5")).toBeInTheDocument();
    expect(screen.queryByText("Ação 6")).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════
   CAMADA 5 — Model Confidence
   ═══════════════════════════════════════════════════════════════ */
describe("ModelConfidencePanel", () => {
  it("renders quality and reliability summaries", () => {
    const intel = fullIntelligence();
    render(<ModelConfidencePanel layer={intel.technical_summary_layer} />);
    expect(screen.getByText(/AUC 0.87, acima do baseline/)).toBeInTheDocument();
    expect(screen.getByText(/Score estável/)).toBeInTheDocument();
  });

  it("renders main limitation", () => {
    const intel = fullIntelligence();
    render(<ModelConfidencePanel layer={intel.technical_summary_layer} />);
    expect(screen.getByText(/Baixa representatividade/)).toBeInTheDocument();
  });

  it("returns null when all summaries empty", () => {
    const empty = emptyDashboardIntelligence();
    const { container } = render(<ModelConfidencePanel layer={empty.technical_summary_layer} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders without limitation when only quality present", () => {
    const layer = {
      model_quality_summary: "Modelo adequado",
      score_reliability_summary: "",
      main_limitation: "",
    };
    render(<ModelConfidencePanel layer={layer} />);
    expect(screen.getByText("Modelo adequado")).toBeInTheDocument();
    expect(screen.queryByText(/Limitação/)).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════
   CAMADA 6 — Scenario Simulation
   ═══════════════════════════════════════════════════════════════ */
describe("ScenarioSimulationPanel", () => {
  it("renders what-if scenarios", () => {
    const intel = fullIntelligence();
    render(<ScenarioSimulationPanel layer={intel.simulation_layer} />);
    expect(screen.getByText("Priorizar top 10%")).toBeInTheDocument();
    expect(screen.getByText(/reduz custo operacional em 40%/)).toBeInTheDocument();
  });

  it("renders assumptions", () => {
    const intel = fullIntelligence();
    render(<ScenarioSimulationPanel layer={intel.simulation_layer} />);
    expect(screen.getByText(/Ticket médio estável/)).toBeInTheDocument();
  });

  it("returns null when no scenarios and no controls", () => {
    const empty = emptyDashboardIntelligence();
    const { container } = render(<ScenarioSimulationPanel layer={empty.simulation_layer} />);
    expect(container.firstChild).toBeNull();
  });
});
