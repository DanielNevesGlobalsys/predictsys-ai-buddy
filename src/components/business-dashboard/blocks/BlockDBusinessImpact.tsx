import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Rocket } from 'lucide-react';
import { BusinessKPICards } from '../BusinessKPICards';
import { ActionableList } from '../ActionableList';
import { TimeProjection } from '../TimeProjection';
import { SimulationPanel } from '../SimulationPanel';
import type { BusinessDashboardData, DashboardFilters, KPIData } from '../types';
import type { SimulationParams, SimulationResults, BusinessConfig } from '../hooks/useSimulation';

interface BlockDBusinessImpactProps {
  data: BusinessDashboardData;
  displayKpis: KPIData;
  filters: DashboardFilters;
  problemType: string;
  simulationParams: SimulationParams;
  simulationResults: SimulationResults;
  businessConfig: BusinessConfig;
  updateSimulationParams: (p: Partial<SimulationParams>) => void;
  resetSimulationParams: () => void;
  isSimulationActive: boolean;
}

export function BlockDBusinessImpact({
  data,
  displayKpis,
  filters,
  problemType,
  simulationParams,
  simulationResults,
  businessConfig,
  updateSimulationParams,
  resetSimulationParams,
  isSimulationActive,
}: BlockDBusinessImpactProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <Card className="border-green-600/30 bg-green-600/5">
        <CardContent className="py-3 flex items-center gap-3">
          <Rocket className="w-5 h-5 text-green-600 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">Impacto de Negócio</p>
            <p className="text-xs text-muted-foreground">
              O modelo está aprovado e as previsões possuem cobertura adequada.
              Os dados abaixo podem ser usados para priorização e decisões operacionais.
            </p>
          </div>
          <Badge className="bg-green-600 hover:bg-green-700">Decisório</Badge>
        </CardContent>
      </Card>

      {/* KPI Cards */}
      <BusinessKPICards
        kpis={displayKpis}
        problemType={problemType}
        viewMode={filters.viewMode}
      />

      {/* Simulation */}
      <SimulationPanel
        params={simulationParams}
        results={simulationResults}
        businessConfig={businessConfig}
        onParamsChange={updateSimulationParams}
        onReset={resetSimulationParams}
        isActive={isSimulationActive}
        problemType={problemType}
        viewMode={filters.viewMode}
      />

      {/* Time Projection */}
      <TimeProjection
        projections={data.timeProjections}
        problemType={problemType}
        horizonDays={filters.horizon}
      />

      {/* Actionable List */}
      <ActionableList
        predictions={data.predictions}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
    </div>
  );
}
