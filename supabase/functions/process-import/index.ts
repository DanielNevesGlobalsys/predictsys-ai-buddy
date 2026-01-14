import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Configuration
const MAX_ROWS = 10000000;
const SAMPLE_SIZE = 100000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const PROGRESS_UPDATE_INTERVAL = 5000; // Update progress every 5000 rows

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
        is_active: true, // New dataset becomes active
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
  
  // We'll concatenate all CSVs into one file in the datasets bucket
  let concatenatedContent = '';
  let isFirstFile = true;

  for (const job of batchJobs as ImportJob[]) {
    console.log(`[process-import] Processing file ${job.batch_sequence}/${batchJobs.length}: ${job.file_name}`);

    // Update job to processing
    await supabase
      .from('import_jobs')
      .update({ status: 'processing', progress: 0 })
      .eq('id', job.id);

    try {
      // Download file from big_imports bucket
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('big_imports')
        .download(job.storage_path);

      if (downloadError || !fileData) {
        throw new Error(`Falha ao baixar arquivo: ${job.storage_path}. ${downloadError?.message || ''}`);
      }

      console.log(`[process-import] Downloaded file: ${job.file_name}, size: ${(fileData.size / 1024 / 1024).toFixed(2)} MB`);

      const fileText = await fileData.text();
      const delimiter = job.delimiter || ',';
      const lines = fileText.split('\n');
      const nonEmptyLines = lines.filter((line: string) => line.trim() !== '');

      if (nonEmptyLines.length < 2) {
        throw new Error('Arquivo vazio ou sem dados válidos.');
      }

      // Parse header
      const headers = parseCSVLine(nonEmptyLines[0], delimiter);

      // Validate headers against primary file
      if (job.is_batch_primary) {
        primaryHeaders = headers;
        
        // Store headers in job
        await supabase
          .from('import_jobs')
          .update({ headers_json: headers })
          .eq('id', job.id);
          
        // Add header line to concatenated content
        concatenatedContent = nonEmptyLines[0] + '\n';
      } else {
        // Compare headers with primary
        if (!primaryHeaders) {
          throw new Error('Arquivo primário não foi processado primeiro.');
        }

        const isCompatible = compareHeaders(primaryHeaders, headers);
        if (!isCompatible.compatible) {
          throw new Error(
            `Colunas incompatíveis com o arquivo principal. ${isCompatible.message}`
          );
        }
      }

      // Process data rows
      const totalRows = nonEmptyLines.length - 1;
      let processedRows = 0;

      for (let i = 1; i < nonEmptyLines.length; i++) {
        const line = nonEmptyLines[i];
        if (!line.trim()) continue;
        
        try {
          const values = parseCSVLine(line, delimiter);

          // Collect sample rows (proportionally from each file)
          const samplesPerFile = Math.ceil(SAMPLE_SIZE / batchJobs.length);
          if (allSampleRows.length < SAMPLE_SIZE && processedRows < samplesPerFile) {
            const row: Record<string, unknown> = {};
            (primaryHeaders || headers).forEach((h, idx) => {
              row[h] = values[idx] ?? null;
            });
            allSampleRows.push(row);
          }

          // Add line to concatenated content (skip header for non-primary files)
          concatenatedContent += line + '\n';
          
          processedRows++;
          totalRowsProcessed++;

          // Update progress periodically
          if (processedRows % PROGRESS_UPDATE_INTERVAL === 0) {
            const progress = Math.min(Math.floor((processedRows / totalRows) * 100), 99);
            await updateJobProgress(supabase, job.id, progress, processedRows);
          }
        } catch (parseError) {
          console.warn(`[process-import] Error parsing row ${i} in file ${job.file_name}:`, parseError);
        }
      }

      processedJobIds.push(job.id);

      // Mark job as completed
      await supabase
        .from('import_jobs')
        .update({ 
          status: 'completed', 
          progress: 100,
          rows_processed: processedRows,
          finished_at: new Date().toISOString()
        })
        .eq('id', job.id);

      console.log(`[process-import] File ${job.file_name} completed: ${processedRows} rows`);
      isFirstFile = false;

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      console.error(`[process-import] Error processing file ${job.file_name}:`, errorMessage);
      
      failedJobs.push({ id: job.id, fileName: job.file_name, error: errorMessage });

      await updateJobError(supabase, job.id, errorMessage);
    }
  }

  // If we have processed files, save the consolidated dataset
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

    await supabase
      .from('project_columns')
      .insert(columnInserts);

    // Upload the concatenated file to datasets bucket
    const datasetFileName = `${primaryJob.file_name.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
    const datasetPath = `${primaryJob.user_id}/${primaryJob.project_id}/${datasetFileName}`;
    
    console.log(`[process-import] Uploading consolidated dataset to: ${datasetPath}`);
    
    const consolidatedBlob = new Blob([concatenatedContent], { type: 'text/csv' });
    const { error: uploadError } = await supabase.storage
      .from('datasets')
      .upload(datasetPath, consolidatedBlob, { upsert: true });
    
    if (uploadError) {
      console.error(`[process-import] Error uploading consolidated dataset:`, uploadError);
    } else {
      console.log(`[process-import] Consolidated dataset uploaded successfully`);
    }

    // Create dataset record in project_datasets
    const datasetId = await createDatasetRecord(
      supabase,
      primaryJob.project_id,
      primaryJob.user_id,
      primaryJob.file_name,
      datasetPath,
      totalBatchSize,
      totalRowsProcessed,
      Math.min(allSampleRows.length, SAMPLE_SIZE),
      primaryHeaders.length,
      'batch_import',
      {
        batch_id: primaryJob.batch_id,
        files_count: batchJobs.length,
        files_processed: processedJobIds.length,
        files_failed: failedJobs.length
      }
    );

    // Link dataset to jobs
    if (datasetId) {
      await supabase
        .from('import_jobs')
        .update({ dataset_id: datasetId })
        .eq('batch_id', primaryJob.batch_id);
    }

    // Update project with dataset info - use the correct path!
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
    await supabase
      .from('project_data_ingestion_logs')
      .insert({
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
          consolidated_path: datasetPath,
          dataset_id: datasetId
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
    // Download file from big_imports bucket
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('big_imports')
      .download(job.storage_path);

    if (downloadError || !fileData) {
      console.error(`[process-import] Failed to download file: ${job.storage_path}`, downloadError);
      await updateJobError(supabase, job_id, `Falha ao baixar o arquivo. ${downloadError?.message || ''}`);
      return new Response(
        JSON.stringify({ success: false, message: 'Failed to download file' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-import] Downloaded file: ${job.file_name}, size: ${(fileData.size / 1024 / 1024).toFixed(2)} MB`);

    const fileText = await fileData.text();
    const delimiter = job.delimiter || ',';
    const lines = fileText.split('\n');
    const nonEmptyLines = lines.filter((line: string) => line.trim() !== '');
    
    if (nonEmptyLines.length < 2) {
      await updateJobError(supabase, job_id, 'Arquivo vazio ou sem dados válidos.');
      return new Response(
        JSON.stringify({ success: false, message: 'Empty file or no valid data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const totalRows = nonEmptyLines.length - 1;
    
    if (totalRows > MAX_ROWS) {
      await updateJobError(supabase, job_id, `Arquivo excede o limite de ${MAX_ROWS.toLocaleString()} linhas.`);
      return new Response(
        JSON.stringify({ success: false, message: 'File exceeds maximum rows' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-import] Processing ${totalRows} rows from file`);

    // Parse header
    const headerLine = nonEmptyLines[0];
    const headers = parseCSVLine(headerLine, delimiter);
    
    if (headers.length === 0) {
      await updateJobError(supabase, job_id, 'Não foi possível detectar colunas no arquivo. Verifique o delimitador.');
      return new Response(
        JSON.stringify({ success: false, message: 'Could not parse headers' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-import] Found ${headers.length} columns: ${headers.slice(0, 5).join(', ')}...`);

    // Process data
    const sampleRows: Record<string, unknown>[] = [];
    let processedRows = 0;
    let lastProgress = 0;

    for (let i = 1; i < nonEmptyLines.length; i++) {
      try {
        const values = parseCSVLine(nonEmptyLines[i], delimiter);

        if (sampleRows.length < SAMPLE_SIZE) {
          const row: Record<string, unknown> = {};
          headers.forEach((h, idx) => {
            row[h] = values[idx] ?? null;
          });
          sampleRows.push(row);
        }

        processedRows++;

        if (processedRows % PROGRESS_UPDATE_INTERVAL === 0) {
          const progress = Math.min(Math.floor((processedRows / totalRows) * 100), 99);
          if (progress !== lastProgress) {
            await updateJobProgress(supabase, job_id, progress, processedRows);
            lastProgress = progress;
          }
        }
      } catch (parseError) {
        console.warn(`[process-import] Error parsing row ${i}:`, parseError);
        // Continue processing other rows instead of failing completely
      }
    }

    console.log(`[process-import] Processed ${processedRows} rows, sampled ${sampleRows.length}`);

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

    // Copy file to datasets bucket with proper path
    const datasetFileName = `${job.file_name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const datasetPath = `${job.user_id}/${job.project_id}/${datasetFileName}`;

    console.log(`[process-import] Copying to datasets bucket: ${datasetPath}`);

    // Re-upload to datasets bucket
    const { error: copyError } = await supabase.storage
      .from('datasets')
      .upload(datasetPath, fileData, { upsert: true });

    if (copyError) {
      console.error('[process-import] Error copying to datasets:', copyError);
    }

    // Create dataset record
    const datasetId = await createDatasetRecord(
      supabase,
      job.project_id,
      job.user_id,
      job.file_name,
      datasetPath,
      job.file_size_bytes,
      totalRows,
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
        total_rows: totalRows,
        sample_rows: Math.min(sampleRows.length, SAMPLE_SIZE),
        status: 'data_uploaded'
      })
      .eq('id', job.project_id);

    // Log ingestion
    await supabase.from('project_data_ingestion_logs').insert({
      project_id: job.project_id,
      status: 'success',
      rows_read: totalRows,
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
        rows_processed: processedRows,
        finished_at: new Date().toISOString(),
        dataset_id: datasetId
      })
      .eq('id', job_id);

    console.log(`[process-import] Job ${job_id} completed successfully`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Importação concluída: ${processedRows.toLocaleString()} linhas processadas`,
        rows_processed: processedRows,
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