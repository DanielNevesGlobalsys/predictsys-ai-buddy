import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { LisStage, LisExecutionMode } from "@/types/lisAgents";
import { useToast } from "@/hooks/use-toast";

export interface MLDecisionResult {
  execution_id: string;
  agent_name: string;
  stage: string;
  execution_mode: string;
  ml_decision: Record<string, unknown>;
  audit_metadata: Record<string, unknown>;
}

export function useMLEngineerAgent(projectId: string, organizationId: string) {
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<MLDecisionResult | null>(null);
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
          agent_name: "ml_engineer_agent",
          execution_mode: mode,
          input_contract: inputContract,
        },
      });
      if (error) throw error;
      setLastResult(data as MLDecisionResult);
      return data as MLDecisionResult;
    } catch (err: any) {
      toast({
        title: "Erro no ML Engineer Agent",
        description: err.message || "Falha na análise de ML",
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
      .eq("agent_name", "ml_engineer_agent")
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setHistory(data);
  }, [projectId]);

  return { loading, lastResult, history, runCheck, loadHistory };
}
