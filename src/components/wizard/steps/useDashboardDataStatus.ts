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
      // 5 parallel queries — prediction_state is the new SSOT
      const [predStateRes, reportRes, totalRes, latestRes, horizonRes] = await Promise.all([
        // A) Prediction state (SSOT)
        supabase
          .from("project_prediction_state")
          .select("status, latest_batch_id, predictions_count, coverage_pct, last_error_code, last_error_message")
          .eq("project_id", projectId)
          .maybeSingle(),
        // B) Latest score report
        supabase
          .from("project_score_reports")
          .select("created_at, predictions_count, coverage_pct, batch_id, warnings")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // C) Total predictions count
        supabase
          .from("predictions")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId),
        // D) Latest predictions count
        supabase
          .from("predictions")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("is_latest", true),
        // E) Horizons
        supabase
          .from("predictions")
          .select("horizon_days")
          .eq("project_id", projectId)
          .eq("is_latest", true)
          .limit(1000),
      ]);

      // Check for RLS errors
      const errors = [predStateRes.error, reportRes.error, totalRes.error, latestRes.error, horizonRes.error].filter(Boolean);
      if (errors.length > 0) {
        const msg = errors.map(e => e!.message).join("; ");
        console.error("[DashboardDataStatus] RLS/query error:", msg);
        setRlsError(msg);
        setStatus("RLS_ERROR");
        return;
      }

      // Prediction state (new SSOT)
      const pState = predStateRes.data as PredictionStateInfo | null;
      setPredictionState(pState);

      // Score report
      const report = reportRes.data as ScoreReportInfo | null;
      setScoreReport(report);

      // Counts
      const total = totalRes.count ?? 0;
      const latest = latestRes.count ?? 0;
      setCounts({ total, latest });

      // Horizons aggregation
      const horizonMap = new Map<number, number>();
      if (horizonRes.data) {
        for (const row of horizonRes.data) {
          const h = row.horizon_days ?? 0;
          horizonMap.set(h, (horizonMap.get(h) || 0) + 1);
        }
      }
      const horizonArr = Array.from(horizonMap.entries())
        .map(([horizon_days, count]) => ({ horizon_days, count }))
        .sort((a, b) => b.count - a.count);
      setHorizons(horizonArr);

      // ===== Decision logic: prediction_state is primary SSOT =====
      if (pState) {
        switch (pState.status) {
          case "running":
            setStatus("SCORING_RUNNING");
            return;
          case "finalizing":
            setStatus("SCORING_FINALIZING");
            return;
          case "failed":
            setStatus("SCORING_FAILED");
            return;
          case "sanity_fail":
            setStatus("SCORING_SANITY_FAIL");
            return;
          case "done":
            if (pState.predictions_count > 0) {
              setStatus("OK");
              return;
            }
            break;
          // idle — fall through to legacy check
        }
      }

      // Legacy fallback (for projects without prediction_state yet)
      if (report && report.predictions_count > 0) {
        setStatus("OK");
      } else if (latest > 0) {
        setStatus("OK");
      } else if (total > 0 && latest === 0) {
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
