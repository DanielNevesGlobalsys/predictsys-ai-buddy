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

    const { project_id, model_id } = await req.json();
    if (!project_id || !model_id) {
      return new Response(JSON.stringify({ error: "project_id e model_id obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[deploy-model] Starting deploy for project=${project_id}, model=${model_id}, user=${user.id}`);

    // ===== LOAD ALL SOURCES IN PARALLEL =====
    const [selectionRes, modelRes, datasetRes, dsStateRes, contractRes, projectRes] = await Promise.all([
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_models").select("*").eq("id", model_id).eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("*").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("projects").select("organization_id").eq("id", project_id).single(),
    ]);

    const selection = selectionRes.data as any;
    const model = modelRes.data as any;
    const builderDataset = datasetRes.data as any;
    const dsState = dsStateRes.data as any;
    const contract = contractRes.data as any;
    const project = projectRes.data as any;

    if (!model) {
      return new Response(JSON.stringify({ error: "Modelo não encontrado", status: "BLOCKED", blocked_reason_code: "MODEL_NOT_FOUND" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gates: DeployGate[] = [];
    const currentSelVersion = selection?.selection_version || 0;
    const hyper = (model.hyperparameters || {}) as Record<string, any>;

    // Helper
    const blockResult = (code: string, message: string, cta: { label: string; go_to_step?: number }) => {
      console.error(`[deploy-model] BLOCKED: ${code} — ${message}`);
      return new Response(JSON.stringify({
        status: "BLOCKED",
        selection_version: currentSelVersion,
        model_id,
        production_model_id: null,
        deployed_at: null,
        scoring_enabled: false,
        dashboard_enabled: false,
        blocked_reason_code: code,
        gates,
        ctas: [cta],
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    };

    // ===== GATE 1: Modelo Válido =====
    const mqf = hyper.model_quality_flag || model.status;
    const dashAllowed = hyper.dashboard_allowed !== false;
    const canPromote = hyper.can_promote_to_production !== false;

    if (mqf !== "ok" && mqf !== "trained") {
      gates.push({ gate: "model_valid", status: "BLOCK", message: `model_quality_flag=${mqf}. Modelo não aprovado.` });
      return blockResult("MODEL_QUALITY_FAILED", `Modelo reprovado (quality=${mqf}). Retreine com dados melhores.`, { label: "Voltar ao Treino", go_to_step: 4 });
    }
    if (!dashAllowed) {
      gates.push({ gate: "model_valid", status: "BLOCK", message: "dashboard_allowed=false. Modelo sem permissão para dashboard." });
      return blockResult("DASHBOARD_NOT_ALLOWED", "Modelo não tem permissão para dashboard. Retreine ou ajuste target.", { label: "Voltar ao Treino", go_to_step: 4 });
    }
    if (!canPromote) {
      gates.push({ gate: "model_valid", status: "BLOCK", message: "can_promote_to_production=false." });
      return blockResult("CANNOT_PROMOTE", "Modelo não elegível para produção (não supera baseline ou sanidade falhou).", { label: "Voltar ao Treino", go_to_step: 4 });
    }
    gates.push({ gate: "model_valid", status: "PASS", message: `Modelo válido: quality=${mqf}, dashboard=${dashAllowed}` });

    // ===== GATE 2: Versionamento =====
    const modelSelVersion = hyper.selection_version || 0;
    if (currentSelVersion > 0 && modelSelVersion > 0 && modelSelVersion !== currentSelVersion) {
      gates.push({ gate: "versioning", status: "BLOCK", message: `Modelo treinado com v${modelSelVersion}, seleção atual v${currentSelVersion}.`, details: { model_version: modelSelVersion, current_version: currentSelVersion } });
      return blockResult("VERSION_MISMATCH", `Modelo desatualizado (treinado v${modelSelVersion}, atual v${currentSelVersion}). Retreine.`, { label: "Retreinar Modelo", go_to_step: 4 });
    }
    gates.push({ gate: "versioning", status: "PASS", message: `Versão OK: model=v${modelSelVersion}, selection=v${currentSelVersion}` });

    // ===== GATE 3: Dataset Atual =====
    const modelDatasetId = hyper.builder_dataset_id || null;
    if (builderDataset) {
      const builderSelVersion = (builderDataset as any).selection_version_used || 0;
      if (modelDatasetId && modelDatasetId !== builderDataset.id) {
        gates.push({ gate: "dataset_current", status: "BLOCK", message: `Modelo usa dataset ${modelDatasetId}, mas o atual é ${builderDataset.id}.` });
        return blockResult("DATASET_MISMATCH", "Modelo treinado com dataset diferente do atual. Retreine.", { label: "Retreinar Modelo", go_to_step: 4 });
      }
      if (currentSelVersion > 0 && builderSelVersion < currentSelVersion) {
        gates.push({ gate: "dataset_current", status: "BLOCK", message: `Builder dataset (v${builderSelVersion}) desatualizado vs seleção (v${currentSelVersion}).` });
        return blockResult("BUILDER_OUTDATED", "Builder desatualizado. Regere o dataset modelável antes de promover.", { label: "Regerar Builder", go_to_step: 3 });
      }
      gates.push({ gate: "dataset_current", status: "PASS", message: `Dataset atual: id=${builderDataset.id}, sel_v=${builderSelVersion}` });
    } else {
      // No builder — warn but allow (legacy path)
      gates.push({ gate: "dataset_current", status: "WARN", message: "Nenhum dataset modelável encontrado (legacy path)." });
    }

    // ===== GATE 4: Contrato =====
    if (contract) {
      if (contract.status === "blocked") {
        gates.push({ gate: "contract", status: "BLOCK", message: "Contrato de modelagem bloqueado.", details: { reasons: contract.blocked_reasons } });
        return blockResult("CONTRACT_BLOCKED", "Contrato de modelagem está bloqueado. Revise Target/Features.", { label: "Revisar Contrato", go_to_step: 3 });
      }
      gates.push({ gate: "contract", status: "PASS", message: `Contrato OK (status=${contract.status})` });
    } else {
      gates.push({ gate: "contract", status: "WARN", message: "Sem contrato de modelagem — continuando sem contrato." });
    }

    // ===== ALL GATES PASSED — PROMOTE =====
    console.log(`[deploy-model] All gates PASS. Promoting model ${model_id}`);

    const deployedAt = new Date().toISOString();

    // 1) Demote all existing production models for this project
    await supabase
      .from("project_models")
      .update({ is_production: false })
      .eq("project_id", project_id)
      .eq("is_production", true);

    // 2) Promote current model
    await supabase
      .from("project_models")
      .update({
        is_production: true,
        deployed_at: deployedAt,
        deployed_selection_version: currentSelVersion,
        status: "trained",
      })
      .eq("id", model_id);

    // 3) Update project_dataset_state with production_model_id
    if (dsState) {
      await supabase
        .from("project_dataset_state")
        .update({ production_model_id: model_id })
        .eq("project_id", project_id);
    }

    // 4) Update project status
    await supabase
      .from("projects")
      .update({ status: "deployed" })
      .eq("id", project_id);

    // 5) Audit log
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
            selection_version: currentSelVersion,
            model_quality_flag: mqf,
            deployed_at: deployedAt,
            gates: gates.map(g => ({ gate: g.gate, status: g.status })),
          },
        });
      } catch (auditErr) {
        console.error("[deploy-model] Audit log failed:", auditErr);
      }
    }

    const elapsedMs = Date.now() - startMs;
    console.log(`[deploy-model] SUCCESS in ${elapsedMs}ms. Model ${model_id} is now production.`);

    return new Response(JSON.stringify({
      status: "DEPLOYED",
      selection_version: currentSelVersion,
      model_id,
      production_model_id: model_id,
      deployed_at: deployedAt,
      scoring_enabled: true,
      dashboard_enabled: dashAllowed,
      blocked_reason_code: null,
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
      status: "BLOCKED",
      error: error instanceof Error ? error.message : "Erro desconhecido",
      blocked_reason_code: "INTERNAL_ERROR",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
