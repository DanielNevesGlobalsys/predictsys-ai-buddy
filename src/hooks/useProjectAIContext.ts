import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AIContextStage = "eda" | "targeting" | "training" | "predictions" | "business" | "storyline";

export interface AIContextEDA {
  summary: string;
  column_profile: Record<string, any>;
  warnings: string[];
  hypotheses: string[];
}

export interface AIContextTargeting {
  suggested_problems: string[];
  selected_problem: string;
  selected_target: string;
  recommended_features: string[];
  excluded_features: string[];
  justification: string;
}

export interface AIContextTraining {
  model_type: string;
  metrics: Record<string, number>;
  limitations: string[];
  confidence_level: string;
}

export interface AIContextPredictions {
  horizons: Record<string, any>;
  segment_insights: any[];
}

export interface AIContextBusiness {
  kpis: Record<string, any>;
  risks: string[];
  opportunities: string[];
  campaigns_summary: any[];
}

export interface AIContextStoryline {
  executive_summary: string;
  last_update_reason: string;
}

export interface ProjectAIContext {
  eda: AIContextEDA;
  targeting: AIContextTargeting;
  training: AIContextTraining;
  predictions: AIContextPredictions;
  business: AIContextBusiness;
  storyline: AIContextStoryline;
}

export interface ProjectAIContextRecord {
  id: string;
  organization_id: string;
  project_id: string;
  context: ProjectAIContext;
  status: string;
  last_updated_at: string;
  created_at: string;
}

const DEFAULT_CONTEXT: ProjectAIContext = {
  eda: { summary: "", column_profile: {}, warnings: [], hypotheses: [] },
  targeting: {
    suggested_problems: [],
    selected_problem: "",
    selected_target: "",
    recommended_features: [],
    excluded_features: [],
    justification: "",
  },
  training: { model_type: "", metrics: {}, limitations: [], confidence_level: "" },
  predictions: { horizons: {}, segment_insights: [] },
  business: { kpis: {}, risks: [], opportunities: [], campaigns_summary: [] },
  storyline: { executive_summary: "", last_update_reason: "" },
};

export function useProjectAIContext(projectId: string | undefined) {
  const [context, setContext] = useState<ProjectAIContext>(DEFAULT_CONTEXT);
  const [status, setStatus] = useState<string>("draft");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadingRef = useRef(false);

  const loadContext = useCallback(async () => {
    if (!projectId || loadingRef.current) return null;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data, error } = await supabase
        .from("project_ai_context")
        .select("*")
        .eq("project_id", projectId)
        .maybeSingle();

      if (error) {
        console.error("[useProjectAIContext] Load error:", error);
        return null;
      }

      if (data) {
        const ctx = (data.context as unknown as ProjectAIContext) || DEFAULT_CONTEXT;
        setContext({ ...DEFAULT_CONTEXT, ...ctx });
        setStatus(data.status || "draft");
        setLoaded(true);
        return ctx;
      }

      setLoaded(true);
      return null;
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [projectId]);

  const appendContext = useCallback(
    async (
      stage: AIContextStage,
      payload: Record<string, any>,
      organizationId?: string,
      statusUpdate?: string
    ) => {
      if (!projectId) return false;

      try {
        const { data, error } = await supabase.functions.invoke("append-project-context", {
          body: {
            project_id: projectId,
            organization_id: organizationId || undefined,
            stage,
            payload,
            status_update: statusUpdate,
          },
        });

        if (error) {
          console.error("[useProjectAIContext] Append error:", error);
          return false;
        }

        if (data?.context) {
          setContext(data.context);
        }
        if (data?.status) {
          setStatus(data.status);
        }

        return true;
      } catch (err) {
        console.error("[useProjectAIContext] Append exception:", err);
        return false;
      }
    },
    [projectId]
  );

  const getStage = useCallback(
    <T extends keyof ProjectAIContext>(stage: T): ProjectAIContext[T] => {
      return context[stage];
    },
    [context]
  );

  return {
    context,
    status,
    loading,
    loaded,
    loadContext,
    appendContext,
    getStage,
  };
}
