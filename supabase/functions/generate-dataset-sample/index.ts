import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    // 1. Validate UUID
    if (!projectId || !UUID_RE.test(projectId)) {
      return fail("INVALID_PROJECT_ID", "project_id ausente ou inválido.");
    }

    // 2. Get active_dataset_ref from project_dataset_state
    const { data: dsState } = await sb
      .from("project_dataset_state")
      .select("active_dataset_ref, organization_id")
      .eq("project_id", projectId)
      .maybeSingle();

    if (!dsState?.active_dataset_ref) {
      await logEvent(sb, projectId, "dataset_sample_failed", { code: "NO_ACTIVE_DATASET" });
      return fail("NO_ACTIVE_DATASET", "Nenhum dataset ativo encontrado para este projeto.");
    }

    // 3. Resolve dataset record
    const datasetRef = dsState.active_dataset_ref;
    let datasetId: string | null = null;
    let storagePath: string | null = null;
    let userId: string | null = null;

    // Try active_dataset_ref as UUID → project_datasets lookup
    if (UUID_RE.test(datasetRef)) {
      const { data: dataset } = await sb
        .from("project_datasets")
        .select("id, storage_path, user_id")
        .eq("id", datasetRef)
        .maybeSingle();

      if (dataset) {
        datasetId = dataset.id;
        storagePath = dataset.storage_path;
        userId = dataset.user_id;
      }
    }

    // Fallback: search by project_id + is_active
    if (!storagePath) {
      const { data: dataset } = await sb
        .from("project_datasets")
        .select("id, storage_path, user_id")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle();

      if (dataset) {
        datasetId = dataset.id;
        storagePath = dataset.storage_path;
        userId = dataset.user_id;
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
      return fail("NO_STORAGE_PATH", "Caminho do arquivo não encontrado no storage.");
    }

    // 4. Download file
    let fileBlob: Blob | null = null;

    const { data: fileData, error: dlErr } = await sb.storage.from("datasets").download(storagePath);

    if (dlErr || !fileData) {
      // Fallback: scan folder for CSV
      if (userId) {
        const folderPath = `${userId}/${projectId}`;
        const { data: files } = await sb.storage.from("datasets").list(folderPath, { limit: 10 });
        const csvFile = files?.find((f) => /\.csv$/i.test(f.name));
        if (csvFile) {
          storagePath = `${folderPath}/${csvFile.name}`;
          const { data: retryData, error: retryErr } = await sb.storage.from("datasets").download(storagePath);
          if (!retryErr && retryData) fileBlob = retryData;
        }
      }
      if (!fileBlob) {
        await logEvent(sb, projectId, "dataset_sample_failed", {
          code: "STORAGE_DOWNLOAD_FAIL",
          storage_path: storagePath,
          error: dlErr?.message,
        });
        return fail("STORAGE_DOWNLOAD_FAIL", "Falha ao baixar o arquivo do storage.", { storage_path: storagePath });
      }
    } else {
      fileBlob = fileData;
    }

    // 5. Parse CSV
    const text = await fileBlob!.text();
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

    // 6. Build sample_json with _meta
    const sampleJson = {
      _meta: {
        dataset_id: datasetId,
        storage_path: storagePath,
        generated_at: new Date().toISOString(),
        delimiter,
        columns: headers,
      },
      rows: sampleRows,
    };

    // 7. UPSERT into project_dataset_sample (only columns that exist: project_id, sample_json, sample_rows)
    const { error: upsertError } = await sb
      .from("project_dataset_sample")
      .upsert(
        {
          project_id: projectId,
          sample_json: sampleJson,
          sample_rows: sampleRows.length,
        },
        { onConflict: "project_id" }
      );

    if (upsertError) {
      console.error("[generate-dataset-sample] Upsert error:", upsertError);
      await logEvent(sb, projectId, "dataset_sample_failed", {
        code: "UPSERT_FAIL",
        error: upsertError.message,
      });
      return fail("UPSERT_FAIL", "Falha ao gravar a amostra no banco.", { details: { error: upsertError.message } });
    }

    // 8. Update project_datasets.sample_rows
    if (datasetId) {
      await sb
        .from("project_datasets")
        .update({ sample_rows: sampleRows.length })
        .eq("id", datasetId);
    }

    // 9. Log success
    await logEvent(sb, projectId, "dataset_sample_generated", {
      sample_rows: sampleRows.length,
      columns_detected: headers.length,
      dataset_id: datasetId,
      storage_path: storagePath,
    });

    return ok({
      success: true,
      sample_rows: sampleRows.length,
      columns_detected: headers.length,
      dataset_id: datasetId,
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
    return fail("INTERNAL_ERROR", err.message);
  }
});

async function logEvent(
  sb: any,
  projectId: string,
  eventType: string,
  metadata: Record<string, unknown>
) {
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
