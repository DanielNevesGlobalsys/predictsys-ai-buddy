import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PlayCircle, AlertCircle, RefreshCw, Download, FileSpreadsheet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBusinessDashboard } from './hooks/useBusinessDashboard';
import { useSimulation } from './hooks/useSimulation';
import { useProjectAIContext } from '@/hooks/useProjectAIContext';
import { BusinessDashboardHero } from './BusinessDashboardHero';
import { BusinessDashboardFilters } from './BusinessDashboardFilters';
import { BusinessKPICards } from './BusinessKPICards';
import { ProbabilitySegmentation } from './ProbabilitySegmentation';
import { GroupSegmentation } from './GroupSegmentation';
import { TimeProjection } from './TimeProjection';
import { ActionableList } from './ActionableList';
import { CohortComparison } from './CohortComparison';
import { SimulationPanel } from './SimulationPanel';
import { BusinessAIInsights } from './BusinessAIInsights';
import { ExecutiveNarrative } from './ExecutiveNarrative';
import { DashboardPDFExport } from './DashboardPDFExport';
import { ExportCSVModal, ExportJobsModal } from '@/components/export';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from 'sonner';

interface BusinessDashboardProps {
  projectId: string;
}

export function BusinessDashboard({ projectId }: BusinessDashboardProps) {
  const { t } = useTranslation();
  const [projectInfo, setProjectInfo] = useState<{
    name: string;
    organization_name: string;
    problem_type: string;
    problem_context: string | null;
    target_column: string | null;
  } | null>(null);
  
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportJobsModalOpen, setExportJobsModalOpen] = useState(false);
  
  // AI Context hook
  const { context: aiContext, status: aiStatus, loadContext, loading: aiContextLoading } = useProjectAIContext(projectId);
  
  useEffect(() => {
    loadContext();
  }, [loadContext]);
  
  const handleRefreshContext = useCallback(() => {
    loadContext();
  }, [loadContext]);
  
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

  const problemType = projectInfo?.problem_type || 
    (data.predictions.length > 0 ? data.predictions[0].problem_type : 'classification');

  // Simulation hook
  const {
    params: simulationParams,
    updateParams: updateSimulationParams,
    resetParams: resetSimulationParams,
    simulationResults,
    simulatedKpis,
    businessConfig,
    isSimulationActive,
  } = useSimulation({
    projectId,
    predictions: data.predictions,
    baseKpis: data.kpis,
    problemType,
  });
  
  useEffect(() => {
    async function fetchProjectInfo() {
      try {
        const { data: project } = await supabase
          .from('projects')
          .select('name, organization_id, problem_type, detected_problem_type, target_column, business_objective')
          .eq('id', projectId)
          .maybeSingle();
        
        if (project) {
          // Fetch organization name
          let orgName = 'Organização';
          if (project.organization_id) {
            const { data: org } = await supabase
              .from('organizations')
              .select('name')
              .eq('id', project.organization_id)
              .maybeSingle();
            if (org) {
              orgName = org.name;
            }
          }
          
          setProjectInfo({
            name: project.name,
            organization_name: orgName,
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

  // Use simulated KPIs when simulation is active
  const displayKpis = isSimulationActive ? simulatedKpis : data.kpis;

  // Show loading state while batch is running or initial load
  if (runningBatch) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero 
          projectId={projectId}
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
          projectId={projectId}
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
          projectId={projectId}
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
        projectId={projectId}
        problemContext={problemContext}
        problemType={problemType}
        horizonDays={filters.horizon}
      />
      
      {/* Executive Narrative from AI Context */}
      <ExecutiveNarrative
        projectId={projectId}
        executiveSummary={aiContext.storyline?.executive_summary || ''}
        lastUpdateReason={aiContext.storyline?.last_update_reason || ''}
        generatedAt={(aiContext.storyline as any)?.generated_at || null}
        contextStatus={aiStatus}
        onRefresh={handleRefreshContext}
      />
      
      {/* Run predictions button + Export */}
      {productionModel && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <p className="text-sm text-muted-foreground">
            {t('businessDashboard.usingModel')}: <strong>{productionModel.algorithm_name}</strong>
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <DashboardPDFExport
              projectId={projectId}
              projectName={projectInfo?.name || 'Projeto'}
              organizationName={projectInfo?.organization_name || 'Organização'}
              modelName={productionModel.algorithm_name}
              filters={filters}
              kpis={data.kpis}
              simulatedKpis={simulatedKpis}
              simulationParams={simulationParams}
              simulationResults={simulationResults}
              businessConfig={businessConfig}
              segmentationBands={data.segmentationBands}
              predictions={data.predictions}
              problemType={problemType}
              isSimulationActive={isSimulationActive}
            />
            <Button 
              variant="outline"
              size="sm"
              onClick={() => setExportJobsModalOpen(true)}
              className="gap-2"
            >
              <FileSpreadsheet className="w-4 h-4" />
              {t('export.jobsTitle')}
            </Button>
            <Button 
              variant="outline"
              size="sm"
              onClick={() => setExportModalOpen(true)}
              className="gap-2"
            >
              <Download className="w-4 h-4" />
              {t('common.export')}
            </Button>
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
        </div>
      )}
      
      {/* Filters */}
      <BusinessDashboardFilters 
        filters={filters}
        onFilterChange={updateFilters}
        availableSegmentFields={data.availableSegmentFields}
        problemType={problemType}
      />
      
      {/* KPI Cards - Now using display KPIs that reflect simulation */}
      <BusinessKPICards 
        kpis={displayKpis}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
      
      {/* Simulation Panel - BEFORE segmentation */}
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
      
      {/* AI Insights */}
      <BusinessAIInsights 
        projectId={projectId}
        problemType={problemType}
        problemContext={problemContext}
        kpis={displayKpis}
        segmentationBands={data.segmentationBands}
        groupSegmentation={data.groupSegmentation}
        viewMode={filters.viewMode}
      />
      
      {/* Export Modals */}
      <ExportCSVModal
        open={exportModalOpen}
        onOpenChange={setExportModalOpen}
        projectId={projectId}
        exportContext="dashboard"
        currentFilters={{
          horizon: filters.horizon,
          segmentField: filters.segmentField,
          segmentValue: filters.segmentValue,
        }}
        onExportStarted={() => setExportJobsModalOpen(true)}
      />
      
      <ExportJobsModal
        open={exportJobsModalOpen}
        onOpenChange={setExportJobsModalOpen}
        projectId={projectId}
      />
    </div>
  );
}
