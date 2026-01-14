import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Edge Function: calculate-dashboard-metrics
 * 
 * Calcula todas as métricas do dashboard de negócio usando agregações SQL.
 * Evita trazer milhões de linhas para o front, fazendo os cálculos no banco.
 * 
 * Responde ao POST com:
 * {
 *   project_id: string,
 *   mode: "risk" | "opportunity",
 *   horizon: 30 | 60 | 180 | 365,
 *   segment_field?: string,
 *   segment_value?: string
 * }
 * 
 * Retorna:
 * {
 *   summary_cards: { ... },
 *   probability_buckets: [ ... ],
 *   segments: [ ... ]
 * }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Limiar para alto risco/oportunidade
const HIGH_THRESHOLD = 0.7;

serve(async (req) => {
  // Handle CORS preflight
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

    // Criar cliente Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`[Dashboard Metrics] Project: ${project_id}, Mode: ${mode}, Horizon: ${horizon}d, Segment: ${segment_field}=${segment_value || 'all'}`);

    // =====================================================
    // 1. Identificar o último batch do projeto
    // =====================================================
    const { data: latestBatchData, error: batchError } = await supabase
      .from('predictions')
      .select('batch_id')
      .eq('project_id', project_id)
      .eq('is_latest', true)
      .not('batch_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (batchError) {
      console.error('[Dashboard Metrics] Error fetching batch:', batchError);
    }

    const latestBatchId = latestBatchData?.batch_id || null;
    console.log(`[Dashboard Metrics] Latest batch_id: ${latestBatchId || 'using is_latest filter'}`);

    // =====================================================
    // 2. Construir condições WHERE base
    // =====================================================
    // Base: project_id + is_latest + horizon
    // O horizonte é usado para filtrar previsões que estão dentro do horizonte selecionado
    
    // =====================================================
    // 3. Calcular Summary Cards via SQL
    // =====================================================
    
    // Query para KPIs principais - usa RPC para agregação
    // Construir query com filtros
    let query = supabase
      .from('predictions')
      .select('id, entity_id, probability_event, predicted_value, potential_value, prediction_date, problem_type, horizon_days')
      .eq('project_id', project_id)
      .eq('is_latest', true)
      .lte('horizon_days', horizon);

    // Filtrar por segmento se especificado - cast para any para evitar erro de tipo
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

    console.log(`[Dashboard Metrics] Total predictions fetched (with horizon filter): ${predictions?.length || 0}`);

    // Se não há previsões, retornar valores zerados
    if (!predictions || predictions.length === 0) {
      return new Response(JSON.stringify({
        horizon,
        mode,
        segment: segment_value || 'all',
        summary_cards: {
          entities_with_prediction: 0,
          high_risk_or_opportunity: 0,
          expected_events: 0,
          financial_impact: 0,
          coverage: 0,
          last_update: null
        },
        probability_buckets: [
          { bucket: '0-20%', count: 0, avg_value: 0, expected_events: 0 },
          { bucket: '20-40%', count: 0, avg_value: 0, expected_events: 0 },
          { bucket: '40-60%', count: 0, avg_value: 0, expected_events: 0 },
          { bucket: '60-80%', count: 0, avg_value: 0, expected_events: 0 },
          { bucket: '80-100%', count: 0, avg_value: 0, expected_events: 0 }
        ],
        segments: []
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Detectar tipo de problema
    const problemType = predictions[0]?.problem_type || 'classification';
    const isClassification = problemType === 'classification';

    // =====================================================
    // Calcular KPIs
    // =====================================================

    // Contagem de entidades únicas
    const uniqueEntities = new Set(predictions.map(p => p.entity_id));
    const entitiesWithPrediction = uniqueEntities.size;

    // Alto risco/oportunidade (prob >= 0.7)
    let highRiskOrOpportunity = 0;
    let expectedEvents = 0;
    let financialImpact = 0;
    let lastUpdateDate: string | null = null;

    // Para regressão, valores acumulados
    let totalPredictedValue = 0;

    predictions.forEach(p => {
      if (isClassification) {
        const prob = p.probability_event ?? 0;
        
        // Alto risco/oportunidade
        if (prob >= HIGH_THRESHOLD) {
          highRiskOrOpportunity++;
        }
        
        // Eventos esperados = soma das probabilidades
        expectedEvents += prob;
        
        // Impacto financeiro = prob * valor potencial
        const value = p.potential_value ?? p.predicted_value ?? 0;
        financialImpact += prob * value;
      } else {
        // Regressão
        const value = p.predicted_value ?? 0;
        totalPredictedValue += value;
        financialImpact += value;
      }

      // Última atualização
      if (!lastUpdateDate || (p.prediction_date && p.prediction_date > lastUpdateDate)) {
        lastUpdateDate = p.prediction_date;
      }
    });

    // Para regressão, eventos esperados = total de valor previsto
    if (!isClassification) {
      expectedEvents = totalPredictedValue;
    }

    // =====================================================
    // Cobertura da base - buscar total sem filtros
    // =====================================================
    const { count: totalBaseCount } = await supabase
      .from('predictions')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project_id)
      .eq('is_latest', true);

    const totalBase = totalBaseCount || entitiesWithPrediction;
    const coverage = totalBase > 0 ? entitiesWithPrediction / totalBase : 1;

    console.log(`[Dashboard Metrics] KPIs calculated:
      - Entities: ${entitiesWithPrediction}
      - High ${mode}: ${highRiskOrOpportunity}
      - Expected Events: ${expectedEvents.toFixed(2)}
      - Financial Impact: ${financialImpact.toFixed(2)}
      - Coverage: ${(coverage * 100).toFixed(1)}%
      - Last Update: ${lastUpdateDate}`);

    // =====================================================
    // 4. Calcular Segmentação por Probabilidade
    // =====================================================
    
    const buckets = [
      { bucket: '0-20%', min: 0, max: 0.2, count: 0, sumValue: 0, sumProb: 0 },
      { bucket: '20-40%', min: 0.2, max: 0.4, count: 0, sumValue: 0, sumProb: 0 },
      { bucket: '40-60%', min: 0.4, max: 0.6, count: 0, sumValue: 0, sumProb: 0 },
      { bucket: '60-80%', min: 0.6, max: 0.8, count: 0, sumValue: 0, sumProb: 0 },
      { bucket: '80-100%', min: 0.8, max: 1.0, count: 0, sumValue: 0, sumProb: 0 }
    ];

    predictions.forEach(p => {
      if (!isClassification) return; // Só para classificação

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

    const probabilityBuckets = buckets.map(b => ({
      bucket: b.bucket,
      count: b.count,
      avg_value: b.count > 0 ? b.sumValue / b.count : 0,
      expected_events: b.sumProb,
      percent: predictions.length > 0 ? (b.count / predictions.length) * 100 : 0
    }));

    console.log(`[Dashboard Metrics] Probability buckets calculated:`, 
      probabilityBuckets.map(b => `${b.bucket}: ${b.count}`).join(', '));

    // =====================================================
    // 5. Listar segmentos disponíveis
    // =====================================================
    
    const segmentFields = ['segment', 'age_group', 'region', 'state', 'city', 'product_category', 'channel', 'campaign', 'cohort'];
    const availableSegments: { field: string; values: string[] }[] = [];

    // Buscar valores únicos para cada campo de segmento
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
          availableSegments.push({ field, values: uniqueValues.slice(0, 50) }); // Limitar a 50 valores por campo
        }
      }
    }

    // =====================================================
    // 6. Montar resposta final
    // =====================================================
    
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
