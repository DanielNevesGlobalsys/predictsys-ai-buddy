import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKETS_TO_TRY = ["datasets", "uploads", "imports", "project_datasets", "raw"];

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
      .select("active_dataset_ref, organization_id")
      .eq("project_id", projectId)
      .maybeSingle();

    if (!dsState?.active_dataset_ref) {
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "NO_ACTIVE_DATASET" });
      return fail("NO_ACTIVE_DATASET", "Nenhum dataset ativo encontrado para este projeto.");
    }

    const datasetRef = dsState.active_dataset_ref;
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

    // ── 2. Multi-bucket download with diagnostics ────────────
    const folderPath = storagePath.includes("/") ? storagePath.substring(0, storagePath.lastIndexOf("/")) : "";
    const attempts: Record<string, unknown>[] = [];
    let fileBlob: Blob | null = null;
    let successBucket: string | null = null;

    for (const bucket of BUCKETS_TO_TRY) {
      const attempt: Record<string, unknown> = { bucket, path: storagePath, folder: folderPath };

      // List folder contents first
      try {
        const { data: listData, error: listErr } = await sb.storage.from(bucket).list(folderPath, { limit: 20 });
        if (listErr) {
          attempt.list_error = listErr.message;
          attempt.list_count = 0;
        } else {
          attempt.list_count = listData?.length ?? 0;
          attempt.list_names = (listData || []).slice(0, 10).map((f: any) => f.name);
        }
      } catch (e: any) {
        attempt.list_error = e.message;
        attempt.list_count = 0;
      }

      // Try download
      try {
        const { data: dlData, error: dlErr } = await sb.storage.from(bucket).download(storagePath);
        if (dlErr || !dlData) {
          attempt.download_ok = false;
          attempt.error_raw = dlErr?.message || "no data returned";
        } else {
          attempt.download_ok = true;
          attempt.file_size = dlData.size;
          fileBlob = dlData;
          successBucket = bucket;
        }
      } catch (e: any) {
        attempt.download_ok = false;
        attempt.error_raw = e.message;
      }

      attempts.push(attempt);
      if (fileBlob) break;
    }

    // If primary path failed, try scanning folder for CSV in datasets bucket
    if (!fileBlob && userId) {
      const scanFolder = `${userId}/${projectId}`;
      const scanAttempt: Record<string, unknown> = { bucket: "datasets", path: "FOLDER_SCAN:" + scanFolder };
      try {
        const { data: files } = await sb.storage.from("datasets").list(scanFolder, { limit: 20 });
        const csvFile = files?.find((f: any) => /\.csv$/i.test(f.name));
        scanAttempt.list_count = files?.length ?? 0;
        scanAttempt.list_names = (files || []).slice(0, 10).map((f: any) => f.name);
        if (csvFile) {
          const scanPath = `${scanFolder}/${csvFile.name}`;
          const { data: scanData, error: scanErr } = await sb.storage.from("datasets").download(scanPath);
          if (!scanErr && scanData) {
            scanAttempt.download_ok = true;
            scanAttempt.file_size = scanData.size;
            scanAttempt.resolved_path = scanPath;
            fileBlob = scanData;
            successBucket = "datasets";
            storagePath = scanPath;
          } else {
            scanAttempt.download_ok = false;
            scanAttempt.error_raw = scanErr?.message;
          }
        } else {
          scanAttempt.download_ok = false;
          scanAttempt.error_raw = "no CSV found in folder";
        }
      } catch (e: any) {
        scanAttempt.download_ok = false;
        scanAttempt.error_raw = e.message;
      }
      attempts.push(scanAttempt);
    }

    if (!fileBlob) {
      const debugInfo = { dataset_id: datasetId, storage_path: storagePath, dataset_meta: datasetMeta, attempts };
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "STORAGE_DOWNLOAD_FAIL", debug: debugInfo });
      return fail(
        "STORAGE_DOWNLOAD_FAIL",
        `Falha ao baixar o arquivo em ${attempts.length} tentativas. Path: ${storagePath}`,
        { debug: debugInfo }
      );
    }

    // ── 3. Parse CSV ─────────────────────────────────────────
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

    // ── 4. Build sample_json & upsert ────────────────────────
    const sampleJson = {
      _meta: {
        dataset_id: datasetId,
        storage_path: storagePath,
        bucket: successBucket,
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
      console.error("[generate-dataset-sample] Upsert error:", upsertError);
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "UPSERT_FAIL", error: upsertError.message });
      return fail("UPSERT_FAIL", "Falha ao gravar a amostra: " + upsertError.message);
    }

    // ── 5. Update project_datasets ───────────────────────────
    if (datasetId) {
      await sb.from("project_datasets")
        .update({ sample_rows: sampleRows.length, columns_count: headers.length })
        .eq("id", datasetId);
    }

    // ── 6. Log success ───────────────────────────────────────
    await logEvent(sb, projectId, "dataset_sample_generated", {
      sample_rows: sampleRows.length,
      columns_detected: headers.length,
      dataset_id: datasetId,
      storage_path: storagePath,
      bucket: successBucket,
    });

    return ok({
      success: true,
      sample_rows: sampleRows.length,
      columns_detected: headers.length,
      dataset_id: datasetId,
      bucket: successBucket,
    });
  } catch (err: any) {
    console.error("[generate-dataset-sample] Error:", err);
    if (projectId) {
      await logEvent(sb, projectId, "dataset_sample_failed", {
        code: "INTERNAL_ERROR",
        error: err.message,
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
