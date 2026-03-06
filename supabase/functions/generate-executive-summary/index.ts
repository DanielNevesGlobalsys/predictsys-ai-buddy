import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id, trigger_reason } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[generate-executive-summary] project=${project_id} reason=${trigger_reason}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch current AI context
    const { data: ctxRecord, error: ctxErr } = await supabase
      .from("project_ai_context")
      .select("context, status")
      .eq("project_id", project_id)
      .maybeSingle();

    if (ctxErr || !ctxRecord) {
      console.error("[generate-executive-summary] No context found:", ctxErr);
      return new Response(
        JSON.stringify({ error: "Contexto de IA não encontrado para o projeto" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const ctx = ctxRecord.context as Record<string, any>;

    // Build prompt from accumulated context
    const edaSummary = ctx.eda?.summary || "EDA não realizado.";
    const edaWarnings = (ctx.eda?.warnings || []).join("; ") || "Nenhum alerta.";

    // Business segment from Lys analysis
    let segmentInfo = "";
    if (ctx.targeting?.business_segment) {
      segmentInfo = `Segmento de negócio: ${ctx.targeting.business_segment.segment} (confiança: ${ctx.targeting.business_segment.confidence}). ${ctx.targeting.business_segment.justification || ""}`;
    }

    const targetInfo = ctx.targeting?.selected_target
      ? `Target: ${ctx.targeting.selected_target} (${ctx.targeting.selected_problem || "N/A"}). Justificativa: ${ctx.targeting.justification || "N/A"}`
      : "Target não definido.";

    const insightText = ctx.targeting?.insight_text || "";

    const trainingInfo = ctx.training?.model_type
      ? `Modelo: ${ctx.training.model_type}. Métricas: ${JSON.stringify(ctx.training.metrics || {})}. Confiança: ${ctx.training.confidence_level || "N/A"}. Limitações: ${(ctx.training.limitations || []).join("; ") || "Nenhuma"}.`
      : "Modelo não treinado.";

    let predictionsInfo = "Predições não geradas.";
    if (ctx.predictions?.horizons && Object.keys(ctx.predictions.horizons).length > 0) {
      const horizonEntries = Object.entries(ctx.predictions.horizons)
        .map(([days, data]: [string, any]) => `${days}d: ${data.total_entities || 0} entidades, ${data.high_risk_pct || 0}% alto risco`)
        .join("; ");
      predictionsInfo = `Horizons: ${horizonEntries}.`;
      const segInsights = ctx.predictions.segment_insights || [];
      if (segInsights.length > 0) {
        const topSegs = segInsights.slice(0, 3).map((s: any) => `${s.segment}: ${s.high_risk_pct}% alto risco`).join("; ");
        predictionsInfo += ` Segmentos críticos: ${topSegs}.`;
      }
    }

    // Dashboard mapping from Lys analysis
    let dashboardInfo = "";
    if (ctx.targeting?.dashboard_mapping) {
      const dm = ctx.targeting.dashboard_mapping;
      dashboardInfo = `KPIs sugeridos: ${(dm.primary_kpis || []).join(", ")}. Ação recomendada: ${dm.business_action || "N/A"}.`;
    }

    const learningNotes = ctx.targeting?.learning_notes || "";

    const prompt = `Você é **Lys**, o copiloto de IA da plataforma PredictSys AI. Gere um resumo executivo CURTO (máx 4 parágrafos) em português brasileiro para um decisor de negócio. NÃO use termos técnicos de ML. Foque em impacto de negócio, riscos e oportunidades.

Dados do projeto:
${segmentInfo ? `- Segmento: ${segmentInfo}` : ""}
- EDA: ${edaSummary}
- Alertas: ${edaWarnings}
- ${targetInfo}
${insightText ? `- Insight da Lys: ${insightText}` : ""}
- ${trainingInfo}
- ${predictionsInfo}
${dashboardInfo ? `- Dashboard: ${dashboardInfo}` : ""}
${learningNotes ? `- Aprendizados: ${learningNotes}` : ""}
- Razão desta atualização: ${trigger_reason || "Atualização de contexto"}

Responda APENAS o texto do resumo executivo, sem markdown, sem títulos, sem bullet points. Texto corrido e fluido.`;

    let executiveSummary = "";

    try {
      const aiRes = await callOpenAI({
        messages: [
          { role: "system", content: "Você é Lys, copiloto de IA do PredictSys. Gere resumos executivos concisos em português brasileiro, focados em impacto de negócio." },
          { role: "user", content: prompt },
        ],
        max_tokens: 1000,
        temperature: 0.5,
      });

      if (aiRes.ok) {
        const aiData = await aiRes.json();
        executiveSummary = aiData.choices?.[0]?.message?.content || "";
      } else {
        console.error(`[generate-executive-summary] AI API error: ${aiRes.status}`);
      }
    } catch (aiErr) {
      console.error("[generate-executive-summary] AI call failed:", aiErr);
    }

    // Fallback: generate a rule-based summary
    if (!executiveSummary) {
      const parts: string[] = [];

      if (ctx.targeting?.business_segment) {
        parts.push(`Este projeto atua no segmento de ${ctx.targeting.business_segment.segment}.`);
      }

      if (ctx.eda?.summary) {
        parts.push(`A análise exploratória identificou os principais padrões nos dados: ${ctx.eda.summary}`);
      }

      if (ctx.targeting?.selected_target) {
        parts.push(`O problema definido é de ${ctx.targeting.selected_problem || "previsão"}, com foco na variável "${ctx.targeting.selected_target}".`);
      }

      if (ctx.targeting?.insight_text) {
        parts.push(ctx.targeting.insight_text);
      }

      if (ctx.training?.model_type) {
        const confLabel = ctx.training.confidence_level === "high" ? "alta" : ctx.training.confidence_level === "medium" ? "moderada" : "limitada";
        parts.push(`O modelo treinado (${ctx.training.model_type}) apresenta confiabilidade ${confLabel}.`);
      }

      if (ctx.predictions?.horizons) {
        const horizonKeys = Object.keys(ctx.predictions.horizons);
        if (horizonKeys.length > 0) {
          const first = ctx.predictions.horizons[horizonKeys[0]];
          parts.push(`As predições indicam ${first.high_risk_pct || 0}% da base em alto risco nos próximos ${horizonKeys[0]} dias.`);
        }
      }

      if (ctx.targeting?.dashboard_mapping?.business_action) {
        parts.push(`Ação recomendada: ${ctx.targeting.dashboard_mapping.business_action}`);
      }

      executiveSummary = parts.join(" ") || "Resumo executivo será gerado conforme o projeto avança.";
    }

    // Save storyline to context
    const appendRes = await fetch(`${supabaseUrl}/functions/v1/append-project-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
        apikey: supabaseServiceKey,
      },
      body: JSON.stringify({
        project_id,
        stage: "storyline",
        payload: {
          executive_summary: executiveSummary,
          last_update_reason: trigger_reason || "Geração automática",
          generated_at: new Date().toISOString(),
        },
      }),
    });
    console.log(`[generate-executive-summary] Context append status=${appendRes.status}`);

    return new Response(
      JSON.stringify({ success: true, executive_summary: executiveSummary, trigger_reason }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[generate-executive-summary] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
