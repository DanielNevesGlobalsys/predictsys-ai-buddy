import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AuditCheckResult {
  status: "ok" | "warning" | "error" | "pending";
  observations: string[];
}

export interface AuditContextFlags {
  has_eda: boolean;
  has_inference: boolean;
  has_target: boolean;
  has_features: boolean;
  has_model: boolean;
  has_metrics: boolean;
  has_feature_importance: boolean;
  has_predictions: boolean;
  has_dashboard_context: boolean;
}

export interface AuditReport {
  overall_coherent: boolean;
  confidence_level: "high" | "medium" | "low";
  stages: {
    eda: AuditCheckResult;
    inference: AuditCheckResult;
    target: AuditCheckResult;
    model: AuditCheckResult;
    dashboard: AuditCheckResult;
  };
  incoherences: string[];
  corrections: string[];
  executive_conclusion: string;
  context_flags: AuditContextFlags;
  disclaimer: string;
}

export function useProjectPipelineAudit(projectId: string | undefined) {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAudit = useCallback(async (language: string = "pt", pipelineStage: string = "production") => {
    if (!projectId) return null;
    setLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke("audit-project-pipeline", {
        body: { project_id: projectId, language, pipeline_stage: pipelineStage },
      });

      if (fnError) {
        throw new Error(fnError.message || "Erro na auditoria");
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      if (data?.report) {
        setReport(data.report);
        return data.report as AuditReport;
      }

      throw new Error("Resposta inválida da auditoria");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      setError(msg);
      console.error("[useProjectPipelineAudit] Error:", err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  return { report, loading, error, runAudit };
}
