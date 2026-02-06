import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const HIGH_THRESHOLD = 0.7;

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

    // Build query
    let query = supabase
      .from('predictions')
      .select('id, entity_id, probability_event, predicted_value, potential_value, prediction_date, problem_type, horizon_days')
      .eq('project_id', project_id)
      .eq('is_latest', true)
      .lte('horizon_days', horizon);

    if (segment_field && segment_value) {
      query = (query as any).eq(segment_field, segment_value);
    }

    const { data: predictions, error: predError } = await query;

    if (predError) {
      console.error('[Dashboard Metrics] Error fetching predictions:', predError);
      return new Response(
        JSON.stringify({ error: 'Erro ao buscar previsões: ' + predError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Dashboard Metrics] Total predictions fetched: ${predictions?.length || 0}`);

    if (!predictions || predictions.length === 0) {
      return new Response(JSON.stringify({
        horizon,
        mode,
        segment: segment_value || 'all',
        problem_type: 'classification',
        summary_cards: {
          entities_with_prediction: 0,
          high_risk_or_opportunity: 0,
          expected_events: 0,
          financial_impact: 0,
          predicted_total_value: 0,
          predicted_avg_value: 0,
          coverage: 0,
          last_update: null
        },
        probability_buckets: [],
        segments: []
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Detect problem type
    const problemType = predictions[0]?.problem_type || 'classification';
    const isClassification = problemType === 'classification';

    // Calculate KPIs
    const uniqueEntities = new Set(predictions.map(p => p.entity_id));
    const entitiesWithPrediction = uniqueEntities.size;

    let highRiskOrOpportunity = 0;
    let expectedEvents = 0;
    let financialImpact = 0;
    let lastUpdateDate: string | null = null;
    let totalPredictedValue = 0;
    const allPredictedValues: number[] = [];

    predictions.forEach(p => {
      if (isClassification) {
        const prob = p.probability_event ?? 0;
        if (prob >= HIGH_THRESHOLD) {
          highRiskOrOpportunity++;
        }
        expectedEvents += prob;
        const value = p.potential_value ?? p.predicted_value ?? 0;
        financialImpact += prob * value;
      } else {
        // Regression
        const value = p.predicted_value ?? 0;
        totalPredictedValue += value;
        allPredictedValues.push(value);
      }

      if (!lastUpdateDate || (p.prediction_date && p.prediction_date > lastUpdateDate)) {
        lastUpdateDate = p.prediction_date;
      }
    });

    // For regression, financial impact = total predicted value
    if (!isClassification) {
      financialImpact = totalPredictedValue;
      expectedEvents = totalPredictedValue;
    }

    const predictedAvgValue = allPredictedValues.length > 0
      ? totalPredictedValue / allPredictedValues.length
      : 0;

    // Coverage
    const { count: totalBaseCount } = await supabase
      .from('predictions')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project_id)
      .eq('is_latest', true);

    const totalBase = totalBaseCount || entitiesWithPrediction;
    const coverage = totalBase > 0 ? entitiesWithPrediction / totalBase : 1;

    console.log(`[Dashboard Metrics] KPIs: Entities=${entitiesWithPrediction}, HighRisk=${highRiskOrOpportunity}, Expected=${expectedEvents.toFixed(2)}, Impact=${financialImpact.toFixed(2)}, Coverage=${(coverage * 100).toFixed(1)}%, PredTotal=${totalPredictedValue.toFixed(2)}, PredAvg=${predictedAvgValue.toFixed(2)}`);

    // Calculate segmentation buckets
    let probabilityBuckets;

    if (isClassification) {
      const buckets = [
        { bucket: '0-20%', min: 0, max: 0.2, count: 0, sumValue: 0, sumProb: 0 },
        { bucket: '20-40%', min: 0.2, max: 0.4, count: 0, sumValue: 0, sumProb: 0 },
        { bucket: '40-60%', min: 0.4, max: 0.6, count: 0, sumValue: 0, sumProb: 0 },
        { bucket: '60-80%', min: 0.6, max: 0.8, count: 0, sumValue: 0, sumProb: 0 },
        { bucket: '80-100%', min: 0.8, max: 1.0, count: 0, sumValue: 0, sumProb: 0 }
      ];

      predictions.forEach(p => {
        const prob = p.probability_event ?? 0;
        const value = p.potential_value ?? p.predicted_value ?? 0;
        for (const bucket of buckets) {
          if (prob >= bucket.min && (prob < bucket.max || (bucket.max === 1.0 && prob <= 1.0))) {
            bucket.count++;
            bucket.sumValue += value;
            bucket.sumProb += prob;
            break;
          }
        }
      });

      probabilityBuckets = buckets.map(b => ({
        bucket: b.bucket,
        count: b.count,
        avg_value: b.count > 0 ? b.sumValue / b.count : 0,
        total_value: b.sumValue,
        expected_events: b.sumProb,
        percent: predictions.length > 0 ? (b.count / predictions.length) * 100 : 0
      }));
    } else {
      // Regression: quantile-based bins (p25/p50/p75/p90/p95)
      const values = allPredictedValues.sort((a, b) => a - b);

      if (values.length > 0) {
        const getQuantile = (arr: number[], q: number) => {
          const pos = (arr.length - 1) * q;
          const base = Math.floor(pos);
          const rest = pos - base;
          if (arr[base + 1] !== undefined) {
            return arr[base] + rest * (arr[base + 1] - arr[base]);
          }
          return arr[base];
        };

        const p25 = getQuantile(values, 0.25);
        const p50 = getQuantile(values, 0.50);
        const p75 = getQuantile(values, 0.75);
        const p90 = getQuantile(values, 0.90);
        const minVal = values[0];
        const maxVal = values[values.length - 1];

        // Build quantile-based bins
        const quantileBins = [
          { label: 'Até P25', min: minVal, max: p25 },
          { label: 'P25–P50', min: p25, max: p50 },
          { label: 'P50–P75', min: p50, max: p75 },
          { label: 'P75–P90', min: p75, max: p90 },
          { label: 'Acima P90', min: p90, max: maxVal + 0.01 },
        ];

        const formatVal = (v: number) => {
          if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
          if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
          return v.toFixed(0);
        };

        // Deduplicate bins with same min/max (happens when many values are identical)
        const seenBuckets = new Set<string>();
        probabilityBuckets = [];

        for (let i = 0; i < quantileBins.length; i++) {
          const bin = quantileBins[i];
          const bucketKey = `${bin.min.toFixed(2)}-${bin.max.toFixed(2)}`;
          if (seenBuckets.has(bucketKey) && i > 0) continue;
          seenBuckets.add(bucketKey);

          const isLast = i === quantileBins.length - 1;
          const inBucket = predictions.filter(p => {
            const v = p.predicted_value ?? 0;
            if (isLast) return v >= bin.min && v <= maxVal;
            return v >= bin.min && v < bin.max;
          });

          const totalVal = inBucket.reduce((s, p) => s + (p.predicted_value ?? 0), 0);

          probabilityBuckets.push({
            bucket: `R$ ${formatVal(bin.min)} – ${formatVal(isLast ? maxVal : bin.max)}`,
            count: inBucket.length,
            avg_value: inBucket.length > 0 ? totalVal / inBucket.length : 0,
            total_value: totalVal,
            expected_events: 0,
            percent: predictions.length > 0 ? (inBucket.length / predictions.length) * 100 : 0
          });
        }
      } else {
        probabilityBuckets = [];
      }
    }

    console.log(`[Dashboard Metrics] Buckets:`, probabilityBuckets.map(b => `${b.bucket}: ${b.count}`).join(', '));

    // Segments
    const segmentFields = ['segment', 'age_group', 'region', 'state', 'city', 'product_category', 'channel', 'campaign', 'cohort'];
    const availableSegments: { field: string; values: string[] }[] = [];

    for (const field of segmentFields) {
      const { data: segData } = await supabase
        .from('predictions')
        .select(field)
        .eq('project_id', project_id)
        .eq('is_latest', true)
        .not(field, 'is', null)
        .limit(100);

      if (segData && segData.length > 0) {
        const uniqueValues = [...new Set(segData.map(s => s[field as keyof typeof s]).filter(Boolean))] as string[];
        if (uniqueValues.length > 0) {
          availableSegments.push({ field, values: uniqueValues.slice(0, 50) });
        }
      }
    }

    const response = {
      horizon,
      mode,
      segment: segment_value || 'all',
      problem_type: problemType,
      summary_cards: {
        entities_with_prediction: entitiesWithPrediction,
        high_risk_or_opportunity: highRiskOrOpportunity,
        expected_events: Math.round(expectedEvents * 100) / 100,
        financial_impact: Math.round(financialImpact * 100) / 100,
        predicted_total_value: Math.round(totalPredictedValue * 100) / 100,
        predicted_avg_value: Math.round(predictedAvgValue * 100) / 100,
        coverage,
        last_update: lastUpdateDate
      },
      probability_buckets: probabilityBuckets,
      segments: availableSegments
    };

    console.log(`[Dashboard Metrics] Response ready for project ${project_id}`);

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
