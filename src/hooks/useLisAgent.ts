import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { LisAgentName, LisStage, LisExecutionMode, LisAgentResponse, LisAgentExecution } from "@/types/lisAgents";

interface UseLisAgentOptions {
  projectId: string;
  organizationId: string;
}

export function useLisAgent({ projectId, organizationId }: UseLisAgentOptions) {
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<LisAgentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invoke = useCallback(
    async (
      stage: LisStage,
      inputContract: Record<string, unknown> = {},
      options?: {
        agentName?: LisAgentName;
        executionMode?: LisExecutionMode;
      }
    ): Promise<LisAgentResponse | null> => {
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
              agent_name: options?.agentName,
              input_contract: inputContract,
              execution_mode: options?.executionMode || "auto",
            },
          }
        );

        if (fnError) {
          setError(fnError.message);
          return null;
        }

        if (data?.error) {
          setError(data.error);
          return null;
        }

        setLastResult(data as LisAgentResponse);
        return data as LisAgentResponse;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [projectId, organizationId]
  );

  const fetchHistory = useCallback(
    async (
      limit = 10,
      filters?: { stage?: LisStage; agentName?: LisAgentName }
    ): Promise<LisAgentExecution[]> => {
      let query = supabase
        .from("lis_agent_executions" as any)
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (filters?.stage) query = query.eq("stage", filters.stage);
      if (filters?.agentName) query = query.eq("agent_name", filters.agentName);

      const { data, error } = await query;
      if (error) {
        console.error("[useLisAgent] fetchHistory error:", error);
        return [];
      }

      return (data || []) as unknown as LisAgentExecution[];
    },
    [projectId]
  );

  return {
    invoke,
    fetchHistory,
    loading,
    lastResult,
    error,
  };
}
