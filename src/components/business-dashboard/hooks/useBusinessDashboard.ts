import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { 
  Prediction, 
  DashboardFilters, 
  KPIData, 
  SegmentationBand, 
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
  
  const [filters, setFilters] = useState<DashboardFilters>({
    dataset: 'latest',
    dateRange: { from: null, to: null },
    horizon: 30,
    segmentField: null,
    segmentValue: null,
    viewMode: 'risk'
  });

  // Fetch production model
  useEffect(() => {
    async function fetchProductionModel() {
      const { data: model } = await supabase
        .from('project_models')
        .select('id, algorithm_name')
        .eq('project_id', projectId)
        .eq('is_production', true)
        .eq('status', 'trained')
        .maybeSingle();
      
      setProductionModel(model);
    }
    
    if (projectId) {
      fetchProductionModel();
    }
  }, [projectId]);

  // Fetch predictions filtered by production model
  const fetchPredictions = useCallback(async () => {
    if (!projectId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      let query = supabase
        .from('predictions')
        .select('*')
        .eq('project_id', projectId);
      
      // Filter by production model if available
      if (productionModel?.id) {
        query = query.contains('metadata', { model_id: productionModel.id });
      }
      
      if (filters.dataset === 'latest') {
        query = query.eq('is_latest', true);
      }
      
      if (filters.dateRange.from) {
        query = query.gte('reference_date', filters.dateRange.from.toISOString());
      }
      
      if (filters.dateRange.to) {
        query = query.lte('reference_date', filters.dateRange.to.toISOString());
      }
      
      if (filters.segmentField && filters.segmentValue) {
        query = query.eq(filters.segmentField as keyof Prediction, filters.segmentValue);
      }
      
      const { data, error: fetchError } = await query;
      
      if (fetchError) throw fetchError;
      
      setPredictions((data as Prediction[]) || []);
    } catch (err) {
      console.error('Error fetching predictions:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [projectId, productionModel?.id, filters.dataset, filters.dateRange, filters.segmentField, filters.segmentValue]);

  useEffect(() => {
    fetchPredictions();
  }, [fetchPredictions]);

  // Run batch predictions
  const runBatchPredictions = useCallback(async () => {
    if (!projectId) return;
    
    setRunningBatch(true);
    setError(null);
    
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('run-batch-predictions', {
        body: { project_id: projectId, horizon_days: filters.horizon }
      });
      
      if (invokeError) throw invokeError;
      
      console.log('Batch predictions result:', data);
      
      // Refetch predictions after batch is done
      await fetchPredictions();
      
      return data;
    } catch (err) {
      console.error('Error running batch predictions:', err);
      setError(err instanceof Error ? err.message : 'Erro ao gerar previsões');
      throw err;
    } finally {
      setRunningBatch(false);
    }
  }, [projectId, filters.horizon, fetchPredictions]);

  // Calculate KPIs
  const kpis = useMemo<KPIData>(() => {
    if (predictions.length === 0) {
      return {
        totalEntities: 0,
        highProbabilityCount: 0,
        highProbabilityPercent: 0,
        expectedEvents: 0,
        expectedEventsPercent: 0,
        financialImpact: 0,
        coveragePercent: 100,
        lastUpdateDate: null,
        daysSinceUpdate: null
      };
    }

    const isClassification = predictions[0]?.problem_type === 'classification';
    
    const totalEntities = predictions.length;
    
    let highProbabilityCount = 0;
    let expectedEvents = 0;
    let financialImpact = 0;
    let lastUpdateDate: string | null = null;
    
    predictions.forEach(p => {
      if (isClassification && p.probability_event !== null) {
        if (p.probability_event >= HIGH_PROBABILITY_THRESHOLD) {
          highProbabilityCount++;
        }
        expectedEvents += p.probability_event;
        
        if (p.potential_value) {
          financialImpact += p.probability_event * p.potential_value;
        }
      } else if (!isClassification && p.predicted_value !== null) {
        expectedEvents += p.predicted_value;
        financialImpact += p.predicted_value;
      }
      
      if (!lastUpdateDate || p.prediction_date > lastUpdateDate) {
        lastUpdateDate = p.prediction_date;
      }
    });
    
    const daysSinceUpdate = lastUpdateDate 
      ? Math.floor((Date.now() - new Date(lastUpdateDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    
    return {
      totalEntities,
      highProbabilityCount,
      highProbabilityPercent: totalEntities > 0 ? (highProbabilityCount / totalEntities) * 100 : 0,
      expectedEvents: Math.round(expectedEvents),
      expectedEventsPercent: totalEntities > 0 ? (expectedEvents / totalEntities) * 100 : 0,
      financialImpact,
      coveragePercent: 100,
      lastUpdateDate,
      daysSinceUpdate
    };
  }, [predictions]);

  // Calculate segmentation bands
  const segmentationBands = useMemo<SegmentationBand[]>(() => {
    const isClassification = predictions[0]?.problem_type === 'classification';
    
    if (isClassification) {
      const bands: SegmentationBand[] = [
        { range: '0-20%', min: 0, max: 0.2, count: 0, percent: 0, avgPotentialValue: null },
        { range: '20-40%', min: 0.2, max: 0.4, count: 0, percent: 0, avgPotentialValue: null },
        { range: '40-60%', min: 0.4, max: 0.6, count: 0, percent: 0, avgPotentialValue: null },
        { range: '60-80%', min: 0.6, max: 0.8, count: 0, percent: 0, avgPotentialValue: null },
        { range: '80-100%', min: 0.8, max: 1.0, count: 0, percent: 0, avgPotentialValue: null }
      ];
      
      const potentialValues: number[][] = [[], [], [], [], []];
      
      predictions.forEach(p => {
        if (p.probability_event === null) return;
        
        let bandIndex = Math.min(Math.floor(p.probability_event * 5), 4);
        bands[bandIndex].count++;
        
        if (p.potential_value) {
          potentialValues[bandIndex].push(p.potential_value);
        }
      });
      
      const total = predictions.length;
      bands.forEach((band, i) => {
        band.percent = total > 0 ? (band.count / total) * 100 : 0;
        if (potentialValues[i].length > 0) {
          band.avgPotentialValue = potentialValues[i].reduce((a, b) => a + b, 0) / potentialValues[i].length;
        }
      });
      
      return bands;
    } else {
      // For regression, use quintiles
      const values = predictions
        .map(p => p.predicted_value)
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      
      if (values.length === 0) return [];
      
      const quintileSize = Math.ceil(values.length / 5);
      const bands: SegmentationBand[] = [];
      
      for (let i = 0; i < 5; i++) {
        const start = i * quintileSize;
        const end = Math.min((i + 1) * quintileSize, values.length);
        const quintileValues = values.slice(start, end);
        
        if (quintileValues.length > 0) {
          bands.push({
            range: `Q${i + 1}`,
            min: quintileValues[0],
            max: quintileValues[quintileValues.length - 1],
            count: quintileValues.length,
            percent: (quintileValues.length / values.length) * 100,
            avgPotentialValue: null
          });
        }
      }
      
      return bands;
    }
  }, [predictions]);

  // Calculate group segmentation
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

  // Calculate time projections
  const timeProjections = useMemo<TimeProjection[]>(() => {
    const isClassification = predictions[0]?.problem_type === 'classification';
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
    
    // Distribute predictions across periods (simplified linear distribution)
    const totalExpected = predictions.reduce((sum, p) => {
      if (isClassification) return sum + (p.probability_event || 0);
      return sum + (p.predicted_value || 0);
    }, 0);
    
    const totalFinancial = predictions.reduce((sum, p) => {
      if (isClassification && p.probability_event && p.potential_value) {
        return sum + (p.probability_event * p.potential_value);
      }
      return sum + (p.predicted_value || 0);
    }, 0);
    
    return periods.map((period, i) => ({
      period: period.label,
      expectedEvents: Math.round((totalExpected / periods.length) * (i + 1)),
      financialImpact: (totalFinancial / periods.length) * (i + 1)
    }));
  }, [predictions, filters.horizon]);

  // Available segment fields
  const availableSegmentFields = useMemo(() => {
    const fields: (keyof Prediction)[] = ['segment', 'age_group', 'region', 'state', 'city', 'product_category', 'channel', 'campaign', 'cohort'];
    
    return fields.filter(field => 
      predictions.some(p => p[field] !== null)
    );
  }, [predictions]);

  const updateFilters = (newFilters: Partial<DashboardFilters>) => {
    setFilters(prev => ({ ...prev, ...newFilters }));
  };

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
    loading,
    error,
    productionModel,
    runBatchPredictions,
    runningBatch,
    refetch: fetchPredictions
  };
}
