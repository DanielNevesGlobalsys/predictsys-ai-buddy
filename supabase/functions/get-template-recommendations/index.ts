import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Reason codes (stable for i18n/analytics) ──────────────────
type ReasonCode =
  | "HIGH_SUCCESS_RATE"
  | "HIGH_MONITORING_SCORE"
  | "LOW_SANITY_FAIL"
  | "HIGH_USER_RATING"
  | "INTENT_MATCH"
  | "INDUSTRY_MATCH"
  | "HIGH_COVERAGE"
  | "PENALTY_SANITY_FAIL"
  | "PENALTY_LOW_RATING"
  | "COLD_START"
  | "HARD_STOP_SANITY";

interface ReasonEntry {
  code: ReasonCode;
  weight: number;
}

// ─── Bayesian smoothing for cold start (improvement #1) ────────
function smoothedRate(wins: number, total: number, priorWins = 5, priorTotal = 10): number {
  return (wins + priorWins) / (total + priorTotal);
}

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

    // ── Improvement #3: strict industry filtering (no cross-contamination) ──
    const { data: stats, error: statsErr } = await supabase
      .from("template_quality_stats")
      .select("*")
      .or(`industry.eq.${industry},industry.eq.generic`)
      .order("success_rate", { ascending: false });

    if (statsErr) {
      console.error("[Recommendations] Stats error:", statsErr);
    }

    const allStats = (stats || []) as any[];

    // Score each template
    const scored = allStats.map((s: any) => {
      const reasons: ReasonEntry[] = [];
      let confidence = 0.5;
      const totalUses = s.total_uses ?? 0;

      // ── Improvement #1: Bayesian smoothing for cold start ──
      const isColdStart = totalUses < 20;
      const rawSuccessRate = s.success_rate ?? 0;
      const successes = Math.round(rawSuccessRate * totalUses);
      const adjustedSuccessRate = isColdStart
        ? smoothedRate(successes, totalUses)
        : rawSuccessRate;

      if (isColdStart) {
        reasons.push({ code: "COLD_START", weight: 0 });
      }

      // ── Improvement #2: Weighted composite score ──
      // score = 0.5*success + 0.3*(avg_monitoring/100) + 0.2*(avg_rating/5)
      const monNorm = (s.avg_monitoring_score ?? 0) / 100;
      const ratingNorm = (s.avg_rating ?? 0) / 5;
      confidence = 0.5 * adjustedSuccessRate + 0.3 * monNorm + 0.2 * ratingNorm;

      // Dataset quality penalty: reduce confidence when avg predictability is low
      const avgConfidence = s.avg_confidence ?? 100;
      if (avgConfidence < 50) {
        confidence *= 0.8; // 20% penalty for bad datasets
      }

      if (adjustedSuccessRate >= 0.7) reasons.push({ code: "HIGH_SUCCESS_RATE", weight: 0.3 });
      if (monNorm >= 0.8) reasons.push({ code: "HIGH_MONITORING_SCORE", weight: 0.1 });

      // ── Improvement #4: Hard stop for high sanity_fail_rate ──
      const sanityFailRate = s.sanity_fail_rate ?? 0;
      const isHardStop = sanityFailRate > 0.15;

      if (sanityFailRate > 0.1) {
        confidence -= 0.2;
        reasons.push({ code: "PENALTY_SANITY_FAIL", weight: -0.2 });
      }
      if (isHardStop) {
        reasons.push({ code: "HARD_STOP_SANITY", weight: -0.5 });
      }

      // Rating
      if ((s.avg_rating ?? 0) >= 4) {
        reasons.push({ code: "HIGH_USER_RATING", weight: 0.1 });
      } else if ((s.avg_rating ?? 0) > 0 && (s.avg_rating ?? 0) < 2.5) {
        confidence -= 0.1;
        reasons.push({ code: "PENALTY_LOW_RATING", weight: -0.1 });
      }

      // Intent match
      if (intent_id && s.intent_id === intent_id) {
        confidence += 0.1;
        reasons.push({ code: "INTENT_MATCH", weight: 0.1 });
      }

      // ── Improvement #3: Industry exact match bonus ──
      if (s.industry === industry) {
        confidence += 0.05;
        reasons.push({ code: "INDUSTRY_MATCH", weight: 0.05 });
      }

      // Coverage
      if ((s.avg_coverage ?? 0) >= 80) {
        reasons.push({ code: "HIGH_COVERAGE", weight: 0 });
      }

      if (sanityFailRate <= 0.1) {
        reasons.push({ code: "LOW_SANITY_FAIL", weight: 0.05 });
      }

      confidence = Math.max(0, Math.min(1, confidence));

      return {
        template_id: s.template_id,
        industry: s.industry,
        intent_id: s.intent_id,
        // ── Improvement #8: Stable reason_codes for i18n ──
        reason_codes: reasons.map(r => r.code),
        reasons,
        confidence: Math.round(confidence * 100) / 100,
        expected_fit: isHardStop ? "blocked" : confidence >= 0.7 ? "high" : confidence >= 0.4 ? "medium" : "low",
        is_hard_stop: isHardStop,
        is_cold_start: isColdStart,
        stats: {
          total_uses: totalUses,
          success_rate: rawSuccessRate,
          adjusted_success_rate: Math.round(adjustedSuccessRate * 1000) / 1000,
          avg_monitoring_score: s.avg_monitoring_score,
          sanity_fail_rate: sanityFailRate,
          avg_rating: s.avg_rating,
          avg_confidence: avgConfidence,
        },
      };
    });

    // Sort: non-hard-stop first, then by confidence descending
    scored.sort((a: any, b: any) => {
      if (a.is_hard_stop !== b.is_hard_stop) return a.is_hard_stop ? 1 : -1;
      return b.confidence - a.confidence;
    });

    // Take top 5, mark hard stops as alternatives
    const recommendations = scored.slice(0, 5).map((r: any) => ({
      ...r,
      recommendation_id: `rec_${r.template_id}_${Date.now()}`,
    }));

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
