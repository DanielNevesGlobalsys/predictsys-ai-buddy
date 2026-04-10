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

    // ═══ Canonical problem_type normalization ═══════════════════════
    const ALLOWED_PROBLEM_TYPES = ["classification", "regression", "multiclass", "segmentation", "ranking"] as const;
    type CanonicalProblemType = typeof ALLOWED_PROBLEM_TYPES[number];

    const PROBLEM_TYPE_ALIASES: Record<string, CanonicalProblemType> = {
      // Portuguese labels
      "classificação binária": "classification",
      "classificação": "classification",
      "classificacao binaria": "classification",
      "classificacao": "classification",
      "regressão": "regression",
      "regressao": "regression",
      "classificação multiclasse": "multiclass",
      "classificacao multiclasse": "multiclass",
      "segmentação": "segmentation",
      "segmentacao": "segmentation",
      "segmentação / agrupamento": "segmentation",
      "ranking / priorização": "ranking",
      "ranking": "ranking",
      // English aliases
      "binary": "classification",
      "binary_classification": "classification",
      "multiclass_classification": "multiclass",
      "multiclass": "multiclass",
      "classification": "classification",
      "regression": "regression",
      "segmentation": "segmentation",
      "continuous": "regression",
      "clustering": "segmentation",
    };

    function normalizeProblemType(raw: string | null | undefined): CanonicalProblemType {
      if (!raw) return "classification";
      const key = raw.trim().toLowerCase();
      if (ALLOWED_PROBLEM_TYPES.includes(key as CanonicalProblemType)) return key as CanonicalProblemType;
      return PROBLEM_TYPE_ALIASES[key] || "classification";
    }

    const body = await req.json();
    const {
      project_id,
      target_column,
      problem_type: rawProblemType,
      selected_features,
      excluded_features,
      entity_key,
      time_column,
      dataset_build_mode,
    } = body;

    const problem_type = normalizeProblemType(rawProblemType);

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
      `[upsert-model-selection] project=${project_id}, target=${target_column}, problem_type_raw="${rawProblemType}" → normalized="${problem_type}", user=${user.id}`,
    );

    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "rpc_upsert_model_selection",
      {
        p_project_id: project_id,
        p_organization_id: project.organization_id,
        p_user_id: user.id,
        p_target_column: target_column,
        p_problem_type: problem_type,
        p_selected_features: selected_features || [],
        p_excluded_features: excluded_features || [],
      },
    );

    if (rpcErr || !rpcData || (Array.isArray(rpcData) && rpcData.length === 0)) {
      console.error("[upsert-model-selection] RPC error:", rpcErr);
      const isConstraintViolation = rpcErr?.code === "23514";
      return new Response(
        JSON.stringify({
          success: false,
          error: isConstraintViolation ? "invalid_problem_type" : "rpc_error",
          message: isConstraintViolation
            ? `Valor de problem_type inválido: "${rawProblemType}" (normalizado: "${problem_type}"). Valores aceitos: ${ALLOWED_PROBLEM_TYPES.join(", ")}`
            : "Erro ao salvar seleção (RPC)",
          details: rpcErr?.message,
          incoming_value: rawProblemType,
          normalized_value: problem_type,
          allowed_values: ALLOWED_PROBLEM_TYPES,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
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

    // ── Sync selection_version + features to project_settings ──
    // IMPORTANT: Do NOT overwrite target_source or active_target_mode here.
    // Those fields are set by the calling context (IntentTargetSummary, TargetBuilder, etc.)
    // and overwriting them with stale values causes pipeline misalignment.
    const settingsUpsert: Record<string, any> = {
      project_id,
      org_id: project.organization_id,
      target_column,
      problem_type: problem_type || null,
      feature_columns: selected_features || [],
      excluded_columns: excluded_features || [],
      selection_version: newVersion,
      target_state: target_column ? "ready" : "draft",
      active_target_column: target_column,
      // GOVERNANCE: Set official fields on explicit promotion
      official_target: target_column,
      official_problem_type: problem_type || null,
      official_entity_key: entity_key || null,
      official_time_column: time_column || null,
      // Clear governance conflict on explicit save
      governance_conflict: false,
      governance_conflict_details: null,
      last_governance_action: "explicit_promotion",
      last_governance_action_at: new Date().toISOString(),
    };
    const isAggregatedTarget = dataset_build_mode === "temporal_aggregated" || /^agg_/i.test(target_column || "");

    // Persist entity_key and time_column if provided
    if (entity_key !== undefined && entity_key !== null) {
      settingsUpsert.entity_key = entity_key;
    }
    if (time_column !== undefined && time_column !== null) {
      settingsUpsert.time_anchor_column = time_column;
      settingsUpsert.recommended_time_column = time_column;
    }
    if (entity_key && time_column) {
      settingsUpsert.recommended_grain = "entity_time";
      settingsUpsert.recommended_split_strategy = "temporal";
      settingsUpsert.dataset_build_mode = isAggregatedTarget ? "temporal_aggregated" : (dataset_build_mode || "entity_time");
      settingsUpsert.official_grain = "entity_time";
    }

    await supabase
      .from("project_settings")
      .upsert(settingsUpsert, { onConflict: "project_id" });

    // ── SSOT: Mark downstream stages as stale when selection changes ──
    if (didChange) {
      // Reset builder + training + scoring + dashboard to prevent stale states
      await Promise.all([
        supabase.rpc("rpc_update_pipeline_state", {
          p_project_id: project_id,
          p_stage: "builder",
          p_new_state: "draft",
        }),
        supabase.rpc("rpc_update_pipeline_state", {
          p_project_id: project_id,
          p_stage: "training",
          p_new_state: "idle",
        }),
        supabase.rpc("rpc_update_pipeline_state", {
          p_project_id: project_id,
          p_stage: "scoring",
          p_new_state: "idle",
        }),
        supabase.rpc("rpc_update_pipeline_state", {
          p_project_id: project_id,
          p_stage: "dashboard",
          p_new_state: "idle",
        }),
      ]);
    }

    // ── Auto-generate/update modeling contract with entity/time/grain ──
    if (didChange) {
      const grainVal = entity_key && time_column ? "entity_time" : "original_row";
      const splitVal = time_column ? "temporal" : "stratified";
      const buildMode = isAggregatedTarget ? "temporal_aggregated" : entity_key && time_column ? "entity_time" : "row_level";

      const contractPayload = {
        project_id,
        organization_id: project.organization_id,
        version: 3,
        intent_contract_id: null,
        entity_key: entity_key || null,
        anchor_time_col: time_column || null,
        split_strategy: splitVal,
        target_definition: {
          target_name: target_column,
          problem_type: problem_type,
          target_source: "column",
        },
        feature_plan: {
          include_features: selected_features || [],
          exclude_features: excluded_features || [],
        },
        dataset_build_mode: buildMode,
        grain: grainVal,
        selection_version: newVersion,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await supabase.from("project_modeling_contracts").insert(contractPayload as any);
      console.log(`[upsert-model-selection] Modeling contract v3 created: grain=${grainVal}, split=${splitVal}, time=${time_column || "none"}, entity=${entity_key || "none"}`);
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
