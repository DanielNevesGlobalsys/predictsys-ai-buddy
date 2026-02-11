import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { project_id, target_column, problem_type, selected_features, excluded_features } = body;

    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!target_column) {
      return new Response(JSON.stringify({ error: "target_column obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify project access
    const { data: project, error: projErr } = await supabase
      .from("projects").select("id, organization_id, user_id").eq("id", project_id).single();
    if (projErr || !project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[upsert-model-selection] project=${project_id}, target=${target_column}, user=${user.id}`);

    // ── 1. Atomically increment selection_version ──
    const { data: existing } = await supabase
      .from("project_model_selection")
      .select("selection_version")
      .eq("project_id", project_id)
      .maybeSingle();

    const currentVersion = (existing as any)?.selection_version || 0;
    const newVersion = currentVersion + 1;

    // Compute target_hash
    const hashInput = `${project_id}|${target_column}|${newVersion}`;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      const ch = hashInput.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0;
    }
    const targetHash = `th_${Math.abs(hash).toString(36)}`;

    const selectionRecord = {
      project_id,
      organization_id: project.organization_id,
      target_column,
      problem_type: problem_type || null,
      selected_features: selected_features || [],
      excluded_features: excluded_features || [],
      selection_version: newVersion,
      target_hash: targetHash,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    };

    const { error: upsertErr } = await supabase
      .from("project_model_selection")
      .upsert(selectionRecord, { onConflict: "project_id" });

    if (upsertErr) {
      console.error("[upsert-model-selection] Upsert error:", upsertErr);
      return new Response(JSON.stringify({ error: "Erro ao salvar seleção", details: upsertErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[upsert-model-selection] Saved v${newVersion}, hash=${targetHash}`);

    // ── 2. Mark ALL existing modeling datasets as stale ──
    const { data: staleUpdated } = await supabase
      .from("project_modeling_datasets")
      .update({ is_current: false, stale_reason: "SELECTION_CHANGED" })
      .eq("project_id", project_id)
      .eq("is_current", true)
      .select("id");

    const staleCount = staleUpdated?.length || 0;
    console.log(`[upsert-model-selection] Marked ${staleCount} datasets as stale`);

    // ── 3. Update project_dataset_state.model_ready=false + diagnostics ──
    const { data: dsState } = await supabase
      .from("project_dataset_state")
      .select("diagnostics")
      .eq("project_id", project_id)
      .maybeSingle();

    if (dsState) {
      const oldDiag = (dsState as any).diagnostics || {};
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

    // ── 4. Also sync project_settings for backward compat ──
    await supabase
      .from("project_settings")
      .upsert({
        project_id,
        org_id: project.organization_id,
        target_column,
        problem_type: problem_type || null,
        feature_columns: selected_features || [],
        excluded_columns: excluded_features || [],
      }, { onConflict: "project_id" });

    return new Response(JSON.stringify({
      success: true,
      selection_version: newVersion,
      target_hash: targetHash,
      target_column,
      stale_datasets_count: staleCount,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[upsert-model-selection] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
