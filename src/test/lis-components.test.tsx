/**
 * LIS AI OS — Frontend Component Tests
 * Tests rendering of all LIS UI components with mock data.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LisAgentExecution } from "@/types/lisAgents";
import LisAgentPanel from "@/components/lis/LisAgentPanel";
import AgentDecisionSummaryCard from "@/components/lis/AgentDecisionSummaryCard";
import AgentBlockingBanner from "@/components/lis/AgentBlockingBanner";
import AgentAuditAccordion from "@/components/lis/AgentAuditAccordion";

// ─── Mock Data Factory ───

function mockExecution(overrides: Partial<LisAgentExecution> = {}): LisAgentExecution {
  return {
    id: "exec-001",
    project_id: "proj-001",
    organization_id: "org-001",
    agent_name: "governance_agent",
    stage: "training",
    execution_mode: "assisted",
    status: "success",
    confidence: 0.85,
    context_version: "v1_dv1",
    decision: { pipeline_status: "clear" },
    reasoning_summary: ["Pipeline coerente", "Sem conflitos"],
    warnings: [],
    blocking_issues: [],
    actions_recommended: [],
    model_used: "google/gemini-2.5-flash",
    duration_ms: 3200,
    triggered_by: "user-001",
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── LisAgentPanel ───

describe("LisAgentPanel", () => {
  it("renders loading state", () => {
    render(<LisAgentPanel executions={[]} loading={true} />);
    expect(screen.getByText(/Carregando/i)).toBeInTheDocument();
  });

  it("renders empty state", () => {
    render(<LisAgentPanel executions={[]} loading={false} />);
    expect(screen.getByText(/Nenhuma execução/i)).toBeInTheDocument();
  });

  it("renders executions with tabs", () => {
    const exec = mockExecution();
    render(<LisAgentPanel executions={[exec]} />);
    expect(screen.getByText("LIS AI OS")).toBeInTheDocument();
    expect(screen.getByText("Resumo")).toBeInTheDocument();
    expect(screen.getByText("Auditoria")).toBeInTheDocument();
  });

  it("shows stage info when currentStage is set", () => {
    render(
      <LisAgentPanel
        executions={[mockExecution({ stage: "training" })]}
        currentStage="training"
      />,
    );
    expect(screen.getByText(/Engenheiro de ML/i)).toBeInTheDocument();
  });

  it("shows analyze button when onRunStage provided", () => {
    const fn = vi.fn();
    render(
      <LisAgentPanel
        executions={[]}
        currentStage="eda"
        onRunStage={fn}
      />,
    );
    expect(screen.getByText("Analisar")).toBeInTheDocument();
  });
});

// ─── AgentDecisionSummaryCard ───

describe("AgentDecisionSummaryCard", () => {
  it("renders compact card with agent label", () => {
    const exec = mockExecution({ agent_name: "data_scientist_agent" });
    render(<AgentDecisionSummaryCard execution={exec} compact />);
    expect(screen.getByText("Cientista de Dados")).toBeInTheDocument();
  });

  it("renders confidence percentage", () => {
    render(<AgentDecisionSummaryCard execution={mockExecution({ confidence: 0.92 })} compact />);
    expect(screen.getByText("92%")).toBeInTheDocument();
  });

  it("renders full card with warnings", () => {
    const exec = mockExecution({
      warnings: ["Feature X tem alta nulidade"],
      status: "warning",
    });
    render(<AgentDecisionSummaryCard execution={exec} />);
    expect(screen.getByText(/alta nulidade/i)).toBeInTheDocument();
  });

  it("renders blocking issues in full card", () => {
    const exec = mockExecution({
      blocking_issues: ["Leakage detectado na feature target_lag"],
      status: "blocked",
    });
    render(<AgentDecisionSummaryCard execution={exec} />);
    expect(screen.getByText(/Leakage detectado/i)).toBeInTheDocument();
  });

  it("renders policy badge", () => {
    const exec = mockExecution({ stage: "training" });
    render(<AgentDecisionSummaryCard execution={exec} stage="training" />);
    expect(screen.getByText("Insight")).toBeInTheDocument();
  });
});

// ─── AgentBlockingBanner ───

describe("AgentBlockingBanner", () => {
  it("renders nothing when no blockers", () => {
    const { container } = render(
      <AgentBlockingBanner executions={[mockExecution()]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders banner for blocked execution", () => {
    const exec = mockExecution({
      status: "blocked",
      blocking_issues: ["Builder stale — reconstrua o dataset"],
    });
    render(<AgentBlockingBanner executions={[exec]} />);
    expect(screen.getByText(/Builder stale/i)).toBeInTheDocument();
  });

  it("shows agent name in banner", () => {
    const exec = mockExecution({
      agent_name: "governance_agent",
      status: "blocked",
      blocking_issues: ["Conflito de governança"],
    });
    render(<AgentBlockingBanner executions={[exec]} />);
    expect(screen.getAllByText(/Governança/i).length).toBeGreaterThanOrEqual(1);
  });

  it("filters by stage when provided", () => {
    const exec1 = mockExecution({ stage: "training", status: "blocked", blocking_issues: ["A"] });
    const exec2 = mockExecution({ id: "exec-002", stage: "scoring", status: "blocked", blocking_issues: ["B"] });
    render(<AgentBlockingBanner executions={[exec1, exec2]} stage="training" />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
  });
});

// ─── AgentAuditAccordion ───

describe("AgentAuditAccordion", () => {
  it("renders nothing when no executions", () => {
    const { container } = render(<AgentAuditAccordion executions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders title when provided", () => {
    render(
      <AgentAuditAccordion
        executions={[mockExecution()]}
        title="Histórico — training"
      />,
    );
    expect(screen.getByText("Histórico — training")).toBeInTheDocument();
  });

  it("renders agent label and stage badge", () => {
    render(<AgentAuditAccordion executions={[mockExecution()]} />);
    expect(screen.getByText("Governança")).toBeInTheDocument();
    expect(screen.getByText("training")).toBeInTheDocument();
  });

  it("shows execution mode badge", () => {
    render(<AgentAuditAccordion executions={[mockExecution()]} />);
    expect(screen.getByText("assisted")).toBeInTheDocument();
  });

  it("renders multiple executions", () => {
    const execs = [
      mockExecution({ id: "e1", agent_name: "governance_agent" }),
      mockExecution({ id: "e2", agent_name: "ml_engineer_agent" }),
      mockExecution({ id: "e3", agent_name: "data_engineer_agent" }),
    ];
    render(<AgentAuditAccordion executions={execs} />);
    expect(screen.getByText("Governança")).toBeInTheDocument();
    expect(screen.getByText("Engenheiro de ML")).toBeInTheDocument();
    expect(screen.getByText("Engenheiro de Dados")).toBeInTheDocument();
  });
});
