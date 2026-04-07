import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface GovernanceDecision {
  pipeline_status: "ready" | "warning" | "blocked";
  governance_conflict: boolean;
  conflict_type: string;
  conflict_summary: string[];
  consistency_checks: Array<{
    check: string;
    status: "pass" | "warn" | "block";
    reason: string;
  }>;
  leakage_assessment: {
    status: "clear" | "warning" | "blocked";
    blocking_columns: string[];
    warning_columns: string[];
    reasoning: string[];
  };
  readiness_assessment: {
    target_ready: boolean;
    entity_ready: boolean;
    time_ready: boolean;
    grain_ready: boolean;
    builder_ready: boolean;
    training_ready: boolean;
    scoring_ready: boolean;
    dashboard_ready: boolean;
  };
  official_state_summary: {
    official_target: string;
    official_problem_type: string;
    official_entity_key: string[];
    official_time_column: string;
    official_grain: string;
    official_split_strategy: string;
  };
  blocking_reasons: string[];
  warnings: string[];
  actions_required: Array<{
    action: string;
    target: string;
    priority: "critical" | "high" | "medium" | "low";
    auto_applicable: boolean;
  }>;
  compliance_notes: string[];
  confidence: number;
}

export interface GovernanceResult {
  execution_id: string;
  governance_decision: GovernanceDecision;
  audit_metadata: {
    input_hash: string;
    context_version: string;
    executed_at: string;
    model_used: string;
    duration_ms: number;
  };
}

export function useGovernanceAgent(projectId: string | undefined, organizationId: string | undefined) {
  const [result, setResult] = useState<GovernanceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runGovernanceCheck = useCallback(async (
    stage: string,
    executionMode: "auto" | "assisted" | "shadow" = "assisted",
  ) => {
    if (!projectId || !organizationId) return null;

    setLoading(true);
    setError(null);

    try {
      const { data, error: fnErr } = await supabase.functions.invoke("lis-orchestrator", {
        body: {
          project_id: projectId,
          organization_id: organizationId,
          stage,
          agent_name: "governance_agent",
          execution_mode: executionMode,
          input_contract: { trigger: "manual", stage },
        },
      });

      if (fnErr) throw new Error(fnErr.message || "Governance check failed");
      if (data?.error) throw new Error(data.error);

      const govResult: GovernanceResult = {
        execution_id: data.execution_id,
        governance_decision: data.governance_decision,
        audit_metadata: data.audit_metadata,
      };

      setResult(govResult);
      return govResult;
    } catch (err: any) {
      const msg = err?.message || "Erro ao executar verificação de governança";
      setError(msg);
      console.error("[useGovernanceAgent]", err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, organizationId]);

  const loadLatestDecision = useCallback(async (stage?: string) => {
    if (!projectId) return null;

    try {
      let query = supabase
        .from("lis_agent_executions")
        .select("*")
        .eq("project_id", projectId)
        .eq("agent_name", "governance_agent")
        .neq("status", "running")
        .order("created_at", { ascending: false })
        .limit(1);

      if (stage) query = query.eq("stage", stage);

      const { data } = await query.maybeSingle();

      if (data?.decision) {
        const govResult: GovernanceResult = {
          execution_id: data.id,
          governance_decision: data.decision as unknown as GovernanceDecision,
          audit_metadata: {
            input_hash: data.input_hash || "",
            context_version: data.context_version || "",
            executed_at: data.finished_at || data.created_at,
            model_used: data.model_used || "",
            duration_ms: data.duration_ms || 0,
          },
        };
        setResult(govResult);
        return govResult;
      }

      return null;
    } catch (err) {
      console.error("[useGovernanceAgent] loadLatest error:", err);
      return null;
    }
  }, [projectId]);

  return {
    result,
    decision: result?.governance_decision ?? null,
    loading,
    error,
    runGovernanceCheck,
    loadLatestDecision,
  };
}
