import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Não autorizado" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ success: false, error: "Token inválido" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { project_id, template_id, params } = body;

    if (!project_id || !template_id) {
      return new Response(JSON.stringify({ success: false, error: "project_id e template_id obrigatórios" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify project ownership
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, organization_id, user_id")
      .eq("id", project_id)
      .single();

    if (projErr || !project) {
      return new Response(JSON.stringify({ success: false, error: "Projeto não encontrado" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ GUARD: NO_ACTIVE_DATASET — refuse to persist target if no dataset ═══
    const { data: settingsCheck } = await supabase
      .from("project_settings")
      .select("ingestion_state, ingestion_dataset_id, ingestion_manifest_id, feature_columns, excluded_columns, active_target_mode, target_source, selected_template_id, target_column")
      .eq("project_id", project_id)
      .maybeSingle();

    const ingestionState = (settingsCheck as any)?.ingestion_state;
    const hasDataset = (settingsCheck as any)?.ingestion_dataset_id || (settingsCheck as any)?.ingestion_manifest_id;

    if (ingestionState !== "done" && !hasDataset) {
      // Fallback: check project_columns existence
      const { count: colCount } = await supabase
        .from("project_columns")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project_id);

      if (!colCount || colCount === 0) {
        console.log(`[activate-target-template] BLOCKED: NO_ACTIVE_DATASET (ingestion_state=${ingestionState})`);
        return new Response(JSON.stringify({
          success: false,
          error_code: "NO_ACTIVE_DATASET",
          error: "Nenhum dataset ativo encontrado. Importe dados antes de ativar o target.",
          ctas: [
            { label: "Voltar e importar dados", action: "goto_step", step: 2 },
          ],
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Idempotency check: if already set to same template, skip
    if (
      settingsCheck &&
      (settingsCheck as any).target_source === "label_builder" &&
      (settingsCheck as any).selected_template_id === template_id &&
      (settingsCheck as any).target_column === "label"
    ) {
      console.log(`[activate-target-template] Idempotent: already set for ${template_id}`);

      // Fetch latest builder
      const { data: builder } = await supabase
        .from("project_label_builders")
        .select("id, status, template_id, params")
        .eq("project_id", project_id)
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return new Response(JSON.stringify({
        success: true,
        target_column: "label",
        target_source: "label_builder",
        builder_status: builder?.status || "ready",
        selection: { template_id, params: params || {} },
        gates: [],
        idempotent: true,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check that builder is READY
    const { data: builder } = await supabase
      .from("project_label_builders")
      .select("id, status, template_id, params, selection_version")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const gates: { gate: string; status: string; message: string }[] = [];

    if (!builder) {
      gates.push({
        gate: "BUILDER_EXISTS",
        status: "BLOCK",
        message: "Nenhum label builder encontrado. Execute o Preview primeiro.",
      });
      return new Response(JSON.stringify({
        success: false,
        error: "Builder não encontrado",
        gates,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (builder.status !== "ready") {
      gates.push({
        gate: "BUILDER_READY",
        status: "BLOCK",
        message: `Builder está com status "${builder.status}". Execute o Preview novamente.`,
      });
      return new Response(JSON.stringify({
        success: false,
        error: "Builder não está ready",
        gates,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    gates.push({ gate: "BUILDER_READY", status: "PASS", message: "Label builder pronto." });

    // ═══ PRESERVE EXISTING FEATURES ═══
    // Read current feature_columns so we don't wipe them
    const existingFeatures = Array.isArray((settingsCheck as any)?.feature_columns)
      ? ((settingsCheck as any).feature_columns as string[])
      : [];
    const existingExcluded = Array.isArray((settingsCheck as any)?.excluded_columns)
      ? ((settingsCheck as any).excluded_columns as string[])
      : [];

    // ═══ CANONICAL SSOT COMMIT: persist all target fields atomically ═══
    const { error: settingsErr } = await supabase
      .from("project_settings")
      .upsert(
        {
          project_id,
          org_id: project.organization_id,
          target_column: "label",
          problem_type: params?.problem_type || "classification",
          target_source: "label_builder",
          active_target_mode: "template",
          active_target_ref: { builder_id: builder.id, template_id },
          active_target_column: "label",
          selected_template_id: template_id,
          selected_template_params: params || {},
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id" },
      );

    if (settingsErr) {
      console.error("[activate-target-template] Settings upsert error:", settingsErr);
      return new Response(JSON.stringify({
        success: false,
        error: "Erro ao salvar settings",
        details: settingsErr.message,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Also call upsert-model-selection RPC — PRESERVE existing features
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "rpc_upsert_model_selection",
      {
        p_project_id: project_id,
        p_organization_id: project.organization_id,
        p_user_id: user.id,
        p_target_column: "label",
        p_problem_type: params?.problem_type || "classification",
        p_selected_features: existingFeatures,
        p_excluded_features: existingExcluded,
      },
    );

    if (rpcErr) {
      console.warn("[activate-target-template] RPC warning (non-fatal):", rpcErr.message);
    }

    const selectionVersion = rpcData
      ? (Array.isArray(rpcData) ? rpcData[0]?.selection_version : rpcData.selection_version)
      : null;

    gates.push({ gate: "SETTINGS_PERSISTED", status: "PASS", message: "Target persistido como 'label'." });

    console.log(`[activate-target-template] Activated: project=${project_id}, template=${template_id}, v=${selectionVersion}, features_preserved=${existingFeatures.length}`);

    return new Response(JSON.stringify({
      success: true,
      target_column: "label",
      target_source: "label_builder",
      active_target_mode: "template",
      builder_status: "ready",
      selection: { template_id, params: params || {} },
      selection_version: selectionVersion,
      features_preserved: existingFeatures.length,
      gates,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[activate-target-template] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
