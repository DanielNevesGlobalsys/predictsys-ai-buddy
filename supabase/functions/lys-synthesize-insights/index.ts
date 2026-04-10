import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOpenAI } from "../_shared/openai-client.ts";
import { buildProjectContext, contextToPromptBlock } from "../_shared/build-project-context.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * lys-synthesize-insights
 * 
 * Consolidates EDA + Target Discovery + Intent Contract using the unified context builder
 * and calls OpenAI to produce structured insights + recommendations for the target/features step.
 */

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

    const { project_id, language = "pt" } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ success: false, error: "project_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[lys-synthesize] Starting for project ${project_id}`);

    // ── 1. Build unified context ──
    const context = await buildProjectContext(serviceClient, project_id);
    const contextBlock = contextToPromptBlock(context);

    // Check EDA readiness — allow virtual/external datasets to pass
    const sourceType = String(context.dataset_summary?.source_type || "").toLowerCase();
    const isVirtualDataset = ["powerbi", "external", "virtual"].includes(sourceType);

    if (
      !isVirtualDataset &&
      context.eda_summary.numeric_columns.length === 0 &&
      context.eda_summary.categorical_columns.length === 0
    ) {
      return new Response(JSON.stringify({
        success: false, error: "EDA_NOT_READY",
        message: "EDA must be completed before Lys synthesis.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // For virtual datasets with no EDA columns, enrich the prompt context
    if (isVirtualDataset && context.eda_summary.numeric_columns.length === 0) {
      console.log(`[lys-synthesize] Virtual dataset (${sourceType}) — proceeding with simplified context`);
    }

    // ── 2. Build prompt ──
    const langMap: Record<string, string> = { pt: "Brazilian Portuguese", en: "English", es: "Spanish" };
    const lang = langMap[language] || "Brazilian Portuguese";

    const systemPrompt = `You are Lys, the AI synthesis engine for PredictSys. Analyze the complete project context (EDA results, Target Discovery, business intent) and provide:
1. A business-friendly narrative summary (in ${lang})
2. Structured operational recommendations for the pipeline

You MUST call the function "lys_synthesis" with your analysis. Never return plain text.

Guidelines:
- Reference actual column names from the data
- Connect analysis to the business objective and industry
- Identify leakage risks (columns that directly encode the outcome)
- Suggest the best target based on business objective + data evidence
- Recommend entity key and time anchor when available
- Provide a confidence score (0-1) for your overall recommendation
- The narrative should be 3-5 paragraphs, business-friendly, in ${lang}
- NEVER use technical ML jargon. Explain in business terms.`;

    const userPrompt = `Analyze this project context and provide synthesis:\n\n${contextBlock}`;

    const tools = [{
      type: "function",
      function: {
        name: "lys_synthesis",
        description: "Structured synthesis of EDA + Target Discovery + Intent Contract analysis",
        parameters: {
          type: "object",
          properties: {
            narrative: { type: "string", description: "3-5 paragraph business-friendly narrative summary" },
            suggested_problem_type: { type: "string", enum: ["classification", "regression"] },
            suggested_target: { type: "string", description: "Recommended target column name" },
            suggested_entity_key: { type: "string", description: "Recommended entity key column" },
            suggested_time_anchor: { type: "string", description: "Recommended time anchor column" },
            suggested_features: { type: "array", items: { type: "string" } },
            blocked_features: {
              type: "array",
              items: { type: "object", properties: { column: { type: "string" }, reason: { type: "string" } }, required: ["column", "reason"] },
            },
            leakage_risks: {
              type: "array",
              items: {
                type: "object",
                properties: { column: { type: "string" }, risk_level: { type: "string", enum: ["high", "medium", "low"] }, reason: { type: "string" } },
                required: ["column", "risk_level", "reason"],
              },
            },
            alternative_target_candidates: {
              type: "array",
              items: { type: "object", properties: { column: { type: "string" }, problem_type: { type: "string" }, reason: { type: "string" } }, required: ["column", "problem_type", "reason"] },
            },
            confidence_score: { type: "number", description: "Overall confidence (0.0-1.0)" },
            reasoning_summary: { type: "string" },
          },
          required: ["narrative", "suggested_problem_type", "confidence_score", "reasoning_summary", "suggested_features", "blocked_features", "leakage_risks"],
          additionalProperties: false,
        },
      },
    }];

    const aiResponse = await callOpenAI({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "lys_synthesis" } },
      max_tokens: 4000,
      temperature: 0.4,
    });

    if (!aiResponse.ok) {
      const body = await aiResponse.text();
      console.error(`[lys-synthesize] OpenAI error ${aiResponse.status}: ${body}`);
      return new Response(JSON.stringify({ success: false, error: `AI error: ${aiResponse.status}` }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall?.function?.arguments) {
      return new Response(JSON.stringify({ success: false, error: "AI did not return structured output" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let synthesis: Record<string, any>;
    try {
      synthesis = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: "Failed to parse AI output" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── GUARDRAIL: Block date columns as suggested target ──
    const DATE_TARGET_BLOCKLIST = ["datmov", "dt_mov", "data_mov", "sk_data", "created_at", "updated_at", "date", "data_ref", "dt_ref"];
    const suggestedTargetLower = (synthesis.suggested_target || "").toLowerCase();
    const isDateTarget = DATE_TARGET_BLOCKLIST.some(d => suggestedTargetLower.includes(d))
      || /^(calend[aá]rio|calendar)\./i.test(synthesis.suggested_target || "")
      || ["date", "datetime", "timestamp", "data", "temporal"].some(t => suggestedTargetLower.includes(t) && !suggestedTargetLower.includes("qty") && !suggestedTargetLower.includes("qtd"));

    if (isDateTarget) {
      console.warn(`[lys-synthesize] GUARDRAIL: Blocked date column "${synthesis.suggested_target}" as target. Looking for numeric alternative.`);
      // Try to find a numeric alternative from suggested_features or alternative_target_candidates
      const altCandidates = synthesis.alternative_target_candidates || [];
      const numericAlt = altCandidates.find((c: any) => c.problem_type === "regression" && !DATE_TARGET_BLOCKLIST.some((d: string) => (c.column || "").toLowerCase().includes(d)));
      if (numericAlt) {
        synthesis.suggested_target = numericAlt.column;
        synthesis.suggested_problem_type = numericAlt.problem_type || "regression";
        console.log(`[lys-synthesize] GUARDRAIL: Replaced with numeric alternative: ${numericAlt.column}`);
      } else {
        // Check suggested_features for numeric columns
        const AGRO_VALUE_TOKENS = ["qtd", "sacas", "peso", "volume", "quantidade", "producao", "captacao", "rendimento", "produção", "captação", "tonelada", "kg", "litro"];
        const numericFeature = (synthesis.suggested_features || []).find((f: string) => {
          const lo = f.toLowerCase();
          return AGRO_VALUE_TOKENS.some(t => lo.includes(t));
        });
        if (numericFeature) {
          synthesis.suggested_target = numericFeature;
          synthesis.suggested_problem_type = "regression";
          synthesis.suggested_features = (synthesis.suggested_features || []).filter((f: string) => f !== numericFeature);
          console.log(`[lys-synthesize] GUARDRAIL: Promoted numeric feature as target: ${numericFeature}`);
        } else {
          // Last resort: check TDE profile value candidates from context
          const tdeValues = context.eda_summary?.tde_profile_result?.candidates?.value_candidates
            || context.eda_summary?.tde_profile?.candidates?.value_candidates || [];
          const tdeValueCol = tdeValues.find((v: any) => {
            const col = typeof v === "string" ? v : v?.column || "";
            return AGRO_VALUE_TOKENS.some(t => col.toLowerCase().includes(t));
          });
          if (tdeValueCol) {
            const colName = typeof tdeValueCol === "string" ? tdeValueCol : tdeValueCol.column;
            synthesis.suggested_target = colName;
            synthesis.suggested_problem_type = "regression";
            console.log(`[lys-synthesize] GUARDRAIL: Promoted TDE value candidate as target: ${colName}`);
          } else {
            synthesis.suggested_target = null;
            console.log(`[lys-synthesize] GUARDRAIL: No valid alternative found, target set to null`);
          }
        }
      }
    }

    console.log(`[lys-synthesize] Complete. Confidence: ${synthesis.confidence_score}, Target: ${synthesis.suggested_target}`);

    // ── 3. Persist to SSOT ──
    const recommendationJson = {
      suggested_problem_type: synthesis.suggested_problem_type || null,
      suggested_target: synthesis.suggested_target || null,
      suggested_entity_key: synthesis.suggested_entity_key || null,
      suggested_time_anchor: synthesis.suggested_time_anchor || null,
      suggested_features: synthesis.suggested_features || [],
      blocked_features: synthesis.blocked_features || [],
      leakage_risks: synthesis.leakage_risks || [],
      alternative_target_candidates: synthesis.alternative_target_candidates || [],
      reasoning_summary: synthesis.reasoning_summary || "",
    };

    await Promise.all([
      serviceClient.from("project_settings").update({
        lys_insight_text: synthesis.narrative || null,
        lys_recommendation_json: recommendationJson,
        lys_confidence_score: synthesis.confidence_score ?? null,
        lys_synthesized_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any).eq("project_id", project_id),

      // Save to AI context
      (async () => {
        const existing = (await serviceClient.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle()).data?.context || {};
        await serviceClient.from("project_ai_context").upsert({
          project_id,
          context: {
            ...existing,
            lys_synthesis: { ...recommendationJson, narrative: synthesis.narrative, confidence_score: synthesis.confidence_score, synthesized_at: new Date().toISOString() },
          },
          status: "active",
          last_updated_at: new Date().toISOString(),
        } as any, { onConflict: "project_id" });
      })(),

      // Save as insight record
      (async () => {
        const { data: existingInsight } = await serviceClient.from("project_model_insights").select("id").eq("project_id", project_id).eq("insight_type", "eda_synthesis").eq("language", language).maybeSingle();
        if (existingInsight) {
          await serviceClient.from("project_model_insights").update({ insights: { narrative: synthesis.narrative, recommendation: recommendationJson, confidence_score: synthesis.confidence_score }, updated_at: new Date().toISOString() }).eq("id", existingInsight.id);
        } else {
          await serviceClient.from("project_model_insights").insert({ project_id, insight_type: "eda_synthesis", language, insights: { narrative: synthesis.narrative, recommendation: recommendationJson, confidence_score: synthesis.confidence_score } });
        }
      })(),

      // Log event
      serviceClient.from("platform_events").insert({
        event_type: "lys_synthesis_completed",
        project_id,
        status: "success",
        source: "edge",
        metadata: { confidence_score: synthesis.confidence_score, suggested_target: synthesis.suggested_target, suggested_problem_type: synthesis.suggested_problem_type },
      }),
    ].map(p => Promise.resolve(p).catch(e => console.warn("[lys-synthesize] Non-critical persist error:", e))));

    return new Response(JSON.stringify({
      success: true,
      narrative: synthesis.narrative,
      recommendation: recommendationJson,
      confidence_score: synthesis.confidence_score,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[lys-synthesize] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Internal error",
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
