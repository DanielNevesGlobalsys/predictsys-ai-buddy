/**
 * Dashboard Intelligence — types and contract
 */

export interface DashboardIntelligence {
  executive_layer: {
    main_message: string;
    main_opportunity: string;
    main_risk: string;
    main_action: string;
    confidence_message: string;
  };
  prioritization_layer: {
    priority_entities: Array<{ entity_id: string; score: number; reason: string }>;
    priority_segments: Array<{ segment: string; count: number; opportunity: string; action: string }>;
    priority_rules: string[];
    reasoning: string[];
  };
  impact_layer: {
    financial_impact: Array<{ description: string; value: string; segment?: string }>;
    operational_impact: string[];
    expected_return: Array<{ scenario: string; estimate: string }>;
    reasoning: string[];
  };
  action_layer: {
    recommended_actions: Array<{ action: string; target_segment: string; urgency: string; expected_result: string }>;
    action_sequences: string[];
    segments_to_watch: string[];
  };
  technical_summary_layer: {
    model_quality_summary: string;
    score_reliability_summary: string;
    main_limitation: string;
  };
  dashboard_design_layer: {
    keep_blocks: string[];
    remove_blocks: string[];
    new_blocks: string[];
    chart_recommendations: string[];
    reasoning: string[];
  };
  simulation_layer: {
    what_if_scenarios: Array<{ scenario: string; description: string }>;
    controls_recommended: string[];
    assumptions: string[];
  };
}

export function emptyDashboardIntelligence(): DashboardIntelligence {
  return {
    executive_layer: { main_message: "", main_opportunity: "", main_risk: "", main_action: "", confidence_message: "" },
    prioritization_layer: { priority_entities: [], priority_segments: [], priority_rules: [], reasoning: [] },
    impact_layer: { financial_impact: [], operational_impact: [], expected_return: [], reasoning: [] },
    action_layer: { recommended_actions: [], action_sequences: [], segments_to_watch: [] },
    technical_summary_layer: { model_quality_summary: "", score_reliability_summary: "", main_limitation: "" },
    dashboard_design_layer: { keep_blocks: [], remove_blocks: [], new_blocks: [], chart_recommendations: [], reasoning: [] },
    simulation_layer: { what_if_scenarios: [], controls_recommended: [], assumptions: [] },
  };
}

/** Extract DashboardIntelligence from BA agent decision */
export function parseBaDecisionToIntelligence(decision: Record<string, unknown>): DashboardIntelligence {
  const base = emptyDashboardIntelligence();
  if (!decision) return base;

  const exec = decision.executive_summary as any;
  if (exec) {
    base.executive_layer.main_message = exec.main_message || "";
    base.executive_layer.main_opportunity = (exec.main_opportunities as string[])?.[0] || "";
    base.executive_layer.main_risk = (exec.main_risks as string[])?.[0] || "";
    base.executive_layer.main_action = "";
    base.executive_layer.confidence_message = "";
  }

  const action = decision.action_layer as any;
  if (action) {
    base.prioritization_layer.priority_segments = (action.who_to_prioritize || []).map((w: any) => ({
      segment: w.segment || w, count: 0, opportunity: w.reason || "", action: w.action || "",
    }));
    base.prioritization_layer.priority_rules = action.priority_rules || [];
    base.action_layer.recommended_actions = (action.recommended_actions || []).map((a: any) => ({
      action: a.action || a, target_segment: a.target_segment || "", urgency: a.urgency || "normal", expected_result: a.expected_result || "",
    }));
    base.action_layer.segments_to_watch = action.segments_to_watch || [];
    if (base.action_layer.recommended_actions.length > 0) {
      base.executive_layer.main_action = base.action_layer.recommended_actions[0].action;
    }
  }

  const impact = decision.business_impact as any;
  if (impact) {
    base.impact_layer.financial_impact = (impact.expected_impact || impact.financial_interpretation || []).map((i: any) => ({
      description: typeof i === "string" ? i : i.description || "", value: i.value || "", segment: i.segment,
    }));
    base.impact_layer.operational_impact = impact.operational_interpretation || [];
  }

  const dash = decision.dashboard_blocks as any;
  if (dash) {
    base.dashboard_design_layer.keep_blocks = dash.keep_blocks || [];
    base.dashboard_design_layer.remove_blocks = dash.remove_blocks || [];
    base.dashboard_design_layer.new_blocks = dash.new_blocks || [];
    base.dashboard_design_layer.reasoning = dash.reasoning || [];
  }

  const sim = decision.simulation_guidance as any;
  if (sim) {
    base.simulation_layer.what_if_scenarios = (sim.what_if_scenarios || []).map((s: any) => ({
      scenario: typeof s === "string" ? s : s.scenario || "", description: s.description || "",
    }));
    base.simulation_layer.controls_recommended = sim.recommended_controls || [];
    base.simulation_layer.assumptions = sim.assumptions || [];
  }

  const tech = decision.technical_to_business_translation as any;
  if (tech) {
    base.executive_layer.confidence_message = (tech.score_translation || []).join(". ");
  }

  return base;
}
