import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { LisAgentExecution, LisStage } from "@/types/lisAgents";
import type { OrchestratedRunResult, ExecutionMode } from "@/types/lisOrchestration";
import { STAGE_ORCHESTRATION_MAP } from "@/types/lisOrchestration";

interface UseLisOrchestrationOptions {
  projectId: string;
  organizationId: string;
}

export function useLisOrchestration({ projectId, organizationId }: UseLisOrchestrationOptions) {
  const [loading, setLoading] = useState(false);
  const [lastRun, setLastRun] = useState<OrchestratedRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Run orchestrated stage: primary agent + validator
   */
  const runStage = useCallback(
    async (
      stage: LisStage,
      inputContract: Record<string, unknown> = {},
      modeOverride?: ExecutionMode,
    ): Promise<OrchestratedRunResult | null> => {
      if (!projectId || !organizationId) return null;

      const config = STAGE_ORCHESTRATION_MAP[stage] || STAGE_ORCHESTRATION_MAP.general;
      const mode = modeOverride || config.default_mode;

      setLoading(true);
      setError(null);

      try {
        // 1. Run primary agent
        const { data: primaryData, error: primaryErr } = await supabase.functions.invoke(
          "lis-orchestrator",
          {
            body: {
              project_id: projectId,
              organization_id: organizationId,
              stage,
              agent_name: config.primary_agent,
              input_contract: inputContract,
              execution_mode: mode,
            },
          },
        );

        if (primaryErr) {
          setError(primaryErr.message);
          return null;
        }

        // 2. Run validator (governance) if different from primary
        let validatorData: Record<string, unknown> | null = null;
        if (config.validator_agent !== config.primary_agent) {
          const { data: valData, error: valErr } = await supabase.functions.invoke(
            "lis-orchestrator",
            {
              body: {
                project_id: projectId,
                organization_id: organizationId,
                stage,
                agent_name: config.validator_agent,
                input_contract: {
                  ...inputContract,
                  primary_agent_decision: primaryData,
                },
                execution_mode: "shadow",
              },
            },
          );

          if (!valErr) {
            validatorData = valData;
          }
        }

        // 3. Determine final status
        const primaryStatus = (primaryData?.status as string) ||
          (primaryData?.governance_decision?.pipeline_status as string) ||
          (primaryData?.ds_decision ? "success" : "completed");

        const validatorStatus = validatorData
          ? ((validatorData as any)?.governance_decision?.pipeline_status as string) || "success"
          : undefined;

        const confidence = (primaryData?.confidence as number) ||
          (primaryData?.governance_decision?.confidence as number) ||
          (primaryData?.ds_decision?.confidence as number) ||
          (primaryData?.de_decision?.confidence as number) ||
          (primaryData?.ml_decision?.confidence as number) ||
          (primaryData?.business_decision?.confidence as number) ||
          0;

        const isBlocked = validatorStatus === "blocked" ||
          (config.application_policy === "block" && primaryStatus === "blocked");

        const canAutoApply = config.auto_apply_allowed &&
          !isBlocked &&
          confidence >= 0.7 &&
          primaryStatus !== "failed";

        const result: OrchestratedRunResult = {
          project_id: projectId,
          stage,
          primary_agent: config.primary_agent,
          secondary_agents: config.secondary_agents,
          validator_agent: config.validator_agent,
          execution_mode: mode,
          application_policy: config.application_policy,
          status: isBlocked ? "blocked" : "completed",
          primary_execution_id: primaryData?.execution_id || null,
          validator_execution_id: (validatorData as any)?.execution_id || null,
          primary_decision: primaryData,
          validator_decision: validatorData,
          applied: canAutoApply,
          applied_at: canAutoApply ? new Date().toISOString() : null,
          blocked_by: isBlocked ? config.validator_agent : null,
          confidence,
        };

        setLastRun(result);
        return result;
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

  /**
   * Fetch latest orchestrated executions for a stage
   */
  const fetchStageHistory = useCallback(
    async (stage: LisStage, limit = 10): Promise<LisAgentExecution[]> => {
      const { data, error } = await supabase
        .from("lis_agent_executions" as any)
        .select("*")
        .eq("project_id", projectId)
        .eq("stage", stage)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        console.error("[useLisOrchestration] fetchStageHistory error:", error);
        return [];
      }
      return (data || []) as unknown as LisAgentExecution[];
    },
    [projectId],
  );

  /**
   * Fetch the latest decision for a specific agent+stage
   */
  const fetchLatestDecision = useCallback(
    async (stage: LisStage, agentName: string): Promise<LisAgentExecution | null> => {
      const { data, error } = await supabase
        .from("lis_agent_executions" as any)
        .select("*")
        .eq("project_id", projectId)
        .eq("stage", stage)
        .eq("agent_name", agentName)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data) return null;
      return data as unknown as LisAgentExecution;
    },
    [projectId],
  );

  return {
    runStage,
    fetchStageHistory,
    fetchLatestDecision,
    loading,
    lastRun,
    error,
    getConfig: (stage: string) => STAGE_ORCHESTRATION_MAP[stage] || STAGE_ORCHESTRATION_MAP.general,
  };
}
