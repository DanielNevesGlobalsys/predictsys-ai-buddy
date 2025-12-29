import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const getSystemPrompt = (language: string) => {
  const prompts: Record<string, string> = {
    pt: `Você é o Assistente Global da plataforma PredictSys AI.

Sua função é explicar em português, em linguagem simples e voltada para negócios:
- Como usar os recursos da plataforma (projetos, EDA, treinamento de modelos, métricas, deploy de API)
- Conceitos básicos de machine learning (classificação, regressão, churn, métricas como AUC, F1, Precisão, Recall, MAE, RMSE, R²)
- Boas práticas para criar modelos preditivos

Regras importantes:
- Evite jargão técnico sempre que possível
- Dê exemplos práticos relacionados a negócios (churn, vendas, inadimplência)
- Seja conciso mas completo nas explicações
- Quando mencionar métricas, explique o que significam em termos de negócio
- Se não souber algo específico sobre a plataforma, seja honesto e sugira onde o usuário pode encontrar a informação

Contexto da plataforma:
- PredictSys AI é uma plataforma no-code para criação de modelos de machine learning
- Aceita arquivos CSV como entrada de dados
- Suporta classificação (prever categorias) e regressão (prever valores)
- Oferece EDA automática, treinamento de múltiplos algoritmos, e deploy de API com 1 clique
- Tem um Assistente IA por projeto que entende os dados e modelos específicos`,

    en: `You are the Global Assistant of the PredictSys AI platform.

Your function is to explain in English, using simple business-oriented language:
- How to use platform features (projects, EDA, model training, metrics, API deployment)
- Basic machine learning concepts (classification, regression, churn, metrics like AUC, F1, Precision, Recall, MAE, RMSE, R²)
- Best practices for creating predictive models

Important rules:
- Avoid technical jargon whenever possible
- Give practical business-related examples (churn, sales, default)
- Be concise but complete in explanations
- When mentioning metrics, explain what they mean in business terms
- If you don't know something specific about the platform, be honest and suggest where the user can find the information

Platform context:
- PredictSys AI is a no-code platform for creating machine learning models
- Accepts CSV files as data input
- Supports classification (predicting categories) and regression (predicting values)
- Offers automatic EDA, training of multiple algorithms, and 1-click API deployment
- Has an AI Assistant per project that understands specific data and models`,

    es: `Eres el Asistente Global de la plataforma PredictSys AI.

Tu función es explicar en español, usando lenguaje simple orientado a negocios:
- Cómo usar las funciones de la plataforma (proyectos, EDA, entrenamiento de modelos, métricas, deploy de API)
- Conceptos básicos de machine learning (clasificación, regresión, churn, métricas como AUC, F1, Precisión, Recall, MAE, RMSE, R²)
- Mejores prácticas para crear modelos predictivos

Reglas importantes:
- Evita jerga técnica siempre que sea posible
- Da ejemplos prácticos relacionados con negocios (churn, ventas, morosidad)
- Sé conciso pero completo en las explicaciones
- Cuando menciones métricas, explica qué significan en términos de negocio
- Si no sabes algo específico sobre la plataforma, sé honesto y sugiere dónde el usuario puede encontrar la información

Contexto de la plataforma:
- PredictSys AI es una plataforma no-code para crear modelos de machine learning
- Acepta archivos CSV como entrada de datos
- Soporta clasificación (predecir categorías) y regresión (predecir valores)
- Ofrece EDA automático, entrenamiento de múltiples algoritmos, y deploy de API con 1 clic
- Tiene un Asistente IA por proyecto que entiende los datos y modelos específicos`,
  };

  return prompts[language] || prompts.pt;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
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

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      console.error("[global-chat] Auth error:", userError);
      return new Response(
        JSON.stringify({ success: false, error: "Usuário não autenticado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { message, language = "pt" } = await req.json();
    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ success: false, error: "Mensagem é obrigatória" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[global-chat] User ${user.id} sent message (lang: ${language}): ${message.substring(0, 100)}...`);

    // Save user message
    const { error: saveUserError } = await supabase
      .from("global_chat_messages")
      .insert({
        user_id: user.id,
        sender_type: "user",
        message_text: message,
      });

    if (saveUserError) {
      console.warn("[global-chat] Error saving user message:", saveUserError);
    }

    // Load recent chat history for context
    const { data: history } = await supabase
      .from("global_chat_messages")
      .select("sender_type, message_text")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);

    const chatHistory = (history || []).reverse().map((msg) => ({
      role: msg.sender_type === "user" ? "user" : "assistant",
      content: msg.message_text,
    }));

    // Build messages array for LLM with language-specific system prompt
    const systemPrompt = getSystemPrompt(language);
    const messages = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(0, -1), // Exclude current message (already in history)
      { role: "user", content: message },
    ];

    // Call Lovable AI Gateway
    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages,
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    if (!aiResponse.ok) {
      const status = aiResponse.status;
      console.error(`[global-chat] AI Gateway error: ${status}`);
      
      if (status === 429) {
        return new Response(
          JSON.stringify({ success: false, error: "Limite de requisições excedido. Tente novamente em alguns segundos." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (status === 402) {
        return new Response(
          JSON.stringify({ success: false, error: "Créditos de IA esgotados. Entre em contato com o suporte." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: "Erro ao processar resposta da IA" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiData = await aiResponse.json();
    const assistantMessage = aiData.choices?.[0]?.message?.content || "Desculpe, não consegui gerar uma resposta.";

    console.log(`[global-chat] AI response generated: ${assistantMessage.substring(0, 100)}...`);

    // Save assistant message
    const { error: saveAssistantError } = await supabase
      .from("global_chat_messages")
      .insert({
        user_id: user.id,
        sender_type: "assistant",
        message_text: assistantMessage,
      });

    if (saveAssistantError) {
      console.warn("[global-chat] Error saving assistant message:", saveAssistantError);
    }

    return new Response(
      JSON.stringify({ success: true, response: assistantMessage }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[global-chat] Unexpected error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno ao processar mensagem" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
