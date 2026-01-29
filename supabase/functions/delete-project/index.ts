import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Get auth header to identify user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Autenticação necessária" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create client with user's token for RLS
    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    // Create admin client for storage operations and cascade deletes
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ success: false, error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Starting deletion for project: ${project_id}`);

    // 1. Verify user owns this project (RLS will enforce this)
    const { data: project, error: projectError } = await supabaseUser
      .from("projects")
      .select("id, user_id, dataset_filename, organization_id")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      console.error(`[delete-project] Project not found or access denied:`, projectError);
      return new Response(
        JSON.stringify({ success: false, error: "Projeto não encontrado ou sem permissão" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Project found, user_id: ${project.user_id}, proceeding with deletion`);

    // Use admin client for all deletions to bypass RLS and ensure complete cleanup
    // This is safe because we already verified ownership above

    // 2. Get model IDs for this project to delete related tables
    const { data: models } = await supabaseAdmin
      .from("project_models")
      .select("id")
      .eq("project_id", project_id);

    const modelIds = models?.map((m) => m.id) || [];
    console.log(`[delete-project] Found ${modelIds.length} models to delete`);

    // 3. Delete all related data in correct order (child tables first)
    
    // Delete feature importances (depends on project_models)
    if (modelIds.length > 0) {
      const { error: fiError } = await supabaseAdmin
        .from("project_feature_importances")
        .delete()
        .in("project_model_id", modelIds);
      if (fiError) console.warn(`[delete-project] Error deleting feature importances:`, fiError);
      else console.log(`[delete-project] Deleted feature importances`);

      // Delete model metrics (depends on project_models)
      const { error: mmError } = await supabaseAdmin
        .from("project_model_metrics")
        .delete()
        .in("project_model_id", modelIds);
      if (mmError) console.warn(`[delete-project] Error deleting model metrics:`, mmError);
      else console.log(`[delete-project] Deleted model metrics`);

      // Delete model insights (depends on project_models)
      const { error: miError } = await supabaseAdmin
        .from("project_model_insights")
        .delete()
        .in("model_id", modelIds);
      if (miError) console.warn(`[delete-project] Error deleting model insights (by model_id):`, miError);
    }

    // Delete project_model_insights by project_id (some may not have model_id)
    const { error: pmiError } = await supabaseAdmin
      .from("project_model_insights")
      .delete()
      .eq("project_id", project_id);
    if (pmiError) console.warn(`[delete-project] Error deleting model insights (by project_id):`, pmiError);
    else console.log(`[delete-project] Deleted model insights`);

    // Delete prediction schedules (depends on project_models)
    const { error: psError } = await supabaseAdmin
      .from("project_prediction_schedules")
      .delete()
      .eq("project_id", project_id);
    if (psError) console.warn(`[delete-project] Error deleting prediction schedules:`, psError);
    else console.log(`[delete-project] Deleted prediction schedules`);

    // Delete models
    const { error: modelsError } = await supabaseAdmin
      .from("project_models")
      .delete()
      .eq("project_id", project_id);
    if (modelsError) console.warn(`[delete-project] Error deleting models:`, modelsError);
    else console.log(`[delete-project] Deleted models`);

    // Delete chat messages
    const { error: chatError } = await supabaseAdmin
      .from("project_chat_messages")
      .delete()
      .eq("project_id", project_id);
    if (chatError) console.warn(`[delete-project] Error deleting chat messages:`, chatError);
    else console.log(`[delete-project] Deleted chat messages`);

    // Delete EDA stats
    const { error: numericError } = await supabaseAdmin
      .from("project_numeric_stats")
      .delete()
      .eq("project_id", project_id);
    if (numericError) console.warn(`[delete-project] Error deleting numeric stats:`, numericError);

    const { error: catError } = await supabaseAdmin
      .from("project_categorical_stats")
      .delete()
      .eq("project_id", project_id);
    if (catError) console.warn(`[delete-project] Error deleting categorical stats:`, catError);
    else console.log(`[delete-project] Deleted EDA stats`);

    // Delete columns
    const { error: colsError } = await supabaseAdmin
      .from("project_columns")
      .delete()
      .eq("project_id", project_id);
    if (colsError) console.warn(`[delete-project] Error deleting columns:`, colsError);
    else console.log(`[delete-project] Deleted columns`);

    // Delete EDA insights
    const { error: edaInsightsError } = await supabaseAdmin
      .from("project_eda_insights")
      .delete()
      .eq("project_id", project_id);
    if (edaInsightsError) console.warn(`[delete-project] Error deleting EDA insights:`, edaInsightsError);
    else console.log(`[delete-project] Deleted EDA insights`);

    // Delete predictions
    const { error: predictionsError } = await supabaseAdmin
      .from("predictions")
      .delete()
      .eq("project_id", project_id);
    if (predictionsError) console.warn(`[delete-project] Error deleting predictions:`, predictionsError);
    else console.log(`[delete-project] Deleted predictions`);

    // Delete export jobs
    const { error: exportError } = await supabaseAdmin
      .from("export_jobs")
      .delete()
      .eq("project_id", project_id);
    if (exportError) console.warn(`[delete-project] Error deleting export jobs:`, exportError);
    else console.log(`[delete-project] Deleted export jobs`);

    // Delete import jobs
    const { error: importError } = await supabaseAdmin
      .from("import_jobs")
      .delete()
      .eq("project_id", project_id);
    if (importError) console.warn(`[delete-project] Error deleting import jobs:`, importError);
    else console.log(`[delete-project] Deleted import jobs`);

    // Delete project datasets
    const { error: datasetsError } = await supabaseAdmin
      .from("project_datasets")
      .delete()
      .eq("project_id", project_id);
    if (datasetsError) console.warn(`[delete-project] Error deleting datasets:`, datasetsError);
    else console.log(`[delete-project] Deleted datasets`);

    // Delete project features
    const { error: featuresError } = await supabaseAdmin
      .from("project_features")
      .delete()
      .eq("project_id", project_id);
    if (featuresError) console.warn(`[delete-project] Error deleting features:`, featuresError);
    else console.log(`[delete-project] Deleted features`);

    // Delete business config
    const { error: bizConfigError } = await supabaseAdmin
      .from("project_business_config")
      .delete()
      .eq("project_id", project_id);
    if (bizConfigError) console.warn(`[delete-project] Error deleting business config:`, bizConfigError);
    else console.log(`[delete-project] Deleted business config`);

    // Delete project actions
    const { error: actionsError } = await supabaseAdmin
      .from("project_actions")
      .delete()
      .eq("project_id", project_id);
    if (actionsError) console.warn(`[delete-project] Error deleting actions:`, actionsError);
    else console.log(`[delete-project] Deleted actions`);

    // Delete data ingestion logs
    const { error: ingestionError } = await supabaseAdmin
      .from("project_data_ingestion_logs")
      .delete()
      .eq("project_id", project_id);
    if (ingestionError) console.warn(`[delete-project] Error deleting ingestion logs:`, ingestionError);
    else console.log(`[delete-project] Deleted ingestion logs`);

    // Delete platform events (set project_id to null instead of deleting for analytics)
    const { error: eventsError } = await supabaseAdmin
      .from("platform_events")
      .update({ project_id: null })
      .eq("project_id", project_id);
    if (eventsError) console.warn(`[delete-project] Error updating platform events:`, eventsError);
    else console.log(`[delete-project] Cleared platform events reference`);

    // Delete audit logs (set project_id to null instead of deleting for compliance)
    const { error: auditError } = await supabaseAdmin
      .from("audit_logs")
      .update({ project_id: null })
      .eq("project_id", project_id);
    if (auditError) console.warn(`[delete-project] Error updating audit logs:`, auditError);
    else console.log(`[delete-project] Cleared audit logs reference`);

    // 4. Delete dataset file from storage if exists
    if (project.dataset_filename) {
      console.log(`[delete-project] Deleting dataset file: ${project.dataset_filename}`);
      const { error: storageError } = await supabaseAdmin.storage
        .from("datasets")
        .remove([project.dataset_filename]);
      if (storageError) {
        console.warn(`[delete-project] Error deleting storage file:`, storageError);
      } else {
        console.log(`[delete-project] Deleted storage file`);
      }
    }

    // 5. Finally delete the project itself using admin client
    const { error: deleteError } = await supabaseAdmin
      .from("projects")
      .delete()
      .eq("id", project_id);

    if (deleteError) {
      console.error(`[delete-project] Error deleting project:`, deleteError);
      return new Response(
        JSON.stringify({ success: false, error: "Erro ao excluir projeto: " + deleteError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Project ${project_id} deleted successfully`);

    return new Response(
      JSON.stringify({ success: true, message: "Projeto excluído com sucesso" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error(`[delete-project] Unexpected error:`, error);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno ao excluir projeto" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
