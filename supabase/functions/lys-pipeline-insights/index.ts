import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOpenAI } from "../_shared/openai-client.ts";
import { buildProjectContext, contextToPromptBlock } from "../_shared/build-project-context.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type InsightStage = "eda_synthesis" | "target_validation" | "model_interpretation" | "business_story";

const STAGE_PROMPTS: Record<InsightStage, { system: string; toolName: string; toolDesc: string; toolSchema: Record<string, any> }> = {
  eda_synthesis: {
    system: `You are Lys, the AI business analyst for PredictSys. You just received the EDA results and Target Discovery candidates for a project.

Your task: Interpret the dataset in BUSINESS terms. Connect EDA findings to the declared business objective and industry.

Guidelines:
- Reference actual column names and statistics
- Identify which columns suggest business opportunities or risks
- Suggest hypotheses about what the data can predict
- Highlight data quality issues that could impact business decisions
- NEVER use technical ML jargon. Speak as a business consultant.
- Connect everything to the intent contract / business objective`,
    toolName: "eda_insight",
    toolDesc: "Structured EDA interpretation for business users",
    toolSchema: {
      type: "object",
      properties: {
        narrative: { type: "string", description: "3-4 paragraph business-friendly interpretation of the dataset" },
        data_quality_assessment: { type: "string", description: "1-2 sentences on data readiness for the business objective" },
        key_hypotheses: { type: "array", items: { type: "string" }, description: "2-4 business hypotheses the data can test" },
        risk_flags: { type: "array", items: { type: "string" }, description: "Data quality or coverage risks" },
      },
      required: ["narrative", "data_quality_assessment", "key_hypotheses", "risk_flags"],
    },
  },

  target_validation: {
    system: `You are Lys, validating whether the chosen target variable is coherent with the business objective and dataset characteristics.

Your task: Assess if the target makes sense for the declared intent. Consider:
- Does the target align with the business problem?
- Is the data structure adequate (enough variance, not too sparse)?
- Are there leakage risks?
- Would an alternative target better serve the business goal?

Respond in BUSINESS terms. Never say "AUC" or "feature importance" — say "predictive power" or "business signal strength".`,
    toolName: "target_validation_insight",
    toolDesc: "Validation of target choice against business intent",
    toolSchema: {
      type: "object",
      properties: {
        narrative: { type: "string", description: "2-3 paragraph assessment of target coherence with business goal" },
        alignment_score: { type: "number", description: "0-1 score of target-intent alignment" },
        risks: { type: "array", items: { type: "string" }, description: "Specific risks with this target choice" },
        alternative_suggestion: { type: "string", description: "If applicable, a better alternative target with justification" },
      },
      required: ["narrative", "alignment_score", "risks"],
    },
  },

  model_interpretation: {
    system: `You are Lys, interpreting ML model results for business stakeholders.

CRITICAL RULES:
- NEVER say "AUC", "F1", "RMSE", "R²" directly. Translate them:
  - AUC 0.85 → "o modelo consegue distinguir corretamente ~85% dos casos"
  - F1 0.7 → "o modelo identifica 70% dos eventos reais com boa precisão"
  - RMSE → "erro médio de previsão de X unidades"
- Connect model performance to business impact
- Reference feature importance as "o que mais influencia o resultado"
- Reference the business objective and intent contract
- Suggest what the model CAN and CANNOT reliably predict`,
    toolName: "model_insight",
    toolDesc: "Business-friendly model interpretation",
    toolSchema: {
      type: "object",
      properties: {
        narrative: { type: "string", description: "3-4 paragraph business interpretation of model results" },
        reliability_assessment: { type: "string", description: "Can this model be used for business decisions? Why?" },
        key_drivers: { type: "array", items: { type: "string" }, description: "Top 3-5 business factors driving predictions, in business language" },
        limitations: { type: "array", items: { type: "string" }, description: "What the model cannot reliably predict" },
        recommended_usage: { type: "string", description: "How should the business use these predictions?" },
      },
      required: ["narrative", "reliability_assessment", "key_drivers", "limitations", "recommended_usage"],
    },
  },

  business_story: {
    system: `You are Lys, creating the definitive business narrative for a predictive analytics project.

This narrative has FOUR fixed blocks. You MUST fill ALL four:

A) BUSINESS CONTEXT — Explain what the dataset represents, which business problem the project solves, and why it matters. Ground this in the intent contract.

B) MODEL DISCOVERIES — Interpret what the model learned about entity behavior. What patterns did it find? What drives the outcome? Translate feature importance into business language.

C) RISKS OR OPPORTUNITIES — Highlight specific segments, proportions, or patterns the model found. Use real numbers (entities at risk, financial exposure, concentration in segments).

D) RECOMMENDED ACTIONS — Suggest 3-4 concrete strategic actions based on the patterns detected. Each action should be specific and actionable.

CRITICAL RULES:
- This is for C-level executives. Zero technical jargon.
- NEVER say "AUC", "F1", "precision", "recall", "RMSE". Translate:
  - AUC 0.85 → "o modelo identifica corretamente ~85% dos casos de risco"
  - High feature importance → "o fator que mais influencia o resultado é..."
- Use real numbers from predictions (entities, financial impact, segments)
- Reference the business objective throughout
- Each block should be 2-4 sentences, clear and direct`,
    toolName: "business_story",
    toolDesc: "Four-block structured business narrative for the dashboard",
    toolSchema: {
      type: "object",
      properties: {
        business_context: { type: "string", description: "2-4 sentences: what the dataset represents, which problem the project solves, why it matters" },
        model_discoveries: { type: "string", description: "2-4 sentences: what the model learned about entity behavior, key drivers in business language" },
        risk_or_opportunity: { type: "string", description: "2-4 sentences: specific segments, proportions, or patterns found, with real numbers" },
        recommended_actions: { type: "array", items: { type: "string" }, description: "3-4 concrete, actionable business recommendations" },
        confidence_statement: { type: "string", description: "1-2 sentences about prediction reliability in business terms" },
        dashboard_business_story: { type: "string", description: "Consolidated 1-paragraph executive summary combining all blocks" },
      },
      required: ["business_context", "model_discoveries", "risk_or_opportunity", "recommended_actions", "confidence_statement", "dashboard_business_story"],
    },
  },
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Auth required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: "Not authenticated" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, stage, language = "pt", extra_context } = await req.json();

    if (!project_id || !stage) {
      return new Response(JSON.stringify({ success: false, error: "project_id and stage are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const validStage = stage as InsightStage;
    const stageConfig = STAGE_PROMPTS[validStage];
    if (!stageConfig) {
      return new Response(JSON.stringify({ success: false, error: `Invalid stage: ${stage}. Valid: eda_synthesis, target_validation, model_interpretation, business_story` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[lys-pipeline-insights] Stage: ${stage}, Project: ${project_id}`);

    // ── 1. Build unified context ──
    const context = await buildProjectContext(serviceClient, project_id);
    const contextBlock = contextToPromptBlock(context);

    // ── 2. Language mapping ──
    const langMap: Record<string, string> = { pt: "Brazilian Portuguese", en: "English", es: "Spanish" };
    const lang = langMap[language] || "Brazilian Portuguese";

    // ── 3. Build messages ──
    const systemPrompt = `${stageConfig.system}\n\nIMPORTANT: Respond in ${lang}. Call the function "${stageConfig.toolName}" with your analysis. Never return plain text.`;

    let userPrompt = `Analyze this project and provide your ${stage} insight:\n\n${contextBlock}`;
    if (extra_context) {
      userPrompt += `\n\nAdditional context for this stage:\n${JSON.stringify(extra_context, null, 1)}`;
    }

    const tools = [{
      type: "function",
      function: {
        name: stageConfig.toolName,
        description: stageConfig.toolDesc,
        parameters: { ...stageConfig.toolSchema, additionalProperties: false },
      },
    }];

    // ── 4. Call OpenAI ──
    const aiResponse = await callOpenAI({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools,
      tool_choice: { type: "function", function: { name: stageConfig.toolName } },
      max_tokens: 4000,
      temperature: 0.4,
    });

    if (!aiResponse.ok) {
      const body = await aiResponse.text();
      console.error(`[lys-pipeline-insights] OpenAI error ${aiResponse.status}: ${body}`);
      return new Response(JSON.stringify({ success: false, error: `AI error: ${aiResponse.status}` }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall?.function?.arguments) {
      console.error("[lys-pipeline-insights] No tool call in response");
      return new Response(JSON.stringify({ success: false, error: "AI did not return structured output" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let insight: Record<string, any>;
    try {
      insight = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      console.error("[lys-pipeline-insights] Parse error:", e);
      return new Response(JSON.stringify({ success: false, error: "Failed to parse AI output" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[lys-pipeline-insights] ${stage} insight generated successfully`);

    // ── 5. Persist insight ──
    // Save to project_model_insights for retrieval
    try {
      const { data: existing } = await serviceClient
        .from("project_model_insights")
        .select("id")
        .eq("project_id", project_id)
        .eq("insight_type", stage)
        .eq("language", language)
        .maybeSingle();

      if (existing) {
        await serviceClient.from("project_model_insights").update({
          insights: insight,
          updated_at: new Date().toISOString(),
        }).eq("id", existing.id);
      } else {
        await serviceClient.from("project_model_insights").insert({
          project_id,
          insight_type: stage,
          language,
          insights: insight,
        });
      }
    } catch (e) {
      console.warn("[lys-pipeline-insights] Failed to persist insight:", e);
    }

    // Save to AI context for cross-stage memory
    try {
      const existingCtx = (await serviceClient.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle()).data?.context || {};
      
      const stageContextKey = `lys_${stage}`;
      const updatedCtx = {
        ...existingCtx,
        [stageContextKey]: {
          ...insight,
          generated_at: new Date().toISOString(),
          language,
        },
      };

      // For business_story, also store the storyline for executive narrative
      if (validStage === "business_story") {
        updatedCtx.storyline = {
          executive_summary: insight.dashboard_business_story || "",
          business_context: insight.business_context || "",
          model_discoveries: insight.model_discoveries || "",
          risk_or_opportunity: insight.risk_or_opportunity || "",
          recommended_actions: insight.recommended_actions || [],
          confidence_statement: insight.confidence_statement || "",
          generated_at: new Date().toISOString(),
        };
      }

      await serviceClient.from("project_ai_context").upsert({
        project_id,
        context: updatedCtx,
        status: "active",
        last_updated_at: new Date().toISOString(),
      } as any, { onConflict: "project_id" });
    } catch (e) {
      console.warn("[lys-pipeline-insights] Failed to update AI context:", e);
    }

    // Persist business_story blocks to SSOT (project_settings)
    if (validStage === "business_story") {
      try {
        await serviceClient.from("project_settings").update({
          lys_insight_text: insight.dashboard_business_story || "",
          lys_recommendation_json: {
            business_context: insight.business_context,
            model_discoveries: insight.model_discoveries,
            risk_or_opportunity: insight.risk_or_opportunity,
            recommended_actions: insight.recommended_actions,
            confidence_statement: insight.confidence_statement,
            generated_at: new Date().toISOString(),
          },
          lys_synthesized_at: new Date().toISOString(),
        }).eq("project_id", project_id);
      } catch (e) {
        console.warn("[lys-pipeline-insights] Failed to persist to SSOT:", e);
      }
    }

    // Log event
    try {
      await serviceClient.from("platform_events").insert({
        event_type: `lys_${stage}_generated`,
        project_id,
        status: "success",
        source: "edge",
        metadata: { stage, language, has_narrative: !!insight.narrative || !!insight.executive_narrative },
      });
    } catch (e) {
      console.warn("[lys-pipeline-insights] Failed to log event:", e);
    }

    return new Response(JSON.stringify({ success: true, stage, insight }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[lys-pipeline-insights] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Internal error",
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
