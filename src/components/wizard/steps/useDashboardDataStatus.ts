import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type DashboardStatus =
  | "LOADING"
  | "OK"
  | "PENDING_PROMOTE"
  | "NO_PREDICTIONS"
  | "RLS_ERROR"
  | "SCORING_SANITY_FAIL"
  | "SCORING_RUNNING"
  | "SCORING_FINALIZING"
  | "SCORING_FAILED";

export interface ScoreReportInfo {
  created_at: string;
  predictions_count: number;
  coverage_pct: number;
  batch_id: string | null;
}

export interface PredictionCounts {
  total: number;
  latest: number;
}

export interface HorizonInfo {
  horizon_days: number;
  count: number;
}

export interface PredictionStateInfo {
  status: string;
  latest_batch_id: string | null;
  predictions_count: number;
  coverage_pct: number;
  last_error_code: string | null;
  last_error_message: string | null;
}

export interface DashboardDataStatus {
  status: DashboardStatus;
  scoreReport: ScoreReportInfo | null;
  counts: PredictionCounts;
  horizons: HorizonInfo[];
  bestHorizon: number | null;
  rlsError: string | null;
  predictionState: PredictionStateInfo | null;
  refetch: () => void;
}

export function useDashboardDataStatus(projectId: string | undefined): DashboardDataStatus {
  const [status, setStatus] = useState<DashboardStatus>("LOADING");
  const [scoreReport, setScoreReport] = useState<ScoreReportInfo | null>(null);
  const [counts, setCounts] = useState<PredictionCounts>({ total: 0, latest: 0 });
  const [horizons, setHorizons] = useState<HorizonInfo[]>([]);
  const [rlsError, setRlsError] = useState<string | null>(null);
  const [predictionState, setPredictionState] = useState<PredictionStateInfo | null>(null);

  const fetchAll = useCallback(async () => {
    if (!projectId) {
      setStatus("NO_PREDICTIONS");
      return;
    }
    setStatus("LOADING");
    setRlsError(null);

    try {
      // Phase 1: Get prediction state (SSOT) — this is the primary source of truth
      const { data: predStateData, error: predStateError } = await supabase
        .from("project_prediction_state")
        .select("status, latest_batch_id, predictions_count, coverage_pct, last_error_code, last_error_message")
        .eq("project_id", projectId)
        .maybeSingle();

      if (predStateError) {
        console.error("[DashboardDataStatus] State error:", predStateError.message);
        setRlsError(predStateError.message);
        setStatus("RLS_ERROR");
        return;
      }

      const pState = predStateData as PredictionStateInfo | null;
      setPredictionState(pState);

      // If prediction state exists, use it as primary SSOT
      if (pState) {
        switch (pState.status) {
          case "running":
            setStatus("SCORING_RUNNING");
            setCounts({ total: pState.predictions_count || 0, latest: 0 });
            return;
          case "finalizing": {
            // Check if stuck > 60s — show CTA
            setStatus("SCORING_FINALIZING");
            setCounts({ total: pState.predictions_count || 0, latest: 0 });
            return;
          }
          case "failed":
            setStatus("SCORING_FAILED");
            setCounts({ total: pState.predictions_count || 0, latest: 0 });
            return;
          case "sanity_fail":
            setStatus("SCORING_SANITY_FAIL");
            setCounts({ total: pState.predictions_count || 0, latest: 0 });
            return;
          case "done":
            if (pState.predictions_count > 0 && pState.latest_batch_id) {
              // Use batch_id from SSOT for horizon query
              const [reportRes, horizonRes] = await Promise.all([
                supabase
                  .from("project_score_reports")
                  .select("created_at, predictions_count, coverage_pct, batch_id, warnings")
                  .eq("project_id", projectId)
                  .order("created_at", { ascending: false })
                  .limit(1)
                  .maybeSingle(),
                supabase.from("predictions").select("horizon_days")
                  .eq("project_id", projectId).eq("batch_id", pState.latest_batch_id).limit(1000),
              ]);

              setScoreReport(reportRes.data as ScoreReportInfo | null);
              setCounts({ total: pState.predictions_count, latest: pState.predictions_count });

              // Horizons
              const horizonMap = new Map<number, number>();
              if (horizonRes.data) {
                for (const row of horizonRes.data) {
                  const h = row.horizon_days ?? 0;
                  horizonMap.set(h, (horizonMap.get(h) || 0) + 1);
                }
              }
              setHorizons(
                Array.from(horizonMap.entries())
                  .map(([horizon_days, count]) => ({ horizon_days, count }))
                  .sort((a, b) => b.count - a.count)
              );

              setStatus("OK");
              return;
            }
            break; // fall through to legacy
        }
      }

      // Legacy fallback (projects without prediction_state)
      const [reportRes, totalRes] = await Promise.all([
        supabase
          .from("project_score_reports")
          .select("created_at, predictions_count, coverage_pct, batch_id, warnings")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("predictions")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId),
      ]);

      const report = reportRes.data as ScoreReportInfo | null;
      setScoreReport(report);
      const total = totalRes.count ?? 0;
      setCounts({ total, latest: total > 0 ? total : 0 });

      if (report && report.predictions_count > 0) {
        setStatus("OK");
      } else if (total > 0) {
        setStatus("PENDING_PROMOTE");
      } else {
        setStatus("NO_PREDICTIONS");
      }
    } catch (err) {
      console.error("[DashboardDataStatus] Unexpected error:", err);
      setRlsError(err instanceof Error ? err.message : "Erro desconhecido");
      setStatus("RLS_ERROR");
    }
  }, [projectId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const bestHorizon = horizons.length > 0 ? horizons[0].horizon_days : null;

  return { status, scoreReport, counts, horizons, bestHorizon, rlsError, predictionState, refetch: fetchAll };
}
