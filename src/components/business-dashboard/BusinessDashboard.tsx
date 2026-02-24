import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PlayCircle, AlertCircle, RefreshCw, Download, FileSpreadsheet, ArrowLeft, ShieldAlert, Clock, FileText } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBusinessDashboard } from './hooks/useBusinessDashboard';
import { useDashboardState } from './hooks/useDashboardState';
import { useSimulation } from './hooks/useSimulation';
import { useProjectAIContext } from '@/hooks/useProjectAIContext';
import { BusinessDashboardHero } from './BusinessDashboardHero';
import { BusinessDashboardFilters } from './BusinessDashboardFilters';
import { BusinessAIInsights } from './BusinessAIInsights';
import { ExecutiveNarrative } from './ExecutiveNarrative';
import { FullReportPDFExport } from './pdf/FullReportPDFExport';
import { MonitoringPanel } from './MonitoringPanel';
import { DashboardFeedbackWidget } from './DashboardFeedbackWidget';
import { ConfidenceCard } from './ConfidenceCard';
import { BusinessSummaryCard } from './BusinessSummaryCard';
import { ExportCSVModal, ExportJobsModal } from '@/components/export';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { translateToBusinessNarrative } from '@/lib/businessTranslator';
import type { IndustryKey } from '@/types/intentContract';
import type { ExecutiveReportResponse } from './types';

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
  const [exportingExecutive, setExportingExecutive] = useState(false);

  // SSOT State Machine
  const { state: dashboardState, ssot, loading: ssotLoading, refetch: refetchSsot } = useDashboardState(projectId);

  // AI Context hook
  const { context: aiContext, status: aiStatus, loadContext, loading: aiContextLoading } = useProjectAIContext(projectId);

  useEffect(() => { loadContext(); }, [loadContext]);

  const handleRefreshContext = useCallback(() => { loadContext(); }, [loadContext]);

  const {
    data, filters, updateFilters, loading, error,
    productionModel, runBatchPredictions, runningBatch,
    scoringBlocked,
  } = useBusinessDashboard(projectId);

  const problemType = projectInfo?.problem_type ||
    (data.predictions.length > 0 ? data.predictions[0].problem_type : 'classification');

  const {
    params: simulationParams, updateParams: updateSimulationParams,
    resetParams: resetSimulationParams, simulationResults,
    simulatedKpis, businessConfig, isSimulationActive,
  } = useSimulation({ projectId, predictions: data.predictions, baseKpis: data.kpis, problemType });

  useEffect(() => {
    async function fetchProjectInfo() {
      try {
        const { data: project } = await supabase
          .from('projects')
          .select('name, organization_id, problem_type, detected_problem_type, target_column, business_objective')
          .eq('id', projectId).maybeSingle();

        if (project) {
          let orgName = 'Organização';
          if (project.organization_id) {
            const { data: org } = await supabase.from('organizations').select('name').eq('id', project.organization_id).maybeSingle();
            if (org) orgName = org.name;
          }
          setProjectInfo({
            name: project.name, organization_name: orgName, problem_type: project.problem_type,
            problem_context: project.business_objective || project.detected_problem_type || null,
            target_column: project.target_column,
          });
        }

        const { data: prodModel } = await supabase
          .from('project_models').select('id, hyperparameters')
          .eq('project_id', projectId).eq('is_production', true).eq('status', 'trained').maybeSingle();

        if (prodModel) {
          setProductionModelId(prodModel.id);
          const hp = prodModel.hyperparameters as any;
          const qFlag = hp?.model_quality_flag || null;
          const sanity = hp?.prediction_sanity;
          setModelQualityFlag(sanity?.passed === false ? 'fail' : qFlag);

          if (hp?.baseline_metrics) {
            const bm = hp.baseline_metrics;
            const firstKey = Object.keys(bm)[0];
            if (firstKey) setBaselineMetric({ name: firstKey, value: bm[firstKey] });
          }

          const { data: metricsData } = await supabase
            .from('project_model_metrics').select('metric_name, metric_value')
            .eq('project_model_id', prodModel.id);

          if (metricsData?.length) {
            const pt = project?.problem_type || 'classification';
            const preferred = pt === 'regression' ? ['r2', 'R²', 'rmse'] : ['auc', 'AUC', 'f1', 'F1'];
            const found = metricsData.find(m => preferred.includes(m.metric_name));
            const picked = found || metricsData[0];
            setMainMetric({ name: picked.metric_name, value: picked.metric_value });
          }
        }

        const { data: aiCtxData } = await supabase.from('project_ai_context').select('context').eq('project_id', projectId).maybeSingle();
        if (aiCtxData?.context) {
          const ctx = aiCtxData.context as any;
          const coverage = ctx?.predictions?.score_report?.coverage_pct;
          if (typeof coverage === 'number') setScoreCoveragePct(coverage);
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
      refetchSsot();
    } else {
      toast.error(result.error || t('businessDashboard.predictionsError'));
    }
  };

  const projectStage = useMemo<ProjectStage>(
    () => determineProjectStage(modelQualityFlag, scoreCoveragePct, mainMetric, baselineMetric, data.predictions.length, problemType),
    [modelQualityFlag, scoreCoveragePct, mainMetric, baselineMetric, data.predictions.length, problemType],
  );

  // Executive PDF export handler
  const handleExportExecutive = useCallback(async () => {
    if (data.staleResults) {
      const confirmed = window.confirm('Os resultados estão desatualizados (configuração alterada após o último scoring). Deseja exportar mesmo assim?');
      if (!confirmed) return;
    }
    setExportingExecutive(true);
    try {
      const { data: result, error: invokeErr } = await supabase.functions.invoke('generate-executive-report', {
        body: { project_id: projectId, horizon_days: filters.horizon },
      });
      if (invokeErr) {
        toast.error(invokeErr.message || 'Erro ao gerar relatório');
        return;
      }
      const response = result as ExecutiveReportResponse;
      if (response.success && response.signed_url) {
        window.open(response.signed_url, '_blank');
        if (response.format === 'html') {
          toast.warning('Relatório gerado em HTML (fallback). Engine PDF indisponível.', {
            description: 'O arquivo foi salvo como HTML em vez de PDF.',
            duration: 6000,
          });
        } else {
          toast.success('Relatório executivo PDF gerado com sucesso!');
        }
      } else {
        const msg = response.error_friendly || response.error || 'Erro ao gerar relatório';
        toast.error(msg, {
          description: response.ctas?.map(c => c.label).join(' · ') || undefined,
        });
      }
    } catch (err) {
      toast.error('Erro inesperado ao exportar relatório');
      console.error('Executive export error:', err);
    } finally {
      setExportingExecutive(false);
    }
  }, [projectId, filters.horizon, data.staleResults]);

  const displayKpis = isSimulationActive ? simulatedKpis : data.kpis;
  const showBlockC = projectStage !== 'nao_confiavel' && data.predictions.length > 0;
  const showBlockD = projectStage === 'decisorio' && data.predictions.length > 0;

  // Business translation memo
  const businessTranslation = useMemo(() => {
    if (data.kpis.totalEntities === 0) return null;
    const aiCtxData = aiContext as any;
    const intentContract = aiCtxData?.intent_contract;
    // Read industry — never default to 'generic', keep actual value or null
    const rawIndustry = intentContract?.domain_adapter?.industry || intentContract?.industry_hint || null;
    // Use "generic" ONLY for display/translation — never persist this fallback
    const industry: IndustryKey = (rawIndustry && rawIndustry !== 'generic' ? rawIndustry : 'generic') as IndustryKey;
    const objective = intentContract?.intent_base?.declared_objective || intentContract?.declared_objective || '';
    return translateToBusinessNarrative({
      industry,
      declaredObjective: objective,
      problemType,
      totalEntities: data.kpis.totalEntities,
      highRiskCount: data.kpis.highProbabilityCount,
      expectedEvents: data.kpis.expectedEvents,
      financialImpact: data.kpis.financialImpact,
      predictedTotalValue: data.kpis.predictedTotalValue,
      coveragePct: data.kpis.coveragePercent,
      confidenceScore: data.confidenceScore,
      targetColumn: projectInfo?.target_column || undefined,
      recommendedThreshold: data.recommendedThreshold ?? undefined,
    });
  }, [data.kpis, data.confidenceScore, data.recommendedThreshold, problemType, aiContext, projectInfo?.target_column]);

  const hasPredictionVariance = useMemo(() => {
    if (data.predictions.length < 2) return false;
    const vals = data.predictions.map(p => p.probability_event ?? p.predicted_value ?? 0).filter(v => v !== null);
    if (vals.length < 2) return false;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return variance > 1e-8;
  }, [data.predictions]);

  // ===== STATE-BASED RENDERING =====

  // RUNNING state
  if (runningBatch) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero projectId={projectId} problemContext={problemContext} problemType={problemType} horizonDays={filters.horizon} />
        <Card className="p-8">
          <div className="text-center space-y-4">
            <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto" />
            <div>
              <h3 className="text-xl font-semibold">{t('businessDashboard.generatingPredictions')}</h3>
              <p className="text-muted-foreground mt-2">{t('businessDashboard.pleaseWait')}</p>
            </div>
          </div>
        </Card>
        {/* Audit always visible */}
        <AuditGovernancePanel projectId={projectId} problemType={problemType} projectStage={projectStage} modelQualityFlag={modelQualityFlag} ssot={ssot} />
      </div>
    );
  }

  if (loading && data.predictions.length === 0 && ssotLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // BLOCKED state (from SSOT or scoring)
  const isBlocked = dashboardState === 'BLOCKED' || scoringBlocked;
  
  if (isBlocked && data.predictions.length === 0) {
    const blockReason = scoringBlocked?.message || 
      (ssot.productionModel?.model_quality_flag === 'fail' ? 'Modelo reprovado — desempenho inferior ao baseline.' :
       !ssot.productionModel ? 'Nenhum modelo em produção.' :
       !ssot.productionModel.dashboard_allowed ? 'Dashboard não autorizado para este modelo.' :
       'Dashboard bloqueado.');
    const blockCtas = scoringBlocked?.ctas || [];

    return (
      <div className="space-y-6">
        <BusinessDashboardHero projectId={projectId} problemContext={problemContext} problemType={problemType} horizonDays={filters.horizon} />
        <Card className="p-8 border-2 border-destructive/30">
          <div className="text-center space-y-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
              <ShieldAlert className="w-8 h-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-semibold text-destructive">Dashboard Bloqueado</h3>
              <p className="text-muted-foreground max-w-lg mx-auto">{blockReason}</p>
            </div>
            {blockCtas.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2">
                {blockCtas.map((cta: any, i: number) => (
                  <Button key={i} variant="outline" size="sm">{cta.label}</Button>
                ))}
              </div>
            )}
          </div>
        </Card>
        <AuditGovernancePanel projectId={projectId} problemType={problemType} projectStage={projectStage} modelQualityFlag={modelQualityFlag} ssot={ssot} />
      </div>
    );
  }

  // ERROR state
  if (dashboardState === 'ERROR' && data.predictions.length === 0) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero projectId={projectId} problemContext={problemContext} problemType={problemType} horizonDays={filters.horizon} />
        <Card className="p-8 border-2 border-destructive/30">
          <div className="text-center space-y-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-semibold text-destructive">Erro no Scoring</h3>
              <p className="text-muted-foreground max-w-lg mx-auto">
                {ssot.scoringJob?.error_friendly || 'Ocorreu um erro durante a geração de previsões.'}
              </p>
              {ssot.scoringJob?.error_code && (
                <p className="text-xs font-mono text-muted-foreground">Código: {ssot.scoringJob.error_code}</p>
              )}
            </div>
            <Button onClick={handleRunPredictions} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Tentar novamente
            </Button>
          </div>
        </Card>
        <AuditGovernancePanel projectId={projectId} problemType={problemType} projectStage={projectStage} modelQualityFlag={modelQualityFlag} ssot={ssot} />
      </div>
    );
  }

  // NO_PREDICTIONS: model exists but no score done
  const showError = error && !runningBatch;
  const inferenceFailure = productionModel && data.predictions.length === 0 && scoreCoveragePct !== null && scoreCoveragePct === 0;

  if (data.predictions.length === 0 && !productionModel) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero projectId={projectId} problemContext={problemContext} problemType={problemType} horizonDays={filters.horizon} />
        <Card className="p-8">
          <div className="text-center space-y-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-semibold">{t('businessDashboard.noPredictions')}</h3>
              <p className="text-muted-foreground max-w-md mx-auto">{t('businessDashboard.noProductionModel')}</p>
            </div>
            <p className="text-sm text-muted-foreground">{t('businessDashboard.selectProductionModelFirst')}</p>
          </div>
        </Card>
        <AuditGovernancePanel projectId={projectId} problemType={problemType} projectStage={projectStage} modelQualityFlag={modelQualityFlag} ssot={ssot} />
      </div>
    );
  }

  if (data.predictions.length === 0 && productionModel) {
    return (
      <div className="space-y-6">
        <BusinessDashboardHero projectId={projectId} problemContext={problemContext} problemType={problemType} horizonDays={filters.horizon} />
        {showError && (
          <Card className="p-4 border-destructive bg-destructive/10">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-destructive">{t('businessDashboard.error')}</p>
                <p className="text-sm text-destructive/80">{error}</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleRunPredictions} className="ml-auto">
                <RefreshCw className="w-4 h-4 mr-2" />{t('common.retry')}
              </Button>
            </div>
          </Card>
        )}

        {inferenceFailure ? (
          <Card className="p-8 border-2 border-destructive/40 bg-destructive/5">
            <div className="text-center space-y-6">
              <div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertCircle className="w-8 h-8 text-destructive" />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-semibold text-destructive">⚠️ Não foi possível gerar o relatório deste projeto</h3>
                <p className="text-muted-foreground max-w-lg mx-auto">
                  Modelo treinado, mas nenhuma previsão válida foi gerada. Coverage: {scoreCoveragePct?.toFixed(1)}%
                  {ssot.scoreReport && `, Missing Feature: ${ssot.scoreReport.missing_feature_pct.toFixed(1)}%`}
                </p>
              </div>
              <div className="bg-muted/50 p-4 rounded-lg max-w-lg mx-auto text-left space-y-2">
                <p className="text-sm font-medium">👉 Recomendação:</p>
                <p className="text-sm text-muted-foreground">
                  Revise o target e as features, retreine o modelo e execute o scoring novamente.
                </p>
              </div>
              <Button size="lg" onClick={handleRunPredictions} disabled={runningBatch} className="gap-2">
                <RefreshCw className="w-5 h-5" />Tentar novamente
              </Button>
            </div>
          </Card>
        ) : (
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
                <PlayCircle className="w-5 h-5" />{t('businessDashboard.runPredictionsNow')}
              </Button>
              <p className="text-sm text-muted-foreground">
                {t('businessDashboard.usingModel')}: <strong>{productionModel.algorithm_name}</strong>
              </p>
            </div>
          </Card>
        )}
        <AuditGovernancePanel projectId={projectId} problemType={problemType} projectStage={projectStage} modelQualityFlag={modelQualityFlag} ssot={ssot} />
      </div>
    );
  }

  // ===== READY STATE — Full Dashboard =====
  return (
    <div className="space-y-6">
      <BusinessDashboardHero projectId={projectId} problemContext={problemContext} problemType={problemType} horizonDays={filters.horizon} />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <TabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="monitoring">Monitoramento</TabsTrigger>
            <TabsTrigger value="audit">Auditoria & Governança</TabsTrigger>
          </TabsList>

          {productionModel && (
            <div className="flex items-center gap-2 flex-wrap">
              <FullReportPDFExport
                projectId={projectId}
                projectName={projectInfo?.name || 'Projeto'}
                organizationName={projectInfo?.organization_name || 'Organização'}
                modelName={productionModel.algorithm_name}
                problemType={problemType}
                problemContext={problemContext}
                projectStage={projectStage}
                filters={filters}
                mainMetric={mainMetric}
                baselineMetric={baselineMetric}
                scoreCoveragePct={scoreCoveragePct}
                totalEntities={data.kpis.totalEntities}
                executiveNarrative={aiContext.storyline?.executive_summary || null}
                kpis={data.kpis}
                segmentationBands={data.segmentationBands}
                groupSegmentation={data.groupSegmentation}
                predictions={data.predictions}
                timeProjections={data.timeProjections}
                displayKpis={displayKpis}
                simulationParams={simulationParams}
                simulationResults={simulationResults}
                businessConfig={businessConfig}
                isSimulationActive={isSimulationActive}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportExecutive}
                disabled={exportingExecutive || dashboardState !== 'READY'}
                className="gap-2"
                title={dashboardState !== 'READY' ? 'Scoring precisa estar concluído para exportar' : 'Gerar relatório executivo 1 página'}
              >
                {exportingExecutive ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FileText className="w-4 h-4" />
                )}
                PDF Executivo
              </Button>
              <Button variant="outline" size="sm" onClick={() => setExportJobsModalOpen(true)} className="gap-2">
                <FileSpreadsheet className="w-4 h-4" />{t('export.jobsTitle')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setExportModalOpen(true)} className="gap-2">
                <Download className="w-4 h-4" />{t('common.export')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleRunPredictions} disabled={runningBatch} className="gap-2">
                {runningBatch ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />{t('businessDashboard.generatingPredictions')}</>
                ) : (
                  <><PlayCircle className="w-4 h-4" />{t('businessDashboard.refreshPredictions')}</>
                )}
              </Button>
            </div>
          )}
        </div>

        <TabsContent value="dashboard" className="space-y-6 mt-4">
          {/* Confidence Card + Business Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ConfidenceCard
              score={data.confidenceScore}
              inputs={data.confidenceInputs ?? undefined}
            />
            <div className="md:col-span-2">
              <BusinessSummaryCard
                translation={businessTranslation}
                staleResults={data.staleResults}
                onRunScoring={handleRunPredictions}
              />
            </div>
          </div>

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

          <ExecutiveNarrative
            projectId={projectId}
            executiveSummary={aiContext.storyline?.executive_summary || ''}
            lastUpdateReason={aiContext.storyline?.last_update_reason || ''}
            generatedAt={(aiContext.storyline as any)?.generated_at || null}
            contextStatus={aiStatus}
            onRefresh={handleRefreshContext}
          />

          {productionModel && (
            <div className="flex items-center justify-between flex-wrap gap-3">
              <p className="text-sm text-muted-foreground">
                {t('businessDashboard.usingModel')}: <strong>{productionModel.algorithm_name}</strong>
              </p>
            </div>
          )}

          <BusinessDashboardFilters
            filters={filters}
            onFilterChange={updateFilters}
            availableSegmentFields={data.availableSegmentFields}
            problemType={problemType}
          />

          <BlockBAnalyticalTranslation projectId={projectId} problemType={problemType} productionModelId={productionModelId} />

          {showBlockC && hasPredictionVariance && (
            <BlockCGuidedExploration data={data} filters={filters} problemType={problemType} updateFilters={updateFilters} />
          )}

          {showBlockD && (
            <BlockDBusinessImpact
              data={data} displayKpis={displayKpis} filters={filters} problemType={problemType}
              simulationParams={simulationParams} simulationResults={simulationResults}
              businessConfig={businessConfig} updateSimulationParams={updateSimulationParams}
              resetSimulationParams={resetSimulationParams} isSimulationActive={isSimulationActive}
            />
          )}

          <BusinessAIInsights
            projectId={projectId} problemType={problemType} problemContext={problemContext}
            kpis={displayKpis} segmentationBands={data.segmentationBands}
            groupSegmentation={data.groupSegmentation} viewMode={filters.viewMode}
          />

          <DashboardFeedbackWidget projectId={projectId} />
        </TabsContent>

        <TabsContent value="monitoring" className="space-y-6 mt-4">
          <MonitoringPanel projectId={projectId} />
        </TabsContent>

        <TabsContent value="audit" className="space-y-6 mt-4">
          <AuditGovernancePanel
            projectId={projectId} problemType={problemType}
            projectStage={projectStage} modelQualityFlag={modelQualityFlag}
            ssot={ssot}
          />
        </TabsContent>
      </Tabs>

      <ExportCSVModal
        open={exportModalOpen} onOpenChange={setExportModalOpen}
        projectId={projectId} exportContext="dashboard"
        currentFilters={{ horizon: filters.horizon, segmentField: filters.segmentField, segmentValue: filters.segmentValue }}
        onExportStarted={() => setExportJobsModalOpen(true)}
      />
      <ExportJobsModal open={exportJobsModalOpen} onOpenChange={setExportJobsModalOpen} projectId={projectId} />
    </div>
  );
}
