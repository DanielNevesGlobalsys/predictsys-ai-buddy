import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { generateFullReportPDF } from './generateFullReportPDF';
import type { FullReportData } from './generateFullReportPDF';
import type {
  DashboardFilters,
  KPIData,
  SegmentationBand,
  GroupSegmentation,
  Prediction,
  TimeProjection,
} from '../types';
import type { SimulationParams, SimulationResults, BusinessConfig } from '../hooks/useSimulation';
import type { ProjectStage } from '../blocks/BlockATrustVision';

interface FullReportPDFExportProps {
  projectId: string;
  projectName: string;
  organizationName: string;
  modelName: string;
  problemType: string;
  problemContext: string | null;
  projectStage: ProjectStage;
  filters: DashboardFilters;
  // Section 1
  mainMetric: { name: string; value: number } | null;
  baselineMetric: { name: string; value: number } | null;
  scoreCoveragePct: number | null;
  totalEntities: number;
  executiveNarrative: string | null;
  // Section 3
  kpis: KPIData;
  segmentationBands: SegmentationBand[];
  groupSegmentation: GroupSegmentation[];
  predictions: Prediction[];
  timeProjections: TimeProjection[];
  // Section 4
  displayKpis: KPIData;
  simulationParams: SimulationParams;
  simulationResults: SimulationResults;
  businessConfig: BusinessConfig;
  isSimulationActive: boolean;
}

export function FullReportPDFExport(props: FullReportPDFExportProps) {
  const { t, i18n } = useTranslation();
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      // Fetch additional data needed for the report in parallel
      const [featRes, metricsRes, modelRes, aiInsightsRes, aiCtxRes, predictionsCountRes] = await Promise.all([
        // Feature importances
        supabase
          .from('project_models')
          .select('id')
          .eq('project_id', props.projectId)
          .eq('is_production', true)
          .eq('status', 'trained')
          .maybeSingle()
          .then(async (modelIdRes) => {
            if (!modelIdRes.data?.id) return { data: [] };
            return supabase
              .from('project_feature_importances')
              .select('feature_name, importance_value')
              .eq('project_model_id', modelIdRes.data.id)
              .order('importance_value', { ascending: false })
              .limit(10);
          }),
        // Model metrics
        supabase
          .from('project_models')
          .select('id')
          .eq('project_id', props.projectId)
          .eq('is_production', true)
          .eq('status', 'trained')
          .maybeSingle()
          .then(async (modelIdRes) => {
            if (!modelIdRes.data?.id) return { data: [] };
            return supabase
              .from('project_model_metrics')
              .select('metric_name, metric_value')
              .eq('project_model_id', modelIdRes.data.id);
          }),
        // Model hyperparameters (for audit data)
        supabase
          .from('project_models')
          .select('id, algorithm_name, hyperparameters')
          .eq('project_id', props.projectId)
          .eq('is_production', true)
          .eq('status', 'trained')
          .maybeSingle(),
        // AI insights
        supabase
          .from('project_model_insights')
          .select('insights')
          .eq('project_id', props.projectId)
          .eq('insight_type', 'dashboard')
          .eq('language', i18n.language)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        // AI context (for coverage, batch_id)
        supabase
          .from('project_ai_context')
          .select('context')
          .eq('project_id', props.projectId)
          .maybeSingle(),
        // Predictions count
        supabase
          .from('predictions')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', props.projectId)
          .eq('is_latest', true),
      ]);

      // Dataset info
      const { data: datasetData } = await supabase
        .from('project_datasets')
        .select('total_rows, columns_count, sample_rows')
        .eq('project_id', props.projectId)
        .eq('is_active', true)
        .maybeSingle();

      // Build metrics maps
      const modelMetrics: Record<string, number> = {};
      if (metricsRes.data && Array.isArray(metricsRes.data)) {
        (metricsRes.data as { metric_name: string; metric_value: number }[]).forEach(m => {
          modelMetrics[m.metric_name] = m.metric_value;
        });
      }

      const hp = (modelRes.data?.hyperparameters as Record<string, any>) || {};
      const baselineMetrics: Record<string, number> = hp?.baseline_metrics || {};

      // Parse AI insights
      let aiInsights: { type: string; content: string }[] = [];
      if (aiInsightsRes.data?.insights) {
        const parsed = typeof aiInsightsRes.data.insights === 'string'
          ? JSON.parse(aiInsightsRes.data.insights)
          : aiInsightsRes.data.insights;
        if (Array.isArray(parsed)) {
          aiInsights = parsed;
        }
      }

      // Parse AI context for audit
      const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
      const scoreReport = aiCtx?.predictions?.score_report;

      // Build full report data
      const reportData: FullReportData = {
        projectName: props.projectName,
        organizationName: props.organizationName,
        problemType: props.problemType,
        problemContext: props.problemContext,
        modelName: props.modelName,
        projectStage: props.projectStage,
        filters: props.filters,

        // Section 1
        mainMetric: props.mainMetric,
        baselineMetric: props.baselineMetric,
        scoreCoveragePct: props.scoreCoveragePct,
        totalEntities: props.totalEntities,
        executiveNarrative: props.executiveNarrative,

        // Section 2
        featureImportances: (featRes.data as { feature_name: string; importance_value: number }[]) || [],
        modelMetrics,
        baselineMetrics,

        // Section 3
        kpis: props.kpis,
        segmentationBands: props.segmentationBands,
        groupSegmentation: props.groupSegmentation,
        predictions: props.predictions,
        timeProjections: props.timeProjections,

        // Section 4
        displayKpis: props.displayKpis,
        simulationParams: props.simulationParams,
        simulationResults: props.simulationResults,
        businessConfig: props.businessConfig,
        isSimulationActive: props.isSimulationActive,

        // Section 5
        aiInsights,

        // Section 6
        audit: {
          totalRows: datasetData?.total_rows ?? null,
          columnsCount: datasetData?.columns_count ?? null,
          sampleRows: datasetData?.sample_rows ?? null,
          algorithmName: modelRes.data?.algorithm_name ?? null,
          splitStrategy: hp?.split_strategy ?? null,
          sampleStrategy: hp?.sample_strategy ?? null,
          trainRowsUsed: hp?.sample_size_final ?? hp?.train_rows_used ?? null,
          metrics: modelMetrics,
          baselineMetrics,
          modelQualityFlag: hp?.model_quality_flag ?? null,
          predictionSanity: hp?.prediction_sanity ?? null,
          preflightReport: hp?.preflight_report ?? null,
          featuresBlocked: hp?.features_blocked || [],
          predictionsCount: predictionsCountRes.count ?? 0,
          scoreCoveragePct: scoreReport?.coverage_pct ?? null,
          batchId: scoreReport?.batch_id ?? null,
        },

        locale: i18n.language,
      };

      generateFullReportPDF(reportData);
      toast.success('Relatório PDF exportado com sucesso!');
    } catch (error) {
      console.error('Error exporting full report PDF:', error);
      toast.error('Erro ao exportar relatório PDF');
    } finally {
      setExporting(false);
    }
  }, [props, i18n.language]);

  return (
    <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} className="gap-2">
      {exporting ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <FileText className="w-4 h-4" />
      )}
      Relatório PDF
    </Button>
  );
}
