import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardMetrics } from './useDashboardMetrics';
import { trackEventWithTiming } from '@/lib/platformTracking';
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

/**
 * Hook principal do Business Dashboard
 * 
 * Usa a Edge Function calculate-dashboard-metrics para obter:
 * - KPIs agregados (entities, high_risk, expected_events, financial_impact, coverage)
 * - Segmentação por probabilidade (buckets 0-20%, 20-40%, etc.)
 * 
 * Mantém lógica local para:
 * - Buscar previsões para componentes que precisam de dados individuais (ActionableList, etc.)
 * - Cálculos de projeção temporal
 * - Segmentação por grupo
 */
export function useBusinessDashboard(projectId: string) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [productionModel, setProductionModel] = useState<ProductionModelInfo | null>(null);
  const [runningBatch, setRunningBatch] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const autoRunTriggered = useRef(false);
  
  const [filters, setFilters] = useState<DashboardFilters>({
    dataset: 'latest',
    dateRange: { from: null, to: null },
    horizon: 30,
    segmentField: null,
    segmentValue: null,
    viewMode: 'risk'
  });

  // =====================================================
  // Hook de métricas agregadas via Edge Function
  // =====================================================
  const {
    kpis,
    segmentationBands,
    availableSegmentFields: metricsSegmentFields,
    problemType: metricsProblemType,
    loading: metricsLoading,
    error: metricsError,
    refetch: refetchMetrics
  } = useDashboardMetrics(projectId, filters);

  // Fetch production model
  useEffect(() => {
    async function fetchProductionModel() {
      try {
        const { data: model } = await supabase
          .from('project_models')
          .select('id, algorithm_name')
          .eq('project_id', projectId)
          .eq('is_production', true)
          .eq('status', 'trained')
          .maybeSingle();
        
        setProductionModel(model);
      } catch (err) {
        console.error('Error fetching production model:', err);
      }
    }
    
    if (projectId) {
      fetchProductionModel();
    }
  }, [projectId]);

  // Fetch predictions - para componentes que precisam de dados individuais
  // Limite de 1000 para ActionableList, CohortComparison, etc.
  const fetchPredictions = useCallback(async () => {
    if (!projectId) return;
    
    setLoading(true);
    
    try {
      let query = supabase
        .from('predictions')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_latest', true)
        .lte('horizon_days', filters.horizon);
      
      if (filters.segmentField && filters.segmentValue) {
        query = query.eq(filters.segmentField as keyof Prediction, filters.segmentValue);
      }
      
      // Limite para componentes que precisam de dados individuais
      query = query.limit(1000);
      
      const { data, error: fetchError } = await query;
      
      if (fetchError) {
        console.error('Error fetching predictions:', fetchError);
        setError(fetchError.message);
        setPredictions([]);
      } else {
        setPredictions((data as Prediction[]) || []);
        setError(null);
      }
    } catch (err) {
      console.error('Error fetching predictions:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setPredictions([]);
    } finally {
      setLoading(false);
      setInitialLoadComplete(true);
    }
  }, [projectId, filters.horizon, filters.segmentField, filters.segmentValue]);

  useEffect(() => {
    fetchPredictions();
  }, [fetchPredictions]);

  // Run batch predictions with multi-pass support for large datasets
  const runBatchPredictions = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!projectId || !productionModel) {
      return { success: false, error: 'Nenhum modelo em produção' };
    }
    
    const startTime = Date.now();
    setRunningBatch(true);
    setError(null);
    
    try {
      let passOffset = 0;
      let batchIdToUse: string | undefined;
      let runningStatsState: any = null;
      let totalScoredPrev = 0;
      let totalInvalidPrev = 0;
      let passNumber = 0;

      // Multi-pass loop: keeps calling until the function says continue=false
      while (true) {
        passNumber++;
        console.log(`[Scoring] Client pass #${passNumber}, offset=${passOffset}`);

        const { data, error: invokeError } = await supabase.functions.invoke('run-batch-predictions', {
          body: {
            project_id: projectId,
            horizon_days: filters.horizon,
            pass_offset: passOffset,
            batch_id: batchIdToUse,
            running_stats: runningStatsState,
            total_scored_prev: totalScoredPrev,
            total_invalid_prev: totalInvalidPrev,
          }
        });

        if (invokeError) {
          console.error('Error invoking batch predictions:', invokeError);
          const errorMsg = invokeError.message || 'Erro ao gerar previsões';
          setError(errorMsg);
          
          trackEventWithTiming({
            event_type: "job_error",
            project_id: projectId,
            status: "error",
            metadata: { stage: "prediction", error_message: errorMsg, pass: passNumber },
            source: "app",
          }, startTime);
          
          return { success: false, error: errorMsg };
        }

        if (data?.error) {
          console.error('Batch predictions error:', data.error);
          setError(data.error);
          
          trackEventWithTiming({
            event_type: "job_error",
            project_id: projectId,
            status: "error",
            metadata: { stage: "prediction", error_message: data.error, pass: passNumber },
            source: "app",
          }, startTime);
          
          return { success: false, error: data.error };
        }

        console.log(`[Scoring] Pass #${passNumber} result:`, {
          continue: data?.continue,
          pass_rows: data?.pass_rows_scored,
          total: data?.total_scored_prev || data?.rows_scored,
        });

        // If continuation needed, update state and loop
        if (data?.continue) {
          passOffset = data.next_offset;
          batchIdToUse = data.batch_id;
          runningStatsState = data.running_stats;
          totalScoredPrev = data.total_scored_prev;
          totalInvalidPrev = data.total_invalid_prev;
          continue;
        }

        // Final pass complete
        console.log('Batch predictions complete:', data);

        trackEventWithTiming({
          event_type: "prediction_run",
          project_id: projectId,
          status: "success",
          metadata: { rows_scored: data?.rows_scored, passes: passNumber },
          source: "app",
        }, startTime);

        await Promise.all([fetchPredictions(), refetchMetrics()]);
        return { success: true };
      }
    } catch (err) {
      console.error('Error running batch predictions:', err);
      const errorMsg = err instanceof Error ? err.message : 'Erro ao gerar previsões';
      setError(errorMsg);
      
      trackEventWithTiming({
        event_type: "job_error",
        project_id: projectId,
        status: "error",
        metadata: { stage: "prediction", error_message: errorMsg },
        source: "app",
      }, startTime);
      
      return { success: false, error: errorMsg };
    } finally {
      setRunningBatch(false);
    }
  }, [projectId, productionModel, filters.horizon, fetchPredictions, refetchMetrics]);

  // Auto-run predictions when entering dashboard with no predictions
  useEffect(() => {
    if (
      initialLoadComplete && 
      !autoRunTriggered.current && 
      predictions.length === 0 && 
      kpis.totalEntities === 0 &&
      productionModel && 
      !runningBatch && 
      !loading &&
      !metricsLoading
    ) {
      console.log('Auto-triggering batch predictions...');
      autoRunTriggered.current = true;
      runBatchPredictions();
    }
  }, [initialLoadComplete, predictions.length, kpis.totalEntities, productionModel, runningBatch, loading, metricsLoading, runBatchPredictions]);

  // Calculate group segmentation - local calculation from sampled predictions
  const groupSegmentation = useMemo<GroupSegmentation[]>(() => {
    const groupField = filters.segmentField || 'segment';
    const groups = new Map<string, { count: number; probabilities: number[]; values: number[]; highProbCount: number }>();
    
    predictions.forEach(p => {
      const groupValue = p[groupField as keyof Prediction] as string | null;
      if (!groupValue) return;
      
      if (!groups.has(groupValue)) {
        groups.set(groupValue, { count: 0, probabilities: [], values: [], highProbCount: 0 });
      }
      
      const group = groups.get(groupValue)!;
      group.count++;
      
      if (p.probability_event !== null) {
        group.probabilities.push(p.probability_event);
        if (p.probability_event >= HIGH_PROBABILITY_THRESHOLD) {
          group.highProbCount++;
        }
      }
      
      if (p.predicted_value !== null) {
        group.values.push(p.predicted_value);
      }
    });
    
    return Array.from(groups.entries()).map(([group, data]) => ({
      group,
      count: data.count,
      avgProbability: data.probabilities.length > 0 
        ? data.probabilities.reduce((a, b) => a + b, 0) / data.probabilities.length 
        : null,
      avgValue: data.values.length > 0 
        ? data.values.reduce((a, b) => a + b, 0) / data.values.length 
        : null,
      highProbabilityPercent: data.count > 0 ? (data.highProbCount / data.count) * 100 : 0
    })).sort((a, b) => (b.avgProbability || 0) - (a.avgProbability || 0));
  }, [predictions, filters.segmentField]);

  // Calculate time projections - based on aggregated metrics
  const timeProjections = useMemo<TimeProjection[]>(() => {
    const horizonDays = filters.horizon;
    
    // Generate periods based on horizon
    const periods: { label: string; days: number }[] = [];
    
    if (horizonDays <= 60) {
      // Weekly for short horizons
      for (let i = 1; i <= Math.ceil(horizonDays / 7); i++) {
        periods.push({ label: `Semana ${i}`, days: i * 7 });
      }
    } else if (horizonDays <= 180) {
      // Monthly for medium horizons
      for (let i = 1; i <= Math.ceil(horizonDays / 30); i++) {
        periods.push({ label: `Mês ${i}`, days: i * 30 });
      }
    } else {
      // Quarterly for long horizons
      for (let i = 1; i <= Math.ceil(horizonDays / 90); i++) {
        periods.push({ label: `Trimestre ${i}`, days: i * 90 });
      }
    }
    
    // Use KPIs agregados da Edge Function
    const totalExpected = kpis.expectedEvents;
    const totalFinancial = kpis.financialImpact;
    
    return periods.map((period, i) => ({
      period: period.label,
      expectedEvents: Math.round((totalExpected / periods.length) * (i + 1)),
      financialImpact: (totalFinancial / periods.length) * (i + 1)
    }));
  }, [filters.horizon, kpis.expectedEvents, kpis.financialImpact]);

  // Combine available segment fields from metrics and local predictions
  const availableSegmentFields = useMemo(() => {
    const fields = new Set<string>(metricsSegmentFields);
    
    // Também verificar previsões locais
    const localFields: (keyof Prediction)[] = ['segment', 'age_group', 'region', 'state', 'city', 'product_category', 'channel', 'campaign', 'cohort'];
    localFields.forEach(field => {
      if (predictions.some(p => p[field] !== null)) {
        fields.add(field);
      }
    });
    
    return Array.from(fields);
  }, [metricsSegmentFields, predictions]);

  const updateFilters = (newFilters: Partial<DashboardFilters>) => {
    setFilters(prev => ({ ...prev, ...newFilters }));
  };

  // Combinar erros
  const combinedError = error || metricsError;
  const combinedLoading = loading || metricsLoading;

  const data: BusinessDashboardData = {
    predictions,
    kpis,
    segmentationBands,
    groupSegmentation,
    timeProjections,
    availableSegmentFields
  };

  return {
    data,
    filters,
    updateFilters,
    loading: combinedLoading,
    error: combinedError,
    productionModel,
    runBatchPredictions,
    runningBatch,
    refetch: async () => {
      await Promise.all([fetchPredictions(), refetchMetrics()]);
    }
  };
}
