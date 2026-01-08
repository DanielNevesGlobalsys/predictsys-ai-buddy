import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Configuration
const CHUNK_SIZE = 10000;
const MAX_ROWS = 10000000;
const SAMPLE_SIZE = 100000;

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
    return new Response(
      JSON.stringify({ success: false, message: 'Failed to fetch batch jobs' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[process-import] Found ${batchJobs.length} files in batch`);

  let primaryHeaders: string[] | null = null;
  let primaryHeadersHash: string | null = null;
  let totalRowsProcessed = 0;
  let allSampleRows: Record<string, unknown>[] = [];
  const processedJobIds: string[] = [];
  const failedJobs: { id: string; fileName: string; error: string }[] = [];

  for (const job of batchJobs as ImportJob[]) {
    console.log(`[process-import] Processing file ${job.batch_sequence}/${batchJobs.length}: ${job.file_name}`);

    // Update job to processing
    await supabase
      .from('import_jobs')
      .update({ status: 'processing', progress: 0 })
      .eq('id', job.id);

    try {
      // Download file
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('big_imports')
        .download(job.storage_path);

      if (downloadError || !fileData) {
        throw new Error(`Falha ao baixar arquivo: ${job.storage_path}`);
      }

      const fileText = await fileData.text();
      const delimiter = job.delimiter || ',';
      const lines = fileText.split('\n').filter((line: string) => line.trim() !== '');

      if (lines.length < 2) {
        throw new Error('Arquivo vazio ou sem dados válidos.');
      }

      // Parse header
      const headers = parseCSVLine(lines[0], delimiter);
      const headersHash = await hashHeaders(headers);

      // Validate headers against primary file
      if (job.is_batch_primary) {
        primaryHeaders = headers;
        primaryHeadersHash = headersHash;
        
        // Store headers in job
        await supabase
          .from('import_jobs')
          .update({ 
            headers_json: headers,
            headers_hash: headersHash
          })
          .eq('id', job.id);
      } else {
        // Compare headers with primary
        if (!primaryHeaders || !primaryHeadersHash) {
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
      const totalRows = lines.length - 1;
      let processedRows = 0;

      for (let i = 1; i < lines.length; i++) {
        try {
          const values = parseCSVLine(lines[i], delimiter);

          // Collect sample rows (proportionally from each file)
          const samplesPerFile = Math.ceil(SAMPLE_SIZE / batchJobs.length);
          if (allSampleRows.length < SAMPLE_SIZE && processedRows < samplesPerFile) {
            const row: Record<string, unknown> = {};
            (primaryHeaders || headers).forEach((h, idx) => {
              row[h] = values[idx] ?? null;
            });
            allSampleRows.push(row);
          }

          processedRows++;

          // Update progress
          if (processedRows % CHUNK_SIZE === 0) {
            const progress = Math.min(Math.floor((processedRows / totalRows) * 100), 99);
            await supabase
              .from('import_jobs')
              .update({ progress, rows_processed: processedRows })
              .eq('id', job.id);
          }
        } catch (parseError) {
          console.warn(`[process-import] Error parsing row ${i} in file ${job.file_name}:`, parseError);
        }
      }

      totalRowsProcessed += processedRows;
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

      // Copy file to datasets bucket
      const datasetPath = `${job.user_id}/${job.project_id}/${job.file_name}`;
      await supabase.storage
        .from('datasets')
        .upload(datasetPath, fileData, { upsert: true });

      console.log(`[process-import] File ${job.file_name} completed: ${processedRows} rows`);

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      console.error(`[process-import] Error processing file ${job.file_name}:`, errorMessage);
      
      failedJobs.push({ id: job.id, fileName: job.file_name, error: errorMessage });

      await supabase
        .from('import_jobs')
        .update({ 
          status: 'failed', 
          error_message: errorMessage,
          finished_at: new Date().toISOString()
        })
        .eq('id', job.id);
    }
  }

  // Update project with combined dataset info
  if (processedJobIds.length > 0 && primaryHeaders) {
    const columnTypes = inferColumnTypes(primaryHeaders, allSampleRows);

    // Delete existing columns
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

    // Update project
    await supabase
      .from('projects')
      .update({
        dataset_filename: `batch_${primaryJob.batch_id}`,
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
          failed_files: failedJobs.map(f => ({ name: f.fileName, error: f.error }))
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

  // Download file from storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from('big_imports')
    .download(job.storage_path);

  if (downloadError || !fileData) {
    console.error(`[process-import] Failed to download file: ${job.storage_path}`, downloadError);
    await supabase
      .from('import_jobs')
      .update({ 
        status: 'failed', 
        error_message: 'Falha ao baixar o arquivo. Verifique se o upload foi concluído.',
        finished_at: new Date().toISOString()
      })
      .eq('id', job_id);
    return new Response(
      JSON.stringify({ success: false, message: 'Failed to download file' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const fileText = await fileData.text();
  const delimiter = job.delimiter || ',';
  const lines = fileText.split('\n').filter((line: string) => line.trim() !== '');
  
  if (lines.length < 2) {
    await supabase
      .from('import_jobs')
      .update({ 
        status: 'failed', 
        error_message: 'Arquivo vazio ou sem dados válidos.',
        finished_at: new Date().toISOString()
      })
      .eq('id', job_id);
    return new Response(
      JSON.stringify({ success: false, message: 'Empty file or no valid data' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const totalRows = lines.length - 1;
  
  if (totalRows > MAX_ROWS) {
    await supabase
      .from('import_jobs')
      .update({ 
        status: 'failed', 
        error_message: `Arquivo excede o limite de ${MAX_ROWS.toLocaleString()} linhas.`,
        finished_at: new Date().toISOString()
      })
      .eq('id', job_id);
    return new Response(
      JSON.stringify({ success: false, message: 'File exceeds maximum rows' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[process-import] Processing ${totalRows} rows from file`);

  // Parse header
  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine, delimiter);
  
  if (headers.length === 0) {
    await supabase
      .from('import_jobs')
      .update({ 
        status: 'failed', 
        error_message: 'Não foi possível detectar colunas no arquivo. Verifique o delimitador.',
        finished_at: new Date().toISOString()
      })
      .eq('id', job_id);
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

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = parseCSVLine(lines[i], delimiter);

      if (sampleRows.length < SAMPLE_SIZE) {
        const row: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          row[h] = values[idx] ?? null;
        });
        sampleRows.push(row);
      }

      processedRows++;

      if (processedRows % CHUNK_SIZE === 0) {
        const progress = Math.min(Math.floor((processedRows / totalRows) * 100), 99);
        if (progress !== lastProgress) {
          await supabase
            .from('import_jobs')
            .update({ progress, rows_processed: processedRows })
            .eq('id', job_id);
          lastProgress = progress;
        }
      }
    } catch (parseError) {
      console.error(`[process-import] Error parsing row ${i}:`, parseError);
      await supabase
        .from('import_jobs')
        .update({ 
          status: 'failed', 
          error_message: `Erro ao processar linha ${i}. Verifique o formato do CSV.`,
          finished_at: new Date().toISOString()
        })
        .eq('id', job_id);
      return new Response(
        JSON.stringify({ success: false, message: `Error parsing row ${i}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  console.log(`[process-import] Processed ${processedRows} rows, sampled ${sampleRows.length}`);

  const columnTypes = inferColumnTypes(headers, sampleRows);

  await supabase
    .from('project_columns')
    .delete()
    .eq('project_id', job.project_id);

  const columnInserts = headers.map((name, index) => ({
    project_id: job.project_id,
    column_name: name,
    column_index: index,
    inferred_type: columnTypes[name] || 'texto'
  }));

  await supabase
    .from('project_columns')
    .insert(columnInserts);

  const datasetPath = `${job.user_id}/${job.project_id}/${job.file_name}`;
  await supabase.storage
    .from('datasets')
    .upload(datasetPath, fileData, { upsert: true });

  await supabase
    .from('projects')
    .update({
      dataset_filename: datasetPath,
      dataset_rows: Math.min(processedRows, SAMPLE_SIZE),
      dataset_columns: headers.length,
      total_rows: processedRows,
      sample_rows: Math.min(processedRows, SAMPLE_SIZE),
      status: 'data_uploaded'
    })
    .eq('id', job.project_id);

  await supabase
    .from('project_data_ingestion_logs')
    .insert({
      project_id: job.project_id,
      status: 'success',
      rows_read: processedRows,
      rows_sampled: Math.min(processedRows, SAMPLE_SIZE),
      completed_at: new Date().toISOString(),
      metadata: {
        file_name: job.file_name,
        file_size_bytes: job.file_size_bytes,
        delimiter: job.delimiter,
        encoding: job.encoding,
        import_job_id: job_id
      }
    });

  await supabase
    .from('import_jobs')
    .update({ 
      status: 'completed', 
      progress: 100,
      rows_processed: processedRows,
      finished_at: new Date().toISOString()
    })
    .eq('id', job_id);

  console.log(`[process-import] Job ${job_id} completed successfully`);

  return new Response(
    JSON.stringify({ 
      success: true, 
      message: 'Import completed successfully',
      rows_processed: processedRows,
      columns: headers.length
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Helper functions
function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
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

async function hashHeaders(headers: string[]): Promise<string> {
  const text = headers.join('|').toLowerCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('MD5', data).catch(() => {
    // Fallback for environments without MD5
    return encoder.encode(text.slice(0, 32));
  });
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function compareHeaders(
  primary: string[], 
  current: string[]
): { compatible: boolean; message: string } {
  const primaryNorm = primary.map(h => h.toLowerCase().trim());
  const currentNorm = current.map(h => h.toLowerCase().trim());

  // Check for exact match (order independent)
  const primarySet = new Set(primaryNorm);
  const currentSet = new Set(currentNorm);

  const missing = primaryNorm.filter(h => !currentSet.has(h));
  const extra = currentNorm.filter(h => !primarySet.has(h));

  if (missing.length === 0 && extra.length === 0) {
    return { compatible: true, message: '' };
  }

  // Allow files with same columns in different order
  if (missing.length === 0 && extra.length === 0) {
    return { compatible: true, message: '' };
  }

  let message = '';
  if (missing.length > 0) {
    message += `Colunas faltando: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}. `;
  }
  if (extra.length > 0) {
    message += `Colunas extras: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? '...' : ''}.`;
  }

  return { compatible: false, message };
}

function inferColumnTypes(headers: string[], sampleRows: Record<string, unknown>[]): Record<string, string> {
  const types: Record<string, string> = {};
  
  for (const header of headers) {
    const values = sampleRows
      .map(row => row[header])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
      .map(v => String(v));
    
    if (values.length === 0) {
      types[header] = 'texto';
      continue;
    }
    
    const allNumbers = values.every(v => !isNaN(Number(v.replace(',', '.'))));
    if (allNumbers) {
      types[header] = 'numérico';
      continue;
    }
    
    const datePatterns = [
      /^\d{4}-\d{2}-\d{2}/,
      /^\d{2}\/\d{2}\/\d{4}/,
      /^\d{2}-\d{2}-\d{4}/,
    ];
    const allDates = values.every(v => datePatterns.some(p => p.test(v)));
    if (allDates) {
      types[header] = 'data';
      continue;
    }
    
    const uniqueValues = new Set(values);
    if (uniqueValues.size <= Math.min(10, values.length * 0.3)) {
      types[header] = 'categórico';
      continue;
    }
    
    types[header] = 'texto';
  }
  
  return types;
}
