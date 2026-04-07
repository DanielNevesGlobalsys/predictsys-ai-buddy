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
import {
  GOVERNANCE_SYSTEM_PROMPT,
  GOVERNANCE_RESPONSE_TOOL,
  buildGovernanceContext,
  buildGovernancePrompt,
  validateGovernanceResponse,
} from "../_shared/governance-agent.ts";
import {
  DS_SYSTEM_PROMPT,
  DS_RESPONSE_TOOL,
  buildDSContext,
  buildDSPrompt,
  validateDSResponse,
} from "../_shared/data-scientist-agent.ts";
import {
  DE_SYSTEM_PROMPT,
  DE_RESPONSE_TOOL,
  buildDEContext,
  buildDEPrompt,
  validateDEResponse,
} from "../_shared/data-engineer-agent.ts";
import {
  ML_SYSTEM_PROMPT,
  ML_RESPONSE_TOOL,
  buildMLContext,
  buildMLPrompt,
  validateMLResponse,
} from "../_shared/ml-engineer-agent.ts";
import {
  BA_SYSTEM_PROMPT,
  BA_RESPONSE_TOOL,
  buildBAContext,
  buildBAPrompt,
  validateBAResponse,
} from "../_shared/business-analyst-agent.ts";

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

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

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
    const isGovernanceAgent = agentName === "governance_agent";
    const isDSAgent = agentName === "data_scientist_agent";
    const isDEAgent = agentName === "data_engineer_agent";
    const isMLAgent = agentName === "ml_engineer_agent";
    const isBAAgent = agentName === "business_analyst_agent";

    console.log(`[LIS] Agent=${agentName} Stage=${stage} Mode=${execution_mode} Project=${project_id}`);

    // ─── Build Context ───
    let systemPrompt: string;
    let userPrompt: string;
    let toolDef: any;
    let toolName: string;
    let projectContext: Record<string, unknown>;

    if (isGovernanceAgent) {
      const govCtx = await buildGovernanceContext(svc, project_id, stage, execution_mode);
      systemPrompt = GOVERNANCE_SYSTEM_PROMPT;
      userPrompt = buildGovernancePrompt(govCtx);
      toolDef = GOVERNANCE_RESPONSE_TOOL;
      toolName = "governance_decision";
      projectContext = govCtx as unknown as Record<string, unknown>;
    } else if (isDSAgent) {
      const dsCtx = await buildDSContext(svc, project_id, stage, execution_mode);
      systemPrompt = DS_SYSTEM_PROMPT;
      userPrompt = buildDSPrompt(dsCtx);
      toolDef = DS_RESPONSE_TOOL;
      toolName = "ds_decision";
      projectContext = dsCtx as unknown as Record<string, unknown>;
    } else if (isDEAgent) {
      const deCtx = await buildDEContext(svc, project_id, stage, execution_mode);
      systemPrompt = DE_SYSTEM_PROMPT;
      userPrompt = buildDEPrompt(deCtx);
      toolDef = DE_RESPONSE_TOOL;
      toolName = "de_decision";
      projectContext = deCtx as unknown as Record<string, unknown>;
    } else if (isMLAgent) {
      const mlCtx = await buildMLContext(svc, project_id, stage, execution_mode);
      systemPrompt = ML_SYSTEM_PROMPT;
      userPrompt = buildMLPrompt(mlCtx);
      toolDef = ML_RESPONSE_TOOL;
      toolName = "ml_decision";
      projectContext = mlCtx as unknown as Record<string, unknown>;
    } else if (isBAAgent) {
      const baCtx = await buildBAContext(svc, project_id, stage, execution_mode);
      systemPrompt = BA_SYSTEM_PROMPT;
      userPrompt = buildBAPrompt(baCtx);
      toolDef = BA_RESPONSE_TOOL;
      toolName = "business_decision";
      projectContext = baCtx as unknown as Record<string, unknown>;
    } else {
      // Generic agent flow
      systemPrompt = AGENT_SYSTEM_PROMPTS[agentName];
      if (!systemPrompt) {
        return jsonResponse({ error: `Unknown agent: ${agentName}` }, 400);
      }

      const [aiCtxRes, settingsRes, selectionRes] = await Promise.all([
        svc.from("project_ai_context").select("context, status").eq("project_id", project_id).maybeSingle(),
        svc.from("project_settings")
          .select("ingestion_state, eda_state, target_state, split_state, builder_state, training_state, scoring_state, dashboard_state, selection_version, dataset_version")
          .eq("project_id", project_id).maybeSingle(),
        svc.from("project_model_selection")
          .select("target_column, problem_type, selected_features, excluded_features, selection_version")
          .eq("project_id", project_id).maybeSingle(),
      ]);

      projectContext = {
        ai_context: aiCtxRes.data?.context || {},
        pipeline_state: settingsRes.data || {},
        model_selection: selectionRes.data || {},
        stage,
        execution_mode,
      };

      userPrompt = buildAgentPrompt(agentName, stage, projectContext, input_contract);
      toolDef = AGENT_RESPONSE_TOOL;
      toolName = "agent_decision";
    }

    const contextVersion = `v${(projectContext as any).selection_version || 0}_dv${(projectContext as any).dataset_version || 0}`;
    const inputHash = await computeInputHash({ ...input_contract, stage, agentName });

    // ─── Create Execution Record ───
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
        tools: [toolDef],
        tool_choice: { type: "function", function: { name: toolName } },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error(`[LIS] AI Gateway error ${aiResponse.status}:`, errText);

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
      const content = aiData.choices?.[0]?.message?.content || "";
      try {
        rawDecision = JSON.parse(content);
      } catch {
        rawDecision = { raw_content: content };
      }
    }

    // ─── Validate Response ───
    let finalResponse: Record<string, unknown>;

    if (isGovernanceAgent) {
      const govDecision = validateGovernanceResponse(rawDecision);
      console.log(`[LIS-GOV] Pipeline=${govDecision.pipeline_status} Conflict=${govDecision.governance_conflict} Confidence=${govDecision.confidence} Blocks=${govDecision.blocking_reasons.length} Warns=${govDecision.warnings.length}`);

      // Map governance decision to the standard execution record fields
      const mappedStatus = govDecision.pipeline_status === "blocked" ? "blocked"
        : govDecision.pipeline_status === "warning" ? "warning"
        : "success";

      await svc.from("lis_agent_executions").update({
        status: mappedStatus,
        confidence: govDecision.confidence,
        decision: govDecision as unknown as Record<string, unknown>,
        reasoning_summary: govDecision.conflict_summary.length > 0
          ? govDecision.conflict_summary
          : govDecision.consistency_checks.map(c => `[${c.status}] ${c.check}: ${c.reason}`),
        warnings: govDecision.warnings,
        blocking_issues: govDecision.blocking_reasons,
        actions_recommended: govDecision.actions_required,
        model_used: modelUsed,
        duration_ms: durationMs,
        raw_ai_response: aiData,
        finished_at: new Date().toISOString(),
      }).eq("id", executionId);

      finalResponse = {
        execution_id: executionId,
        agent_name: agentName,
        stage,
        execution_mode,
        governance_decision: govDecision,
        audit_metadata: {
          input_hash: inputHash,
          context_version: contextVersion,
          executed_at: new Date().toISOString(),
          model_used: modelUsed,
          duration_ms: durationMs,
        },
      };
    } else if (isDSAgent) {
      const dsDecision = validateDSResponse(rawDecision);
      console.log(`[LIS-DS] Family=${dsDecision.problem_formulation.objective_family} Target=${dsDecision.target_recommendation.recommended_target} Confidence=${dsDecision.confidence} Duration=${durationMs}ms`);

      await svc.from("lis_agent_executions").update({
        status: dsDecision.confidence >= 0.5 ? "success" : "warning",
        confidence: dsDecision.confidence,
        decision: dsDecision as unknown as Record<string, unknown>,
        reasoning_summary: dsDecision.target_recommendation.target_reasoning,
        warnings: [
          ...dsDecision.modeling_risk_assessment.target_risks,
          ...dsDecision.modeling_risk_assessment.general_risks,
        ],
        blocking_issues: dsDecision.actions_recommended
          .filter(a => a.priority === "critical")
          .map(a => a.action),
        actions_recommended: dsDecision.actions_recommended,
        model_used: modelUsed,
        duration_ms: durationMs,
        raw_ai_response: aiData,
        finished_at: new Date().toISOString(),
      }).eq("id", executionId);

      finalResponse = {
        execution_id: executionId,
        agent_name: agentName,
        stage,
        execution_mode,
        ds_decision: dsDecision,
        audit_metadata: {
          input_hash: inputHash,
          context_version: contextVersion,
          executed_at: new Date().toISOString(),
          model_used: modelUsed,
          duration_ms: durationMs,
        },
      };
    } else if (isDEAgent) {
      const deDecision = validateDEResponse(rawDecision);
      console.log(`[LIS-DE] BuildMode=${deDecision.builder_plan.dataset_build_mode} Compatible=${deDecision.training_scoring_compatibility.compatible} Confidence=${deDecision.confidence} Duration=${durationMs}ms`);

      const deWarnings = [
        ...deDecision.schema_assessment.schema_warnings,
        ...deDecision.data_reliability_assessment.delimiter_risk,
        ...deDecision.data_reliability_assessment.parsing_risk,
      ];

      await svc.from("lis_agent_executions").update({
        status: deDecision.schema_assessment.schema_blockers.length > 0 ? "blocked"
          : deDecision.confidence >= 0.5 ? "success" : "warning",
        confidence: deDecision.confidence,
        decision: deDecision as unknown as Record<string, unknown>,
        reasoning_summary: deDecision.builder_plan.reasoning,
        warnings: deWarnings,
        blocking_issues: deDecision.schema_assessment.schema_blockers,
        actions_recommended: deDecision.actions_recommended,
        model_used: modelUsed,
        duration_ms: durationMs,
        raw_ai_response: aiData,
        finished_at: new Date().toISOString(),
      }).eq("id", executionId);

      finalResponse = {
        execution_id: executionId,
        agent_name: agentName,
        stage,
        execution_mode,
        de_decision: deDecision,
        audit_metadata: {
          input_hash: inputHash,
          context_version: contextVersion,
          executed_at: new Date().toISOString(),
          model_used: modelUsed,
          duration_ms: durationMs,
        },
      };
    } else if (isMLAgent) {
      const mlDecision = validateMLResponse(rawDecision);
      console.log(`[LIS-ML] Quality=${mlDecision.training_assessment.model_quality} Deploy=${mlDecision.deploy_readiness.status} Metric=${mlDecision.training_assessment.primary_metric_name}=${mlDecision.training_assessment.primary_metric_value} Confidence=${mlDecision.confidence} Duration=${durationMs}ms`);

      const mlWarnings = [
        ...mlDecision.overfit_underfit_assessment.overfit_signals,
        ...mlDecision.overfit_underfit_assessment.underfit_signals,
        ...mlDecision.overfit_underfit_assessment.feature_dominance_risks,
      ];

      await svc.from("lis_agent_executions").update({
        status: mlDecision.deploy_readiness.status === "blocked" ? "blocked"
          : mlDecision.confidence >= 0.5 ? "success" : "warning",
        confidence: mlDecision.confidence,
        decision: mlDecision as unknown as Record<string, unknown>,
        reasoning_summary: mlDecision.training_assessment.reasoning,
        warnings: mlWarnings,
        blocking_issues: mlDecision.deploy_readiness.required_actions,
        actions_recommended: mlDecision.model_improvement_opportunities.map(o => ({
          action: o.suggestion, target: o.area, priority: o.expected_impact === "high" ? "high" : "medium", auto_applicable: false,
        })),
        model_used: modelUsed,
        duration_ms: durationMs,
        raw_ai_response: aiData,
        finished_at: new Date().toISOString(),
      }).eq("id", executionId);

      finalResponse = {
        execution_id: executionId,
        agent_name: agentName,
        stage,
        execution_mode,
        ml_decision: mlDecision,
        audit_metadata: {
          input_hash: inputHash,
          context_version: contextVersion,
          executed_at: new Date().toISOString(),
          model_used: modelUsed,
          duration_ms: durationMs,
        },
      };
    } else {
      const validated = validateAgentResponse(rawDecision);
      console.log(`[LIS] Agent=${agentName} Status=${validated.status} Confidence=${validated.confidence} Duration=${durationMs}ms`);

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

      finalResponse = {
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
    }

    return jsonResponse(finalResponse);
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
