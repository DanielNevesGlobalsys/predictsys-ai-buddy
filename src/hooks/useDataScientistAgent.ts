import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface DSDecision {
  problem_formulation: {
    objective_family: string;
    problem_type: string;
    business_mode: string;
    target_strategy: string;
    prediction_unit: string;
    decision_unit: string;
  };
  target_recommendation: {
    recommended_target: string;
    target_kind: string;
    target_reasoning: string[];
    target_alternatives: Array<{ column: string; problem_type: string; reasoning: string }>;
    target_confidence: number;
  };
  entity_time_grain_recommendation: {
    recommended_entity_key: string[];
    recommended_time_column: string;
    recommended_grain: string;
    recommended_split_strategy: string;
    reasoning: string[];
    confidence: number;
  };
  feature_reasoning: {
    recommended_features: string[];
    blocked_features: string[];
    warning_features: string[];
    leakage_risk_features: string[];
    low_value_features: string[];
    reasoning: string[];
  };
  modeling_risk_assessment: {
    target_risks: string[];
    grain_risks: string[];
    split_risks: string[];
    data_risks: string[];
    general_risks: string[];
  };
  alternatives: {
    alternative_targets: Array<{ column: string; problem_type: string; reasoning: string }>;
    alternative_grains: string[];
    alternative_splits: string[];
    alternative_problem_types: string[];
  };
  actions_recommended: Array<{
    action: string;
    target: string;
    priority: string;
    auto_applicable: boolean;
  }>;
  confidence: number;
}

interface DSAgentResult {
  execution_id: string;
  agent_name: string;
  stage: string;
  execution_mode: string;
  ds_decision: DSDecision;
  audit_metadata: {
    input_hash: string;
    context_version: string;
    executed_at: string;
    model_used: string;
    duration_ms: number;
  };
}

interface UseDataScientistAgentOptions {
  projectId: string;
  organizationId: string;
}

export function useDataScientistAgent({ projectId, organizationId }: UseDataScientistAgentOptions) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DSAgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(
    async (
      stage: string = "targeting",
      inputContract: Record<string, unknown> = {},
      executionMode: string = "auto",
    ): Promise<DSAgentResult | null> => {
      if (!projectId || !organizationId) return null;

      setLoading(true);
      setError(null);

      try {
        const { data, error: fnError } = await supabase.functions.invoke(
          "lis-orchestrator",
          {
            body: {
              project_id: projectId,
              organization_id: organizationId,
              stage,
              agent_name: "data_scientist_agent",
              input_contract: inputContract,
              execution_mode: executionMode,
            },
          },
        );

        if (fnError) {
          setError(fnError.message);
          return null;
        }

        if (data?.error) {
          setError(data.error);
          return null;
        }

        setResult(data as DSAgentResult);
        return data as DSAgentResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [projectId, organizationId],
  );

  const fetchLatest = useCallback(async (): Promise<DSAgentResult | null> => {
    try {
      const { data } = await supabase
        .from("lis_agent_executions" as any)
        .select("*")
        .eq("project_id", projectId)
        .eq("agent_name", "data_scientist_agent")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data?.decision) {
        const mapped: DSAgentResult = {
          execution_id: data.id,
          agent_name: "data_scientist_agent",
          stage: data.stage,
          execution_mode: data.execution_mode,
          ds_decision: data.decision as unknown as DSDecision,
          audit_metadata: {
            input_hash: data.input_hash || "",
            context_version: data.context_version || "",
            executed_at: data.created_at,
            model_used: data.model_used || "",
            duration_ms: data.duration_ms || 0,
          },
        };
        setResult(mapped);
        return mapped;
      }
      return null;
    } catch {
      return null;
    }
  }, [projectId]);

  return { analyze, fetchLatest, loading, result, error };
}
