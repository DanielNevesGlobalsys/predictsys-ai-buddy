import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Batched delete helper: deletes in chunks to avoid statement timeout
async function batchDelete(
  supabase: any,
  table: string,
  filterCol: string,
  filterVal: string,
  batchSize = 1000,
): Promise<{ deleted: number; error: string | null }> {
  let totalDeleted = 0;
  let attempts = 0;
  const maxAttempts = 500; // safety cap

  while (attempts < maxAttempts) {
    attempts++;
    // Select a batch of IDs
    const { data: batch, error: selectError } = await supabase
      .from(table)
      .select("id")
      .eq(filterCol, filterVal)
      .limit(batchSize);

    if (selectError) {
      return { deleted: totalDeleted, error: selectError.message };
    }

    if (!batch || batch.length === 0) break;

    const ids = batch.map((r: any) => r.id);
    const { error: delError } = await supabase
      .from(table)
      .delete()
      .in("id", ids);

    if (delError) {
      return { deleted: totalDeleted, error: delError.message };
    }

    totalDeleted += ids.length;
    console.log(`[delete-project] ${table}: deleted batch of ${ids.length} (total: ${totalDeleted})`);

    if (ids.length < batchSize) break; // last batch
  }

  return { deleted: totalDeleted, error: null };
}

// Simple delete helper (for small tables)
async function safeDelete(supabase: any, table: string, col: string, val: string, label?: string) {
  const { error } = await supabase.from(table).delete().eq(col, val);
  if (error) console.warn(`[delete-project] Error deleting ${label || table}:`, error.message);
  else console.log(`[delete-project] Deleted ${label || table}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Autenticação necessária" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      db: { schema: "public" },
      global: { headers: { "x-supabase-postgres-config": "statement_timeout=120000" } },
    });

    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ success: false, error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Starting deletion for project: ${project_id}`);

    // 1. Verify user owns this project (RLS enforced)
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

    console.log(`[delete-project] Project found, user_id: ${project.user_id}, proceeding`);

    // 2. Get model IDs
    const { data: models } = await supabaseAdmin
      .from("project_models")
      .select("id")
      .eq("project_id", project_id);

    const modelIds = models?.map((m) => m.id) || [];
    console.log(`[delete-project] Found ${modelIds.length} models`);

    // 3. Delete model-dependent tables
    if (modelIds.length > 0) {
      const { error: fiError } = await supabaseAdmin
        .from("project_feature_importances")
        .delete()
        .in("project_model_id", modelIds);
      if (fiError) console.warn(`[delete-project] feature_importances:`, fiError.message);

      const { error: mmError } = await supabaseAdmin
        .from("project_model_metrics")
        .delete()
        .in("project_model_id", modelIds);
      if (mmError) console.warn(`[delete-project] model_metrics:`, mmError.message);

      const { error: miError } = await supabaseAdmin
        .from("project_model_insights")
        .delete()
        .in("model_id", modelIds);
      if (miError) console.warn(`[delete-project] model_insights by model_id:`, miError.message);
    }

    // 4. Delete project-level tables (small ones first)
    await safeDelete(supabaseAdmin, "project_model_insights", "project_id", project_id, "model_insights");
    await safeDelete(supabaseAdmin, "project_prediction_schedules", "project_id", project_id, "prediction_schedules");
    await safeDelete(supabaseAdmin, "project_models", "project_id", project_id, "models");
    await safeDelete(supabaseAdmin, "project_chat_messages", "project_id", project_id, "chat_messages");
    await safeDelete(supabaseAdmin, "project_numeric_stats", "project_id", project_id, "numeric_stats");
    await safeDelete(supabaseAdmin, "project_categorical_stats", "project_id", project_id, "categorical_stats");
    await safeDelete(supabaseAdmin, "project_columns", "project_id", project_id, "columns");
    await safeDelete(supabaseAdmin, "project_eda_insights", "project_id", project_id, "eda_insights");
    await safeDelete(supabaseAdmin, "project_eda_snapshots", "project_id", project_id, "eda_snapshots");
    await safeDelete(supabaseAdmin, "project_ai_context", "project_id", project_id, "ai_context");
    await safeDelete(supabaseAdmin, "project_ai_memory", "project_id", project_id, "ai_memory");
    await safeDelete(supabaseAdmin, "project_data_contract", "project_id", project_id, "data_contract");
    await safeDelete(supabaseAdmin, "project_features", "project_id", project_id, "features");
    await safeDelete(supabaseAdmin, "project_business_config", "project_id", project_id, "business_config");
    await safeDelete(supabaseAdmin, "project_actions", "project_id", project_id, "actions");
    await safeDelete(supabaseAdmin, "project_data_ingestion_logs", "project_id", project_id, "ingestion_logs");
    await safeDelete(supabaseAdmin, "export_jobs", "project_id", project_id, "export_jobs");

    // 5. Batched delete for PREDICTIONS (can be very large — millions of rows)
    console.log(`[delete-project] Starting batched predictions delete...`);
    const predResult = await batchDelete(supabaseAdmin, "predictions", "project_id", project_id, 2000);
    if (predResult.error) {
      console.warn(`[delete-project] predictions batch error: ${predResult.error}`);
    }
    console.log(`[delete-project] Deleted ${predResult.deleted} predictions total`);

    // 6. Delete import manifests, jobs, datasets
    await safeDelete(supabaseAdmin, "import_manifests", "project_id", project_id, "import_manifests");
    await safeDelete(supabaseAdmin, "import_jobs", "project_id", project_id, "import_jobs");
    await safeDelete(supabaseAdmin, "project_datasets", "project_id", project_id, "datasets");

    // 7. Unlink platform events & audit logs (preserve for analytics/compliance)
    const { error: eventsError } = await supabaseAdmin
      .from("platform_events")
      .update({ project_id: null })
      .eq("project_id", project_id);
    if (eventsError) console.warn(`[delete-project] platform_events:`, eventsError.message);

    const { error: auditError } = await supabaseAdmin
      .from("audit_logs")
      .update({ project_id: null })
      .eq("project_id", project_id);
    if (auditError) console.warn(`[delete-project] audit_logs:`, auditError.message);

    // 8. Storage cleanup
    if (project.dataset_filename) {
      const { error: storageError } = await supabaseAdmin.storage
        .from("datasets")
        .remove([project.dataset_filename]);
      if (storageError) console.warn(`[delete-project] storage datasets:`, storageError.message);
      else console.log(`[delete-project] Deleted dataset file`);
    }

    try {
      const userFolder = `${project.user_id}/${project_id}`;
      const { data: bigFiles } = await supabaseAdmin.storage
        .from("big_imports")
        .list(userFolder);
      if (bigFiles && bigFiles.length > 0) {
        const paths = bigFiles.map(f => `${userFolder}/${f.name}`);
        await supabaseAdmin.storage.from("big_imports").remove(paths);
        console.log(`[delete-project] Deleted ${paths.length} big_imports files`);
      }
    } catch (e) {
      console.warn(`[delete-project] big_imports cleanup error:`, e);
    }

    // 9. Finally delete the project
    const { error: deleteError } = await supabaseAdmin
      .from("projects")
      .delete()
      .eq("id", project_id);

    if (deleteError) {
      console.error(`[delete-project] Final delete error:`, deleteError);
      return new Response(
        JSON.stringify({ success: false, error: "Erro ao excluir projeto: " + deleteError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Project ${project_id} deleted successfully (${predResult.deleted} predictions removed)`);

    return new Response(
      JSON.stringify({ success: true, message: "Projeto excluído com sucesso", predictions_deleted: predResult.deleted }),
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
