import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Target, Layers, Info, Loader2, Sparkles, AlertCircle, Save, AlertTriangle, Ban, Database, CheckCircle, XCircle, KeyRound } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import TargetPresenceScan from "./TargetPresenceScan";
import ColumnInferenceMatrix, { type ColumnInferenceRow } from "./ColumnInferenceMatrix";
import BlockedTargetCandidates from "./BlockedTargetCandidates";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../WizardContainer";
import type { FeatureExpression } from "@/lib/featureEngineering";
import { LABEL_TEMPLATES } from "@/config/labelTemplates";
import ExcludedFeaturesList from "./ExcludedFeaturesList";
import ModelingDatasetSection from "./ModelingDatasetSection";
import TrainingPreflightPanel from "./TrainingPreflightPanel";

import TargetStrategyPanel from "./TargetStrategyPanel";
import SplitAndLeakagePanel from "./SplitAndLeakagePanel";
import AuditContractPanel from "./AuditContractPanel";
import TargetQualityCard from "./TargetQualityCard";
import WeakLabelBuilderCard from "./WeakLabelBuilderCard";
import HumanLabelingCard from "./HumanLabelingCard";
import TargetLifecycleCard from "./TargetLifecycleCard";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useProjectAIContext } from "@/hooks/useProjectAIContext";
import { useProblemInference } from "@/hooks/useProblemInference";
import { logProjectAuditEvent } from "@/lib/auditLog";
import { useDatasetState } from "@/hooks/useDatasetState";
import { useTargetFeaturesSSOT } from "@/hooks/useTargetFeaturesSSOT";
import { useProjectSchemaSSOT } from "@/hooks/useProjectSchemaSSOT";

interface StepTargetFeaturesProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onConfigChange?: () => void;
  onSSOTChanged?: () => void;
}

interface ColumnInfo {
  name: string;
  type: string;
  isFeature?: boolean;
  featureLabel?: string;
  featureHasError?: boolean;
}
// CoverageStats from manifest diagnostics
interface CoverageStats {
  critical_columns_pct: number;
  global_null_pct: number;
  top_10_null_columns: { column: string; null_pct: number }[];
  file_contribution: { file: string; rows: number; data_cols: number; null_only_cols: number; contribution_type: "data" | "mostly_null" }[];
}

const StepTargetFeatures = ({
  projectData,
  onNext,
  onBack,
  loading,
  saveProject,
  onConfigChange,
  onSSOTChanged,
}: StepTargetFeaturesProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [loadingColumns, setLoadingColumns] = useState(true);
  const initialTargetRef = useRef<string | null>(null);
  const hasChangedConfig = useRef(false);

  // ═══ SSOT: Single Source of Truth from project_settings ═══
  const { ssot, loaded: ssotLoaded, load: loadSSOT, activeMode, isBuilderReady, isBuilderStale } = useTargetFeaturesSSOT(projectData.id);

  // ── Editable state derived from SSOT (user can modify, then persists back) ──
  const [targetColumn, setTargetColumn] = useState("");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [excludedColumns, setExcludedColumns] = useState<string[]>([]);
  const [inferredProblemType, setInferredProblemType] = useState<string | null>(null);
  const [targetSource, setTargetSource] = useState<"manual" | "label_builder" | "weak_supervision" | "human_labeling">("manual");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [entityKey, setEntityKey] = useState<string>("");

  // SSOT dataset state
  const ds = useDatasetState(projectData.id);

  // Schema SSOT — consolidated column list
  const schemaSSOT = useProjectSchemaSSOT(projectData.id);

  // Builder version mismatch tracking
  const [builderVersionUsed, setBuilderVersionUsed] = useState<number | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);

  // Column inference matrix data
  const [columnInference, setColumnInference] = useState<ColumnInferenceRow[]>([]);
  const columnInferenceMap = useRef(new Map<string, ColumnInferenceRow>());

  // Inference panel
  const [appliedTargetColumn, setAppliedTargetColumn] = useState<string | null>(null);
  const [selectionVersion, setSelectionVersion] = useState<number | null>(null);
  const [hasEDA, setHasEDA] = useState(false);
  const inferenceAutoLoaded = useRef(false);

  // Preflight refresh key — incremented after builder completes
  const [preflightRefreshKey, setPreflightRefreshKey] = useState(0);

  // Problem inference hook
  const { inference, loading: inferenceLoading, error: inferenceError, loadInference } = useProblemInference(projectData.id);

  // Project settings persistence (for saveSettings)
  const { settings, loadSettings, saveSettings } = useProjectSettings(projectData.id);
  const { appendContext, loadContext } = useProjectAIContext(projectData.id);

  // Contract hints from Etapa 2 auto-detection
  const [contractHints, setContractHints] = useState<{
    entity_key?: string | null;
    time_anchor_column?: string | null;
    event_candidates?: string[];
    value_candidates?: string[];
    status_candidates?: { column: string; score: number; reason?: string }[];
    tde_status_candidates?: { column: string; score: number; reason?: string }[];
    tde_value_candidates?: { column: string; score: number; reason?: string }[];
  } | null>(null);

  // Intent contract info for target builder
  const [intentInfo, setIntentInfo] = useState<{
    labelBuilderRequired: boolean;
    recommendedTemplates: { template_id: string; display_name: string; problem_type: string }[];
    industry: string;
  }>({ labelBuilderRequired: false, recommendedTemplates: [], industry: "generic" });

  // Label builder state
  const [labelBuilderId, setLabelBuilderId] = useState<string | null>(null);
  const [labelTemplateId, setLabelTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (projectData.id) {
      loadColumns();
      checkEDA();
      ds.load();
      loadSSOT();
      schemaSSOT.load();
      loadSelectionVersion();
      loadBuilderVersion();
      loadContractHints();
      loadIntentInfo();
      loadSettings();
    }
  }, [projectData.id]);

  const loadIntentInfo = async () => {
    if (!projectData.id) return;
    const [{ data: settingsData }, { data }] = await Promise.all([
      supabase
        .from("project_settings")
        .select("industry, industry_source")
        .eq("project_id", projectData.id)
        .maybeSingle(),
      supabase
        .from("project_ai_context")
        .select("context")
        .eq("project_id", projectData.id)
        .maybeSingle(),
    ]);

    // Read industry from SSOT (project_settings) — never default to "generic"
    let resolvedIndustry: string | null = null;
    if (settingsData) {
      const ind = (settingsData as any).industry;
      if (ind) resolvedIndustry = ind;
    }

    let labelBuilderRequired = false;
    let recommendedTemplates: { template_id: string; display_name: string; problem_type: string }[] = [];

    if (data?.context) {
      const ctx = data.context as Record<string, any>;
      const ic = ctx.intent_contract || ctx.intent || {};
      const ib = ic.intent_base || ic;
      const da = ic.domain_adapter || {};
      labelBuilderRequired = ib.label_builder_required || false;
      recommendedTemplates = da.recommended_templates || [];
      // Only use AI context industry as fallback if SSOT is null
      if (!resolvedIndustry && (da.industry || ib.industry_hint)) {
        const candidate = da.industry || ib.industry_hint;
        // Don't adopt "generic" from AI context — keep null
        if (candidate && candidate !== "generic") {
          resolvedIndustry = candidate;
        }
      }
    }

    setIntentInfo({
      labelBuilderRequired,
      recommendedTemplates,
      industry: resolvedIndustry,
    });
  };

  const loadContractHints = async () => {
    if (!projectData.id) return;
    const [{ data: aiCtxData }, { data: dsStateData }] = await Promise.all([
      supabase
        .from("project_ai_context")
        .select("context")
        .eq("project_id", projectData.id)
        .maybeSingle(),
      supabase
        .from("project_dataset_state")
        .select("active_dataset_ref, manifest_id")
        .eq("project_id", projectData.id)
        .maybeSingle(),
    ]);
    if (aiCtxData?.context) {
      const ctx = aiCtxData.context as Record<string, any>;
      if (ctx.contract_hints || ctx.tde_profile) {
        const hints = ctx.contract_hints || {};
        // Only use hints if they match the current dataset/manifest
        const currentRef = dsStateData?.active_dataset_ref || null;
        const currentManifest = dsStateData?.manifest_id || null;
        const hintsRef = hints.dataset_ref || null;
        const hintsManifest = hints.manifest_id || null;
        // If hints have a dataset_ref, it must match current; otherwise accept (legacy hints)
        const refMatch = !hintsRef || hintsRef === currentRef;
        const manifestMatch = !hintsManifest || hintsManifest === currentManifest;
        
        // Extract TDE profile candidates (status/event/value)
        const tdeProfile = ctx.tde_profile as Record<string, any> | null;
        const tdeCandidates = tdeProfile?.candidates || {};
        // TDE stores "reasons" (string[]), UI expects "reason" (string) — normalize
        const normalizeCandidate = (c: any) => ({
          column: c.column as string,
          score: Math.min((c.score as number) || 0, 95),
          reasons: Array.isArray(c.reasons) ? (c.reasons as string[]) : [],
          reason: Array.isArray(c.reasons) ? (c.reasons as string[]).join("; ") : (c.reason as string | undefined),
        });
        const tdeStatusCandidates = ((tdeCandidates.status_candidates || []) as any[]).map(normalizeCandidate);
        const tdeValueCandidates = ((tdeCandidates.value_candidates || []) as any[]).map(normalizeCandidate);
        
        console.log("[StepTargetFeatures] TDE candidates found:", { 
          statusCount: tdeStatusCandidates.length, 
          valueCount: tdeValueCandidates.length,
          refMatch, manifestMatch,
          hintsRef, currentRef, hintsManifest, currentManifest
        });

        if (refMatch && manifestMatch) {
          setContractHints({
            ...hints,
            tde_status_candidates: tdeStatusCandidates,
            tde_value_candidates: tdeValueCandidates,
          });
        } else if (tdeStatusCandidates.length > 0 || tdeValueCandidates.length > 0) {
          // Even if hints are stale, TDE candidates may still be relevant
          setContractHints({
            tde_status_candidates: tdeStatusCandidates,
            tde_value_candidates: tdeValueCandidates,
          });
          console.log("[StepTargetFeatures] Stale contract_hints ignored but TDE candidates kept");
        } else {
          console.log("[StepTargetFeatures] Stale contract_hints ignored (dataset/manifest mismatch)");
        }
      }
    }
  };

  const loadBuilderVersion = async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("project_modeling_datasets" as any)
      .select("selection_version_used")
      .eq("project_id", projectData.id)
      .eq("is_current", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) setBuilderVersionUsed((data as any).selection_version_used ?? null);
    else setBuilderVersionUsed(null);
  };

  const loadSelectionVersion = async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("project_model_selection" as any)
      .select("selection_version")
      .eq("project_id", projectData.id)
      .maybeSingle();
    if (data) setSelectionVersion((data as any).selection_version);
  };

  // Coverage stats from fallback
  const coverageStats = ds.fallback?.coverageStats as CoverageStats | null;

  // Auto-load inference when EDA is available
  useEffect(() => {
    if (hasEDA && !inferenceAutoLoaded.current && !inference) {
      inferenceAutoLoaded.current = true;
      loadInference(false);
    }
  }, [hasEDA, inference, loadInference]);

  // ═══ SSOT-driven rehydration: derive local editable state from SSOT ═══
  useEffect(() => {
    if (ssotLoaded && columns.length > 0) {
      // Hydrate target
      if (ssot.target_column) {
        const isPhysical = columns.some((c) => c.name === ssot.target_column);
        const isLabel = ssot.target_column === "label";
        if (isPhysical || isLabel) {
          setTargetColumn(ssot.target_column);
          setAppliedTargetColumn(ssot.target_column);
        }
      }
      // Hydrate features
      if (ssot.feature_columns.length > 0) {
        setSelectedFeatures(ssot.feature_columns);
      }
      // Hydrate excluded
      if (ssot.excluded_columns.length > 0) {
        setExcludedColumns(ssot.excluded_columns);
      }
      // Hydrate problem type
      if (ssot.problem_type) {
        setInferredProblemType(ssot.problem_type);
      }
      // Hydrate target source & template
      if (ssot.target_source && ssot.target_source !== "manual") {
        setTargetSource(ssot.target_source as any);
      }
      if (ssot.selected_template_id) {
        setSelectedTemplateId(ssot.selected_template_id);
      }
      // Hydrate selection version
      setSelectionVersion(ssot.selection_version || null);
      // Hydrate entity key
      if (ssot.entity_key) {
        setEntityKey(ssot.entity_key);
      }
      // Hydrate industry into intentInfo
      if (ssot.industry) {
        setIntentInfo(prev => ({ ...prev, industry: ssot.industry! }));
      }
    }
  }, [ssotLoaded, ssot, columns]);

  // Fallback: Also restore from useProjectSettings (for backward compat)
  useEffect(() => {
    if (settings && ssotLoaded && columns.length > 0 && !ssot.target_column) {
      if (settings.target_column) {
        const isPhysical = columns.some((c) => c.name === settings.target_column);
        const isLabel = settings.target_column === "label";
        if (isPhysical || isLabel) {
          setTargetColumn(settings.target_column);
          setAppliedTargetColumn(settings.target_column);
        }
      }
      if (settings.feature_columns && settings.feature_columns.length > 0) {
        setSelectedFeatures(settings.feature_columns);
      }
      if (settings.excluded_columns) {
        setExcludedColumns(settings.excluded_columns);
      }
      if (settings.problem_type) {
        setInferredProblemType(settings.problem_type);
      }
    }
  }, [settings, ssotLoaded, ssot, columns]);

  // NOTE: We intentionally do NOT pre-fill target from event_candidates.
  // event_candidate ≠ target. Target is often derived (e.g. "no purchase in 90 days").
  // We only pre-fill entity_key + time_anchor (structural keys), not the target.

  // Store initial target on mount
  useEffect(() => {
    if (projectData.target_column && initialTargetRef.current === null) {
      initialTargetRef.current = projectData.target_column;
    }
  }, [projectData.target_column]);

  // Auto-select all features when columns load and no SSOT features exist
  useEffect(() => {
    if (columns.length > 0 && selectedFeatures.length === 0 && ssotLoaded && ssot.feature_columns.length === 0) {
      const features = columns
        .filter((c) => c.name !== targetColumn && !c.featureHasError)
        .map((c) => c.name);
      setSelectedFeatures(features);
    }
  }, [columns, targetColumn, ssotLoaded, ssot.feature_columns]);

  const checkEDA = async () => {
    if (!projectData.id) return;
    const { count } = await supabase
      .from("project_numeric_stats")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectData.id);
    setHasEDA((count || 0) > 0);
  };

  const loadColumns = async () => {
    setLoadingColumns(true);
    try {
      const { data: colData, error: colError } = await supabase
        .from("project_columns")
        .select("column_name, inferred_type")
        .eq("project_id", projectData.id)
        .order("column_index");

      if (colError) {
        console.error("Error loading columns:", colError);
        return;
      }

      const { data: featureData, error: featureError } = await supabase
        .from("project_features")
        .select("name, label, enabled, expression")
        .eq("project_id", projectData.id)
        .eq("enabled", true);

      if (featureError) {
        console.error("Error loading features:", featureError);
      }

      const cols: ColumnInfo[] = [];
      // Track seen names (lowercase) to deduplicate physical columns vs derived features
      const seenLower = new Set<string>();

      if (colData && colData.length > 0) {
        for (const col of colData) {
          seenLower.add(col.column_name.toLowerCase());
          cols.push({
            name: col.column_name,
            type: col.inferred_type,
            isFeature: false,
          });
        }
      }

      // Only add derived features that are NOT already in project_columns (physical)
      if (featureData && featureData.length > 0) {
        for (const feature of featureData) {
          if (seenLower.has(feature.name.toLowerCase())) {
            // Already exists as physical column — skip to avoid duplicate
            // Find the physical column and mark it as derived+materialized
            const physIdx = cols.findIndex(c => c.name.toLowerCase() === feature.name.toLowerCase());
            if (physIdx >= 0) {
              cols[physIdx].isFeature = true;
              cols[physIdx].featureLabel = feature.label + " (materializado)";
            }
            continue;
          }
          const expr = feature.expression as FeatureExpression | null;
          const hasError = !expr || !expr.type;
          seenLower.add(feature.name.toLowerCase());
          cols.push({
            name: feature.name,
            type: "numérico",
            isFeature: true,
            featureLabel: feature.label,
            featureHasError: hasError,
          });
        }
      }

      // ── Enrich with Schema SSOT columns not in project_columns ──
      // This ensures ALL consolidated columns are available even if project_columns
      // only has a subset (e.g. from a partial file/part)
      if (schemaSSOT.columns.length > 0) {
        for (const sc of schemaSSOT.columns) {
          if (!seenLower.has(sc.name.toLowerCase())) {
            seenLower.add(sc.name.toLowerCase());
            cols.push({
              name: sc.name,
              type: sc.type || "desconhecido",
              isFeature: false,
            });
          }
        }
        console.log(`[StepTargetFeatures] Enriched columns with SSOT: ${cols.length} total (SSOT has ${schemaSSOT.schema_columns_count})`);
      }

      setColumns(cols);

      if (projectData.target_column && cols.some((c) => c.name === projectData.target_column)) {
        setTargetColumn(projectData.target_column);
      }
    } catch (err) {
      console.error("Error loading columns:", err);
    }
    setLoadingColumns(false);
  };

  const handleTargetChange = (value: string) => {
    if (initialTargetRef.current && value !== initialTargetRef.current && !hasChangedConfig.current) {
      hasChangedConfig.current = true;
      onConfigChange?.();
    }
    setTargetColumn(value);
    // If switching away from label, mark as manual
    if (value !== "label") {
      setTargetSource("manual");
    }
    setSelectedFeatures((prev) => {
      const newFeatures = prev.filter((f) => f !== value);
      if (newFeatures.length === 0) {
        return columns.filter((c) => c.name !== value).map((c) => c.name);
      }
      return newFeatures;
    });
    setAppliedTargetColumn(null);
    setInferredProblemType(null);
  };

  const toggleFeature = (columnName: string) => {
    setSelectedFeatures((prev) =>
      prev.includes(columnName)
        ? prev.filter((f) => f !== columnName)
        : [...prev, columnName]
    );
  };

  /**
   * Leakage keyword blocklist for auto-feature selection.
   * These patterns indicate columns that are likely derived from or identical to the target.
   */
  const LEAKAGE_KEYWORDS = [
    "target", "label", "resultado", "result", "status_final", "outcome",
    "predicted", "prediction", "score_final", "y_true", "y_pred",
    "suggested_label", "confidence", "label_source",
  ];

  const isLeakageCandidate = (colName: string): boolean => {
    const lower = colName.toLowerCase();
    return LEAKAGE_KEYWORDS.some(kw => lower === kw || lower.includes(kw));
  };

  /**
   * Auto-populate features: preserves existing selection if any,
   * otherwise selects all valid columns except target + structural keys + leakage suspects.
   * Always removes the target column and obvious leakage from the selection.
   */
  const autoPopulateFeatures = (newTarget: string) => {
    setSelectedFeatures(prev => {
      const structuralCols = new Set<string>();
      if (ssot.entity_key) structuralCols.add(ssot.entity_key);
      if (ssot.time_anchor_column) structuralCols.add(ssot.time_anchor_column);
      if (contractHints?.entity_key) structuralCols.add(contractHints.entity_key);
      if (contractHints?.time_anchor_column) structuralCols.add(contractHints.time_anchor_column);
      structuralCols.add(newTarget);

      if (prev.length > 0) {
        // Preserve existing but remove target + leakage
        return prev.filter(f => f !== newTarget && !isLeakageCandidate(f));
      }

      // Auto-select: all valid columns minus structural + leakage
      return columns
        .filter(c => !structuralCols.has(c.name) && !c.featureHasError && !isLeakageCandidate(c.name))
        .map(c => c.name);
    });
  };

  /**
   * Map target_source to the canonical active_target_mode used by resolveActiveTarget().
   */
  const sourceToMode = (source: string): string => {
    const map: Record<string, string> = {
      label_builder: "template",
      weak_supervision: "weak",
      human_labeling: "human",
      manual: "column",
      column: "column",
    };
    return map[source] || "column";
  };

  /**
   * Persist target_source, active_target_mode, and active_target_column to project_settings (SSOT).
   * This ensures resolveActiveTarget() in preflight/train-models reads the correct mode.
   */
  const persistTargetSourceToSSOT = async (source: string, templateId: string | null, targetCol?: string) => {
    if (!projectData.id) return;
    const mode = sourceToMode(source);
    const col = targetCol || targetColumn || (source !== "manual" ? "label" : null);
    try {
      await supabase
        .from("project_settings")
        .update({
          target_source: source,
          selected_template_id: templateId,
          active_target_mode: mode,
          active_target_column: col,
          target_state: col ? "ready" : "draft",
        } as any)
        .eq("project_id", projectData.id);
      console.log(`[StepTargetFeatures] SSOT persisted: source=${source}, mode=${mode}, col=${col}`);
      await loadSSOT();
      onSSOTChanged?.();
    } catch (err) {
      console.error("[StepTargetFeatures] Failed to persist target_source:", err);
    }
  };

  const handleSaveSettings = async (): Promise<boolean> => {
    if (!projectData.id || !targetColumn) return false;
    if (!entityKey) {
      toast({
        title: "Entity Key obrigatória",
        description: "Selecione a coluna que identifica a entidade (ex: id_cliente, cpf) antes de salvar.",
        variant: "destructive",
      });
      return false;
    }

    const cleanFeatures = selectedFeatures.filter((f) => f !== targetColumn);
    if (cleanFeatures.length === 0) {
      toast({
        title: t("common.error"),
        description: t("lysSuggestions.needOneFeature", "Selecione ao menos 1 feature."),
        variant: "destructive",
      });
      return false;
    }

    const problemType = inferredProblemType || projectData.problem_type;

    const saved = await saveSettings({
      target_column: targetColumn,
      problem_type: problemType,
      feature_columns: cleanFeatures,
      excluded_columns: excludedColumns,
      suggestion: null,
    });

    if (saved) {
      // Persist entity_key to project_settings (separate from model selection)
      supabase
        .from("project_settings")
        .update({ entity_key: entityKey } as any)
        .eq("project_id", projectData.id)
        .then(({ error }) => {
          if (error) console.error("[StepTargetFeatures] Failed to persist entity_key:", error);
          else console.log(`[StepTargetFeatures] entity_key persisted: ${entityKey}`);
        });

      // Fire observability event for entity_key selection
      supabase.functions.invoke("track-event", {
        body: {
          event_type: "entity_key_selected",
          project_id: projectData.id,
          status: "success",
          metadata: {
            entity_key: entityKey,
            schema_source: schemaSSOT.source,
            schema_columns_count: schemaSSOT.schema_columns_count,
            detected_columns_count: schemaSSOT.detected_columns_count ?? null,
          },
        },
      }).catch(() => {});

      appendContext("targeting", {
        selected_problem: problemType || "",
        selected_target: targetColumn,
        entity_key: entityKey,
        recommended_features: cleanFeatures,
        excluded_features: excludedColumns,
        justification: inference?.suggested_targets.find((t) => t.column === targetColumn)?.why_this_target || "Configuração manual pelo usuário.",
        suggested_problems: inference?.suggested_problem_labels.map((l) => l.label) || [],
      }).catch((err) =>
        console.error("Failed to persist targeting AI context:", err)
      );

      toast({
        title: t("lysSuggestions.settingsSaved", "Configuração salva!"),
        description: t("lysSuggestions.settingsSavedDesc", "Target, features e configurações foram persistidos."),
      });

      // Reload SSOT + selection version after save
      await Promise.all([loadSelectionVersion(), loadSSOT()]);
      onSSOTChanged?.();

      return true;
    }
    return false;
  };

  const handleNext = async () => {
    if (targetColumn) {
      await handleSaveSettings();

      const updateData: Partial<ProjectData> = {
        target_column: targetColumn,
      };
      if (inferredProblemType) {
        updateData.problem_type = inferredProblemType as "classification" | "regression";
      }

      await saveProject(updateData, 5);
    } else {
      onNext();
    }
  };

  const availableFeatures = columns.filter((col) => col.name !== targetColumn);
  const effectiveProblemType = inferredProblemType || projectData.problem_type;

  // ── Gating logic (uses SSOT) ──
  const isHardBlocked = ds.loaded && !ds.edaReady;
  const hasModelWarning = ds.loaded && ds.edaReady && !ds.modelReady;

  if (loadingColumns) {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="flex flex-col items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
          <p className="text-muted-foreground">{t("stepVariables.loadingColumns")}</p>
        </div>
      </Card>
    );
  }

  if (columns.length === 0) {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="text-center py-8">
          <div className="w-16 h-16 bg-destructive/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Target className="w-8 h-8 text-destructive" />
          </div>
          <h3 className="text-lg font-semibold mb-2">{t("stepVariables.noColumns")}</h3>
          <p className="text-muted-foreground mb-6">
            {t("stepVariables.noColumnsDesc")}
          </p>
          <Button variant="outline" onClick={onBack}>
            {t("stepVariables.backToData")}
          </Button>
        </div>
      </Card>
    );
  }

  // Hard block screen
  if (isHardBlocked) {
    const reason = ds.fallback?.blockedReasonEda || ds.fallback?.blockedReasonModel || "O dataset importado possui problemas estruturais que impedem a configuração de variáveis.";
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="text-center py-12 space-y-4">
          <Ban className="w-12 h-12 text-destructive/50 mx-auto" />
          <h2 className="text-xl font-display font-bold text-destructive">Dataset não está pronto para modelagem</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">{reason}</p>
          <p className="text-xs text-muted-foreground">
            Volte à Etapa 2 (Importação) e corrija os problemas indicados no Resumo de Importação.
          </p>
          <div className="pt-4">
            <Button variant="outline" onClick={onBack}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // Preflight checklist items
  const preflightChecks = [
    { label: "Dataset ativo", ok: ds.hasManifest, detail: ds.isVirtual ? "virtual manifest" : ds.fallback?.manifestId ? "manifest real" : "Sem manifest" },
    { label: "Linhas consolidadas > 0", ok: ds.rowCount > 0, detail: `${ds.rowCount.toLocaleString()} linhas` },
    { label: "Colunas detectadas > 0", ok: columns.length > 0, detail: `${columns.length} colunas` },
    { label: "Target definido", ok: !!targetColumn, detail: targetColumn || "—" },
    { label: "Entity Key definida", ok: !!entityKey, detail: entityKey || "—" },
    { label: "Features selecionadas", ok: selectedFeatures.filter(f => f !== targetColumn).length > 0, detail: `${selectedFeatures.filter(f => f !== targetColumn).length} features` },
    { label: "EDA pronto", ok: ds.edaReady, detail: ds.edaReady ? "OK" : "BLOCKED" },
    { label: "Modelo pronto", ok: ds.modelReady, detail: ds.modelReady ? "OK" : (ds.fallback?.blockedReasonModel || "BLOCKED") },
  ];

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Target className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("stepVariables.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("stepVariables.subtitle")}
          </p>
        </div>

        {/* Coverage Report Banner */}
        {ds.loaded && ds.rowCount > 0 && (
          <div className={`p-4 rounded-lg border space-y-3 ${
            hasModelWarning
              ? "bg-amber-500/5 border-amber-500/30"
              : "bg-primary/5 border-primary/20"
          }`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <Database className={`w-5 h-5 ${hasModelWarning ? "text-amber-500" : "text-primary"}`} />
                <div>
                  <p className="text-sm font-semibold">
                    Coverage do Consolidado
                    {ds.isVirtual && <Badge variant="outline" className="ml-2 text-[10px]">virtual</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ds.rowCount.toLocaleString()} linhas • {ds.colCount} colunas
                    {!ds.isVirtual && ds.fallback?.totalFiles ? ` • ${ds.fallback.totalFiles} arquivo(s)` : ""}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {ds.edaReady ? (
                  <Badge className="bg-accent/20 text-accent border-accent/30">EDA: OK</Badge>
                ) : (
                  <Badge variant="destructive">EDA: BLOCKED</Badge>
                )}
                {ds.modelReady ? (
                  <Badge className="bg-accent/20 text-accent border-accent/30">MODEL: OK</Badge>
                ) : (
                  <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">
                    <AlertTriangle className="w-3 h-3 mr-1" />
                    MODEL: WARN
                  </Badge>
                )}
              </div>
            </div>

            {/* Coverage stats */}
            {coverageStats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2 bg-muted/30 rounded text-center">
                  <p className={`text-lg font-bold ${coverageStats.critical_columns_pct > 30 ? "text-destructive" : coverageStats.critical_columns_pct > 10 ? "text-amber-500" : ""}`}>
                    {coverageStats.critical_columns_pct}%
                  </p>
                  <p className="text-[10px] text-muted-foreground">Colunas 🔴 (&gt;50% NULL)</p>
                </div>
                <div className="p-2 bg-muted/30 rounded text-center">
                  <p className={`text-lg font-bold ${coverageStats.global_null_pct > 30 ? "text-destructive" : coverageStats.global_null_pct > 15 ? "text-amber-500" : ""}`}>
                    {coverageStats.global_null_pct}%
                  </p>
                  <p className="text-[10px] text-muted-foreground">Nulos global</p>
                </div>
                <div className="p-2 bg-muted/30 rounded text-center col-span-2">
                  <div className="flex flex-wrap gap-1 justify-center">
                    {coverageStats.file_contribution.map((fc, i) => (
                      <Badge key={i} variant={fc.contribution_type === "data" ? "default" : "outline"} className="text-[10px]">
                        {fc.file.length > 15 ? fc.file.slice(0, 15) + "…" : fc.file}
                        {fc.contribution_type === "mostly_null" && " ⚠️"}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Contribuição por arquivo</p>
                </div>
              </div>
            )}

            {/* Model warning */}
            {hasModelWarning && ds.fallback?.blockedReasonModel && (
              <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/5 p-2 rounded border border-amber-500/20">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  <strong>Atenção:</strong> {ds.fallback.blockedReasonModel}
                  {" "}Você pode configurar target e features, mas o treino pode ser bloqueado até os dados serem corrigidos.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Schema SSOT divergence info */}
        {schemaSSOT.loaded && schemaSSOT.schema_columns_count > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs gap-1">
              <Database className="w-3 h-3" />
              Colunas (schema): {schemaSSOT.schema_columns_count}
            </Badge>
            {schemaSSOT.detected_columns_count != null && schemaSSOT.detected_columns_count !== schemaSSOT.schema_columns_count && (
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-xs gap-1 cursor-help">
                      <AlertTriangle className="w-3 h-3" />
                      Amostra: {schemaSSOT.detected_columns_count} colunas
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">A amostra é parcial (arquivo particionado). O treino usa o schema consolidado com {schemaSSOT.schema_columns_count} colunas.</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {schemaSSOT.source !== "active_schema_json" && (
              <Badge variant="outline" className="text-xs text-amber-600 border-amber-500/30 gap-1">
                <AlertTriangle className="w-3 h-3" />
                Schema obtido por fallback: {schemaSSOT.source}
              </Badge>
            )}
          </div>
        )}

        {/* ═══ Unified Strategy Panel ═══ */}
        {projectData.id && (
          <div id="target-builder-panel">
            <TargetStrategyPanel
              projectId={projectData.id}
              industry={intentInfo.industry}
              onBuilderReady={(builderId, templateId, templateParams) => {
                setLabelBuilderId(builderId);
                setLabelTemplateId(templateId);
                setTargetColumn("label");
                setTargetSource("label_builder");
                setSelectedTemplateId(templateId);
                setAppliedTargetColumn("label");
                const tmpl = LABEL_TEMPLATES[templateId];
                setInferredProblemType(tmpl?.problem_type || "classification");
                // Auto-populate features: all valid columns except label + structural
                autoPopulateFeatures("label");
                setPreflightRefreshKey(k => k + 1);
                // Persist target_source to SSOT
                persistTargetSourceToSSOT("label_builder", templateId);
              }}
            />
          </div>
        )}

        {/* Weak Supervision / Assisted Mode (Etapa E) */}
        {projectData.id && (
          <WeakLabelBuilderCard
            projectId={projectData.id}
            onActivated={() => {
              setTargetColumn("label");
              setTargetSource("weak_supervision");
              setSelectedTemplateId("weak_supervision_assisted");
              setAppliedTargetColumn("label");
              setInferredProblemType("classification");
              // Auto-populate features
              autoPopulateFeatures("label");
              setPreflightRefreshKey(k => k + 1);
              // Persist target_source to SSOT
              persistTargetSourceToSSOT("weak_supervision", "weak_supervision_assisted");
            }}
          />
        )}

        {/* Human Labeling Card (Etapa F) */}
        {projectData.id && (
          <HumanLabelingCard
            projectId={projectData.id}
            onActivated={() => {
              setTargetColumn("label");
              setTargetSource("human_labeling");
              setSelectedTemplateId("human_labeling_assisted");
              setAppliedTargetColumn("label");
              setInferredProblemType("classification");
              // Auto-populate features
              autoPopulateFeatures("label");
              setPreflightRefreshKey(k => k + 1);
              // Persist target_source to SSOT
              persistTargetSourceToSSOT("human_labeling", "human_labeling_assisted");
            }}
          />
        )}

        {/* Column Inference Matrix (collapsible) */}
        {projectData.id && (
          <ColumnInferenceMatrix
            projectId={projectData.id}
            onDataLoaded={(data) => {
              setColumnInference(data);
              const map = new Map<string, ColumnInferenceRow>();
              data.forEach((d) => map.set(d.column_name, d));
              columnInferenceMap.current = map;
            }}
          />
        )}

        {/* Blocked target candidates */}
        {columnInference.length > 0 && (
          <BlockedTargetCandidates columnInference={columnInference} />
        )}

        {/* Inferred problem type badge */}
        {inferredProblemType && (
          <div className="flex items-center gap-2 p-3 bg-accent/10 border border-accent/20 rounded-lg">
            <Info className="w-4 h-4 text-accent" />
            <span className="text-sm">
              {t("inference.inferredType", "Tipo detectado pela Lys")}:{" "}
              <strong>
                {inferredProblemType === "classification"
                  ? t("project.classification", "Classificação")
                  : t("project.regression", "Regressão")}
              </strong>
            </span>
          </div>
        )}

        {/* Regression / categorical target mismatch warning */}
        {inferredProblemType === "regression" && targetColumn && (() => {
          const colInfo = columns.find(c => c.name === targetColumn);
          const colInf = columnInferenceMap.current.get(targetColumn);
          const isCategorical = colInfo?.type === "categórico" || colInfo?.type === "text" || colInf?.inferred_type === "categorical";
          const isBinary = colInf && colInf.semantic_role?.includes("EVENTO");
          if (isCategorical || isBinary) {
            return (
              <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">Tipo de problema incompatível</p>
                  <p className="text-muted-foreground">
                    O alvo "<strong>{targetColumn}</strong>" parece ser categórico/binário, mas o tipo selecionado é Regressão.
                    Considere trocar para <strong>Classificação</strong> ou escolher um alvo numérico contínuo.
                  </p>
                </div>
              </div>
            );
          }
          return null;
        })()}

        {/* Target Quality Card */}
        {projectData.id && targetColumn && appliedTargetColumn && (
          <div id="target-quality-card">
          <TargetQualityCard
            projectId={projectData.id}
            refreshKey={preflightRefreshKey}
          />
          </div>
        )}

        {/* Target Lifecycle Card (Etapa G) */}
        {projectData.id && targetColumn && appliedTargetColumn && (
          <TargetLifecycleCard
            projectId={projectData.id}
            refreshKey={preflightRefreshKey}
          />
        )}

        {/* Target source badge */}
        {targetSource === "label_builder" && targetColumn === "label" && (
          <div className="flex items-center gap-2 p-3 bg-accent/10 border border-accent/20 rounded-lg">
            <Sparkles className="w-4 h-4 text-accent" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] mr-2">Alvo gerado automaticamente</Badge>
                <strong>label</strong>
              </p>
              {selectedTemplateId && LABEL_TEMPLATES[selectedTemplateId] && (
                <p className="text-xs text-muted-foreground">
                  Forma: {LABEL_TEMPLATES[selectedTemplateId].display_name}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={() => {
                setTargetSource("manual");
                setTargetColumn("");
                setAppliedTargetColumn(null);
              }}
            >
              Trocar para manual
            </Button>
          </div>
        )}
        {targetSource === "weak_supervision" && targetColumn === "label" && (
          <div className="flex items-center gap-2 p-3 bg-secondary/10 border border-secondary/20 rounded-lg">
            <Sparkles className="w-4 h-4 text-secondary" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                <Badge className="bg-secondary/20 text-secondary border-secondary/30 text-[10px] mr-2">Alvo assistido por regras</Badge>
                <strong>label</strong>
              </p>
            </div>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { setTargetSource("manual"); setTargetColumn(""); setAppliedTargetColumn(null); }}>
              Trocar para manual
            </Button>
          </div>
        )}
        {targetSource === "human_labeling" && targetColumn === "label" && (
          <div className="flex items-center gap-2 p-3 bg-primary/10 border border-primary/20 rounded-lg">
            <Sparkles className="w-4 h-4 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px] mr-2">Alvo definido manualmente com rotulagem</Badge>
                <strong>label</strong>
              </p>
            </div>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { setTargetSource("manual"); setTargetColumn(""); setAppliedTargetColumn(null); }}>
              Trocar para manual
            </Button>
          </div>
        )}

        {/* Target selection */}
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
            <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-primary mb-1">{t("stepVariables.whatIsTarget")}</p>
              <p className="text-muted-foreground">
                {t("stepVariables.whatIsTargetDesc")}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              {t("stepVariables.targetVariable")}
            </Label>
            <Select value={targetColumn} onValueChange={handleTargetChange}>
              <SelectTrigger className="bg-background">
                <SelectValue placeholder={t("stepVariables.selectTarget")} />
              </SelectTrigger>
              <SelectContent className="bg-popover border border-border shadow-lg z-50">
                {/* Virtual "label" option for label builder */}
                {(targetSource === "label_builder" || labelBuilderId) && (
                  <SelectItem value="label">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">label</span>
                      <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] py-0">
                        Target gerado automaticamente
                      </Badge>
                    </div>
                  </SelectItem>
                )}
                {columns.map((col) => {
                  const inf = columnInferenceMap.current.get(col.name);
                  const isBlocked = inf && !inf.can_be_target && inf.block_reasons.length > 0;
                  const roleBadge = inf?.semantic_role;
                  const ROLE_SHORT: Record<string, string> = {
                    ID_TECNICO: "ID", TEMPO: "TEMPO", DIMENSAO_NEGOCIO: "DIM",
                    MEDIDA_NUMERICA: "NUM", CATEGORICA: "CAT", TEXTO: "TXT",
                    TARGET_CANDIDATO_EVENTO: "EVENTO", TARGET_CANDIDATO_ESTADO: "ESTADO",
                    DERIVADA_LEAKAGE: "LEAKAGE", DESCONHECIDO: "?",
                  };

                  return (
                    <SelectItem key={col.name} value={col.name} disabled={isBlocked}>
                      <div className="flex items-center gap-2">
                        <span className={`font-medium ${isBlocked ? "text-muted-foreground line-through" : ""}`}>
                          {col.name}
                        </span>
                        <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">
                          {col.type}
                        </span>
                        {col.isFeature && (
                          <Badge variant="secondary" className="text-[10px] py-0">
                            {col.featureLabel?.includes("materializado") ? "derivado ✓" : "derivado"}
                          </Badge>
                        )}
                        {roleBadge && ROLE_SHORT[roleBadge] && (
                          <Badge
                            variant={roleBadge === "DERIVADA_LEAKAGE" ? "destructive" : "outline"}
                            className="text-xs py-0"
                          >
                            {ROLE_SHORT[roleBadge]}
                          </Badge>
                        )}
                        {isBlocked && (
                          <TooltipProvider delayDuration={100}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Ban className="w-3 h-3 text-destructive" />
                              </TooltipTrigger>
                              <TooltipContent side="right" className="max-w-xs">
                                {inf.block_reasons.map((r, i) => (
                                  <p key={i} className="text-xs">• {r}</p>
                                ))}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {effectiveProblemType === "classification"
                ? t("stepVariables.classificationHint")
                : t("stepVariables.regressionHint")}
            </p>
          </div>
        </div>

        {/* Entity Key selection (mandatory) */}
        <div className="space-y-2">
          <Label className="text-base font-medium flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-secondary" />
            Entity Key (chave da entidade)
            <Badge variant="destructive" className="text-[10px] py-0">obrigatório</Badge>
          </Label>
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="text-sm text-muted-foreground cursor-help inline-flex items-center gap-1">
                  <Info className="w-3 h-3" />
                  Coluna que identifica unicamente a entidade (ex: id_cliente, cpf, email).
                </p>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="text-xs">EntityKey é usada para agrupar previsões por entidade e garantir split correto. Deve ser uma coluna com alta cardinalidade (muitos valores únicos).</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Select value={entityKey} onValueChange={setEntityKey}>
            <SelectTrigger className={`bg-background ${!entityKey ? "border-destructive/50" : ""}`}>
              <SelectValue placeholder="Selecione a coluna de entidade..." />
            </SelectTrigger>
            <SelectContent className="bg-popover border border-border shadow-lg z-50">
              {columns.map((col) => {
                const inf = columnInferenceMap.current.get(col.name);
                const isId = inf?.semantic_role === "ID_TECNICO";
                const notInSample = schemaSSOT.detected_columns_count != null &&
                  schemaSSOT.detected_columns_count < schemaSSOT.schema_columns_count &&
                  !columns.slice(0, schemaSSOT.detected_columns_count).some(c => c.name === col.name);
                return (
                  <SelectItem key={col.name} value={col.name}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{col.name}</span>
                      <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">{col.type}</span>
                      {isId && <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] py-0">ID</Badge>}
                      {notInSample && (
                        <Badge variant="outline" className="text-[10px] py-0">só no schema</Badge>
                      )}
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {!entityKey && targetColumn && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Selecione a Entity Key para poder avançar.
            </p>
          )}
        </div>

        {/* Target Presence Scan */}
        {projectData.id && targetColumn && (
          <TargetPresenceScan projectId={projectData.id} targetColumn={targetColumn} targetSource={targetSource} />
        )}

        {/* Features selection */}
        <div className="space-y-4">
          <Label className="text-base font-medium flex items-center gap-2">
            <Layers className="w-4 h-4 text-secondary" />
            {t("stepVariables.features")}
          </Label>
          <p className="text-sm text-muted-foreground">
            {t("stepVariables.featuresDesc")}
          </p>

          <div className="bg-muted/30 rounded-xl p-4 space-y-3 max-h-64 overflow-y-auto">
            {availableFeatures.length > 0 ? (
              <>
                {/* Original columns first */}
                {availableFeatures.filter(col => !col.isFeature).map((col) => {
                  const inf = columnInferenceMap.current.get(col.name);
                  const isBlockedFeature = inf && !inf.can_be_feature && inf.block_reasons.length > 0;
                  const ROLE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
                    ID_TECNICO: { label: "ID", variant: "outline" },
                    DERIVADA_LEAKAGE: { label: "LEAKAGE", variant: "destructive" },
                    TARGET_CANDIDATO_EVENTO: { label: "EVENTO", variant: "secondary" },
                    TARGET_CANDIDATO_ESTADO: { label: "ESTADO", variant: "secondary" },
                    TEMPO: { label: "TEMPO", variant: "outline" },
                  };
                  const badge = inf ? ROLE_BADGE[inf.semantic_role] : undefined;

                  return (
                    <div
                      key={col.name}
                      className={`flex items-center justify-between p-3 rounded-lg transition-colors ${
                        isBlockedFeature
                          ? "bg-destructive/5 border border-destructive/20"
                          : "bg-background hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Checkbox
                          id={col.name}
                          checked={selectedFeatures.includes(col.name)}
                          onCheckedChange={() => toggleFeature(col.name)}
                          disabled={isBlockedFeature}
                        />
                        <label
                          htmlFor={col.name}
                          className={`font-medium cursor-pointer ${isBlockedFeature ? "text-muted-foreground line-through" : ""}`}
                        >
                          {col.name}
                        </label>
                        {badge && (
                          <Badge variant={badge.variant} className="text-xs py-0">
                            {badge.label}
                          </Badge>
                        )}
                        {inf?.temporal_role === "POS_EVENTO" && (
                          <Badge variant="destructive" className="text-xs py-0">PÓS-EVENTO</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                          {col.type}
                        </span>
                        {isBlockedFeature && inf && (
                          <TooltipProvider delayDuration={100}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="w-3.5 h-3.5 text-destructive cursor-help" />
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-xs">
                                {inf.block_reasons.map((r, i) => (
                                  <p key={i} className="text-xs">• {r}</p>
                                ))}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Engineered features section */}
                {availableFeatures.filter(col => col.isFeature).length > 0 && (
                  <>
                    <div className="flex items-center gap-2 pt-2 pb-1 px-1">
                      <Sparkles className="w-4 h-4 text-secondary" />
                      <span className="text-sm font-medium text-secondary">
                        {t("stepVariables.engineeredFeatures", "Features criadas")}
                      </span>
                    </div>
                    {availableFeatures.filter(col => col.isFeature).map((col) => (
                      <div
                        key={col.name}
                        className={`flex items-center justify-between p-3 rounded-lg transition-colors ${
                          col.featureHasError
                            ? "bg-destructive/10 border border-destructive/30"
                            : "bg-secondary/5 border border-secondary/20 hover:bg-secondary/10"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <Checkbox
                            id={col.name}
                            checked={selectedFeatures.includes(col.name)}
                            onCheckedChange={() => toggleFeature(col.name)}
                            disabled={col.featureHasError}
                          />
                          <div className="flex flex-col">
                            <label
                              htmlFor={col.name}
                              className={`font-medium cursor-pointer ${col.featureHasError ? "text-muted-foreground" : ""}`}
                            >
                              {col.featureLabel || col.name}
                            </label>
                            <span className="text-xs text-muted-foreground font-mono">
                              {col.name}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {col.featureHasError ? (
                            <Badge variant="destructive" className="text-xs">
                              <AlertCircle className="w-3 h-3 mr-1" />
                              {t("stepVariables.featureError", "Erro")}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">
                              <Sparkles className="w-3 h-3 mr-1" />
                              {t("stepVariables.createdFeature", "Feature")}
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            ) : (
              <p className="text-center text-muted-foreground py-4">
                {t("stepVariables.selectTargetFirst")}
              </p>
            )}
          </div>

          {/* Excluded features collapsible */}
          {excludedColumns.length > 0 && (
            <ExcludedFeaturesList excludedColumns={excludedColumns} />
          )}

          {selectedFeatures.length > 0 && (
            <p className="text-sm text-accent">
              {t("stepVariables.selectedCount", { count: selectedFeatures.length })}
            </p>
          )}
        </div>

        {/* Selection Version Badge */}
        {selectionVersion !== null && (
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg text-xs text-muted-foreground">
            <Save className="w-3.5 h-3.5" />
            <span>Seleção <strong>v{selectionVersion}</strong> salva</span>
          </div>
        )}

        {/* Builder Version Mismatch Banner */}
        {selectionVersion !== null && builderVersionUsed !== null && selectionVersion !== builderVersionUsed && (
          <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/5 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              <p className="text-sm font-semibold text-destructive">
                Builder desatualizado (built v{builderVersionUsed}, current v{selectionVersion})
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              A seleção de target/features mudou desde o último build. Regere o Dataset Modelável abaixo para poder treinar.
            </p>
          </div>
        )}

        {/* Split & Leakage Guard Panel */}
        {projectData.id && targetColumn && (
          <SplitAndLeakagePanel projectId={projectData.id} />
        )}

        {/* === Dataset Modelável Section === */}
        <ModelingDatasetSection
          projectId={projectData.id}
          targetColumn={targetColumn}
          onSaveBeforeBuild={handleSaveSettings}
          onBuildComplete={async () => {
            // Full cache bust: reload SSOT, selection version, builder version, THEN bump preflight
            await Promise.all([
              ds.load(),
              loadSelectionVersion(),
              loadBuilderVersion(),
              loadSSOT(),
            ]);
            onSSOTChanged?.();
            // Bump preflight AFTER fresh data is loaded
            setPreflightRefreshKey(k => k + 1);
          }}
        />

        {/* === Training Preflight Panel === */}
        <TrainingPreflightPanel projectId={projectData.id} onNavigateBack={onBack} refreshKey={preflightRefreshKey} />

        {/* Preflight Checklist */}
        {targetColumn && (
          <div className="p-4 rounded-lg border border-border bg-muted/10 space-y-2">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-primary" />
              Checklist Técnico — Pré-modelagem
            </h4>
            <div className="grid gap-1">
              {preflightChecks.map((check, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-1">
                  <div className="flex items-center gap-2">
                    {check.ok ? (
                      <CheckCircle className="w-3.5 h-3.5 text-accent" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-destructive" />
                    )}
                    <span className={check.ok ? "" : "text-destructive"}>{check.label}</span>
                  </div>
                  <span className="text-muted-foreground font-mono truncate max-w-[200px]">{check.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Audit Contract Panel */}
        {targetColumn && selectionVersion && (
          <AuditContractPanel
            projectId={projectData.id}
            selectionVersion={selectionVersion}
          />
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            {t("common.back")}
          </Button>
          <div className="flex gap-2">
            {targetColumn && (
              <Button
                variant="outline"
                onClick={handleSaveSettings}
                disabled={loading || !targetColumn || !entityKey}
              >
                <Save className="w-4 h-4 mr-1.5" />
                {t("common.save")}
              </Button>
            )}
            <Button
              onClick={handleNext}
              disabled={loading || !targetColumn || !entityKey}
              className="bg-gradient-primary hover:shadow-hover transition-all"
            >
              {loading ? t("common.loading") : t("common.next")}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default StepTargetFeatures;
