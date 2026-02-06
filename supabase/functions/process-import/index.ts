import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parquetMetadataAsync, parquetRead } from "npm:hyparquet@1.24.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Configuration - optimized for large files up to 10GB
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const SAMPLE_SIZE = 10000; // Max rows to sample for type inference
const SAMPLE_BYTES_LIMIT = 50 * 1024 * 1024; // 50MB for sampling (fast partial read)

interface ImportJob {
  id: string;
  project_id: string;
  user_id: string;
  file_name: string;
  file_size_bytes: number;
  storage_path: string;
  delimiter: string;
  encoding: string;
  status: string;
  batch_id: string | null;
  batch_sequence: number;
  is_batch_primary: boolean;
  headers_json: string[] | null;
  headers_hash: string | null;
  dataset_id: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { job_id, batch_id } = await req.json();

    if (!job_id) {
      return new Response(JSON.stringify({ success: false, message: "job_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[process-import] Starting import job: ${job_id}, batch_id: ${batch_id || "none"}`);

    const { data: job, error: jobError } = await supabase.from("import_jobs").select("*").eq("id", job_id).single();

    if (jobError || !job) {
      console.error(`[process-import] Job not found: ${job_id}`, jobError);
      return new Response(JSON.stringify({ success: false, message: "Import job not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (job.status !== "pending") {
      console.log(`[process-import] Job ${job_id} is already ${job.status}`);
      return new Response(JSON.stringify({ success: true, message: `Job is already ${job.status}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reject binary formats that cannot be parsed as CSV/text
    const fileExtension = job.file_name.split('.').pop()?.toLowerCase();
    if (fileExtension === 'parquet' || fileExtension === 'parq' || fileExtension === 'pq') {
      const errMsg = "Arquivos Parquet não são suportados. Por favor, converta para CSV antes de importar (ex: pandas df.to_csv()).";
      console.error(`[process-import] Rejecting Parquet file: ${job.file_name}`);
      await updateJobError(supabase, job_id, errMsg);
      return new Response(JSON.stringify({ success: false, message: errMsg }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (job.file_size_bytes > MAX_FILE_SIZE_BYTES) {
      const maxGB = (MAX_FILE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(0);
      await updateJobError(supabase, job_id, `Arquivo excede o limite de ${maxGB} GB.`);
      return new Response(JSON.stringify({ success: false, message: `File exceeds ${maxGB} GB limit` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (job.batch_id) {
      return await processBatchImport(supabase, job as ImportJob);
    } else {
      return await processSingleImport(supabase, job as ImportJob);
    }
  } catch (error: unknown) {
    console.error("[process-import] Unexpected error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(JSON.stringify({ success: false, message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function updateJobProgress(supabase: any, jobId: string, progress: number, rowsProcessed: number): Promise<void> {
  try {
    // Clamp progress between 0-100
    const clampedProgress = Math.min(100, Math.max(0, Math.round(progress)));
    await supabase
      .from("import_jobs")
      .update({ 
        progress: clampedProgress, 
        rows_processed: rowsProcessed, 
        updated_at: new Date().toISOString() 
      })
      .eq("id", jobId);
  } catch (e) {
    console.warn(`[process-import] Failed to update progress for job ${jobId}:`, e);
  }
}

async function updateJobError(supabase: any, jobId: string, errorMessage: string): Promise<void> {
  await supabase
    .from("import_jobs")
    .update({
      status: "failed",
      progress: 0,
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function completeJob(supabase: any, jobId: string, rowsProcessed: number, datasetId: string | null): Promise<void> {
  await supabase
    .from("import_jobs")
    .update({
      status: "completed",
      progress: 100,
      rows_processed: rowsProcessed,
      finished_at: new Date().toISOString(),
      dataset_id: datasetId,
    })
    .eq("id", jobId);
}

async function createDatasetRecord(
  supabase: any,
  projectId: string,
  userId: string,
  name: string,
  storagePath: string,
  fileSizeBytes: number,
  totalRows: number,
  sampleRows: number,
  columnsCount: number,
  sourceType: string,
  sourceMetadata: Record<string, unknown>,
): Promise<string | null> {
  try {
    // Deactivate any existing active datasets for this project
    await supabase
      .from("project_datasets")
      .update({ is_active: false })
      .eq("project_id", projectId)
      .eq("is_active", true);

    const { data, error } = await supabase
      .from("project_datasets")
      .insert({
        project_id: projectId,
        user_id: userId,
        name,
        storage_path: storagePath,
        file_size_bytes: fileSizeBytes,
        total_rows: totalRows,
        sample_rows: sampleRows,
        columns_count: columnsCount,
        is_active: true,
        source_type: sourceType,
        source_metadata: sourceMetadata,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[process-import] Failed to create dataset record:", error);
      return null;
    }

    return data.id;
  } catch (e) {
    console.error("[process-import] Error creating dataset record:", e);
    return null;
  }
}

function makeTextDecoder(encoding: string): TextDecoder {
  const encodingMap: Record<string, string> = {
    "ISO-8859-1": "iso-8859-1",
    "Windows-1252": "windows-1252",
    "UTF-8": "utf-8",
  };
  return new TextDecoder(encodingMap[encoding] || "utf-8");
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Efficient file sampling using Range requests.
 * Only reads up to SAMPLE_BYTES_LIMIT to get headers + sample rows.
 * Estimates total row count from average bytes per row.
 */
async function processFileSampling(
  supabase: any,
  job: ImportJob,
  isFirstInBatch: boolean,
  primaryHeaders: string[] | null,
  onProgress?: (progress: number, rowsRead: number) => Promise<void>,
): Promise<{
  success: boolean;
  headers: string[];
  estimatedRowCount: number;
  sampleRows: Record<string, unknown>[];
  bytesPerRow: number;
  error?: string;
}> {
  let res: Response;

  try {
    const { data, error } = await supabase.storage.from("big_imports").createSignedUrl(job.storage_path, 60 * 60);

    if (error || !data?.signedUrl) {
      throw new Error(`Falha ao gerar URL assinada: ${error?.message || "erro desconhecido"}`);
    }

    // Use Range header to only fetch first SAMPLE_BYTES_LIMIT bytes
    const bytesToFetch = Math.min(job.file_size_bytes, SAMPLE_BYTES_LIMIT);
    res = await fetch(data.signedUrl, {
      headers: {
        "Accept-Encoding": "identity",
        Range: `bytes=0-${bytesToFetch - 1}`,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro ao preparar download do arquivo";
    return { success: false, headers: [], estimatedRowCount: 0, sampleRows: [], bytesPerRow: 0, error: msg };
  }

  if (!res.ok && res.status !== 206) {
    return {
      success: false,
      headers: [],
      estimatedRowCount: 0,
      sampleRows: [],
      bytesPerRow: 0,
      error: `Falha ao baixar arquivo: ${job.storage_path}. HTTP ${res.status}`,
    };
  }

  if (!res.body) {
    return {
      success: false,
      headers: [],
      estimatedRowCount: 0,
      sampleRows: [],
      bytesPerRow: 0,
      error: "Resposta sem body",
    };
  }

  console.log(
    `[process-import] Sampling file: ${job.file_name}, size: ${(job.file_size_bytes / 1024 / 1024).toFixed(2)} MB, delimiter: "${job.delimiter}"`,
  );

  const delimiter = job.delimiter || ",";
  const encoding = job.encoding || "UTF-8";
  const decoder = makeTextDecoder(encoding);

  let headers: string[] = [];
  let rowCount = 0;
  const sampleRows: Record<string, unknown>[] = [];
  let isHeaderLine = true;
  let totalBytesRead = 0;
  let bytesForRows = 0;
  let lastProgressUpdate = Date.now();

  const reader = res.body.getReader();
  let leftover = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytesRead += value.byteLength;

      const text = decoder.decode(value, { stream: true });
      leftover += text;

      let nlIndex = -1;
      while ((nlIndex = leftover.indexOf("\n")) !== -1) {
        const rawLine = leftover.slice(0, nlIndex);
        leftover = leftover.slice(nlIndex + 1);

        const line = rawLine.replace(/\r$/, "");
        if (!line.trim()) continue;

        if (isHeaderLine) {
          headers = parseCSVLine(line, delimiter);
          isHeaderLine = false;
          
          console.log(`[process-import] Parsed ${headers.length} headers with delimiter "${delimiter}"`);

          if (!isFirstInBatch && primaryHeaders) {
            const comparison = compareHeaders(primaryHeaders, headers);
            if (!comparison.compatible) {
              return {
                success: false,
                headers: [],
                estimatedRowCount: 0,
                sampleRows: [],
                bytesPerRow: 0,
                error: `Colunas incompatíveis: ${comparison.message}`,
              };
            }
          }
          continue;
        }

        rowCount++;
        bytesForRows += rawLine.length + 1;

        if (sampleRows.length < SAMPLE_SIZE) {
          const values = parseCSVLine(line, delimiter);
          const row: Record<string, unknown> = {};
          const headersToUse = primaryHeaders || headers;
          headersToUse.forEach((h, idx) => {
            row[h] = values[idx] ?? null;
          });
          sampleRows.push(row);
        }

        // Report progress periodically
        if (onProgress && Date.now() - lastProgressUpdate > 500) {
          const progress = Math.round((totalBytesRead / job.file_size_bytes) * 100);
          await onProgress(Math.min(progress, 90), rowCount);
          lastProgressUpdate = Date.now();
        }

        // Stop if we have enough samples
        if (sampleRows.length >= SAMPLE_SIZE && rowCount >= SAMPLE_SIZE) {
          break;
        }
      }

      if (sampleRows.length >= SAMPLE_SIZE) {
        break;
      }
    }

    // Flush remaining
    leftover += decoder.decode();
    if (leftover.trim() && !isHeaderLine) {
      const line = leftover.replace(/\r$/, "");
      if (line.trim()) {
        rowCount++;
        bytesForRows += line.length;
        if (sampleRows.length < SAMPLE_SIZE) {
          const values = parseCSVLine(line, delimiter);
          const row: Record<string, unknown> = {};
          const headersToUse = primaryHeaders || headers;
          headersToUse.forEach((h, idx) => {
            row[h] = values[idx] ?? null;
          });
          sampleRows.push(row);
        }
      }
    }

    // Calculate average bytes per row and estimate total
    const avgBytesPerRow = rowCount > 0 ? bytesForRows / rowCount : 100;
    
    let estimatedRowCount: number;
    if (job.file_size_bytes <= totalBytesRead) {
      estimatedRowCount = rowCount;
    } else {
      const headerBytes = totalBytesRead - bytesForRows;
      const dataBytesTotal = job.file_size_bytes - headerBytes;
      estimatedRowCount = Math.round(dataBytesTotal / avgBytesPerRow);
    }

    console.log(
      `[process-import] Sampled ${rowCount} rows from ${(totalBytesRead / 1024 / 1024).toFixed(2)} MB. ` +
        `Avg ${avgBytesPerRow.toFixed(1)} bytes/row. Estimated total: ${estimatedRowCount.toLocaleString()} rows. Columns: ${headers.length}`,
    );

    return {
      success: true,
      headers,
      estimatedRowCount,
      sampleRows,
      bytesPerRow: avgBytesPerRow,
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "Erro ao processar arquivo";
    return { success: false, headers: [], estimatedRowCount: 0, sampleRows: [], bytesPerRow: 0, error: errorMessage };
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
}

async function processBatchImport(supabase: any, primaryJob: ImportJob): Promise<Response> {
  console.log(`[process-import] Processing batch: ${primaryJob.batch_id}`);

  // Fetch all jobs in batch, ordered by sequence
  const { data: batchJobs, error: batchError } = await supabase
    .from("import_jobs")
    .select("*")
    .eq("batch_id", primaryJob.batch_id)
    .order("batch_sequence", { ascending: true });

  if (batchError || !batchJobs || batchJobs.length === 0) {
    console.error(`[process-import] Failed to fetch batch jobs`, batchError);
    await updateJobError(supabase, primaryJob.id, "Falha ao buscar jobs do lote.");
    return new Response(JSON.stringify({ success: false, message: "Failed to fetch batch jobs" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Validate total batch size
  const totalBatchSize = batchJobs.reduce((sum: number, j: ImportJob) => sum + j.file_size_bytes, 0);
  if (totalBatchSize > MAX_FILE_SIZE_BYTES) {
    const maxGB = (MAX_FILE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(0);
    for (const job of batchJobs) {
      await updateJobError(supabase, job.id, `Lote excede o limite total de ${maxGB} GB.`);
    }
    return new Response(JSON.stringify({ success: false, message: `Batch exceeds ${maxGB} GB limit` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log(
    `[process-import] Found ${batchJobs.length} files in batch, total size: ${(totalBatchSize / 1024 / 1024).toFixed(2)} MB`,
  );

  let primaryHeaders: string[] | null = null;
  let totalRowsEstimated = 0;
  let allSampleRows: Record<string, unknown>[] = [];
  const processedJobIds: string[] = [];
  const failedJobs: { id: string; fileName: string; error: string }[] = [];
  const processedFilePaths: string[] = [];
  let totalFileSizeBytes = 0;

  // Batch datasets stored in a folder: user_id/project_id/batch_id/
  const batchFolder = `${primaryJob.user_id}/${primaryJob.project_id}/${primaryJob.batch_id}`;

  // Calculate samples per file proportionally based on file size
  const fileSizes = batchJobs.map((j: ImportJob) => j.file_size_bytes);
  const totalSize = fileSizes.reduce((a: number, b: number) => a + b, 0);
  const samplesPerFile = batchJobs.map((j: ImportJob) => 
    Math.max(100, Math.ceil((j.file_size_bytes / totalSize) * SAMPLE_SIZE))
  );

  for (let i = 0; i < batchJobs.length; i++) {
    const job = batchJobs[i] as ImportJob;
    const isFirst = i === 0;

    console.log(`[process-import] Processing file ${i + 1}/${batchJobs.length}: ${job.file_name}`);

    // Mark job as processing with 0%
    await supabase.from("import_jobs").update({ 
      status: "processing", 
      progress: 0,
      updated_at: new Date().toISOString()
    }).eq("id", job.id);

    // Progress callback for this job
    const progressCallback = async (progress: number, rows: number) => {
      await updateJobProgress(supabase, job.id, progress, rows);
    };

    const result = await processFileSampling(supabase, job, isFirst, primaryHeaders, progressCallback);

    if (!result.success) {
      console.error(`[process-import] Error processing file ${job.file_name}:`, result.error);
      failedJobs.push({ id: job.id, fileName: job.file_name, error: result.error || "Erro desconhecido" });
      await updateJobError(supabase, job.id, result.error || "Erro desconhecido");
      continue;
    }

    if (isFirst) {
      primaryHeaders = result.headers;
      await supabase.from("import_jobs").update({ headers_json: result.headers }).eq("id", job.id);
    }

    totalRowsEstimated += result.estimatedRowCount;

    // Collect samples proportionally from each file
    const maxSamplesFromThisFile = samplesPerFile[i];
    const samplesToAdd = result.sampleRows.slice(0, maxSamplesFromThisFile);
    if (allSampleRows.length < SAMPLE_SIZE) {
      allSampleRows = allSampleRows.concat(samplesToAdd.slice(0, SAMPLE_SIZE - allSampleRows.length));
    }

    // Copy file to datasets bucket
    const sanitizedFileName = sanitizeFileName(job.file_name);
    const destPath = `${batchFolder}/${sanitizedFileName}`;

    try {
      const { error: copyError } = await supabase.storage
        .from("big_imports")
        .copy(job.storage_path, destPath, { destinationBucket: "datasets" });

      if (copyError) {
        // Try to handle "already exists" gracefully
        if (!copyError.message?.includes("already exists")) {
          throw copyError;
        }
        console.log(`[process-import] File already exists in datasets: ${destPath}`);
      }

      processedFilePaths.push(destPath);
      totalFileSizeBytes += job.file_size_bytes;

      console.log(`[process-import] Copied ${job.file_name} to datasets: ${destPath}`);
    } catch (copyErr: any) {
      const errMsg = copyErr?.message || "Falha ao copiar arquivo para o storage do dataset.";
      console.warn(`[process-import] Failed to copy ${job.file_name} to datasets:`, copyErr);
      failedJobs.push({ id: job.id, fileName: job.file_name, error: errMsg });
      await updateJobError(supabase, job.id, errMsg);
      continue;
    }

    processedJobIds.push(job.id);

    // Mark this job as completed with 100%
    await completeJob(supabase, job.id, result.estimatedRowCount, null);

    console.log(
      `[process-import] File ${job.file_name} completed: ~${result.estimatedRowCount.toLocaleString()} rows (estimated)`,
    );
  }

  // If no files processed successfully, fail
  if (processedJobIds.length === 0 || !primaryHeaders) {
    const errMsg = failedJobs.length > 0 
      ? `Todos os arquivos falharam: ${failedJobs[0].error}` 
      : "Nenhum arquivo processado com sucesso";
    
    await updateJobError(supabase, primaryJob.id, errMsg);
    return new Response(JSON.stringify({ 
      success: false, 
      message: errMsg,
      failed_files: failedJobs 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Finalize batch: infer column types and update project
  const columnTypes = inferColumnTypes(primaryHeaders, allSampleRows);

  // Clear existing columns and insert new ones
  await supabase.from("project_columns").delete().eq("project_id", primaryJob.project_id);

  const columnInserts = primaryHeaders.map((name, index) => ({
    project_id: primaryJob.project_id,
    column_name: name,
    column_index: index,
    inferred_type: columnTypes[name] || "texto",
  }));

  await supabase.from("project_columns").insert(columnInserts);

  // Create dataset record with batch folder as storage_path
  const datasetPath = batchFolder;
  const sampleRowsCount = Math.min(allSampleRows.length, SAMPLE_SIZE);

  const datasetId = await createDatasetRecord(
    supabase,
    primaryJob.project_id,
    primaryJob.user_id,
    primaryJob.file_name,
    datasetPath,
    totalFileSizeBytes,
    totalRowsEstimated,
    sampleRowsCount,
    primaryHeaders.length,
    processedJobIds.length > 1 ? "batch_import" : "upload",
    {
      batch_id: primaryJob.batch_id,
      files_count: batchJobs.length,
      files_processed: processedJobIds.length,
      files_failed: failedJobs.length,
      file_paths: processedFilePaths,
      file_names: batchJobs.map((j: ImportJob) => j.file_name),
      rows_estimated: true,
      delimiter: primaryJob.delimiter,
      encoding: primaryJob.encoding,
    },
  );

  // Link dataset to all jobs
  if (datasetId) {
    await supabase.from("import_jobs").update({ dataset_id: datasetId }).eq("batch_id", primaryJob.batch_id);
  }

  // Update project with consolidated info
  await supabase
    .from("projects")
    .update({
      dataset_filename: datasetPath,
      dataset_rows: sampleRowsCount,
      dataset_columns: primaryHeaders.length,
      total_rows: totalRowsEstimated,
      sample_rows: sampleRowsCount,
      status: "data_uploaded",
    })
    .eq("id", primaryJob.project_id);

  // Log ingestion
  await supabase.from("project_data_ingestion_logs").insert({
    project_id: primaryJob.project_id,
    status: failedJobs.length > 0 ? "partial" : "success",
    rows_read: totalRowsEstimated,
    rows_sampled: sampleRowsCount,
    completed_at: new Date().toISOString(),
    metadata: {
      batch_id: primaryJob.batch_id,
      files_processed: processedJobIds.length,
      files_failed: failedJobs.length,
      failed_files: failedJobs.map((f) => ({ name: f.fileName, error: f.error })),
      dataset_path: datasetPath,
      dataset_id: datasetId,
      file_paths: processedFilePaths,
      total_rows: totalRowsEstimated,
      rows_estimated: true,
    },
  });

  const responseMessage =
    failedJobs.length > 0
      ? `Importação parcial: ${processedJobIds.length} arquivos ok, ${failedJobs.length} com erro`
      : `Batch importado com sucesso: ${processedJobIds.length} arquivos, ~${totalRowsEstimated.toLocaleString()} linhas (estimado)`;

  console.log(`[process-import] Batch ${primaryJob.batch_id} completed. ${responseMessage}`);

  return new Response(
    JSON.stringify({
      success: processedJobIds.length > 0,
      message: responseMessage,
      rows_processed: totalRowsEstimated,
      files_processed: processedJobIds.length,
      files_failed: failedJobs.length,
      failed_files: failedJobs,
      rows_estimated: true,
      dataset_id: datasetId,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function processSingleImport(supabase: any, job: ImportJob): Promise<Response> {
  const job_id = job.id;

  await supabase.from("import_jobs").update({ 
    status: "processing", 
    progress: 0,
    updated_at: new Date().toISOString()
  }).eq("id", job_id);

  console.log(`[process-import] Job ${job_id} set to processing`);

  try {
    // Progress callback
    const progressCallback = async (progress: number, rows: number) => {
      await updateJobProgress(supabase, job_id, progress, rows);
    };

    const result = await processFileSampling(supabase, job, true, null, progressCallback);

    if (!result.success) {
      await updateJobError(supabase, job_id, result.error || "Erro ao processar arquivo");
      return new Response(JSON.stringify({ success: false, message: result.error }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { headers, estimatedRowCount, sampleRows } = result;

    if (headers.length === 0) {
      await updateJobError(supabase, job_id, "Não foi possível detectar colunas no arquivo.");
      return new Response(JSON.stringify({ success: false, message: "Could not parse headers" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(
      `[process-import] Processed ~${estimatedRowCount.toLocaleString()} rows (estimated), ${sampleRows.length} samples, ${headers.length} columns`,
    );

    const columnTypes = inferColumnTypes(headers, sampleRows);

    await supabase.from("project_columns").delete().eq("project_id", job.project_id);

    const columnInserts = headers.map((name, index) => ({
      project_id: job.project_id,
      column_name: name,
      column_index: index,
      inferred_type: columnTypes[name] || "texto",
    }));

    await supabase.from("project_columns").insert(columnInserts);

    // Copy file to datasets bucket
    const sanitizedFileName = sanitizeFileName(job.file_name);
    const datasetPath = `${job.user_id}/${job.project_id}/${sanitizedFileName}`;

    console.log(`[process-import] Copying to datasets bucket: ${datasetPath}`);

    const { error: copyError } = await supabase.storage
      .from("big_imports")
      .copy(job.storage_path, datasetPath, { destinationBucket: "datasets" });

    if (copyError && !copyError.message?.includes("already exists")) {
      console.error("[process-import] Error copying to datasets:", copyError);
    } else {
      console.log("[process-import] File copied to datasets bucket");
    }

    const sampleRowsCount = Math.min(sampleRows.length, SAMPLE_SIZE);

    const datasetId = await createDatasetRecord(
      supabase,
      job.project_id,
      job.user_id,
      job.file_name,
      datasetPath,
      job.file_size_bytes,
      estimatedRowCount,
      sampleRowsCount,
      headers.length,
      "upload",
      { 
        original_path: job.storage_path, 
        rows_estimated: true,
        delimiter: job.delimiter,
        encoding: job.encoding,
      },
    );

    // Update project
    await supabase
      .from("projects")
      .update({
        dataset_filename: datasetPath,
        dataset_rows: sampleRowsCount,
        dataset_columns: headers.length,
        total_rows: estimatedRowCount,
        sample_rows: sampleRowsCount,
        status: "data_uploaded",
      })
      .eq("id", job.project_id);

    // Log ingestion
    await supabase.from("project_data_ingestion_logs").insert({
      project_id: job.project_id,
      status: "success",
      rows_read: estimatedRowCount,
      rows_sampled: sampleRowsCount,
      completed_at: new Date().toISOString(),
      metadata: {
        file_name: job.file_name,
        storage_path: job.storage_path,
        dataset_path: datasetPath,
        dataset_id: datasetId,
        rows_estimated: true,
      },
    });

    // Complete job with 100%
    await completeJob(supabase, job_id, estimatedRowCount, datasetId);

    console.log(`[process-import] Job ${job_id} completed successfully`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Importação concluída: ~${estimatedRowCount.toLocaleString()} linhas (estimado)`,
        rows_processed: estimatedRowCount,
        columns: headers.length,
        dataset_id: datasetId,
        rows_estimated: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[process-import] Error processing job ${job_id}:`, errorMessage);
    await updateJobError(supabase, job_id, errorMessage);
    return new Response(JSON.stringify({ success: false, message: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function compareHeaders(primary: string[], current: string[]): { compatible: boolean; message: string } {
  if (primary.length !== current.length) {
    return {
      compatible: false,
      message: `Número de colunas diferente: esperado ${primary.length}, encontrado ${current.length}`,
    };
  }

  const mismatches: string[] = [];
  for (let i = 0; i < primary.length; i++) {
    if (primary[i].toLowerCase() !== current[i].toLowerCase()) {
      mismatches.push(`"${primary[i]}" vs "${current[i]}"`);
    }
  }

  if (mismatches.length > 0) {
    return {
      compatible: false,
      message: `Colunas diferentes: ${mismatches.slice(0, 3).join(", ")}${mismatches.length > 3 ? "..." : ""}`,
    };
  }

  return { compatible: true, message: "" };
}

function inferColumnTypes(headers: string[], sampleRows: Record<string, unknown>[]): Record<string, string> {
  const types: Record<string, string> = {};

  for (const header of headers) {
    const values = sampleRows
      .map((row) => row[header])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== "");

    if (values.length === 0) {
      types[header] = "texto";
      continue;
    }

    const numericCount = values.filter((v) => {
      const str = String(v).replace(",", ".").trim();
      return !isNaN(Number(str)) && str !== "";
    }).length;

    if (numericCount >= values.length * 0.8) {
      types[header] = "numérico";
      continue;
    }

    const datePatterns = [/^\d{4}-\d{2}-\d{2}/, /^\d{2}\/\d{2}\/\d{4}/, /^\d{2}-\d{2}-\d{4}/];
    const dateCount = values.filter((v) => datePatterns.some((p) => p.test(String(v)))).length;

    if (dateCount >= values.length * 0.8) {
      types[header] = "data";
      continue;
    }

    const uniqueValues = new Set(values.map((v) => String(v)));
    if (uniqueValues.size <= Math.min(20, values.length * 0.1)) {
      types[header] = "categórico";
      continue;
    }

    types[header] = "texto";
  }

  return types;
}
