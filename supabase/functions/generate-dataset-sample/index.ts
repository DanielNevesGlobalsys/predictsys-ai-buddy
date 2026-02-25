import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(
        JSON.stringify({ success: false, error: "MISSING_PROJECT_ID" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // 1. Get active_dataset_ref from project_dataset_state
    const { data: dsState } = await sb
      .from("project_dataset_state")
      .select("active_dataset_ref, organization_id")
      .eq("project_id", project_id)
      .maybeSingle();

    if (!dsState?.active_dataset_ref) {
      return new Response(
        JSON.stringify({ success: false, error: "NO_ACTIVE_DATASET" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Resolve dataset storage path
    const { data: dataset } = await sb
      .from("project_datasets")
      .select("id, storage_path, user_id")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .maybeSingle();

    let storagePath: string | null = dataset?.storage_path || null;
    let datasetId: string | null = dataset?.id || null;

    // Fallback: search storage if no dataset record
    if (!storagePath) {
      const { data: project } = await sb
        .from("projects")
        .select("dataset_filename, user_id")
        .eq("id", project_id)
        .single();

      if (project?.dataset_filename && project?.user_id) {
        storagePath = `${project.user_id}/${project_id}/${project.dataset_filename}`;
      }
    }

    if (!storagePath) {
      return new Response(
        JSON.stringify({ success: false, error: "NO_STORAGE_PATH" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Download file from storage
    const { data: fileData, error: downloadError } = await sb.storage
      .from("datasets")
      .download(storagePath);

    if (downloadError || !fileData) {
      // Fallback: scan folder
      const userId = dataset?.user_id;
      if (userId) {
        const folderPath = `${userId}/${project_id}`;
        const { data: files } = await sb.storage.from("datasets").list(folderPath, { limit: 10 });
        const csvFile = files?.find(
          (f) => f.name.endsWith(".csv") || f.name.endsWith(".CSV")
        );
        if (csvFile) {
          storagePath = `${folderPath}/${csvFile.name}`;
          const { data: retryData, error: retryErr } = await sb.storage
            .from("datasets")
            .download(storagePath);
          if (retryErr || !retryData) {
            return new Response(
              JSON.stringify({ success: false, error: "STORAGE_DOWNLOAD_FAIL", message: retryErr?.message }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          // Use retryData below
          return await processAndPersist(sb, project_id, datasetId, retryData);
        }
      }

      return new Response(
        JSON.stringify({ success: false, error: "STORAGE_DOWNLOAD_FAIL", message: downloadError?.message }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return await processAndPersist(sb, project_id, datasetId, fileData);
  } catch (err: any) {
    console.error("[generate-dataset-sample] Error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "INTERNAL_ERROR", message: err.message }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function processAndPersist(
  sb: any,
  projectId: string,
  datasetId: string | null,
  fileBlob: Blob
) {
  const text = await fileBlob.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return new Response(
      JSON.stringify({ success: false, error: "EMPTY_FILE" }),
      { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  // Parse CSV header + up to 500 rows
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

  // Upsert into project_dataset_sample
  const { error: upsertError } = await sb
    .from("project_dataset_sample")
    .upsert(
      {
        project_id: projectId,
        dataset_id: datasetId,
        sample_json: sampleRows,
        sample_rows: sampleRows.length,
        created_at: new Date().toISOString(),
      },
      { onConflict: "project_id" }
    );

  if (upsertError) {
    console.error("[generate-dataset-sample] Upsert error:", upsertError);
    return new Response(
      JSON.stringify({ success: false, error: "UPSERT_FAIL", message: upsertError.message }),
      { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  // Update project_datasets.sample_rows
  if (datasetId) {
    await sb
      .from("project_datasets")
      .update({ sample_rows: sampleRows.length })
      .eq("id", datasetId);
  }

  return new Response(
    JSON.stringify({
      success: true,
      sample_rows: sampleRows.length,
      columns_detected: headers.length,
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
  );
}
