import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ProjectContext {
  project: any;
  numericStats: any[];
  categoricalStats: any[];
  models: any[];
  productionModel: any | null;
  featureImportances: any[];
  recentMessages: any[];
}

// Function to generate assistant reply - structured to easily plug in LLM later
function generateAssistantReply(context: ProjectContext, question: string): string {
  const { project, numericStats, categoricalStats, models, productionModel, featureImportances, recentMessages } = context;
  const questionLower = question.toLowerCase();

  // Question about best model or model comparison
  if (questionLower.includes("melhor modelo") || questionLower.includes("qual modelo") || questionLower.includes("comparar modelo")) {
    if (models.length === 0) {
      return "Ainda não há modelos treinados neste projeto. Vá até a aba 'Modelos' e clique em 'Treinar Modelos' para começar.";
    }

    const modelsSummary = models.map((m: any) => {
      const metricsStr = m.metrics?.map((met: any) => `${met.metric_name}: ${(met.metric_value * 100).toFixed(1)}%`).join(", ") || "sem métricas";
      return `- ${m.algorithm_name}: ${metricsStr}`;
    }).join("\n");

    let response = `📊 **Modelos treinados neste projeto:**\n\n${modelsSummary}\n\n`;
    
    if (productionModel) {
      response += `✅ **Modelo em produção:** ${productionModel.algorithm_name}\n`;
    } else {
      response += `⚠️ Nenhum modelo foi selecionado para produção ainda. Escolha o melhor modelo na aba 'Modelos'.`;
    }

    return response;
  }

  // Question about feature importance / important variables
  if (questionLower.includes("variáveis importantes") || questionLower.includes("features importantes") || 
      questionLower.includes("importância") || questionLower.includes("variavel") || questionLower.includes("influencia")) {
    if (featureImportances.length === 0) {
      return "Ainda não temos dados de importância de variáveis. Isso é calculado após o treinamento dos modelos.";
    }

    const topFeatures = featureImportances
      .sort((a: any, b: any) => b.importance_value - a.importance_value)
      .slice(0, 5);

    const featuresStr = topFeatures.map((f: any, i: number) => 
      `${i + 1}. **${f.feature_name}**: ${(f.importance_value * 100).toFixed(1)}% de importância`
    ).join("\n");

    return `🎯 **Top 5 variáveis mais importantes:**\n\n${featuresStr}\n\nEssas são as variáveis que mais influenciam as previsões do modelo.`;
  }

  // Question about metrics / performance
  if (questionLower.includes("métrica") || questionLower.includes("performance") || questionLower.includes("desempenho") ||
      questionLower.includes("acurácia") || questionLower.includes("auc") || questionLower.includes("rmse") || questionLower.includes("precisão")) {
    if (!productionModel && models.length === 0) {
      return "Ainda não há modelos treinados. Treine os modelos primeiro para ver as métricas de performance.";
    }

    const targetModel = productionModel || models[0];
    const metricsStr = targetModel.metrics?.map((m: any) => {
      const value = m.metric_name.includes("R2") || m.metric_name === "AUC" || m.metric_name === "Accuracy" || m.metric_name === "F1"
        ? `${(m.metric_value * 100).toFixed(1)}%`
        : m.metric_value.toFixed(4);
      return `- **${m.metric_name}**: ${value}`;
    }).join("\n") || "Métricas não disponíveis";

    return `📈 **Performance do modelo ${targetModel.algorithm_name}:**\n\n${metricsStr}\n\n${
      project.problem_type === "classification" 
        ? "Para classificação, AUC e F1 são as métricas mais importantes." 
        : "Para regressão, RMSE e R² são as métricas mais importantes."
    }`;
  }

  // Question about summary / resume
  if (questionLower.includes("resumo") || questionLower.includes("resuma") || questionLower.includes("tópicos") || questionLower.includes("diretor")) {
    let summary = `📋 **Resumo do Projeto: ${project.name}**\n\n`;
    
    if (project.business_objective) {
      summary += `**Objetivo de negócio:** ${project.business_objective}\n\n`;
    }

    summary += `**Tipo de problema:** ${project.problem_type === "classification" ? "Classificação" : "Regressão"}\n`;
    summary += `**Variável alvo:** ${project.target_column || "Não definida"}\n\n`;

    if (project.dataset_rows && project.dataset_columns) {
      summary += `**Dataset:** ${project.dataset_rows.toLocaleString("pt-BR")} registros com ${project.dataset_columns} variáveis\n\n`;
    }

    if (models.length > 0) {
      summary += `**Modelos treinados:** ${models.length} algoritmos testados\n`;
      if (productionModel) {
        const mainMetric = productionModel.metrics?.find((m: any) => 
          m.metric_name === "AUC" || m.metric_name === "R2"
        );
        summary += `**Modelo em produção:** ${productionModel.algorithm_name}`;
        if (mainMetric) {
          summary += ` (${mainMetric.metric_name}: ${(mainMetric.metric_value * 100).toFixed(1)}%)`;
        }
        summary += "\n";
      }
    } else {
      summary += "**Status:** Aguardando treinamento de modelos\n";
    }

    if (featureImportances.length > 0) {
      const top3 = featureImportances
        .sort((a: any, b: any) => b.importance_value - a.importance_value)
        .slice(0, 3)
        .map((f: any) => f.feature_name)
        .join(", ");
      summary += `\n**Principais variáveis preditoras:** ${top3}`;
    }

    return summary;
  }

  // Question about data / EDA
  if (questionLower.includes("dados") || questionLower.includes("dataset") || questionLower.includes("eda") || 
      questionLower.includes("estatística") || questionLower.includes("coluna")) {
    let response = `📊 **Informações do Dataset:**\n\n`;
    
    if (project.dataset_rows && project.dataset_columns) {
      response += `- **Total de registros:** ${project.dataset_rows.toLocaleString("pt-BR")}\n`;
      response += `- **Total de variáveis:** ${project.dataset_columns}\n`;
      response += `- **Variável alvo:** ${project.target_column || "Não definida"}\n\n`;
    }

    if (numericStats.length > 0) {
      response += `**Variáveis numéricas:** ${numericStats.length}\n`;
      const numExamples = numericStats.slice(0, 3).map((s: any) => s.column_name).join(", ");
      response += `Exemplos: ${numExamples}\n\n`;
    }

    if (categoricalStats.length > 0) {
      response += `**Variáveis categóricas:** ${categoricalStats.length}\n`;
      const catExamples = categoricalStats.slice(0, 3).map((s: any) => s.column_name).join(", ");
      response += `Exemplos: ${catExamples}\n`;
    }

    return response;
  }

  // Question about API / deploy / endpoint
  if (questionLower.includes("api") || questionLower.includes("deploy") || questionLower.includes("endpoint") || 
      questionLower.includes("integrar") || questionLower.includes("produção")) {
    if (!productionModel) {
      return "Para usar a API de predição, primeiro você precisa selecionar um modelo para produção na aba 'Modelos'.";
    }

    return `🚀 **API de Predição**\n\nSeu modelo **${productionModel.algorithm_name}** está em produção!\n\nPara fazer predições, acesse a aba **'API & Deploy'** onde você encontrará:\n- URL do endpoint\n- Exemplo de requisição\n- Instruções de integração`;
  }

  // Default response with suggestions
  const suggestions = [
    "• \"Qual é o melhor modelo treinado?\"",
    "• \"Quais são as variáveis mais importantes?\"",
    "• \"Resuma este projeto para eu apresentar ao diretor\"",
    "• \"Qual é a performance do modelo em produção?\"",
    "• \"Como posso integrar a API de predição?\"",
  ];

  let defaultResponse = `Olá! Sou o assistente IA do projeto **${project.name}**.\n\n`;
  defaultResponse += `Este é um projeto de **${project.problem_type === "classification" ? "classificação" : "regressão"}**`;
  
  if (project.target_column) {
    defaultResponse += ` que prevê a variável **${project.target_column}**`;
  }
  defaultResponse += ".\n\n";

  if (models.length > 0) {
    defaultResponse += `Já temos **${models.length} modelos** treinados`;
    if (productionModel) {
      defaultResponse += ` e o modelo **${productionModel.algorithm_name}** está em produção`;
    }
    defaultResponse += ".\n\n";
  }

  defaultResponse += `**Algumas perguntas que posso responder:**\n${suggestions.join("\n")}`;

  return defaultResponse;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { projectId, message } = await req.json();

    if (!projectId || !message) {
      return new Response(JSON.stringify({ error: "projectId e message são obrigatórios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user owns the project
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();

    if (projectError || !project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado ou sem permissão" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all context data in parallel
    const [
      numericStatsResult,
      categoricalStatsResult,
      modelsResult,
      recentMessagesResult,
    ] = await Promise.all([
      supabase.from("project_numeric_stats").select("*").eq("project_id", projectId),
      supabase.from("project_categorical_stats").select("*").eq("project_id", projectId),
      supabase.from("project_models").select("*").eq("project_id", projectId),
      supabase.from("project_chat_messages")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    const models = modelsResult.data || [];
    const productionModel = models.find((m: any) => m.is_production);

    // Fetch metrics and feature importances for all models
    let featureImportances: any[] = [];
    for (const model of models) {
      const [metricsResult, importancesResult] = await Promise.all([
        supabase.from("project_model_metrics").select("*").eq("project_model_id", model.id),
        supabase.from("project_feature_importances").select("*").eq("project_model_id", model.id),
      ]);
      model.metrics = metricsResult.data || [];
      if (importancesResult.data) {
        featureImportances = [...featureImportances, ...importancesResult.data];
      }
    }

    // Build context
    const context: ProjectContext = {
      project,
      numericStats: numericStatsResult.data || [],
      categoricalStats: categoricalStatsResult.data || [],
      models,
      productionModel: productionModel || null,
      featureImportances,
      recentMessages: recentMessagesResult.data || [],
    };

    // Generate response
    const assistantReply = generateAssistantReply(context, message);

    // Save both messages to database
    const { error: insertUserError } = await supabase
      .from("project_chat_messages")
      .insert({
        project_id: projectId,
        user_id: user.id,
        sender_type: "user",
        message_text: message,
      });

    if (insertUserError) {
      console.error("Error saving user message:", insertUserError);
    }

    const { data: assistantMessage, error: insertAssistantError } = await supabase
      .from("project_chat_messages")
      .insert({
        project_id: projectId,
        user_id: user.id,
        sender_type: "assistant",
        message_text: assistantReply,
      })
      .select()
      .single();

    if (insertAssistantError) {
      console.error("Error saving assistant message:", insertAssistantError);
    }

    return new Response(JSON.stringify({ 
      reply: assistantReply,
      messageId: assistantMessage?.id 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Chat error:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Erro desconhecido" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
