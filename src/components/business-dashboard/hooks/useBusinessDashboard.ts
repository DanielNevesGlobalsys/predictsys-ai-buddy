import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardMetrics } from './useDashboardMetrics';
import { trackEventWithTiming } from '@/lib/platformTracking';
import { getLatestBatchId } from '@/lib/getLatestBatchId';
import type { 
  Prediction, 
  DashboardFilters, 
  GroupSegmentation,
  TimeProjection,
  BusinessDashboardData 
} from '../types';

const HIGH_PROBABILITY_THRESHOLD = 0.7;

interface ProductionModelInfo {
  id: string;
  algorithm_name: string;
}

export function useBusinessDashboard(projectId: string) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [productionModel, setProductionModel] = useState<ProductionModelInfo | null>(null);
  const [runningBatch, setRunningBatch] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const autoRunTriggered = useRef(false);
  const [scoringBlocked, setScoringBlocked] = useState<{ code: string; message: string; ctas: any[] } | null>(null);
  
  const [filters, setFilters] = useState<DashboardFilters>({
    dataset: 'latest',
    dateRange: { from: null, to: null },
    horizon: 30,
    segmentField: null,
    segmentValue: null,
    viewMode: 'risk'
  });

  const {
    kpis, segmentationBands,
    availableSegmentFields: metricsSegmentFields,
    problemType: metricsProblemType,
    loading: metricsLoading, error: metricsError,
    refetch: refetchMetrics,
    confidenceScore, confidenceInputs,
    recommendedThreshold, staleResults,
    selectionVersionScored, selectionVersionCurrent,
  } = useDashboardMetrics(projectId, filters);

  // Fetch production model
  useEffect(() => {
    async function fetchProductionModel() {
      try {
        const { data: model } = await supabase
          .from('project_models').select('id, algorithm_name')
          .eq('project_id', projectId).eq('is_production', true)
          .eq('status', 'trained').maybeSingle();
        setProductionModel(model);
      } catch (err) {
        console.error('Error fetching production model:', err);
      }
    }
    if (projectId) fetchProductionModel();
  }, [projectId]);

  // Fetch predictions for components needing individual data
  const fetchPredictions = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      // Use batch_id from SSOT instead of is_latest
      const batchId = await getLatestBatchId(projectId);
      let query = supabase.from('predictions').select('*')
        .eq('project_id', projectId)
        .lte('horizon_days', filters.horizon);
      if (batchId) {
        query = query.eq('batch_id', batchId);
      } else {
        // Legacy fallback
        query = query.eq('is_latest', true);
      }
      if (filters.segmentField && filters.segmentValue) {
        query = query.eq(filters.segmentField as keyof Prediction, filters.segmentValue);
      }
      query = query.limit(1000);
      const { data, error: fetchError } = await query;
      if (fetchError) {
        setError(fetchError.message);
        setPredictions([]);
      } else {
        setPredictions((data as Prediction[]) || []);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setPredictions([]);
    } finally {
      setLoading(false);
      setInitialLoadComplete(true);
    }
  }, [projectId, filters.horizon, filters.segmentField, filters.segmentValue]);

  useEffect(() => { fetchPredictions(); }, [fetchPredictions]);

  // Run batch predictions with multi-pass and structured responses
  const runBatchPredictions = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!projectId || !productionModel) {
      return { success: false, error: 'Nenhum modelo em produção' };
    }
    
    const startTime = Date.now();
    setRunningBatch(true);
    setError(null);
    setScoringBlocked(null);
    
    try {
      let passOffset = 0;
      let batchIdToUse: string | undefined;
      let runningStatsState: any = null;
      let totalScoredPrev = 0;
      let totalInvalidPrev = 0;
      let passNumber = 0;
      let jobId: string | undefined;

      while (true) {
        passNumber++;

        const { data, error: invokeError } = await supabase.functions.invoke('run-batch-predictions', {
          body: {
            project_id: projectId, horizon_days: filters.horizon,
            pass_offset: passOffset, batch_id: batchIdToUse,
            running_stats: runningStatsState,
            total_scored_prev: totalScoredPrev,
            total_invalid_prev: totalInvalidPrev,
            job_id: jobId,
          }
        });

        if (invokeError) {
          const errorMsg = invokeError.message || 'Erro ao gerar previsões';
          setError(errorMsg);
          trackEventWithTiming({ event_type: "job_error", project_id: projectId, status: "error", metadata: { stage: "prediction", error_message: errorMsg, pass: passNumber }, source: "app" }, startTime);
          return { success: false, error: errorMsg };
        }

        // Handle BLOCKED
        if (data?.status === "BLOCKED") {
          const msg = data.error_friendly || `Scoring bloqueado: ${data.error_code}`;
          setScoringBlocked({ code: data.error_code, message: msg, ctas: data.ctas || [] });
          setError(msg);
          return { success: false, error: msg };
        }

        // Handle ERROR
        if (data?.status === "ERROR") {
          const msg = data.error_friendly || data.error || "Erro no scoring";
          setError(msg);
          return { success: false, error: msg };
        }

        // CONTINUE
        if (data?.status === "CONTINUE" || data?.continue) {
          passOffset = data.next_offset;
          batchIdToUse = data.batch_id;
          runningStatsState = data.running_stats;
          totalScoredPrev = data.total_scored_prev;
          totalInvalidPrev = data.total_invalid_prev;
          jobId = data.job_id;
          continue;
        }

        // DONE
        trackEventWithTiming({ event_type: "prediction_run", project_id: projectId, status: "success", metadata: { rows_scored: data?.rows_scored || data?.predictions_count, passes: passNumber }, source: "app" }, startTime);
        await Promise.all([fetchPredictions(), refetchMetrics()]);
        return { success: true };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Erro ao gerar previsões';
      setError(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setRunningBatch(false);
    }
  }, [projectId, productionModel, filters.horizon, fetchPredictions, refetchMetrics]);

  // Auto-run predictions when entering dashboard with no predictions
  useEffect(() => {
    if (
      initialLoadComplete && !autoRunTriggered.current && 
      predictions.length === 0 && kpis.totalEntities === 0 &&
      productionModel && !runningBatch && !loading && !metricsLoading
    ) {
      autoRunTriggered.current = true;
      runBatchPredictions();
    }
  }, [initialLoadComplete, predictions.length, kpis.totalEntities, productionModel, runningBatch, loading, metricsLoading, runBatchPredictions]);

  // Group segmentation
  const groupSegmentation = useMemo<GroupSegmentation[]>(() => {
    const groupField = filters.segmentField || 'segment';
    const groups = new Map<string, { count: number; probabilities: number[]; values: number[]; highProbCount: number }>();
    predictions.forEach(p => {
      const groupValue = p[groupField as keyof Prediction] as string | null;
      if (!groupValue) return;
      if (!groups.has(groupValue)) groups.set(groupValue, { count: 0, probabilities: [], values: [], highProbCount: 0 });
      const group = groups.get(groupValue)!;
      group.count++;
      if (p.probability_event !== null) {
        group.probabilities.push(p.probability_event);
        if (p.probability_event >= HIGH_PROBABILITY_THRESHOLD) group.highProbCount++;
      }
      if (p.predicted_value !== null) group.values.push(p.predicted_value);
    });
    return Array.from(groups.entries()).map(([group, data]) => ({
      group, count: data.count,
      avgProbability: data.probabilities.length > 0 ? data.probabilities.reduce((a, b) => a + b, 0) / data.probabilities.length : null,
      avgValue: data.values.length > 0 ? data.values.reduce((a, b) => a + b, 0) / data.values.length : null,
      highProbabilityPercent: data.count > 0 ? (data.highProbCount / data.count) * 100 : 0
    })).sort((a, b) => (b.avgProbability || 0) - (a.avgProbability || 0));
  }, [predictions, filters.segmentField]);

  // Time projections
  const timeProjections = useMemo<TimeProjection[]>(() => {
    const horizonDays = filters.horizon;
    const periods: { label: string; days: number }[] = [];
    if (horizonDays <= 60) {
      for (let i = 1; i <= Math.ceil(horizonDays / 7); i++) periods.push({ label: `Semana ${i}`, days: i * 7 });
    } else if (horizonDays <= 180) {
      for (let i = 1; i <= Math.ceil(horizonDays / 30); i++) periods.push({ label: `Mês ${i}`, days: i * 30 });
    } else {
      for (let i = 1; i <= Math.ceil(horizonDays / 90); i++) periods.push({ label: `Trimestre ${i}`, days: i * 90 });
    }
    const totalExpected = kpis.expectedEvents;
    const totalFinancial = kpis.financialImpact;
    return periods.map((period, i) => ({
      period: period.label,
      expectedEvents: Math.round((totalExpected / periods.length) * (i + 1)),
      financialImpact: (totalFinancial / periods.length) * (i + 1)
    }));
  }, [filters.horizon, kpis.expectedEvents, kpis.financialImpact]);

  const availableSegmentFields = useMemo(() => {
    const fields = new Set<string>(metricsSegmentFields);
    const localFields: (keyof Prediction)[] = ['segment', 'age_group', 'region', 'state', 'city', 'product_category', 'channel', 'campaign', 'cohort'];
    localFields.forEach(field => {
      if (predictions.some(p => p[field] !== null)) fields.add(field);
    });
    return Array.from(fields);
  }, [metricsSegmentFields, predictions]);

  const updateFilters = (newFilters: Partial<DashboardFilters>) => {
    setFilters(prev => ({ ...prev, ...newFilters }));
  };

  const combinedError = error || metricsError;
  const combinedLoading = loading || metricsLoading;

  const data: BusinessDashboardData = {
    predictions, kpis, segmentationBands, groupSegmentation, timeProjections, availableSegmentFields,
    confidenceScore, confidenceInputs,
    recommendedThreshold, staleResults,
    selectionVersionScored, selectionVersionCurrent,
  };

  return {
    data, filters, updateFilters,
    loading: combinedLoading, error: combinedError,
    productionModel, runBatchPredictions, runningBatch,
    scoringBlocked,
    refetch: async () => { await Promise.all([fetchPredictions(), refetchMetrics()]); }
  };
}
