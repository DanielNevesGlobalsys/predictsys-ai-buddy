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

export interface IndustryInference {
  label: string;
  display_name: string;
  confidence: number;
  evidence: string[];
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
  industry?: IndustryInference;
}

function parseIndustryFromLabels(labels: ProblemLabel[]): IndustryInference | null {
  for (const l of labels) {
    if (l.label.startsWith("__industry:")) {
      const parts = l.label.replace("__industry:", "").split(":");
      if (parts.length >= 3) {
        return {
          label: parts[0],
          display_name: parts[1],
          confidence: parseFloat(parts[2]) || 0,
          evidence: [],
        };
      }
    }
  }
  return null;
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
        const industryFromResponse = data?.industry as IndustryInference | undefined;

        if (result) {
          const allLabels = Array.isArray(result.suggested_problem_labels)
            ? result.suggested_problem_labels
            : [];

          // Extract industry from __industry: label or from response
          const industryFromLabels = parseIndustryFromLabels(allLabels);
          const industry = industryFromResponse || industryFromLabels || undefined;

          // Filter out internal __industry labels
          const cleanLabels = allLabels.filter((l) => !l.label.startsWith("__industry:"));

          const parsed: ProblemInference = {
            ...result,
            suggested_problem_labels: cleanLabels,
            suggested_targets: Array.isArray(result.suggested_targets)
              ? result.suggested_targets
              : [],
            suggested_predictors: Array.isArray(result.suggested_predictors)
              ? result.suggested_predictors
              : [],
            industry,
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
