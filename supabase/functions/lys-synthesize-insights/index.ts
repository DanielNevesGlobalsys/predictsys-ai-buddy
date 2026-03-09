import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOpenAI } from "../_shared/openai-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * lys-synthesize-insights
 * 
 * Consolidates EDA + Target Discovery + Intent Contract and calls OpenAI
 * to produce structured insights + recommendations for the target/features step.
 * 
 * Prerequisites: EDA done, TDE profile available, intent contract (optional but enriching).
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

    // ── 1. Gather all context in parallel ──
    const [
      settingsRes,
      numStatsRes,
      catStatsRes,
      aiCtxRes,
      projectRes,
      selectionRes,
      intentRes,
    ] = await Promise.all([
      serviceClient.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      serviceClient.from("project_numeric_stats").select("*").eq("project_id", project_id),
      serviceClient.from("project_categorical_stats").select("*").eq("project_id", project_id),
      serviceClient.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      serviceClient.from("projects").select("name, problem_type, target_column, business_objective, dataset_rows, dataset_columns").eq("id", project_id).single(),
      serviceClient.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      serviceClient.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const settings = settingsRes.data as Record<string, any> | null;
    const project = projectRes.data as Record<string, any> | null;
    const aiCtx = (aiCtxRes.data?.context || {}) as Record<string, any>;
    const numStats = numStatsRes.data || [];
    const catStats = catStatsRes.data || [];
    const selection = selectionRes.data as Record<string, any> | null;
    const intentContract = intentRes.data as Record<string, any> | null;

    if (!project) {
      return new Response(JSON.stringify({ success: false, error: "Project not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check EDA readiness
    const edaState = settings?.eda_state || settings?.eda_status;
    if (edaState !== "done" && edaState !== "succeeded") {
      return new Response(JSON.stringify({
        success: false, error: "EDA_NOT_READY",
        message: "EDA must be completed before Lys synthesis.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── 2. Build structured context ──
    const tdeProfile = aiCtx.tde_profile || {};
    const tdeCandidates = tdeProfile.candidates || {};
    const contractHints = aiCtx.contract_hints || {};

    const numericSummary = numStats.slice(0, 30).map((s: any) => ({
      name: s.column_name,
      mean: s.mean_value?.toFixed(2),
      std: s.std_value?.toFixed(2),
      missing_pct: s.null_count > 0 && settings?.ingestion_rows_detected
        ? ((s.null_count / settings.ingestion_rows_detected) * 100).toFixed(1) + "%"
        : "0%",
      distinct: s.distinct_count,
    }));

    const categoricalSummary = catStats.slice(0, 20).map((s: any) => ({
      name: s.column_name,
      distinct: s.distinct_count,
      top_category: s.top_categories?.[0]?.category,
      top_pct: s.top_categories?.[0]?.count && settings?.ingestion_rows_detected
        ? ((s.top_categories[0].count / settings.ingestion_rows_detected) * 100).toFixed(1) + "%"
        : null,
    }));

    const context = {
      project_name: project.name,
      total_rows: settings?.ingestion_rows_detected || project.dataset_rows || 0,
      total_columns: settings?.ingestion_cols_detected || project.dataset_columns || 0,
      industry: settings?.industry || null,
      business_objective: settings?.objective || project.business_objective || null,
      current_target: selection?.target_column || settings?.target_column || project.target_column || null,
      current_problem_type: selection?.problem_type || project.problem_type || null,
      entity_key: settings?.entity_key || contractHints.entity_key || null,
      time_anchor: settings?.time_anchor_column || contractHints.time_anchor_column || null,
      numeric_columns: numericSummary,
      categorical_columns: categoricalSummary,
      tde_dataset_format: tdeProfile.dataset_format || null,
      tde_status_candidates: (tdeCandidates.status_candidates || []).slice(0, 5),
      tde_value_candidates: (tdeCandidates.value_candidates || []).slice(0, 5),
      tde_event_candidates: (tdeCandidates.event_candidates || []).slice(0, 5),
      intent_contract: intentContract ? {
        problem_type: intentContract.problem_type,
        target_column: intentContract.target_column,
        entity_key: intentContract.entity_key,
        objective: intentContract.objective,
      } : null,
      business_intent_contract: settings?.business_intent_contract || null,
      eda_profile: settings?.eda_profile_json || null,
    };

    // ── 3. Build prompt with tool calling for structured output ──
    const langMap: Record<string, string> = { pt: "Portuguese", en: "English", es: "Spanish" };
    const lang = langMap[language] || "Portuguese";

    const systemPrompt = `You are Lys, the AI synthesis engine for PredictSys. Your job is to analyze a dataset's EDA results, Target Discovery profile, and business intent contract, then provide:
1. A narrative summary for the user (in ${lang})
2. Structured operational recommendations for the pipeline

You MUST call the function "lys_synthesis" with your analysis. Never return plain text.

Guidelines:
- Be specific: reference actual column names from the data
- Identify leakage risks (columns that directly encode the outcome)
- Suggest the best target based on business objective + data evidence
- Recommend entity key and time anchor when available
- List features to include and exclude with reasons
- Provide a confidence score (0-1) for your overall recommendation
- The narrative should be 3-5 paragraphs, business-friendly, in ${lang}`;

    const userPrompt = `Analyze this project context and provide synthesis:\n\n${JSON.stringify(context, null, 2)}`;

    const tools = [
      {
        type: "function",
        function: {
          name: "lys_synthesis",
          description: "Structured synthesis of EDA + Target Discovery + Intent Contract analysis",
          parameters: {
            type: "object",
            properties: {
              narrative: {
                type: "string",
                description: "3-5 paragraph business-friendly narrative summary for the user",
              },
              suggested_problem_type: {
                type: "string",
                enum: ["classification", "regression"],
                description: "Recommended problem type",
              },
              suggested_target: {
                type: "string",
                description: "Recommended target column name",
              },
              suggested_entity_key: {
                type: "string",
                description: "Recommended entity key column",
              },
              suggested_time_anchor: {
                type: "string",
                description: "Recommended time anchor column",
              },
              suggested_features: {
                type: "array",
                items: { type: "string" },
                description: "List of recommended feature column names",
              },
              blocked_features: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["column", "reason"],
                },
                description: "Features to exclude with reasons",
              },
              leakage_risks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column: { type: "string" },
                    risk_level: { type: "string", enum: ["high", "medium", "low"] },
                    reason: { type: "string" },
                  },
                  required: ["column", "risk_level", "reason"],
                },
                description: "Columns with data leakage risk",
              },
              alternative_target_candidates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column: { type: "string" },
                    problem_type: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["column", "problem_type", "reason"],
                },
                description: "Alternative target options",
              },
              confidence_score: {
                type: "number",
                description: "Overall confidence in the recommendation (0.0 to 1.0)",
              },
              reasoning_summary: {
                type: "string",
                description: "Brief technical reasoning for the recommendations",
              },
            },
            required: [
              "narrative", "suggested_problem_type", "confidence_score", "reasoning_summary",
              "suggested_features", "blocked_features", "leakage_risks",
            ],
            additionalProperties: false,
          },
        },
      },
    ];

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
      const status = aiResponse.status;
      const body = await aiResponse.text();
      console.error(`[lys-synthesize] OpenAI error ${status}: ${body}`);
      return new Response(JSON.stringify({ success: false, error: `AI error: ${status}` }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall?.function?.arguments) {
      console.error("[lys-synthesize] No tool call in response");
      return new Response(JSON.stringify({ success: false, error: "AI did not return structured output" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let synthesis: Record<string, any>;
    try {
      synthesis = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      console.error("[lys-synthesize] Failed to parse tool call arguments:", e);
      return new Response(JSON.stringify({ success: false, error: "Failed to parse AI output" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[lys-synthesize] Synthesis complete. Confidence: ${synthesis.confidence_score}, Target: ${synthesis.suggested_target}`);

    // ── 4. Persist to SSOT ──
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

    try {
      await Promise.resolve(
        serviceClient.from("project_settings").update({
          lys_insight_text: synthesis.narrative || null,
          lys_recommendation_json: recommendationJson,
          lys_confidence_score: synthesis.confidence_score ?? null,
          lys_synthesized_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any).eq("project_id", project_id)
      );
    } catch (e) {
      console.warn("[lys-synthesize] Failed to persist to SSOT:", e);
    }

    // ── 5. Also save to project_ai_context for cross-step availability ──
    try {
      const existingCtx = aiCtx || {};
      const updatedCtx = {
        ...existingCtx,
        lys_synthesis: {
          ...recommendationJson,
          narrative: synthesis.narrative,
          confidence_score: synthesis.confidence_score,
          synthesized_at: new Date().toISOString(),
        },
      };

      await Promise.resolve(
        serviceClient.from("project_ai_context").upsert({
          project_id,
          context: updatedCtx,
          updated_at: new Date().toISOString(),
        } as any, { onConflict: "project_id" })
      );
    } catch (e) {
      console.warn("[lys-synthesize] Failed to update AI context:", e);
    }

    // ── 6. Log event ──
    try {
      await Promise.resolve(
        serviceClient.from("platform_events").insert({
          event_type: "lys_synthesis_completed",
          project_id,
          status: "success",
          source: "edge",
          metadata: {
            confidence_score: synthesis.confidence_score,
            suggested_target: synthesis.suggested_target,
            suggested_problem_type: synthesis.suggested_problem_type,
            features_count: (synthesis.suggested_features || []).length,
            blocked_count: (synthesis.blocked_features || []).length,
            leakage_count: (synthesis.leakage_risks || []).length,
          },
        })
      );
    } catch (e) {
      console.warn("[lys-synthesize] Failed to log event:", e);
    }

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
