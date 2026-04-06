import { useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * SSOT State for Target & Features — single source of truth from project_settings.
 * All UI in StepTargetFeatures MUST derive from this state.
 */
export interface TargetFeaturesSSOT {
  // ── Core target/feature state ──
  target_column: string | null;
  problem_type: string | null;
  feature_columns: string[];
  excluded_columns: string[];
  
  // ── Target source & mode ──
  target_source: "manual" | "label_builder" | "weak_supervision" | "human_labeling" | "column";
  active_target_mode: string | null;
  selected_template_id: string | null;
  
  // ── Versioning (triggers rehydration) ──
  selection_version: number;
  dataset_version: number;
  training_version: number;
  
  // ── Pipeline state ──
  builder_state: string | null;
  target_state: string | null;
  ingestion_state: string | null;
  
  // ── Structural keys ──
  entity_key: string | null;
  time_anchor_column: string | null;
  value_column: string | null;
  
  // ── Industry context ──
  industry: string | null;
  
  // ── Staleness ──
  staleness_flags: Record<string, boolean> | null;
  
  // ── Lifecycle ──
  target_lifecycle_state: string | null;
}

const EMPTY_SSOT: TargetFeaturesSSOT = {
  target_column: null,
  problem_type: null,
  feature_columns: [],
  excluded_columns: [],
  target_source: "manual",
  active_target_mode: null,
  selected_template_id: null,
  selection_version: 0,
  dataset_version: 0,
  training_version: 0,
  builder_state: null,
  target_state: null,
  ingestion_state: null,
  entity_key: null,
  time_anchor_column: null,
  value_column: null,
  industry: null,
  staleness_flags: null,
  target_lifecycle_state: null,
};

export function useTargetFeaturesSSOT(projectId: string | undefined) {
  const [ssot, setSSOT] = useState<TargetFeaturesSSOT>(EMPTY_SSOT);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fetchCountRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return EMPTY_SSOT;
    
    const fetchId = ++fetchCountRef.current;
    setLoading(true);
    
    try {
      const { data, error } = await supabase
        .from("project_settings")
        .select("*")
        .eq("project_id", projectId)
        .maybeSingle();

      // Stale request guard
      if (fetchId !== fetchCountRef.current) return ssot;

      if (error || !data) {
        console.warn("[useTargetFeaturesSSOT] No settings found for project", projectId);
        setSSOT(EMPTY_SSOT);
        setLoaded(true);
        return EMPTY_SSOT;
      }

      const d = data as Record<string, any>;
      
      const parsed: TargetFeaturesSSOT = {
        target_column: d.target_column || null,
        problem_type: d.problem_type || null,
        feature_columns: Array.isArray(d.feature_columns) ? d.feature_columns : [],
        excluded_columns: Array.isArray(d.excluded_columns) ? d.excluded_columns : [],
        target_source: d.target_source || "manual",
        active_target_mode: d.active_target_mode || null,
        selected_template_id: d.selected_template_id || null,
        selection_version: d.selection_version || 0,
        dataset_version: d.dataset_version || 0,
        training_version: d.training_version || 0,
        builder_state: d.builder_state || null,
        target_state: d.target_state || null,
        ingestion_state: d.ingestion_state || null,
        entity_key: d.entity_key || null,
        time_anchor_column: d.time_anchor_column || null,
        value_column: d.value_column || null,
        industry: d.industry || null,
        staleness_flags: d.staleness_flags || null,
        target_lifecycle_state: d.target_lifecycle_state || null,
      };

      setSSOT(parsed);
      setLoaded(true);
      return parsed;
    } catch (err) {
      console.error("[useTargetFeaturesSSOT] Error:", err);
      setLoaded(true);
      return EMPTY_SSOT;
    } finally {
      if (fetchId === fetchCountRef.current) {
        setLoading(false);
      }
    }
  }, [projectId]);

  /**
   * Derive the active mode label for UI rendering.
   * Priority: target_source > active_target_mode > fallback "manual"
   */
  const activeMode = ssot.target_source !== "manual" 
    ? ssot.target_source 
    : ssot.active_target_mode || "manual";

  /**
   * Whether the builder is ready (features have been built).
   */
  const isBuilderReady = ssot.builder_state === "ready";

  /**
   * Whether selection is stale relative to builder.
   */
  const isBuilderStale = ssot.staleness_flags?.builder_stale === true;

  // Reset on project switch
  React.useEffect(() => {
    setSSOT(EMPTY_SSOT);
    setLoaded(false);
    fetchCountRef.current = 0;
  }, [projectId]);

  return {
    ssot,
    loading,
    loaded,
    load,
    activeMode,
    isBuilderReady,
    isBuilderStale,
  };
}
