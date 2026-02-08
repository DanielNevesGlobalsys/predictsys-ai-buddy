import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Compass, AlertTriangle } from 'lucide-react';
import { ProbabilitySegmentation } from '../ProbabilitySegmentation';
import { GroupSegmentation } from '../GroupSegmentation';
import { CohortComparison } from '../CohortComparison';
import type { BusinessDashboardData, DashboardFilters, Prediction } from '../types';

interface BlockCGuidedExplorationProps {
  data: BusinessDashboardData;
  filters: DashboardFilters;
  problemType: string;
  updateFilters: (f: Partial<DashboardFilters>) => void;
}

export function BlockCGuidedExploration({
  data,
  filters,
  problemType,
  updateFilters,
}: BlockCGuidedExplorationProps) {
  return (
    <div className="space-y-6">
      {/* Disclaimer */}
      <Card className="border-yellow-600/30 bg-yellow-600/5">
        <CardContent className="py-3 flex items-center gap-3">
          <Compass className="w-5 h-5 text-yellow-600 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">Exploração Guiada</p>
            <p className="text-xs text-muted-foreground">
              As visualizações abaixo são exploratórias e não representam previsões definitivas.
              Use para entender padrões e formular hipóteses.
            </p>
          </div>
          <Badge variant="outline" className="text-yellow-600 border-yellow-600/30">
            Exploratório
          </Badge>
        </CardContent>
      </Card>

      {/* Segmentation */}
      <ProbabilitySegmentation
        bands={data.segmentationBands}
        problemType={problemType}
        viewMode={filters.viewMode}
      />

      {/* Group Segmentation */}
      <GroupSegmentation
        groups={data.groupSegmentation}
        problemType={problemType}
        availableFields={data.availableSegmentFields}
        currentField={filters.segmentField}
        onFieldChange={(field) => updateFilters({ segmentField: field })}
        viewMode={filters.viewMode}
      />

      {/* Cohort Comparison */}
      <CohortComparison
        predictions={data.predictions}
        problemType={problemType}
        availableFields={data.availableSegmentFields}
        viewMode={filters.viewMode}
      />
    </div>
  );
}
