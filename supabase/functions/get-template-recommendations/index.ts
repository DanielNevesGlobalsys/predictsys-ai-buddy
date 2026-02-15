import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { industry, intent_id, project_id } = body;

    if (!industry) {
      return new Response(JSON.stringify({ error: "industry required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load template stats for this industry
    const { data: stats, error: statsErr } = await supabase
      .from("template_quality_stats")
      .select("*")
      .or(`industry.eq.${industry},industry.eq.generic`)
      .order("success_rate", { ascending: false });

    if (statsErr) {
      console.error("[Recommendations] Stats error:", statsErr);
    }

    // If intent_id filter provided, prioritize matching
    const allStats = (stats || []) as any[];

    // Score each template
    const scored = allStats.map((s: any) => {
      let confidence = 0.5;
      let reasons: string[] = [];

      // Base: success rate
      confidence += (s.success_rate ?? 0) * 0.3;
      if (s.success_rate >= 0.8) reasons.push("Alta taxa de sucesso");

      // Monitoring score contribution
      if (s.avg_monitoring_score >= 80) {
        confidence += 0.1;
        reasons.push("Score de monitoramento consistente");
      }

      // Sanity fail penalty
      if (s.sanity_fail_rate > 0.2) {
        confidence -= 0.2;
        reasons.push("⚠️ Taxa de sanity fail elevada");
      }

      // Rating bonus
      if (s.avg_rating >= 4) {
        confidence += 0.1;
        reasons.push("Bem avaliado por usuários");
      } else if (s.avg_rating > 0 && s.avg_rating < 2.5) {
        confidence -= 0.1;
        reasons.push("⚠️ Avaliação baixa de usuários");
      }

      // Intent match bonus
      if (intent_id && s.intent_id === intent_id) {
        confidence += 0.1;
        reasons.push("Match de intenção exato");
      }

      // Industry exact match
      if (s.industry === industry) {
        confidence += 0.05;
      }

      // Coverage
      if (s.avg_coverage >= 80) {
        reasons.push("Boa cobertura média");
      }

      confidence = Math.max(0, Math.min(1, confidence));

      return {
        template_id: s.template_id,
        industry: s.industry,
        intent_id: s.intent_id,
        reason: reasons.join(". ") || "Template disponível",
        confidence: Math.round(confidence * 100) / 100,
        expected_fit: confidence >= 0.7 ? "high" : confidence >= 0.4 ? "medium" : "low",
        stats: {
          total_uses: s.total_uses,
          success_rate: s.success_rate,
          avg_monitoring_score: s.avg_monitoring_score,
          sanity_fail_rate: s.sanity_fail_rate,
          avg_rating: s.avg_rating,
        },
      };
    });

    // Sort by confidence descending
    scored.sort((a: any, b: any) => b.confidence - a.confidence);

    // Take top 5
    const recommendations = scored.slice(0, 5);

    return new Response(JSON.stringify({
      success: true,
      recommendations,
      total_templates_evaluated: allStats.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[Recommendations] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
