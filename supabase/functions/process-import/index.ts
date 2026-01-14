import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Configuration
const MAX_ROWS = 100000000; // 100M rows max
const SAMPLE_SIZE = 10000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const PROGRESS_UPDATE_INTERVAL = 50000; // Update progress every 50K rows
const CHUNK_SIZE = 64 * 1024; // 64KB chunks for reading

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
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { job_id, batch_id } = await req.json();

    if (!job_id) {
      return new Response(
        JSON.stringify({ success: false, message: 'job_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-import] Starting import job: ${job_id}, batch_id: ${batch_id || 'none'}`);

    // Fetch the import job
    const { data: job, error: jobError } = await supabase
      .from('import_jobs')
      .select('*')
      .eq('id', job_id)
      .single();

    if (jobError || !job) {
      console.error(`[process-import] Job not found: ${job_id}`, jobError);
      return new Response(
        JSON.stringify({ success: false, message: 'Import job not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (job.status !== 'pending') {
      console.log(`[process-import] Job ${job_id} is already ${job.status}`);
      return new Response(
        JSON.stringify({ success: true, message: `Job is already ${job.status}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate file size
    if (job.file_size_bytes > MAX_FILE_SIZE_BYTES) {
      const maxGB = (MAX_FILE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(0);
      await updateJobError(supabase, job_id, `Arquivo excede o limite de ${maxGB} GB.`);
      return new Response(
        JSON.stringify({ success: false, message: `File exceeds ${maxGB} GB limit` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // If this is a batch import, process all files in sequence
    if (job.batch_id) {
      return await processBatchImport(supabase, job as ImportJob);
    } else {
      return await processSingleImport(supabase, job as ImportJob);
    }

  } catch (error: unknown) {
    console.error('[process-import] Unexpected error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ success: false, message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function updateJobProgress(
  supabase: any, 
  jobId: string, 
  progress: number, 
  rowsProcessed: number
): Promise<void> {
  try {
    await supabase
      .from('import_jobs')
      .update({ progress, rows_processed: rowsProcessed, updated_at: new Date().toISOString() })
      .eq('id', jobId);
  } catch (e) {
    console.warn(`[process-import] Failed to update progress for job ${jobId}:`, e);
  }
}

async function updateJobError(
  supabase: any, 
  jobId: string, 
  errorMessage: string
): Promise<void> {
  await supabase
    .from('import_jobs')
    .update({ 
      status: 'failed', 
      error_message: errorMessage,
      finished_at: new Date().toISOString()
    })
    .eq('id', jobId);
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
  sourceMetadata: Record<string, unknown>
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('project_datasets')
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
      .select('id')
      .single();

    if (error) {
      console.error('[process-import] Failed to create dataset record:', error);
      return null;
    }

    return data.id;
  } catch (e) {
    console.error('[process-import] Error creating dataset record:', e);
    return null;
  }
}

// Stream-based line reader that doesn't load entire file in memory
async function* readLinesFromStream(
  stream: ReadableStream<Uint8Array>,
  encoding: string,
  bytesCounter: { bytes: number },
): AsyncGenerator<string> {
  const decoder = new TextDecoder(
    encoding === 'ISO-8859-1'
      ? 'iso-8859-1'
      : encoding === 'Windows-1252'
        ? 'windows-1252'
        : 'utf-8',
  );

  const reader = stream.getReader();
  let leftover = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!value) continue;

      bytesCounter.bytes += value.byteLength;

      const text = decoder.decode(value, { stream: true });
      const lines = (leftover + text).split('\n');
      leftover = lines.pop() || '';

      for (const line of lines) {
        const cleaned = line.replace(/\r$/, '');
        if (cleaned.trim()) {
          yield cleaned;
        }
      }
    }

    // Flush decoder
    const flushed = decoder.decode();
    if (flushed) leftover += flushed;

    const last = leftover.replace(/\r$/, '');
    if (last.trim()) {
      yield last;
    }
  } finally {
    reader.releaseLock();
  }
}

function makeTextDecoder(encoding: string): TextDecoder {
  return new TextDecoder(
    encoding === 'ISO-8859-1'
      ? 'iso-8859-1'
      : encoding === 'Windows-1252'
        ? 'windows-1252'
        : 'utf-8',
  );
}

function countNewlines(chunk: Uint8Array): number {
  // Count '\n' bytes (0x0A). Works for UTF-8 and most single-byte encodings.
  let c = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === 10) c++;
  }
  return c;
}

// Process a single file and return stats without loading entire content
// Optimized to avoid per-row CSV parsing on huge files (prevents WORKER_LIMIT)
async function processFileStreaming(
  supabase: any,
  job: ImportJob,
  isFirstInBatch: boolean,
  primaryHeaders: string[] | null,
  totalBytesInBatch: number,
): Promise<{
  success: boolean;
  headers: string[];
  rowCount: number;
  sampleRows: Record<string, unknown>[];
  error?: string;
}> {
  let res: Response;
  try {
    const signedUrl = await getSignedDownloadUrl(supabase, job.storage_path);
    res = await fetch(signedUrl, { headers: { 'Accept-Encoding': 'identity' } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro ao preparar download do arquivo';
    return { success: false, headers: [], rowCount: 0, sampleRows: [], error: msg };
  }

  if (!res.ok || !res.body) {
    return {
      success: false,
      headers: [],
      rowCount: 0,
      sampleRows: [],
      error: `Falha ao baixar arquivo: ${job.storage_path}. HTTP ${res.status}`,
    };
  }

  console.log(
    `[process-import] Streaming file: ${job.file_name}, size: ${(job.file_size_bytes / 1024 / 1024).toFixed(2)} MB`,
  );

  const delimiter = job.delimiter || ',';
  const encoding = job.encoding || 'UTF-8';
  const decoder = makeTextDecoder(encoding);

  // Progress updates by bytes are much cheaper than per-row updates.
  const PROGRESS_UPDATE_BYTES = 32 * 1024 * 1024; // 32MB

  let headers: string[] = [];
  let rowCount = 0;
  const sampleRows: Record<string, unknown>[] = [];
  let isHeaderLine = true;

  const bytesCounter = { bytes: 0 };
  let lastProgressBytes = 0;

  const reader = res.body.getReader();
  let leftover = '';
  let samplingComplete = false;
  let lastByteWasNewline = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytesCounter.bytes += value.byteLength;
      lastByteWasNewline = value[value.length - 1] === 10;

      if (!samplingComplete) {
        // Decode only until we have headers + SAMPLE_SIZE rows (for type inference).
        const text = decoder.decode(value, { stream: true });
        leftover += text;

        let nlIndex = -1;
        while ((nlIndex = leftover.indexOf('\n')) !== -1) {
          const rawLine = leftover.slice(0, nlIndex);
          leftover = leftover.slice(nlIndex + 1);

          const line = rawLine.replace(/\r$/, '');
          if (!line.trim()) continue;

          if (isHeaderLine) {
            headers = parseCSVLine(line, delimiter);
            isHeaderLine = false;

            // Validate headers if not first file
            if (!isFirstInBatch && primaryHeaders) {
              const comparison = compareHeaders(primaryHeaders, headers);
              if (!comparison.compatible) {
                return {
                  success: false,
                  headers: [],
                  rowCount: 0,
                  sampleRows: [],
                  error: `Colunas incompatíveis: ${comparison.message}`,
                };
              }
            }

            continue;
          }

          rowCount++;

          if (sampleRows.length < SAMPLE_SIZE) {
            const values = parseCSVLine(line, delimiter);
            const row: Record<string, unknown> = {};
            const headersToUse = primaryHeaders || headers;
            headersToUse.forEach((h, idx) => {
              row[h] = values[idx] ?? null;
            });
            sampleRows.push(row);
          }

          if (sampleRows.length >= SAMPLE_SIZE) {
            // From here on, stop decoding/parsing; only count newlines in raw bytes.
            samplingComplete = true;

            // Account for any complete lines already buffered in leftover (without parsing them).
            const extraLines = (leftover.match(/\n/g) || []).length;
            rowCount += extraLines;
            leftover = '';
            break;
          }
        }
      } else {
        // Cheap counting: count '\n' bytes only (no decoding, no CSV parsing)
        rowCount += countNewlines(value);
      }

      if (bytesCounter.bytes - lastProgressBytes >= PROGRESS_UPDATE_BYTES) {
        const denom = job.file_size_bytes > 0 ? job.file_size_bytes : 1;
        const progress = Math.min(Math.floor((bytesCounter.bytes / denom) * 95), 95);
        await updateJobProgress(supabase, job.id, progress, rowCount);
        lastProgressBytes = bytesCounter.bytes;
      }

      // Basic safety guard
      if (rowCount > MAX_ROWS) {
        return {
          success: false,
          headers,
          rowCount,
          sampleRows,
          error: `Arquivo excede o limite de ${MAX_ROWS.toLocaleString()} linhas.`,
        };
      }
    }

    // Flush decoder if we never switched to counting-only mode
    if (!samplingComplete) {
      leftover += decoder.decode();

      const tail = leftover.replace(/\r$/, '');
      if (tail.trim()) {
        if (isHeaderLine) {
          headers = parseCSVLine(tail, delimiter);
        } else {
          rowCount++;
          if (sampleRows.length < SAMPLE_SIZE) {
            const values = parseCSVLine(tail, delimiter);
            const row: Record<string, unknown> = {};
            const headersToUse = primaryHeaders || headers;
            headersToUse.forEach((h, idx) => {
              row[h] = values[idx] ?? null;
            });
            sampleRows.push(row);
          }
        }
      }
    } else {
      // If file doesn't end with a newline, newline-counting misses the last line.
      if (!lastByteWasNewline) {
        rowCount += 1;
      }
    }

    return { success: true, headers, rowCount, sampleRows };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Erro ao processar arquivo';
    return { success: false, headers, rowCount, sampleRows, error: errorMessage };
  } finally {
    reader.releaseLock();
  }
}

async function processBatchImport(supabase: any, primaryJob: ImportJob): Promise<Response> {
  console.log(`[process-import] Processing batch: ${primaryJob.batch_id}`);

  // Get all jobs in this batch, ordered by sequence
  const { data: batchJobs, error: batchError } = await supabase
    .from('import_jobs')
    .select('*')
    .eq('batch_id', primaryJob.batch_id)
    .order('batch_sequence', { ascending: true });

  if (batchError || !batchJobs || batchJobs.length === 0) {
    console.error(`[process-import] Failed to fetch batch jobs`, batchError);
    await updateJobError(supabase, primaryJob.id, 'Falha ao buscar jobs do lote.');
    return new Response(
      JSON.stringify({ success: false, message: 'Failed to fetch batch jobs' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Validate total batch size
  const totalBatchSize = batchJobs.reduce((sum: number, j: ImportJob) => sum + j.file_size_bytes, 0);
  if (totalBatchSize > MAX_FILE_SIZE_BYTES) {
    const maxGB = (MAX_FILE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(0);
    for (const job of batchJobs) {
      await updateJobError(supabase, job.id, `Lote excede o limite total de ${maxGB} GB.`);
    }
    return new Response(
      JSON.stringify({ success: false, message: `Batch exceeds ${maxGB} GB limit` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[process-import] Found ${batchJobs.length} files in batch, total size: ${(totalBatchSize / 1024 / 1024).toFixed(2)} MB`);

  let primaryHeaders: string[] | null = null;
  let totalRowsProcessed = 0;
  let allSampleRows: Record<string, unknown>[] = [];
  const processedJobIds: string[] = [];
  const failedJobs: { id: string; fileName: string; error: string }[] = [];
  
  // We'll copy each file to datasets bucket individually, then store paths
  const processedFilePaths: string[] = [];
  let totalFileSizeBytes = 0;

  for (let i = 0; i < batchJobs.length; i++) {
    const job = batchJobs[i] as ImportJob;
    console.log(`[process-import] Processing file ${i + 1}/${batchJobs.length}: ${job.file_name}`);

    // Update job to processing
    await supabase
      .from('import_jobs')
      .update({ status: 'processing', progress: 0 })
      .eq('id', job.id);

    const isFirst = job.is_batch_primary;
    
    const result = await processFileStreaming(
      supabase,
      job,
      isFirst,
      primaryHeaders,
      totalBatchSize
    );

    if (!result.success) {
      console.error(`[process-import] Error processing file ${job.file_name}:`, result.error);
      failedJobs.push({ id: job.id, fileName: job.file_name, error: result.error || 'Erro desconhecido' });
      await updateJobError(supabase, job.id, result.error || 'Erro desconhecido');
      continue;
    }

    if (isFirst) {
      primaryHeaders = result.headers;
      await supabase
        .from('import_jobs')
        .update({ headers_json: result.headers })
        .eq('id', job.id);
    }

    totalRowsProcessed += result.rowCount;
    
    // Collect sample rows proportionally
    const samplesPerFile = Math.ceil(SAMPLE_SIZE / batchJobs.length);
    const samplesToAdd = result.sampleRows.slice(0, samplesPerFile);
    if (allSampleRows.length < SAMPLE_SIZE) {
      allSampleRows = allSampleRows.concat(samplesToAdd.slice(0, SAMPLE_SIZE - allSampleRows.length));
    }

    // Copy file to datasets bucket without downloading into memory
    const destPath = `${job.user_id}/${job.project_id}/${job.batch_id}/${job.file_name}`;

    try {
      const { error: copyError } = await supabase.storage
        .from('big_imports')
        .copy(job.storage_path, destPath, { destinationBucket: 'datasets' });

      if (!copyError) {
        processedFilePaths.push(destPath);
        totalFileSizeBytes += job.file_size_bytes;
      } else {
        console.warn(`[process-import] Failed to copy ${job.file_name} to datasets:`, copyError);
      }
    } catch (copyErr) {
      console.warn(`[process-import] Error copying file to datasets:`, copyErr);
    }

    processedJobIds.push(job.id);

    // Mark job as completed
    await supabase
      .from('import_jobs')
      .update({ 
        status: 'completed', 
        progress: 100,
        rows_processed: result.rowCount,
        finished_at: new Date().toISOString()
      })
      .eq('id', job.id);

    console.log(`[process-import] File ${job.file_name} completed: ${result.rowCount.toLocaleString()} rows`);
  }

  // If we have processed files, create the consolidated dataset record
  if (processedJobIds.length > 0 && primaryHeaders) {
    const columnTypes = inferColumnTypes(primaryHeaders, allSampleRows);

    // Delete existing columns for this project
    await supabase
      .from('project_columns')
      .delete()
      .eq('project_id', primaryJob.project_id);

    // Insert column metadata
    const columnInserts = primaryHeaders.map((name, index) => ({
      project_id: primaryJob.project_id,
      column_name: name,
      column_index: index,
      inferred_type: columnTypes[name] || 'texto'
    }));

    await supabase.from('project_columns').insert(columnInserts);

    // Dataset path - use the batch folder
    const datasetPath = `${primaryJob.user_id}/${primaryJob.project_id}/${primaryJob.batch_id}`;

    // Create dataset record in project_datasets
    const datasetId = await createDatasetRecord(
      supabase,
      primaryJob.project_id,
      primaryJob.user_id,
      primaryJob.file_name,
      datasetPath,
      totalFileSizeBytes,
      totalRowsProcessed,
      Math.min(allSampleRows.length, SAMPLE_SIZE),
      primaryHeaders.length,
      'batch_import',
      {
        batch_id: primaryJob.batch_id,
        files_count: batchJobs.length,
        files_processed: processedJobIds.length,
        files_failed: failedJobs.length,
        file_paths: processedFilePaths
      }
    );

    // Link dataset to jobs
    if (datasetId) {
      await supabase
        .from('import_jobs')
        .update({ dataset_id: datasetId })
        .eq('batch_id', primaryJob.batch_id);
    }

    // Update project with dataset info
    await supabase
      .from('projects')
      .update({
        dataset_filename: datasetPath,
        dataset_rows: Math.min(allSampleRows.length, SAMPLE_SIZE),
        dataset_columns: primaryHeaders.length,
        total_rows: totalRowsProcessed,
        sample_rows: Math.min(allSampleRows.length, SAMPLE_SIZE),
        status: 'data_uploaded'
      })
      .eq('id', primaryJob.project_id);

    // Log ingestion
    await supabase.from('project_data_ingestion_logs').insert({
      project_id: primaryJob.project_id,
      status: failedJobs.length > 0 ? 'partial' : 'success',
      rows_read: totalRowsProcessed,
      rows_sampled: Math.min(allSampleRows.length, SAMPLE_SIZE),
      completed_at: new Date().toISOString(),
      metadata: {
        batch_id: primaryJob.batch_id,
        files_processed: processedJobIds.length,
        files_failed: failedJobs.length,
        failed_files: failedJobs.map(f => ({ name: f.fileName, error: f.error })),
        dataset_path: datasetPath,
        dataset_id: datasetId,
        file_paths: processedFilePaths
      }
    });
  }

  const responseMessage = failedJobs.length > 0
    ? `Importação parcial: ${processedJobIds.length} arquivos ok, ${failedJobs.length} com erro`
    : `Batch importado com sucesso: ${processedJobIds.length} arquivos, ${totalRowsProcessed.toLocaleString()} linhas`;

  console.log(`[process-import] Batch ${primaryJob.batch_id} completed. ${responseMessage}`);

  return new Response(
    JSON.stringify({ 
      success: processedJobIds.length > 0, 
      message: responseMessage,
      rows_processed: totalRowsProcessed,
      files_processed: processedJobIds.length,
      files_failed: failedJobs.length,
      failed_files: failedJobs
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function processSingleImport(supabase: any, job: ImportJob): Promise<Response> {
  const job_id = job.id;
  
  // Update job to processing
  await supabase
    .from('import_jobs')
    .update({ status: 'processing', progress: 0 })
    .eq('id', job_id);

  console.log(`[process-import] Job ${job_id} set to processing`);

  try {
    const result = await processFileStreaming(supabase, job, true, null, job.file_size_bytes);

    if (!result.success) {
      await updateJobError(supabase, job_id, result.error || 'Erro ao processar arquivo');
      return new Response(
        JSON.stringify({ success: false, message: result.error }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { headers, rowCount, sampleRows } = result;

    if (headers.length === 0) {
      await updateJobError(supabase, job_id, 'Não foi possível detectar colunas no arquivo.');
      return new Response(
        JSON.stringify({ success: false, message: 'Could not parse headers' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-import] Processed ${rowCount.toLocaleString()} rows, ${sampleRows.length} samples, ${headers.length} columns`);

    const columnTypes = inferColumnTypes(headers, sampleRows);

    // Delete existing columns
    await supabase
      .from('project_columns')
      .delete()
      .eq('project_id', job.project_id);

    // Insert column metadata
    const columnInserts = headers.map((name, index) => ({
      project_id: job.project_id,
      column_name: name,
      column_index: index,
      inferred_type: columnTypes[name] || 'texto'
    }));

    await supabase.from('project_columns').insert(columnInserts);

    // Copy file to datasets bucket
    const datasetFileName = `${job.file_name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const datasetPath = `${job.user_id}/${job.project_id}/${datasetFileName}`;

    console.log(`[process-import] Copying to datasets bucket: ${datasetPath}`);

     // Copy file to datasets bucket without downloading into memory
     const { error: copyError } = await supabase.storage
       .from('big_imports')
       .copy(job.storage_path, datasetPath, { destinationBucket: 'datasets' });

     if (copyError) {
       console.error('[process-import] Error copying to datasets:', copyError);
     } else {
       console.log('[process-import] File copied to datasets bucket');
     }

    // Create dataset record
    const datasetId = await createDatasetRecord(
      supabase,
      job.project_id,
      job.user_id,
      job.file_name,
      datasetPath,
      job.file_size_bytes,
      rowCount,
      Math.min(sampleRows.length, SAMPLE_SIZE),
      headers.length,
      'upload',
      { original_path: job.storage_path }
    );

    // Link dataset to job
    if (datasetId) {
      await supabase
        .from('import_jobs')
        .update({ dataset_id: datasetId })
        .eq('id', job_id);
    }

    // Update project
    await supabase
      .from('projects')
      .update({
        dataset_filename: datasetPath,
        dataset_rows: Math.min(sampleRows.length, SAMPLE_SIZE),
        dataset_columns: headers.length,
        total_rows: rowCount,
        sample_rows: Math.min(sampleRows.length, SAMPLE_SIZE),
        status: 'data_uploaded'
      })
      .eq('id', job.project_id);

    // Log ingestion
    await supabase.from('project_data_ingestion_logs').insert({
      project_id: job.project_id,
      status: 'success',
      rows_read: rowCount,
      rows_sampled: Math.min(sampleRows.length, SAMPLE_SIZE),
      completed_at: new Date().toISOString(),
      metadata: { 
        file_name: job.file_name, 
        storage_path: job.storage_path,
        dataset_path: datasetPath,
        dataset_id: datasetId
      }
    });

    // Mark job as completed
    await supabase
      .from('import_jobs')
      .update({
        status: 'completed',
        progress: 100,
        rows_processed: rowCount,
        finished_at: new Date().toISOString(),
        dataset_id: datasetId
      })
      .eq('id', job_id);

    console.log(`[process-import] Job ${job_id} completed successfully`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Importação concluída: ${rowCount.toLocaleString()} linhas processadas`,
        rows_processed: rowCount,
        columns: headers.length,
        dataset_id: datasetId
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
    console.error(`[process-import] Error processing job ${job_id}:`, errorMessage);
    await updateJobError(supabase, job_id, errorMessage);
    return new Response(
      JSON.stringify({ success: false, message: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
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
      current = '';
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
      message: `Número de colunas diferente: esperado ${primary.length}, encontrado ${current.length}` 
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
      message: `Colunas diferentes: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? '...' : ''}` 
    };
  }

  return { compatible: true, message: '' };
}

function inferColumnTypes(headers: string[], sampleRows: Record<string, unknown>[]): Record<string, string> {
  const types: Record<string, string> = {};

  for (const header of headers) {
    const values = sampleRows
      .map(row => row[header])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '');

    if (values.length === 0) {
      types[header] = 'texto';
      continue;
    }

    // Check for numeric
    const numericCount = values.filter(v => {
      const str = String(v).replace(',', '.').trim();
      return !isNaN(Number(str)) && str !== '';
    }).length;

    if (numericCount >= values.length * 0.8) {
      types[header] = 'numérico';
      continue;
    }

    // Check for date
    const datePatterns = [
      /^\d{4}-\d{2}-\d{2}/,
      /^\d{2}\/\d{2}\/\d{4}/,
      /^\d{2}-\d{2}-\d{4}/,
    ];
    const dateCount = values.filter(v => 
      datePatterns.some(p => p.test(String(v)))
    ).length;

    if (dateCount >= values.length * 0.8) {
      types[header] = 'data';
      continue;
    }

    // Check for categorical (low cardinality)
    const uniqueValues = new Set(values.map(v => String(v)));
    if (uniqueValues.size <= Math.min(20, values.length * 0.1)) {
      types[header] = 'categórico';
      continue;
    }

    types[header] = 'texto';
  }

  return types;
}
