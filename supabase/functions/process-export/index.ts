import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ExportJob {
  id: string;
  project_id: string;
  user_id: string;
  export_type: 'dataset' | 'predictions' | 'eda_results';
  parameters: Record<string, any>;
  status: string;
}

const CHUNK_SIZE = 10000; // Rows per chunk to avoid memory issues
const MAX_ROWS = 5000000; // 5 million rows max per export

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { job_id, trigger_type } = await req.json();
    
    console.log(`[process-export] Starting export process, job_id: ${job_id}, trigger: ${trigger_type}`);

    let jobs: ExportJob[] = [];

    if (job_id) {
      // Process specific job
      const { data, error } = await supabase
        .from('export_jobs')
        .select('*')
        .eq('id', job_id)
        .eq('status', 'pending')
        .single();

      if (error || !data) {
        console.log(`[process-export] Job ${job_id} not found or not pending`);
        return new Response(JSON.stringify({ error: 'Job not found or already processed' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 404,
        });
      }
      jobs = [data];
    } else {
      // Process all pending jobs (worker mode)
      const { data, error } = await supabase
        .from('export_jobs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(5);

      if (error) throw error;
      jobs = data || [];
    }

    if (jobs.length === 0) {
      console.log('[process-export] No pending jobs found');
      return new Response(JSON.stringify({ message: 'No pending jobs' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const results: Array<{ job_id: string; status: string; error?: string }> = [];

    for (const job of jobs) {
      try {
        console.log(`[process-export] Processing job ${job.id}, type: ${job.export_type}`);

        // Update status to running
        await supabase
          .from('export_jobs')
          .update({ status: 'running', started_at: new Date().toISOString() })
          .eq('id', job.id);

        // Generate CSV content based on export type
        const { csvContent, rowCount } = await generateCSV(supabase, job);

        if (rowCount === 0) {
          throw new Error('No data available to export');
        }

        // Upload to storage
        const fileName = `${job.user_id}/${job.project_id}/${job.id}.csv`;
        const { error: uploadError } = await supabase.storage
          .from('exports')
          .upload(fileName, csvContent, {
            contentType: 'text/csv',
            upsert: true,
          });

        if (uploadError) throw uploadError;

        // Create signed URL (valid for 7 days)
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from('exports')
          .createSignedUrl(fileName, 60 * 60 * 24 * 7);

        if (signedUrlError) throw signedUrlError;

        // Update job as completed
        await supabase
          .from('export_jobs')
          .update({
            status: 'completed',
            finished_at: new Date().toISOString(),
            file_url: signedUrlData.signedUrl,
            file_size_bytes: csvContent.length,
            rows_exported: rowCount,
          })
          .eq('id', job.id);

        console.log(`[process-export] Job ${job.id} completed successfully, ${rowCount} rows exported`);
        results.push({ job_id: job.id, status: 'completed' });

      } catch (jobError) {
        const errorMessage = jobError instanceof Error ? jobError.message : 'Unknown error';
        console.error(`[process-export] Job ${job.id} failed:`, errorMessage);

        await supabase
          .from('export_jobs')
          .update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            error_message: errorMessage,
          })
          .eq('id', job.id);

        results.push({ job_id: job.id, status: 'failed', error: errorMessage });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[process-export] Error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});

async function generateCSV(supabase: any, job: ExportJob): Promise<{ csvContent: string; rowCount: number }> {
  const { export_type, project_id, parameters } = job;

  let allRows: any[] = [];
  let headers: string[] = [];

  switch (export_type) {
    case 'predictions': {
      // Build query based on parameters
      let query = supabase
        .from('predictions')
        .select('*')
        .eq('project_id', project_id);

      // Apply filters from parameters
      if (parameters.batch_id) {
        query = query.eq('batch_id', parameters.batch_id);
      }
      if (parameters.is_latest !== false) {
        query = query.eq('is_latest', true);
      }
      if (parameters.horizon_days) {
        query = query.eq('horizon_days', parameters.horizon_days);
      }
      if (parameters.segment_field && parameters.segment_value) {
        query = query.eq(parameters.segment_field, parameters.segment_value);
      }
      if (parameters.problem_type) {
        query = query.eq('problem_type', parameters.problem_type);
      }

      // Paginate to handle large datasets
      let offset = 0;
      let hasMore = true;

      while (hasMore && offset < MAX_ROWS) {
        const { data, error } = await query
          .range(offset, offset + CHUNK_SIZE - 1)
          .order('probability_event', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
          hasMore = false;
        } else {
          allRows = allRows.concat(data);
          offset += CHUNK_SIZE;
          hasMore = data.length === CHUNK_SIZE;
        }

        console.log(`[process-export] Fetched ${allRows.length} prediction rows so far`);
      }

      if (allRows.length > 0) {
        // Select relevant columns for predictions export
        headers = [
          'entity_id', 'entity_type', 'problem_type', 'problem_context',
          'probability_event', 'predicted_class', 'predicted_value',
          'potential_value', 'average_ticket', 'lifetime_value',
          'segment', 'age_group', 'region', 'state', 'city',
          'product_category', 'channel', 'campaign', 'cohort',
          'horizon_days', 'prediction_date', 'reference_date', 'batch_id'
        ];
      }
      break;
    }

    case 'eda_results': {
      // Export EDA statistics
      const [numericStats, categoricalStats, columns] = await Promise.all([
        supabase.from('project_numeric_stats').select('*').eq('project_id', project_id),
        supabase.from('project_categorical_stats').select('*').eq('project_id', project_id),
        supabase.from('project_columns').select('*').eq('project_id', project_id),
      ]);

      if (numericStats.error) throw numericStats.error;
      if (categoricalStats.error) throw categoricalStats.error;
      if (columns.error) throw columns.error;

      // Combine into a unified EDA report
      const columnsMap = new Map((columns.data || []).map((c: any) => [c.column_name, c]));

      allRows = [];
      headers = ['column_name', 'type', 'min', 'max', 'mean', 'median', 'std', 'null_count', 'distinct_count', 'top_categories'];

      for (const stat of numericStats.data || []) {
        allRows.push({
          column_name: stat.column_name,
          type: 'numeric',
          min: stat.min_value,
          max: stat.max_value,
          mean: stat.mean_value,
          median: stat.median_value,
          std: stat.std_value,
          null_count: stat.null_count,
          distinct_count: '',
          top_categories: '',
        });
      }

      for (const stat of categoricalStats.data || []) {
        allRows.push({
          column_name: stat.column_name,
          type: 'categorical',
          min: '',
          max: '',
          mean: '',
          median: '',
          std: '',
          null_count: '',
          distinct_count: stat.distinct_count,
          top_categories: JSON.stringify(stat.top_categories),
        });
      }
      break;
    }

    case 'dataset': {
      // For dataset export, we need to fetch from the original file
      // Since original data is stored in storage, we'll export the project columns info
      // and sample data if available
      const { data: projectData, error: projectError } = await supabase
        .from('projects')
        .select('dataset_filename, dataset_rows, dataset_columns')
        .eq('id', project_id)
        .single();

      if (projectError) throw projectError;

      // Export columns info as a summary since full dataset may be in storage
      const { data: columnsData, error: columnsError } = await supabase
        .from('project_columns')
        .select('*')
        .eq('project_id', project_id)
        .order('column_index');

      if (columnsError) throw columnsError;

      headers = ['column_index', 'column_name', 'inferred_type'];
      allRows = columnsData || [];
      break;
    }

    default:
      throw new Error(`Unsupported export type: ${export_type}`);
  }

  // Generate CSV content
  if (allRows.length === 0) {
    return { csvContent: '', rowCount: 0 };
  }

  const csvLines: string[] = [];
  csvLines.push(headers.join(','));

  for (const row of allRows) {
    const values = headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) return '';
      const strValue = String(value);
      // Escape CSV special characters
      if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
        return `"${strValue.replace(/"/g, '""')}"`;
      }
      return strValue;
    });
    csvLines.push(values.join(','));
  }

  return { csvContent: csvLines.join('\n'), rowCount: allRows.length };
}
