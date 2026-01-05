import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Configuration
const CHUNK_SIZE = 10000; // Rows per chunk
const MAX_ROWS = 10000000; // 10 million rows max
const SAMPLE_SIZE = 100000; // Rows to sample for EDA

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { job_id } = await req.json();

    if (!job_id) {
      return new Response(
        JSON.stringify({ success: false, message: 'job_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-import] Starting import job: ${job_id}`);

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

    // Check if job is already processing or completed
    if (job.status !== 'pending') {
      console.log(`[process-import] Job ${job_id} is already ${job.status}`);
      return new Response(
        JSON.stringify({ success: true, message: `Job is already ${job.status}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

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
    const lines = fileText.split('\n').filter(line => line.trim() !== '');
    
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

    const totalRows = lines.length - 1; // Excluding header
    
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

    // Process data in chunks and collect sample
    const sampleRows: Record<string, unknown>[] = [];
    let processedRows = 0;
    let lastProgress = 0;

    for (let i = 1; i < lines.length; i++) {
      try {
        const values = parseCSVLine(lines[i], delimiter);
        
        if (values.length !== headers.length) {
          console.warn(`[process-import] Row ${i} has ${values.length} values, expected ${headers.length}`);
          // Continue processing but log the issue
        }

        // Collect sample rows
        if (sampleRows.length < SAMPLE_SIZE) {
          const row: Record<string, unknown> = {};
          headers.forEach((h, idx) => {
            row[h] = values[idx] ?? null;
          });
          sampleRows.push(row);
        }

        processedRows++;

        // Update progress every CHUNK_SIZE rows
        if (processedRows % CHUNK_SIZE === 0) {
          const progress = Math.min(Math.floor((processedRows / totalRows) * 100), 99);
          if (progress !== lastProgress) {
            await supabase
              .from('import_jobs')
              .update({ progress, rows_processed: processedRows })
              .eq('id', job_id);
            lastProgress = progress;
            console.log(`[process-import] Progress: ${progress}% (${processedRows}/${totalRows})`);
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

    // Infer column types from sample
    const columnTypes = inferColumnTypes(headers, sampleRows);
    console.log(`[process-import] Inferred column types`);

    // Delete existing columns for this project
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

    const { error: columnsError } = await supabase
      .from('project_columns')
      .insert(columnInserts);

    if (columnsError) {
      console.error(`[process-import] Failed to insert columns:`, columnsError);
    }

    // Copy file to datasets bucket for consistency with normal upload flow
    const datasetPath = `${job.user_id}/${job.project_id}/${job.file_name}`;
    
    const { error: copyError } = await supabase.storage
      .from('datasets')
      .upload(datasetPath, fileData, { upsert: true });

    if (copyError) {
      console.error(`[process-import] Warning: Failed to copy to datasets bucket:`, copyError);
    }

    // Update project with dataset info
    const { error: projectError } = await supabase
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

    if (projectError) {
      console.error(`[process-import] Failed to update project:`, projectError);
    }

    // Log ingestion
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

    // Mark job as completed
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

  } catch (error: unknown) {
    console.error('[process-import] Unexpected error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ success: false, message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Parse a CSV line respecting quotes
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

// Infer column types from sample data
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
    
    // Check if all are numbers
    const allNumbers = values.every(v => !isNaN(Number(v.replace(',', '.'))));
    if (allNumbers) {
      types[header] = 'numérico';
      continue;
    }
    
    // Check if all are dates
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
    
    // Check for categorical (low cardinality)
    const uniqueValues = new Set(values);
    if (uniqueValues.size <= Math.min(10, values.length * 0.3)) {
      types[header] = 'categórico';
      continue;
    }
    
    types[header] = 'texto';
  }
  
  return types;
}
