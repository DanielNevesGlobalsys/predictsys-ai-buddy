import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface PredictionState {
  status: string;
  latest_batch_id: string | null;
  predictions_count: number;
  coverage_pct: number;
  last_error_code: string | null;
  last_error_message: string | null;
  latest_model_id: string | null;
}

/**
 * Dashboard Metrics v2 — SSOT-aligned
 * 
 * 1. Reads project_prediction_state (SSOT) to resolve batch
 * 2. If status != done → returns diagnostics + CTAs
 * 3. If done → calculates KPIs using RPC with latest_batch_id context
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      project_id,
      mode = 'risk',
      horizon = 30,
      segment_field = null,
      segment_value = null,
    } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: 'project_id é obrigatório' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`[Dashboard Metrics v2] Project: ${project_id}, Horizon: ${horizon}d, Segment: ${segment_field}=${segment_value || 'all'}`);

    // ═══ Step 1: Read SSOT (project_prediction_state) ═══
    const { data: predState, error: stateError } = await supabase
      .from('project_prediction_state')
      .select('status, latest_batch_id, predictions_count, coverage_pct, last_error_code, last_error_message, latest_model_id')
      .eq('project_id', project_id)
      .maybeSingle();

    if (stateError) {
      console.error('[Dashboard Metrics v2] State read error:', stateError);
    }

    const pState = predState as PredictionState | null;

    // ═══ Step 2: Non-done states → return diagnostics + CTAs ═══
    if (pState && pState.status !== 'done' && pState.status !== 'idle') {
      const ctaMap: Record<string, { label: string; action: string; step?: number }[]> = {
        running: [{ label: 'Atualizar status', action: 'refresh' }],
        finalizing: [
          { label: 'Finalizar scoring', action: 'finalize_scoring' },
          { label: 'Atualizar status', action: 'refresh' },
        ],
        failed: [
          { label: 'Tentar novamente', action: 'run_scoring' },
          { label: 'Revisar contrato', action: 'goto_step', step: 3 },
        ],
        sanity_fail: [
          { label: 'Revisar target e features', action: 'goto_step', step: 4 },
          { label: 'Retreinar modelo', action: 'goto_step', step: 6 },
        ],
      };

      const messageMap: Record<string, string> = {
        running: 'O scoring está processando o dataset. Aguarde ou atualize o status.',
        finalizing: 'As previsões foram geradas e estão sendo promovidas. Se demorar, finalize manualmente.',
        failed: `Scoring falhou${pState.last_error_message ? ': ' + pState.last_error_message : '.'}`,
        sanity_fail: 'As previsões geradas são degeneradas (pouca variação). Revise o target/features e retreine.',
      };

      console.log(`[Dashboard Metrics v2] Non-done state: ${pState.status}`);

      return new Response(JSON.stringify({
        dashboard_status: pState.status,
        message: messageMap[pState.status] || 'Estado desconhecido.',
        ctas: ctaMap[pState.status] || [],
        diagnostics: {
          project_id,
          prediction_state_status: pState.status,
          latest_batch_id: pState.latest_batch_id,
          predictions_count: pState.predictions_count,
          coverage_pct: pState.coverage_pct,
          error_code: pState.last_error_code,
          error_message: pState.last_error_message,
        },
        // Empty KPIs for frontend compat
        summary_cards: {
          entities_with_prediction: pState.predictions_count || 0,
          high_risk_or_opportunity: 0, expected_events: 0,
          financial_impact: 0, predicted_total_value: 0,
          predicted_avg_value: 0, coverage: pState.coverage_pct / 100 || 0,
          last_update: null,
        },
        probability_buckets: [],
        segments: [],
        problem_type: 'classification',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ═══ Step 3: Resolve batch_id ═══
    const latestBatchId = pState?.latest_batch_id || null;

    console.log(`[Dashboard Metrics v2] Resolved batch: ${latestBatchId || 'legacy(is_latest)'}`);

    // ═══ Step 4: Calculate KPIs via server-side RPC ═══
    const { data: agg, error: rpcError } = await supabase.rpc('calculate_dashboard_kpis', {
      p_project_id: project_id,
      p_horizon: horizon,
    });

    if (rpcError) {
      console.error('[Dashboard Metrics v2] RPC error:', rpcError);
      throw new Error('Erro ao calcular métricas: ' + rpcError.message);
    }

    if (!agg || agg.total_rows === 0) {
      console.warn(`[Dashboard Metrics v2] No predictions found`);
      return new Response(JSON.stringify({
        dashboard_status: 'no_predictions',
        message: 'Nenhuma previsão encontrada. Execute o scoring primeiro.',
        ctas: [{ label: 'Executar scoring', action: 'run_scoring' }],
        horizon, mode,
        segment: segment_value || 'all',
        problem_type: 'classification',
        diagnostics: {
          project_id,
          resolved_batch_id: latestBatchId,
          predictions_count_used_for_kpis: 0,
          coverage_pct: 0,
          total_latest_in_db: 0,
          prediction_state_status: pState?.status || 'none',
        },
        summary_cards: {
          entities_with_prediction: 0, high_risk_or_opportunity: 0,
          expected_events: 0, financial_impact: 0,
          predicted_total_value: 0, predicted_avg_value: 0,
          coverage: 0, last_update: null,
        },
        probability_buckets: [],
        segments: [],
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ═══ Step 5: Version drift detection ═══
    let selectionVersionScored: number | null = null;
    let selectionVersionCurrent: number | null = null;
    let staleResults = false;

    const [deployedModelRes, currentSelectionRes] = await Promise.all([
      // Get the selection_version that was used when scoring
      supabase
        .from('project_models')
        .select('deployed_selection_version')
        .eq('project_id', project_id)
        .eq('is_production', true)
        .maybeSingle(),
      // Get the current selection_version from SSOT
      supabase
        .from('project_model_selection')
        .select('selection_version')
        .eq('project_id', project_id)
        .maybeSingle(),
    ]);

    selectionVersionScored = (deployedModelRes.data as any)?.deployed_selection_version ?? null;
    selectionVersionCurrent = (currentSelectionRes.data as any)?.selection_version ?? null;
    
    if (selectionVersionScored !== null && selectionVersionCurrent !== null && selectionVersionScored < selectionVersionCurrent) {
      staleResults = true;
      console.log(`[Dashboard Metrics v2] Version drift detected: scored=${selectionVersionScored}, current=${selectionVersionCurrent}`);
    }

    // ═══ Step 6: Build response ═══
    const problemType = agg.problem_type || 'classification';
    const isClassification = problemType === 'classification';
    const totalRows = agg.total_rows || 0;
    const totalLatest = agg.total_latest || totalRows;
    const coveragePct = totalLatest > 0 ? (totalRows / totalLatest) * 100 : 100;

    // Get recommended_threshold from production model
    const { data: prodModelData } = await supabase
      .from('project_models')
      .select('hyperparameters')
      .eq('project_id', project_id)
      .eq('is_production', true)
      .maybeSingle();
    
    const hp = prodModelData?.hyperparameters as any;
    const recommendedThreshold = hp?.recommended_threshold ?? hp?.best_threshold ?? 0.5;

    // Probability buckets
    let probabilityBuckets: any[];

    if (isClassification) {
      const rawBuckets = agg.classification_buckets || [];
      const allBucketLabels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
      probabilityBuckets = allBucketLabels.map(label => {
        const found = rawBuckets.find((b: any) => b.bucket === label);
        return {
          bucket: label,
          count: found?.count || 0,
          avg_value: found?.avg_value || 0,
          total_value: found?.total_value || 0,
          expected_events: found?.expected_events || 0,
          percent: totalRows > 0 ? ((found?.count || 0) / totalRows) * 100 : 0,
        };
      });
    } else {
      const rs = agg.regression_stats;
      if (rs && rs.total_count > 0) {
        const formatVal = (v: number) => {
          if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
          if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
          return v.toFixed(0);
        };
        const bins = [
          { label: 'Até P25', min: rs.min_val, max: rs.p25 },
          { label: 'P25–P50', min: rs.p25, max: rs.p50 },
          { label: 'P50–P75', min: rs.p50, max: rs.p75 },
          { label: 'P75–P90', min: rs.p75, max: rs.p90 },
          { label: 'Acima P90', min: rs.p90, max: rs.max_val },
        ];
        const approxPerBin = Math.round(rs.total_count / 5);
        probabilityBuckets = bins.map((bin, i) => ({
          bucket: `R$ ${formatVal(bin.min)} – ${formatVal(bin.max)}`,
          count: i < 4 ? approxPerBin : rs.total_count - approxPerBin * 4,
          avg_value: (bin.min + bin.max) / 2,
          total_value: ((bin.min + bin.max) / 2) * approxPerBin,
          expected_events: 0,
          percent: totalRows > 0 ? (approxPerBin / totalRows) * 100 : 0,
        }));
      } else {
        probabilityBuckets = [];
      }
    }

    // Segments — use batch_id if available, also track null coverage
    const segmentFields = ['segment', 'age_group', 'region', 'state', 'city', 'product_category', 'channel', 'campaign', 'cohort'];
    const availableSegments: { field: string; values: string[]; null_count?: number; null_pct?: number }[] = [];

    const segmentPromises = segmentFields.map(async (field) => {
      let query = supabase
        .from('predictions')
        .select(field)
        .eq('project_id', project_id)
        .eq('is_latest', true)
        .not(field, 'is', null)
        .limit(100);

      if (latestBatchId) {
        query = query.eq('batch_id', latestBatchId);
      }

      const { data: segData } = await query;

      if (segData && segData.length > 0) {
        const uniqueValues = [...new Set(segData.map((s: any) => s[field]).filter(Boolean))] as string[];
        if (uniqueValues.length > 0) {
          // Count nulls for this segment field
          const nullCount = totalRows - segData.length; // approximate from sample
          const nullPct = totalRows > 0 ? (nullCount / totalRows) * 100 : 0;
          return { field, values: uniqueValues.slice(0, 50), null_count: nullCount, null_pct: +nullPct.toFixed(1) };
        }
      }
      return null;
    });

    const segmentResults = await Promise.all(segmentPromises);
    for (const seg of segmentResults) {
      if (seg) availableSegments.push(seg);
    }

    // Fetch confidence inputs in parallel
    const [auditRes, scoreReportRes] = await Promise.all([
      supabase
        .from('project_contract_audits')
        .select('predictability_score')
        .eq('project_id', project_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('project_score_reports')
        .select('coverage_pct, warnings, missing_feature_pct')
        .eq('project_id', project_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const predictabilityScore = (auditRes.data as any)?.predictability_score ?? null;
    const scoreReportCoverage = (scoreReportRes.data as any)?.coverage_pct ?? pState?.coverage_pct ?? null;
    const missingFeaturePct = (scoreReportRes.data as any)?.missing_feature_pct ?? null;
    const isSanityFail = pState?.status === 'sanity_fail';

    // Compute confidence score (0-100)
    let confidenceScore: number | null = null;
    if (predictabilityScore !== null || scoreReportCoverage !== null) {
      const ps = predictabilityScore ?? 50; // 0-100
      const cov = scoreReportCoverage ?? 100; // 0-100
      const mfPenalty = missingFeaturePct ? Math.min(missingFeaturePct, 30) : 0; // cap at 30 penalty
      const sanityPenalty = isSanityFail ? 40 : 0;
      confidenceScore = Math.max(0, Math.min(100,
        Math.round(ps * 0.4 + cov * 0.35 + (100 - mfPenalty * 2) * 0.25 - sanityPenalty)
      ));
    }

    const financialImpact = isClassification
      ? agg.financial_impact_class
      : agg.total_predicted_value;

    const expectedEvents = isClassification
      ? agg.sum_probability
      : agg.total_predicted_value;

    const coverage = totalLatest > 0 ? agg.entities_with_prediction / totalLatest : 1;

    const response = {
      dashboard_status: 'done',
      horizon, mode,
      segment: segment_value || 'all',
      problem_type: problemType,
      recommended_threshold: recommendedThreshold,
      stale_results: staleResults,
      selection_version_scored: selectionVersionScored,
      selection_version_current: selectionVersionCurrent,
      confidence_score: confidenceScore,
      confidence_inputs: {
        predictability_score: predictabilityScore,
        coverage_pct: scoreReportCoverage,
        missing_feature_pct: missingFeaturePct,
        sanity_fail: isSanityFail,
      },
      diagnostics: {
        project_id,
        resolved_batch_id: latestBatchId || 'legacy(is_latest)',
        prediction_state_status: pState?.status || 'none',
        predictions_count_used_for_kpis: totalRows,
        coverage_pct: +coveragePct.toFixed(2),
        total_latest_in_db: totalLatest,
      },
      summary_cards: {
        entities_with_prediction: agg.entities_with_prediction,
        high_risk_or_opportunity: agg.high_risk_or_opportunity || 0,
        expected_events: Math.round(expectedEvents * 100) / 100,
        financial_impact: Math.round(financialImpact * 100) / 100,
        predicted_total_value: Math.round(agg.total_predicted_value * 100) / 100,
        predicted_avg_value: Math.round(agg.avg_predicted_value * 100) / 100,
        coverage,
        last_update: agg.last_update,
      },
      probability_buckets: probabilityBuckets,
      segments: availableSegments,
    };

    console.log(`[Dashboard Metrics v2] Done: entities=${agg.entities_with_prediction}, rows=${totalRows}, confidence=${confidenceScore}, batch=${latestBatchId || 'legacy'}`);

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[Dashboard Metrics v2] Error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Erro interno';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
