import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Target, Layers, Info, Loader2, Sparkles, AlertCircle, Save, AlertTriangle, Ban, Database, CheckCircle, XCircle, KeyRound, Settings2 } from "lucide-react";
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
import PipelineStateDebugPanel from "./PipelineStateDebugPanel";

import TargetStrategyPanel from "./TargetStrategyPanel";
import SplitAndLeakagePanel from "./SplitAndLeakagePanel";
import AuditContractPanel from "./AuditContractPanel";
import IntentTargetSummary from "./IntentTargetSummary";
import type { TargetCandidateResolved } from "@/hooks/useIntentDrivenTarget";
import TargetQualityCard from "./TargetQualityCard";
import WeakLabelBuilderCard from "./WeakLabelBuilderCard";
import HumanLabelingCard from "./HumanLabelingCard";
import TargetLifecycleCard from "./TargetLifecycleCard";
import TargetBusinessContext from "./TargetBusinessContext";
import TargetExpertPanel from "./TargetExpertPanel";
import TargetTrainingReadiness from "./TargetTrainingReadiness";
import TargetLysSuggestion from "./TargetLysSuggestion";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useProjectAIContext } from "@/hooks/useProjectAIContext";
import { useProblemInference } from "@/hooks/useProblemInference";
import { logProjectAuditEvent } from "@/lib/auditLog";
import { useDatasetState } from "@/hooks/useDatasetState";
import { useTargetFeaturesSSOT } from "@/hooks/useTargetFeaturesSSOT";
import { useProjectSchemaSSOT } from "@/hooks/useProjectSchemaSSOT";
import { trackEvent } from "@/lib/platformTracking";
import type { BusinessIntentContract, ObjectiveKey, IndustryKey } from "@/lib/industryRules";
import { INDUSTRY_OBJECTIVE_MATRIX, buildBusinessIntentContract } from "@/lib/industryRules";
import BusinessGuidancePanel, { type TargetSuggestionCard } from "../shared/BusinessGuidancePanel";
import { useLysSynthesis, type LysRecommendation } from "@/hooks/useLysSynthesis";

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

  // Lys synthesis — structured recommendations from EDA + TDE + Intent
  const lysSynthesis = useLysSynthesis(projectData.id);
  const lysAppliedRef = useRef(false);

  // Unified modeling state from backend
  const [modelingState, setModelingState] = useState<{
    eda: { status: string };
    project: { business_objective: string | null; detected_problem_type: string | null };
    active_dataset: { id: string; total_rows: number; columns_count: number } | null;
    schema: { columns: { name: string; type: string | null }[]; source: string };
  } | null>(null);

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

  // ═══ Business Intent Contract (from SSOT) ═══
  const [businessContract, setBusinessContract] = useState<BusinessIntentContract | null>(null);
  const [businessObjective, setBusinessObjective] = useState<string | null>(null);
  const [businessIndustry, setBusinessIndustry] = useState<string | null>(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [contractMissing, setContractMissing] = useState(false);
  const [leakageWarning, setLeakageWarning] = useState<string | null>(null);
  const [leakageBlock, setLeakageBlock] = useState<string | null>(null);
  const isSegmentation = businessContract?.problem_type_default === "clustering" || businessObjective === "segmentation";

  // State→Event conversion panel
  const [showStateToEvent, setShowStateToEvent] = useState(false);
  const [stateToEventCol, setStateToEventCol] = useState<string | null>(null);

  // Blocked target (ID) modal
  const [blockedIdTarget, setBlockedIdTarget] = useState<string | null>(null);

  // Load business intent contract from SSOT
  const loadBusinessContract = useCallback(async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("project_settings")
      .select("business_intent_contract, objective, industry, advanced_mode_enabled")
      .eq("project_id", projectData.id)
      .maybeSingle();
    if (data) {
      const ps = data as any;
      if (ps.business_intent_contract) {
        setBusinessContract(ps.business_intent_contract as BusinessIntentContract);
        setContractMissing(false);
      } else if (ps.industry && ps.objective) {
        // Rebuild from saved industry+objective
        try {
          const contract = buildBusinessIntentContract(ps.industry as IndustryKey, ps.objective as ObjectiveKey);
          setBusinessContract(contract);
          setContractMissing(false);
        } catch {
          setContractMissing(true);
        }
      } else {
        setContractMissing(true);
      }
      setBusinessObjective(ps.objective || null);
      setBusinessIndustry(ps.industry || null);
      setAdvancedMode(ps.advanced_mode_enabled === true);
    } else {
      setContractMissing(true);
    }
  }, [projectData.id]);

  // Leakage check helper
  const looksLikeLeakage = useCallback((colName: string, patterns?: string[]): boolean => {
    const lower = colName.toLowerCase();
    const allPatterns = [
      ...(patterns || []),
      ...(businessContract?.guardrails?.forbid_leakage_patterns || []),
    ];
    return allPatterns.some(p => lower.includes(p.toLowerCase()));
  }, [businessContract]);

  // Hard-block tokens
  const HARD_BLOCK_TOKENS = ["label", "target", "y", "outcome_final", "status_final"];
  const isHardBlockedTarget = useCallback((colName: string): boolean => {
    const lower = colName.toLowerCase().trim();
    return HARD_BLOCK_TOKENS.some(t => lower === t);
  }, []);

  // Check if column looks like an ID (blocked_target_patterns)
  const looksLikeId = useCallback((colName: string): boolean => {
    const lower = colName.toLowerCase().trim();
    const patterns = businessContract?.blocked_target_patterns || [];
    return patterns.some(p => lower === p || lower.startsWith(p + '_') || lower.endsWith('_' + p) || lower === p.replace(/_/g, ''));
  }, [businessContract]);

  // Check if column is a state candidate (state_to_event_candidates)
  const looksLikeState = useCallback((colName: string): boolean => {
    const lower = colName.toLowerCase().trim();
    const candidates = businessContract?.state_to_event_candidates || [];
    return candidates.some(c => lower === c || lower.includes(c));
  }, [businessContract]);

  // Auto-suggest entity key from schema
  const suggestEntityKey = useCallback((): string | null => {
    if (!businessContract || columns.length === 0) return null;
    const patterns = businessContract.entity_key_hint_patterns;
    for (const p of patterns) {
      const match = columns.find(c => c.name.toLowerCase().includes(p.toLowerCase()));
      if (match) return match.name;
    }
    return null;
  }, [businessContract, columns]);

  // Apply a suggestion card — uses ref-stable approach to avoid dependency issues
  const handleApplySuggestionRef = useRef<((card: TargetSuggestionCard) => void) | null>(null);
  handleApplySuggestionRef.current = (card: TargetSuggestionCard) => {
    if (card.action.entityKey) {
      setEntityKey(card.action.entityKey);
    }
    if (card.action.problemType) {
      setInferredProblemType(card.action.problemType);
    }
    if (card.action.mode === "assisted_build") {
      document.getElementById("target-builder-panel")?.scrollIntoView({ behavior: "smooth" });
    } else if (card.action.targetColumn) {
      // Direct set instead of handleTargetChange to avoid guardrail loops
      setTargetColumn(card.action.targetColumn);
      setTargetSource("manual");
      setAppliedTargetColumn(null);
    }
    trackEvent({
      event_type: "project_created",
      project_id: projectData.id,
      metadata: { sub_event: "guided_target_applied", card_id: card.id, card_variant: card.variant, ...card.action },
    });
  };
  const handleApplySuggestion = useCallback((card: TargetSuggestionCard) => {
    handleApplySuggestionRef.current?.(card);
  }, []);

  // Toggle advanced mode + persist
  const handleAdvancedModeToggle = useCallback(async (enabled: boolean) => {
    setAdvancedMode(enabled);
    if (projectData.id) {
      await supabase
        .from("project_settings")
        .upsert(
          { project_id: projectData.id, advanced_mode_enabled: enabled, updated_at: new Date().toISOString() } as any,
          { onConflict: "project_id" }
        );
      trackEvent({
        event_type: "project_created",
        project_id: projectData.id,
        metadata: { sub_event: "advanced_mode_toggled", enabled, objective: businessObjective, industry: businessIndustry },
      });
    }
  }, [projectData.id, businessObjective, businessIndustry]);

  // Auto-repair: ensure active dataset exists before loading columns
  const ensureActiveDataset = useCallback(async () => {
    if (!projectData.id) return;
    try {
      await supabase.functions.invoke("ensure-active-dataset", {
        body: { project_id: projectData.id },
      });
    } catch (e) {
      console.warn("[StepTargetFeatures] ensure-active-dataset failed (non-blocking):", e);
    }
  }, [projectData.id]);

  // Load unified modeling state from backend
  const loadModelingState = useCallback(async () => {
    if (!projectData.id) return;
    try {
      const { data, error } = await supabase.functions.invoke("get-project-modeling-state", {
        body: { project_id: projectData.id },
      });
      if (!error && data?.success) {
        setModelingState(data);
        // Update contract missing based on business_objective from project
        if (data.project?.business_objective) {
          // Has business objective — don't show contract missing just because of missing settings row
          setContractMissing(false);
        }
      }
    } catch (e) {
      console.warn("[StepTargetFeatures] get-project-modeling-state failed (non-blocking):", e);
    }
  }, [projectData.id]);

  useEffect(() => {
    if (projectData.id) {
      // First ensure dataset exists, then load everything
      ensureActiveDataset().then(() => {
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
        loadBusinessContract();
        loadModelingState();
        lysSynthesis.load();
      });
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

  // Coverage stats from fallback — safe access
  const coverageStats = (ds.fallback?.coverageStats ?? null) as CoverageStats | null;

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
      // Hydrate entity key (SSOT first, then auto-suggest from contract)
      if (ssot.entity_key) {
        setEntityKey(ssot.entity_key);
      } else if (!entityKey) {
        const suggested = suggestEntityKey();
        if (suggested) setEntityKey(suggested);
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

  // ═══ Lys synthesis pre-configuration ═══
  // Apply Lys recommendations as defaults ONLY when no SSOT target exists
  useEffect(() => {
    if (lysAppliedRef.current) return;
    if (!lysSynthesis.loaded || !ssotLoaded || columns.length === 0) return;
    if (ssot.target_column || targetColumn) return; // Don't override user selection
    
    const rec = lysSynthesis.recommendation;
    if (!rec?.suggested_target) return;

    // Validate suggested target exists in columns
    const targetExists = columns.some(c => c.name === rec.suggested_target);
    if (!targetExists) return;

    lysAppliedRef.current = true;

    // Pre-fill target
    setTargetColumn(rec.suggested_target!);
    if (rec.suggested_problem_type) {
      setInferredProblemType(rec.suggested_problem_type);
    }

    // Pre-fill entity key
    if (rec.suggested_entity_key && columns.some(c => c.name === rec.suggested_entity_key)) {
      setEntityKey(rec.suggested_entity_key);
    }

    // Pre-fill features (if Lys suggests them and no SSOT features)
    if (rec.suggested_features && rec.suggested_features.length > 0 && ssot.feature_columns.length === 0) {
      const validFeatures = rec.suggested_features.filter(f => columns.some(c => c.name === f));
      if (validFeatures.length > 0) {
        setSelectedFeatures(validFeatures);
      }
    }

    // Pre-fill excluded (blocked features from Lys)
    if (rec.blocked_features && rec.blocked_features.length > 0) {
      const blockedCols = rec.blocked_features.map(f => f.column).filter(c => columns.some(col => col.name === c));
      if (blockedCols.length > 0) {
        setExcludedColumns(prev => [...new Set([...prev, ...blockedCols])]);
      }
    }

    console.log("[StepTargetFeatures] Lys recommendations applied:", {
      target: rec.suggested_target,
      problem_type: rec.suggested_problem_type,
      entity_key: rec.suggested_entity_key,
      features: rec.suggested_features?.length,
      blocked: rec.blocked_features?.length,
    });
  }, [lysSynthesis.loaded, lysSynthesis.recommendation, ssotLoaded, ssot.target_column, columns, targetColumn]);

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

    // ID blocking (PROMPT 11)
    if (looksLikeId(value) && !advancedMode) {
      setBlockedIdTarget(value);
      trackEvent({
        event_type: "project_created",
        project_id: projectData.id,
        metadata: { sub_event: "target_id_blocked", target: value, objective: businessObjective, industry: businessIndustry },
      });
      return; // Don't set
    }
    setBlockedIdTarget(null);

    // Leakage guardrails
    if (isHardBlockedTarget(value) && !advancedMode) {
      setLeakageBlock(`O campo "${value}" parece ser o próprio resultado. Escolha um alvo anterior ao evento.`);
      setLeakageWarning(null);
      trackEvent({
        event_type: "project_created",
        project_id: projectData.id,
        metadata: { sub_event: "target_leakage_blocked", target: value, objective: businessObjective, industry: businessIndustry },
      });
      return;
    }
    setLeakageBlock(null);

    if (looksLikeLeakage(value)) {
      setLeakageWarning(`O campo "${value}" parece ser um 'resultado final' (ex: status final/resultado). Isso costuma gerar um modelo irreal.`);
      trackEvent({
        event_type: "project_created",
        project_id: projectData.id,
        metadata: { sub_event: "target_leakage_warning_shown", target: value, objective: businessObjective, industry: businessIndustry },
      });
    } else {
      setLeakageWarning(null);
    }

    // State→Event detection (PROMPT 11)
    if (looksLikeState(value) && !advancedMode &&
        (businessObjective === "churn" || businessObjective === "propensity" || businessObjective === "anomaly")) {
      setShowStateToEvent(true);
      setStateToEventCol(value);
    } else {
      setShowStateToEvent(false);
      setStateToEventCol(null);
    }

    setTargetColumn(value);
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

  // ── Gating logic ──
  // Use unified modeling state for EDA status. EDA is NOT a gate for variable selection.
  // Only block if dataset truly has 0 rows/cols or columns list is empty (handled below).
  const unifiedEdaOk = modelingState?.eda?.status === "ok" || ds.edaReady;
  const isHardBlocked = false;
  const hasModelWarning = ds.loaded && !unifiedEdaOk && ds.rowCount > 0;

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

  // Preflight checklist items — use unified EDA status
  const preflightChecks = [
    { label: "Dataset ativo", ok: !!(modelingState?.active_dataset || ds.hasManifest), detail: modelingState?.active_dataset ? `dataset ${modelingState.active_dataset.id.slice(0,8)}` : ds.isVirtual ? "virtual manifest" : ds.fallback?.manifestId ? "manifest real" : "Sem manifest" },
    { label: "Linhas consolidadas > 0", ok: ds.rowCount > 0, detail: `${ds.rowCount.toLocaleString()} linhas` },
    { label: "Colunas detectadas > 0", ok: columns.length > 0, detail: `${columns.length} colunas` },
    { label: "Target definido", ok: !!targetColumn, detail: targetColumn || "—" },
    { label: "Entity Key definida", ok: !!entityKey, detail: entityKey || "—" },
    { label: "Features selecionadas", ok: selectedFeatures.filter(f => f !== targetColumn).length > 0, detail: `${selectedFeatures.filter(f => f !== targetColumn).length} features` },
    { label: "EDA pronto", ok: unifiedEdaOk, detail: unifiedEdaOk ? "OK" : (modelingState?.eda?.status === "blocked" ? "Recalcule EDA" : "Pendente") },
    { label: "Modelo pronto", ok: ds.modelReady, detail: ds.modelReady ? "OK" : (ds.fallback?.blockedReasonModel || "BLOCKED") },
  ];

  // Readiness checks for Block 5
  const readinessChecks = [
    { label: "Dataset ativo", ok: !!(modelingState?.active_dataset || ds.hasManifest), detail: modelingState?.active_dataset ? `dataset ok` : ds.isVirtual ? "virtual" : ds.fallback?.manifestId ? "manifest ok" : "Sem manifest" },
    { label: "Linhas consolidadas", ok: ds.rowCount > 0, detail: `${ds.rowCount.toLocaleString()} linhas` },
    { label: "Alvo definido", ok: !!targetColumn, detail: targetColumn || "—" },
    { label: "Entidade definida", ok: !!entityKey, detail: entityKey || "—" },
    { label: "Features selecionadas", ok: selectedFeatures.filter(f => f !== targetColumn).length > 0, detail: `${selectedFeatures.filter(f => f !== targetColumn).length} features` },
    { label: "EDA processado", ok: unifiedEdaOk, detail: unifiedEdaOk ? "OK" : "Pendente" },
  ];

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center mb-4">
          <div className="w-14 h-14 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Target className="w-7 h-7 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-1">
            {t("stepVariables.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            Configure o alvo e as variáveis com base no objetivo do seu projeto.
          </p>
        </div>

        {/* Hidden: load column inference data for target selector enrichment */}
        {projectData.id && !advancedMode && (
          <div className="hidden">
            <ColumnInferenceMatrix
              projectId={projectData.id}
              onDataLoaded={(data) => {
                setColumnInference(data);
                const map = new Map<string, ColumnInferenceRow>();
                data.forEach((d) => map.set(d.column_name, d));
                columnInferenceMap.current = map;
              }}
            />
          </div>
        )}

        {/* ═══ BLOCK 1: Problema de negócio ═══ */}
        <TargetBusinessContext
          contract={businessContract}
          industry={businessIndustry}
          objective={businessObjective}
          problemType={inferredProblemType || effectiveProblemType}
          industryLabel={
            businessContract?.industry === "retail" ? "Varejo" :
            businessContract?.industry === "health" ? "Saúde" :
            businessContract?.industry === "finance" ? "Finanças" :
            businessContract?.industry === "education" ? "Educação" :
            businessContract?.industry === "logistics" ? "Logística" : 
            businessIndustry || "—"
          }
          objectiveLabel={
            businessContract
              ? (INDUSTRY_OBJECTIVE_MATRIX[businessContract.industry]?.objectives.find(
                  o => o.key === businessContract.objective
                )?.label_pt || businessContract.objective)
              : businessObjective || "—"
          }
        />

        {/* Contract missing warning */}
        {contractMissing && !businessContract && !projectData.business_objective && !modelingState?.project?.business_objective && (
          <Alert className="border-amber-500/30 bg-amber-500/5">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <AlertDescription className="text-sm">
              Objetivo de negócio não definido — volte na Etapa 1 e preencha o objetivo para receber orientações de alvo.
            </AlertDescription>
          </Alert>
        )}

        {/* Segmentation mode — no target needed */}
        {isSegmentation && (
          <Alert className="border-primary/30 bg-primary/5">
            <Info className="w-4 h-4 text-primary" />
            <AlertDescription className="text-sm">
              Para <strong>segmentação</strong>, não existe "alvo". O sistema agrupa perfis parecidos automaticamente. Foque na seleção do Entity Key e das features.
            </AlertDescription>
          </Alert>
        )}

        {/* ═══ BLOCK 2: Target sugerido (Intent-Driven) ═══ */}
        {projectData.id && !isSegmentation && (
          <IntentTargetSummary
            projectId={projectData.id}
            currentTarget={targetColumn || null}
            onApplyTarget={(candidate: TargetCandidateResolved) => {
              if (candidate.column) {
                setTargetColumn(candidate.column);
                setTargetSource("manual");
                setAppliedTargetColumn(null);
                if (candidate.problem_type) {
                  setInferredProblemType(candidate.problem_type);
                }
              }
            }}
            onApplyEntityKey={(key: string) => setEntityKey(key)}
            onApplyTimeAnchor={(col: string) => {
              // Persist time anchor to SSOT immediately
              supabase
                .from("project_settings")
                .update({ time_anchor_column: col, updated_at: new Date().toISOString() } as any)
                .eq("project_id", projectData.id)
                .then(({ error }) => {
                  if (error) console.error("[StepTargetFeatures] Failed to persist time_anchor:", error);
                  else {
                    console.log(`[StepTargetFeatures] time_anchor_column persisted: ${col}`);
                    loadSSOT(); // Reload SSOT to reflect new time anchor in UI
                  }
                });
            }}
            onApplyFeatures={(features: string[], blocked: { column: string; reason: string }[]) => {
              if (features.length > 0) {
                const validFeatures = features.filter(f => columns.some(c => c.name === f));
                if (validFeatures.length > 0) setSelectedFeatures(validFeatures);
              }
              if (blocked.length > 0) {
                const blockedCols = blocked.map(b => b.column).filter(c => columns.some(col => col.name === c));
                if (blockedCols.length > 0) setExcludedColumns(prev => [...new Set([...prev, ...blockedCols])]);
              }
            }}
          />
        )}

        {/* Lys suggestion block */}
        <TargetLysSuggestion
          synthesis={lysSynthesis}
          loaded={lysSynthesis.loaded}
        />

        {/* ID blocked alert */}
        {blockedIdTarget && (
          <Alert className="border-destructive/30 bg-destructive/5">
            <Ban className="w-4 h-4 text-destructive" />
            <AlertDescription className="text-sm">
              <strong>Esse campo parece ser um identificador</strong> ("{blockedIdTarget}"). Identificadores não contêm informação preditiva.
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBlockedIdTarget(null)}>
                  Escolher outro alvo
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Leakage warnings */}
        {leakageWarning && (
          <Alert className="border-amber-500/30 bg-amber-500/5">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <AlertDescription className="text-sm text-amber-700 dark:text-amber-400">
              {leakageWarning}
            </AlertDescription>
          </Alert>
        )}
        {leakageBlock && (
          <Alert className="border-destructive/30 bg-destructive/5">
            <Ban className="w-4 h-4 text-destructive" />
            <AlertDescription className="text-sm text-destructive">
              {leakageBlock}
            </AlertDescription>
          </Alert>
        )}

        {/* Target source badge (when using label builder / weak / human) */}
        {targetSource === "label_builder" && targetColumn === "label" && (
          <div className="flex items-center gap-2 p-3 bg-accent/10 border border-accent/20 rounded-lg">
            <Sparkles className="w-4 h-4 text-accent" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] mr-2">Alvo gerado</Badge>
                <strong>label</strong>
              </p>
              {selectedTemplateId && LABEL_TEMPLATES[selectedTemplateId] && (
                <p className="text-xs text-muted-foreground">
                  Forma: {LABEL_TEMPLATES[selectedTemplateId].display_name}
                </p>
              )}
            </div>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { setTargetSource("manual"); setTargetColumn(""); setAppliedTargetColumn(null); }}>
              Trocar
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
              Trocar
            </Button>
          </div>
        )}
        {targetSource === "human_labeling" && targetColumn === "label" && (
          <div className="flex items-center gap-2 p-3 bg-primary/10 border border-primary/20 rounded-lg">
            <Sparkles className="w-4 h-4 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px] mr-2">Alvo por rotulagem</Badge>
                <strong>label</strong>
              </p>
            </div>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { setTargetSource("manual"); setTargetColumn(""); setAppliedTargetColumn(null); }}>
              Trocar
            </Button>
          </div>
        )}

        {/* Target selection (manual) */}
        {targetSource === "manual" && (
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
                {labelBuilderId && (
                  <SelectItem value="label">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">label</span>
                      <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] py-0">gerado</Badge>
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
                          <Badge variant="secondary" className="text-[10px] py-0">derivado</Badge>
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
          </div>
        )}

        {/* State→Event conversion panel */}
        {showStateToEvent && stateToEventCol && (
          <Alert className="border-primary/30 bg-primary/5">
            <AlertTriangle className="w-4 h-4 text-primary" />
            <AlertDescription className="text-sm space-y-2">
              <p>
                <strong>"{stateToEventCol}"</strong> é um campo de estado. Para previsão, o ideal é prever uma <strong>mudança</strong> nesse estado.
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button size="sm" variant="default" className="h-7 text-xs" onClick={async () => {
                  const plan = { type: "state_to_event", base_column: stateToEventCol, window_days: 30, anchor_time_col: businessContract?.time_anchor_candidates?.[0] || null, event_definition: "mudou_status_30d" };
                  setShowStateToEvent(false);
                  if (projectData.id) {
                    await supabase.from("project_settings").update({ derived_target_plan: plan as any } as any).eq("project_id", projectData.id);
                  }
                  document.getElementById("target-builder-panel")?.scrollIntoView({ behavior: "smooth" });
                }}>
                  Criar alvo: mudou em 30 dias
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => setShowStateToEvent(false)}>
                  Usar como está
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* ═══ BLOCK 3: Entity Key e Tempo ═══ */}
        <div className="p-5 rounded-xl border border-border bg-muted/10 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-secondary" />
            <h3 className="text-base font-semibold">Entidade e tempo</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Entity Key */}
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center gap-2">
                Entity Key
                <Badge variant="destructive" className="text-[10px] py-0">obrigatório</Badge>
              </Label>
              <Select value={entityKey} onValueChange={setEntityKey}>
                <SelectTrigger className={`bg-background ${!entityKey ? "border-destructive/50" : ""}`}>
                  <SelectValue placeholder="Selecione a entidade..." />
                </SelectTrigger>
                <SelectContent className="bg-popover border border-border shadow-lg z-50">
                  {columns.map((col) => {
                    const inf = columnInferenceMap.current.get(col.name);
                    const isId = inf?.semantic_role === "ID_TECNICO";
                    return (
                      <SelectItem key={col.name} value={col.name}>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{col.name}</span>
                          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">{col.type}</span>
                          {isId && <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] py-0">ID</Badge>}
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

            {/* Time Anchor (info only) */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Coluna temporal</Label>
              <div className="p-3 bg-background rounded-lg border border-border/50 text-sm">
                {ssot.time_anchor_column ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-accent" />
                    <span className="font-medium">{ssot.time_anchor_column}</span>
                  </div>
                ) : contractHints?.time_anchor_column ? (
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Sugerida: {contractHints.time_anchor_column}</span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Não detectada</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ═══ BLOCK 4: Variáveis preditoras ═══ */}
        <div className="space-y-4">
          <Label className="text-base font-medium flex items-center gap-2">
            <Layers className="w-4 h-4 text-secondary" />
            Variáveis preditoras
          </Label>
          <p className="text-sm text-muted-foreground">
            {t("stepVariables.featuresDesc")}
          </p>

          <div className="bg-muted/30 rounded-xl p-4 space-y-3 max-h-64 overflow-y-auto">
            {availableFeatures.length > 0 ? (
              <>
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

                {/* Engineered features */}
                {availableFeatures.filter(col => col.isFeature).length > 0 && (
                  <>
                    <div className="flex items-center gap-2 pt-2 pb-1 px-1">
                      <Sparkles className="w-4 h-4 text-secondary" />
                      <span className="text-sm font-medium text-secondary">Features criadas</span>
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
                            <label htmlFor={col.name} className={`font-medium cursor-pointer ${col.featureHasError ? "text-muted-foreground" : ""}`}>
                              {col.featureLabel || col.name}
                            </label>
                            <span className="text-xs text-muted-foreground font-mono">{col.name}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {col.featureHasError ? (
                            <Badge variant="destructive" className="text-xs">Erro</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Feature</Badge>
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

          {excludedColumns.length > 0 && (
            <ExcludedFeaturesList excludedColumns={excludedColumns} />
          )}

          {selectedFeatures.length > 0 && (
            <p className="text-sm text-accent">
              {t("stepVariables.selectedCount", { count: selectedFeatures.length })}
            </p>
          )}
        </div>

        {/* ═══ BLOCK 5: Prontidão do treino ═══ */}
        {targetColumn && (
          <TargetTrainingReadiness checks={readinessChecks} />
        )}

        {/* Target Quality Card (compact) */}
        {projectData.id && targetColumn && appliedTargetColumn && (
          <TargetQualityCard projectId={projectData.id} refreshKey={preflightRefreshKey} />
        )}

        {/* Training Preflight Panel */}
        <TrainingPreflightPanel projectId={projectData.id} onNavigateBack={onBack} refreshKey={preflightRefreshKey} />

        {/* ═══ EXPERT MODE: Technical tools ═══ */}
        <TargetExpertPanel advancedMode={advancedMode}>
          {/* Business Guidance Panel */}
          {businessContract && (
            <BusinessGuidancePanel
              contract={businessContract}
              objectiveLabel={
                INDUSTRY_OBJECTIVE_MATRIX[businessContract.industry]?.objectives.find(
                  o => o.key === businessContract.objective
                )?.label_pt || businessContract.objective
              }
              industryLabel={
                businessContract.industry === "retail" ? "Varejo" :
                businessContract.industry === "health" ? "Saúde" :
                businessContract.industry === "finance" ? "Finanças" :
                businessContract.industry === "education" ? "Educação" :
                businessContract.industry === "logistics" ? "Logística" : "Geral"
              }
              schemaColumns={columns.map(c => c.name)}
              advancedMode={advancedMode}
              onApplySuggestion={handleApplySuggestion}
            />
          )}

          {/* Target Mode Panels */}
          {(() => {
            const allowed = businessContract?.target_modes_allowed;
            const showAll = advancedMode || !allowed || allowed.length === 0;
            const canAssisted = showAll || allowed?.includes("assisted_build");
            const canQuickLabel = showAll || allowed?.includes("quick_label");
            const canManual = showAll || allowed?.includes("manual");

            return (
              <>
                {projectData.id && canAssisted && !isSegmentation && (
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
                        autoPopulateFeatures("label");
                        setPreflightRefreshKey(k => k + 1);
                        persistTargetSourceToSSOT("label_builder", templateId);
                      }}
                    />
                  </div>
                )}

                {projectData.id && canQuickLabel && !isSegmentation && (
                  <WeakLabelBuilderCard
                    projectId={projectData.id}
                    onActivated={() => {
                      setTargetColumn("label");
                      setTargetSource("weak_supervision");
                      setSelectedTemplateId("weak_supervision_assisted");
                      setAppliedTargetColumn("label");
                      setInferredProblemType("classification");
                      autoPopulateFeatures("label");
                      setPreflightRefreshKey(k => k + 1);
                      persistTargetSourceToSSOT("weak_supervision", "weak_supervision_assisted");
                    }}
                  />
                )}

                {projectData.id && canManual && !isSegmentation && (
                  <HumanLabelingCard
                    projectId={projectData.id}
                    onActivated={() => {
                      setTargetColumn("label");
                      setTargetSource("human_labeling");
                      setSelectedTemplateId("human_labeling_assisted");
                      setAppliedTargetColumn("label");
                      setInferredProblemType("classification");
                      autoPopulateFeatures("label");
                      setPreflightRefreshKey(k => k + 1);
                      persistTargetSourceToSSOT("human_labeling", "human_labeling_assisted");
                    }}
                  />
                )}
              </>
            );
          })()}

          {/* Column Inference Matrix */}
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

          {/* Target Presence Scan */}
          {projectData.id && targetColumn && (
            <TargetPresenceScan projectId={projectData.id} targetColumn={targetColumn} targetSource={targetSource} />
          )}

          {/* Target Lifecycle */}
          {projectData.id && targetColumn && appliedTargetColumn && (
            <TargetLifecycleCard projectId={projectData.id} refreshKey={preflightRefreshKey} />
          )}

          {/* Split & Leakage */}
          {projectData.id && targetColumn && (
            <SplitAndLeakagePanel projectId={projectData.id} />
          )}

          {/* Dataset Modelável */}
          <ModelingDatasetSection
            projectId={projectData.id}
            targetColumn={targetColumn}
            onSaveBeforeBuild={handleSaveSettings}
            onBuildComplete={async () => {
              await Promise.all([ds.load(), loadSelectionVersion(), loadBuilderVersion(), loadSSOT()]);
              onSSOTChanged?.();
              setPreflightRefreshKey(k => k + 1);
            }}
          />

          {/* Audit Contract Panel */}
          {targetColumn && selectionVersion && (
            <AuditContractPanel projectId={projectData.id} selectionVersion={selectionVersion} />
          )}

          {/* Coverage stats */}
          {ds.loaded && ds.rowCount > 0 && (
            <div className="p-4 rounded-lg border border-border bg-muted/10 space-y-3">
              <div className="flex items-center gap-3">
                <Database className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-semibold">Coverage do Consolidado</p>
                  <p className="text-xs text-muted-foreground">
                    {ds.rowCount.toLocaleString()} linhas • {ds.colCount} colunas
                  </p>
                </div>
              </div>
              {coverageStats && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 bg-muted/30 rounded text-center">
                    <p className="text-lg font-bold">{coverageStats.critical_columns_pct}%</p>
                    <p className="text-[10px] text-muted-foreground">Colunas críticas</p>
                  </div>
                  <div className="p-2 bg-muted/30 rounded text-center">
                    <p className="text-lg font-bold">{coverageStats.global_null_pct}%</p>
                    <p className="text-[10px] text-muted-foreground">Nulos global</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Selection & Builder Version */}
          {selectionVersion !== null && (
            <div className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg text-xs text-muted-foreground">
              <Save className="w-3.5 h-3.5" />
              <span>Seleção <strong>v{selectionVersion}</strong></span>
            </div>
          )}
          {selectionVersion !== null && builderVersionUsed !== null && selectionVersion !== builderVersionUsed && (
            <Alert className="border-destructive/30 bg-destructive/5">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <AlertDescription className="text-sm">
                Builder desatualizado (v{builderVersionUsed} → v{selectionVersion}). Regere o Dataset Modelável.
              </AlertDescription>
            </Alert>
          )}
        </TargetExpertPanel>

        {/* Advanced Mode Toggle (compact, bottom) */}
        <div className="flex items-center justify-between p-3 bg-muted/20 rounded-lg border border-border/30">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Modo especialista</span>
          </div>
          <Switch checked={advancedMode} onCheckedChange={handleAdvancedModeToggle} />
        </div>

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
