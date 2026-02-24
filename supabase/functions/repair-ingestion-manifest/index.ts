import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Auto-repair edge function: rebuilds manifest for projects where
 * ingestion_state='done' but ingestion_manifest_id IS NULL.
 * 
 * Called by StepEDA / Preflight when manifest is missing.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(JSON.stringify({ success: false, error: "project_id required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    console.log(`[repair-manifest] Starting repair for project ${project_id}`);

    // 1) Check current state
    const { data: settings } = await supabase
      .from("project_settings")
      .select("ingestion_state, ingestion_manifest_id, ingestion_source_type, ingestion_rows_detected, ingestion_cols_detected, ingestion_total_bytes, ingestion_source_config_hash, ingestion_dataset_id")
      .eq("project_id", project_id)
      .maybeSingle();

    if (!settings) {
      return new Response(JSON.stringify({ success: false, error: "PROJECT_NOT_FOUND" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    // If manifest already exists, nothing to do
    if (settings.ingestion_manifest_id) {
      // Verify manifest row actually exists
      const { data: manifestRow } = await supabase
        .from("project_ingestion_manifests")
        .select("id")
        .eq("id", settings.ingestion_manifest_id)
        .maybeSingle();

      if (manifestRow) {
        return new Response(JSON.stringify({
          success: true, status: "ALREADY_HAS_MANIFEST",
          manifest_id: settings.ingestion_manifest_id,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
      }
      // Manifest ID set but row missing — need to rebuild
      console.warn(`[repair-manifest] Manifest ID ${settings.ingestion_manifest_id} set but row missing. Rebuilding...`);
    }

    // 2) Try to reconstruct schema from project_columns
    const { data: columns } = await supabase
      .from("project_columns")
      .select("column_name, inferred_type, column_index")
      .eq("project_id", project_id)
      .order("column_index", { ascending: true });

    if (!columns || columns.length === 0) {
      // Cannot repair — no columns available
      console.error(`[repair-manifest] No columns found for project ${project_id}. Marking as failed.`);

      await supabase
        .from("project_settings")
        .update({
          ingestion_state: "failed",
          ingestion_error_code: "MANIFEST_MISSING",
          ingestion_error_message: "Manifest ausente e schema não disponível para reconstrução. Reimporte os dados.",
          updated_at: new Date().toISOString(),
        })
        .eq("project_id", project_id);

      return new Response(JSON.stringify({
        success: false,
        error: "MANIFEST_MISSING",
        message: "Não foi possível reconstruir o manifest. Reimporte os dados.",
        ctas: [{ label: "Reimportar", action: "retry_ingestion" }],
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // 3) Build schema for manifest
    const schemaJson = columns.map(c => ({
      name: c.column_name,
      type: c.inferred_type,
      index: c.column_index,
    }));

    const rowCount = settings.ingestion_rows_detected || 0;
    const colCount = columns.length;

    if (rowCount <= 0) {
      // Try to get from project
      const { data: proj } = await supabase
        .from("projects")
        .select("total_rows")
        .eq("id", project_id)
        .maybeSingle();

      if (!proj?.total_rows || proj.total_rows <= 0) {
        await supabase
          .from("project_settings")
          .update({
            ingestion_state: "failed",
            ingestion_error_code: "EMPTY_DATASET",
            ingestion_error_message: "Dataset vazio (0 linhas). Reimporte os dados.",
            updated_at: new Date().toISOString(),
          })
          .eq("project_id", project_id);

        return new Response(JSON.stringify({
          success: false, error: "EMPTY_DATASET",
          message: "Dataset sem linhas detectadas.",
          ctas: [{ label: "Reimportar", action: "retry_ingestion" }],
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
      }
    }

    const effectiveRowCount = rowCount > 0 ? rowCount : (
      await supabase.from("projects").select("total_rows").eq("id", project_id).maybeSingle()
    ).data?.total_rows || 0;

    // 4) Build source pointer from available info
    const sourcePointer: Record<string, unknown> = {
      repaired: true,
      repaired_at: new Date().toISOString(),
      source_type: settings.ingestion_source_type || "upload",
    };

    // Try to get storage path from project_datasets
    const { data: dataset } = await supabase
      .from("project_datasets")
      .select("id, storage_path, source_metadata")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .maybeSingle();

    if (dataset) {
      sourcePointer.storage_path = dataset.storage_path;
      sourcePointer.dataset_id = dataset.id;
      if (dataset.source_metadata) {
        sourcePointer.source_metadata = dataset.source_metadata;
      }
    }

    // 5) Call rpc_finalize_ingestion to atomically create manifest + set state
    const { data: result, error: rpcError } = await supabase.rpc("rpc_finalize_ingestion", {
      p_project_id: project_id,
      p_source_type: settings.ingestion_source_type || "upload",
      p_config_hash: settings.ingestion_source_config_hash || null,
      p_dataset_id: settings.ingestion_dataset_id || dataset?.id || null,
      p_source_pointer: sourcePointer,
      p_schema_json: schemaJson,
      p_row_count: effectiveRowCount,
      p_col_count: colCount,
      p_total_bytes: settings.ingestion_total_bytes || 0,
      p_sample_strategy: { method: "repair", repaired_at: new Date().toISOString() },
      p_file_count: 1,
    });

    if (rpcError) {
      console.error(`[repair-manifest] rpc_finalize_ingestion error:`, rpcError);
      return new Response(JSON.stringify({
        success: false, error: "RPC_ERROR", message: rpcError.message,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    const res = result as Record<string, unknown>;
    console.log(`[repair-manifest] Repair complete: manifest=${res.manifest_id}, v${res.dataset_version}`);

    return new Response(JSON.stringify({
      success: true,
      status: "REPAIRED",
      manifest_id: res.manifest_id,
      dataset_version: res.dataset_version,
      rows: effectiveRowCount,
      cols: colCount,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });

  } catch (error) {
    console.error("[repair-manifest] Error:", error);
    return new Response(JSON.stringify({
      success: false, error: "UNKNOWN",
      message: error instanceof Error ? error.message : "Erro desconhecido",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
  }
});
