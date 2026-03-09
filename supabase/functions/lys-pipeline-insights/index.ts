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

This is the FINAL insight layer — the Business Dashboard narrative. You must synthesize EVERYTHING:
- The original business intent
- What the data revealed (EDA)
- How the model performs
- What the predictions mean for the business

CRITICAL RULES:
- This is for C-level executives. Zero technical jargon.
- Structure as: situation → findings → impact → recommended actions
- Use real numbers from the predictions (entities at risk, financial impact, segments)
- Identify specific segments that need attention
- Suggest 3-4 concrete business actions
- NEVER say "the model shows AUC of 0.85". SAY "o modelo identifica corretamente ~85% dos casos de risco, o que permite priorizar ações preventivas"
- Reference the business objective throughout`,
    toolName: "business_story",
    toolDesc: "Complete business narrative for the dashboard",
    toolSchema: {
      type: "object",
      properties: {
        executive_narrative: { type: "string", description: "4-6 paragraph executive narrative connecting intent → data → model → impact" },
        summary: { type: "string", description: "2-3 sentence executive summary" },
        opportunities: { type: "array", items: { type: "string" }, description: "3-4 specific business opportunities identified" },
        risk_segments: { type: "array", items: { type: "string" }, description: "2-3 segments or groups that need urgent attention" },
        recommended_actions: { type: "array", items: { type: "string" }, description: "3-4 concrete, actionable business recommendations" },
        confidence_statement: { type: "string", description: "Statement about how confident the business can be in these predictions" },
      },
      required: ["executive_narrative", "summary", "opportunities", "risk_segments", "recommended_actions", "confidence_statement"],
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

      await serviceClient.from("project_ai_context").upsert({
        project_id,
        context: updatedCtx,
        status: "active",
        last_updated_at: new Date().toISOString(),
      } as any, { onConflict: "project_id" });
    } catch (e) {
      console.warn("[lys-pipeline-insights] Failed to update AI context:", e);
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
