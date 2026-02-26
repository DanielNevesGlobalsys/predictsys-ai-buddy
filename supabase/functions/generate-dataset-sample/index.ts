import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_EXT_RE = /\.(csv|parquet|json|jsonl|xlsx)$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  const ok = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const fail = (code: string, message: string, details?: Record<string, unknown>) =>
    ok({ success: false, code, message, ...(details || {}) });

  let projectId: string | undefined;

  try {
    const body = await req.json();
    projectId = body.project_id;

    if (!projectId || !UUID_RE.test(projectId)) {
      return fail("INVALID_PROJECT_ID", "project_id ausente ou inválido.");
    }

    // ── 1. Resolve dataset info ──────────────────────────────
    const { data: dsState } = await sb
      .from("project_dataset_state")
      .select("active_dataset_ref, organization_id, active_schema_json")
      .eq("project_id", projectId)
      .maybeSingle();

    if (!dsState?.active_dataset_ref) {
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "NO_ACTIVE_DATASET" });
      return fail("NO_ACTIVE_DATASET", "Nenhum dataset ativo encontrado para este projeto.");
    }

    const datasetRef = dsState.active_dataset_ref;
    const schemaJson = dsState.active_schema_json;
    let datasetId: string | null = null;
    let storagePath: string | null = null;
    let userId: string | null = null;
    let datasetMeta: Record<string, unknown> = {};

    // Try active_dataset_ref as UUID → project_datasets
    if (UUID_RE.test(datasetRef)) {
      const { data: dataset } = await sb
        .from("project_datasets")
        .select("id, storage_path, user_id, name, source_type, source_metadata, created_at, columns_count")
        .eq("id", datasetRef)
        .maybeSingle();

      if (dataset) {
        datasetId = dataset.id;
        storagePath = dataset.storage_path;
        userId = dataset.user_id;
        datasetMeta = { name: dataset.name, source_type: dataset.source_type, columns_count: dataset.columns_count, created_at: dataset.created_at };
      }
    }

    // Fallback: project_id + is_active
    if (!storagePath) {
      const { data: dataset } = await sb
        .from("project_datasets")
        .select("id, storage_path, user_id, name, source_type, columns_count, created_at")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle();

      if (dataset) {
        datasetId = dataset.id;
        storagePath = dataset.storage_path;
        userId = dataset.user_id;
        datasetMeta = { name: dataset.name, source_type: dataset.source_type, columns_count: dataset.columns_count, created_at: dataset.created_at };
      }
    }

    // Fallback: projects.dataset_filename
    if (!storagePath) {
      const { data: project } = await sb
        .from("projects")
        .select("dataset_filename, user_id")
        .eq("id", projectId)
        .single();

      if (project?.dataset_filename && project?.user_id) {
        userId = project.user_id;
        storagePath = `${project.user_id}/${projectId}/${project.dataset_filename}`;
      }
    }

    if (!storagePath) {
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "NO_STORAGE_PATH", dataset_ref: datasetRef });
      return fail("NO_STORAGE_PATH", "Caminho do arquivo não encontrado no storage.", { debug: { dataset_ref: datasetRef, dataset_id: datasetId } });
    }

    // ── 2. Determine if storagePath is a file or folder ──────
    const isLikelyFile = FILE_EXT_RE.test(storagePath);
    const bucket = "datasets";
    let fileBlob: Blob | null = null;
    let pickedFile: string | null = null;
    let pickedFormat: "csv" | "parquet" | "unknown" = "unknown";
    const diagnostics: Record<string, unknown>[] = [];

    // 2a. Try direct download if it looks like a file
    if (isLikelyFile) {
      const { data: dlData, error: dlErr } = await sb.storage.from(bucket).download(storagePath);
      const diag: Record<string, unknown> = { step: "direct_download", bucket, path: storagePath };
      if (dlErr || !dlData) {
        diag.ok = false;
        diag.error = dlErr?.message || "no data";
      } else {
        diag.ok = true;
        diag.size = dlData.size;
        fileBlob = dlData;
        pickedFile = storagePath;
        pickedFormat = /\.parquet$/i.test(storagePath) ? "parquet" : "csv";
      }
      diagnostics.push(diag);
    }

    // 2b. If no blob yet, treat storagePath as folder prefix and list contents
    if (!fileBlob) {
      const folderPrefix = storagePath.endsWith("/") ? storagePath : storagePath + "/";
      // Also try without trailing slash (supabase list uses folder arg)
      const folderArg = storagePath.replace(/\/+$/, "");

      const { data: files, error: listErr } = await sb.storage.from(bucket).list(folderArg, { limit: 100 });
      const listDiag: Record<string, unknown> = {
        step: "folder_list", bucket, folder: folderArg,
        list_count: files?.length ?? 0,
        list_names: (files || []).slice(0, 15).map((f: any) => f.name),
        list_error: listErr?.message || null,
      };
      diagnostics.push(listDiag);

      if (files && files.length > 0) {
        // Separate CSV and Parquet candidates
        const csvFiles = files.filter((f: any) => /\.csv$/i.test(f.name));
        const parquetFiles = files.filter((f: any) => /\.parquet$/i.test(f.name));

        // Pick best candidate: prefer CSV (largest), then Parquet (largest)
        let candidate: { name: string; format: "csv" | "parquet" } | null = null;

        if (csvFiles.length > 0) {
          csvFiles.sort((a: any, b: any) => (b.metadata?.size ?? 0) - (a.metadata?.size ?? 0));
          candidate = { name: csvFiles[0].name, format: "csv" };
        } else if (parquetFiles.length > 0) {
          parquetFiles.sort((a: any, b: any) => (b.metadata?.size ?? 0) - (a.metadata?.size ?? 0));
          candidate = { name: parquetFiles[0].name, format: "parquet" };
        }

        if (candidate) {
          const candidatePath = `${folderArg}/${candidate.name}`;
          pickedFormat = candidate.format;

          if (candidate.format === "csv") {
            const { data: dlData, error: dlErr } = await sb.storage.from(bucket).download(candidatePath);
            const dlDiag: Record<string, unknown> = { step: "folder_candidate_download", path: candidatePath, format: "csv" };
            if (dlErr || !dlData) {
              dlDiag.ok = false;
              dlDiag.error = dlErr?.message || "no data";
              diagnostics.push(dlDiag);
            } else {
              dlDiag.ok = true;
              dlDiag.size = dlData.size;
              diagnostics.push(dlDiag);
              fileBlob = dlData;
              pickedFile = candidatePath;
            }
          } else {
            // Parquet — schema-only mode, no download needed
            pickedFile = candidatePath;
          }
        } else {
          diagnostics.push({ step: "folder_no_candidates", csv_count: 0, parquet_count: 0 });
        }
      }
    }

    // 2c. Extra fallback: scan user/project folder
    if (!fileBlob && pickedFormat !== "parquet" && userId) {
      const scanFolder = `${userId}/${projectId}`;
      const { data: scanFiles } = await sb.storage.from(bucket).list(scanFolder, { limit: 50 });
      const scanDiag: Record<string, unknown> = {
        step: "user_project_scan", folder: scanFolder,
        list_count: scanFiles?.length ?? 0,
        list_names: (scanFiles || []).slice(0, 15).map((f: any) => f.name),
      };

      if (scanFiles && scanFiles.length > 0) {
        const csvFile = scanFiles.filter((f: any) => /\.csv$/i.test(f.name))
          .sort((a: any, b: any) => (b.metadata?.size ?? 0) - (a.metadata?.size ?? 0))[0];
        const parquetFile = !csvFile
          ? scanFiles.filter((f: any) => /\.parquet$/i.test(f.name))
              .sort((a: any, b: any) => (b.metadata?.size ?? 0) - (a.metadata?.size ?? 0))[0]
          : null;

        const picked = csvFile || parquetFile;
        if (picked) {
          const candidatePath = `${scanFolder}/${picked.name}`;
          pickedFormat = /\.parquet$/i.test(picked.name) ? "parquet" : "csv";

          if (pickedFormat === "csv") {
            const { data: dlData, error: dlErr } = await sb.storage.from(bucket).download(candidatePath);
            if (!dlErr && dlData) {
              scanDiag.download_ok = true;
              scanDiag.picked = picked.name;
              fileBlob = dlData;
              pickedFile = candidatePath;
            } else {
              scanDiag.download_ok = false;
              scanDiag.error = dlErr?.message;
            }
          } else {
            scanDiag.picked = picked.name;
            pickedFile = candidatePath;
          }
        }
      }
      diagnostics.push(scanDiag);
    }

    // ── 3. Handle Parquet schema-only mode ────────────────────
    if (pickedFormat === "parquet" && pickedFile) {
      // Extract columns from active_schema_json if available
      let columns: string[] = [];
      if (Array.isArray(schemaJson)) {
        columns = schemaJson.map((col: any) => col.name || col.column_name || String(col)).filter(Boolean);
      } else if (schemaJson && typeof schemaJson === "object") {
        columns = Object.keys(schemaJson);
      }

      const sampleJson = {
        _meta: {
          dataset_id: datasetId,
          storage_path: storagePath,
          picked_file: pickedFile,
          format: "parquet",
          preview_mode: "schema_only",
          generated_at: new Date().toISOString(),
          columns,
        },
        rows: [],
      };

      const { error: upsertError } = await sb
        .from("project_dataset_sample")
        .upsert(
          { project_id: projectId, sample_json: sampleJson, sample_rows: 0 },
          { onConflict: "project_id" }
        );

      if (upsertError) {
        await logEvent(sb, projectId, "dataset_sample_failed", { code: "UPSERT_FAIL", error: upsertError.message, format: "parquet" });
        return fail("UPSERT_FAIL", "Falha ao gravar amostra (parquet/schema-only): " + upsertError.message);
      }

      await logEvent(sb, projectId, "dataset_sample_generated", {
        format: "parquet", preview_mode: "schema_only",
        columns_detected: columns.length, dataset_id: datasetId,
        original_storage_path: storagePath, picked_file: pickedFile,
        picked_bucket: bucket, diagnostics,
      });

      return ok({
        success: true, sample_rows: 0, columns_detected: columns.length,
        dataset_id: datasetId, bucket, format: "parquet", preview_mode: "schema_only",
      });
    }

    // ── 4. No file found at all ──────────────────────────────
    if (!fileBlob) {
      const debugInfo = { dataset_id: datasetId, storage_path: storagePath, dataset_meta: datasetMeta, diagnostics };
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "STORAGE_DOWNLOAD_FAIL", debug: debugInfo });
      return fail(
        "STORAGE_DOWNLOAD_FAIL",
        `Falha ao baixar arquivo. Path: ${storagePath}. Tentativas: ${diagnostics.length}.`,
        { debug: debugInfo }
      );
    }

    // ── 5. Parse CSV ─────────────────────────────────────────
    const text = await fileBlob.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    if (lines.length < 2) {
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "EMPTY_FILE", lines: lines.length });
      return fail("EMPTY_FILE", "Arquivo vazio ou sem linhas de dados.");
    }

    const headerLine = lines[0];
    const delimiter = headerLine.includes(";") ? ";" : ",";
    const headers = headerLine.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
    const maxRows = Math.min(lines.length - 1, 500);
    const sampleRows: Record<string, string>[] = [];

    for (let i = 1; i <= maxRows; i++) {
      const values = lines[i].split(delimiter);
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = (values[idx] || "").trim().replace(/^"|"$/g, "");
      });
      sampleRows.push(row);
    }

    // ── 6. Build sample_json & upsert ────────────────────────
    const sampleJson = {
      _meta: {
        dataset_id: datasetId,
        storage_path: storagePath,
        picked_file: pickedFile,
        format: "csv",
        generated_at: new Date().toISOString(),
        delimiter,
        columns: headers,
      },
      rows: sampleRows,
    };

    const { error: upsertError } = await sb
      .from("project_dataset_sample")
      .upsert(
        { project_id: projectId, sample_json: sampleJson, sample_rows: sampleRows.length },
        { onConflict: "project_id" }
      );

    if (upsertError) {
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "UPSERT_FAIL", error: upsertError.message });
      return fail("UPSERT_FAIL", "Falha ao gravar a amostra: " + upsertError.message);
    }

    // ── 7. Update project_datasets ───────────────────────────
    if (datasetId) {
      await sb.from("project_datasets")
        .update({ sample_rows: sampleRows.length, columns_count: headers.length })
        .eq("id", datasetId);
    }

    // ── 8. Log success ───────────────────────────────────────
    await logEvent(sb, projectId, "dataset_sample_generated", {
      sample_rows: sampleRows.length, columns_detected: headers.length,
      dataset_id: datasetId, original_storage_path: storagePath,
      picked_file: pickedFile, picked_bucket: bucket, format: "csv",
      list_count: diagnostics.length, diagnostics,
    });

    return ok({
      success: true, sample_rows: sampleRows.length,
      columns_detected: headers.length, dataset_id: datasetId,
      bucket, format: "csv",
    });
  } catch (err: any) {
    console.error("[generate-dataset-sample] Error:", err);
    if (projectId) {
      await logEvent(sb, projectId, "dataset_sample_failed", {
        code: "INTERNAL_ERROR", error: err.message,
        stack: (err.stack || "").slice(0, 4000),
      }).catch(() => {});
    }
    return fail("INTERNAL_ERROR", err.message || "Erro interno desconhecido.");
  }
});

async function logEvent(sb: any, projectId: string, eventType: string, metadata: Record<string, unknown>) {
  try {
    await sb.from("platform_events").insert({
      project_id: projectId,
      event_type: eventType,
      status: eventType.includes("failed") ? "error" : "success",
      source: "edge",
      metadata,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[generate-dataset-sample] logEvent error:", e);
  }
}
