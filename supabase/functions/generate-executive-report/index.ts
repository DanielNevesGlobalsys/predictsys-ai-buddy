import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

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

const HEALTH_DISCLAIMER =
  "⚕️ Uso operacional: Este resultado é suporte à operação (agendamento, confirmação, triagem), não diagnóstico clínico. Não substitui avaliação médica.";

// ─── PDF generation via pdf-lib ───────────────────
async function generatePDF(p: {
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
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const marginLeft = 40;
  const contentWidth = PAGE_W - 80;
  const FOOTER_ZONE = 55; // reserved for footer

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

  const blue = rgb(0.231, 0.51, 0.965);
  const dark = rgb(0.118, 0.137, 0.169);
  const gray = rgb(0.396, 0.443, 0.525);
  const lightGray = rgb(0.584, 0.639, 0.714);
  const red = rgb(0.863, 0.145, 0.145);
  const amber = rgb(0.961, 0.62, 0.043);
  const green = rgb(0.086, 0.639, 0.267);
  const white = rgb(1, 1, 1);
  const bgLight = rgb(0.973, 0.98, 0.988);

  let pageNum = 0;
  let currentPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 40;
  pageNum++;

  // Helper: ensure we have space, otherwise add a new page
  const ensureSpace = (needed: number) => {
    if (y - needed < FOOTER_ZONE) {
      // Draw footer on current page
      drawFooter(currentPage);
      // New page
      currentPage = doc.addPage([PAGE_W, PAGE_H]);
      pageNum++;
      // Mini header on continuation pages
      currentPage.drawRectangle({ x: 0, y: PAGE_H - 36, width: PAGE_W, height: 36, color: blue });
      currentPage.drawText("Relatório Executivo (cont.)", { x: marginLeft, y: PAGE_H - 24, size: 11, font: fontBold, color: white });
      const pgStr = `Página ${pageNum}`;
      const pgW = fontRegular.widthOfTextAtSize(pgStr, 8);
      currentPage.drawText(pgStr, { x: PAGE_W - marginLeft - pgW, y: PAGE_H - 24, size: 8, font: fontRegular, color: rgb(0.85, 0.9, 1) });
      y = PAGE_H - 52;
    }
  };

  const drawFooter = (pg: any) => {
    pg.drawLine({ start: { x: marginLeft, y: 40 }, end: { x: PAGE_W - marginLeft, y: 40 }, thickness: 0.5, color: rgb(0.886, 0.91, 0.937) });
    const footerText = "PredictSys AI · Relatório gerado automaticamente · Dados sujeitos a atualização";
    const footerW = fontRegular.widthOfTextAtSize(footerText, 7);
    pg.drawText(footerText, { x: PAGE_W / 2 - footerW / 2, y: 28, size: 7, font: fontRegular, color: lightGray });
  };

  // Helper: draw text on current page, return new y
  const drawText = (text: string, x: number, yPos: number, size: number, font = fontRegular, color = dark) => {
    currentPage.drawText(text, { x, y: yPos, size, font, color });
    return yPos - size - 4;
  };

  // Helper: wrap text
  const wrapText = (text: string, maxWidth: number, size: number, font = fontRegular): string[] => {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth) {
        if (current) lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  // ─── Header (page 1) ───
  currentPage.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: blue });
  drawText("Relatório Executivo", marginLeft, PAGE_H - 30, 18, fontBold, white);
  drawText(p.projectName, marginLeft, PAGE_H - 50, 11, fontRegular, rgb(0.85, 0.9, 1));

  const dateStr = `Gerado em ${p.generatedAt}`;
  const dateW = fontRegular.widthOfTextAtSize(dateStr, 9);
  drawText(dateStr, PAGE_W - marginLeft - dateW, PAGE_H - 30, 9, fontRegular, rgb(0.85, 0.9, 1));
  const psText = "PredictSys AI";
  const psW = fontRegular.widthOfTextAtSize(psText, 8);
  drawText(psText, PAGE_W - marginLeft - psW, PAGE_H - 44, 8, fontRegular, rgb(0.85, 0.9, 1));

  y = PAGE_H - 85;

  const subline = `${p.industry} · ${p.objective}`.substring(0, 90);
  y = drawText(subline, marginLeft, y, 9, fontRegular, lightGray);
  y -= 6;

  // ─── Banners ───
  if (p.staleResults) {
    ensureSpace(30);
    currentPage.drawRectangle({ x: marginLeft, y: y - 18, width: contentWidth, height: 22, color: rgb(0.996, 0.953, 0.78) });
    y = drawText("Resultados desatualizados: Configuracao alterada apos o ultimo scoring.", marginLeft + 8, y - 4, 8, fontRegular, rgb(0.6, 0.4, 0));
    y -= 10;
  }

  if (p.sanityFail) {
    ensureSpace(30);
    currentPage.drawRectangle({ x: marginLeft, y: y - 18, width: contentWidth, height: 22, color: rgb(0.996, 0.886, 0.886) });
    y = drawText("Alerta de qualidade: Previsoes com variancia insuficiente. Revise target e features.", marginLeft + 8, y - 4, 8, fontRegular, rgb(0.7, 0.1, 0.1));
    y -= 10;
  }

  // ─── Main KPI box ───
  ensureSpace(75);
  currentPage.drawRectangle({ x: marginLeft, y: y - 65, width: contentWidth, height: 65, color: bgLight, borderColor: rgb(0.886, 0.91, 0.937), borderWidth: 1 });

  const headlineLines = wrapText(p.headline, contentWidth - 20, 14, fontBold);
  let hy = y - 16;
  for (const line of headlineLines) {
    hy = drawText(line, marginLeft + 10, hy, 14, fontBold, dark);
  }

  const whatLines = wrapText(p.whatItMeans, contentWidth - 20, 9, fontRegular);
  for (const line of whatLines.slice(0, 3)) {
    hy = drawText(line, marginLeft + 10, hy, 9, fontRegular, gray);
  }
  y -= 75;

  // ─── Metric + threshold ───
  if (p.primaryMetricName && p.primaryMetricValue !== null) {
    ensureSpace(18);
    y = drawText(`Metrica principal: ${p.primaryMetricName} = ${p.primaryMetricValue.toFixed(4)}`, marginLeft, y, 9, fontRegular, gray);
  }
  if (p.thresholdExplanation) {
    ensureSpace(16);
    y = drawText(p.thresholdExplanation, marginLeft, y, 8, fontRegular, lightGray);
  }
  y -= 8;

  // ─── Confidence + Entities row ───
  ensureSpace(70);
  const boxW = (contentWidth - 16) / 2;
  const boxH = 55;

  currentPage.drawRectangle({ x: marginLeft, y: y - boxH, width: boxW, height: boxH, color: bgLight, borderColor: rgb(0.886, 0.91, 0.937), borderWidth: 1 });
  drawText("Confianca", marginLeft + boxW / 2 - fontRegular.widthOfTextAtSize("Confianca", 9) / 2, y - 14, 9, fontRegular, lightGray);
  const confStr = p.confidenceScore !== null ? String(p.confidenceScore) : "-";
  const confColor = (p.confidenceScore ?? 0) >= 70 ? green : (p.confidenceScore ?? 0) >= 40 ? amber : red;
  drawText(confStr, marginLeft + boxW / 2 - fontBold.widthOfTextAtSize(confStr, 22) / 2, y - 36, 22, fontBold, confColor);
  drawText(p.confidenceLabel, marginLeft + boxW / 2 - fontRegular.widthOfTextAtSize(p.confidenceLabel, 8) / 2, y - 48, 8, fontRegular, confColor);

  const ex = marginLeft + boxW + 16;
  currentPage.drawRectangle({ x: ex, y: y - boxH, width: boxW, height: boxH, color: bgLight, borderColor: rgb(0.886, 0.91, 0.937), borderWidth: 1 });
  drawText("Entidades analisadas", ex + boxW / 2 - fontRegular.widthOfTextAtSize("Entidades analisadas", 9) / 2, y - 14, 9, fontRegular, lightGray);
  const entStr = p.totalEntities.toLocaleString("pt-BR");
  drawText(entStr, ex + boxW / 2 - fontBold.widthOfTextAtSize(entStr, 22) / 2, y - 36, 22, fontBold, dark);

  y -= boxH + 12;

  // ─── Buckets table (cap at 10, show note if more) ───
  if (p.buckets.length > 0) {
    ensureSpace(40);
    y = drawText("Distribuicao de Probabilidade", marginLeft, y, 11, fontBold, dark);
    y -= 4;

    const colFaixa = marginLeft;
    const colQtd = marginLeft + contentWidth * 0.55;
    const colPct = marginLeft + contentWidth * 0.8;

    ensureSpace(20);
    currentPage.drawRectangle({ x: marginLeft, y: y - 14, width: contentWidth, height: 16, color: rgb(0.945, 0.961, 0.976) });
    drawText("Faixa", colFaixa + 4, y - 10, 8, fontBold, dark);
    drawText("Quantidade", colQtd, y - 10, 8, fontBold, dark);
    drawText("%", colPct, y - 10, 8, fontBold, dark);
    y -= 18;

    const maxBuckets = 10;
    const displayBuckets = p.buckets.slice(0, maxBuckets);

    for (const b of displayBuckets) {
      ensureSpace(18);
      drawText(b.bucket, colFaixa + 4, y - 10, 8, fontRegular, dark);
      drawText(b.count.toLocaleString("pt-BR"), colQtd, y - 10, 8, fontRegular, dark);
      drawText(`${b.percent.toFixed(1)}%`, colPct, y - 10, 8, fontRegular, dark);
      currentPage.drawLine({ start: { x: marginLeft, y: y - 14 }, end: { x: marginLeft + contentWidth, y: y - 14 }, thickness: 0.5, color: rgb(0.886, 0.91, 0.937) });
      y -= 16;
    }

    if (p.buckets.length > maxBuckets) {
      ensureSpace(16);
      y = drawText(`... e mais ${p.buckets.length - maxBuckets} faixas. Veja detalhes no dashboard.`, marginLeft + 4, y - 2, 7, fontRegular, lightGray);
    }
    y -= 6;
  }

  // ─── Recommended actions ───
  if (p.recommendedActions.length > 0) {
    ensureSpace(24);
    y = drawText("Acoes Recomendadas", marginLeft, y, 11, fontBold, dark);
    y -= 2;
    for (let i = 0; i < p.recommendedActions.length; i++) {
      const lines = wrapText(`${i + 1}. ${p.recommendedActions[i]}`, contentWidth - 10, 9, fontRegular);
      for (const line of lines) {
        ensureSpace(16);
        y = drawText(line, marginLeft + 6, y, 9, fontRegular, gray);
      }
    }
    y -= 6;
  }

  // ─── Health disclaimer ───
  if (p.isHealth) {
    ensureSpace(40);
    y -= 4;
    currentPage.drawRectangle({ x: marginLeft, y: y - 28, width: contentWidth, height: 30, color: rgb(0.937, 0.965, 1), borderColor: rgb(0.231, 0.51, 0.965), borderWidth: 0.5 });
    const disclaimerText = "Uso operacional: Este resultado e suporte a operacao (agendamento, confirmacao, triagem), nao diagnostico clinico. Nao substitui avaliacao medica.";
    const disclaimerLines = wrapText(disclaimerText, contentWidth - 16, 7, fontRegular);
    let dy = y - 8;
    for (const line of disclaimerLines) {
      dy = drawText(line, marginLeft + 8, dy, 7, fontRegular, rgb(0.2, 0.35, 0.6));
    }
    y -= 36;
  }

  // ─── Footer on last page ───
  drawFooter(currentPage);

  return await doc.save();
}

// ─── HTML fallback (kept for resilience) ──────────
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
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 8px;font-size:18px;color:#1e293b">${p.headline}</h2>
    <p style="margin:0;color:#475569;font-size:14px">${p.whatItMeans}</p>
    ${metricLine}${thresholdLine}
  </div>
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
  ${p.buckets.length > 0 ? `<div style="margin-bottom:20px">
    <h3 style="margin:0 0 8px;font-size:15px">Distribuição de Probabilidade</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f1f5f9">
        <th style="padding:6px 12px;border:1px solid #e2e8f0;text-align:left">Faixa</th>
        <th style="padding:6px 12px;border:1px solid #e2e8f0;text-align:right">Quantidade</th>
        <th style="padding:6px 12px;border:1px solid #e2e8f0;text-align:right">%</th>
      </tr></thead>
      <tbody>${bucketsHTML}</tbody>
    </table>
  </div>` : ""}
  <div style="margin-bottom:16px">
    <h3 style="margin:0 0 8px;font-size:15px">Ações Recomendadas</h3>
    <ol style="margin:0;padding-left:20px;color:#475569;font-size:13px">${actionsHTML}</ol>
  </div>
  ${healthDisclaimer}
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

    // Business translation
    const totalEntities = metrics.summary_cards?.entities_with_prediction || 0;
    const highRisk = metrics.summary_cards?.high_risk_or_opportunity || 0;
    const expectedEvents = metrics.summary_cards?.expected_events || 0;
    const financialImpact = metrics.summary_cards?.financial_impact || 0;

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
    const thresholdExplanation = `Risco alto = probabilidade >= ${thresholdPct}%`;

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

    // ═══ Step 5: Try PDF, fallback to HTML ═══
    let fileBytes: Uint8Array;
    let contentType: string;
    let fileExtension: string;
    let format: "pdf" | "html";
    let engine: string;
    const warnGates: Gate[] = [];

    try {
      fileBytes = await generatePDF({
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
        sanityFail: false,
        isHealth,
      });
      contentType = "application/pdf";
      fileExtension = "pdf";
      format = "pdf";
      engine = "pdf-lib";
      console.log(`[Executive Report] PDF generated successfully (${fileBytes.length} bytes)`);
    } catch (pdfErr) {
      console.error("[Executive Report] PDF generation failed, falling back to HTML:", pdfErr);
      warnGates.push({
        gate: "PDF_ENGINE_AVAILABLE",
        status: "WARN",
        message: `PDF engine failed: ${pdfErr instanceof Error ? pdfErr.message : "unknown"}. Fallback to HTML.`,
      });

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
        sanityFail: false,
        isHealth,
        selVersionScored,
        selVersionCurrent,
      });
      fileBytes = new TextEncoder().encode(html);
      contentType = "text/html";
      fileExtension = "html";
      format = "html";
      engine = "html-fallback";
    }

    // Add format gate
    if (format === "pdf") {
      warnGates.push({ gate: "EXPORT_FORMAT", status: "WARN", message: "format=pdf (success)" });
    } else {
      warnGates.push({ gate: "EXPORT_FORMAT", status: "WARN", message: "format=html (fallback)" });
    }

    // ═══ Step 6: Save to storage ═══
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const dateSlug = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = `${project_id}/executive_report_${timestamp}.${fileExtension}`;

    const { error: uploadErr } = await supabase.storage
      .from("exports")
      .upload(filePath, fileBytes, {
        contentType,
        upsert: false,
      });

    if (uploadErr) {
      console.error("[Executive Report] Storage upload error:", uploadErr);
      return blocked("STORAGE_WRITE", "Falha ao salvar o relatório.", [
        { gate: "STORAGE_WRITE", status: "BLOCK", message: uploadErr.message },
      ], [{ label: "Tentar novamente", action: "retry" }]);
    }

    // ═══ Step 7: Generate signed URL ═══
    const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
    const downloadName = `PredictSys_Executive_${safeName}_${dateSlug}.${fileExtension}`;
    const { data: signedData, error: signedErr } = await supabase.storage
      .from("exports")
      .createSignedUrl(filePath, 10 * 60, { download: downloadName });

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
          format,
          engine,
          page_count: 1,
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
    }

    console.log(`[Executive Report] Done: report_id=${exportRecord?.id}, format=${format}, entities=${totalEntities}, confidence=${confidenceScore}`);

    // ═══ Step 9: Return response ═══
    return new Response(
      JSON.stringify({
        success: true,
        report_id: exportRecord?.id || null,
        signed_url: signedData.signedUrl,
        file_path: filePath,
        format,
        engine,
        generated_at: new Date().toISOString(),
        selection_version_scored: selVersionScored,
        selection_version_current: selVersionCurrent,
        confidence_score: confidenceScore,
        stale_results: staleResults,
        total_entities: totalEntities,
        gates: warnGates,
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
