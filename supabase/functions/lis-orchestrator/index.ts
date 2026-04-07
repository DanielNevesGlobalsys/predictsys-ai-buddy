import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AGENT_SYSTEM_PROMPTS,
  AGENT_RESPONSE_TOOL,
  validateAgentResponse,
  buildAgentPrompt,
  computeInputHash,
  selectAgent,
} from "../_shared/lis-agents.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startMs = Date.now();

  try {
    // ─── Auth ───
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      return jsonResponse({ error: "LOVABLE_API_KEY not configured" }, 500);
    }

    // Verify user
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Service client for writes
    const svc = createClient(supabaseUrl, serviceKey);

    // ─── Parse Request ───
    const body = await req.json();
    const {
      project_id,
      organization_id,
      stage,
      agent_name: preferredAgent,
      input_contract = {},
      execution_mode = "auto",
    } = body;

    if (!project_id || !organization_id || !stage) {
      return jsonResponse({ error: "project_id, organization_id, and stage are required" }, 400);
    }

    // ─── Select Agent ───
    const agentName = selectAgent(stage, preferredAgent);
    const systemPrompt = AGENT_SYSTEM_PROMPTS[agentName];
    if (!systemPrompt) {
      return jsonResponse({ error: `Unknown agent: ${agentName}` }, 400);
    }

    console.log(`[LIS] Agent=${agentName} Stage=${stage} Mode=${execution_mode} Project=${project_id}`);

    // ─── Build Context ───
    // Fetch project context from project_ai_context
    const { data: aiCtx } = await svc
      .from("project_ai_context")
      .select("context, status")
      .eq("project_id", project_id)
      .maybeSingle();

    // Fetch pipeline state from project_settings
    const { data: settings } = await svc
      .from("project_settings")
      .select("ingestion_state, eda_state, target_state, split_state, builder_state, training_state, scoring_state, dashboard_state, selection_version, dataset_version")
      .eq("project_id", project_id)
      .maybeSingle();

    // Fetch model selection
    const { data: selection } = await svc
      .from("project_model_selection")
      .select("target_column, problem_type, selected_features, excluded_features, selection_version")
      .eq("project_id", project_id)
      .maybeSingle();

    const projectContext: Record<string, unknown> = {
      ai_context: aiCtx?.context || {},
      pipeline_state: settings || {},
      model_selection: selection || {},
      stage,
      execution_mode,
    };

    const contextVersion = `v${settings?.selection_version || 0}_dv${settings?.dataset_version || 0}`;
    const inputHash = await computeInputHash({ ...input_contract, stage, agentName });

    // ─── Create Execution Record (pending) ───
    const { data: execRecord, error: insertErr } = await svc
      .from("lis_agent_executions")
      .insert({
        project_id,
        organization_id,
        agent_name: agentName,
        stage,
        execution_mode,
        status: "running",
        context_version: contextVersion,
        input_contract,
        project_context_snapshot: projectContext,
        input_hash: inputHash,
        triggered_by: user.id,
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[LIS] Failed to create execution record:", insertErr);
      return jsonResponse({ error: "Failed to create execution record" }, 500);
    }

    const executionId = execRecord.id;

    // ─── Call AI Gateway ───
    const userPrompt = buildAgentPrompt(agentName, stage, projectContext, input_contract);

    const aiResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [AGENT_RESPONSE_TOOL],
        tool_choice: { type: "function", function: { name: "agent_decision" } },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error(`[LIS] AI Gateway error ${aiResponse.status}:`, errText);

      // Update execution as failed
      await svc.from("lis_agent_executions").update({
        status: "failed",
        decision: { error: `AI Gateway ${aiResponse.status}` },
        reasoning_summary: [errText.slice(0, 500)],
        duration_ms: Date.now() - startMs,
        finished_at: new Date().toISOString(),
      }).eq("id", executionId);

      const statusCode = aiResponse.status === 429 ? 429 : aiResponse.status === 402 ? 402 : 500;
      return jsonResponse({
        error: statusCode === 429
          ? "Rate limit exceeded. Try again later."
          : statusCode === 402
          ? "Credits exhausted. Add funds in Settings > Workspace > Usage."
          : "AI processing failed",
      }, statusCode);
    }

    const aiData = await aiResponse.json();
    const durationMs = Date.now() - startMs;
    const modelUsed = aiData.model || DEFAULT_MODEL;

    // ─── Extract Tool Call Response ───
    let rawDecision: unknown = {};
    const toolCalls = aiData.choices?.[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      try {
        rawDecision = JSON.parse(toolCalls[0].function.arguments);
      } catch {
        rawDecision = { error: "Failed to parse tool call arguments" };
      }
    } else {
      // Fallback: try to parse content as JSON
      const content = aiData.choices?.[0]?.message?.content || "";
      try {
        rawDecision = JSON.parse(content);
      } catch {
        rawDecision = { raw_content: content };
      }
    }

    // ─── Validate Response ───
    const validated = validateAgentResponse(rawDecision);

    console.log(`[LIS] Agent=${agentName} Status=${validated.status} Confidence=${validated.confidence} Duration=${durationMs}ms`);

    // ─── Persist Result ───
    await svc.from("lis_agent_executions").update({
      status: validated.status,
      confidence: validated.confidence,
      decision: validated.decision,
      reasoning_summary: validated.reasoning_summary,
      warnings: validated.warnings,
      blocking_issues: validated.blocking_issues,
      actions_recommended: validated.actions_recommended,
      model_used: modelUsed,
      duration_ms: durationMs,
      raw_ai_response: aiData,
      finished_at: new Date().toISOString(),
    }).eq("id", executionId);

    // ─── Build Response ───
    const response = {
      execution_id: executionId,
      agent_name: agentName,
      stage,
      execution_mode,
      ...validated,
      audit_metadata: {
        input_hash: inputHash,
        context_version: contextVersion,
        executed_at: new Date().toISOString(),
        model_used: modelUsed,
        duration_ms: durationMs,
      },
    };

    return jsonResponse(response);
  } catch (err) {
    console.error("[LIS] Orchestrator error:", err);
    return jsonResponse({
      error: err instanceof Error ? err.message : "Unknown error",
    }, 500);
  }
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
