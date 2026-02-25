import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(
        JSON.stringify({ success: false, error: "project_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`[repair-dataset-activation] Starting for project=${project_id}`);

    // 1. Check current state
    const [settingsRes, datasetStateRes] = await Promise.all([
      supabase
        .from("project_settings")
        .select("ingestion_state, ingestion_rows_detected, ingestion_cols_detected, ingestion_source_type, ingestion_manifest_id, ingestion_dataset_id, org_id")
        .eq("project_id", project_id)
        .maybeSingle(),
      supabase
        .from("project_dataset_state")
        .select("project_id, row_count, col_count")
        .eq("project_id", project_id)
        .maybeSingle(),
    ]);

    const settings = settingsRes.data as any;
    const datasetState = datasetStateRes.data as any;

    if (!settings) {
      return new Response(
        JSON.stringify({ success: false, repaired: false, reason: "PROJECT_NOT_FOUND" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. If ingestion not done, nothing to repair
    if (settings.ingestion_state !== "done") {
      return new Response(
        JSON.stringify({ success: true, repaired: false, reason: "INGESTION_NOT_DONE", ingestion_state: settings.ingestion_state }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. If dataset_state already exists with valid data, no repair needed
    if (datasetState && datasetState.row_count > 0 && datasetState.col_count > 0) {
      return new Response(
        JSON.stringify({ success: true, repaired: false, reason: "ALREADY_VALID", row_count: datasetState.row_count, col_count: datasetState.col_count }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Gather best available row/col counts
    let rowCount = settings.ingestion_rows_detected || 0;
    let colCount = settings.ingestion_cols_detected || 0;
    const sourceType = settings.ingestion_source_type || "upload";

    // Fallback: check project_columns count
    if (colCount === 0) {
      const { count } = await supabase
        .from("project_columns")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project_id);
      if (count && count > 0) colCount = count;
    }

    // Fallback: check projects table
    if (rowCount === 0 || colCount === 0) {
      const { data: proj } = await supabase
        .from("projects")
        .select("dataset_rows, dataset_columns, total_rows")
        .eq("id", project_id)
        .maybeSingle();
      if (proj) {
        if (rowCount === 0) rowCount = (proj as any).total_rows || (proj as any).dataset_rows || 0;
        if (colCount === 0) colCount = (proj as any).dataset_columns || 0;
      }
    }

    // Fallback: check import_manifests
    if (rowCount === 0 || colCount === 0) {
      const { data: manifest } = await supabase
        .from("import_manifests")
        .select("rows_consolidated, columns_final")
        .eq("project_id", project_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (manifest) {
        if (rowCount === 0) rowCount = manifest.rows_consolidated || 0;
        if (colCount === 0) colCount = manifest.columns_final || 0;
      }
    }

    // Fallback: check project_ingestion_manifests
    if (rowCount === 0 || colCount === 0) {
      const { data: ingManifest } = await supabase
        .from("project_ingestion_manifests")
        .select("row_count, col_count")
        .eq("project_id", project_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ingManifest) {
        if (rowCount === 0) rowCount = (ingManifest as any).row_count || 0;
        if (colCount === 0) colCount = (ingManifest as any).col_count || 0;
      }
    }

    if (rowCount === 0 || colCount === 0) {
      console.warn(`[repair-dataset-activation] Cannot repair: rows=${rowCount}, cols=${colCount}`);
      return new Response(
        JSON.stringify({ success: true, repaired: false, reason: "INSUFFICIENT_DATA", row_count: rowCount, col_count: colCount }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Create/update project_dataset_state
    const { error: upsertErr } = await supabase
      .from("project_dataset_state")
      .upsert(
        {
          project_id,
          organization_id: settings.org_id,
          source_type: sourceType,
          row_count: rowCount,
          col_count: colCount,
          eda_ready: false,
          model_ready: false,
          manifest_id: settings.ingestion_manifest_id || null,
          active_dataset_ref: settings.ingestion_dataset_id || settings.ingestion_manifest_id || project_id,
          virtual_manifest: !settings.ingestion_manifest_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id" }
      );

    if (upsertErr) {
      console.error("[repair-dataset-activation] Upsert error:", upsertErr);
      return new Response(
        JSON.stringify({ success: false, repaired: false, reason: "UPSERT_ERROR", error: upsertErr.message }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Also update project_settings with row/col if they were missing
    if (!settings.ingestion_rows_detected || !settings.ingestion_cols_detected) {
      await supabase
        .from("project_settings")
        .update({
          ingestion_rows_detected: rowCount,
          ingestion_cols_detected: colCount,
          updated_at: new Date().toISOString(),
        })
        .eq("project_id", project_id);
    }

    console.log(`[repair-dataset-activation] Repaired: rows=${rowCount}, cols=${colCount}, source=${sourceType}`);

    return new Response(
      JSON.stringify({
        success: true,
        repaired: true,
        reason: "DATASET_STATE_CREATED",
        row_count: rowCount,
        col_count: colCount,
        source_type: sourceType,
        virtual_manifest: !settings.ingestion_manifest_id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[repair-dataset-activation] Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
