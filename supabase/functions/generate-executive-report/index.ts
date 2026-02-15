import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Gate {
  gate: string;
  status: "BLOCK" | "WARN";
  message: string;
}

interface CTA {
  label: string;
  action: string;
  step?: number;
}

function blocked(errorCode: string, friendlyMsg: string, gates: Gate[], ctas: CTA[]) {
  return new Response(
    JSON.stringify({
      success: false,
      status: "BLOCKED",
      error_code: errorCode,
      error_friendly: friendlyMsg,
      gates,
      ctas,
    }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// ─── Health disclaimer ────────────────────────────
const HEALTH_DISCLAIMER =
  "⚕️ Uso operacional: Este resultado é suporte à operação (agendamento, confirmação, triagem), não diagnóstico clínico. Não substitui avaliação médica.";

// ─── HTML template ────────────────────────────────
function renderExecutiveHTML(p: {
  projectName: string;
  industry: string;
  objective: string;
  generatedAt: string;
  headline: string;
  whatItMeans: string;
  recommendedActions: string[];
  buckets: { bucket: string; count: number; percent: number }[];
  confidenceScore: number | null;
  confidenceLabel: string;
  primaryMetricName: string | null;
  primaryMetricValue: number | null;
  threshold: number | null;
  thresholdExplanation: string | null;
  totalEntities: number;
  staleResults: boolean;
  sanityFail: boolean;
  isHealth: boolean;
  selVersionScored: number | null;
  selVersionCurrent: number | null;
}): string {
  const bucketsHTML = p.buckets
    .map(
      (b) =>
        `<tr><td style="padding:6px 12px;border:1px solid #e2e8f0">${b.bucket}</td>` +
        `<td style="padding:6px 12px;border:1px solid #e2e8f0;text-align:right">${b.count.toLocaleString("pt-BR")}</td>` +
        `<td style="padding:6px 12px;border:1px solid #e2e8f0;text-align:right">${b.percent.toFixed(1)}%</td></tr>`,
    )
    .join("");

  const actionsHTML = p.recommendedActions
    .map((a) => `<li style="margin-bottom:4px">${a}</li>`)
    .join("");

  const staleBanner = p.staleResults
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;padding:10px 16px;border-radius:6px;margin-bottom:16px;font-size:13px">
        ⚠️ <strong>Resultados desatualizados:</strong> Configuração alterada (v${p.selVersionScored} → v${p.selVersionCurrent}). Rode o scoring novamente para resultados atualizados.
       </div>`
    : "";

  const sanityBanner = p.sanityFail
    ? `<div style="background:#fee2e2;border:1px solid #ef4444;padding:10px 16px;border-radius:6px;margin-bottom:16px;font-size:13px">
        🚨 <strong>Alerta de qualidade:</strong> Previsões com variância insuficiente. Revise target e features antes de confiar nestes resultados.
       </div>`
    : "";

  const healthDisclaimer = p.isHealth
    ? `<div style="background:#eff6ff;border:1px solid #3b82f6;padding:10px 16px;border-radius:6px;margin-top:16px;font-size:12px">${HEALTH_DISCLAIMER}</div>`
    : "";

  const confidenceColor =
    (p.confidenceScore ?? 0) >= 70 ? "#16a34a" : (p.confidenceScore ?? 0) >= 40 ? "#ca8a04" : "#dc2626";

  const metricLine =
    p.primaryMetricName && p.primaryMetricValue !== null
      ? `<p style="font-size:13px;color:#64748b">Métrica principal: <strong>${p.primaryMetricName} = ${p.primaryMetricValue.toFixed(4)}</strong></p>`
      : "";

  const thresholdLine = p.thresholdExplanation
    ? `<p style="font-size:12px;color:#64748b;margin-top:4px">📊 ${p.thresholdExplanation}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>Relatório Executivo - ${p.projectName}</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;max-width:800px;margin:0 auto;padding:32px;color:#1e293b;font-size:14px">
  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;border-bottom:3px solid #3b82f6;padding-bottom:16px">
    <div>
      <h1 style="margin:0;font-size:22px;color:#1e293b">Relatório Executivo</h1>
      <p style="margin:4px 0 0;font-size:14px;color:#64748b">${p.projectName}</p>
      <p style="margin:2px 0 0;font-size:12px;color:#94a3b8">${p.industry} · ${p.objective}</p>
    </div>
    <div style="text-align:right;font-size:12px;color:#94a3b8">
      <p style="margin:0">Gerado em</p>
      <p style="margin:0;font-weight:600">${p.generatedAt}</p>
      <p style="margin:4px 0 0">PredictSys AI</p>
    </div>
  </div>

  ${staleBanner}${sanityBanner}

  <!-- KPI Principal -->
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 8px;font-size:18px;color:#1e293b">${p.headline}</h2>
    <p style="margin:0;color:#475569;font-size:14px">${p.whatItMeans}</p>
    ${metricLine}${thresholdLine}
  </div>

  <!-- Confiança + Entidades -->
  <div style="display:flex;gap:16px;margin-bottom:20px">
    <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center">
      <p style="margin:0;font-size:12px;color:#94a3b8">Confiança</p>
      <p style="margin:4px 0;font-size:28px;font-weight:700;color:${confidenceColor}">${p.confidenceScore ?? "—"}</p>
      <p style="margin:0;font-size:12px;color:${confidenceColor}">${p.confidenceLabel}</p>
    </div>
    <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center">
      <p style="margin:0;font-size:12px;color:#94a3b8">Entidades analisadas</p>
      <p style="margin:4px 0;font-size:28px;font-weight:700;color:#1e293b">${p.totalEntities.toLocaleString("pt-BR")}</p>
    </div>
  </div>

  <!-- Distribuição -->
  ${
    p.buckets.length > 0
      ? `<div style="margin-bottom:20px">
    <h3 style="margin:0 0 8px;font-size:15px">Distribuição de Probabilidade</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f1f5f9">
        <th style="padding:6px 12px;border:1px solid #e2e8f0;text-align:left">Faixa</th>
        <th style="padding:6px 12px;border:1px solid #e2e8f0;text-align:right">Quantidade</th>
        <th style="padding:6px 12px;border:1px solid #e2e8f0;text-align:right">%</th>
      </tr></thead>
      <tbody>${bucketsHTML}</tbody>
    </table>
  </div>`
      : ""
  }

  <!-- Ações -->
  <div style="margin-bottom:16px">
    <h3 style="margin:0 0 8px;font-size:15px">Ações Recomendadas</h3>
    <ol style="margin:0;padding-left:20px;color:#475569;font-size:13px">${actionsHTML}</ol>
  </div>

  ${healthDisclaimer}

  <!-- Footer -->
  <div style="margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px;font-size:11px;color:#94a3b8;text-align:center">
    PredictSys AI · Relatório gerado automaticamente · Dados sujeitos a atualização
  </div>
</body>
</html>`;
}

// ─── Main handler ─────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, horizon_days = 30 } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[Executive Report] project=${project_id}, user=${user.id}`);

    // ═══ Step 1: Load project + context + prediction state ═══
    const [projectRes, aiCtxRes, predStateRes, prodModelRes, selectionRes] = await Promise.all([
      supabase
        .from("projects")
        .select("id, name, organization_id, problem_type, business_objective, target_column")
        .eq("id", project_id)
        .single(),
      supabase
        .from("project_ai_context")
        .select("context")
        .eq("project_id", project_id)
        .maybeSingle(),
      supabase
        .from("project_prediction_state")
        .select("status, latest_batch_id, predictions_count, coverage_pct, latest_model_id, last_error_code")
        .eq("project_id", project_id)
        .maybeSingle(),
      supabase
        .from("project_models")
        .select("id, algorithm_name, hyperparameters, deployed_selection_version")
        .eq("project_id", project_id)
        .eq("is_production", true)
        .eq("status", "trained")
        .maybeSingle(),
      supabase
        .from("project_model_selection")
        .select("selection_version")
        .eq("project_id", project_id)
        .maybeSingle(),
    ]);

    if (projectRes.error || !projectRes.data) {
      return blocked("PROJECT_NOT_FOUND", "Projeto não encontrado.", [
        { gate: "PROJECT", status: "BLOCK", message: "Projeto inexistente" },
      ], []);
    }

    const project = projectRes.data;

    // ═══ Step 2: Gate PREDICTIONS_READY ═══
    const predState = predStateRes.data;

    if (!predState || predState.status === "idle" || !predState.latest_batch_id) {
      return blocked("PREDICTIONS_NOT_READY", "Ainda não há previsões prontas para exportar.", [
        { gate: "PREDICTIONS_READY", status: "BLOCK", message: `prediction_state=${predState?.status || "none"}` },
      ], [{ label: "Executar scoring", action: "run_scoring" }]);
    }

    if (predState.status === "running") {
      return blocked("PREDICTIONS_NOT_READY", "O scoring está em andamento. Aguarde a conclusão.", [
        { gate: "PREDICTIONS_READY", status: "BLOCK", message: "prediction_state=running" },
      ], [{ label: "Acompanhar Scoring", action: "refresh" }]);
    }

    if (predState.status === "finalizing") {
      return blocked("PREDICTIONS_NOT_READY", "As previsões estão sendo promovidas. Aguarde.", [
        { gate: "PREDICTIONS_READY", status: "BLOCK", message: "prediction_state=finalizing" },
      ], [{ label: "Finalizar scoring", action: "finalize_scoring" }]);
    }

    if (predState.status === "sanity_fail") {
      return blocked("SANITY_FAIL", "Previsões degeneradas. Revise target/features e retreine.", [
        { gate: "PREDICTIONS_READY", status: "BLOCK", message: "prediction_state=sanity_fail" },
      ], [{ label: "Revisar target e features", action: "goto_step", step: 4 }]);
    }

    if (predState.status === "failed") {
      return blocked("PREDICTIONS_FAILED", "O scoring falhou. Tente novamente.", [
        { gate: "PREDICTIONS_READY", status: "BLOCK", message: "prediction_state=failed" },
      ], [
        { label: "Tentar novamente", action: "run_scoring" },
        { label: "Revisar contrato", action: "goto_step", step: 3 },
      ]);
    }

    if (predState.status !== "done") {
      return blocked("PREDICTIONS_NOT_READY", `Estado inesperado: ${predState.status}`, [
        { gate: "PREDICTIONS_READY", status: "BLOCK", message: `prediction_state=${predState.status}` },
      ], []);
    }

    // Gate MODEL_PRODUCTION
    if (!prodModelRes.data) {
      return blocked("MODEL_NOT_FOUND", "Nenhum modelo em produção encontrado.", [
        { gate: "MODEL_PRODUCTION", status: "BLOCK", message: "No production model" },
      ], [{ label: "Promover modelo", action: "goto_step", step: 6 }]);
    }

    // ═══ Step 3: Call calculate-dashboard-metrics internally ═══
    const metricsBody = JSON.stringify({
      project_id,
      horizon: horizon_days,
      mode: "risk",
    });

    const metricsRes = await fetch(`${supabaseUrl}/functions/v1/calculate-dashboard-metrics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: metricsBody,
    });

    if (!metricsRes.ok) {
      const errText = await metricsRes.text();
      console.error("[Executive Report] Dashboard metrics failed:", errText);
      return blocked("DASHBOARD_METRICS", "Falha ao calcular métricas do dashboard.", [
        { gate: "DASHBOARD_METRICS", status: "BLOCK", message: errText.slice(0, 200) },
      ], [{ label: "Tentar novamente", action: "retry" }]);
    }

    const metrics = await metricsRes.json();

    if (metrics.dashboard_status !== "done" && metrics.dashboard_status !== "no_predictions") {
      return blocked("DASHBOARD_METRICS", metrics.message || "Métricas indisponíveis.", [
        { gate: "DASHBOARD_METRICS", status: "BLOCK", message: `dashboard_status=${metrics.dashboard_status}` },
      ], metrics.ctas || []);
    }

    // ═══ Step 4: Build executive payload ═══
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const intentContract = aiCtx?.intent_contract || {};
    const industry: string =
      intentContract?.domain_adapter?.industry || intentContract?.industry_hint || "generic";
    const objective: string =
      intentContract?.intent_base?.declared_objective ||
      intentContract?.declared_objective ||
      project.business_objective ||
      project.problem_type ||
      "";

    const hp = (prodModelRes.data.hyperparameters as Record<string, any>) || {};
    const recommendedThreshold = hp?.recommended_threshold ?? hp?.best_threshold ?? 0.5;

    const selVersionScored = prodModelRes.data.deployed_selection_version ?? null;
    const selVersionCurrent = (selectionRes.data as any)?.selection_version ?? null;
    const staleResults =
      selVersionScored !== null &&
      selVersionCurrent !== null &&
      selVersionScored < selVersionCurrent;

    // Confidence
    const confidenceScore = metrics.confidence_score ?? null;
    const confidenceLabel =
      confidenceScore === null
        ? "Não calculado"
        : confidenceScore >= 70
          ? "Alta confiança"
          : confidenceScore >= 40
            ? "Confiança moderada"
            : "Baixa confiança";

    // Primary metric
    const { data: metricsData } = await supabase
      .from("project_model_metrics")
      .select("metric_name, metric_value")
      .eq("project_model_id", prodModelRes.data.id);

    let primaryMetricName: string | null = null;
    let primaryMetricValue: number | null = null;
    if (metricsData?.length) {
      const preferred =
        project.problem_type === "regression"
          ? ["r2", "R²", "rmse"]
          : ["auc", "AUC", "f1", "F1"];
      const found = metricsData.find((m: any) => preferred.includes(m.metric_name));
      const picked = found || metricsData[0];
      primaryMetricName = picked.metric_name;
      primaryMetricValue = picked.metric_value;
    }

    // Business translation (inline, matching businessTranslator.ts logic)
    const totalEntities = metrics.summary_cards?.entities_with_prediction || 0;
    const highRisk = metrics.summary_cards?.high_risk_or_opportunity || 0;
    const expectedEvents = metrics.summary_cards?.expected_events || 0;
    const financialImpact = metrics.summary_cards?.financial_impact || 0;

    // Simple headline/what generation
    const isHealth = industry === "health";
    const isChurn =
      objective.toLowerCase().includes("churn") || objective.toLowerCase().includes("cancelamento");
    const isConversion =
      objective.toLowerCase().includes("conversão") || objective.toLowerCase().includes("lead");
    const isNoShow =
      objective.toLowerCase().includes("no-show") ||
      objective.toLowerCase().includes("no show") ||
      objective.toLowerCase().includes("falta");

    let headline: string;
    let whatItMeans: string;
    let recommendedActions: string[];

    if (isChurn) {
      headline = `${highRisk.toLocaleString("pt-BR")} clientes em risco alto de churn`;
      whatItMeans = `De ${totalEntities.toLocaleString("pt-BR")} clientes analisados, ${highRisk.toLocaleString("pt-BR")} apresentam alta probabilidade de cancelamento.`;
      recommendedActions = [
        "Priorize contato direto com os clientes de maior risco",
        "Lance campanha de retenção segmentada",
        "Revise condições comerciais para os top 20% em risco",
      ];
    } else if (isNoShow && isHealth) {
      headline = `${highRisk.toLocaleString("pt-BR")} pacientes com alta chance de falta`;
      whatItMeans = `Dentre ${totalEntities.toLocaleString("pt-BR")} pacientes, ${highRisk.toLocaleString("pt-BR")} têm alta probabilidade de não comparecer à consulta.`;
      recommendedActions = [
        "Envie confirmação automatizada (SMS/WhatsApp)",
        "Ligue para os pacientes do grupo de maior risco",
        "Implemente overbooking para horários com alto no-show",
      ];
    } else if (isConversion) {
      headline = `${highRisk.toLocaleString("pt-BR")} leads com alta propensão de conversão`;
      whatItMeans = `${highRisk.toLocaleString("pt-BR")} de ${totalEntities.toLocaleString("pt-BR")} leads têm probabilidade elevada de converter. Impacto financeiro estimado: R$ ${financialImpact.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}.`;
      recommendedActions = [
        "Direcione equipe comercial para os leads de maior score",
        "Automatize nutrição para o segmento intermediário",
        "Avalie ofertas personalizadas para os top leads",
      ];
    } else {
      headline = `${highRisk.toLocaleString("pt-BR")} entidades em alta probabilidade`;
      whatItMeans = `De ${totalEntities.toLocaleString("pt-BR")} entidades analisadas, ${highRisk.toLocaleString("pt-BR")} foram classificadas com alta probabilidade. Espera-se ${Math.round(expectedEvents)} eventos no horizonte.`;
      recommendedActions = [
        "Priorize ação para o grupo de maior probabilidade",
        "Analise segmentos para direcionar campanhas",
        "Acompanhe a evolução com execuções periódicas",
      ];
    }

    const thresholdPct = (recommendedThreshold * 100).toFixed(0);
    const thresholdExplanation = `Risco alto = probabilidade ≥ ${thresholdPct}%`;

    const buckets = (metrics.probability_buckets || []).map((b: any) => ({
      bucket: b.bucket,
      count: b.count || 0,
      percent: b.percent || 0,
    }));

    const generatedAt = new Date().toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    // ═══ Step 5: Render HTML ═══
    const html = renderExecutiveHTML({
      projectName: project.name,
      industry,
      objective,
      generatedAt,
      headline,
      whatItMeans,
      recommendedActions,
      buckets,
      confidenceScore,
      confidenceLabel,
      primaryMetricName,
      primaryMetricValue,
      threshold: recommendedThreshold,
      thresholdExplanation,
      totalEntities,
      staleResults,
      sanityFail: false, // already gated above
      isHealth,
      selVersionScored: selVersionScored,
      selVersionCurrent: selVersionCurrent,
    });

    // ═══ Step 6: Save to storage ═══
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = `${project_id}/executive_report_${timestamp}.html`;
    const fileBytes = new TextEncoder().encode(html);

    const { error: uploadErr } = await supabase.storage
      .from("exports")
      .upload(filePath, fileBytes, {
        contentType: "text/html",
        upsert: false,
      });

    if (uploadErr) {
      console.error("[Executive Report] Storage upload error:", uploadErr);
      return blocked("STORAGE_WRITE", "Falha ao salvar o relatório.", [
        { gate: "STORAGE_WRITE", status: "BLOCK", message: uploadErr.message },
      ], [{ label: "Tentar novamente", action: "retry" }]);
    }

    // ═══ Step 7: Generate signed URL ═══
    const { data: signedData, error: signedErr } = await supabase.storage
      .from("exports")
      .createSignedUrl(filePath, 10 * 60, { download: `executive_report_${project.name.replace(/\s+/g, "_")}.html` });

    if (signedErr || !signedData?.signedUrl) {
      console.error("[Executive Report] Signed URL error:", signedErr);
      return new Response(
        JSON.stringify({ success: false, error: "Falha ao gerar URL de download" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ═══ Step 8: Insert project_exports record ═══
    const { data: exportRecord, error: insertErr } = await supabase
      .from("project_exports")
      .insert({
        project_id,
        organization_id: project.organization_id,
        user_id: user.id,
        export_type: "executive_pdf",
        batch_id: predState.latest_batch_id,
        selection_version_scored: selVersionScored,
        selection_version_current: selVersionCurrent,
        confidence_score: confidenceScore,
        status: "done",
        file_path: filePath,
        meta: {
          industry,
          objective,
          total_entities: totalEntities,
          high_risk: highRisk,
          horizon_days,
          stale_results: staleResults,
        },
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[Executive Report] Insert export log error:", insertErr);
      // Non-blocking — report was already generated
    }

    console.log(`[Executive Report] Done: report_id=${exportRecord?.id}, entities=${totalEntities}, confidence=${confidenceScore}`);

    // ═══ Step 9: Return response ═══
    return new Response(
      JSON.stringify({
        success: true,
        report_id: exportRecord?.id || null,
        signed_url: signedData.signedUrl,
        file_path: filePath,
        generated_at: new Date().toISOString(),
        selection_version_scored: selVersionScored,
        selection_version_current: selVersionCurrent,
        confidence_score: confidenceScore,
        stale_results: staleResults,
        total_entities: totalEntities,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[Executive Report] Error:", err);
    const msg = err instanceof Error ? err.message : "Internal server error";
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
