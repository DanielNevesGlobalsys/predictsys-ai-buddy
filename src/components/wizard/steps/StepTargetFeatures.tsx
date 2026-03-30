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
import GrainTimeStrategyPanel from "./GrainTimeStrategyPanel";
import { useGrainTimeResolution } from "@/hooks/useGrainTimeResolution";

import TargetStrategyPanel from "./TargetStrategyPanel";
import SplitAndLeakagePanel from "./SplitAndLeakagePanel";
import AuditContractPanel from "./AuditContractPanel";
import type { TargetCandidateResolved } from "@/hooks/useIntentDrivenTarget";
import TargetQualityCard from "./TargetQualityCard";
import WeakLabelBuilderCard from "./WeakLabelBuilderCard";
import HumanLabelingCard from "./HumanLabelingCard";
import TargetLifecycleCard from "./TargetLifecycleCard";
import TargetExpertPanel from "./TargetExpertPanel";
import TargetTrainingReadiness from "./TargetTrainingReadiness";
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
import { useAutoResolution } from "@/hooks/useAutoResolution";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Brain, Shield, Clock, BarChart3, RefreshCw, Wand2 } from "lucide-react";

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
  const { currentOrganization } = useOrganization();
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [loadingColumns, setLoadingColumns] = useState(true);
  const initialTargetRef = useRef<string | null>(null);
  const hasChangedConfig = useRef(false);

  // ═══ AUTO-RESOLUTION: PRE runs on mount and auto-applies ═══
  const autoRes = useAutoResolution(projectData.id, currentOrganization?.id);
  const autoResAppliedRef = useRef(false);

  // ═══ GRAIN + TIME RESOLUTION ═══
  const grainTime = useGrainTimeResolution(projectData.id);
  const grainTimeRanRef = useRef(false);

  // ═══ SSOT: Single Source of Truth from project_settings ═══
  const { ssot, loaded: ssotLoaded, load: loadSSOT, activeMode, isBuilderReady, isBuilderStale } = useTargetFeaturesSSOT(projectData.id);

  // ── Editable state derived from SSOT ──
  const [targetColumn, setTargetColumn] = useState("");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [excludedColumns, setExcludedColumns] = useState<string[]>([]);
  const [inferredProblemType, setInferredProblemType] = useState<string | null>(null);
  const [targetSource, setTargetSource] = useState<"manual" | "label_builder" | "weak_supervision" | "human_labeling">("manual");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [entityKey, setEntityKey] = useState<string>("");

  // SSOT dataset state
  const ds = useDatasetState(projectData.id);

  // Schema SSOT
  const schemaSSOT = useProjectSchemaSSOT(projectData.id);

  // Lys synthesis
  const lysSynthesis = useLysSynthesis(projectData.id);
  const lysAppliedRef = useRef(false);

  // Unified modeling state
  const [modelingState, setModelingState] = useState<{
    eda: { status: string };
    project: { business_objective: string | null; detected_problem_type: string | null };
    active_dataset: { id: string; total_rows: number; columns_count: number } | null;
    schema: { columns: { name: string; type: string | null }[]; source: string };
  } | null>(null);

  // Builder version tracking
  const [builderVersionUsed, setBuilderVersionUsed] = useState<number | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);

  // Column inference
  const [columnInference, setColumnInference] = useState<ColumnInferenceRow[]>([]);
  const columnInferenceMap = useRef(new Map<string, ColumnInferenceRow>());

  // Misc state
  const [appliedTargetColumn, setAppliedTargetColumn] = useState<string | null>(null);
  const [selectionVersion, setSelectionVersion] = useState<number | null>(null);
  const [hasEDA, setHasEDA] = useState(false);
  const inferenceAutoLoaded = useRef(false);
  const [preflightRefreshKey, setPreflightRefreshKey] = useState(0);

  // Problem inference
  const { inference, loading: inferenceLoading, error: inferenceError, loadInference } = useProblemInference(projectData.id);
  const { settings, loadSettings, saveSettings } = useProjectSettings(projectData.id);
  const { appendContext, loadContext } = useProjectAIContext(projectData.id);

  // Contract hints
  const [contractHints, setContractHints] = useState<{
    entity_key?: string | null;
    time_anchor_column?: string | null;
    event_candidates?: string[];
    value_candidates?: string[];
    status_candidates?: { column: string; score: number; reason?: string }[];
    tde_status_candidates?: { column: string; score: number; reason?: string }[];
    tde_value_candidates?: { column: string; score: number; reason?: string }[];
  } | null>(null);

  const [intentInfo, setIntentInfo] = useState<{
    labelBuilderRequired: boolean;
    recommendedTemplates: { template_id: string; display_name: string; problem_type: string }[];
    industry: string;
  }>({ labelBuilderRequired: false, recommendedTemplates: [], industry: "generic" });

  const [labelBuilderId, setLabelBuilderId] = useState<string | null>(null);
  const [labelTemplateId, setLabelTemplateId] = useState<string | null>(null);

  // Business contract
  const [businessContract, setBusinessContract] = useState<BusinessIntentContract | null>(null);
  const [businessObjective, setBusinessObjective] = useState<string | null>(null);
  const [businessIndustry, setBusinessIndustry] = useState<string | null>(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [contractMissing, setContractMissing] = useState(false);
  const [leakageWarning, setLeakageWarning] = useState<string | null>(null);
  const [leakageBlock, setLeakageBlock] = useState<string | null>(null);
  const isSegmentation = businessContract?.problem_type_default === "clustering" || businessObjective === "segmentation";

  const [showStateToEvent, setShowStateToEvent] = useState(false);
  const [stateToEventCol, setStateToEventCol] = useState<string | null>(null);
  const [blockedIdTarget, setBlockedIdTarget] = useState<string | null>(null);

  // ═══ HELPERS ═══
  const looksLikeLeakage = useCallback((colName: string, patterns?: string[]): boolean => {
    const lower = colName.toLowerCase();
    const allPatterns = [...(patterns || []), ...(businessContract?.guardrails?.forbid_leakage_patterns || [])];
    return allPatterns.some(p => lower.includes(p.toLowerCase()));
  }, [businessContract]);

  const HARD_BLOCK_TOKENS = ["label", "target", "y", "outcome_final", "status_final"];
  const isHardBlockedTarget = useCallback((colName: string): boolean => {
    const lower = colName.toLowerCase().trim();
    return HARD_BLOCK_TOKENS.some(t => lower === t);
  }, []);

  const looksLikeId = useCallback((colName: string): boolean => {
    const lower = colName.toLowerCase().trim();
    const patterns = businessContract?.blocked_target_patterns || [];
    return patterns.some(p => lower === p || lower.startsWith(p + '_') || lower.endsWith('_' + p) || lower === p.replace(/_/g, ''));
  }, [businessContract]);

  const looksLikeState = useCallback((colName: string): boolean => {
    const lower = colName.toLowerCase().trim();
    const candidates = businessContract?.state_to_event_candidates || [];
    return candidates.some(c => lower === c || lower.includes(c));
  }, [businessContract]);

  const suggestEntityKey = useCallback((): string | null => {
    if (!businessContract || columns.length === 0) return null;
    const patterns = businessContract.entity_key_hint_patterns;
    for (const p of patterns) {
      const match = columns.find(c => c.name.toLowerCase().includes(p.toLowerCase()));
      if (match) return match.name;
    }
    return null;
  }, [businessContract, columns]);

  const handleApplySuggestionRef = useRef<((card: TargetSuggestionCard) => void) | null>(null);
  handleApplySuggestionRef.current = (card: TargetSuggestionCard) => {
    if (card.action.entityKey) setEntityKey(card.action.entityKey);
    if (card.action.problemType) setInferredProblemType(card.action.problemType);
    if (card.action.mode === "assisted_build") {
      document.getElementById("target-builder-panel")?.scrollIntoView({ behavior: "smooth" });
    } else if (card.action.targetColumn) {
      setTargetColumn(card.action.targetColumn);
      setTargetSource("manual");
      setAppliedTargetColumn(null);
    }
    trackEvent({ event_type: "project_created", project_id: projectData.id, metadata: { sub_event: "guided_target_applied", card_id: card.id, card_variant: card.variant, ...card.action } });
  };
  const handleApplySuggestion = useCallback((card: TargetSuggestionCard) => { handleApplySuggestionRef.current?.(card); }, []);

  const handleAdvancedModeToggle = useCallback(async (enabled: boolean) => {
    setAdvancedMode(enabled);
    if (projectData.id) {
      await supabase.from("project_settings").upsert({ project_id: projectData.id, advanced_mode_enabled: enabled, updated_at: new Date().toISOString() } as any, { onConflict: "project_id" });
    }
  }, [projectData.id]);

  const ensureActiveDataset = useCallback(async () => {
    if (!projectData.id) return;
    try { await supabase.functions.invoke("ensure-active-dataset", { body: { project_id: projectData.id } }); } catch (e) { /* non-blocking */ }
  }, [projectData.id]);

  const loadModelingState = useCallback(async () => {
    if (!projectData.id) return;
    try {
      const { data, error } = await supabase.functions.invoke("get-project-modeling-state", { body: { project_id: projectData.id } });
      if (!error && data?.success) {
        setModelingState(data);
        if (data.project?.business_objective) setContractMissing(false);
      }
    } catch (e) { /* non-blocking */ }
  }, [projectData.id]);

  const loadBusinessContract = useCallback(async () => {
    if (!projectData.id) return;
    const { data } = await supabase.from("project_settings").select("business_intent_contract, objective, industry, advanced_mode_enabled").eq("project_id", projectData.id).maybeSingle();
    if (data) {
      const ps = data as any;
      if (ps.business_intent_contract) { setBusinessContract(ps.business_intent_contract as BusinessIntentContract); setContractMissing(false); }
      else if (ps.industry && ps.objective) { try { setBusinessContract(buildBusinessIntentContract(ps.industry as IndustryKey, ps.objective as ObjectiveKey)); setContractMissing(false); } catch { setContractMissing(true); } }
      else { setContractMissing(true); }
      setBusinessObjective(ps.objective || null);
      setBusinessIndustry(ps.industry || null);
      setAdvancedMode(ps.advanced_mode_enabled === true);
    } else { setContractMissing(true); }
  }, [projectData.id]);

  // ═══ INITIALIZATION ═══
  useEffect(() => {
    if (projectData.id) {
      ensureActiveDataset().then(() => {
        loadColumns(); checkEDA(); ds.load(); loadSSOT(); schemaSSOT.load();
        loadSelectionVersion(); loadBuilderVersion(); loadContractHints(); loadIntentInfo();
        loadSettings(); loadBusinessContract(); loadModelingState(); lysSynthesis.load();
      });
    }
  }, [projectData.id]);

  const loadIntentInfo = async () => {
    if (!projectData.id) return;
    const [{ data: settingsData }, { data }] = await Promise.all([
      supabase.from("project_settings").select("industry, industry_source").eq("project_id", projectData.id).maybeSingle(),
      supabase.from("project_ai_context").select("context").eq("project_id", projectData.id).maybeSingle(),
    ]);
    let resolvedIndustry: string | null = null;
    if (settingsData) { const ind = (settingsData as any).industry; if (ind) resolvedIndustry = ind; }
    let labelBuilderRequired = false;
    let recommendedTemplates: { template_id: string; display_name: string; problem_type: string }[] = [];
    if (data?.context) {
      const ctx = data.context as Record<string, any>;
      const ic = ctx.intent_contract || ctx.intent || {};
      const ib = ic.intent_base || ic;
      const da = ic.domain_adapter || {};
      labelBuilderRequired = ib.label_builder_required || false;
      recommendedTemplates = da.recommended_templates || [];
      if (!resolvedIndustry && (da.industry || ib.industry_hint)) {
        const candidate = da.industry || ib.industry_hint;
        if (candidate && candidate !== "generic") resolvedIndustry = candidate;
      }
    }
    setIntentInfo({ labelBuilderRequired, recommendedTemplates, industry: resolvedIndustry });
  };

  const loadContractHints = async () => {
    if (!projectData.id) return;
    const [{ data: aiCtxData }, { data: dsStateData }] = await Promise.all([
      supabase.from("project_ai_context").select("context").eq("project_id", projectData.id).maybeSingle(),
      supabase.from("project_dataset_state").select("active_dataset_ref, manifest_id").eq("project_id", projectData.id).maybeSingle(),
    ]);
    if (aiCtxData?.context) {
      const ctx = aiCtxData.context as Record<string, any>;
      if (ctx.contract_hints || ctx.tde_profile) {
        const hints = ctx.contract_hints || {};
        const currentRef = dsStateData?.active_dataset_ref || null;
        const currentManifest = dsStateData?.manifest_id || null;
        const hintsRef = hints.dataset_ref || null;
        const hintsManifest = hints.manifest_id || null;
        const refMatch = !hintsRef || hintsRef === currentRef;
        const manifestMatch = !hintsManifest || hintsManifest === currentManifest;
        const tdeProfile = ctx.tde_profile as Record<string, any> | null;
        const tdeCandidates = tdeProfile?.candidates || {};
        const normalizeCandidate = (c: any) => ({ column: c.column as string, score: Math.min((c.score as number) || 0, 95), reasons: Array.isArray(c.reasons) ? (c.reasons as string[]) : [], reason: Array.isArray(c.reasons) ? (c.reasons as string[]).join("; ") : (c.reason as string | undefined) });
        const tdeStatusCandidates = ((tdeCandidates.status_candidates || []) as any[]).map(normalizeCandidate);
        const tdeValueCandidates = ((tdeCandidates.value_candidates || []) as any[]).map(normalizeCandidate);
        if (refMatch && manifestMatch) {
          setContractHints({ ...hints, tde_status_candidates: tdeStatusCandidates, tde_value_candidates: tdeValueCandidates });
        } else if (tdeStatusCandidates.length > 0 || tdeValueCandidates.length > 0) {
          setContractHints({ tde_status_candidates: tdeStatusCandidates, tde_value_candidates: tdeValueCandidates });
        }
      }
    }
  };

  const loadBuilderVersion = async () => {
    if (!projectData.id) return;
    const { data } = await supabase.from("project_modeling_datasets" as any).select("selection_version_used").eq("project_id", projectData.id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data) setBuilderVersionUsed((data as any).selection_version_used ?? null);
    else setBuilderVersionUsed(null);
  };

  const loadSelectionVersion = async () => {
    if (!projectData.id) return;
    const { data } = await supabase.from("project_model_selection" as any).select("selection_version").eq("project_id", projectData.id).maybeSingle();
    if (data) setSelectionVersion((data as any).selection_version);
  };

  const coverageStats = (ds.fallback?.coverageStats ?? null) as CoverageStats | null;

  // Auto-load inference
  useEffect(() => {
    if (hasEDA && !inferenceAutoLoaded.current && !inference) { inferenceAutoLoaded.current = true; loadInference(false); }
  }, [hasEDA, inference, loadInference]);

  // ═══ SSOT REHYDRATION ═══
  useEffect(() => {
    if (ssotLoaded && columns.length > 0) {
      if (ssot.target_column) {
        const isPhysical = columns.some((c) => c.name === ssot.target_column);
        const isLabel = ssot.target_column === "label";
        if (isPhysical || isLabel) { setTargetColumn(ssot.target_column); setAppliedTargetColumn(ssot.target_column); }
      }
      if (ssot.feature_columns.length > 0) setSelectedFeatures(ssot.feature_columns);
      if (ssot.excluded_columns.length > 0) setExcludedColumns(ssot.excluded_columns);
      if (ssot.problem_type) setInferredProblemType(ssot.problem_type);
      if (ssot.target_source && ssot.target_source !== "manual") setTargetSource(ssot.target_source as any);
      if (ssot.selected_template_id) setSelectedTemplateId(ssot.selected_template_id);
      setSelectionVersion(ssot.selection_version || null);
      if (ssot.entity_key) { setEntityKey(ssot.entity_key); }
      else if (!entityKey) { const suggested = suggestEntityKey(); if (suggested) setEntityKey(suggested); }
      if (ssot.industry) setIntentInfo(prev => ({ ...prev, industry: ssot.industry! }));
    }
  }, [ssotLoaded, ssot, columns]);

  // Fallback from useProjectSettings
  useEffect(() => {
    if (settings && ssotLoaded && columns.length > 0 && !ssot.target_column) {
      if (settings.target_column) {
        const isPhysical = columns.some((c) => c.name === settings.target_column);
        if (isPhysical || settings.target_column === "label") { setTargetColumn(settings.target_column); setAppliedTargetColumn(settings.target_column); }
      }
      if (settings.feature_columns && settings.feature_columns.length > 0) setSelectedFeatures(settings.feature_columns);
      if (settings.excluded_columns) setExcludedColumns(settings.excluded_columns);
      if (settings.problem_type) setInferredProblemType(settings.problem_type);
    }
  }, [settings, ssotLoaded, ssot, columns]);

  // ═══ LYS PRE-CONFIG ═══
  useEffect(() => {
    if (lysAppliedRef.current) return;
    if (!lysSynthesis.loaded || !ssotLoaded || columns.length === 0) return;
    if (ssot.target_column || targetColumn) return;
    const rec = lysSynthesis.recommendation;
    if (!rec?.suggested_target) return;
    const targetExists = columns.some(c => c.name === rec.suggested_target);
    if (!targetExists) return;
    lysAppliedRef.current = true;
    setTargetColumn(rec.suggested_target!);
    if (rec.suggested_problem_type) setInferredProblemType(rec.suggested_problem_type);
    if (rec.suggested_entity_key && columns.some(c => c.name === rec.suggested_entity_key)) setEntityKey(rec.suggested_entity_key);
    if (rec.suggested_features && rec.suggested_features.length > 0 && ssot.feature_columns.length === 0) {
      const validFeatures = rec.suggested_features.filter(f => columns.some(c => c.name === f));
      if (validFeatures.length > 0) setSelectedFeatures(validFeatures);
    }
    if (rec.blocked_features && rec.blocked_features.length > 0) {
      const blockedCols = rec.blocked_features.map(f => f.column).filter(c => columns.some(col => col.name === c));
      if (blockedCols.length > 0) setExcludedColumns(prev => [...new Set([...prev, ...blockedCols])]);
    }
    console.log("[StepTargetFeatures] Lys recommendations applied:", { target: rec.suggested_target, problem_type: rec.suggested_problem_type, entity_key: rec.suggested_entity_key, features: rec.suggested_features?.length, blocked: rec.blocked_features?.length });
  }, [lysSynthesis.loaded, lysSynthesis.recommendation, ssotLoaded, ssot.target_column, columns, targetColumn]);

  // ═══ AUTO-RESOLUTION APPLY ═══
  useEffect(() => {
    if (autoResAppliedRef.current) return;
    if (!autoRes.resolved || autoRes.resolving) return;
    if (columns.length === 0) return;
    if (ssot.target_column || targetColumn) return;
    const r = autoRes.result;
    if (!r.target_column) return;
    const targetExists = columns.some(c => c.name === r.target_column);
    if (!targetExists) return;
    autoResAppliedRef.current = true;

    setTargetColumn(r.target_column);
    if (r.problem_type) setInferredProblemType(r.problem_type);
    if (r.entity_key && columns.some(c => c.name === r.entity_key)) setEntityKey(r.entity_key);
    if (r.selected_features.length > 0) {
      const validFeatures = r.selected_features.filter(f => columns.some(c => c.name === f));
      if (validFeatures.length > 0) setSelectedFeatures(validFeatures);
    }
    if (r.excluded_features.length > 0) {
      const validExcluded = r.excluded_features.filter(f => columns.some(c => c.name === f));
      if (validExcluded.length > 0) setExcludedColumns(prev => [...new Set([...prev, ...validExcluded])]);
    }

    // ATOMIC: persist to project_settings + project_model_selection + trigger builder
    autoRes.applyToSSOT(r);

    console.log("[StepTargetFeatures] Auto-resolution applied:", { target: r.target_column, problem_type: r.problem_type, entity_key: r.entity_key, features: r.selected_features.length, confidence: r.confidence_score });
  }, [autoRes.resolved, autoRes.resolving, autoRes.result, columns, ssot.target_column, targetColumn]);

  // ═══ AUTO-TRIGGER GRAIN+TIME RESOLUTION ═══
  useEffect(() => {
    if (grainTimeRanRef.current) return;
    if (!autoRes.resolved || autoRes.resolving || columns.length === 0) return;
    grainTimeRanRef.current = true;
    grainTime.resolve({
      targetColumn: targetColumn || autoRes.result.target_column || undefined,
      problemType: (inferredProblemType || autoRes.result.problem_type || "classification") as "classification" | "regression",
      entityKey: entityKey || autoRes.result.entity_key || null,
      timeColumn: autoRes.result.time_column || ssot.time_anchor_column || null,
      objective: businessObjective || undefined,
    });
  }, [autoRes.resolved, autoRes.resolving, columns.length, targetColumn, entityKey]);

  useEffect(() => {
    if (projectData.target_column && initialTargetRef.current === null) initialTargetRef.current = projectData.target_column;
  }, [projectData.target_column]);

  // Auto-select all features when no SSOT features
  useEffect(() => {
    if (columns.length > 0 && selectedFeatures.length === 0 && ssotLoaded && ssot.feature_columns.length === 0) {
      const features = columns.filter((c) => c.name !== targetColumn && !c.featureHasError).map((c) => c.name);
      setSelectedFeatures(features);
    }
  }, [columns, targetColumn, ssotLoaded, ssot.feature_columns]);

  const checkEDA = async () => {
    if (!projectData.id) return;
    const { count } = await supabase.from("project_numeric_stats").select("id", { count: "exact", head: true }).eq("project_id", projectData.id);
    setHasEDA((count || 0) > 0);
  };

  const loadColumns = async () => {
    setLoadingColumns(true);
    try {
      const { data: colData } = await supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", projectData.id).order("column_index");
      const { data: featureData } = await supabase.from("project_features").select("name, label, enabled, expression").eq("project_id", projectData.id).eq("enabled", true);
      const cols: ColumnInfo[] = [];
      const seenLower = new Set<string>();
      if (colData && colData.length > 0) {
        for (const col of colData) { seenLower.add(col.column_name.toLowerCase()); cols.push({ name: col.column_name, type: col.inferred_type, isFeature: false }); }
      }
      if (featureData && featureData.length > 0) {
        for (const feature of featureData) {
          if (seenLower.has(feature.name.toLowerCase())) {
            const physIdx = cols.findIndex(c => c.name.toLowerCase() === feature.name.toLowerCase());
            if (physIdx >= 0) { cols[physIdx].isFeature = true; cols[physIdx].featureLabel = feature.label + " (materializado)"; }
            continue;
          }
          const expr = feature.expression as FeatureExpression | null;
          seenLower.add(feature.name.toLowerCase());
          cols.push({ name: feature.name, type: "numérico", isFeature: true, featureLabel: feature.label, featureHasError: !expr || !expr.type });
        }
      }
      if (schemaSSOT.columns.length > 0) {
        for (const sc of schemaSSOT.columns) {
          if (!seenLower.has(sc.name.toLowerCase())) { seenLower.add(sc.name.toLowerCase()); cols.push({ name: sc.name, type: sc.type || "desconhecido", isFeature: false }); }
        }
      }
      setColumns(cols);
      if (projectData.target_column && cols.some((c) => c.name === projectData.target_column)) setTargetColumn(projectData.target_column);
    } catch (err) { console.error("Error loading columns:", err); }
    setLoadingColumns(false);
  };

  // ═══ PERSIST TARGET ═══
  const persistTargetSelection = useCallback(async (col: string, source: "manual" | "label_builder" | "weak_supervision" | "human_labeling" = "manual") => {
    if (!projectData.id || !col) return;
    const mode = sourceToMode(source);
    try {
      // 1. project_settings
      await supabase.from("project_settings").upsert({ project_id: projectData.id, target_column: col, active_target_column: col, active_target_mode: mode, target_source: source, target_state: "ready", updated_at: new Date().toISOString() } as any, { onConflict: "project_id" });
      console.log(`[StepTargetFeatures] Target persisted: col=${col}, mode=${mode}`);
    } catch (err) { console.error("[StepTargetFeatures] Failed to persist target:", err); }
  }, [projectData.id]);

  const runTargetHealthCheck = useCallback(async (col: string) => {
    if (!projectData.id || !col) return;
    try {
      const { data } = await supabase.functions.invoke("tde-evaluate-target-quality", { body: { project_id: projectData.id, target_column: col } });
      console.log("[StepTargetFeatures] Target health check:", data?.quality_score);
    } catch (err) { /* non-blocking */ }
  }, [projectData.id]);

  const handleTargetChange = (value: string) => {
    if (isHardBlockedTarget(value)) { setTargetColumn(""); toast({ title: "Alvo inválido", description: `"${value}" é um token de sistema reservado.`, variant: "destructive" }); return; }
    if (looksLikeId(value)) { setBlockedIdTarget(value); return; }
    setBlockedIdTarget(null);
    if (looksLikeLeakage(value)) { setLeakageBlock(`"${value}" parece conter informação pós-evento (leakage). Não recomendado como alvo.`); }
    else if (businessContract?.guardrails?.forbid_leakage_patterns?.some(p => value.toLowerCase().includes(p.toLowerCase()))) { setLeakageWarning(`"${value}" pode conter informação parcial de leakage. Use com cautela.`); }
    else { setLeakageWarning(null); setLeakageBlock(null); }
    if (looksLikeState(value) && !advancedMode && (businessObjective === "churn" || businessObjective === "propensity" || businessObjective === "anomaly")) { setShowStateToEvent(true); setStateToEventCol(value); }
    else { setShowStateToEvent(false); setStateToEventCol(null); }

    setTargetColumn(value);
    if (value !== "label") setTargetSource("manual");
    setSelectedFeatures((prev) => { const f = prev.filter((f) => f !== value); return f.length === 0 ? columns.filter((c) => c.name !== value).map((c) => c.name) : f; });
    setAppliedTargetColumn(null);
    setInferredProblemType(null);
    const source = value === "label" ? targetSource : "manual";
    persistTargetSelection(value, source);
    runTargetHealthCheck(value);
  };

  const toggleFeature = (columnName: string) => { setSelectedFeatures((prev) => prev.includes(columnName) ? prev.filter((f) => f !== columnName) : [...prev, columnName]); };

  const LEAKAGE_KEYWORDS = ["target", "label", "resultado", "result", "status_final", "outcome", "predicted", "prediction", "score_final", "y_true", "y_pred", "suggested_label", "confidence", "label_source"];
  const isLeakageCandidate = (colName: string): boolean => { const lower = colName.toLowerCase(); return LEAKAGE_KEYWORDS.some(kw => lower === kw || lower.includes(kw)); };

  const autoPopulateFeatures = (newTarget: string) => {
    setSelectedFeatures(prev => {
      const structuralCols = new Set<string>();
      if (ssot.entity_key) structuralCols.add(ssot.entity_key);
      if (ssot.time_anchor_column) structuralCols.add(ssot.time_anchor_column);
      if (contractHints?.entity_key) structuralCols.add(contractHints.entity_key);
      if (contractHints?.time_anchor_column) structuralCols.add(contractHints.time_anchor_column);
      structuralCols.add(newTarget);
      if (prev.length > 0) return prev.filter(f => f !== newTarget && !isLeakageCandidate(f));
      return columns.filter(c => !structuralCols.has(c.name) && !c.featureHasError && !isLeakageCandidate(c.name)).map(c => c.name);
    });
  };

  const sourceToMode = (source: string): string => {
    const map: Record<string, string> = { label_builder: "template", weak_supervision: "weak", human_labeling: "human", manual: "column", column: "column" };
    return map[source] || "column";
  };

  const persistTargetSourceToSSOT = async (source: string, templateId: string | null, targetCol?: string) => {
    if (!projectData.id) return;
    const mode = sourceToMode(source);
    const col = targetCol || targetColumn || (source !== "manual" ? "label" : null);
    try {
      await supabase.from("project_settings").update({ target_source: source, selected_template_id: templateId, active_target_mode: mode, active_target_column: col, target_state: col ? "ready" : "draft" } as any).eq("project_id", projectData.id);
      await loadSSOT();
      onSSOTChanged?.();
    } catch (err) { console.error("[StepTargetFeatures] Failed to persist target_source:", err); }
  };

  /**
   * SAVE: persists to project_model_selection (atomic) + project_settings + triggers builder
   */
  const handleSaveSettings = async (): Promise<boolean> => {
    if (!projectData.id || !targetColumn) return false;
    if (!entityKey) { toast({ title: "Entity Key obrigatória", description: "Selecione a coluna que identifica a entidade antes de salvar.", variant: "destructive" }); return false; }
    const cleanFeatures = selectedFeatures.filter((f) => f !== targetColumn);
    if (cleanFeatures.length === 0) { toast({ title: t("common.error"), description: "Selecione ao menos 1 feature.", variant: "destructive" }); return false; }
    const problemType = inferredProblemType || projectData.problem_type;

    // 1. Save via atomic model_selection RPC
    const saved = await saveSettings({ target_column: targetColumn, problem_type: problemType, feature_columns: cleanFeatures, excluded_columns: excludedColumns, suggestion: null });
    if (!saved) return false;

    // 2. Persist entity_key + time_anchor to project_settings
    const settingsUpdate: Record<string, any> = { entity_key: entityKey };
    const resolvedTimeAnchor = ssot.time_anchor_column || contractHints?.time_anchor_column || null;
    if (resolvedTimeAnchor) settingsUpdate.time_anchor_column = resolvedTimeAnchor;
    supabase.from("project_settings").update(settingsUpdate as any).eq("project_id", projectData.id).then(({ error }) => {
      if (!error) console.log(`[StepTargetFeatures] entity_key=${entityKey}, time_anchor=${resolvedTimeAnchor} persisted`);
    });

    // 3. Auto-trigger builder
    if (cleanFeatures.length >= 3) {
      setIsRebuilding(true);
      try {
        const builderRes = await supabase.functions.invoke("build-modeling-dataset", { body: { project_id: projectData.id } });
        console.log("[StepTargetFeatures] Builder triggered after save:", builderRes.data?.success ? "OK" : builderRes.data?.error);
      } catch (e) { console.warn("[StepTargetFeatures] Builder auto-trigger failed:", e); }
      finally { setIsRebuilding(false); }
    }

    appendContext("targeting", {
      selected_problem: problemType || "", selected_target: targetColumn, entity_key: entityKey,
      recommended_features: cleanFeatures, excluded_features: excludedColumns,
      justification: inference?.suggested_targets.find((t) => t.column === targetColumn)?.why_this_target || "Manual.",
    }).catch(() => {});

    toast({ title: "Configuração salva!", description: "Target, features e configurações foram persistidos." });
    await Promise.all([loadSelectionVersion(), loadSSOT()]);
    onSSOTChanged?.();
    setPreflightRefreshKey(k => k + 1);
    return true;
  };

  const handleNext = async () => {
    if (targetColumn) {
      await handleSaveSettings();
      await saveProject({ target_column: targetColumn, ...(inferredProblemType ? { problem_type: inferredProblemType as any } : {}) }, 5);
    } else { onNext(); }
  };

  const availableFeatures = columns.filter((col) => col.name !== targetColumn);
  const effectiveProblemType = inferredProblemType || projectData.problem_type;
  const unifiedEdaOk = modelingState?.eda?.status === "ok" || ds.edaReady;

  // ═══ PIPELINE STATUS (real state from SSOT + model_selection) ═══
  const pipelineChecks = [
    { label: "Dataset ativo", ok: !!(modelingState?.active_dataset || ds.hasManifest), detail: modelingState?.active_dataset ? `${modelingState.active_dataset.total_rows?.toLocaleString()} linhas` : ds.rowCount > 0 ? `${ds.rowCount.toLocaleString()} linhas` : "—" },
    { label: "Target definido", ok: !!targetColumn, detail: targetColumn || "—" },
    { label: "Entity Key", ok: !!entityKey, detail: entityKey || "—" },
    { label: "Features", ok: selectedFeatures.filter(f => f !== targetColumn).length > 0, detail: `${selectedFeatures.filter(f => f !== targetColumn).length} selecionadas` },
    { label: "EDA processado", ok: unifiedEdaOk, detail: unifiedEdaOk ? "OK" : "Pendente" },
    { label: "Model selection", ok: autoRes.applied || (selectionVersion !== null && selectionVersion > 0), detail: selectionVersion ? `v${selectionVersion}` : autoRes.applied ? "Aplicado pelo PRE" : "Pendente" },
    { label: "Builder", ok: autoRes.builderStatus === "done" || isBuilderReady, detail: autoRes.builderStatus === "done" ? "Gerado" : autoRes.builderStatus === "running" || isRebuilding ? "Gerando..." : isBuilderReady ? "Pronto" : "Pendente" },
  ];

  // ═══ LOADING STATES ═══
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
          <p className="text-muted-foreground mb-6">{t("stepVariables.noColumnsDesc")}</p>
          <Button variant="outline" onClick={onBack}>{t("stepVariables.backToData")}</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        {/* ═══ HEADER ═══ */}
        <div className="text-center mb-2">
          <div className="w-14 h-14 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Target className="w-7 h-7 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-1">Variável Alvo &amp; Features</h2>
          <p className="text-sm text-muted-foreground">Configuração inteligente do problema preditivo.</p>
        </div>

        {/* ═══ BLOCO 1: SUGESTÃO APLICADA (PRE) ═══ */}
        {autoRes.resolving && (
          <div className="flex items-center gap-3 p-4 rounded-xl border border-primary/20 bg-primary/5 animate-pulse">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <div>
              <p className="text-sm font-medium">Analisando dados e formulando problema preditivo...</p>
              <p className="text-xs text-muted-foreground">O PRE está resolvendo target, entidade e features automaticamente.</p>
            </div>
          </div>
        )}

        {autoRes.resolved && autoRes.result.target_column && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Brain className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <h3 className="text-sm font-semibold">Resolução aplicada</h3>
                  <Badge variant={autoRes.result.confidence_score >= 0.7 ? "default" : "outline"} className={`text-[10px] py-0 ${autoRes.result.confidence_score >= 0.7 ? "bg-green-500/20 text-green-600 border-green-500/30" : autoRes.result.confidence_score >= 0.5 ? "border-yellow-500/50 text-yellow-600" : "border-destructive/50 text-destructive"}`}>
                    {Math.round(autoRes.result.confidence_score * 100)}% confiança
                  </Badge>
                  {autoRes.result.auto_fix_applied && (
                    <Badge variant="outline" className="text-[10px] py-0"><Wand2 className="w-3 h-3 mr-1" /> Auto-fix</Badge>
                  )}
                  {autoRes.applied && (
                    <Badge className="bg-green-500/20 text-green-600 border-green-500/30 text-[10px] py-0"><CheckCircle className="w-3 h-3 mr-0.5" /> Sincronizado</Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="text-xs"><span className="text-muted-foreground">Target:</span> <span className="font-medium">{autoRes.result.target_column}</span></div>
                  <div className="text-xs"><span className="text-muted-foreground">Problema:</span> <span className="font-medium">{autoRes.result.problem_type === "classification" ? "Classificação" : "Regressão"}</span></div>
                  <div className="text-xs"><span className="text-muted-foreground">Entity:</span> <span className="font-medium">{autoRes.result.entity_key || "—"}</span></div>
                  <div className="text-xs"><span className="text-muted-foreground">Tempo:</span> <span className="font-medium">{autoRes.result.time_column || "Não detectado"}</span></div>
                </div>
                {autoRes.result.auto_fix_details.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {autoRes.result.auto_fix_details.map((detail, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground"><Wand2 className="w-3 h-3 text-primary" /><span>{detail}</span></div>
                    ))}
                  </div>
                )}
              </div>
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { autoResAppliedRef.current = false; autoRes.resolve(); }}>
                <RefreshCw className="w-3 h-3 mr-1" /> Reexecutar
              </Button>
            </div>
          </div>
        )}

        {/* ═══ BLOCO 2: CONFIGURAÇÃO EDITÁVEL ═══ */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-5">
          <div className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            <h3 className="text-base font-semibold">Configuração</h3>
          </div>

          {/* Hidden column inference loader */}
          {projectData.id && !advancedMode && (
            <div className="hidden">
              <ColumnInferenceMatrix projectId={projectData.id} onDataLoaded={(data) => { setColumnInference(data); const map = new Map<string, ColumnInferenceRow>(); data.forEach((d) => map.set(d.column_name, d)); columnInferenceMap.current = map; }} />
            </div>
          )}

          {/* Alerts */}
          {blockedIdTarget && (
            <Alert className="border-destructive/30 bg-destructive/5">
              <Ban className="w-4 h-4 text-destructive" />
              <AlertDescription className="text-sm">
                <strong>"{blockedIdTarget}" parece ser um identificador.</strong> Identificadores não contêm informação preditiva.
                <div className="mt-2"><Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBlockedIdTarget(null)}>Escolher outro alvo</Button></div>
              </AlertDescription>
            </Alert>
          )}
          {leakageWarning && (
            <Alert className="border-amber-500/30 bg-amber-500/5"><AlertTriangle className="w-4 h-4 text-amber-500" /><AlertDescription className="text-sm text-amber-700 dark:text-amber-400">{leakageWarning}</AlertDescription></Alert>
          )}
          {leakageBlock && (
            <Alert className="border-destructive/30 bg-destructive/5"><Ban className="w-4 h-4 text-destructive" /><AlertDescription className="text-sm text-destructive">{leakageBlock}</AlertDescription></Alert>
          )}

          {/* Target selection */}
          {targetSource === "manual" && (
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Target className="w-4 h-4 text-primary" />
                {t("stepVariables.targetVariable")}
              </Label>
              <Select value={targetColumn} onValueChange={handleTargetChange}>
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder={t("stepVariables.selectTarget")} />
                </SelectTrigger>
                <SelectContent className="bg-popover border border-border shadow-lg z-50">
                  {labelBuilderId && (
                    <SelectItem value="label"><div className="flex items-center gap-2"><span className="font-medium">label</span><Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] py-0">gerado</Badge></div></SelectItem>
                  )}
                  {columns.map((col) => {
                    const inf = columnInferenceMap.current.get(col.name);
                    const isBlocked = inf && !inf.can_be_target && inf.block_reasons.length > 0;
                    return (
                      <SelectItem key={col.name} value={col.name} disabled={isBlocked}>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${isBlocked ? "text-muted-foreground line-through" : ""}`}>{col.name}</span>
                          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">{col.type}</span>
                          {col.isFeature && <Badge variant="secondary" className="text-[10px] py-0">derivado</Badge>}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Label builder/weak/human badges */}
          {targetSource !== "manual" && targetColumn === "label" && (
            <div className="flex items-center gap-2 p-3 bg-accent/10 border border-accent/20 rounded-lg">
              <Sparkles className="w-4 h-4 text-accent" />
              <div className="flex-1">
                <p className="text-sm font-medium">
                  <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px] mr-2">
                    {targetSource === "label_builder" ? "Alvo gerado" : targetSource === "weak_supervision" ? "Alvo por regras" : "Alvo por rotulagem"}
                  </Badge>
                  <strong>label</strong>
                </p>
              </div>
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { setTargetSource("manual"); setTargetColumn(""); setAppliedTargetColumn(null); }}>Trocar</Button>
            </div>
          )}

          {/* Problem type */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Tipo do problema</Label>
            <Select value={effectiveProblemType || ""} onValueChange={(v) => setInferredProblemType(v)}>
              <SelectTrigger className="bg-background">
                <SelectValue placeholder="Tipo do problema" />
              </SelectTrigger>
              <SelectContent className="bg-popover border border-border shadow-lg z-50">
                <SelectItem value="classification">Classificação</SelectItem>
                <SelectItem value="regression">Regressão</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Entity + Time */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-secondary" />
                Entity Key
                <Badge variant="destructive" className="text-[10px] py-0">obrigatório</Badge>
              </Label>
              <Select value={entityKey} onValueChange={setEntityKey}>
                <SelectTrigger className={`bg-background ${!entityKey ? "border-destructive/50" : ""}`}>
                  <SelectValue placeholder="Selecione a entidade..." />
                </SelectTrigger>
                <SelectContent className="bg-popover border border-border shadow-lg z-50">
                  {columns.map((col) => (
                    <SelectItem key={col.name} value={col.name}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{col.name}</span>
                        <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">{col.type}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!entityKey && targetColumn && (
                <p className="text-xs text-destructive flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Selecione a Entity Key para poder avançar.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Clock className="w-4 h-4 text-muted-foreground" />
                Coluna temporal
              </Label>
              <div className="p-3 bg-background rounded-lg border border-border/50 text-sm">
                {ssot.time_anchor_column ? (
                  <div className="flex items-center gap-2"><CheckCircle className="w-4 h-4 text-accent" /><span className="font-medium">{ssot.time_anchor_column}</span></div>
                ) : contractHints?.time_anchor_column ? (
                  <div className="flex items-center gap-2"><Info className="w-4 h-4 text-muted-foreground" /><span className="text-muted-foreground">Sugerida: {contractHints.time_anchor_column}</span></div>
                ) : (
                  <span className="text-muted-foreground">Não detectada</span>
                )}
              </div>
            </div>
          </div>

          {/* Features */}
          <div className="space-y-3">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Layers className="w-4 h-4 text-secondary" />
              Variáveis preditoras
              {selectedFeatures.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">{selectedFeatures.filter(f => f !== targetColumn).length} selecionadas</Badge>
              )}
            </Label>
            <div className="bg-muted/30 rounded-xl p-3 space-y-2 max-h-52 overflow-y-auto">
              {availableFeatures.length > 0 ? (
                <>
                  {availableFeatures.filter(col => !col.isFeature).map((col) => {
                    const inf = columnInferenceMap.current.get(col.name);
                    const isBlockedFeature = inf && !inf.can_be_feature && inf.block_reasons.length > 0;
                    return (
                      <div key={col.name} className={`flex items-center justify-between p-2.5 rounded-lg transition-colors ${isBlockedFeature ? "bg-destructive/5 border border-destructive/20" : "bg-background hover:bg-muted/50"}`}>
                        <div className="flex items-center gap-3">
                          <Checkbox id={col.name} checked={selectedFeatures.includes(col.name)} onCheckedChange={() => toggleFeature(col.name)} disabled={isBlockedFeature} />
                          <label htmlFor={col.name} className={`text-sm font-medium cursor-pointer ${isBlockedFeature ? "text-muted-foreground line-through" : ""}`}>{col.name}</label>
                        </div>
                        <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">{col.type}</span>
                      </div>
                    );
                  })}
                  {availableFeatures.filter(col => col.isFeature).length > 0 && (
                    <>
                      <div className="flex items-center gap-2 pt-2 pb-1 px-1"><Sparkles className="w-4 h-4 text-secondary" /><span className="text-sm font-medium text-secondary">Features criadas</span></div>
                      {availableFeatures.filter(col => col.isFeature).map((col) => (
                        <div key={col.name} className={`flex items-center justify-between p-2.5 rounded-lg ${col.featureHasError ? "bg-destructive/10 border border-destructive/30" : "bg-secondary/5 border border-secondary/20"}`}>
                          <div className="flex items-center gap-3">
                            <Checkbox id={col.name} checked={selectedFeatures.includes(col.name)} onCheckedChange={() => toggleFeature(col.name)} disabled={col.featureHasError} />
                            <div className="flex flex-col">
                              <label htmlFor={col.name} className="text-sm font-medium cursor-pointer">{col.featureLabel || col.name}</label>
                              <span className="text-xs text-muted-foreground font-mono">{col.name}</span>
                            </div>
                          </div>
                          {col.featureHasError ? <Badge variant="destructive" className="text-xs">Erro</Badge> : <Badge variant="secondary" className="text-xs">Feature</Badge>}
                        </div>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <p className="text-center text-muted-foreground py-4">{t("stepVariables.selectTargetFirst")}</p>
              )}
            </div>
            {excludedColumns.length > 0 && <ExcludedFeaturesList excludedColumns={excludedColumns} />}
          </div>
        </div>

        {/* ═══ BLOCO 3: STATUS REAL DO PIPELINE ═══ */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            <h3 className="text-base font-semibold">Status do pipeline</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {pipelineChecks.map((check, i) => (
              <div key={i} className={`flex items-center gap-2 p-2.5 rounded-lg text-sm ${check.ok ? "bg-green-500/5 border border-green-500/20" : "bg-muted/30 border border-border/50"}`}>
                {check.ok ? <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                <span className="font-medium">{check.label}</span>
                <span className="text-xs text-muted-foreground ml-auto">{check.detail}</span>
              </div>
            ))}
          </div>

          {/* Builder/PRE status */}
          {(autoRes.builderStatus === "running" || isRebuilding) && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              <span>Gerando dataset modelável...</span>
            </div>
          )}
          {autoRes.builderStatus === "done" && !isRebuilding && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-xs">
              <CheckCircle className="w-3.5 h-3.5 text-green-500" />
              <span className="font-medium text-green-600">Dataset modelável gerado com sucesso!</span>
            </div>
          )}
        </div>

        {/* Training Preflight */}
        <TrainingPreflightPanel projectId={projectData.id} onNavigateBack={onBack} refreshKey={preflightRefreshKey} />

        {/* ═══ MODO ESPECIALISTA ═══ */}
        <TargetExpertPanel advancedMode={advancedMode}>
          {businessContract && (
            <BusinessGuidancePanel
              contract={businessContract}
              objectiveLabel={INDUSTRY_OBJECTIVE_MATRIX[businessContract.industry]?.objectives.find(o => o.key === businessContract.objective)?.label_pt || businessContract.objective}
              industryLabel={businessContract.industry === "retail" ? "Varejo" : businessContract.industry === "health" ? "Saúde" : businessContract.industry === "finance" ? "Finanças" : businessContract.industry === "education" ? "Educação" : businessContract.industry === "logistics" ? "Logística" : "Geral"}
              schemaColumns={columns.map(c => c.name)}
              advancedMode={advancedMode}
              onApplySuggestion={handleApplySuggestion}
            />
          )}

          {(() => {
            const allowed = businessContract?.target_modes_allowed;
            const showAll = advancedMode || !allowed || allowed.length === 0;
            return (
              <>
                {projectData.id && (showAll || allowed?.includes("assisted_build")) && !isSegmentation && (
                  <div id="target-builder-panel">
                    <TargetStrategyPanel projectId={projectData.id} industry={intentInfo.industry} onBuilderReady={(builderId, templateId) => { setLabelBuilderId(builderId); setLabelTemplateId(templateId); setTargetColumn("label"); setTargetSource("label_builder"); setSelectedTemplateId(templateId); setAppliedTargetColumn("label"); const tmpl = LABEL_TEMPLATES[templateId]; setInferredProblemType(tmpl?.problem_type || "classification"); autoPopulateFeatures("label"); setPreflightRefreshKey(k => k + 1); persistTargetSourceToSSOT("label_builder", templateId); }} />
                  </div>
                )}
                {projectData.id && (showAll || allowed?.includes("quick_label")) && !isSegmentation && (
                  <WeakLabelBuilderCard projectId={projectData.id} onActivated={() => { setTargetColumn("label"); setTargetSource("weak_supervision"); setSelectedTemplateId("weak_supervision_assisted"); setAppliedTargetColumn("label"); setInferredProblemType("classification"); autoPopulateFeatures("label"); setPreflightRefreshKey(k => k + 1); persistTargetSourceToSSOT("weak_supervision", "weak_supervision_assisted"); }} />
                )}
                {projectData.id && (showAll || allowed?.includes("manual")) && !isSegmentation && (
                  <HumanLabelingCard projectId={projectData.id} onActivated={() => { setTargetColumn("label"); setTargetSource("human_labeling"); setSelectedTemplateId("human_labeling_assisted"); setAppliedTargetColumn("label"); setInferredProblemType("classification"); autoPopulateFeatures("label"); setPreflightRefreshKey(k => k + 1); persistTargetSourceToSSOT("human_labeling", "human_labeling_assisted"); }} />
                )}
              </>
            );
          })()}

          {projectData.id && <ColumnInferenceMatrix projectId={projectData.id} onDataLoaded={(data) => { setColumnInference(data); const map = new Map<string, ColumnInferenceRow>(); data.forEach((d) => map.set(d.column_name, d)); columnInferenceMap.current = map; }} />}
          {columnInference.length > 0 && <BlockedTargetCandidates columnInference={columnInference} />}
          {projectData.id && targetColumn && <TargetPresenceScan projectId={projectData.id} targetColumn={targetColumn} targetSource={targetSource} />}
          {projectData.id && targetColumn && appliedTargetColumn && <TargetLifecycleCard projectId={projectData.id} refreshKey={preflightRefreshKey} />}
          {projectData.id && targetColumn && <SplitAndLeakagePanel projectId={projectData.id} />}

          <ModelingDatasetSection
            projectId={projectData.id}
            targetColumn={targetColumn}
            onSaveBeforeBuild={handleSaveSettings}
            onBuildComplete={async () => { await Promise.all([ds.load(), loadSelectionVersion(), loadBuilderVersion(), loadSSOT()]); onSSOTChanged?.(); setPreflightRefreshKey(k => k + 1); }}
          />

          {targetColumn && selectionVersion && <AuditContractPanel projectId={projectData.id} selectionVersion={selectionVersion} />}
          {projectData.id && targetColumn && appliedTargetColumn && <TargetQualityCard projectId={projectData.id} refreshKey={preflightRefreshKey} />}

          {selectionVersion !== null && (
            <div className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg text-xs text-muted-foreground">
              <Save className="w-3.5 h-3.5" /><span>Seleção <strong>v{selectionVersion}</strong></span>
            </div>
          )}
        </TargetExpertPanel>

        {/* Pipeline Debug (admin) */}
        {advancedMode && <PipelineStateDebugPanel projectId={projectData.id} />}

        {/* Advanced toggle */}
        <div className="flex items-center justify-between p-3 bg-muted/20 rounded-lg border border-border/30">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Modo especialista</span>
          </div>
          <Switch checked={advancedMode} onCheckedChange={handleAdvancedModeToggle} />
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>{t("common.back")}</Button>
          <div className="flex gap-2">
            {targetColumn && (
              <Button variant="outline" onClick={handleSaveSettings} disabled={loading || !targetColumn || !entityKey || isRebuilding}>
                <Save className="w-4 h-4 mr-1.5" />{isRebuilding ? "Salvando..." : t("common.save")}
              </Button>
            )}
            <Button onClick={handleNext} disabled={loading || !targetColumn || !entityKey} className="bg-gradient-primary hover:shadow-hover transition-all">
              {loading ? t("common.loading") : t("common.next")}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default StepTargetFeatures;
