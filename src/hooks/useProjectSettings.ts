import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TargetSuggestion } from "@/components/wizard/steps/LysSuggestionCards";

interface ProjectSettings {
  project_id: string;
  org_id: string | null;
  target_column: string | null;
  problem_type: string | null;
  feature_columns: string[] | null;
  excluded_columns: string[] | null;
  target_suggestion_meta: Record<string, unknown> | null;
  updated_at: string;
}

export function useProjectSettings(projectId: string | undefined) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSettings = useCallback(async () => {
    if (!projectId) return null;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("project_settings")
        .select("*")
        .eq("project_id", projectId)
        .maybeSingle();

      if (error) {
        console.error("Error loading project settings:", error);
        return null;
      }

      if (data) {
        const parsed: ProjectSettings = {
          project_id: data.project_id,
          org_id: data.org_id,
          target_column: data.target_column,
          problem_type: data.problem_type,
          feature_columns: data.feature_columns as string[] | null,
          excluded_columns: data.excluded_columns as string[] | null,
          target_suggestion_meta: data.target_suggestion_meta as Record<string, unknown> | null,
          updated_at: data.updated_at,
        };
        setSettings(parsed);
        return parsed;
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const saveSettings = useCallback(
    async (payload: {
      target_column: string;
      problem_type: string;
      feature_columns: string[];
      excluded_columns: string[];
      suggestion?: TargetSuggestion | null;
      org_id?: string | null;
    }) => {
      if (!projectId) return false;

      // Validations
      if (payload.feature_columns.includes(payload.target_column)) {
        console.error("Target column cannot be in feature_columns");
        return false;
      }
      if (payload.feature_columns.length === 0) {
        console.error("At least 1 feature must be selected");
        return false;
      }

      const record = {
        project_id: projectId,
        org_id: payload.org_id || null,
        target_column: payload.target_column,
        problem_type: payload.problem_type,
        feature_columns: payload.feature_columns,
        excluded_columns: payload.excluded_columns,
        target_suggestion_meta: payload.suggestion
          ? {
              chosen_suggestion_id: payload.suggestion.id,
              reasoning: payload.suggestion.reasoning,
              warnings: payload.suggestion.warnings,
            }
          : null,
      };

      const { error } = await supabase
        .from("project_settings")
        .upsert(record, { onConflict: "project_id" });

      if (error) {
        console.error("Error saving project settings:", error);
        return false;
      }

      // Also upsert project_model_selection for versioned SSOT
      // Increment selection_version on each save
      const { data: existing } = await supabase
        .from("project_model_selection" as any)
        .select("selection_version")
        .eq("project_id", projectId)
        .maybeSingle();

      const currentVersion = (existing as any)?.selection_version || 0;
      const newVersion = currentVersion + 1;

      // Compute target_hash
      const hashInput = `${projectId}|${payload.target_column}|${newVersion}`;
      let hash = 0;
      for (let i = 0; i < hashInput.length; i++) {
        const ch = hashInput.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash |= 0;
      }
      const targetHash = `th_${Math.abs(hash).toString(36)}`;

      await supabase.from("project_model_selection" as any).upsert({
        project_id: projectId,
        organization_id: payload.org_id || null,
        target_column: payload.target_column,
        problem_type: payload.problem_type,
        selected_features: payload.feature_columns,
        excluded_features: payload.excluded_columns,
        selection_version: newVersion,
        target_hash: targetHash,
        updated_at: new Date().toISOString(),
      } as any, { onConflict: "project_id" } as any);

      // Mark existing modeling datasets as stale if target changed
      await supabase.from("project_modeling_datasets" as any)
        .update({ is_current: false, stale_reason: "TARGET_CHANGED" } as any)
        .eq("project_id", projectId)
        .eq("is_current", true);

      setSettings({
        ...record,
        updated_at: new Date().toISOString(),
      });
      return true;
    },
    [projectId]
  );

  return { settings, loading, loadSettings, saveSettings };
}
