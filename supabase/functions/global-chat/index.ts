import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Lys System Prompt ──────────────────────────────────────────────────────

const getSystemPrompt = (language: string) => {
  const prompts: Record<string, string> = {
    pt: `Você é **Lys**, a IA especialista da plataforma PredictSys AI.

## Papel
Você traduz dados em decisões de negócio. Combina análise estatística, machine learning e entendimento de contexto empresarial para fornecer insights acionáveis.

## Capacidades
- Explicar recursos da plataforma (projetos, EDA, treinamento de modelos, métricas, deploy de API) em linguagem simples
- Conceitos de machine learning traduzidos para negócio (classificação, regressão, churn, métricas)
- Boas práticas para criação de modelos preditivos
- Análise de segmentos de negócio (retail, saúde, logística, educação, financeiro)
- Sugerir ações práticas baseadas em dados e predições

## Diretrizes de comunicação
- Evite jargões técnicos sempre que possível
- Dê exemplos práticos de negócio (churn, vendas, inadimplência, retenção)
- Seja concisa mas completa nas explicações
- Quando mencionar métricas, explique em termos de impacto no negócio
- Quando tiver contexto de um projeto, conecte respostas com riscos, oportunidades e KPIs

## Contexto da plataforma
- PredictSys AI é uma plataforma no-code para criação de modelos de machine learning
- Aceita CSV, Parquet, Excel e JSON como entrada de dados
- Suporta classificação e regressão
- Oferece EDA automática, treinamento de múltiplos algoritmos, deploy de API com 1 clique
- Tem Dashboard de Negócio com simulações de ROI e segmentação
- Tem a Lys (você) como assistente IA que aprende continuamente com cada projeto`,

    en: `You are **Lys**, the AI specialist of the PredictSys AI platform.

## Role
You translate data into business decisions. You combine statistical analysis, machine learning, and business context understanding to provide actionable insights.

## Capabilities
- Explain platform features (projects, EDA, model training, metrics, API deployment) in simple language
- Machine learning concepts translated to business (classification, regression, churn, metrics)
- Best practices for creating predictive models
- Business segment analysis (retail, healthcare, logistics, education, finance)
- Suggest practical actions based on data and predictions

## Communication guidelines
- Avoid technical jargon whenever possible
- Give practical business examples (churn, sales, defaults, retention)
- Be concise but complete
- When mentioning metrics, explain in terms of business impact
- When you have project context, connect answers with risks, opportunities, and KPIs

## Platform context
- PredictSys AI is a no-code platform for creating machine learning models
- Accepts CSV, Parquet, Excel, and JSON as data input
- Supports classification and regression
- Offers automatic EDA, multiple algorithm training, 1-click API deployment
- Has a Business Dashboard with ROI simulations and segmentation
- Has Lys (you) as an AI assistant that continuously learns from each project`,

    es: `Eres **Lys**, la IA especialista de la plataforma PredictSys AI.

## Rol
Traduces datos en decisiones de negocio. Combinas análisis estadístico, machine learning y comprensión del contexto empresarial para proporcionar insights accionables.

## Capacidades
- Explicar funciones de la plataforma (proyectos, EDA, entrenamiento de modelos, métricas, deploy de API) en lenguaje simple
- Conceptos de machine learning traducidos a negocios (clasificación, regresión, churn, métricas)
- Mejores prácticas para crear modelos predictivos
- Análisis de segmentos de negocio (retail, salud, logística, educación, finanzas)
- Sugerir acciones prácticas basadas en datos y predicciones

## Directrices de comunicación
- Evita jerga técnica siempre que sea posible
- Da ejemplos prácticos de negocio (churn, ventas, morosidad, retención)
- Sé concisa pero completa
- Cuando menciones métricas, explica en términos de impacto en el negocio

## Contexto de la plataforma
- PredictSys AI es una plataforma no-code para crear modelos de machine learning
- Acepta CSV, Parquet, Excel y JSON como entrada de datos
- Soporta clasificación y regresión
- Ofrece EDA automático, entrenamiento de múltiples algoritmos, deploy de API con 1 clic
- Tiene Dashboard de Negocio con simulaciones de ROI y segmentación
- Tiene a Lys (tú) como asistente IA que aprende continuamente con cada proyecto`,
  };
  return prompts[language] || prompts.pt;
};

// ── Build project context when project_id is provided ──────────────────────

async function buildProjectContext(supabase: any, serviceClient: any, projectId: string): Promise<string> {
  const [projectRes, aiCtxRes] = await Promise.all([
    supabase.from("projects").select("name, problem_type, target_column, status, business_objective, dataset_rows, dataset_columns").eq("id", projectId).single(),
    serviceClient.from("project_ai_context").select("context").eq("project_id", projectId).maybeSingle(),
  ]);

  if (!projectRes.data) return "";

  const project = projectRes.data;
  const aiCtx = aiCtxRes.data?.context as Record<string, any> | null;

  let ctx = `\n=== CONTEXTO DO PROJETO: ${project.name} ===\n`;
  ctx += `Tipo: ${project.problem_type === "classification" ? "Classificação" : "Regressão"}\n`;
  ctx += `Target: ${project.target_column || "Não definido"}\n`;
  ctx += `Status: ${project.status}\n`;
  if (project.business_objective) ctx += `Objetivo: ${project.business_objective}\n`;
  if (project.dataset_rows) ctx += `Dataset: ${project.dataset_rows} registros, ${project.dataset_columns} colunas\n`;

  if (aiCtx) {
    if (aiCtx.targeting?.business_segment) {
      ctx += `\nSegmento de negócio: ${aiCtx.targeting.business_segment.segment} (${aiCtx.targeting.business_segment.confidence})\n`;
    }
    if (aiCtx.targeting?.insight_text) {
      ctx += `Insight: ${aiCtx.targeting.insight_text}\n`;
    }
    if (aiCtx.targeting?.dashboard_mapping?.business_action) {
      ctx += `Ação recomendada: ${aiCtx.targeting.dashboard_mapping.business_action}\n`;
    }
    if (aiCtx.training?.model_type) {
      ctx += `Modelo: ${aiCtx.training.model_type} (confiança: ${aiCtx.training.confidence_level})\n`;
    }
    if (aiCtx.storyline?.executive_summary) {
      ctx += `\nResumo executivo: ${aiCtx.storyline.executive_summary.substring(0, 600)}\n`;
    }
    if (aiCtx.business?.risks?.length) {
      ctx += `Riscos: ${aiCtx.business.risks.join("; ")}\n`;
    }
    if (aiCtx.business?.opportunities?.length) {
      ctx += `Oportunidades: ${aiCtx.business.opportunities.join("; ")}\n`;
    }
  }

  return ctx;
}

// ── Main Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      console.error("[global-chat] LOVABLE_API_KEY not configured");
      return new Response(
        JSON.stringify({ success: false, error: "API de IA não configurada" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Autenticação necessária" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: "Usuário não autenticado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { message, language = "pt", context: requestContext } = await req.json();
    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ success: false, error: "Mensagem é obrigatória" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const projectId = requestContext?.project_id;
    console.log(`[global-chat] Lys processing (lang: ${language}, project: ${projectId || "none"}): ${message.substring(0, 100)}...`);

    // Save user message
    await supabase.from("global_chat_messages").insert({ user_id: user.id, sender_type: "user", message_text: message });

    // Load recent chat history
    const { data: history } = await supabase.from("global_chat_messages").select("sender_type, message_text").eq("user_id", user.id).order("created_at", { ascending: false }).limit(10);
    const chatHistory = (history || []).reverse().map((msg) => ({
      role: msg.sender_type === "user" ? "user" : "assistant",
      content: msg.message_text,
    }));

    // Build project context if project_id provided
    let projectContext = "";
    if (projectId) {
      projectContext = await buildProjectContext(supabase, serviceClient, projectId);
    }

    // Build messages array
    const systemPrompt = getSystemPrompt(language);
    const fullSystemPrompt = projectContext ? `${systemPrompt}\n${projectContext}` : systemPrompt;

    const messages = [
      { role: "system", content: fullSystemPrompt },
      ...chatHistory.slice(0, -1),
      { role: "user", content: message },
    ];

    // Call OpenAI
    const aiResponse = await callOpenAI({
      messages,
      max_tokens: 1500,
      temperature: 0.7,
    });

    if (!aiResponse.ok) {
      const status = aiResponse.status;
      console.error(`[global-chat] AI Gateway error: ${status}`);
      if (status === 429) {
        return new Response(JSON.stringify({ success: false, error: "Limite de requisições excedido. Tente novamente em alguns segundos." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (status === 402) {
        return new Response(JSON.stringify({ success: false, error: "Créditos de IA esgotados. Entre em contato com o suporte." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: false, error: "Erro ao processar resposta da IA" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiData = await aiResponse.json();
    const assistantMessage = aiData.choices?.[0]?.message?.content || "Desculpe, não consegui gerar uma resposta.";

    console.log(`[global-chat] Lys response: ${assistantMessage.substring(0, 100)}...`);

    // Save assistant message
    await supabase.from("global_chat_messages").insert({ user_id: user.id, sender_type: "assistant", message_text: assistantMessage });

    return new Response(
      JSON.stringify({ success: true, response: assistantMessage }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[global-chat] Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno ao processar mensagem" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
