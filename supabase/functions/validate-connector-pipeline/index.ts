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

    console.log(`[validate-pipeline] Starting for import_run=${import_run_id}, project=${project_id}`);

    // Create validation run record
    const { data: valRun, error: valErr } = await supabase
      .from("pipeline_validation_runs")
      .insert({ project_id, import_run_id, started_at: new Date().toISOString() })
      .select()
      .single();
    if (valErr) throw valErr;
    const valRunId = valRun.id;

    const details: Record<string, any> = {};
    let stagingValid = false;
    let metadataValid = false;
    let promotionValid = false;
    let schemaValid = false;
    let sampleValid = false;
    let edaValid = false;

    // ═══ ETAPA 1: STAGING ═══
    try {
      const { data: importObjs } = await supabase
        .from("external_import_objects")
        .select("*")
        .eq("import_run_id", import_run_id)
        .eq("project_id", project_id)
        .in("status", ["staged", "promoted"]);

      if (!importObjs || importObjs.length === 0) {
        details.staging = { error: "NO_STAGED_OBJECTS" };
      } else {
        const stagingChecks = [];
        for (const obj of importObjs) {
          const check: Record<string, any> = { object_name: obj.object_name, storage_path: obj.storage_path };
          
          if (!obj.storage_path) {
            check.error = "MISSING_STORAGE_PATH";
            stagingChecks.push(check);
            continue;
          }

          // Check file exists in storage
          const pathParts = obj.storage_path.split("/");
          const fileName = pathParts.pop() || "";
          const folder = pathParts.join("/");
          const { data: fileList } = await supabase.storage.from("datasets").list(folder, { search: fileName });
          
          if (!fileList || fileList.length === 0) {
            check.error = "FILE_NOT_FOUND";
          } else {
            const file = fileList[0];
            check.file_exists = true;
            check.file_size = file.metadata?.size || obj.file_size_bytes || 0;
            check.valid = (check.file_size > 0);
            if (check.file_size === 0) check.error = "EMPTY_FILE";
          }
          stagingChecks.push(check);
        }
        
        stagingValid = stagingChecks.every(c => c.valid === true);
        details.staging = { objects: stagingChecks, valid: stagingValid };
      }

      await logEvent(supabase, project_id, stagingValid ? "staging_validated" : "staging_validation_failed", { import_run_id, details: details.staging });
    } catch (e: any) {
      details.staging = { error: e.message };
      await logEvent(supabase, project_id, "staging_validation_failed", { import_run_id, error: e.message });
    }

    // ═══ ETAPA 2: METADATA ═══
    try {
      const { data: importRun } = await supabase
        .from("external_import_runs")
        .select("*")
        .eq("id", import_run_id)
        .single();

      const metaChecks: Record<string, boolean> = {};
      if (importRun) {
        metaChecks.has_import_run_id = !!importRun.id;
        metaChecks.has_connection_id = !!importRun.connection_id;
        metaChecks.has_project_id = !!importRun.project_id;
        metaChecks.has_status = !!importRun.status;
        metaChecks.has_started_at = !!importRun.started_at;
        metaChecks.has_finished_at = !!importRun.finished_at;
      }

      const { data: importObjs } = await supabase
        .from("external_import_objects")
        .select("object_name, storage_path, file_size_bytes, status")
        .eq("import_run_id", import_run_id)
        .in("status", ["staged", "promoted"]);

      const objChecks = (importObjs || []).map(o => ({
        object_name: o.object_name,
        has_storage_path: !!o.storage_path,
        has_bytes_size: (o.file_size_bytes || 0) > 0,
        has_status: !!o.status,
      }));

      metadataValid = Object.values(metaChecks).every(Boolean) && objChecks.every(o => o.has_storage_path && o.has_status);
      details.metadata = { run: metaChecks, objects: objChecks, valid: metadataValid, connection_id: importRun?.connection_id };

      // Store connection_id for the validation run
      if (importRun?.connection_id) {
        await supabase.from("pipeline_validation_runs").update({ connection_id: importRun.connection_id }).eq("id", valRunId);
      }

      await logEvent(supabase, project_id, "metadata_validated", { import_run_id, valid: metadataValid });
    } catch (e: any) {
      details.metadata = { error: e.message };
    }

    // ═══ ETAPA 3: PROMOÇÃO ═══
    try {
      // Check if any objects already promoted with dataset
      const { data: promotedObjs } = await supabase
        .from("external_import_objects")
        .select("dataset_id, object_name")
        .eq("import_run_id", import_run_id)
        .eq("status", "promoted")
        .not("dataset_id", "is", null);

      if (promotedObjs && promotedObjs.length > 0) {
        const datasetId = promotedObjs[0].dataset_id;
        
        // Verify dataset in project_datasets
        const { data: dataset } = await supabase
          .from("project_datasets")
          .select("id, project_id, storage_path, is_active, created_at")
          .eq("id", datasetId!)
          .single();

        if (dataset) {
          promotionValid = true;
          details.promotion = {
            valid: true,
            dataset_id: dataset.id,
            is_active: dataset.is_active,
            storage_path: dataset.storage_path,
            created_at: dataset.created_at,
          };

          await supabase.from("pipeline_validation_runs").update({ dataset_id: dataset.id }).eq("id", valRunId);
        } else {
          details.promotion = { valid: false, error: "DATASET_NOT_FOUND", dataset_id: datasetId };
        }
      } else {
        // Try to promote now
        const { data: promoteResult, error: promErr } = await supabase.functions.invoke("promote-staging", {
          body: { import_run_id, project_id },
        });

        if (promErr || !promoteResult?.success) {
          details.promotion = { valid: false, error: promoteResult?.error || promErr?.message || "PROMOTION_FAILED" };
        } else {
          promotionValid = true;
          details.promotion = {
            valid: true,
            dataset_id: promoteResult.dataset_id,
            promoted_count: promoteResult.promoted_count,
            auto_promoted: true,
          };
          await supabase.from("pipeline_validation_runs").update({ dataset_id: promoteResult.dataset_id }).eq("id", valRunId);
        }
      }

      await logEvent(supabase, project_id, promotionValid ? "dataset_promoted" : "promotion_validation_failed", { import_run_id, details: details.promotion });
    } catch (e: any) {
      details.promotion = { error: e.message };
    }

    // ═══ ETAPA 4: SCHEMA ═══
    try {
      const datasetId = details.promotion?.dataset_id;
      if (!datasetId) {
        details.schema = { valid: false, error: "NO_DATASET_TO_CHECK" };
      } else {
        // Check project_columns for schema
        const { data: cols, count } = await supabase
          .from("project_columns")
          .select("column_name, inferred_type", { count: "exact" })
          .eq("project_id", project_id)
          .limit(5);

        // Also check active_schema_json in project_settings
        const { data: settings } = await supabase
          .from("project_settings")
          .select("active_schema_json")
          .eq("project_id", project_id)
          .single();

        const hasProjectColumns = (count || 0) > 0;
        const hasActiveSchema = !!settings?.active_schema_json;

        schemaValid = hasProjectColumns || hasActiveSchema;
        details.schema = {
          valid: schemaValid,
          columns_count: count || 0,
          has_project_columns: hasProjectColumns,
          has_active_schema: hasActiveSchema,
          sample_columns: (cols || []).map(c => c.column_name),
        };
      }

      await logEvent(supabase, project_id, schemaValid ? "schema_persisted" : "schema_validation_failed", { import_run_id });
    } catch (e: any) {
      details.schema = { error: e.message };
    }

    // ═══ ETAPA 5: SAMPLE ═══
    try {
      const { data: sample } = await supabase
        .from("project_dataset_sample")
        .select("id, created_at")
        .eq("project_id", project_id)
        .limit(1);

      // Also check sample_json in project_settings
      const { data: settings } = await supabase
        .from("project_settings")
        .select("sample_json")
        .eq("project_id", project_id)
        .single();

      const hasSampleTable = sample && sample.length > 0;
      const hasSampleJson = !!settings?.sample_json;

      // Try to get row count from sample
      let sampleRows = 0;
      if (hasSampleJson && settings?.sample_json) {
        const sj = settings.sample_json as any;
        sampleRows = sj?.rows?.length || 0;
      }

      sampleValid = hasSampleTable || hasSampleJson;
      details.sample = {
        valid: sampleValid,
        has_sample_table: hasSampleTable,
        has_sample_json: hasSampleJson,
        sample_rows: sampleRows,
      };

      await logEvent(supabase, project_id, sampleValid ? "sample_generated" : "sample_validation_failed", { import_run_id });
    } catch (e: any) {
      details.sample = { error: e.message };
    }

    // ═══ ETAPA 6: EDA VALIDATION ═══
    try {
      // Use the existing compute_eda_ready RPC
      const { data: edaResult } = await supabase.rpc("compute_eda_ready", { p_project_id: project_id });

      if (edaResult) {
        const edaReady = edaResult.eda_ready;
        const evidence = edaResult.evidence || {};
        
        // Check minimum requirements: >= 2 columns, >= 10 rows
        const colCount = evidence.cols_len || 0;
        const rowCount = evidence.rows_len || 0;
        const hasMinCols = colCount >= 2;
        const hasMinRows = rowCount >= 10;

        edaValid = hasMinCols && hasMinRows && (evidence.has_active_dataset === true);
        details.eda = {
          valid: edaValid,
          eda_ready: edaReady,
          columns: colCount,
          rows: rowCount,
          has_min_cols: hasMinCols,
          has_min_rows: hasMinRows,
          has_active_dataset: evidence.has_active_dataset,
          has_sample: evidence.has_sample,
          has_numeric_stats: evidence.has_numeric_stats,
          reasons: edaResult.reasons || [],
        };
      } else {
        details.eda = { valid: false, error: "EDA_CHECK_RETURNED_NULL" };
      }

      await logEvent(supabase, project_id, edaValid ? "eda_validation_passed" : "eda_validation_failed", { import_run_id, details: details.eda });
    } catch (e: any) {
      details.eda = { error: e.message };
    }

    // ═══ COMPUTE OVERALL STATUS ═══
    const allValid = stagingValid && metadataValid && promotionValid && schemaValid && sampleValid && edaValid;
    const anyFailed = !stagingValid || !metadataValid || !promotionValid;
    const overallStatus = allValid ? "success" : anyFailed ? "failed" : "warning";

    // Update validation run
    await supabase
      .from("pipeline_validation_runs")
      .update({
        staging_valid: stagingValid,
        metadata_valid: metadataValid,
        promotion_valid: promotionValid,
        schema_valid: schemaValid,
        sample_valid: sampleValid,
        eda_valid: edaValid,
        overall_status: overallStatus,
        details,
        finished_at: new Date().toISOString(),
      })
      .eq("id", valRunId);

    console.log(`[validate-pipeline] Completed: ${overallStatus} (staging=${stagingValid}, meta=${metadataValid}, promo=${promotionValid}, schema=${schemaValid}, sample=${sampleValid}, eda=${edaValid})`);

    return new Response(
      JSON.stringify({
        success: true,
        validation_run_id: valRunId,
        overall_status: overallStatus,
        staging_valid: stagingValid,
        metadata_valid: metadataValid,
        promotion_valid: promotionValid,
        schema_valid: schemaValid,
        sample_valid: sampleValid,
        eda_valid: edaValid,
        details,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[validate-pipeline] Error:", msg);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  }
});

// Helper to log platform events
async function logEvent(supabase: any, projectId: string, eventType: string, metadata: Record<string, any>) {
  try {
    await supabase.from("platform_events").insert({
      event_type: eventType,
      project_id: projectId,
      status: "info",
      source: "admin",
      metadata,
    });
  } catch { /* best effort */ }
}
