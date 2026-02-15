import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DeployGate {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startMs = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, model_id, reason } = await req.json();
    if (!project_id || !model_id) {
      return new Response(JSON.stringify({ error: "project_id e model_id obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[deploy-model] Starting deploy for project=${project_id}, model=${model_id}, user=${user.id}`);

    // ===== LOAD ALL SOURCES IN PARALLEL =====
    const [selectionRes, modelRes, datasetRes, dsStateRes, contractRes, projectRes, auditRes] = await Promise.all([
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_models").select("*").eq("id", model_id).eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("*").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("projects").select("organization_id").eq("id", project_id).single(),
      supabase.from("project_contract_audits").select("status, predictability_score").eq("project_id", project_id).order("audit_version", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const selection = selectionRes.data as any;
    const model = modelRes.data as any;
    const builderDataset = datasetRes.data as any;
    const dsState = dsStateRes.data as any;
    const contract = contractRes.data as any;
    const project = projectRes.data as any;
    const latestAudit = auditRes.data as any;

    if (!model) {
      return new Response(JSON.stringify({ success: false, status: "BLOCKED", blocked_reason_code: "MODEL_NOT_FOUND", gates: [{ gate: "model_exists", status: "BLOCK", message: "Modelo não encontrado." }], ctas: [{ label: "Voltar ao Treino", go_to_step: 5 }] }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gates: DeployGate[] = [];
    const ctas: { label: string; go_to_step?: number; action?: string }[] = [];
    const currentSelVersion = selection?.selection_version || 0;
    const hyper = (model.hyperparameters || {}) as Record<string, any>;

    // ===== GATE 1: Audit Contract (predictability score) =====
    if (latestAudit) {
      if (latestAudit.status === "block" || latestAudit.predictability_score < 60) {
        gates.push({ gate: "audit_contract", status: "BLOCK", message: `Predictability score=${latestAudit.predictability_score}/100 (mínimo: 60).`, details: { score: latestAudit.predictability_score } });
        ctas.push({ label: "Ver Auditoria do Contrato", go_to_step: 4 });
        return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
      }
      gates.push({ gate: "audit_contract", status: latestAudit.status === "warn" ? "WARN" : "PASS", message: `Predictability score=${latestAudit.predictability_score}/100` });
    } else {
      gates.push({ gate: "audit_contract", status: "WARN", message: "Sem auditoria de contrato — continuando." });
    }

    // ===== GATE 2: Model Artifacts OK =====
    const artifacts = hyper.model_artifacts;
    const featureNames = hyper.feature_names as string[] | undefined;
    const normalization = hyper.normalization;

    if (!artifacts || (!artifacts.weights && !artifacts.trees)) {
      gates.push({ gate: "model_artifacts", status: "BLOCK", message: "Modelo sem artefatos de treinamento." });
      ctas.push({ label: "Retreinar Modelo", go_to_step: 5 });
      return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
    }
    if (!featureNames || featureNames.length === 0) {
      gates.push({ gate: "model_artifacts", status: "BLOCK", message: "Modelo sem feature_names salvas." });
      ctas.push({ label: "Retreinar Modelo", go_to_step: 5 });
      return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
    }
    if (!normalization?.means || !normalization?.stds) {
      gates.push({ gate: "model_artifacts", status: "BLOCK", message: "Modelo sem normalização salva." });
      ctas.push({ label: "Retreinar Modelo", go_to_step: 5 });
      return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
    }
    gates.push({ gate: "model_artifacts", status: "PASS", message: `Artefatos OK: ${featureNames.length} features, normalization present` });

    // ===== GATE 3: Model Quality =====
    const mqf = hyper.model_quality_flag || model.status;
    const dashAllowed = hyper.dashboard_allowed !== false;
    const canPromote = hyper.can_promote_to_production !== false;

    if (mqf !== "ok" && mqf !== "trained") {
      gates.push({ gate: "model_quality", status: "BLOCK", message: `model_quality_flag=${mqf}. Modelo não aprovado.` });
      ctas.push({ label: "Voltar ao Treino", go_to_step: 5 });
      return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
    }
    if (!dashAllowed || !canPromote) {
      gates.push({ gate: "model_quality", status: "BLOCK", message: `dashboard_allowed=${dashAllowed}, can_promote=${canPromote}` });
      ctas.push({ label: "Voltar ao Treino", go_to_step: 5 });
      return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
    }
    gates.push({ gate: "model_quality", status: "PASS", message: `quality=${mqf}, dashboard=${dashAllowed}` });

    // ===== GATE 4: Selection Version Match =====
    const modelSelVersion = hyper.selection_version || 0;
    if (currentSelVersion > 0 && modelSelVersion > 0 && modelSelVersion !== currentSelVersion) {
      gates.push({ gate: "selection_version", status: "BLOCK", message: `Modelo treinado com v${modelSelVersion}, seleção atual v${currentSelVersion}.`, details: { model_version: modelSelVersion, current_version: currentSelVersion } });
      ctas.push({ label: "Retreinar Modelo", go_to_step: 5 });
      return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
    }
    gates.push({ gate: "selection_version", status: "PASS", message: `v${modelSelVersion} == v${currentSelVersion}` });

    // ===== GATE 5: Dataset Current =====
    if (builderDataset) {
      const builderSelVersion = (builderDataset as any).selection_version_used || 0;
      if (currentSelVersion > 0 && builderSelVersion < currentSelVersion) {
        gates.push({ gate: "dataset_current", status: "BLOCK", message: `Builder dataset (v${builderSelVersion}) desatualizado vs seleção (v${currentSelVersion}).` });
        ctas.push({ label: "Regerar Builder", go_to_step: 4 });
        return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
      }
      gates.push({ gate: "dataset_current", status: "PASS", message: `Dataset OK: sel_v=${builderSelVersion}` });
    } else {
      gates.push({ gate: "dataset_current", status: "WARN", message: "Sem dataset modelável (legacy path)." });
    }

    // ===== GATE 6: Contract =====
    if (contract) {
      if (contract.status === "blocked") {
        gates.push({ gate: "contract", status: "BLOCK", message: "Contrato de modelagem bloqueado." });
        ctas.push({ label: "Revisar Contrato", go_to_step: 4 });
        return blockResponse(gates, ctas, project_id, model_id, currentSelVersion);
      }
      gates.push({ gate: "contract", status: "PASS", message: `Contrato OK (status=${contract.status})` });
    } else {
      gates.push({ gate: "contract", status: "WARN", message: "Sem contrato — continuando." });
    }

    // ===== ALL GATES PASSED — CALL ATOMIC RPC =====
    console.log(`[deploy-model] All gates PASS. Calling rpc_promote_model_to_production`);

    const { data: rpcResult, error: rpcError } = await supabase.rpc("rpc_promote_model_to_production", {
      p_project_id: project_id,
      p_model_id: model_id,
      p_reason: reason || "Deploy via UI",
    });

    if (rpcError) {
      console.error("[deploy-model] RPC error:", rpcError);
      gates.push({ gate: "atomic_promotion", status: "BLOCK", message: `Erro na promoção: ${rpcError.message}` });
      return blockResponse(gates, [{ label: "Tentar novamente" }], project_id, model_id, currentSelVersion);
    }

    const result = rpcResult as any;
    if (!result?.success) {
      console.error("[deploy-model] RPC returned failure:", result);
      gates.push({ gate: "atomic_promotion", status: "BLOCK", message: result?.message || "Falha na promoção atômica." });
      return blockResponse(gates, [{ label: "Voltar ao Treino", go_to_step: 5 }], project_id, model_id, currentSelVersion);
    }

    gates.push({ gate: "atomic_promotion", status: "PASS", message: `Promoted. deployment_id=${result.deployment_id}` });

    // Update project status
    await supabase.from("projects").update({ status: "deployed" }).eq("id", project_id);

    // Audit log
    if (project?.organization_id) {
      try {
        await supabase.from("audit_logs").insert({
          organization_id: project.organization_id,
          project_id,
          user_id: user.id,
          action: "model_deployed",
          resource_type: "model",
          resource_name: model.algorithm_name || model_id,
          metadata: {
            model_id,
            deployment_id: result.deployment_id,
            previous_model_id: result.previous_model_id,
            selection_version: result.selection_version,
            gates: gates.map(g => ({ gate: g.gate, status: g.status })),
          },
        });
      } catch (auditErr) {
        console.error("[deploy-model] Audit log failed:", auditErr);
      }
    }

    const elapsedMs = Date.now() - startMs;
    console.log(`[deploy-model] SUCCESS in ${elapsedMs}ms. deployment_id=${result.deployment_id}`);

    return new Response(JSON.stringify({
      success: true,
      status: "DEPLOYED",
      selection_version: result.selection_version,
      model_id,
      production_model_id: result.production_model_id,
      previous_model_id: result.previous_model_id,
      deployment_id: result.deployment_id,
      deployed_at: new Date().toISOString(),
      scoring_enabled: true,
      dashboard_enabled: dashAllowed,
      gates,
      ctas: [],
      elapsed_ms: elapsedMs,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[deploy-model] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      status: "BLOCKED",
      error: error instanceof Error ? error.message : "Erro desconhecido",
      blocked_reason_code: "INTERNAL_ERROR",
      gates: [],
      ctas: [],
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function blockResponse(
  gates: DeployGate[],
  ctas: { label: string; go_to_step?: number; action?: string }[],
  projectId: string,
  modelId: string,
  selectionVersion: number,
) {
  return new Response(JSON.stringify({
    success: false,
    status: "BLOCKED",
    selection_version: selectionVersion,
    model_id: modelId,
    production_model_id: null,
    previous_model_id: null,
    deployment_id: null,
    deployed_at: null,
    scoring_enabled: false,
    dashboard_enabled: false,
    blocked_reason_code: gates.find(g => g.status === "BLOCK")?.gate || "UNKNOWN",
    gates,
    ctas,
  }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
