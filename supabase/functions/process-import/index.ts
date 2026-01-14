import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Configuration
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const SAMPLE_SIZE = 10000;
const SAMPLE_BYTES_LIMIT = 50 * 1024 * 1024; // Read up to 50MB for sampling (fast)

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
    await supabase
      .from("import_jobs")
      .update({ progress, rows_processed: rowsProcessed, updated_at: new Date().toISOString() })
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
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
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
  return new TextDecoder(
    encoding === "ISO-8859-1" ? "iso-8859-1" : encoding === "Windows-1252" ? "windows-1252" : "utf-8",
  );
}

/**
 * Sanitize filename for storage path - remove or replace invalid characters
 */
function sanitizeFileName(fileName: string): string {
  // Replace spaces, special chars with underscores, keep only safe chars
  return fileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * OPTIMIZED: Only reads up to SAMPLE_BYTES_LIMIT to collect headers + sample rows.
 * Estimates total row count from (file_size / avg_bytes_per_row).
 * This avoids CPU timeout on very large files.
 */
async function processFileSampling(
  supabase: any,
  job: ImportJob,
  isFirstInBatch: boolean,
  primaryHeaders: string[] | null,
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

  // IMPORTANT: Use the delimiter from the job
  const delimiter = job.delimiter || ",";
  const encoding = job.encoding || "UTF-8";
  const decoder = makeTextDecoder(encoding);

  let headers: string[] = [];
  let rowCount = 0;
  const sampleRows: Record<string, unknown>[] = [];
  let isHeaderLine = true;
  let totalBytesRead = 0;
  let bytesForRows = 0; // bytes used for data rows (excluding header)

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
        bytesForRows += rawLine.length + 1; // +1 for newline

        if (sampleRows.length < SAMPLE_SIZE) {
          const values = parseCSVLine(line, delimiter);
          const row: Record<string, unknown> = {};
          const headersToUse = primaryHeaders || headers;
          headersToUse.forEach((h, idx) => {
            row[h] = values[idx] ?? null;
          });
          sampleRows.push(row);
        }

        // We have enough samples, can stop early
        if (sampleRows.length >= SAMPLE_SIZE && rowCount >= SAMPLE_SIZE) {
          break;
        }
      }

      // Stop if we've collected enough
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
    
    // For files larger than what we sampled, estimate total rows
    let estimatedRowCount: number;
    if (job.file_size_bytes <= totalBytesRead) {
      // We read the whole file, actual count is accurate
      estimatedRowCount = rowCount;
    } else {
      // Estimate: header bytes + (data bytes / avg bytes per row)
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
    reader.releaseLock();
  }
}

async function processBatchImport(supabase: any, primaryJob: ImportJob): Promise<Response> {
  console.log(`[process-import] Processing batch: ${primaryJob.batch_id}`);

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

  // Always represent batch datasets as a folder (even if it contains only 1 file)
  const batchFolder = `${primaryJob.user_id}/${primaryJob.project_id}/${primaryJob.batch_id}`;

  // For visibility/debugging only
  let primaryFilePath: string | null = null;

  for (let i = 0; i < batchJobs.length; i++) {
    const job = batchJobs[i] as ImportJob;
    console.log(`[process-import] Processing file ${i + 1}/${batchJobs.length}: ${job.file_name}`);

    await supabase.from("import_jobs").update({ status: "processing", progress: 0 }).eq("id", job.id);

    const isFirst = i === 0 || job.is_batch_primary;

    const result = await processFileSampling(supabase, job, isFirst, primaryHeaders);

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

    // Collect sample rows proportionally
    const samplesPerFile = Math.ceil(SAMPLE_SIZE / batchJobs.length);
    const samplesToAdd = result.sampleRows.slice(0, samplesPerFile);
    if (allSampleRows.length < SAMPLE_SIZE) {
      allSampleRows = allSampleRows.concat(samplesToAdd.slice(0, SAMPLE_SIZE - allSampleRows.length));
    }

    // Copy file to datasets bucket under the batch folder (server-side copy, no download)
    const sanitizedFileName = sanitizeFileName(job.file_name);
    const destPath = `${batchFolder}/${sanitizedFileName}`;

    try {
      const { error: copyError } = await supabase.storage
        .from("big_imports")
        .copy(job.storage_path, destPath, { destinationBucket: "datasets" });

      if (copyError) {
        throw copyError;
      }

      processedFilePaths.push(destPath);
      totalFileSizeBytes += job.file_size_bytes;

      if (isFirst) {
        primaryFilePath = destPath;
      }

      console.log(`[process-import] Copied ${job.file_name} to datasets: ${destPath}`);
    } catch (copyErr: any) {
      const errMsg = copyErr?.message || "Falha ao copiar arquivo para o storage do dataset.";
      console.warn(`[process-import] Failed to copy ${job.file_name} to datasets:`, copyErr);
      failedJobs.push({ id: job.id, fileName: job.file_name, error: errMsg });
      await updateJobError(supabase, job.id, errMsg);
      continue;
    }

    processedJobIds.push(job.id);

    await supabase
      .from("import_jobs")
      .update({
        status: "completed",
        progress: 100,
        rows_processed: result.estimatedRowCount,
        finished_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    console.log(
      `[process-import] File ${job.file_name} completed: ~${result.estimatedRowCount.toLocaleString()} rows (estimated)`,
    );
  }

  // Finalize batch
  if (processedJobIds.length > 0 && primaryHeaders) {
    const columnTypes = inferColumnTypes(primaryHeaders, allSampleRows);

    await supabase.from("project_columns").delete().eq("project_id", primaryJob.project_id);

    const columnInserts = primaryHeaders.map((name, index) => ({
      project_id: primaryJob.project_id,
      column_name: name,
      column_index: index,
      inferred_type: columnTypes[name] || "texto",
    }));

    await supabase.from("project_columns").insert(columnInserts);

    // IMPORTANT: represent the batch dataset as a folder path that contains the batch files
    const datasetPath = batchFolder;

    const datasetId = await createDatasetRecord(
      supabase,
      primaryJob.project_id,
      primaryJob.user_id,
      primaryJob.file_name,
      datasetPath,
      totalFileSizeBytes,
      totalRowsEstimated,
      Math.min(allSampleRows.length, SAMPLE_SIZE),
      primaryHeaders.length,
      batchJobs.length === 1 ? "upload" : "batch_import",
      {
        batch_id: primaryJob.batch_id,
        files_count: batchJobs.length,
        files_processed: processedJobIds.length,
        files_failed: failedJobs.length,
        file_paths: processedFilePaths,
        rows_estimated: true,
        primary_file_path: primaryFilePath,
      },
    );

    if (datasetId) {
      await supabase.from("import_jobs").update({ dataset_id: datasetId }).eq("batch_id", primaryJob.batch_id);
    }

    await supabase
      .from("projects")
      .update({
        dataset_filename: datasetPath,
        dataset_rows: Math.min(allSampleRows.length, SAMPLE_SIZE),
        dataset_columns: primaryHeaders.length,
        total_rows: totalRowsEstimated,
        sample_rows: Math.min(allSampleRows.length, SAMPLE_SIZE),
        status: "data_uploaded",
      })
      .eq("id", primaryJob.project_id);

    await supabase.from("project_data_ingestion_logs").insert({
      project_id: primaryJob.project_id,
      status: failedJobs.length > 0 ? "partial" : "success",
      rows_read: totalRowsEstimated,
      rows_sampled: Math.min(allSampleRows.length, SAMPLE_SIZE),
      completed_at: new Date().toISOString(),
      metadata: {
        batch_id: primaryJob.batch_id,
        files_processed: processedJobIds.length,
        files_failed: failedJobs.length,
        failed_files: failedJobs.map((f) => ({ name: f.fileName, error: f.error })),
        dataset_path: datasetPath,
        dataset_id: datasetId,
        file_paths: processedFilePaths,
        rows_estimated: true,
      },
    });
  }

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
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function processSingleImport(supabase: any, job: ImportJob): Promise<Response> {
  const job_id = job.id;

  await supabase.from("import_jobs").update({ status: "processing", progress: 0 }).eq("id", job_id);

  console.log(`[process-import] Job ${job_id} set to processing`);

  try {
    const result = await processFileSampling(supabase, job, true, null);

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

    // Copy file to datasets bucket (server-side copy)
    const sanitizedFileName = sanitizeFileName(job.file_name);
    const datasetPath = `${job.user_id}/${job.project_id}/${sanitizedFileName}`;

    console.log(`[process-import] Copying to datasets bucket: ${datasetPath}`);

    const { error: copyError } = await supabase.storage
      .from("big_imports")
      .copy(job.storage_path, datasetPath, { destinationBucket: "datasets" });

    if (copyError) {
      console.error("[process-import] Error copying to datasets:", copyError);
    } else {
      console.log("[process-import] File copied to datasets bucket");
    }

    const datasetId = await createDatasetRecord(
      supabase,
      job.project_id,
      job.user_id,
      job.file_name,
      datasetPath,
      job.file_size_bytes,
      estimatedRowCount,
      Math.min(sampleRows.length, SAMPLE_SIZE),
      headers.length,
      "upload",
      { original_path: job.storage_path, rows_estimated: true },
    );

    if (datasetId) {
      await supabase.from("import_jobs").update({ dataset_id: datasetId }).eq("id", job_id);
    }

    await supabase
      .from("projects")
      .update({
        dataset_filename: datasetPath,
        dataset_rows: Math.min(sampleRows.length, SAMPLE_SIZE),
        dataset_columns: headers.length,
        total_rows: estimatedRowCount,
        sample_rows: Math.min(sampleRows.length, SAMPLE_SIZE),
        status: "data_uploaded",
      })
      .eq("id", job.project_id);

    await supabase.from("project_data_ingestion_logs").insert({
      project_id: job.project_id,
      status: "success",
      rows_read: estimatedRowCount,
      rows_sampled: Math.min(sampleRows.length, SAMPLE_SIZE),
      completed_at: new Date().toISOString(),
      metadata: {
        file_name: job.file_name,
        storage_path: job.storage_path,
        dataset_path: datasetPath,
        dataset_id: datasetId,
        rows_estimated: true,
      },
    });

    await supabase
      .from("import_jobs")
      .update({
        status: "completed",
        progress: 100,
        rows_processed: estimatedRowCount,
        finished_at: new Date().toISOString(),
        dataset_id: datasetId,
      })
      .eq("id", job_id);

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
