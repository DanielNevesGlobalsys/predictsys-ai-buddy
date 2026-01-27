import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Prediction, KPIData } from '../types';

export interface SimulationParams {
  threshold: number; // 0.5 to 0.95
  percentActioned: number; // 5 to 100
}

export interface SimulationResults {
  entitiesToAction: number;
  expectedEventsCaptured: number;
  captureRate: number;
  financialImpact: number;
  costTotal: number;
  netROI: number;
}

export interface BusinessConfig {
  average_sale_value: number;
  average_margin_percent: number;
  cost_per_contact: number;
  impact_window_days: number;
  baseline_conversion_percent: number;
}

const DEFAULT_CONFIG: BusinessConfig = {
  average_sale_value: 500,
  average_margin_percent: 30,
  cost_per_contact: 5,
  impact_window_days: 30,
  baseline_conversion_percent: 10,
};

interface UseSimulationParams {
  projectId: string;
  predictions: Prediction[];
  baseKpis: KPIData;
  problemType: string;
}

export function useSimulation({ projectId, predictions, baseKpis, problemType }: UseSimulationParams) {
  const [params, setParams] = useState<SimulationParams>({
    threshold: 0.7,
    percentActioned: 20,
  });
  const [businessConfig, setBusinessConfig] = useState<BusinessConfig>(DEFAULT_CONFIG);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Fetch business config
  useEffect(() => {
    async function fetchBusinessConfig() {
      if (!projectId) return;
      
      setLoadingConfig(true);
      try {
        const { data } = await supabase
          .from('project_business_config')
          .select('*')
          .eq('project_id', projectId)
          .maybeSingle();
        
        if (data) {
          setBusinessConfig({
            average_sale_value: data.average_sale_value || DEFAULT_CONFIG.average_sale_value,
            average_margin_percent: data.average_margin_percent || DEFAULT_CONFIG.average_margin_percent,
            cost_per_contact: data.cost_per_contact || DEFAULT_CONFIG.cost_per_contact,
            impact_window_days: data.impact_window_days || DEFAULT_CONFIG.impact_window_days,
            baseline_conversion_percent: data.baseline_conversion_percent || DEFAULT_CONFIG.baseline_conversion_percent,
          });
        }
      } catch (err) {
        console.error('Error fetching business config:', err);
      } finally {
        setLoadingConfig(false);
      }
    }
    
    fetchBusinessConfig();
  }, [projectId]);

  // Calculate simulation results based on params
  const simulationResults = useMemo<SimulationResults>(() => {
    if (problemType !== 'classification' || predictions.length === 0) {
      return {
        entitiesToAction: 0,
        expectedEventsCaptured: 0,
        captureRate: 0,
        financialImpact: 0,
        costTotal: 0,
        netROI: 0,
      };
    }

    // Sort predictions by probability descending
    const sorted = [...predictions]
      .filter(p => p.probability_event !== null)
      .sort((a, b) => (b.probability_event || 0) - (a.probability_event || 0));

    // Filter by threshold
    const aboveThreshold = sorted.filter(p => (p.probability_event || 0) >= params.threshold);

    // Calculate max entities to action based on percentage
    const maxEntitiesToAction = Math.ceil((params.percentActioned / 100) * sorted.length);
    
    // Take minimum of threshold-filtered and percentage-limited
    const actioned = aboveThreshold.slice(0, maxEntitiesToAction);

    // Calculate expected events captured (sum of probabilities)
    const expectedEventsCaptured = actioned.reduce((sum, p) => sum + (p.probability_event || 0), 0);

    // Total expected events in entire base
    const totalExpected = sorted.reduce((sum, p) => sum + (p.probability_event || 0), 0);
    const captureRate = totalExpected > 0 ? (expectedEventsCaptured / totalExpected) * 100 : 0;

    // Calculate financial impact using business config
    // Impact = expectedEvents * average_sale_value * margin_percent
    const grossRevenue = expectedEventsCaptured * businessConfig.average_sale_value;
    const financialImpact = grossRevenue * (businessConfig.average_margin_percent / 100);
    
    // Calculate costs
    const costTotal = actioned.length * businessConfig.cost_per_contact;
    
    // Net ROI = Impact - Costs
    const netROI = financialImpact - costTotal;

    return {
      entitiesToAction: actioned.length,
      expectedEventsCaptured: Math.round(expectedEventsCaptured),
      captureRate,
      financialImpact,
      costTotal,
      netROI,
    };
  }, [predictions, params.threshold, params.percentActioned, problemType, businessConfig]);

  // Simulated KPIs - adjusted based on simulation params
  const simulatedKpis = useMemo<KPIData>(() => {
    return {
      ...baseKpis,
      // Override with simulation values
      highProbabilityCount: simulationResults.entitiesToAction,
      highProbabilityPercent: baseKpis.totalEntities > 0 
        ? (simulationResults.entitiesToAction / baseKpis.totalEntities) * 100 
        : 0,
      expectedEvents: simulationResults.expectedEventsCaptured,
      expectedEventsPercent: baseKpis.totalEntities > 0
        ? (simulationResults.expectedEventsCaptured / baseKpis.totalEntities) * 100
        : 0,
      financialImpact: simulationResults.netROI,
    };
  }, [baseKpis, simulationResults]);

  const updateParams = useCallback((newParams: Partial<SimulationParams>) => {
    setParams(prev => ({ ...prev, ...newParams }));
  }, []);

  const resetParams = useCallback(() => {
    setParams({ threshold: 0.7, percentActioned: 20 });
  }, []);

  return {
    params,
    updateParams,
    resetParams,
    simulationResults,
    simulatedKpis,
    businessConfig,
    loadingConfig,
    isSimulationActive: params.threshold !== 0.7 || params.percentActioned !== 20,
  };
}
