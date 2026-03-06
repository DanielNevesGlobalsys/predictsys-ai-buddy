import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { import_run_id, project_id } = await req.json();
    if (!import_run_id || !project_id) {
      return new Response(JSON.stringify({ success: false, error: "import_run_id and project_id required" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
    }

    console.log(`[promote-staging] Starting for import_run=${import_run_id}, project=${project_id}`);

    // 1. Get staged import objects
    const { data: importObjects, error: objErr } = await supabase
      .from("external_import_objects")
      .select("*")
      .eq("import_run_id", import_run_id)
      .eq("project_id", project_id)
      .in("status", ["staged", "promoted"]);

    if (objErr) throw objErr;
    if (!importObjects || importObjects.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "NO_STAGED_OBJECTS", message: "Nenhum objeto staged encontrado para promoção." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // 2. Validate each object: file exists in storage
    const validObjects = [];
    const errors = [];

    for (const obj of importObjects) {
      if (obj.status === "promoted" && obj.dataset_id) {
        // Already promoted - skip
        continue;
      }

      if (!obj.storage_path) {
        errors.push({ object: obj.object_name, error: "MISSING_STORAGE_PATH" });
        continue;
      }

      // Check file exists
      const { data: fileData } = await supabase.storage.from("datasets").list(
        obj.storage_path.split("/").slice(0, -1).join("/"),
        { search: obj.storage_path.split("/").pop() || "" }
      );

      if (!fileData || fileData.length === 0) {
        errors.push({ object: obj.object_name, error: "FILE_NOT_FOUND", path: obj.storage_path });
        continue;
      }

      validObjects.push(obj);
    }

    if (validObjects.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "NO_VALID_OBJECTS", errors }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // 3. Get project info
    const { data: projectData } = await supabase
      .from("projects")
      .select("user_id, organization_id")
      .eq("id", project_id)
      .single();

    if (!projectData) {
      return new Response(JSON.stringify({ success: false, error: "PROJECT_NOT_FOUND" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // 4. Deactivate previous datasets
    await supabase.from("project_datasets").update({ is_active: false }).eq("project_id", project_id);

    // 5. Promote each valid object
    const promoted = [];
    for (const obj of validObjects) {
      // Get the import run for connector type context
      const { data: importRun } = await supabase
        .from("external_import_runs")
        .select("connection_id")
        .eq("id", import_run_id)
        .single();

      let connectorType = "external";
      if (importRun) {
        const { data: conn } = await supabase
          .from("external_connections")
          .select("connector_type")
          .eq("id", importRun.connection_id)
          .single();
        if (conn) connectorType = conn.connector_type;
      }

      // Create dataset
      const { data: dataset, error: dsErr } = await supabase
        .from("project_datasets")
        .insert({
          project_id,
          user_id: projectData.user_id,
          name: `${obj.object_name} (${connectorType})`,
          storage_path: obj.storage_path,
          source_type: "cloud",
          total_rows: obj.rows_imported || 0,
          sample_rows: Math.min(obj.rows_imported || 0, 100000),
          columns_count: obj.columns_imported || 0,
          file_size_bytes: obj.file_size_bytes || 0,
          is_active: true,
          source_metadata: {
            connector_type: connectorType,
            object_name: obj.object_name,
            import_run_id,
            promoted_by: "admin",
            promoted_at: new Date().toISOString(),
            delimiter: ";",
            encoding: "UTF-8",
          },
        })
        .select()
        .single();

      if (dsErr) {
        errors.push({ object: obj.object_name, error: dsErr.message });
        continue;
      }

      // Update import object status
      await supabase
        .from("external_import_objects")
        .update({ status: "promoted", dataset_id: dataset.id })
        .eq("id", obj.id);

      // Update project
      await supabase.from("projects").update({
        dataset_filename: obj.storage_path.split("/").pop(),
        total_rows: obj.rows_imported || 0,
        dataset_rows: Math.min(obj.rows_imported || 0, 100000),
        dataset_columns: obj.columns_imported || 0,
        status: "data_uploaded",
      }).eq("id", project_id);

      // SSOT: complete ingestion
      try {
        await supabase.rpc("rpc_complete_ingestion", {
          p_project_id: project_id,
          p_success: true,
          p_rows_detected: obj.rows_imported || 0,
          p_cols_detected: obj.columns_imported || 0,
          p_file_count: 1,
          p_total_bytes: obj.file_size_bytes || 0,
          p_dataset_id: dataset.id,
        });
      } catch { /* best effort */ }

      // Track event
      await supabase.from("platform_events").insert({
        event_type: "dataset_connected",
        project_id,
        status: "success",
        source: "admin",
        metadata: {
          action: "promote_staging",
          import_run_id,
          object_name: obj.object_name,
          dataset_id: dataset.id,
          connector_type: connectorType,
        },
      });

      promoted.push({ object_name: obj.object_name, dataset_id: dataset.id });
    }

    console.log(`[promote-staging] Promoted ${promoted.length} objects, ${errors.length} errors`);

    return new Response(
      JSON.stringify({
        success: promoted.length > 0,
        promoted_count: promoted.length,
        error_count: errors.length,
        promoted,
        errors,
        dataset_id: promoted[promoted.length - 1]?.dataset_id,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[promote-staging] Error:", msg);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  }
});
