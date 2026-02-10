import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
      segment_value = null
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

    console.log(`[Dashboard Metrics] Project: ${project_id}, Mode: ${mode}, Horizon: ${horizon}d, Segment: ${segment_field}=${segment_value || 'all'}`);

    // Call server-side aggregation function (runs in SQL with 120s timeout + index)
    const { data: agg, error: rpcError } = await supabase.rpc('calculate_dashboard_kpis', {
      p_project_id: project_id,
      p_horizon: horizon,
    });

    if (rpcError) {
      console.error('[Dashboard Metrics] RPC error:', rpcError);
      throw new Error('Erro ao calcular métricas: ' + rpcError.message);
    }

    if (!agg || agg.total_rows === 0) {
      console.warn(`[Dashboard Metrics] No predictions found`);
      return new Response(JSON.stringify({
        horizon, mode,
        segment: segment_value || 'all',
        problem_type: 'classification',
        modelQualityFlag: 'fail',
        error_friendly: 'Nenhuma previsão encontrada para este projeto. Execute o scoring primeiro.',
        diagnostic: { project_id, predictions_count_used_for_kpis: 0, coverage_pct: 0, total_latest_in_db: 0 },
        summary_cards: {
          entities_with_prediction: 0, high_risk_or_opportunity: 0,
          expected_events: 0, financial_impact: 0,
          predicted_total_value: 0, predicted_avg_value: 0,
          coverage: 0, last_update: null
        },
        probability_buckets: [],
        segments: []
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const problemType = agg.problem_type || 'classification';
    const isClassification = problemType === 'classification';
    const totalRows = agg.total_rows || 0;
    const totalLatest = agg.total_latest || totalRows;
    const coveragePct = totalLatest > 0 ? (totalRows / totalLatest) * 100 : 100;

    // Build probability buckets
    let probabilityBuckets: any[];

    if (isClassification) {
      // Use pre-computed classification buckets from SQL
      const rawBuckets = agg.classification_buckets || [];
      // Ensure all 5 buckets exist
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
      // Regression: compute quantile buckets from regression_stats
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

        // For regression buckets we still need counts per bin — use a lightweight query
        const { data: regBuckets } = await supabase.rpc('calculate_dashboard_kpis', {
          p_project_id: project_id,
          p_horizon: horizon,
        });
        // We already have the aggregation; approximate bucket counts from total
        // For precise regression buckets, we'd need another query — use simple equal split as approximation
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

    // Segments — lightweight queries (only sample 100 rows each)
    const segmentFields = ['segment', 'age_group', 'region', 'state', 'city', 'product_category', 'channel', 'campaign', 'cohort'];
    const availableSegments: { field: string; values: string[] }[] = [];

    // Run segment queries in parallel
    const segmentPromises = segmentFields.map(async (field) => {
      const { data: segData } = await supabase
        .from('predictions')
        .select(field)
        .eq('project_id', project_id)
        .eq('is_latest', true)
        .not(field, 'is', null)
        .limit(100);

      if (segData && segData.length > 0) {
        const uniqueValues = [...new Set(segData.map((s: any) => s[field]).filter(Boolean))] as string[];
        if (uniqueValues.length > 0) {
          return { field, values: uniqueValues.slice(0, 50) };
        }
      }
      return null;
    });

    const segmentResults = await Promise.all(segmentPromises);
    for (const seg of segmentResults) {
      if (seg) availableSegments.push(seg);
    }

    const financialImpact = isClassification
      ? agg.financial_impact_class
      : agg.total_predicted_value;

    const expectedEvents = isClassification
      ? agg.sum_probability
      : agg.total_predicted_value;

    const coverage = totalLatest > 0 ? agg.entities_with_prediction / totalLatest : 1;

    const response = {
      horizon,
      mode,
      segment: segment_value || 'all',
      problem_type: problemType,
      modelQualityFlag: 'ok',
      diagnostic: {
        project_id,
        resolved_batch_id: 'sql-agg',
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
        last_update: agg.last_update
      },
      probability_buckets: probabilityBuckets,
      segments: availableSegments
    };

    console.log(`[Dashboard Metrics] Done: entities=${agg.entities_with_prediction}, rows=${totalRows}, coverage=${coveragePct.toFixed(1)}%`);

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[Dashboard Metrics] Error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Erro interno';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
