import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

// Forbidden terms for health industry (compliance)
const FORBIDDEN_HEALTH_TERMS = /diagnóstico|doença|morte\s*provável|óbito|mortalidade|patologia|prognóstico\s*clínico/gi;

interface MonitoringCheck {
  check: string;
  status: "PASS" | "WARN" | "ALERT" | "FAIL";
  message: string;
  value?: number | string | null;
  threshold?: string;
}

interface MonitoringCTA {
  label: string;
  action: string;
  step?: number;
}

// PSI (Population Stability Index) between two probability distributions
function computePSI(baseline: number[], current: number[], buckets = 10): number {
  if (baseline.length < 10 || current.length < 10) return 0;
  const minVal = 0, maxVal = 1;
  const step = (maxVal - minVal) / buckets;
  let psi = 0;
  const eps = 1e-4;
  for (let i = 0; i < buckets; i++) {
    const lo = minVal + i * step;
    const hi = lo + step;
    const bCount = baseline.filter(v => v >= lo && (i === buckets - 1 ? v <= hi : v < hi)).length;
    const cCount = current.filter(v => v >= lo && (i === buckets - 1 ? v <= hi : v < hi)).length;
    const bPct = Math.max(bCount / baseline.length, eps);
    const cPct = Math.max(cCount / current.length, eps);
    psi += (cPct - bPct) * Math.log(cPct / bPct);
  }
  return Math.abs(psi);
}

// Sanitize health compliance text: strip forbidden diagnostic terms
function sanitizeHealthText(text: string): string {
  return text.replace(FORBIDDEN_HEALTH_TERMS, "[termo removido]");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { project_id, batch_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ========== RATE LIMIT / COOLDOWN ==========
    const { data: existingState } = await supabase
      .from("project_monitoring_state")
      .select("last_run_at")
      .eq("project_id", project_id)
      .maybeSingle();

    if (existingState?.last_run_at) {
      const elapsed = Date.now() - new Date(existingState.last_run_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        const remainSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return new Response(JSON.stringify({
          success: false,
          error: "COOLDOWN",
          message: `Monitoramento executado recentemente. Aguarde ${remainSec}s.`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // Load all needed data in parallel
    const [
      predStateRes, scoreReportsRes, selectionRes, dsStateRes, projectRes,
    ] = await Promise.all([
      supabase.from("project_prediction_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_score_reports").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(5),
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("production_model_id").eq("project_id", project_id).maybeSingle(),
      supabase.from("projects").select("industry, organization_id").eq("id", project_id).single(),
    ]);

    const predState = predStateRes.data as any;
    const scoreReports = (scoreReportsRes.data || []) as any[];
    const selection = selectionRes.data as any;
    const dsState = dsStateRes.data as any;
    const project = projectRes.data as any;

    const productionModelId = dsState?.production_model_id || predState?.model_id;
    const latestBatchId = batch_id || predState?.latest_batch_id;
    const currentReport = scoreReports[0];

    // ===== PSI baseline: find previous DONE batch for the SAME production_model_id =====
    let previousReport: any = null;
    if (currentReport && productionModelId) {
      previousReport = scoreReports.find((r: any, i: number) =>
        i > 0 && r.model_id === productionModelId && r.batch_id !== currentReport.batch_id
      ) || null;
    }
    // Fallback: just use index 1 if no model-matched baseline
    if (!previousReport && scoreReports.length > 1) {
      previousReport = scoreReports[1];
    }

    const checks: MonitoringCheck[] = [];
    const ctas: MonitoringCTA[] = [];
    let score = 100;

    // ========== A) COVERAGE_CHECK ==========
    const coveragePct = currentReport?.coverage_pct ?? predState?.coverage_pct ?? null;
    if (coveragePct !== null) {
      if (coveragePct < 30) {
        checks.push({ check: "COVERAGE_CHECK", status: "ALERT", message: `Cobertura crítica: ${coveragePct.toFixed(1)}%`, value: coveragePct, threshold: "< 30% = ALERT" });
        score -= 25;
        ctas.push({ label: "Rever dataset / filtros", action: "goto_step", step: 2 });
      } else if (coveragePct < 60) {
        checks.push({ check: "COVERAGE_CHECK", status: "WARN", message: `Cobertura baixa: ${coveragePct.toFixed(1)}%`, value: coveragePct, threshold: "< 60% = WARN" });
        score -= 10;
        ctas.push({ label: "Rever dataset / filtros", action: "goto_step", step: 3 });
      } else {
        checks.push({ check: "COVERAGE_CHECK", status: "PASS", message: `Cobertura: ${coveragePct.toFixed(1)}%`, value: coveragePct });
      }
    } else {
      checks.push({ check: "COVERAGE_CHECK", status: "WARN", message: "Sem dados de cobertura disponíveis", value: null });
      score -= 10;
    }

    // ========== B) SANITY_CHECK ==========
    const predStatus = predState?.status;
    const statsSum = currentReport?.stats_summary;
    if (predStatus === "sanity_fail") {
      checks.push({ check: "SANITY_CHECK", status: "ALERT", message: "Previsões degeneradas (sanity_fail). Modelo produz valores constantes.", value: "sanity_fail" });
      score -= 25;
      ctas.push({ label: "Revisar Target/Features", action: "goto_step", step: 4 });
    } else if (statsSum && typeof statsSum.std === "number" && statsSum.std < 0.01) {
      checks.push({ check: "SANITY_CHECK", status: "WARN", message: `Desvio padrão muito baixo: ${statsSum.std.toFixed(4)}`, value: statsSum.std, threshold: "std < 0.01 = WARN" });
      score -= 10;
      ctas.push({ label: "Revisar Target/Features", action: "goto_step", step: 4 });
    } else {
      const stdVal = statsSum?.std;
      checks.push({ check: "SANITY_CHECK", status: "PASS", message: stdVal != null ? `Desvio padrão: ${stdVal.toFixed(4)}` : "Sanity OK", value: stdVal ?? null });
    }

    // ========== C) DATA_DRIFT_CHECK (PSI) ==========
    if (currentReport && previousReport) {
      const currentBatchId = currentReport.batch_id;
      const prevBatchId = previousReport.batch_id;

      const [curPredRes, prevPredRes] = await Promise.all([
        supabase.from("predictions").select("probability_event").eq("project_id", project_id).eq("batch_id", currentBatchId).not("probability_event", "is", null).limit(5000),
        supabase.from("predictions").select("probability_event").eq("project_id", project_id).eq("batch_id", prevBatchId).not("probability_event", "is", null).limit(5000),
      ]);

      const curProbs = (curPredRes.data || []).map((r: any) => r.probability_event as number);
      const prevProbs = (prevPredRes.data || []).map((r: any) => r.probability_event as number);

      if (curProbs.length >= 10 && prevProbs.length >= 10) {
        const psi = computePSI(prevProbs, curProbs);
        if (psi >= 0.3) {
          checks.push({ check: "DATA_DRIFT_CHECK", status: "ALERT", message: `PSI alto: ${psi.toFixed(3)}. Distribuição mudou significativamente.`, value: psi, threshold: ">= 0.3 = ALERT" });
          score -= 25;
          ctas.push({ label: "Re-treinar modelo", action: "goto_step", step: 6 });
          ctas.push({ label: "Rever dataset de entrada", action: "goto_step", step: 2 });
        } else if (psi >= 0.2) {
          checks.push({ check: "DATA_DRIFT_CHECK", status: "WARN", message: `PSI moderado: ${psi.toFixed(3)}. Possível drift nos dados.`, value: psi, threshold: ">= 0.2 = WARN" });
          score -= 10;
          ctas.push({ label: "Re-treinar modelo", action: "goto_step", step: 6 });
        } else {
          checks.push({ check: "DATA_DRIFT_CHECK", status: "PASS", message: `PSI: ${psi.toFixed(3)}`, value: psi });
        }
      } else {
        checks.push({ check: "DATA_DRIFT_CHECK", status: "PASS", message: "Amostras insuficientes para calcular PSI", value: null });
      }
    } else {
      checks.push({ check: "DATA_DRIFT_CHECK", status: "PASS", message: "Sem batch anterior para comparar (primeiro scoring)", value: null });
    }

    // ========== D) VERSION_DRIFT_CHECK ==========
    const selVersionCurrent = selection?.selection_version ?? 0;
    const selVersionScored = currentReport?.selection_version ?? predState?.selection_version_scored ?? 0;
    if (selVersionCurrent > 0 && selVersionScored > 0) {
      const vDiff = selVersionCurrent - selVersionScored;
      if (vDiff >= 2) {
        checks.push({ check: "VERSION_DRIFT_CHECK", status: "ALERT", message: `Versão defasada: scored=v${selVersionScored}, current=v${selVersionCurrent}`, value: vDiff, threshold: "diff >= 2 = ALERT" });
        score -= 25;
        ctas.push({ label: "Rodar scoring novamente", action: "goto_step", step: 8 });
      } else if (vDiff >= 1) {
        checks.push({ check: "VERSION_DRIFT_CHECK", status: "WARN", message: `Versão desatualizada: scored=v${selVersionScored}, current=v${selVersionCurrent}`, value: vDiff, threshold: "diff >= 1 = WARN" });
        score -= 10;
        ctas.push({ label: "Rodar scoring novamente", action: "goto_step", step: 8 });
      } else {
        checks.push({ check: "VERSION_DRIFT_CHECK", status: "PASS", message: `Versão atualizada: v${selVersionScored}`, value: 0 });
      }
    } else {
      checks.push({ check: "VERSION_DRIFT_CHECK", status: "PASS", message: "Sem versão para comparar", value: null });
    }

    // ========== E) HEALTH_COMPLIANCE_CHECK ==========
    const industry = project?.industry;
    if (industry === "health" || industry === "saude") {
      // Sanitize all existing check messages for forbidden health terms
      for (const c of checks) {
        c.message = sanitizeHealthText(c.message);
      }
      checks.push({
        check: "HEALTH_COMPLIANCE_CHECK",
        status: "PASS",
        message: "Compliance: Este modelo é ferramenta de apoio operacional para risco operacional, adesão e no-show. Não substitui avaliação médica profissional.",
        value: "compliance_ok",
      });
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    // Determine overall status
    const hasAlert = checks.some(c => c.status === "ALERT");
    const hasFail = checks.some(c => c.status === "FAIL");
    const hasWarn = checks.some(c => c.status === "WARN");
    const overallStatus = hasFail ? "failed" : hasAlert ? "alert" : hasWarn ? "warn" : "ok";

    const now = new Date().toISOString();

    // Upsert monitoring state (includes last_run_status + error_message for SSOT)
    await supabase.from("project_monitoring_state").upsert({
      project_id,
      model_id: productionModelId || null,
      latest_batch_id: latestBatchId || null,
      status: overallStatus,
      monitoring_score: score,
      checks,
      last_run_at: now,
      last_run_status: "success",
      error_message: null,
      updated_at: now,
    }, { onConflict: "project_id" });

    // Insert historical report
    await supabase.from("project_monitoring_reports").insert({
      project_id,
      model_id: productionModelId || null,
      batch_id: latestBatchId || null,
      selection_version_scored: selVersionScored || null,
      monitoring_score: score,
      checks,
    });

    // ========== IMPLICIT FEEDBACK (best-effort) ==========
    // Auto-register feedback when problems detected
    const shouldAutoFeedback = overallStatus === "alert" || overallStatus === "failed"
      || checks.some(c => c.check === "SANITY_CHECK" && c.status !== "PASS")
      || (coveragePct !== null && coveragePct < 30);

    if (shouldAutoFeedback) {
      try {
        // Resolve template_id from AI context
        const { data: aiCtxData } = await supabase
          .from("project_ai_context")
          .select("context")
          .eq("project_id", project_id)
          .maybeSingle();

        const ctx = aiCtxData?.context as any;
        const templateId = ctx?.intent_contract?.domain_adapter?.recommended_templates?.[0]?.template_id
          || ctx?.intent_contract?.template_id;

        if (templateId && project?.organization_id) {
          const implicitTags: string[] = [];
          if (checks.some(c => c.check === "SANITY_CHECK" && c.status !== "PASS")) implicitTags.push("sanity_fail");
          if (coveragePct !== null && coveragePct < 30) implicitTags.push("cobertura_critica");
          if (checks.some(c => c.check === "DATA_DRIFT_CHECK" && c.status === "ALERT")) implicitTags.push("drift_alto");
          if (checks.some(c => c.check === "VERSION_DRIFT_CHECK" && c.status !== "PASS")) implicitTags.push("versao_defasada");

          await supabase.from("project_template_feedback").insert({
            project_id,
            organization_id: project.organization_id,
            user_id: "00000000-0000-0000-0000-000000000000", // system user
            template_id: templateId,
            industry: project.industry || null,
            feedback_type: "implicit",
            tags: implicitTags,
            batch_id: latestBatchId || null,
            signals: {
              coverage_pct: coveragePct,
              monitoring_score: score,
              monitoring_status: overallStatus,
              sanity_fail: predStatus === "sanity_fail",
            },
          });
          console.log(`[Monitoring] Implicit feedback recorded: ${implicitTags.join(", ")}`);
        }
      } catch (fbErr) {
        console.warn("[Monitoring] Implicit feedback failed (best-effort):", fbErr);
      }
    }

    console.log(`[Monitoring] project=${project_id} status=${overallStatus} score=${score} checks=${checks.length}`);

    return new Response(JSON.stringify({
      success: true,
      status: overallStatus,
      monitoring_score: score,
      checks,
      ctas,
      last_run_at: now,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[Monitoring] Error:", error);

    // Try to persist error in SSOT
    try {
      const { project_id } = await req.clone().json().catch(() => ({}));
      if (project_id) {
        await supabase.from("project_monitoring_state").upsert({
          project_id,
          last_run_status: "error",
          error_message: error instanceof Error ? error.message : "Erro desconhecido",
          last_run_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "project_id" });
      }
    } catch (_) { /* best-effort */ }

    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
