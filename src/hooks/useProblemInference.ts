import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SuggestedTarget {
  column: string;
  type: "binary" | "class" | "regression";
  confidence: number;
  business_summary: string;
  why_this_target: string;
  caveats: string[];
}

export interface SuggestedPredictor {
  column: string;
  score: number;
  reason: string;
}

export interface ProblemLabel {
  label: string;
  relevance: number;
}

export interface ProblemInference {
  id?: string;
  project_id: string;
  problem_type: string;
  suggested_problem_labels: ProblemLabel[];
  suggested_targets: SuggestedTarget[];
  suggested_predictors: SuggestedPredictor[];
  narrative: string;
  confidence: number;
  inference_version: string;
  created_at?: string;
}

export function useProblemInference(projectId: string | undefined) {
  const [inference, setInference] = useState<ProblemInference | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadInference = useCallback(
    async (forceRefresh = false) => {
      if (!projectId || loadingRef.current) return null;
      loadingRef.current = true;
      setLoading(true);
      setError(null);

      try {
        const { data, error: fnError } = await supabase.functions.invoke(
          "infer-problem",
          {
            body: {
              project_id: projectId,
              force_refresh: forceRefresh,
            },
          }
        );

        if (fnError) {
          const msg = fnError.message || "Erro ao gerar inferência";
          setError(msg);
          return null;
        }

        if (data?.error) {
          setError(data.error);
          return null;
        }

        const result = data?.inference as ProblemInference | null;
        if (result) {
          // Ensure arrays are properly parsed
          const parsed: ProblemInference = {
            ...result,
            suggested_problem_labels: Array.isArray(result.suggested_problem_labels)
              ? result.suggested_problem_labels
              : [],
            suggested_targets: Array.isArray(result.suggested_targets)
              ? result.suggested_targets
              : [],
            suggested_predictors: Array.isArray(result.suggested_predictors)
              ? result.suggested_predictors
              : [],
          };
          setInference(parsed);
          return parsed;
        }

        return null;
      } catch (err: any) {
        const msg = err?.message || "Erro inesperado";
        setError(msg);
        return null;
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [projectId]
  );

  return { inference, loading, error, loadInference };
}
