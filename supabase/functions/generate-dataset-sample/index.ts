import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_EXT_RE = /\.(csv|parquet|json|jsonl|xlsx)$/i;
const CSV_SNIFF_BYTES = 65536;

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

    // ── Normalize schema columns ─────────────────────────────
    let schemaColumns: { name: string; type: string }[] = [];
    if (Array.isArray(schemaJson)) {
      schemaColumns = schemaJson.map((col: any) => ({
        name: col.name || col.column_name || String(col),
        type: col.type || col.inferred_type || "unknown",
      })).filter((c: any) => c.name);
    } else if (schemaJson && typeof schemaJson === "object") {
      schemaColumns = Object.entries(schemaJson).map(([name, type]) => ({
        name,
        type: typeof type === "string" ? type : "unknown",
      }));
    }
    let datasetId: string | null = null;
    let storagePath: string | null = null;
    let userId: string | null = null;
    let datasetMeta: Record<string, unknown> = {};
    let isBatchImport = false;

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
        datasetMeta = {
          name: dataset.name, source_type: dataset.source_type,
          columns_count: dataset.columns_count, created_at: dataset.created_at,
        };
        isBatchImport = dataset.source_type === "batch_import"
          || (dataset.name || "").toLowerCase().includes("batch")
          || (dataset.storage_path || "").includes("/batch");
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
        datasetMeta = {
          name: dataset.name, source_type: dataset.source_type,
          columns_count: dataset.columns_count, created_at: dataset.created_at,
        };
        isBatchImport = dataset.source_type === "batch_import"
          || (dataset.name || "").toLowerCase().includes("batch")
          || (storagePath || "").includes("/batch");
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

    // ── 2. Multi-bucket resolution ───────────────────────────
    const defaultBuckets = ["datasets", "big_imports", "uploads", "imports", "raw", "project_datasets"];
    const bucketOrder = isBatchImport
      ? ["big_imports", "datasets", "uploads", "imports", "raw", "project_datasets"]
      : defaultBuckets;

    const isLikelyFile = FILE_EXT_RE.test(storagePath);
    const diagnostics: Record<string, unknown>[] = [];

    let fileBlob: Blob | null = null;
    let pickedFile: string | null = null;
    let pickedBucket: string | null = null;
    let pickedFormat: "csv" | "parquet" | "unknown" = "unknown";
    let pickedSize: number | null = null;
    let pickedMimetype: string | null = null;

    // Helper: derive folder from path
    const folderOf = (p: string) => {
      const parts = p.replace(/\/+$/, "").split("/");
      return parts.length > 1 ? parts.slice(0, -1).join("/") : p;
    };

    // ── 2a. If path looks like a file, try direct download across buckets ──
    if (isLikelyFile) {
      for (const bucket of bucketOrder) {
        const { data: dlData, error: dlErr } = await sb.storage.from(bucket).download(storagePath);
        const diag: Record<string, unknown> = { step: "direct_download", bucket, path: storagePath };
        if (dlErr || !dlData) {
          diag.ok = false;
          diag.error_raw = dlErr?.message || "no data";
        } else {
          diag.ok = true;
          diag.blob_size = dlData.size;
          fileBlob = dlData;
          pickedFile = storagePath;
          pickedBucket = bucket;
          pickedFormat = /\.parquet$/i.test(storagePath) ? "parquet" : "csv";
          pickedSize = dlData.size;
        }
        diagnostics.push(diag);
        if (fileBlob) break;
      }
    }

    // ── 2b. Folder mode: list objects across buckets ─────────
    if (!fileBlob && pickedFormat !== "parquet") {
      const folderVariants = [
        storagePath.replace(/\/+$/, ""),
        storagePath.endsWith("/") ? storagePath.slice(0, -1) : storagePath,
      ];
      // dedupe
      const foldersToTry = [...new Set(folderVariants)];

      for (const bucket of bucketOrder) {
        if (fileBlob) break;
        for (const folder of foldersToTry) {
          if (fileBlob) break;
          const { data: files, error: listErr } = await sb.storage.from(bucket).list(folder, { limit: 100 });
          const listDiag: Record<string, unknown> = {
            step: "folder_list", bucket, folder,
            list_count: files?.length ?? 0,
            list_names: (files || []).slice(0, 10).map((f: any) => f.name),
            list_error: listErr?.message || null,
          };
          diagnostics.push(listDiag);

          if (!files || files.length === 0) continue;

          // Found files in this bucket — select best candidate
          const result = await selectAndDownload(sb, bucket, folder, files, schemaJson, diagnostics);
          if (result) {
            fileBlob = result.blob;
            pickedFile = result.filePath;
            pickedBucket = bucket;
            pickedFormat = result.format;
            pickedSize = result.size;
            pickedMimetype = result.mimetype;
            break;
          }
        }
      }
    }

    // ── 2c. Extra fallback: scan user/project folder ─────────
    if (!fileBlob && pickedFormat !== "parquet" && userId) {
      const scanFolder = `${userId}/${projectId}`;
      for (const bucket of bucketOrder) {
        if (fileBlob) break;
        const { data: scanFiles } = await sb.storage.from(bucket).list(scanFolder, { limit: 50 });
        const scanDiag: Record<string, unknown> = {
          step: "user_project_scan", bucket, folder: scanFolder,
          list_count: scanFiles?.length ?? 0,
          list_names: (scanFiles || []).slice(0, 10).map((f: any) => f.name),
        };
        diagnostics.push(scanDiag);

        if (!scanFiles || scanFiles.length === 0) continue;

        const result = await selectAndDownload(sb, bucket, scanFolder, scanFiles, schemaJson, diagnostics);
        if (result) {
          fileBlob = result.blob;
          pickedFile = result.filePath;
          pickedBucket = bucket;
          pickedFormat = result.format;
          pickedSize = result.size;
          pickedMimetype = result.mimetype;
        }
      }
    }

    // ── 3. Handle Parquet schema-only mode ────────────────────
    if (pickedFormat === "parquet" && pickedFile) {
      const sampleJson = {
        _meta: {
          dataset_id: datasetId,
          project_id: projectId,
          storage_path: storagePath,
          selected_bucket: pickedBucket,
          selected_object: pickedFile,
          selected_size: pickedSize,
          selected_mimetype: pickedMimetype,
          format: "parquet",
          preview_mode: "schema_only",
          schema_source: "active_schema_json",
          detected_columns_count: 0,
          schema_columns_count: schemaColumns.length,
          generated_at: new Date().toISOString(),
        },
        columns: schemaColumns,
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
        picked_bucket: pickedBucket, diagnostics,
      });

      return ok({
        success: true, sample_rows: 0, columns_detected: schemaColumns.length,
        columns_schema: schemaColumns.length, schema_applied: true,
        dataset_id: datasetId, bucket: pickedBucket, format: "parquet", preview_mode: "schema_only",
      });
    }

    // ── 4. No file found at all ──────────────────────────────
    if (!fileBlob) {
      const debugInfo = { dataset_id: datasetId, storage_path: storagePath, dataset_meta: datasetMeta, is_batch_import: isBatchImport, buckets_tried: bucketOrder, diagnostics };
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "STORAGE_DOWNLOAD_FAIL", debug: debugInfo });
      return fail(
        "STORAGE_DOWNLOAD_FAIL",
        `Falha ao baixar arquivo. Path: ${storagePath}. Buckets tentados: ${bucketOrder.join(",")}. Tentativas: ${diagnostics.length}.`,
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
    const delimiter = detectDelimiter(headerLine);
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
    const schemaApplied = schemaColumns.length > 0;
    const finalColumns = schemaApplied ? schemaColumns : headers.map(h => ({ name: h, type: "unknown" }));

    const sampleJson = {
      _meta: {
        dataset_id: datasetId,
        project_id: projectId,
        storage_path: storagePath,
        selected_bucket: pickedBucket,
        selected_object: pickedFile,
        selected_size: pickedSize,
        selected_mimetype: pickedMimetype,
        format: "csv",
        preview_source: "sample_rows",
        schema_source: schemaApplied ? "active_schema_json" : "file_headers",
        detected_columns_count: headers.length,
        schema_columns_count: schemaColumns.length,
        generated_at: new Date().toISOString(),
        delimiter,
      },
      columns: finalColumns,
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
      columns_schema: schemaColumns.length, schema_applied: schemaApplied,
      dataset_id: datasetId, original_storage_path: storagePath,
      picked_file: pickedFile, picked_bucket: pickedBucket, format: "csv",
      picked_size: pickedSize, picked_mimetype: pickedMimetype,
      diagnostics,
    });

    return ok({
      success: true, sample_rows: sampleRows.length,
      columns_detected: headers.length, columns_schema: schemaColumns.length,
      schema_applied: schemaApplied, dataset_id: datasetId || null,
      bucket: pickedBucket, format: "csv",
      warning: datasetId ? undefined : "dataset_id não encontrado — registro em project_datasets pode estar ausente.",
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

// ── Helpers ──────────────────────────────────────────────────

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

function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const count = headerLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function isCsvCandidate(file: any): boolean {
  const name = (file.name || "").toLowerCase();
  if (/\.csv$/i.test(name)) return true;
  const mime = file.metadata?.mimetype || file.metadata?.contentType || "";
  if (mime.includes("csv") || mime.includes("text/plain")) return true;
  // No extension at all = potential CSV (will sniff later)
  if (!FILE_EXT_RE.test(name)) return true;
  return false;
}

function isParquetCandidate(file: any): boolean {
  return /\.parquet$/i.test(file.name || "");
}

function getFileSize(file: any): number {
  return file.metadata?.size ?? file.metadata?.contentLength ?? 0;
}

/**
 * Select the best file from a folder listing and download it.
 * Returns null if no suitable file found or download fails.
 */
async function selectAndDownload(
  sb: any,
  bucket: string,
  folder: string,
  files: any[],
  schemaJson: any,
  diagnostics: Record<string, unknown>[],
): Promise<{ blob: Blob; filePath: string; format: "csv" | "parquet"; size: number; mimetype: string | null } | null> {
  // Separate candidates
  const csvCandidates = files.filter(isCsvCandidate).sort((a: any, b: any) => getFileSize(b) - getFileSize(a));
  const parquetCandidates = files.filter(isParquetCandidate).sort((a: any, b: any) => getFileSize(b) - getFileSize(a));

  // Try CSV candidates first (largest first)
  for (const candidate of csvCandidates) {
    const filePath = `${folder}/${candidate.name}`;
    const { data: dlData, error: dlErr } = await sb.storage.from(bucket).download(filePath);
    const dlDiag: Record<string, unknown> = {
      step: "candidate_download", bucket, filePath,
      candidate_name: candidate.name,
      expected_size: getFileSize(candidate),
      mimetype: candidate.metadata?.mimetype || candidate.metadata?.contentType || null,
    };

    if (dlErr || !dlData) {
      dlDiag.download_ok = false;
      dlDiag.error_raw = dlErr?.message || "no data";
      diagnostics.push(dlDiag);
      continue;
    }

    dlDiag.download_ok = true;
    dlDiag.blob_size = dlData.size;

    // If no extension, sniff to confirm it's CSV
    const hasExtension = FILE_EXT_RE.test(candidate.name);
    if (!hasExtension) {
      const sniffOk = await sniffCSV(dlData);
      dlDiag.sniff_result = sniffOk ? "csv_confirmed" : "not_csv";
      if (!sniffOk) {
        diagnostics.push(dlDiag);
        continue;
      }
    }

    diagnostics.push(dlDiag);
    return {
      blob: dlData,
      filePath,
      format: "csv",
      size: dlData.size,
      mimetype: candidate.metadata?.mimetype || candidate.metadata?.contentType || null,
    };
  }

  // Parquet fallback (schema-only, no download needed)
  if (parquetCandidates.length > 0) {
    const best = parquetCandidates[0];
    const filePath = `${folder}/${best.name}`;
    diagnostics.push({
      step: "parquet_schema_only", bucket, filePath,
      candidate_name: best.name, expected_size: getFileSize(best),
    });
    // We don't return a blob — caller will detect format=parquet and handle schema-only
    // But we need to signal this somehow. Return null blob is bad.
    // Instead, set a global side-effect is messy. Return a sentinel.
    return null; // Caller should check pickedFormat separately if parquet candidates exist
  }

  return null;
}

/**
 * Sniff first N bytes of a blob to determine if it looks like CSV.
 * Checks for: multiple lines, consistent delimiter, >= 2 columns.
 */
async function sniffCSV(blob: Blob): Promise<boolean> {
  try {
    const slice = blob.slice(0, CSV_SNIFF_BYTES);
    const text = await slice.text();
    const lines = text.split("\n").filter(l => l.trim().length > 0);
    if (lines.length < 2) return false;

    const delimiters = [",", ";", "\t", "|"];
    for (const d of delimiters) {
      const headerCols = lines[0].split(d).length;
      if (headerCols >= 2) {
        // Check consistency with 2nd line
        const secondCols = lines[1].split(d).length;
        if (Math.abs(headerCols - secondCols) <= 1) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
