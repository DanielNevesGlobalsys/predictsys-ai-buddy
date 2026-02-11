import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type DashboardState = 'READY' | 'RUNNING' | 'BLOCKED' | 'NO_PREDICTIONS' | 'ERROR';

export interface SSOTData {
  // Dataset State
  datasetState: {
    source_type: string;
    row_count: number;
    col_count: number;
    eda_ready: boolean;
    model_ready: boolean;
    virtual_manifest: boolean;
    production_model_id: string | null;
    active_dataset_ref: string | null;
  } | null;

  // Score Report
  scoreReport: {
    status: string;
    coverage_pct: number;
    predictions_count: number;
    batch_id: string | null;
    warnings: string[];
    missing_feature_pct: number;
    gates_snapshot: Record<string, any> | null;
    created_at: string;
  } | null;

  // Scoring Job
  scoringJob: {
    status: string;
    error_code: string | null;
    error_friendly: string | null;
    started_at: string;
    completed_at: string | null;
  } | null;

  // Model Selection
  modelSelection: {
    selection_version: number;
    target_column: string | null;
    target_hash: string | null;
    features_count: number;
  } | null;

  // Modeling Contract
  modelingContract: {
    status: string;
    contract_version: string;
    split_strategy: string;
    anchor_time_col: string | null;
    features_final_count: number;
    features_blocked_count: number;
    leakage_flags_count: number;
    blocked_reasons: string[] | null;
  } | null;

  // Modeling Dataset
  modelingDataset: {
    status: string;
    selection_version_used: number | null;
    feature_report: Record<string, any> | null;
    missing_feature_pct: number;
    overfit_risk_score: number | null;
  } | null;

  // Production Model
  productionModel: {
    id: string;
    algorithm_name: string;
    deployed_at: string | null;
    deployed_selection_version: number | null;
    hyperparameters: Record<string, any>;
    model_quality_flag: string | null;
    dashboard_allowed: boolean;
    prediction_sanity: Record<string, any> | null;
    baseline_metrics: Record<string, number>;
    improvement_vs_baseline: Record<string, number>;
    can_promote: boolean;
  } | null;

  // Intent from AI Context
  intent: {
    problem_type: string | null;
    window_days: number | null;
    recommended_metrics: string[];
    guardrails: string[];
  } | null;

  // Recent Audit Logs
  recentAuditLogs: Array<{
    action: string;
    timestamp: string;
    resource_type: string;
    metadata: Record<string, any> | null;
  }>;
}

export interface UseDashboardStateResult {
  state: DashboardState;
  ssot: SSOTData;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useDashboardState(projectId: string): UseDashboardStateResult {
  const [ssot, setSsot] = useState<SSOTData>({
    datasetState: null,
    scoreReport: null,
    scoringJob: null,
    modelSelection: null,
    modelingContract: null,
    modelingDataset: null,
    productionModel: null,
    intent: null,
    recentAuditLogs: [],
  });
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);

    try {
      const [
        dsStateRes, scoreReportRes, scoringJobRes,
        modelSelectionRes, contractRes, modelingDatasetRes,
        prodModelRes, aiCtxRes, auditRes,
      ] = await Promise.all([
        supabase.from('project_dataset_state' as any).select('*').eq('project_id', projectId).maybeSingle(),
        supabase.from('project_score_reports' as any).select('*').eq('project_id', projectId).eq('is_latest', true).maybeSingle(),
        supabase.from('project_scoring_jobs' as any).select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('project_model_selection' as any).select('*').eq('project_id', projectId).maybeSingle(),
        supabase.from('project_modeling_contracts' as any).select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('project_modeling_datasets' as any).select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('project_models').select('id, algorithm_name, deployed_at, deployed_selection_version, hyperparameters')
          .eq('project_id', projectId).eq('is_production', true).eq('status', 'trained').maybeSingle(),
        supabase.from('project_ai_context').select('context').eq('project_id', projectId).maybeSingle(),
        supabase.from('audit_logs').select('action, timestamp, resource_type, metadata')
          .eq('project_id', projectId).order('timestamp', { ascending: false }).limit(20),
      ]);

      const hp = (prodModelRes.data?.hyperparameters as Record<string, any>) || {};
      const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
      const intent = aiCtx?.intent || aiCtx?.problem_inference;
      const modelingDs = modelingDatasetRes.data as any;
      const contractData = contractRes.data as any;
      const selData = modelSelectionRes.data as any;
      const dsState = dsStateRes.data as any;
      const scoreData = scoreReportRes.data as any;
      const jobData = scoringJobRes.data as any;

      const featuresFinal = contractData?.features_final;
      const featuresBlocked = contractData?.features_blocked;

      setSsot({
        datasetState: dsState ? {
          source_type: dsState.source_type || 'upload',
          row_count: dsState.row_count || 0,
          col_count: dsState.col_count || 0,
          eda_ready: dsState.eda_ready || false,
          model_ready: dsState.model_ready || false,
          virtual_manifest: dsState.virtual_manifest || false,
          production_model_id: dsState.production_model_id || null,
          active_dataset_ref: dsState.active_dataset_ref || null,
        } : null,

        scoreReport: scoreData ? {
          status: scoreData.status || 'unknown',
          coverage_pct: scoreData.coverage_pct || 0,
          predictions_count: scoreData.predictions_count || 0,
          batch_id: scoreData.batch_id || null,
          warnings: scoreData.warnings || [],
          missing_feature_pct: scoreData.missing_feature_pct || 0,
          gates_snapshot: scoreData.gates_snapshot || null,
          created_at: scoreData.created_at,
        } : null,

        scoringJob: jobData ? {
          status: jobData.status || 'unknown',
          error_code: jobData.error_code || null,
          error_friendly: jobData.error_friendly || null,
          started_at: jobData.created_at,
          completed_at: jobData.completed_at || null,
        } : null,

        modelSelection: selData ? {
          selection_version: selData.selection_version || 0,
          target_column: selData.target_column || null,
          target_hash: selData.target_hash || null,
          features_count: Array.isArray(selData.feature_columns) ? selData.feature_columns.length : 0,
        } : null,

        modelingContract: contractData ? {
          status: contractData.status || 'unknown',
          contract_version: contractData.contract_version || 'v1',
          split_strategy: contractData.split_strategy || 'stratified',
          anchor_time_col: contractData.anchor_time_col || null,
          features_final_count: Array.isArray(featuresFinal) ? featuresFinal.length : 0,
          features_blocked_count: Array.isArray(featuresBlocked) ? featuresBlocked.length : 0,
          leakage_flags_count: Array.isArray(contractData.leakage_flags) ? contractData.leakage_flags.length : 0,
          blocked_reasons: contractData.blocked_reasons ? 
            (Array.isArray(contractData.blocked_reasons) ? contractData.blocked_reasons : [String(contractData.blocked_reasons)]) : null,
        } : null,

        modelingDataset: modelingDs ? {
          status: modelingDs.status || 'unknown',
          selection_version_used: modelingDs.selection_version_used || null,
          feature_report: modelingDs.feature_report || null,
          missing_feature_pct: modelingDs.missing_feature_pct || 0,
          overfit_risk_score: modelingDs.overfit_risk_score || null,
        } : null,

        productionModel: prodModelRes.data ? {
          id: prodModelRes.data.id,
          algorithm_name: prodModelRes.data.algorithm_name,
          deployed_at: prodModelRes.data.deployed_at,
          deployed_selection_version: prodModelRes.data.deployed_selection_version,
          hyperparameters: hp,
          model_quality_flag: hp?.model_quality_flag || null,
          dashboard_allowed: hp?.dashboard_allowed !== false,
          prediction_sanity: hp?.prediction_sanity || null,
          baseline_metrics: hp?.baseline_metrics || {},
          improvement_vs_baseline: hp?.improvement_vs_baseline || {},
          can_promote: hp?.can_promote !== false,
        } : null,

        intent: intent ? {
          problem_type: intent.problem_type || null,
          window_days: intent.window_days || intent.horizon_days || null,
          recommended_metrics: intent.recommended_metrics || [],
          guardrails: intent.guardrails || [],
        } : null,

        recentAuditLogs: (auditRes.data || []).map((l: any) => ({
          action: l.action,
          timestamp: l.timestamp,
          resource_type: l.resource_type,
          metadata: l.metadata,
        })),
      });
    } catch (err) {
      console.error('[useDashboardState] Error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Determine state
  const state = determineDashboardState(ssot);

  return { state, ssot, loading, refetch: fetchAll };
}

function determineDashboardState(ssot: SSOTData): DashboardState {
  const { productionModel, scoreReport, scoringJob } = ssot;

  // ERROR: last scoring job errored
  if (scoringJob?.status === 'ERROR' || scoringJob?.status === 'error') {
    return 'ERROR';
  }

  // RUNNING: scoring in progress
  if (scoringJob?.status === 'RUNNING' || scoringJob?.status === 'CONTINUE' || scoringJob?.status === 'running') {
    return 'RUNNING';
  }

  // BLOCKED: no production model, dashboard not allowed, or scoring blocked
  if (!productionModel) return 'BLOCKED';
  if (!productionModel.dashboard_allowed) return 'BLOCKED';
  if (productionModel.model_quality_flag === 'fail') return 'BLOCKED';
  if (scoringJob?.status === 'BLOCKED' || scoringJob?.status === 'blocked') return 'BLOCKED';

  // NO_PREDICTIONS: model exists but no scores
  if (!scoreReport || scoreReport.predictions_count === 0 || scoreReport.coverage_pct === 0) {
    return 'NO_PREDICTIONS';
  }

  // READY
  if (scoreReport.status === 'DONE' && scoreReport.coverage_pct > 0) {
    return 'READY';
  }

  return 'NO_PREDICTIONS';
}
