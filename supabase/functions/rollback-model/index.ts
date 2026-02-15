import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RollbackGate {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[rollback-model] Starting rollback for project=${project_id}, user=${user.id}`);

    const gates: RollbackGate[] = [];

    // Find last successful deployment with a previous_model_id
    const { data: lastDeployment, error: deployErr } = await supabase
      .from("project_model_deployments")
      .select("*")
      .eq("project_id", project_id)
      .eq("status", "success")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (deployErr || !lastDeployment) {
      gates.push({ gate: "deployment_history", status: "BLOCK", message: "Nenhum deploy encontrado para este projeto." });
      return new Response(JSON.stringify({
        success: false, status: "BLOCKED", gates,
        ctas: [{ label: "Fazer Deploy primeiro", go_to_step: 6 }],
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    gates.push({ gate: "deployment_history", status: "PASS", message: `Último deploy: ${lastDeployment.id}` });

    const previousModelId = lastDeployment.previous_model_id;
    if (!previousModelId) {
      gates.push({ gate: "previous_model", status: "BLOCK", message: "Não existe modelo anterior para rollback (primeiro deploy do projeto)." });
      return new Response(JSON.stringify({
        success: false, status: "BLOCKED", gates,
        ctas: [{ label: "Treinar novo modelo", go_to_step: 5 }],
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify previous model still exists and is trained
    const { data: prevModel } = await supabase
      .from("project_models")
      .select("id, status, algorithm_name, hyperparameters")
      .eq("id", previousModelId)
      .eq("project_id", project_id)
      .maybeSingle();

    if (!prevModel) {
      gates.push({ gate: "previous_model", status: "BLOCK", message: `Modelo anterior (${previousModelId}) não encontrado — pode ter sido deletado.` });
      return new Response(JSON.stringify({
        success: false, status: "BLOCKED", gates,
        ctas: [{ label: "Treinar novo modelo", go_to_step: 5 }],
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (prevModel.status !== "trained" && prevModel.status !== "completed") {
      gates.push({ gate: "previous_model", status: "BLOCK", message: `Modelo anterior status=${prevModel.status}. Não é possível restaurar.` });
      return new Response(JSON.stringify({
        success: false, status: "BLOCKED", gates,
        ctas: [{ label: "Treinar novo modelo", go_to_step: 5 }],
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify artifacts exist on previous model
    const prevHyper = (prevModel.hyperparameters || {}) as Record<string, any>;
    const prevArtifacts = prevHyper.model_artifacts;
    if (!prevArtifacts || (!prevArtifacts.weights && !prevArtifacts.trees)) {
      gates.push({ gate: "previous_model_artifacts", status: "BLOCK", message: "Modelo anterior sem artefatos de treinamento." });
      return new Response(JSON.stringify({
        success: false, status: "BLOCKED", gates,
        ctas: [{ label: "Treinar novo modelo", go_to_step: 5 }],
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    gates.push({ gate: "previous_model", status: "PASS", message: `Modelo anterior OK: ${prevModel.algorithm_name} (${previousModelId})` });

    // Call atomic RPC to promote the previous model
    console.log(`[rollback-model] Promoting previous model ${previousModelId}`);

    const { data: rpcResult, error: rpcError } = await supabase.rpc("rpc_promote_model_to_production", {
      p_project_id: project_id,
      p_model_id: previousModelId,
      p_reason: "Rollback para modelo anterior",
    });

    if (rpcError) {
      console.error("[rollback-model] RPC error:", rpcError);
      gates.push({ gate: "atomic_rollback", status: "BLOCK", message: `Erro no rollback: ${rpcError.message}` });
      return new Response(JSON.stringify({
        success: false, status: "BLOCKED", gates, ctas: [],
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const result = rpcResult as any;
    if (!result?.success) {
      gates.push({ gate: "atomic_rollback", status: "BLOCK", message: result?.message || "Falha no rollback atômico." });
      return new Response(JSON.stringify({
        success: false, status: "BLOCKED", gates, ctas: [],
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    gates.push({ gate: "atomic_rollback", status: "PASS", message: `Rollback OK. deployment_id=${result.deployment_id}` });

    // Mark the new deployment as a rollback
    if (result.deployment_id) {
      await supabase.from("project_model_deployments")
        .update({ metadata: { rollback: true, rolled_back_from: lastDeployment.model_id }, reason: "Rollback para modelo anterior" })
        .eq("id", result.deployment_id);
    }

    // Audit log
    const { data: project } = await supabase.from("projects").select("organization_id").eq("id", project_id).single();
    if (project?.organization_id) {
      try {
        await supabase.from("audit_logs").insert({
          organization_id: project.organization_id,
          project_id,
          user_id: user.id,
          action: "model_rollback",
          resource_type: "model",
          resource_name: prevModel.algorithm_name || previousModelId,
          metadata: {
            rolled_back_model_id: lastDeployment.model_id,
            restored_model_id: previousModelId,
            deployment_id: result.deployment_id,
            gates: gates.map(g => ({ gate: g.gate, status: g.status })),
          },
        });
      } catch (auditErr) {
        console.error("[rollback-model] Audit log failed:", auditErr);
      }
    }

    console.log(`[rollback-model] SUCCESS. Restored model ${previousModelId}`);

    return new Response(JSON.stringify({
      success: true,
      status: "ROLLED_BACK",
      production_model_id: result.production_model_id,
      previous_model_id: result.previous_model_id,
      deployment_id: result.deployment_id,
      selection_version: result.selection_version,
      rolled_back_from: lastDeployment.model_id,
      gates,
      ctas: [],
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[rollback-model] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      status: "BLOCKED",
      error: error instanceof Error ? error.message : "Erro desconhecido",
      gates: [],
      ctas: [],
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
