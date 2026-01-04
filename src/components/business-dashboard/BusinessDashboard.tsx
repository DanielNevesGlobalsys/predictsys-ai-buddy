import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PlayCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBusinessDashboard } from './hooks/useBusinessDashboard';
import { BusinessDashboardHero } from './BusinessDashboardHero';
import { BusinessDashboardFilters } from './BusinessDashboardFilters';
import { BusinessKPICards } from './BusinessKPICards';
import { ProbabilitySegmentation } from './ProbabilitySegmentation';
import { GroupSegmentation } from './GroupSegmentation';
import { TimeProjection } from './TimeProjection';
import { ActionableList } from './ActionableList';
import { CohortComparison } from './CohortComparison';
import { WhatIfSimulation } from './WhatIfSimulation';
import { BusinessAIInsights } from './BusinessAIInsights';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from 'sonner';

interface BusinessDashboardProps {
  projectId: string;
}

export function BusinessDashboard({ projectId }: BusinessDashboardProps) {
  const { t } = useTranslation();
  const [projectInfo, setProjectInfo] = useState<{
    problem_type: string;
    problem_context: string | null;
    target_column: string | null;
  } | null>(null);
  
  const { 
    data, 
    filters, 
    updateFilters, 
    loading, 
    error,
    productionModel,
    runBatchPredictions,
    runningBatch 
  } = useBusinessDashboard(projectId);
  
  useEffect(() => {
    async function fetchProjectInfo() {
      try {
        const { data: project } = await supabase
          .from('projects')
          .select('problem_type, detected_problem_type, target_column, business_objective')
          .eq('id', projectId)
          .maybeSingle();
        
        if (project) {
          setProjectInfo({
            problem_type: project.problem_type,
            problem_context: project.business_objective || project.detected_problem_type || null,
            target_column: project.target_column
          });
        }
      } catch (err) {
        console.error('Error fetching project info:', err);
      }
    }
    
    fetchProjectInfo();
  }, [projectId]);
  
  const problemType = projectInfo?.problem_type || 
    (data.predictions.length > 0 ? data.predictions[0].problem_type : 'classification');
  
  const problemContext = projectInfo?.problem_context || 
    (data.predictions.length > 0 ? data.predictions[0].problem_context : null);

  const handleRunPredictions = async () => {
    const result = await runBatchPredictions();
    if (result.success) {
      toast.success(t('businessDashboard.predictionsGenerated'));
    } else {
      toast.error(result.error || t('businessDashboard.predictionsError'));
    }
  };

  // Show loading state while batch is running or initial load
  if (runningBatch) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero 
          problemContext={problemContext}
          problemType={problemType}
          horizonDays={filters.horizon}
        />
        <Card className="p-8">
          <div className="text-center space-y-4">
            <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto" />
            <div>
              <h3 className="text-xl font-semibold">
                {t('businessDashboard.generatingPredictions')}
              </h3>
              <p className="text-muted-foreground mt-2">
                {t('businessDashboard.pleaseWait')}
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (loading && data.predictions.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Show error state but keep dashboard functional
  const showError = error && !runningBatch;

  // Show empty state with CTA if no predictions and no production model
  if (data.predictions.length === 0 && !productionModel) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero 
          problemContext={problemContext}
          problemType={problemType}
          horizonDays={filters.horizon}
        />
        
        <Card className="p-8">
          <div className="text-center space-y-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-muted-foreground" />
            </div>
            
            <div className="space-y-2">
              <h3 className="text-xl font-semibold">
                {t('businessDashboard.noPredictions')}
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                {t('businessDashboard.noProductionModel')}
              </p>
            </div>
            
            <p className="text-sm text-muted-foreground">
              {t('businessDashboard.selectProductionModelFirst')}
            </p>
          </div>
        </Card>
      </div>
    );
  }

  // Show empty state with CTA if no predictions but has production model
  if (data.predictions.length === 0 && productionModel) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero 
          problemContext={problemContext}
          problemType={problemType}
          horizonDays={filters.horizon}
        />
        
        {showError && (
          <Card className="p-4 border-destructive bg-destructive/10">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-destructive">{t('businessDashboard.error')}</p>
                <p className="text-sm text-destructive/80">{error}</p>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleRunPredictions}
                className="ml-auto"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {t('common.retry')}
              </Button>
            </div>
          </Card>
        )}
        
        <Card className="p-8">
          <div className="text-center space-y-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-muted-foreground" />
            </div>
            
            <div className="space-y-2">
              <h3 className="text-xl font-semibold">
                {t('businessDashboard.noPredictions')}
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                {t('businessDashboard.noPredictionsDesc')}
              </p>
            </div>
            
            <Button 
              size="lg" 
              onClick={handleRunPredictions}
              disabled={runningBatch}
              className="gap-2"
            >
              <PlayCircle className="w-5 h-5" />
              {t('businessDashboard.runPredictionsNow')}
            </Button>
            
            <p className="text-sm text-muted-foreground">
              {t('businessDashboard.usingModel')}: <strong>{productionModel.algorithm_name}</strong>
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <BusinessDashboardHero 
        problemContext={problemContext}
        problemType={problemType}
        horizonDays={filters.horizon}
      />
      
      {/* Run predictions button */}
      {productionModel && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('businessDashboard.usingModel')}: <strong>{productionModel.algorithm_name}</strong>
          </p>
          <Button 
            variant="outline"
            size="sm"
            onClick={handleRunPredictions}
            disabled={runningBatch}
            className="gap-2"
          >
            {runningBatch ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('businessDashboard.generatingPredictions')}
              </>
            ) : (
              <>
                <PlayCircle className="w-4 h-4" />
                {t('businessDashboard.refreshPredictions')}
              </>
            )}
          </Button>
        </div>
      )}
      
      {/* Filters */}
      <BusinessDashboardFilters 
        filters={filters}
        onFilterChange={updateFilters}
        availableSegmentFields={data.availableSegmentFields}
      />
      
      {/* KPI Cards */}
      <BusinessKPICards 
        kpis={data.kpis}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
      
      {/* Segmentation by Probability */}
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
      
      {/* Cohort Comparison */}
      <CohortComparison 
        predictions={data.predictions}
        problemType={problemType}
        availableFields={data.availableSegmentFields}
        viewMode={filters.viewMode}
      />
      
      {/* What-if Simulation */}
      <WhatIfSimulation 
        predictions={data.predictions}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
      
      {/* AI Insights */}
      <BusinessAIInsights 
        projectId={projectId}
        problemType={problemType}
        problemContext={problemContext}
        kpis={data.kpis}
        segmentationBands={data.segmentationBands}
        groupSegmentation={data.groupSegmentation}
        viewMode={filters.viewMode}
      />
    </div>
  );
}
