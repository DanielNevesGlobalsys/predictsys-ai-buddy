import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Calculator, Users, Target, DollarSign } from 'lucide-react';
import type { Prediction, DashboardFilters } from './types';

interface WhatIfSimulationProps {
  predictions: Prediction[];
  problemType: string;
  viewMode: DashboardFilters['viewMode'];
}

export function WhatIfSimulation({ predictions, problemType, viewMode }: WhatIfSimulationProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
  const [threshold, setThreshold] = useState([0.7]);
  const [percentActioned, setPercentActioned] = useState([20]);
  
  const simulation = useMemo(() => {
    if (!isClassification || predictions.length === 0) {
      return {
        entitiesToAction: 0,
        expectedEventsCaptured: 0,
        financialImpact: 0,
        captureRate: 0
      };
    }
    
    // Sort by probability descending
    const sorted = [...predictions]
      .filter(p => p.probability_event !== null)
      .sort((a, b) => (b.probability_event || 0) - (a.probability_event || 0));
    
    // Filter by threshold
    const aboveThreshold = sorted.filter(p => (p.probability_event || 0) >= threshold[0]);
    
    // Apply percent limit
    const entitiesToAction = Math.ceil((percentActioned[0] / 100) * predictions.length);
    const actioned = sorted.slice(0, Math.min(entitiesToAction, aboveThreshold.length));
    
    // Calculate expected events captured
    const expectedEventsCaptured = actioned.reduce((sum, p) => sum + (p.probability_event || 0), 0);
    
    // Calculate financial impact
    const financialImpact = actioned.reduce((sum, p) => {
      const prob = p.probability_event || 0;
      const value = p.potential_value || 0;
      return sum + (prob * value);
    }, 0);
    
    // Total expected events in base
    const totalExpected = sorted.reduce((sum, p) => sum + (p.probability_event || 0), 0);
    const captureRate = totalExpected > 0 ? (expectedEventsCaptured / totalExpected) * 100 : 0;
    
    return {
      entitiesToAction: actioned.length,
      expectedEventsCaptured: Math.round(expectedEventsCaptured),
      financialImpact,
      captureRate
    };
  }, [predictions, threshold, percentActioned, isClassification]);
  
  const formatCurrency = (val: number) => {
    if (val >= 1000000) return `R$ ${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `R$ ${(val / 1000).toFixed(1)}K`;
    return `R$ ${val.toFixed(0)}`;
  };

  if (!isClassification) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calculator className="w-5 h-5" />
            {t('businessDashboard.simulation.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.simulation.classificationOnly')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="w-5 h-5" />
          {t('businessDashboard.simulation.title')}
        </CardTitle>
        <CardDescription>
          {t('businessDashboard.simulation.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid lg:grid-cols-2 gap-8">
          {/* Controls */}
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex justify-between">
                <Label>{t('businessDashboard.simulation.threshold')}</Label>
                <span className="text-sm font-medium">{(threshold[0] * 100).toFixed(0)}%</span>
              </div>
              <Slider
                value={threshold}
                onValueChange={setThreshold}
                min={0.5}
                max={0.95}
                step={0.05}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                {t('businessDashboard.simulation.thresholdDesc')}
              </p>
            </div>
            
            <div className="space-y-3">
              <div className="flex justify-between">
                <Label>{t('businessDashboard.simulation.percentActioned')}</Label>
                <span className="text-sm font-medium">{percentActioned[0]}%</span>
              </div>
              <Slider
                value={percentActioned}
                onValueChange={setPercentActioned}
                min={5}
                max={100}
                step={5}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                {t('businessDashboard.simulation.percentActionedDesc')}
              </p>
            </div>
          </div>
          
          {/* Results */}
          <div className="grid grid-cols-2 gap-4">
            <Card className="p-4 bg-muted/50">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground">
                  {t('businessDashboard.simulation.entitiesToAction')}
                </span>
              </div>
              <p className="text-2xl font-bold">{simulation.entitiesToAction.toLocaleString()}</p>
            </Card>
            
            <Card className="p-4 bg-muted/50">
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-4 h-4 text-secondary" />
                <span className="text-xs text-muted-foreground">
                  {viewMode === 'risk' 
                    ? t('businessDashboard.simulation.eventsCaptured')
                    : t('businessDashboard.simulation.opportunitiesCaptured')
                  }
                </span>
              </div>
              <p className="text-2xl font-bold">{simulation.expectedEventsCaptured}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {simulation.captureRate.toFixed(1)}% {t('businessDashboard.simulation.ofTotal')}
              </p>
            </Card>
            
            <Card className="p-4 bg-muted/50 col-span-2">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-accent" />
                <span className="text-xs text-muted-foreground">
                  {t('businessDashboard.simulation.estimatedImpact')}
                </span>
              </div>
              <p className="text-2xl font-bold">{formatCurrency(simulation.financialImpact)}</p>
            </Card>
          </div>
        </div>
        
        <div className="mt-6 p-3 bg-muted/50 rounded-lg">
          <p className="text-sm text-muted-foreground">
            {t('businessDashboard.simulation.interpretation')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
