import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface LysRecommendation {
  suggested_problem_type?: string;
  suggested_target?: string;
  suggested_entity_key?: string;
  suggested_time_anchor?: string;
  suggested_features?: string[];
  blocked_features?: { column: string; reason: string }[];
  leakage_risks?: { column: string; risk_level: string; reason: string }[];
  alternative_target_candidates?: { column: string; problem_type: string; reason: string }[];
  reasoning_summary?: string;
}

export interface LysSynthesisResult {
  narrative: string | null;
  recommendation: LysRecommendation | null;
  confidence_score: number | null;
  synthesized_at: string | null;
}

const EMPTY: LysSynthesisResult = {
  narrative: null,
  recommendation: null,
  confidence_score: null,
  synthesized_at: null,
};

export function useLysSynthesis(projectId: string | undefined) {
  const [result, setResult] = useState<LysSynthesisResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  /** Load persisted synthesis from SSOT */
  const load = useCallback(async () => {
    if (!projectId) return EMPTY;
    setLoading(true);
    try {
      const { data } = await supabase
        .from("project_settings")
        .select("lys_insight_text, lys_recommendation_json, lys_confidence_score, lys_synthesized_at")
        .eq("project_id", projectId)
        .maybeSingle();

      if (data) {
        const d = data as Record<string, any>;
        const r: LysSynthesisResult = {
          narrative: d.lys_insight_text || null,
          recommendation: d.lys_recommendation_json || null,
          confidence_score: d.lys_confidence_score ?? null,
          synthesized_at: d.lys_synthesized_at || null,
        };
        setResult(r);
        loadedRef.current = true;
        return r;
      }
    } catch (err: any) {
      console.warn("[useLysSynthesis] load error:", err);
    } finally {
      setLoading(false);
    }
    return EMPTY;
  }, [projectId]);

  /** Trigger a new synthesis (calls edge function) */
  const generate = useCallback(async (language = "pt") => {
    if (!projectId) return null;
    setGenerating(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("lys-synthesize-insights", {
        body: { project_id: projectId, language },
      });
      if (fnError) throw fnError;
      if (!data?.success) {
        setError(data?.error || data?.message || "Synthesis failed");
        return null;
      }
      const r: LysSynthesisResult = {
        narrative: data.narrative || null,
        recommendation: data.recommendation || null,
        confidence_score: data.confidence_score ?? null,
        synthesized_at: new Date().toISOString(),
      };
      setResult(r);
      loadedRef.current = true;
      return r;
    } catch (err: any) {
      console.error("[useLysSynthesis] generate error:", err);
      setError(err.message || "Error generating synthesis");
      return null;
    } finally {
      setGenerating(false);
    }
  }, [projectId]);

  return {
    ...result,
    loading,
    generating,
    error,
    loaded: loadedRef.current,
    load,
    generate,
    hasRecommendation: !!result.recommendation?.suggested_target,
  };
}
