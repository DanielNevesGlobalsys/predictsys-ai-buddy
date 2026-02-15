import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { DashboardFilters, KPIData, SegmentationBand } from '../types';

/**
 * Hook para buscar métricas do dashboard via Edge Function
 * Usa agregações SQL no banco para performance
 */

interface DashboardMetricsResponse {
  dashboard_status?: string;
  message?: string;
  ctas?: Array<{ label: string; action: string; step?: number }>;
  horizon: number;
  mode: 'risk' | 'opportunity';
  segment: string;
  problem_type: string;
  recommended_threshold?: number;
  stale_results?: boolean;
  selection_version_scored?: number | null;
  selection_version_current?: number | null;
  confidence_score?: number | null;
  confidence_inputs?: {
    predictability_score: number | null;
    coverage_pct: number | null;
    missing_feature_pct: number | null;
    sanity_fail: boolean;
  };
  summary_cards: {
    entities_with_prediction: number;
    high_risk_or_opportunity: number;
    expected_events: number;
    financial_impact: number;
    predicted_total_value: number;
    predicted_avg_value: number;
    coverage: number;
    last_update: string | null;
  };
  probability_buckets: Array<{
    bucket: string;
    count: number;
    avg_value: number;
    total_value?: number;
    expected_events: number;
    percent: number;
  }>;
  segments: Array<{
    field: string;
    values: string[];
    null_count?: number;
    null_pct?: number;
  }>;
  diagnostics?: Record<string, unknown>;
}

interface UseDashboardMetricsResult {
  kpis: KPIData;
  segmentationBands: SegmentationBand[];
  availableSegmentFields: string[];
  availableSegmentValues: Record<string, string[]>;
  segmentNullCoverage: Record<string, { null_count: number; null_pct: number }>;
  problemType: string;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  dashboardStatus: string | null;
  dashboardMessage: string | null;
  dashboardCtas: Array<{ label: string; action: string; step?: number }>;
  confidenceScore: number | null;
  confidenceInputs: {
    predictability_score: number | null;
    coverage_pct: number | null;
    missing_feature_pct: number | null;
    sanity_fail: boolean;
  } | null;
  recommendedThreshold: number | null;
  staleResults: boolean;
  selectionVersionScored: number | null;
  selectionVersionCurrent: number | null;
}

const DEFAULT_KPIS: KPIData = {
  totalEntities: 0,
  highProbabilityCount: 0,
  highProbabilityPercent: 0,
  expectedEvents: 0,
  expectedEventsPercent: 0,
  financialImpact: 0,
  coveragePercent: 0,
  lastUpdateDate: null,
  daysSinceUpdate: null,
  predictedTotalValue: 0,
  predictedAvgValue: 0,
};

export function useDashboardMetrics(
  projectId: string,
  filters: DashboardFilters
): UseDashboardMetricsResult {
  const [data, setData] = useState<DashboardMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    if (!projectId) return;

    setLoading(true);
    setError(null);

    try {
      const payload = {
        project_id: projectId,
        mode: filters.viewMode,
        horizon: filters.horizon,
        segment_field: filters.segmentField,
        segment_value: filters.segmentValue
      };

      console.log('[useDashboardMetrics] Fetching metrics:', payload);

      const { data: result, error: invokeError } = await supabase.functions.invoke(
        'calculate-dashboard-metrics',
        { body: payload }
      );

      if (invokeError) {
        console.error('[useDashboardMetrics] Error:', invokeError);
        setError(invokeError.message);
        return;
      }

      if (result?.error) {
        console.error('[useDashboardMetrics] API Error:', result.error);
        setError(result.error);
        return;
      }

      console.log('[useDashboardMetrics] Metrics received:', {
        entities: result?.summary_cards?.entities_with_prediction,
        highRisk: result?.summary_cards?.high_risk_or_opportunity,
        expected: result?.summary_cards?.expected_events,
        impact: result?.summary_cards?.financial_impact,
        predTotal: result?.summary_cards?.predicted_total_value,
        predAvg: result?.summary_cards?.predicted_avg_value,
        modelQualityFlag: result?.modelQualityFlag,
        diagnostic: result?.diagnostic,
      });

      setData(result);
    } catch (err) {
      console.error('[useDashboardMetrics] Exception:', err);
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
    } finally {
      setLoading(false);
    }
  }, [projectId, filters.viewMode, filters.horizon, filters.segmentField, filters.segmentValue]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Transform response to frontend types
  const kpis: KPIData = data?.summary_cards
    ? {
        totalEntities: data.summary_cards.entities_with_prediction,
        highProbabilityCount: data.summary_cards.high_risk_or_opportunity,
        highProbabilityPercent: data.summary_cards.entities_with_prediction > 0
          ? (data.summary_cards.high_risk_or_opportunity / data.summary_cards.entities_with_prediction) * 100
          : 0,
        expectedEvents: Math.round(data.summary_cards.expected_events),
        expectedEventsPercent: data.summary_cards.entities_with_prediction > 0
          ? (data.summary_cards.expected_events / data.summary_cards.entities_with_prediction) * 100
          : 0,
        financialImpact: data.summary_cards.financial_impact,
        coveragePercent: data.summary_cards.coverage * 100,
        lastUpdateDate: data.summary_cards.last_update,
        daysSinceUpdate: data.summary_cards.last_update
          ? Math.floor((Date.now() - new Date(data.summary_cards.last_update).getTime()) / (1000 * 60 * 60 * 24))
          : null,
        predictedTotalValue: data.summary_cards.predicted_total_value || 0,
        predictedAvgValue: data.summary_cards.predicted_avg_value || 0,
      }
    : DEFAULT_KPIS;

  // Transform buckets to SegmentationBand
  const segmentationBands: SegmentationBand[] = data?.probability_buckets
    ? data.probability_buckets.map((bucket, index) => {
        // For classification, use fixed probability ranges
        const isClassification = (data.problem_type || 'classification') === 'classification';
        const classificationRanges = [
          { min: 0, max: 0.2 },
          { min: 0.2, max: 0.4 },
          { min: 0.4, max: 0.6 },
          { min: 0.6, max: 0.8 },
          { min: 0.8, max: 1.0 }
        ];
        return {
          range: bucket.bucket,
          min: isClassification ? (classificationRanges[index]?.min ?? 0) : index,
          max: isClassification ? (classificationRanges[index]?.max ?? 1) : index + 1,
          count: bucket.count,
          percent: bucket.percent,
          avgPotentialValue: bucket.avg_value > 0 ? bucket.avg_value : null,
          totalValue: bucket.total_value || 0,
        };
      })
    : [];

  const availableSegmentFields = data?.segments?.map(s => s.field) ?? [];
  
  const availableSegmentValues: Record<string, string[]> = {};
  const segmentNullCoverage: Record<string, { null_count: number; null_pct: number }> = {};
  data?.segments?.forEach(s => {
    availableSegmentValues[s.field] = s.values;
    if (s.null_count != null && s.null_pct != null) {
      segmentNullCoverage[s.field] = { null_count: s.null_count, null_pct: s.null_pct };
    }
  });

  return {
    kpis,
    segmentationBands,
    availableSegmentFields,
    availableSegmentValues,
    segmentNullCoverage,
    problemType: data?.problem_type ?? 'classification',
    loading,
    error,
    refetch: fetchMetrics,
    dashboardStatus: data?.dashboard_status ?? null,
    dashboardMessage: data?.message ?? null,
    dashboardCtas: data?.ctas ?? [],
    confidenceScore: data?.confidence_score ?? null,
    confidenceInputs: data?.confidence_inputs ?? null,
    recommendedThreshold: data?.recommended_threshold ?? null,
    staleResults: data?.stale_results ?? false,
    selectionVersionScored: data?.selection_version_scored ?? null,
    selectionVersionCurrent: data?.selection_version_current ?? null,
  };
}
