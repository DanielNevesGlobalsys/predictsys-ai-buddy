import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ProjectContext {
  project: any;
  numericStats: any[];
  categoricalStats: any[];
  models: any[];
  productionModel: any | null;
  featureImportances: any[];
  recentMessages: any[];
  aiContext: Record<string, any> | null;
}

// ── Lys System Prompt ──────────────────────────────────────────────────────

function buildSystemPrompt(language: string): string {
  const prompts: Record<string, string> = {
    pt: `Você é **Lys**, a IA especialista da plataforma PredictSys AI.

## Papel
Você traduz dados em decisões de negócio. Combina análise estatística, machine learning e entendimento de contexto empresarial para fornecer insights acionáveis.

## Capacidades
- Explicar resultados de modelos em linguagem de negócio, sem jargão técnico
- Fornecer insights acionáveis baseados nos dados e métricas do projeto
- Responder sobre todo o pipeline: dados, EDA, modelos treinados, métricas, importância de variáveis, predições e impacto de negócio
- Sugerir ações práticas baseadas em segmentos de risco e oportunidade
- Usar conhecimento cumulativo de etapas anteriores para enriquecer análises

## Diretrizes de comunicação
- Seja concisa mas completa
- Use exemplos práticos de negócio (churn, vendas, inadimplência, retenção)
- Explique métricas técnicas (AUC, F1, RMSE) em termos de impacto no negócio
- Se não souber algo específico, diga que não tem essa informação
- Sempre baseie respostas nos dados reais do projeto
- Quando relevante, conecte a resposta com KPIs de negócio, riscos e oportunidades
- Responda em português brasileiro`,

    en: `You are **Lys**, the AI specialist of the PredictSys AI platform.

## Role
You translate data into business decisions. You combine statistical analysis, machine learning, and business context understanding to provide actionable insights.

## Capabilities
- Explain model results in business language without technical jargon
- Provide actionable insights based on project data and metrics
- Answer questions about the full pipeline: data, EDA, trained models, metrics, feature importance, predictions, and business impact
- Suggest practical actions based on risk and opportunity segments
- Use cumulative knowledge from previous stages to enrich analyses

## Communication guidelines
- Be concise but complete
- Use practical business examples (churn, sales, defaults, retention)
- Explain technical metrics (AUC, F1, RMSE) in terms of business impact
- If you don't know something specific, say so
- Always base answers on actual project data
- When relevant, connect answers with business KPIs, risks, and opportunities`,

    es: `Eres **Lys**, la IA especialista de la plataforma PredictSys AI.

## Rol
Traduces datos en decisiones de negocio. Combinas análisis estadístico, machine learning y comprensión del contexto empresarial para proporcionar insights accionables.

## Capacidades
- Explicar resultados de modelos en lenguaje de negocios sin jerga técnica
- Proporcionar insights accionables basados en datos y métricas del proyecto
- Responder sobre todo el pipeline: datos, EDA, modelos entrenados, métricas, importancia de variables, predicciones e impacto de negocio
- Sugerir acciones prácticas basadas en segmentos de riesgo y oportunidad
- Usar conocimiento acumulativo de etapas anteriores para enriquecer análisis

## Directrices de comunicación
- Sé concisa pero completa
- Usa ejemplos prácticos de negocio (churn, ventas, morosidad, retención)
- Explica métricas técnicas (AUC, F1, RMSE) en términos de impacto en el negocio
- Si no sabes algo específico, dilo
- Siempre basa respuestas en los datos reales del proyecto`,
  };

  return prompts[language] || prompts.pt;
}

// ── Build context prompt ───────────────────────────────────────────────────

function buildContextPrompt(context: ProjectContext): string {
  const { project, numericStats, categoricalStats, models, productionModel, featureImportances, aiContext } = context;

  let contextStr = `=== CONTEXTO DO PROJETO ===\n\n`;

  // Project info
  contextStr += `**Projeto:** ${project.name}\n`;
  contextStr += `**Tipo de problema:** ${project.problem_type === "classification" ? "Classificação" : "Regressão"}\n`;
  contextStr += `**Variável alvo:** ${project.target_column || "Não definida"}\n`;
  contextStr += `**Status:** ${project.status}\n`;
  if (project.business_objective) contextStr += `**Objetivo de negócio:** ${project.business_objective}\n`;
  if (project.description) contextStr += `**Descrição:** ${project.description}\n`;
  if (project.dataset_rows && project.dataset_columns) {
    contextStr += `\n**Dataset:** ${project.dataset_rows.toLocaleString("pt-BR")} registros, ${project.dataset_columns} variáveis\n`;
  }

  // Cumulative AI Context (Lys memory)
  if (aiContext) {
    contextStr += `\n=== MEMÓRIA CUMULATIVA DA LYS ===\n`;

    if (aiContext.targeting?.business_segment) {
      const seg = aiContext.targeting.business_segment;
      contextStr += `**Segmento de negócio:** ${seg.segment} (confiança: ${seg.confidence})\n`;
      contextStr += `Justificativa: ${seg.justification}\n`;
    }

    if (aiContext.targeting?.suggested_problems?.length) {
      contextStr += `**Problemas de negócio identificados:** ${aiContext.targeting.suggested_problems.join(", ")}\n`;
    }

    if (aiContext.targeting?.insight_text) {
      contextStr += `**Insight principal:** ${aiContext.targeting.insight_text}\n`;
    }

    if (aiContext.targeting?.dashboard_mapping) {
      const dm = aiContext.targeting.dashboard_mapping;
      contextStr += `**KPIs sugeridos:** ${(dm.primary_kpis || []).join(", ")}\n`;
      contextStr += `**Ação de negócio recomendada:** ${dm.business_action || "N/A"}\n`;
    }

    if (aiContext.training?.model_type) {
      contextStr += `\n**Modelo treinado (contexto IA):** ${aiContext.training.model_type}\n`;
      contextStr += `Confiança: ${aiContext.training.confidence_level || "N/A"}\n`;
      if (aiContext.training.limitations?.length) {
        contextStr += `Limitações: ${aiContext.training.limitations.join("; ")}\n`;
      }
    }

    if (aiContext.predictions?.horizons) {
      const horizons = Object.entries(aiContext.predictions.horizons);
      if (horizons.length > 0) {
        contextStr += `\n**Predições:**\n`;
        for (const [days, data] of horizons) {
          const d = data as any;
          contextStr += `- ${days}d: ${d.total_entities || 0} entidades, ${d.high_risk_pct || 0}% alto risco\n`;
        }
      }
    }

    if (aiContext.business?.risks?.length) {
      contextStr += `\n**Riscos identificados:** ${aiContext.business.risks.join("; ")}\n`;
    }
    if (aiContext.business?.opportunities?.length) {
      contextStr += `**Oportunidades:** ${aiContext.business.opportunities.join("; ")}\n`;
    }

    if (aiContext.storyline?.executive_summary) {
      contextStr += `\n**Resumo executivo mais recente:** ${aiContext.storyline.executive_summary.substring(0, 800)}\n`;
    }

    if (aiContext.targeting?.learning_notes) {
      contextStr += `\n**Aprendizados cumulativos:** ${aiContext.targeting.learning_notes}\n`;
    }
  }

  // EDA stats
  if (numericStats.length > 0) {
    contextStr += `\n**Variáveis numéricas (${numericStats.length}):**\n`;
    numericStats.slice(0, 10).forEach((stat: any) => {
      contextStr += `- ${stat.column_name}: média=${stat.mean_value?.toFixed(2) || "N/A"}, min=${stat.min_value?.toFixed(2) || "N/A"}, max=${stat.max_value?.toFixed(2) || "N/A"}, nulos=${stat.null_count || 0}\n`;
    });
  }

  if (categoricalStats.length > 0) {
    contextStr += `\n**Variáveis categóricas (${categoricalStats.length}):**\n`;
    categoricalStats.slice(0, 10).forEach((stat: any) => {
      contextStr += `- ${stat.column_name}: ${stat.distinct_count || 0} categorias distintas\n`;
    });
  }

  // Models
  if (models.length > 0) {
    contextStr += `\n**Modelos treinados (${models.length}):**\n`;
    models.forEach((model: any) => {
      const metricsStr = model.metrics?.map((m: any) => `${m.metric_name}: ${m.metric_value.toFixed(4)}`).join(", ") || "sem métricas";
      const prodTag = model.is_production ? " [EM PRODUÇÃO]" : "";
      contextStr += `- ${model.algorithm_name}${prodTag}: ${metricsStr}\n`;
    });
  } else {
    contextStr += `\n**Modelos:** Nenhum modelo treinado ainda.\n`;
  }

  // Feature importance
  if (featureImportances.length > 0) {
    const sortedFeatures = featureImportances.sort((a: any, b: any) => b.importance_value - a.importance_value).slice(0, 10);
    contextStr += `\n**Top variáveis mais importantes:**\n`;
    sortedFeatures.forEach((f: any, i: number) => {
      contextStr += `${i + 1}. ${f.feature_name}: ${(f.importance_value * 100).toFixed(1)}%\n`;
    });
  }

  // Production model details
  if (productionModel) {
    contextStr += `\n**Modelo em produção:** ${productionModel.algorithm_name}\n`;
    if (productionModel.metrics?.length > 0) {
      contextStr += `Métricas:\n`;
      productionModel.metrics.forEach((m: any) => {
        const isPercentage = ["AUC", "Accuracy", "F1", "Precision", "Recall", "R2"].includes(m.metric_name);
        const value = isPercentage ? `${(m.metric_value * 100).toFixed(1)}%` : m.metric_value.toFixed(4);
        contextStr += `- ${m.metric_name}: ${value}\n`;
      });
    }
  }

  return contextStr;
}

function buildConversationHistory(recentMessages: any[]): string {
  if (recentMessages.length === 0) return "";
  const chronological = [...recentMessages].reverse().slice(-6);
  let historyStr = "\n=== HISTÓRICO RECENTE DA CONVERSA ===\n";
  chronological.forEach((msg: any) => {
    const role = msg.sender_type === "user" ? "Usuário" : "Lys";
    historyStr += `${role}: ${msg.message_text.slice(0, 500)}\n\n`;
  });
  return historyStr;
}

// ── LLM call ───────────────────────────────────────────────────────────────

async function callLLM(systemPrompt: string, userMessage: string, projectContext: string, conversationHistory: string): Promise<string> {
  const fullPrompt = `${projectContext}\n${conversationHistory}\n=== PERGUNTA DO USUÁRIO ===\n${userMessage}`;
  console.log("[project-chat] Context length:", fullPrompt.length);

  const response = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: fullPrompt },
    ],
    max_tokens: 2000,
    temperature: 0.7,
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error("RATE_LIMITED");
    if (response.status === 402) throw new Error("PAYMENT_REQUIRED");
    const errorText = await response.text();
    console.error("[project-chat] LLM API error:", response.status, errorText);
    throw new Error(`LLM API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from LLM");
  return content;
}

function generateFallbackReply(context: ProjectContext, question: string): string {
  const { project, models, featureImportances } = context;
  const questionLower = question.toLowerCase();

  if (questionLower.includes("melhor modelo") || questionLower.includes("qual modelo")) {
    if (models.length === 0) return "Ainda não há modelos treinados neste projeto. Vá até a aba 'Modelos' e clique em 'Treinar Modelos' para começar.";
    const modelsSummary = models.map((m: any) => {
      const metricsStr = m.metrics?.map((met: any) => `${met.metric_name}: ${(met.metric_value * 100).toFixed(1)}%`).join(", ") || "sem métricas";
      return `- ${m.algorithm_name}: ${metricsStr}`;
    }).join("\n");
    return `📊 **Modelos treinados:**\n\n${modelsSummary}`;
  }

  if (questionLower.includes("variáveis importantes") || questionLower.includes("importância")) {
    if (featureImportances.length === 0) return "Ainda não temos dados de importância de variáveis. Isso é calculado após o treinamento dos modelos.";
    const topFeatures = featureImportances.sort((a: any, b: any) => b.importance_value - a.importance_value).slice(0, 5);
    const featuresStr = topFeatures.map((f: any, i: number) => `${i + 1}. **${f.feature_name}**: ${(f.importance_value * 100).toFixed(1)}%`).join("\n");
    return `🎯 **Top variáveis mais importantes:**\n\n${featuresStr}`;
  }

  return `Olá! Sou a **Lys**, assistente IA do projeto **${project.name}**. Posso ajudar com informações sobre dados, modelos, métricas e insights de negócio. Como posso ajudar?`;
}

// ── Main Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { projectId, message, language = "pt" } = await req.json();
    if (!projectId || !message) {
      return new Response(JSON.stringify({ error: "projectId e message são obrigatórios" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify user owns the project
    const { data: project, error: projectError } = await supabase.from("projects").select("*").eq("id", projectId).eq("user_id", user.id).single();
    if (projectError || !project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado ou sem permissão" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[project-chat] Lys processing for project: ${project.name} (lang: ${language})`);

    // Fetch all context data in parallel (including AI cumulative context)
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const [numericStatsResult, categoricalStatsResult, modelsResult, recentMessagesResult, aiContextResult] = await Promise.all([
      supabase.from("project_numeric_stats").select("*").eq("project_id", projectId),
      supabase.from("project_categorical_stats").select("*").eq("project_id", projectId),
      supabase.from("project_models").select("*").eq("project_id", projectId),
      supabase.from("project_chat_messages").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(10),
      serviceClient.from("project_ai_context").select("context").eq("project_id", projectId).maybeSingle(),
    ]);

    const models = modelsResult.data || [];
    const productionModel = models.find((m: any) => m.is_production);

    // Fetch metrics and feature importances
    let featureImportances: any[] = [];
    for (const model of models) {
      const [metricsResult, importancesResult] = await Promise.all([
        supabase.from("project_model_metrics").select("*").eq("project_model_id", model.id),
        supabase.from("project_feature_importances").select("*").eq("project_model_id", model.id),
      ]);
      model.metrics = metricsResult.data || [];
      if (importancesResult.data) featureImportances = [...featureImportances, ...importancesResult.data];
    }

    const context: ProjectContext = {
      project,
      numericStats: numericStatsResult.data || [],
      categoricalStats: categoricalStatsResult.data || [],
      models,
      productionModel: productionModel || null,
      featureImportances,
      recentMessages: recentMessagesResult.data || [],
      aiContext: (aiContextResult.data?.context as Record<string, any>) || null,
    };

    // Generate response
    let assistantReply: string;
    try {
      const systemPrompt = buildSystemPrompt(language);
      const projectContext = buildContextPrompt(context);
      const conversationHistory = buildConversationHistory(context.recentMessages);
      assistantReply = await callLLM(systemPrompt, message, projectContext, conversationHistory);
      console.log("[project-chat] Lys response generated successfully");
    } catch (llmError) {
      console.error("[project-chat] LLM error, using fallback:", llmError);
      if (llmError instanceof Error) {
        if (llmError.message === "RATE_LIMITED") assistantReply = "⚠️ Estou temporariamente indisponível. Tente novamente em alguns segundos.";
        else if (llmError.message === "PAYMENT_REQUIRED") assistantReply = "⚠️ Serviço temporariamente indisponível. Entre em contato com o suporte.";
        else if (llmError.message === "LOVABLE_API_KEY not configured") assistantReply = generateFallbackReply(context, message);
        else assistantReply = "Não consegui gerar uma resposta agora. Tente novamente em alguns instantes.";
      } else {
        assistantReply = generateFallbackReply(context, message);
      }
    }

    // Save messages
    await supabase.from("project_chat_messages").insert({ project_id: projectId, user_id: user.id, sender_type: "user", message_text: message });
    const { data: assistantMessage } = await supabase.from("project_chat_messages").insert({ project_id: projectId, user_id: user.id, sender_type: "assistant", message_text: assistantReply }).select().single();

    return new Response(JSON.stringify({ reply: assistantReply, messageId: assistantMessage?.id }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[project-chat] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro desconhecido" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
