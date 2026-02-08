import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PlayCircle, AlertCircle, RefreshCw, Download, FileSpreadsheet, ArrowLeft } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBusinessDashboard } from './hooks/useBusinessDashboard';
import { useSimulation } from './hooks/useSimulation';
import { useProjectAIContext } from '@/hooks/useProjectAIContext';
import { BusinessDashboardHero } from './BusinessDashboardHero';
import { BusinessDashboardFilters } from './BusinessDashboardFilters';
import { BusinessAIInsights } from './BusinessAIInsights';
import { ExecutiveNarrative } from './ExecutiveNarrative';
import { DashboardPDFExport } from './DashboardPDFExport';
import { ExportCSVModal, ExportJobsModal } from '@/components/export';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';

// Block components
import {
  BlockATrustVision,
  BlockBAnalyticalTranslation,
  BlockCGuidedExploration,
  BlockDBusinessImpact,
  AuditGovernancePanel,
  determineProjectStage,
} from './blocks';
import type { ProjectStage } from './blocks';

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

  const [modelQualityFlag, setModelQualityFlag] = useState<string | null>(null);
  const [scoreCoveragePct, setScoreCoveragePct] = useState<number | null>(null);
  const [mainMetric, setMainMetric] = useState<{ name: string; value: number } | null>(null);
  const [baselineMetric, setBaselineMetric] = useState<{ name: string; value: number } | null>(null);
  const [productionModelId, setProductionModelId] = useState<string | null>(null);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportJobsModalOpen, setExportJobsModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');

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
    runningBatch,
  } = useBusinessDashboard(projectId);

  const problemType =
    projectInfo?.problem_type ||
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
          let orgName = 'Organização';
          if (project.organization_id) {
            const { data: org } = await supabase
              .from('organizations')
              .select('name')
              .eq('id', project.organization_id)
              .maybeSingle();
            if (org) orgName = org.name;
          }

          setProjectInfo({
            name: project.name,
            organization_name: orgName,
            problem_type: project.problem_type,
            problem_context: project.business_objective || project.detected_problem_type || null,
            target_column: project.target_column,
          });
        }

        // Check production model quality flag + prediction sanity + main metrics
        const { data: prodModel } = await supabase
          .from('project_models')
          .select('id, hyperparameters')
          .eq('project_id', projectId)
          .eq('is_production', true)
          .eq('status', 'trained')
          .maybeSingle();

        if (prodModel) {
          setProductionModelId(prodModel.id);
          const hp = prodModel.hyperparameters as any;
          const qFlag = hp?.model_quality_flag || null;
          const sanity = hp?.prediction_sanity;
          if (sanity && sanity.passed === false) {
            setModelQualityFlag('fail');
          } else {
            setModelQualityFlag(qFlag);
          }

          // Get baseline metrics
          if (hp?.baseline_metrics) {
            const bm = hp.baseline_metrics;
            const firstKey = Object.keys(bm)[0];
            if (firstKey) {
              setBaselineMetric({ name: firstKey, value: bm[firstKey] });
            }
          }

          // Get main metric
          const { data: metricsData } = await supabase
            .from('project_model_metrics')
            .select('metric_name, metric_value')
            .eq('project_model_id', prodModel.id);

          if (metricsData && metricsData.length > 0) {
            // Pick the most relevant metric
            const pt = project?.problem_type || 'classification';
            const preferred = pt === 'regression' ? ['r2', 'R²', 'rmse'] : ['auc', 'AUC', 'f1', 'F1'];
            const found = metricsData.find((m) => preferred.includes(m.metric_name));
            if (found) {
              setMainMetric({ name: found.metric_name, value: found.metric_value });
            } else {
              setMainMetric({ name: metricsData[0].metric_name, value: metricsData[0].metric_value });
            }
          }
        }

        // Check score coverage from AI context
        const { data: aiCtxData } = await supabase
          .from('project_ai_context')
          .select('context')
          .eq('project_id', projectId)
          .maybeSingle();

        if (aiCtxData?.context) {
          const ctx = aiCtxData.context as any;
          const coverage = ctx?.predictions?.score_report?.coverage_pct;
          if (typeof coverage === 'number') {
            setScoreCoveragePct(coverage);
          }
        }
      } catch (err) {
        console.error('Error fetching project info:', err);
      }
    }

    fetchProjectInfo();
  }, [projectId]);

  const problemContext =
    projectInfo?.problem_context ||
    (data.predictions.length > 0 ? data.predictions[0].problem_context : null);

  const handleRunPredictions = async () => {
    const result = await runBatchPredictions();
    if (result.success) {
      toast.success(t('businessDashboard.predictionsGenerated'));
    } else {
      toast.error(result.error || t('businessDashboard.predictionsError'));
    }
  };

  // Determine project stage
  const projectStage = useMemo<ProjectStage>(
    () =>
      determineProjectStage(
        modelQualityFlag,
        scoreCoveragePct,
        mainMetric,
        baselineMetric,
        data.predictions.length,
        problemType,
      ),
    [modelQualityFlag, scoreCoveragePct, mainMetric, baselineMetric, data.predictions.length, problemType],
  );

  // Use simulated KPIs when simulation is active
  const displayKpis = isSimulationActive ? simulatedKpis : data.kpis;

  // Block visibility conditions
  const showBlockC = projectStage !== 'nao_confiavel' && data.predictions.length > 0;
  const showBlockD = projectStage === 'decisorio' && data.predictions.length > 0;

  // Prediction variance check for Block C
  const hasPredictionVariance = useMemo(() => {
    if (data.predictions.length < 2) return false;
    const vals = data.predictions
      .map((p) => p.probability_event ?? p.predicted_value ?? 0)
      .filter((v) => v !== null);
    if (vals.length < 2) return false;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return variance > 1e-8;
  }, [data.predictions]);

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
              <h3 className="text-xl font-semibold">{t('businessDashboard.generatingPredictions')}</h3>
              <p className="text-muted-foreground mt-2">{t('businessDashboard.pleaseWait')}</p>
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
              <h3 className="text-xl font-semibold">{t('businessDashboard.noPredictions')}</h3>
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
              <Button variant="outline" size="sm" onClick={handleRunPredictions} className="ml-auto">
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
              <h3 className="text-xl font-semibold">{t('businessDashboard.noPredictions')}</h3>
              <p className="text-muted-foreground max-w-md mx-auto">{t('businessDashboard.noPredictionsDesc')}</p>
            </div>
            <Button size="lg" onClick={handleRunPredictions} disabled={runningBatch} className="gap-2">
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

      {/* Tabs: Dashboard vs Auditoria */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <TabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="audit">Auditoria & Governança</TabsTrigger>
          </TabsList>

          {/* Actions */}
          {productionModel && (
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
              <Button variant="outline" size="sm" onClick={() => setExportJobsModalOpen(true)} className="gap-2">
                <FileSpreadsheet className="w-4 h-4" />
                {t('export.jobsTitle')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setExportModalOpen(true)} className="gap-2">
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
          )}
        </div>

        {/* ===== DASHBOARD TAB ===== */}
        <TabsContent value="dashboard" className="space-y-6 mt-4">
          {/* BLOCO A — VISÃO EXECUTIVA DE CONFIANÇA (ALWAYS) */}
          <BlockATrustVision
            problemType={problemType}
            inferredProblemType={problemContext || undefined}
            modelQualityFlag={modelQualityFlag}
            scoreCoveragePct={scoreCoveragePct}
            mainMetric={mainMetric}
            baselineMetric={baselineMetric}
            predictionsCount={data.predictions.length}
            totalEntities={data.kpis.totalEntities}
          />

          {/* Executive Narrative */}
          <ExecutiveNarrative
            projectId={projectId}
            executiveSummary={aiContext.storyline?.executive_summary || ''}
            lastUpdateReason={aiContext.storyline?.last_update_reason || ''}
            generatedAt={(aiContext.storyline as any)?.generated_at || null}
            contextStatus={aiStatus}
            onRefresh={handleRefreshContext}
          />

          {/* Model info bar */}
          {productionModel && (
            <div className="flex items-center justify-between flex-wrap gap-3">
              <p className="text-sm text-muted-foreground">
                {t('businessDashboard.usingModel')}: <strong>{productionModel.algorithm_name}</strong>
              </p>
            </div>
          )}

          {/* Filters */}
          <BusinessDashboardFilters
            filters={filters}
            onFilterChange={updateFilters}
            availableSegmentFields={data.availableSegmentFields}
            problemType={problemType}
          />

          {/* BLOCO B — TRADUÇÃO ANALÍTICA → NEGÓCIO (ALWAYS when model exists) */}
          <BlockBAnalyticalTranslation
            projectId={projectId}
            problemType={problemType}
            productionModelId={productionModelId}
          />

          {/* BLOCO C — EXPLORAÇÃO GUIADA (CONDITIONAL) */}
          {showBlockC && hasPredictionVariance && (
            <BlockCGuidedExploration
              data={data}
              filters={filters}
              problemType={problemType}
              updateFilters={updateFilters}
            />
          )}

          {/* BLOCO D — IMPACTO DE NEGÓCIO (ONLY IF DECISÓRIO) */}
          {showBlockD && (
            <BlockDBusinessImpact
              data={data}
              displayKpis={displayKpis}
              filters={filters}
              problemType={problemType}
              simulationParams={simulationParams}
              simulationResults={simulationResults}
              businessConfig={businessConfig}
              updateSimulationParams={updateSimulationParams}
              resetSimulationParams={resetSimulationParams}
              isSimulationActive={isSimulationActive}
            />
          )}

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
        </TabsContent>

        {/* ===== AUDIT TAB ===== */}
        <TabsContent value="audit" className="space-y-6 mt-4">
          <AuditGovernancePanel
            projectId={projectId}
            problemType={problemType}
            projectStage={projectStage}
            modelQualityFlag={modelQualityFlag}
          />
        </TabsContent>
      </Tabs>

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

      <ExportJobsModal open={exportJobsModalOpen} onOpenChange={setExportJobsModalOpen} projectId={projectId} />
    </div>
  );
}
