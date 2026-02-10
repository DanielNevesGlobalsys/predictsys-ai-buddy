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

// ── ModelingContract types (v3) ──

export interface TargetDefinition {
  type: "event" | "state_to_event";
  base_column: string;
  derived_target: string;
  window_days: number | null;
  problem_type: "binary" | "class" | "regression";
  confidence: number;
  business_summary: string;
  why_this_target: string;
  caveats: string[];
  notes: string;
}

export interface BlockedFeature {
  col: string;
  reason: string;
}

export interface LeakageFlag {
  col: string;
  reason: string;
}

export type ColumnRole =
  | "ID_TECNICO"
  | "TEMPO"
  | "DIMENSAO_NEGOCIO"
  | "MEDIDA_NUMERICA"
  | "CATEGORICA"
  | "TEXTO"
  | "TARGET_CANDIDATO_EVENTO"
  | "TARGET_CANDIDATO_ESTADO"
  | "DERIVADA_LEAKAGE"
  | "DESCONHECIDO";

export interface ModelingContract {
  anchor_time_col: string | null;
  entity_key: string[] | null;
  target_definition: TargetDefinition;
  split_strategy: "temporal" | "stratified" | "random";
  features_final: string[];
  features_blocked: BlockedFeature[];
  leakage_flags: LeakageFlag[];
  column_roles: Record<string, ColumnRole>;
  dashboard_gold_schema: string[];
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
  const [modelingContract, setModelingContract] = useState<ModelingContract | null>(null);
  const [contractStatus, setContractStatus] = useState<"APPROVED" | "BLOCKED" | null>(null);
  const [justification, setJustification] = useState<string[]>([]);
  const [removedAndWhy, setRemovedAndWhy] = useState<BlockedFeature[]>([]);
  const [nextStep, setNextStep] = useState<string | null>(null);
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
        const contractFromResponse = data?.modeling_contract as ModelingContract | undefined;

        // Set contract-related state
        setModelingContract(contractFromResponse || null);
        setContractStatus(data?.contract_status || null);
        setJustification(data?.justification || []);
        setRemovedAndWhy(data?.removed_and_why || []);
        setNextStep(data?.next_step || null);

        if (result) {
          const allLabels = Array.isArray(result.suggested_problem_labels)
            ? result.suggested_problem_labels
            : [];

          const industryFromLabels = parseIndustryFromLabels(allLabels);
          const industry = industryFromResponse || industryFromLabels || undefined;
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

  return {
    inference,
    modelingContract,
    contractStatus,
    justification,
    removedAndWhy,
    nextStep,
    loading,
    error,
    loadInference,
  };
}
