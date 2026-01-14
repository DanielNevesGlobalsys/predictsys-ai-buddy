import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { DashboardFilters, KPIData, SegmentationBand } from '../types';

/**
 * Hook para buscar métricas do dashboard via Edge Function
 * Usa agregações SQL no banco para performance
 */

interface DashboardMetricsResponse {
  horizon: number;
  mode: 'risk' | 'opportunity';
  segment: string;
  problem_type: string;
  summary_cards: {
    entities_with_prediction: number;
    high_risk_or_opportunity: number;
    expected_events: number;
    financial_impact: number;
    coverage: number;
    last_update: string | null;
  };
  probability_buckets: Array<{
    bucket: string;
    count: number;
    avg_value: number;
    expected_events: number;
    percent: number;
  }>;
  segments: Array<{
    field: string;
    values: string[];
  }>;
}

interface UseDashboardMetricsResult {
  kpis: KPIData;
  segmentationBands: SegmentationBand[];
  availableSegmentFields: string[];
  availableSegmentValues: Record<string, string[]>;
  problemType: string;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

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
        impact: result?.summary_cards?.financial_impact
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

  // =====================================================
  // Transformar resposta para tipos do frontend
  // =====================================================

  const kpis: KPIData = data?.summary_cards
    ? {
        // Entidades com previsão = COUNT(DISTINCT entity_id) com filtros
        totalEntities: data.summary_cards.entities_with_prediction,
        
        // Alto risco/oportunidade = COUNT onde prob >= 0.7
        highProbabilityCount: data.summary_cards.high_risk_or_opportunity,
        highProbabilityPercent: data.summary_cards.entities_with_prediction > 0
          ? (data.summary_cards.high_risk_or_opportunity / data.summary_cards.entities_with_prediction) * 100
          : 0,
        
        // Eventos esperados = SUM(probability)
        expectedEvents: Math.round(data.summary_cards.expected_events),
        expectedEventsPercent: data.summary_cards.entities_with_prediction > 0
          ? (data.summary_cards.expected_events / data.summary_cards.entities_with_prediction) * 100
          : 0,
        
        // Impacto financeiro = SUM(probability * potential_value)
        financialImpact: data.summary_cards.financial_impact,
        
        // Cobertura = entities_filtered / entities_total
        coveragePercent: data.summary_cards.coverage * 100,
        
        // Última atualização
        lastUpdateDate: data.summary_cards.last_update,
        daysSinceUpdate: data.summary_cards.last_update
          ? Math.floor((Date.now() - new Date(data.summary_cards.last_update).getTime()) / (1000 * 60 * 60 * 24))
          : null
      }
    : {
        totalEntities: 0,
        highProbabilityCount: 0,
        highProbabilityPercent: 0,
        expectedEvents: 0,
        expectedEventsPercent: 0,
        financialImpact: 0,
        coveragePercent: 0,
        lastUpdateDate: null,
        daysSinceUpdate: null
      };

  // Transformar buckets para SegmentationBand
  const segmentationBands: SegmentationBand[] = data?.probability_buckets
    ? data.probability_buckets.map((bucket, index) => {
        const ranges = [
          { min: 0, max: 0.2 },
          { min: 0.2, max: 0.4 },
          { min: 0.4, max: 0.6 },
          { min: 0.6, max: 0.8 },
          { min: 0.8, max: 1.0 }
        ];
        return {
          range: bucket.bucket,
          min: ranges[index]?.min ?? 0,
          max: ranges[index]?.max ?? 1,
          count: bucket.count,
          percent: bucket.percent,
          avgPotentialValue: bucket.avg_value > 0 ? bucket.avg_value : null
        };
      })
    : [];

  // Extrair campos de segmento disponíveis
  const availableSegmentFields = data?.segments?.map(s => s.field) ?? [];
  
  // Mapa de valores por campo
  const availableSegmentValues: Record<string, string[]> = {};
  data?.segments?.forEach(s => {
    availableSegmentValues[s.field] = s.values;
  });

  return {
    kpis,
    segmentationBands,
    availableSegmentFields,
    availableSegmentValues,
    problemType: data?.problem_type ?? 'classification',
    loading,
    error,
    refetch: fetchMetrics
  };
}
