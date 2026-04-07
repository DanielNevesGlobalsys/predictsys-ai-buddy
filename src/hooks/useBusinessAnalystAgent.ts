import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { LisStage, LisExecutionMode } from "@/types/lisAgents";
import { useToast } from "@/hooks/use-toast";

export interface BADecisionResult {
  execution_id: string;
  agent_name: string;
  stage: string;
  execution_mode: string;
  business_decision: Record<string, unknown>;
  audit_metadata: Record<string, unknown>;
}

export function useBusinessAnalystAgent(projectId: string, organizationId: string) {
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<BADecisionResult | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const { toast } = useToast();

  const runCheck = useCallback(async (
    stage: LisStage,
    mode: LisExecutionMode = "assisted",
    inputContract: Record<string, unknown> = {},
  ) => {
    if (!projectId || !organizationId) return null;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("lis-orchestrator", {
        body: {
          project_id: projectId,
          organization_id: organizationId,
          stage,
          agent_name: "business_analyst_agent",
          execution_mode: mode,
          input_contract: inputContract,
        },
      });
      if (error) throw error;
      setLastResult(data as BADecisionResult);
      return data as BADecisionResult;
    } catch (err: any) {
      toast({
        title: "Erro no Business Analyst Agent",
        description: err.message || "Falha na análise de negócio",
        variant: "destructive",
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, organizationId, toast]);

  const loadHistory = useCallback(async () => {
    if (!projectId) return;
    const { data } = await supabase
      .from("lis_agent_executions")
      .select("id, stage, status, confidence, decision, created_at, duration_ms, execution_mode")
      .eq("project_id", projectId)
      .eq("agent_name", "business_analyst_agent")
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setHistory(data);
  }, [projectId]);

  return { loading, lastResult, history, runCheck, loadHistory };
}
