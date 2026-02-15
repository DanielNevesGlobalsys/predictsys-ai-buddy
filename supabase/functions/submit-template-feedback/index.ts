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

    // Validate JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { project_id, template_id, rating, tags, comment } = body;

    if (!project_id || !template_id) {
      return new Response(JSON.stringify({ error: "project_id and template_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate project ownership
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, organization_id, industry, user_id")
      .eq("id", project_id)
      .single();

    if (projErr || !project || project.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "project not found or not owned" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Gather automatic signals in parallel
    const [selectionRes, predStateRes, monitoringRes, auditRes, modelRes] = await Promise.all([
      supabase.from("project_model_selection").select("selection_version, problem_type").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_prediction_state").select("latest_batch_id, status, coverage_pct").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_monitoring_state").select("monitoring_score, status").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_contract_audits").select("predictability_score").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1),
      supabase.from("project_models").select("hyperparameters").eq("project_id", project_id).eq("is_production", true).maybeSingle(),
    ]);

    const selection = selectionRes.data as any;
    const predState = predStateRes.data as any;
    const monitoring = monitoringRes.data as any;
    const audit = (auditRes.data as any)?.[0];
    const prodModel = modelRes.data as any;

    // Extract champion metrics
    const hp = prodModel?.hyperparameters as any;
    const championScore = hp?.champion_score ?? hp?.best_score ?? null;
    const prAuc = hp?.pr_auc ?? null;

    const signals = {
      coverage_pct: predState?.coverage_pct ?? null,
      monitoring_score: monitoring?.monitoring_score ?? null,
      monitoring_status: monitoring?.status ?? null,
      sanity_fail: predState?.status === "sanity_fail",
      predictability_score: audit?.predictability_score ?? null,
      champion_score: championScore,
      pr_auc: prAuc,
      problem_type: selection?.problem_type ?? null,
    };

    // Resolve intent_id from AI context
    const { data: aiCtx } = await supabase
      .from("project_ai_context")
      .select("context")
      .eq("project_id", project_id)
      .maybeSingle();

    const ctx = aiCtx?.context as any;
    const intentId = ctx?.intent_contract?.intent_base?.intent_id
      || ctx?.intent_contract?.intent_id
      || null;

    // Insert feedback
    const { error: insertErr } = await supabase.from("project_template_feedback").insert({
      project_id,
      organization_id: project.organization_id,
      user_id: user.id,
      template_id,
      industry: project.industry || null,
      intent_id: intentId,
      selection_version: selection?.selection_version ?? null,
      batch_id: predState?.latest_batch_id ?? null,
      feedback_type: "explicit",
      rating: rating ?? null,
      tags: tags ?? [],
      comment: comment ?? null,
      signals,
    });

    if (insertErr) {
      console.error("[TemplateFeedback] Insert error:", insertErr);
      return new Response(JSON.stringify({ error: insertErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Best-effort: update template_quality_stats aggregate
    try {
      await updateTemplateStats(supabase, template_id, project.industry, intentId);
    } catch (e) {
      console.warn("[TemplateFeedback] Stats update failed:", e);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[TemplateFeedback] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function updateTemplateStats(supabase: any, templateId: string, industry: string | null, intentId: string | null) {
  // Aggregate from feedback table
  const { data: feedbacks } = await supabase
    .from("project_template_feedback")
    .select("rating, signals, feedback_type")
    .eq("template_id", templateId)
    .limit(500);

  if (!feedbacks || feedbacks.length === 0) return;

  const totalUses = feedbacks.length;
  const ratings = feedbacks.filter((f: any) => f.rating != null).map((f: any) => f.rating as number);
  const avgRating = ratings.length > 0 ? ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length : 0;

  const monScores = feedbacks.map((f: any) => f.signals?.monitoring_score).filter((v: any) => v != null);
  const avgMonScore = monScores.length > 0 ? monScores.reduce((a: number, b: number) => a + b, 0) / monScores.length : 0;

  const coverages = feedbacks.map((f: any) => f.signals?.coverage_pct).filter((v: any) => v != null);
  const avgCoverage = coverages.length > 0 ? coverages.reduce((a: number, b: number) => a + b, 0) / coverages.length : 0;

  const sanityFails = feedbacks.filter((f: any) => f.signals?.sanity_fail === true).length;
  const sanityFailRate = totalUses > 0 ? sanityFails / totalUses : 0;

  const predScores = feedbacks.map((f: any) => f.signals?.predictability_score).filter((v: any) => v != null);
  const avgConfidence = predScores.length > 0 ? predScores.reduce((a: number, b: number) => a + b, 0) / predScores.length : 0;

  // Success = monitoring_score >= 70 AND no sanity_fail
  const successes = feedbacks.filter((f: any) =>
    (f.signals?.monitoring_score ?? 100) >= 70 && !f.signals?.sanity_fail
  ).length;
  const successRate = totalUses > 0 ? successes / totalUses : 0;

  await supabase.from("template_quality_stats").upsert({
    template_id: templateId,
    industry: industry || "generic",
    intent_id: intentId || "generic",
    total_uses: totalUses,
    success_rate: Math.round(successRate * 1000) / 1000,
    avg_monitoring_score: Math.round(avgMonScore * 10) / 10,
    avg_confidence: Math.round(avgConfidence * 10) / 10,
    sanity_fail_rate: Math.round(sanityFailRate * 1000) / 1000,
    avg_coverage: Math.round(avgCoverage * 10) / 10,
    avg_rating: Math.round(avgRating * 10) / 10,
    updated_at: new Date().toISOString(),
  }, { onConflict: "template_id,industry,intent_id" });
}
