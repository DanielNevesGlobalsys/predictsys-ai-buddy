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
  | "HARD_STOP_SANITY"
  | "RECENTLY_SUCCESSFUL"
  | "BEST_FIT_FOR_CONTEXT"
  | "POOR_FIT_MISSING_FIELDS"
  | "LOW_PREDICTABILITY"
  | "EXPLORE_SLOT";

interface ReasonEntry {
  code: ReasonCode;
  weight: number;
}

// ─── Bayesian smoothing ────────────────────────────────────────
function smoothedRate(wins: number, total: number, priorWins = 5, priorTotal = 10): number {
  return (wins + priorWins) / (total + priorTotal);
}

// ─── Clamp helper ──────────────────────────────────────────────
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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

    // ── Fetch stats (strict industry filtering) ──
    const { data: stats, error: statsErr } = await supabase
      .from("template_quality_stats")
      .select("*")
      .or(`industry.eq.${industry},industry.eq.generic`)
      .order("success_rate", { ascending: false });

    if (statsErr) console.error("[Recommendations] Stats error:", statsErr);

    // ── Fetch project context for fit_multiplier (Ajuste 2) ──
    let projectContext: {
      has_time_anchor: boolean;
      time_anchor_confidence: number;
      has_entity_key: boolean;
      entity_key_confidence: number;
      missing_feature_pct: number;
      predictability_score: number;
    } | null = null;

    if (project_id) {
      try {
        // Get modeling contract for entity/time anchor info
        const { data: contract } = await supabase
          .from("project_modeling_contracts")
          .select("anchor_time_col, entity_key, column_roles")
          .eq("project_id", project_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Get contract audit for predictability
        const { data: audit } = await supabase
          .from("project_contract_audits")
          .select("predictability_score")
          .eq("project_id", project_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Get column inference for confidence scores
        const { data: inferences } = await supabase
          .from("project_column_inference")
          .select("column_name, semantic_role, confidence_score")
          .eq("project_id", project_id);

        const timeAnchorCol = contract?.anchor_time_col;
        const entityKey = contract?.entity_key;
        const timeInf = inferences?.find((c: any) => c.column_name === timeAnchorCol);
        const entityInf = inferences?.find((c: any) =>
          entityKey && (
            (typeof entityKey === 'string' && c.column_name === entityKey) ||
            (Array.isArray(entityKey) && entityKey.includes(c.column_name)) ||
            (typeof entityKey === 'object' && entityKey?.column === c.column_name)
          )
        );

        // Estimate missing feature pct from column roles
        const columnRoles = contract?.column_roles as Record<string, any> | null;
        let missingPct = 0;
        if (columnRoles) {
          const featureCols = Object.entries(columnRoles).filter(([_, v]: [string, any]) => v === 'feature' || v?.role === 'feature');
          const blockedCols = Object.entries(columnRoles).filter(([_, v]: [string, any]) => v === 'blocked' || v?.role === 'blocked');
          const total = featureCols.length + blockedCols.length;
          if (total > 0) missingPct = blockedCols.length / total;
        }

        projectContext = {
          has_time_anchor: !!timeAnchorCol,
          time_anchor_confidence: timeInf?.confidence_score ?? 0,
          has_entity_key: !!entityKey,
          entity_key_confidence: entityInf?.confidence_score ?? 0,
          missing_feature_pct: missingPct,
          predictability_score: audit?.predictability_score ?? 100,
        };
      } catch (ctxErr) {
        console.warn("[Recommendations] Context fetch error (non-fatal):", ctxErr);
      }
    }

    const allStats = (stats || []) as any[];
    const now = Date.now();

    // ── Score each template ──
    const scored = allStats.map((s: any) => {
      const reasons: ReasonEntry[] = [];
      const totalUses = s.total_uses ?? 0;
      const isColdStart = totalUses < 20;

      // Bayesian smoothing
      const rawSuccessRate = s.success_rate ?? 0;
      const successes = Math.round(rawSuccessRate * totalUses);
      const successAdj = isColdStart
        ? smoothedRate(successes, totalUses)
        : rawSuccessRate;

      if (isColdStart) reasons.push({ code: "COLD_START", weight: 0 });

      // ════════════════════════════════════════════════════════
      // AJUSTE 1: Score "qualidade × risco" (multiplicativo)
      // ════════════════════════════════════════════════════════
      const monNorm = clamp((s.avg_monitoring_score ?? 0) / 100, 0.01, 1);
      const ratingNorm = (s.avg_rating ?? 0) > 0 ? clamp((s.avg_rating ?? 0) / 5, 0.01, 1) : 1; // 1 if no rating
      const sanityFailRate = s.sanity_fail_rate ?? 0;
      const driftAlertRate = s.drift_alert_rate ?? 0; // future-proof, defaults 0
      const coverageOkRate = clamp((s.avg_coverage ?? 80) / 100, 0.01, 1);

      const riskPenalty =
        Math.pow(1 - clamp(sanityFailRate, 0, 1), 2.5) *
        Math.pow(1 - clamp(driftAlertRate, 0, 1), 1.5) *
        Math.pow(coverageOkRate, 1.2);

      let finalScore =
        Math.pow(clamp(successAdj, 0.01, 1), 1.2) *
        Math.pow(monNorm, 0.8) *
        Math.pow(ratingNorm, 0.6) *
        riskPenalty;

      // Dataset quality penalty (from v1)
      const avgConfidence = s.avg_confidence ?? 100;
      if (avgConfidence < 50) finalScore *= 0.8;

      // Reason codes for components
      if (successAdj >= 0.7) reasons.push({ code: "HIGH_SUCCESS_RATE", weight: 0.3 });
      if (monNorm >= 0.8) reasons.push({ code: "HIGH_MONITORING_SCORE", weight: 0.1 });
      if (sanityFailRate > 0.1) reasons.push({ code: "PENALTY_SANITY_FAIL", weight: -0.2 });
      if ((s.avg_rating ?? 0) >= 4) reasons.push({ code: "HIGH_USER_RATING", weight: 0.1 });
      else if ((s.avg_rating ?? 0) > 0 && (s.avg_rating ?? 0) < 2.5) reasons.push({ code: "PENALTY_LOW_RATING", weight: -0.1 });
      if ((s.avg_coverage ?? 0) >= 80) reasons.push({ code: "HIGH_COVERAGE", weight: 0 });
      if (sanityFailRate <= 0.1) reasons.push({ code: "LOW_SANITY_FAIL", weight: 0.05 });

      // Hard stop
      const isHardStop = sanityFailRate > 0.15;
      if (isHardStop) reasons.push({ code: "HARD_STOP_SANITY", weight: -0.5 });

      // Intent match
      if (intent_id && s.intent_id === intent_id) {
        finalScore *= 1.10;
        reasons.push({ code: "INTENT_MATCH", weight: 0.1 });
      }

      // Industry exact match
      if (s.industry === industry) {
        finalScore *= 1.05;
        reasons.push({ code: "INDUSTRY_MATCH", weight: 0.05 });
      }

      // ════════════════════════════════════════════════════════
      // AJUSTE 2: Fit multiplier (aderência ao contexto)
      // ════════════════════════════════════════════════════════
      let fitMultiplier = 1.0;
      if (projectContext) {
        // Templates that need time_anchor benefit if project has one
        if (projectContext.has_time_anchor && projectContext.time_anchor_confidence >= 0.7) {
          fitMultiplier += 0.05;
          reasons.push({ code: "BEST_FIT_FOR_CONTEXT", weight: 0.05 });
        }
        // Entity key confidence
        if (projectContext.has_entity_key && projectContext.entity_key_confidence >= 0.7) {
          fitMultiplier += 0.05;
        }
        // High missing feature pct
        if (projectContext.missing_feature_pct > 0.2) {
          fitMultiplier -= 0.10;
          reasons.push({ code: "POOR_FIT_MISSING_FIELDS", weight: -0.10 });
        }
        // Low predictability
        if (projectContext.predictability_score < 60) {
          fitMultiplier -= 0.05;
          reasons.push({ code: "LOW_PREDICTABILITY", weight: -0.05 });
        }
      }
      fitMultiplier = clamp(fitMultiplier, 0.85, 1.15);
      finalScore *= fitMultiplier;

      // ════════════════════════════════════════════════════════
      // AJUSTE 3a: Recency boost
      // ════════════════════════════════════════════════════════
      const updatedAt = s.updated_at ? new Date(s.updated_at).getTime() : 0;
      const daysSinceUpdate = updatedAt > 0 ? (now - updatedAt) / (1000 * 60 * 60 * 24) : 999;
      const recencyBoost = 1 + 0.10 * Math.exp(-daysSinceUpdate / 14);
      finalScore *= recencyBoost;

      if (daysSinceUpdate < 7) reasons.push({ code: "RECENTLY_SUCCESSFUL", weight: 0.05 });

      // Clamp final score
      finalScore = clamp(finalScore, 0, 1);

      return {
        template_id: s.template_id,
        industry: s.industry,
        intent_id: s.intent_id,
        reason_codes: reasons.map(r => r.code),
        reasons,
        final_score: Math.round(finalScore * 1000) / 1000,
        // Legacy field kept for backward compat
        confidence: Math.round(finalScore * 100) / 100,
        expected_fit: isHardStop ? "blocked" : finalScore >= 0.5 ? "high" : finalScore >= 0.25 ? "medium" : "low",
        is_hard_stop: isHardStop,
        is_cold_start: isColdStart,
        is_explore_slot: false, // set below for the explore pick
        score_breakdown: {
          success_adj: Math.round(successAdj * 1000) / 1000,
          monitoring_norm: Math.round(monNorm * 1000) / 1000,
          rating_norm: Math.round(ratingNorm * 1000) / 1000,
          risk_penalty: Math.round(riskPenalty * 1000) / 1000,
          fit_multiplier: Math.round(fitMultiplier * 1000) / 1000,
          recency_boost: Math.round(recencyBoost * 1000) / 1000,
        },
        stats: {
          total_uses: totalUses,
          success_rate: rawSuccessRate,
          adjusted_success_rate: Math.round(successAdj * 1000) / 1000,
          avg_monitoring_score: s.avg_monitoring_score,
          sanity_fail_rate: sanityFailRate,
          avg_rating: s.avg_rating,
          avg_confidence: avgConfidence,
          days_since_update: Math.round(daysSinceUpdate),
        },
      };
    });

    // Sort: non-hard-stop first, then by final_score descending
    scored.sort((a: any, b: any) => {
      if (a.is_hard_stop !== b.is_hard_stop) return a.is_hard_stop ? 1 : -1;
      return b.final_score - a.final_score;
    });

    // ════════════════════════════════════════════════════════
    // AJUSTE 3b: Explore slot (1-slot bandit simplificado)
    // ════════════════════════════════════════════════════════
    const top4 = scored.filter((r: any) => !r.is_hard_stop).slice(0, 4);
    const fifthScore = scored[4]?.final_score ?? 0;
    const threshold = fifthScore * 0.70;

    // Candidates for exploration: low usage, not hard stop, decent score
    const exploreCandidates = scored.filter((r: any) =>
      !r.is_hard_stop &&
      r.stats.total_uses < 30 &&
      r.final_score >= threshold &&
      !top4.find((t: any) => t.template_id === r.template_id && t.industry === r.industry)
    );

    let exploreSlot: any = null;
    if (exploreCandidates.length > 0) {
      // Weighted random by uncertainty = 1/sqrt(uses+1)
      const weights = exploreCandidates.map((c: any) => 1 / Math.sqrt(c.stats.total_uses + 1));
      const totalWeight = weights.reduce((a: number, b: number) => a + b, 0);
      let r = Math.random() * totalWeight;
      for (let i = 0; i < exploreCandidates.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          exploreSlot = { ...exploreCandidates[i], is_explore_slot: true };
          exploreSlot.reason_codes = [...exploreSlot.reason_codes, "EXPLORE_SLOT"];
          exploreSlot.reasons = [...exploreSlot.reasons, { code: "EXPLORE_SLOT", weight: 0 }];
          break;
        }
      }
    }

    // Build final top 5: 4 best + 1 explore (or just top 5 if no explore)
    let recommendations: any[];
    if (exploreSlot) {
      recommendations = [...top4, exploreSlot];
    } else {
      recommendations = scored.slice(0, 5);
    }

    recommendations = recommendations.map((r: any) => ({
      ...r,
      recommendation_id: `rec_${r.template_id}_${Date.now()}`,
    }));

    return new Response(JSON.stringify({
      success: true,
      recommendations,
      total_templates_evaluated: allStats.length,
      has_project_context: !!projectContext,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[Recommendations] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
