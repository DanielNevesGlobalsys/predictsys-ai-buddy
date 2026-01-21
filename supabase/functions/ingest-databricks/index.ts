import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Limits for processing
const MAX_ROWS_TO_FETCH = 100000;
const FETCH_BATCH_SIZE = 10000;

interface ColumnInfo {
  column_name: string;
  inferred_type: string;
  column_index: number;
}

/**
 * Execute a SQL statement on Databricks and wait for results
 */
async function executeDatabricksQuery(
  host: string,
  httpPath: string,
  accessToken: string,
  sqlQuery: string,
  catalog?: string,
  schema?: string
): Promise<{ columns: string[]; rows: any[]; rowCount: number }> {
  const baseUrl = `https://${host}/api/2.0/sql/statements`;
  
  // Extract warehouse ID from HTTP path
  const warehouseId = httpPath.replace(/^\/sql\/1\.0\/warehouses\//, '').replace(/^\/sql\/protocolv1\/o\/\d+\//, '');
  
  const requestBody: Record<string, any> = {
    statement: sqlQuery,
    warehouse_id: warehouseId,
    wait_timeout: "120s",
    on_wait_timeout: "CANCEL"
  };
  
  if (catalog && catalog.trim()) {
    requestBody.catalog = catalog.trim();
  }
  
  if (schema && schema.trim()) {
    requestBody.schema = schema.trim();
  }

  console.log(`[ingest-databricks] Executing query: ${sqlQuery.substring(0, 200)}...`);

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[ingest-databricks] Query error:`, errorText);
    throw new Error(`Databricks query failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  // Check if we need to poll for results
  if (data.status?.state === 'PENDING' || data.status?.state === 'RUNNING') {
    // Poll until complete (simplified - in production use statement_id to poll)
    console.log(`[ingest-databricks] Query is ${data.status.state}, waiting...`);
    throw new Error('Query is still running. Please try with a smaller dataset.');
  }
  
  if (data.status?.state === 'FAILED') {
    throw new Error(`Query failed: ${data.status.error?.message || 'Unknown error'}`);
  }

  // Extract columns and rows
  const columns = (data.manifest?.schema?.columns || []).map((col: any) => col.name);
  const rows = data.result?.data_array || [];
  const rowCount = data.result?.row_count || rows.length;

  return { columns, rows, rowCount };
}

/**
 * Infer column type from sample values
 */
function inferColumnType(values: any[]): string {
  let numericCount = 0;
  let dateCount = 0;
  let validCount = 0;

  for (const val of values.slice(0, 100)) {
    if (val === null || val === undefined || val === '') continue;
    validCount++;

    const strVal = String(val);
    
    // Check if numeric
    const numVal = parseFloat(strVal.replace(',', '.'));
    if (!isNaN(numVal) && isFinite(numVal)) {
      numericCount++;
      continue;
    }

    // Check if date-like
    if (/^\d{4}-\d{2}-\d{2}/.test(strVal) || /^\d{2}\/\d{2}\/\d{4}/.test(strVal)) {
      dateCount++;
      continue;
    }
  }

  if (validCount === 0) return 'texto';
  if (numericCount / validCount > 0.8) return 'numérico';
  if (dateCount / validCount > 0.5) return 'data';
  return 'texto';
}

/**
 * Convert Databricks results to CSV and upload
 */
async function convertToCSVAndUpload(
  supabase: any,
  columns: string[],
  rows: any[][],
  storagePath: string
): Promise<{ fileSizeBytes: number }> {
  const csvLines: string[] = [];
  
  // Header
  csvLines.push(columns.map(col => `"${col.replace(/"/g, '""')}"`).join(';'));
  
  // Data rows
  for (const row of rows) {
    const values = row.map(val => {
      if (val === null || val === undefined) return '';
      const strVal = String(val);
      if (strVal.includes('"') || strVal.includes(';') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    });
    csvLines.push(values.join(';'));
  }
  
  const csvContent = csvLines.join('\n');
  const encoder = new TextEncoder();
  const csvBytes = encoder.encode(csvContent);
  
  const { error: uploadError } = await supabase.storage
    .from('datasets')
    .upload(storagePath, csvBytes, {
      contentType: 'text/csv',
      upsert: true
    });
  
  if (uploadError) {
    console.error('[ingest-databricks] Upload error:', uploadError);
    throw new Error(`Failed to upload CSV: ${uploadError.message}`);
  }
  
  return { fileSizeBytes: csvBytes.length };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { project_id, data_source_id, table_name: requestTableName } = await req.json();

    console.log(`[ingest-databricks] Starting ingestion for project: ${project_id}, data source: ${data_source_id}`);

    // Create ingestion log
    const { data: logData, error: logError } = await supabase
      .from("project_data_ingestion_logs")
      .insert({
        project_id,
        data_source_id,
        status: "processing"
      })
      .select()
      .single();

    if (logError) {
      console.error("[ingest-databricks] Error creating log:", logError);
      throw logError;
    }

    // Get data source configuration
    const { data: dataSource, error: dsError } = await supabase
      .from("data_sources")
      .select("*")
      .eq("id", data_source_id)
      .single();

    if (dsError || !dataSource) {
      throw new Error("Data source not found");
    }

    const connectionConfig = dataSource.connection_config as Record<string, any>;
    const { host, http_path, access_token, catalog, schema, table_name: configTableName } = connectionConfig;

    // Use table_name from request or from config
    const tableName = requestTableName || configTableName;

    if (!tableName) {
      throw new Error('Table name is required. Please specify the table to import in the connection settings.');
    }

    // Clean host
    const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');

    console.log(`[ingest-databricks] Connecting to ${cleanHost}, table: ${tableName}`);

    // First, get row count
    let totalRows = 0;
    const countQuery = `SELECT COUNT(*) AS cnt FROM ${tableName}`;
    try {
      const countResult = await executeDatabricksQuery(cleanHost, http_path, access_token, countQuery, catalog, schema);
      if (countResult.rows.length > 0) {
        totalRows = parseInt(countResult.rows[0][0]) || 0;
      }
    } catch (error) {
      console.warn('[ingest-databricks] Could not get row count:', error);
    }
    console.log(`[ingest-databricks] Total rows in table: ${totalRows}`);

    // Fetch data with limit
    const fetchLimit = Math.min(totalRows || MAX_ROWS_TO_FETCH, MAX_ROWS_TO_FETCH);
    const dataQuery = `SELECT * FROM ${tableName} LIMIT ${fetchLimit}`;
    
    const { columns, rows, rowCount } = await executeDatabricksQuery(
      cleanHost, http_path, access_token, dataQuery, catalog, schema
    );

    const sampleRows = rows.length;
    if (totalRows === 0) totalRows = sampleRows;
    const columnsCount = columns.length;

    console.log(`[ingest-databricks] Retrieved ${sampleRows} rows, ${columnsCount} columns`);

    if (sampleRows === 0) {
      throw new Error(`No data found in table '${tableName}'`);
    }

    // Infer column types
    const columnInfos: ColumnInfo[] = columns.map((colName, idx) => {
      const colValues = rows.slice(0, 100).map(row => row[idx]);
      return {
        column_name: colName,
        inferred_type: inferColumnType(colValues),
        column_index: idx
      };
    });

    // Generate storage path
    const timestamp = Date.now();
    const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
    const storagePath = `${project_id}/databricks_${safeTableName}_${timestamp}.csv`;

    // Convert to CSV and upload
    const { fileSizeBytes } = await convertToCSVAndUpload(supabase, columns, rows, storagePath);
    console.log(`[ingest-databricks] Uploaded CSV to ${storagePath} (${fileSizeBytes} bytes)`);

    // Deactivate previous datasets
    await supabase
      .from('project_datasets')
      .update({ is_active: false })
      .eq('project_id', project_id);

    // Get user_id from project
    const { data: projectData } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', project_id)
      .single();

    // Create project_datasets record
    const { error: datasetError } = await supabase
      .from('project_datasets')
      .insert({
        project_id,
        user_id: projectData?.user_id,
        name: `${dataSource.name} - ${tableName}`,
        storage_path: storagePath,
        source_type: 'cloud',
        total_rows: totalRows,
        sample_rows: sampleRows,
        columns_count: columnsCount,
        file_size_bytes: fileSizeBytes,
        is_active: true,
        source_metadata: {
          connector_type: 'databricks',
          host: cleanHost,
          table_name: tableName,
          catalog: catalog || null,
          schema: schema || null,
          data_source_id,
          delimiter: ';',
          encoding: 'UTF-8'
        }
      });

    if (datasetError) {
      console.error('[ingest-databricks] Error creating dataset:', datasetError);
      throw new Error(`Failed to create dataset: ${datasetError.message}`);
    }

    // Delete existing columns and insert new ones
    await supabase
      .from('project_columns')
      .delete()
      .eq('project_id', project_id);

    const { error: columnsError } = await supabase
      .from('project_columns')
      .insert(columnInfos.map(col => ({
        project_id,
        column_name: col.column_name,
        inferred_type: col.inferred_type,
        column_index: col.column_index
      })));

    if (columnsError) {
      console.error('[ingest-databricks] Error inserting columns:', columnsError);
    }

    // Update ingestion log
    await supabase
      .from("project_data_ingestion_logs")
      .update({
        status: "success",
        rows_read: totalRows,
        rows_sampled: sampleRows,
        completed_at: new Date().toISOString()
      })
      .eq("id", logData.id);

    // Update data source
    await supabase
      .from("data_sources")
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: "success",
        sync_message: `Successfully ingested ${totalRows} rows from Databricks`
      })
      .eq("id", data_source_id);

    // Update project
    await supabase
      .from("projects")
      .update({
        data_source_id,
        total_rows: totalRows,
        sample_rows: sampleRows,
        dataset_rows: sampleRows,
        dataset_columns: columnsCount,
        dataset_filename: storagePath,
        status: "data_uploaded"
      })
      .eq("id", project_id);

    console.log(`[ingest-databricks] Ingestion complete: ${totalRows} rows, ${columnsCount} columns`);

    return new Response(
      JSON.stringify({ 
        success: true,
        rows_read: totalRows,
        rows_sampled: sampleRows,
        columns_count: columnsCount,
        storage_path: storagePath,
        message: `Successfully ingested data from ${tableName}`
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );

  } catch (error: unknown) {
    console.error("[ingest-databricks] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred during Databricks ingestion";
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        message: errorMessage
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500 
      }
    );
  }
});
