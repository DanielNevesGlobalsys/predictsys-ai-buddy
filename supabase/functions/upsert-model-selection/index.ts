import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type RpcResult = {
  success: boolean;
  selection_version: number;
  target_hash: string;
  did_change: boolean;
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      project_id,
      target_column,
      problem_type,
      selected_features,
      excluded_features,
    } = body;

    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!target_column) {
      return new Response(JSON.stringify({ error: "target_column obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, organization_id, user_id")
      .eq("id", project_id)
      .single();

    if (projErr || !project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(
      `[upsert-model-selection] project=${project_id}, target=${target_column}, user=${user.id}`,
    );

    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "rpc_upsert_model_selection",
      {
        p_project_id: project_id,
        p_organization_id: project.organization_id,
        p_user_id: user.id,
        p_target_column: target_column,
        p_problem_type: problem_type || "",
        p_selected_features: selected_features || [],
        p_excluded_features: excluded_features || [],
      },
    );

    if (rpcErr || !rpcData || (Array.isArray(rpcData) && rpcData.length === 0)) {
      console.error("[upsert-model-selection] RPC error:", rpcErr);
      return new Response(
        JSON.stringify({ error: "Erro ao salvar seleção (RPC)", details: rpcErr?.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result: RpcResult = Array.isArray(rpcData) ? rpcData[0] : rpcData;

    const newVersion = result.selection_version;
    const targetHash = result.target_hash;
    const didChange = result.did_change;

    console.log(
      `[upsert-model-selection] Saved v${newVersion}, hash=${targetHash}, did_change=${didChange}`,
    );

    let staleCount = 0;

    if (didChange) {
      const { data: staleUpdated } = await supabase
        .from("project_modeling_datasets")
        .update({ is_current: false, stale_reason: "SELECTION_CHANGED" })
        .eq("project_id", project_id)
        .eq("is_current", true)
        .select("id");

      staleCount = staleUpdated?.length || 0;
      console.log(`[upsert-model-selection] Marked ${staleCount} datasets as stale`);
    } else {
      console.log("[upsert-model-selection] No-op change: not staling datasets.");
    }

    if (didChange) {
      const { data: dsState } = await supabase
        .from("project_dataset_state")
        .select("diagnostics")
        .eq("project_id", project_id)
        .maybeSingle();

      const oldDiag = (dsState as any)?.diagnostics || {};
      await supabase
        .from("project_dataset_state")
        .update({
          model_ready: false,
          diagnostics: {
            ...oldDiag,
            last_selection_change: new Date().toISOString(),
            last_selection_version: newVersion,
            pending_action: "TARGET_CHANGED_REQUIRES_REBUILD",
          },
        })
        .eq("project_id", project_id);
    }

    // ── Derive active_target_mode from target_column context ──
    // Read current target_source to determine mode
    const { data: currentSettings } = await supabase
      .from("project_settings")
      .select("target_source, active_target_mode")
      .eq("project_id", project_id)
      .maybeSingle();

    const currentSource = (currentSettings as any)?.target_source || "manual";
    // Map target_source → active_target_mode for resolveActiveTarget() parity
    const sourceToMode: Record<string, string> = {
      label_builder: "template",
      weak_supervision: "weak",
      human_labeling: "human",
      manual: "column",
      column: "column",
    };
    const resolvedMode = sourceToMode[currentSource] || "column";

    await supabase
      .from("project_settings")
      .upsert(
        {
          project_id,
          org_id: project.organization_id,
          target_column,
          problem_type: problem_type || null,
          feature_columns: selected_features || [],
          excluded_columns: excluded_features || [],
          // ── SSOT State Machine: sync selection_version + target_state + active_target_mode ──
          selection_version: newVersion,
          target_state: target_column ? "ready" : "draft",
          active_target_column: target_column,
          active_target_mode: resolvedMode,
        },
        { onConflict: "project_id" },
      );

    // ── SSOT: Mark downstream stages as stale when selection changes ──
    if (didChange) {
      await supabase.rpc("rpc_update_pipeline_state", {
        p_project_id: project_id,
        p_stage: "builder",
        p_new_state: "draft",
      });
    }

    // ── Sync modeling contract problem_type when selection changes ──
    if (didChange && problem_type) {
      const { data: contract } = await supabase
        .from("project_modeling_contracts")
        .select("id, target_definition")
        .eq("project_id", project_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (contract) {
        const targetDef = (contract.target_definition as any) || {};
        const contractPT = (targetDef.problem_type || "").toLowerCase();
        const normalize = (t: string) => {
          const l = t.toLowerCase();
          if (["binary", "classification", "binary_classification"].includes(l)) return "classification";
          if (["regression", "continuous"].includes(l)) return "regression";
          return l;
        };
        if (normalize(contractPT) !== normalize(problem_type)) {
          const updatedDef = { ...targetDef, problem_type };
          await supabase
            .from("project_modeling_contracts")
            .update({ target_definition: updatedDef, updated_at: new Date().toISOString() })
            .eq("id", contract.id);
          console.log(`[upsert-model-selection] Synced contract problem_type: ${contractPT} → ${problem_type}`);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        selection_version: newVersion,
        target_hash: targetHash,
        did_change: didChange,
        target_column,
        stale_datasets_count: staleCount,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[upsert-model-selection] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
