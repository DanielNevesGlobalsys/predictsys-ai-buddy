import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ═══ Server-side template registry (mirrors labelTemplates.ts) ═══

interface TemplateSpec {
  template_id: string;
  display_name: string;
  problem_type: "classification" | "regression";
  industry: string;
  requires_entity_key: boolean;
  requires_time_anchor: boolean;
  requires_event_column: boolean;
  required_signals: string[]; // "entity" | "time" | "value" | "status"
  compatible_shapes: string[]; // dataset shapes where this template works best
  family: string[]; // objective family tags for matching
  default_params: Record<string, unknown>;
}

const TEMPLATE_REGISTRY: Record<string, TemplateSpec> = {
  churn_retail: {
    template_id: "churn_retail",
    display_name: "Churn de Clientes (Varejo)",
    problem_type: "classification",
    industry: "retail",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    required_signals: ["entity", "time"],
    compatible_shapes: ["transactional", "events"],
    family: ["churn", "retention", "inatividade"],
    default_params: { window_days: 90, reference_date_strategy: "max_date" },
  },
  no_show_health: {
    template_id: "no_show_health",
    display_name: "No-Show (Falta em Consulta)",
    problem_type: "classification",
    industry: "health",
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: true,
    required_signals: ["entity", "status"],
    compatible_shapes: ["transactional", "events", "snapshot"],
    family: ["no_show", "falta", "absenteeism"],
    default_params: { positive_values: ["no_show", "missed", "faltou", "No-Show", "ausente"], status_column: "" },
  },
  adesao_tratamento_health: {
    template_id: "adesao_tratamento_health",
    display_name: "Adesão ao Tratamento (Saúde)",
    problem_type: "classification",
    industry: "health",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    required_signals: ["entity", "time"],
    compatible_shapes: ["transactional", "events"],
    family: ["adesao", "tratamento", "dropout", "abandono"],
    default_params: { window_days: 60 },
  },
  churn_generic: {
    template_id: "churn_generic",
    display_name: "Churn de Clientes (Genérico)",
    problem_type: "classification",
    industry: "generic",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    required_signals: ["entity", "time"],
    compatible_shapes: ["transactional", "events"],
    family: ["churn", "retention", "inatividade"],
    default_params: { window_days: 90, reference_date_strategy: "max_date" },
  },
  generic_event_no_activity: {
    template_id: "generic_event_no_activity",
    display_name: "Inatividade (Universal)",
    problem_type: "classification",
    industry: "generic",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    required_signals: ["entity", "time"],
    compatible_shapes: ["transactional", "events"],
    family: ["churn", "inatividade", "retention"],
    default_params: { window_days: 90, reference_date_strategy: "max_date" },
  },
  generic_threshold_binary: {
    template_id: "generic_threshold_binary",
    display_name: "Limiar Binário (Universal)",
    problem_type: "classification",
    industry: "generic",
    requires_entity_key: false,
    requires_time_anchor: false,
    requires_event_column: false,
    required_signals: [],
    compatible_shapes: ["snapshot", "transactional", "events", "timeseries"],
    family: ["threshold", "limiar", "inadimplencia", "score"],
    default_params: { threshold_value: 30, value_column: "" },
  },
  generic_future_sum_regression: {
    template_id: "generic_future_sum_regression",
    display_name: "Soma Futura (Regressão Universal)",
    problem_type: "regression",
    industry: "generic",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    required_signals: ["entity", "time", "value"],
    compatible_shapes: ["transactional", "events", "timeseries"],
    family: ["revenue", "receita", "forecast", "regression", "soma"],
    default_params: { window_days: 90, value_column: "" },
  },
  inadimplencia_por_atraso: {
    template_id: "inadimplencia_por_atraso",
    display_name: "Inadimplência por Atraso (Finanças)",
    problem_type: "classification",
    industry: "finance",
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: false,
    required_signals: ["entity", "value"],
    compatible_shapes: ["transactional", "snapshot"],
    family: ["inadimplencia", "default", "atraso", "credit"],
    default_params: { atraso_dias: 30 },
  },
  inadimplencia_por_status: {
    template_id: "inadimplencia_por_status",
    display_name: "Inadimplência por Status (Finanças)",
    problem_type: "classification",
    industry: "finance",
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: true,
    required_signals: ["entity", "status"],
    compatible_shapes: ["transactional", "snapshot"],
    family: ["inadimplencia", "default", "credit", "status"],
    default_params: { negative_statuses: ["em_aberto", "atrasado", "inadimplente", "defaulted", "atraso", "vencido"], status_column: "" },
  },
};

const UNIVERSAL_IDS = [
  "generic_event_no_activity",
  "generic_threshold_binary",
  "generic_future_sum_regression",
];

// ═══ Signal strength normalizer ═══════════════════════════════

function normalizeStrength(score: number): number {
  if (score >= 10) return 1.0;
  if (score >= 7) return 0.7;
  if (score >= 4) return 0.4;
  if (score >= 1) return 0.2;
  return 0;
}

// ═══ Types ═══════════════════════════════════════════════════════

interface Recommendation {
  template_id: string;
  confidence: number;
  business_name: string;
  why_this: string[];
  params_suggestion: Record<string, unknown>;
  required_signals: string[];
  expected_problem_type: string;
  is_fallback: boolean;
}

interface Signals {
  entity_ok: boolean;
  time_ok: boolean;
  value_ok: boolean;
  status_ok: boolean;
  shape: string;
  entity_strength: number;
  time_strength: number;
  value_strength: number;
  status_strength: number;
}

// ═══ Main ═══════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    console.log(`[tde-recommend-targets] Starting for project=${project_id}`);

    // Load AI context
    const { data: ctxRow } = await supabase
      .from("project_ai_context")
      .select("id, context")
      .eq("project_id", project_id)
      .maybeSingle();

    const aiContext = (ctxRow?.context as Record<string, unknown>) || {};
    const intentContract = (aiContext.intent_contract || aiContext.intent || {}) as Record<string, unknown>;
    const intentBase = (intentContract.intent_base || intentContract) as Record<string, unknown>;
    const domainAdapter = (intentContract.domain_adapter || {}) as Record<string, unknown>;
    const tdeProfile = (aiContext.tde_profile || {}) as Record<string, unknown>;
    const contractHints = (aiContext.contract_hints || {}) as Record<string, unknown>;
    const tdeHints = (contractHints.tde || tdeProfile) as Record<string, unknown>;

    // ─── Extract signals from TDE profile ─────────────────────

    const candidates = (tdeProfile.candidates || tdeHints.candidates || {}) as Record<string, { column: string; score: number; reasons: string[] }[]>;
    const entityCandidates = candidates.entity_candidates || [];
    const timeCandidates = candidates.time_candidates || [];
    const valueCandidates = candidates.value_candidates || [];
    const statusCandidates = candidates.status_candidates || [];

    const entityTopScore = entityCandidates[0]?.score ?? 0;
    const timeTopScore = timeCandidates[0]?.score ?? 0;
    const valueTopScore = valueCandidates[0]?.score ?? 0;
    const statusTopScore = statusCandidates[0]?.score ?? 0;

    const signals: Signals = {
      entity_ok: entityTopScore >= 6,
      time_ok: timeTopScore >= 6,
      value_ok: valueTopScore >= 6,
      status_ok: statusTopScore >= 6,
      shape: (tdeProfile.dataset_shape as string) || (tdeHints.dataset_shape as string) || "snapshot",
      entity_strength: normalizeStrength(entityTopScore),
      time_strength: normalizeStrength(timeTopScore),
      value_strength: normalizeStrength(valueTopScore),
      status_strength: normalizeStrength(statusTopScore),
    };

    const requiresTime = (intentBase.requires_time_column as boolean) ?? true;
    const industry = (domainAdapter.industry as string) || (intentBase.industry as string) || "generic";
    const declaredObjective = ((intentBase.declared_objective as string) || "").toLowerCase();
    const problemType = (intentBase.problem_type as string) || "";

    // Adapter recommended template IDs
    const adapterRecs: string[] = [];
    const rawAdapterRecs = domainAdapter.recommended_templates as { template_id: string }[] | undefined;
    if (Array.isArray(rawAdapterRecs)) {
      for (const r of rawAdapterRecs) {
        if (r.template_id) adapterRecs.push(r.template_id);
      }
    }

    // ─── Build candidate pool ─────────────────────────────────

    const poolSet = new Set<string>();

    // 1) Adapter recommended
    for (const tid of adapterRecs) {
      if (TEMPLATE_REGISTRY[tid]) poolSet.add(tid);
    }

    // 2) Same industry
    for (const [tid, spec] of Object.entries(TEMPLATE_REGISTRY)) {
      if (spec.industry === industry) poolSet.add(tid);
    }

    // 3) Objective family match
    if (declaredObjective) {
      for (const [tid, spec] of Object.entries(TEMPLATE_REGISTRY)) {
        if (spec.family.some(f => declaredObjective.includes(f))) poolSet.add(tid);
      }
    }

    // 4) Always include universals
    for (const uid of UNIVERSAL_IDS) poolSet.add(uid);

    // 5) If pool too small, add all
    if (poolSet.size < 3) {
      for (const tid of Object.keys(TEMPLATE_REGISTRY)) poolSet.add(tid);
    }

    // ─── Score each template ──────────────────────────────────

    const scored: { tid: string; score: number; reasons: string[]; notes: string[] }[] = [];

    for (const tid of poolSet) {
      const spec = TEMPLATE_REGISTRY[tid];
      if (!spec) continue;

      let score = 0.40;
      const reasons: string[] = [];
      const notes: string[] = [];

      // +0.25 if in adapter recommended
      if (adapterRecs.includes(tid)) {
        score += 0.25;
        reasons.push("Recomendado pelo adaptador de indústria");
      }

      // +0.15 if problem_type matches
      if (problemType && spec.problem_type === problemType) {
        score += 0.15;
        reasons.push(`Tipo de problema compatível (${problemType})`);
      }

      // +0.15 max for required_signals satisfaction
      const signalMap: Record<string, number> = {
        entity: signals.entity_strength,
        time: signals.time_strength,
        value: signals.value_strength,
        status: signals.status_strength,
      };
      for (const sig of spec.required_signals) {
        const strength = signalMap[sig] ?? 0;
        score += 0.08 * strength;
        if (strength >= 0.7) {
          reasons.push(`Sinal "${sig}" detectado com confiança`);
        }
      }

      // +0.05 if shape compatible
      if (spec.compatible_shapes.includes(signals.shape)) {
        score += 0.05;
        reasons.push(`Dataset ${signals.shape} é compatível`);
      }

      // -0.20 penalty if requires time but time is weak
      if (spec.requires_time_anchor && requiresTime && signals.time_strength < 0.6) {
        score -= 0.20;
        notes.push("Template requer coluna temporal, mas sinal fraco");
      }

      // Clamp
      score = Math.max(0, Math.min(1, score));

      scored.push({ tid, score, reasons, notes });
    }

    // Sort descending
    scored.sort((a, b) => b.score - a.score);

    // ─── Build final recommendations ──────────────────────────

    const recommendations: Recommendation[] = [];
    const usedIds = new Set<string>();
    let fallbackUsed = false;

    // Take top scorers
    for (const item of scored) {
      if (recommendations.length >= 3) break;
      if (usedIds.has(item.tid)) continue;

      const spec = TEMPLATE_REGISTRY[item.tid];
      const isFallback = UNIVERSAL_IDS.includes(item.tid) && !adapterRecs.includes(item.tid) && spec.industry === "generic";

      if (isFallback) fallbackUsed = true;

      recommendations.push({
        template_id: item.tid,
        confidence: Math.round(item.score * 100) / 100,
        business_name: spec.display_name,
        why_this: item.reasons.slice(0, 4),
        params_suggestion: spec.default_params,
        required_signals: spec.required_signals,
        expected_problem_type: spec.problem_type,
        is_fallback: isFallback,
      });
      usedIds.add(item.tid);
    }

    // Guarantee at least 1 universal fallback
    const hasUniversal = recommendations.some(r => UNIVERSAL_IDS.includes(r.template_id));
    if (!hasUniversal) {
      // Replace lowest-confidence with a universal
      const fallbackId = UNIVERSAL_IDS.find(u => !usedIds.has(u)) || UNIVERSAL_IDS[0];
      const fbSpec = TEMPLATE_REGISTRY[fallbackId];
      if (fbSpec && recommendations.length >= 3) {
        recommendations[2] = {
          template_id: fallbackId,
          confidence: 0.40,
          business_name: fbSpec.display_name,
          why_this: ["Fallback universal — funciona com qualquer dataset"],
          params_suggestion: fbSpec.default_params,
          required_signals: fbSpec.required_signals,
          expected_problem_type: fbSpec.problem_type,
          is_fallback: true,
        };
        fallbackUsed = true;
      }
    }

    // Fill up to 3 if needed
    while (recommendations.length < 3) {
      const filler = UNIVERSAL_IDS.find(u => !usedIds.has(u));
      if (!filler) break;
      const spec = TEMPLATE_REGISTRY[filler];
      if (!spec) break;
      recommendations.push({
        template_id: filler,
        confidence: 0.35,
        business_name: spec.display_name,
        why_this: ["Fallback universal — funciona com qualquer dataset"],
        params_suggestion: spec.default_params,
        required_signals: spec.required_signals,
        expected_problem_type: spec.problem_type,
        is_fallback: true,
      });
      usedIds.add(filler);
      fallbackUsed = true;
    }

    // ─── Health compliance ─────────────────────────────────────

    const complianceRestrictions: Record<string, boolean> = {};
    if (industry === "health") {
      complianceRestrictions.disable_free_text_feedback = true;
    }

    // ─── Collect notes ────────────────────────────────────────

    const allNotes: string[] = [];
    for (const item of scored.slice(0, 5)) {
      for (const n of item.notes) allNotes.push(`[${item.tid}] ${n}`);
    }

    // ─── Persist to AI context ────────────────────────────────

    const tdeRecommendations = {
      generated_at: new Date().toISOString(),
      recommendations: recommendations.map(r => ({
        template_id: r.template_id,
        confidence: r.confidence,
        business_name: r.business_name,
        is_fallback: r.is_fallback,
      })),
      fallback_used: fallbackUsed,
      signals,
    };

    // Ring buffer: keep last 5
    const existingHistory = Array.isArray(aiContext.tde_recommendations_history)
      ? aiContext.tde_recommendations_history as unknown[]
      : [];
    const newHistory = [...existingHistory, tdeRecommendations].slice(-5);

    // Slim version for contract_hints
    const slimRecs = recommendations.map(r => ({
      template_id: r.template_id,
      confidence: r.confidence,
    }));

    const updatedHints = {
      ...(aiContext.contract_hints as Record<string, unknown> || {}),
      tde_recommendations: slimRecs,
    };

    const updatedContext = {
      ...aiContext,
      tde_recommendations: tdeRecommendations,
      tde_recommendations_history: newHistory,
      contract_hints: updatedHints,
    };

    if (ctxRow?.id) {
      await supabase
        .from("project_ai_context")
        .update({ context: updatedContext, last_updated_at: new Date().toISOString() })
        .eq("id", ctxRow.id);
    }

    console.log(`[tde-recommend-targets] Done. Top=${recommendations[0]?.template_id}, fallback=${fallbackUsed}`);

    // ─── Response ─────────────────────────────────────────────

    return new Response(
      JSON.stringify({
        success: true,
        recommendations,
        fallback_used: fallbackUsed,
        notes: allNotes,
        signals,
        compliance_restrictions: Object.keys(complianceRestrictions).length > 0 ? complianceRestrictions : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[tde-recommend-targets] Error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
