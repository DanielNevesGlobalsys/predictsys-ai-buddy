import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Target candidate as resolved by the intent-driven engine
 */
export interface TargetCandidateResolved {
  column: string;
  problem_type: string;
  strategy: "explicit" | "derived" | "insufficient";
  confidence: number;
  reasoning: string;
  derivation_formula?: string | null;
}

/**
 * Full resolution result from resolve-target-intent
 */
export interface IntentTargetResolution {
  target_strategy_used: string;
  main_candidate: TargetCandidateResolved | null;
  alternatives: TargetCandidateResolved[];
  is_explicit: boolean;
  is_derived: boolean;
  is_insufficient: boolean;
  derivation_formula: string | null;
  confidence_score: number;
  suggested_entity_key: string | null;
  suggested_time_anchor: string | null;
  problem_type_inferred: string;
  business_fit_assessment: string;
  blocked_targets: string[];
  blocked_target_reasons: { column: string; reason: string }[];
  suggested_features: string[];
  blocked_features: { column: string; reason: string }[];
  target_reasoning_summary: string;
}

const EMPTY: IntentTargetResolution = {
  target_strategy_used: "",
  main_candidate: null,
  alternatives: [],
  is_explicit: false,
  is_derived: false,
  is_insufficient: true,
  derivation_formula: null,
  confidence_score: 0,
  suggested_entity_key: null,
  suggested_time_anchor: null,
  problem_type_inferred: "classification",
  business_fit_assessment: "",
  blocked_targets: [],
  blocked_target_reasons: [],
  suggested_features: [],
  blocked_features: [],
  target_reasoning_summary: "",
};

export function useIntentDrivenTarget(projectId: string | undefined) {
  const [resolution, setResolution] = useState<IntentTargetResolution>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  /** Load persisted resolution from SSOT */
  const loadFromSSOT = useCallback(async () => {
    if (!projectId) return EMPTY;
    setLoading(true);
    try {
      const { data } = await supabase
        .from("project_settings")
        .select("target_intent_resolution")
        .eq("project_id", projectId)
        .maybeSingle();

      if (data) {
        const d = data as Record<string, any>;
        if (d.target_intent_resolution) {
          const r = d.target_intent_resolution as IntentTargetResolution;
          setResolution(r);
          loadedRef.current = true;
          setLoaded(true);
          return r;
        }
      }
    } catch (err: any) {
      console.warn("[useIntentDrivenTarget] load error:", err);
    } finally {
      setLoading(false);
    }
    setLoaded(true);
    return EMPTY;
  }, [projectId]);

  /** Trigger a fresh resolution (calls edge function) */
  const resolve = useCallback(async () => {
    if (!projectId) return null;
    setLoading(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("resolve-target-intent", {
        body: { project_id: projectId },
      });
      if (fnError) throw fnError;
      if (!data?.success) {
        setError(data?.error || "Resolution failed");
        return null;
      }
      const r: IntentTargetResolution = {
        target_strategy_used: data.target_strategy_used || "",
        main_candidate: data.main_candidate || null,
        alternatives: data.alternatives || [],
        is_explicit: data.is_explicit || false,
        is_derived: data.is_derived || false,
        is_insufficient: data.is_insufficient || false,
        derivation_formula: data.derivation_formula || null,
        confidence_score: data.confidence_score || 0,
        suggested_entity_key: data.suggested_entity_key || null,
        suggested_time_anchor: data.suggested_time_anchor || null,
        problem_type_inferred: data.problem_type_inferred || "classification",
        business_fit_assessment: data.business_fit_assessment || "",
        blocked_targets: data.blocked_targets || [],
        blocked_target_reasons: data.blocked_target_reasons || [],
        suggested_features: data.suggested_features || [],
        blocked_features: data.blocked_features || [],
        target_reasoning_summary: data.target_reasoning_summary || "",
      };
      setResolution(r);
      loadedRef.current = true;
      setLoaded(true);
      return r;
    } catch (err: any) {
      console.error("[useIntentDrivenTarget] resolve error:", err);
      setError(err.message || "Error resolving target");
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  return {
    resolution,
    loading,
    loaded,
    error,
    loadFromSSOT,
    resolve,
    hasCandidate: !!resolution.main_candidate,
  };
}
