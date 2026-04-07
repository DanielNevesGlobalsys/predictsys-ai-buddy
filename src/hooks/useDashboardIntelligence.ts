import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  parseBaDecisionToIntelligence,
  emptyDashboardIntelligence,
  type DashboardIntelligence,
} from "@/components/business-dashboard/dashboardIntelligence";

interface UseDashboardIntelligenceOptions {
  projectId: string;
  organizationId: string;
  autoLoad?: boolean;
}

export function useDashboardIntelligence({
  projectId,
  organizationId,
  autoLoad = true,
}: UseDashboardIntelligenceOptions) {
  const [intelligence, setIntelligence] = useState<DashboardIntelligence>(emptyDashboardIntelligence());
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
  const [hasData, setHasData] = useState(false);

  /** Load latest BA decision from persisted executions */
  const loadLatest = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from("lis_agent_executions" as any)
        .select("decision, created_at, confidence")
        .eq("project_id", projectId)
        .eq("agent_name", "business_analyst_agent")
        .in("stage", ["dashboard", "general"])
        .eq("status", "success")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data?.decision) {
        const parsed = parseBaDecisionToIntelligence(data.decision as Record<string, unknown>);
        setIntelligence(parsed);
        setLastGeneratedAt(data.created_at);
        setHasData(true);
      }
    } catch (err) {
      console.error("[useDashboardIntelligence] loadLatest error:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  /** Also load ML Engineer summary for technical layer */
  const loadTechnicalSummary = useCallback(async () => {
    if (!projectId) return;
    try {
      const { data } = await supabase
        .from("lis_agent_executions" as any)
        .select("decision")
        .eq("project_id", projectId)
        .eq("agent_name", "ml_engineer_agent")
        .eq("status", "success")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data?.decision) {
        const ml = data.decision as any;
        setIntelligence((prev) => ({
          ...prev,
          technical_summary_layer: {
            model_quality_summary:
              ml.training_assessment?.reasoning?.[0] ||
              `Qualidade: ${ml.training_assessment?.model_quality || "desconhecida"}`,
            score_reliability_summary:
              ml.deploy_readiness?.reasoning?.[0] ||
              `Deploy: ${ml.deploy_readiness?.status || "desconhecido"}`,
            main_limitation:
              ml.model_improvement_opportunities?.[0]?.suggestion ||
              ml.overfit_underfit_assessment?.recommendation || "",
          },
        }));
      }
    } catch {
      // ignore
    }
  }, [projectId]);

  /** Generate fresh intelligence by running the BA agent */
  const generate = useCallback(async () => {
    if (!projectId || !organizationId) return;
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("lis-orchestrator", {
        body: {
          project_id: projectId,
          organization_id: organizationId,
          stage: "dashboard",
          agent_name: "business_analyst_agent",
          execution_mode: "assisted",
          input_contract: { trigger: "dashboard_remodel" },
        },
      });

      if (error) throw error;

      const decision = data?.business_decision as Record<string, unknown>;
      if (decision) {
        const parsed = parseBaDecisionToIntelligence(decision);
        setIntelligence(parsed);
        setLastGeneratedAt(new Date().toISOString());
        setHasData(true);
      }

      // Also run ML engineer in shadow
      supabase.functions.invoke("lis-orchestrator", {
        body: {
          project_id: projectId,
          organization_id: organizationId,
          stage: "dashboard",
          agent_name: "ml_engineer_agent",
          execution_mode: "shadow",
          input_contract: { trigger: "dashboard_technical_summary" },
        },
      }).then(() => loadTechnicalSummary()).catch(() => {});
    } catch (err) {
      console.error("[useDashboardIntelligence] generate error:", err);
    } finally {
      setGenerating(false);
    }
  }, [projectId, organizationId, loadTechnicalSummary]);

  useEffect(() => {
    if (autoLoad && projectId) {
      loadLatest();
      loadTechnicalSummary();
    }
  }, [autoLoad, projectId, loadLatest, loadTechnicalSummary]);

  return {
    intelligence,
    loading,
    generating,
    hasData,
    lastGeneratedAt,
    generate,
    refresh: loadLatest,
  };
}
