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

    // Create admin client for storage operations
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
      .select("id, user_id, dataset_filename")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      console.error(`[delete-project] Project not found or access denied:`, projectError);
      return new Response(
        JSON.stringify({ success: false, error: "Projeto não encontrado ou sem permissão" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Project found, proceeding with deletion`);

    // 2. Delete related data in order (child tables first)
    
    // Delete chat messages
    const { error: chatError } = await supabaseUser
      .from("project_chat_messages")
      .delete()
      .eq("project_id", project_id);
    if (chatError) console.warn(`[delete-project] Error deleting chat messages:`, chatError);

    // Get model IDs for this project to delete related tables
    const { data: models } = await supabaseUser
      .from("project_models")
      .select("id")
      .eq("project_id", project_id);

    const modelIds = models?.map((m) => m.id) || [];

    if (modelIds.length > 0) {
      // Delete feature importances
      const { error: fiError } = await supabaseUser
        .from("project_feature_importances")
        .delete()
        .in("project_model_id", modelIds);
      if (fiError) console.warn(`[delete-project] Error deleting feature importances:`, fiError);

      // Delete model metrics
      const { error: mmError } = await supabaseUser
        .from("project_model_metrics")
        .delete()
        .in("project_model_id", modelIds);
      if (mmError) console.warn(`[delete-project] Error deleting model metrics:`, mmError);
    }

    // Delete models
    const { error: modelsError } = await supabaseUser
      .from("project_models")
      .delete()
      .eq("project_id", project_id);
    if (modelsError) console.warn(`[delete-project] Error deleting models:`, modelsError);

    // Delete EDA stats
    const { error: numericError } = await supabaseUser
      .from("project_numeric_stats")
      .delete()
      .eq("project_id", project_id);
    if (numericError) console.warn(`[delete-project] Error deleting numeric stats:`, numericError);

    const { error: catError } = await supabaseUser
      .from("project_categorical_stats")
      .delete()
      .eq("project_id", project_id);
    if (catError) console.warn(`[delete-project] Error deleting categorical stats:`, catError);

    // Delete columns
    const { error: colsError } = await supabaseUser
      .from("project_columns")
      .delete()
      .eq("project_id", project_id);
    if (colsError) console.warn(`[delete-project] Error deleting columns:`, colsError);

    // 3. Delete dataset file from storage if exists
    if (project.dataset_filename) {
      console.log(`[delete-project] Deleting dataset file: ${project.dataset_filename}`);
      const { error: storageError } = await supabaseAdmin.storage
        .from("datasets")
        .remove([project.dataset_filename]);
      if (storageError) {
        console.warn(`[delete-project] Error deleting storage file:`, storageError);
      }
    }

    // 4. Finally delete the project itself
    const { error: deleteError } = await supabaseUser
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
