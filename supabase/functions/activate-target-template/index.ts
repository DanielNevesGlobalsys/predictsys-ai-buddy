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

    // Idempotency check: if already set to same template, skip
    const { data: existingSettings } = await supabase
      .from("project_settings")
      .select("target_source, selected_template_id, target_column")
      .eq("project_id", project_id)
      .maybeSingle();

    if (
      existingSettings &&
      existingSettings.target_source === "label_builder" &&
      existingSettings.selected_template_id === template_id &&
      existingSettings.target_column === "label"
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

    // Persist target_column="label" via upsert on project_settings
    const { error: settingsErr } = await supabase
      .from("project_settings")
      .upsert(
        {
          project_id,
          org_id: project.organization_id,
          target_column: "label",
          problem_type: params?.problem_type || "classification",
          target_source: "label_builder",
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

    // Also call upsert-model-selection RPC to keep model_selection in sync
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "rpc_upsert_model_selection",
      {
        p_project_id: project_id,
        p_organization_id: project.organization_id,
        p_user_id: user.id,
        p_target_column: "label",
        p_problem_type: params?.problem_type || "classification",
        p_selected_features: [],
        p_excluded_features: [],
      },
    );

    if (rpcErr) {
      console.warn("[activate-target-template] RPC warning (non-fatal):", rpcErr.message);
    }

    const selectionVersion = rpcData
      ? (Array.isArray(rpcData) ? rpcData[0]?.selection_version : rpcData.selection_version)
      : null;

    gates.push({ gate: "SETTINGS_PERSISTED", status: "PASS", message: "Target persistido como 'label'." });

    console.log(`[activate-target-template] Activated: project=${project_id}, template=${template_id}, v=${selectionVersion}`);

    return new Response(JSON.stringify({
      success: true,
      target_column: "label",
      target_source: "label_builder",
      builder_status: "ready",
      selection: { template_id, params: params || {} },
      selection_version: selectionVersion,
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
