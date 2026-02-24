import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Limits for processing
const MAX_ROWS_TO_FETCH = 100000;
const PREVIEW_TIMEOUT_SECONDS = 30;

// Forbidden SQL keywords for validation
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP',
  'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE',
  'EXECUTE', 'EXEC'
];

interface ColumnInfo {
  column_name: string;
  inferred_type: string;
  column_index: number;
}

/**
 * Validate SQL query for safety
 */
function validateSQL(sql: string): { valid: boolean; error?: string } {
  const trimmedSQL = sql.trim().toUpperCase();
  
  // Must start with SELECT
  if (!trimmedSQL.startsWith("SELECT")) {
    return { valid: false, error: "SQL deve começar com SELECT" };
  }
  
  // Check for forbidden keywords
  for (const keyword of FORBIDDEN_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sql)) {
      return { valid: false, error: `Palavra-chave proibida encontrada: ${keyword}` };
    }
  }
  
  return { valid: true };
}

/**
 * Generate SHA256 hash for SQL
 */
async function hashSQL(sql: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(sql);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Wrap user SQL in safe subquery for preview
 */
function wrapSQLForPreview(userSQL: string, limit: number = 500): string {
  return `SELECT * FROM (
  ${userSQL.replace(/;+\s*$/, '')}
) AS base_query
LIMIT ${limit}`;
}

/**
 * Poll for statement completion
 */
async function pollStatementStatus(
  host: string,
  statementId: string,
  accessToken: string,
  maxRetries: number = 60,
  intervalMs: number = 2000
): Promise<any> {
  const statusUrl = `https://${host}/api/2.0/sql/statements/${statementId}`;
  
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to poll statement status: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const state = data.status?.state;
    
    console.log(`[ingest-databricks] Poll ${i + 1}/${maxRetries}: state=${state}`);
    
    if (state === 'SUCCEEDED') {
      return data;
    }
    
    if (state === 'FAILED' || state === 'CANCELED' || state === 'CLOSED') {
      throw new Error(`Query ${state.toLowerCase()}: ${data.status?.error?.message || 'Unknown error'}`);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  throw new Error('Query timed out after maximum retries');
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
    wait_timeout: "50s", // Max allowed by Databricks API (5-50 seconds)
    on_wait_timeout: "CONTINUE" // Continue execution, we'll poll for results
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

  let data = await response.json();
  const statementId = data.statement_id;
  
  // Check if we need to poll for results
  if (data.status?.state === 'PENDING' || data.status?.state === 'RUNNING') {
    console.log(`[ingest-databricks] Query is ${data.status.state}, polling for completion...`);
    data = await pollStatementStatus(host, statementId, accessToken);
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let projectId = "";

  try {
    const { 
      project_id, 
      data_source_id, 
      table_name: requestTableName,
      source_mode: requestSourceMode,
      source_sql: requestSourceSQL
    } = await req.json();
    projectId = project_id;

    console.log(`[ingest-databricks] Starting ingestion for project: ${project_id}, data source: ${data_source_id}`);

    // ── SSOT: Start ingestion ──
    const configHash = await hashConfigDatabricks({ data_source_id, requestTableName, requestSourceMode, requestSourceSQL });
    const startResult = await rpcStartIngestionDatabricks(supabase, project_id, "databricks", configHash);
    if (!startResult.canProceed && startResult.response) return startResult.response;

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
    const { 
      host, 
      http_path, 
      access_token, 
      catalog, 
      schema, 
      table_name: configTableName,
      source_mode: configSourceMode,
      source_sql: configSourceSQL
    } = connectionConfig;

    // Determine source mode and query
    const sourceMode = requestSourceMode || configSourceMode || dataSource.source_mode || 'table';
    let sourceDefinition: string;
    let displayName: string;
    let dataQuery: string;

    if (sourceMode === 'sql') {
      // SQL mode - use custom SQL
      const sourceSQL = requestSourceSQL || configSourceSQL || dataSource.source_sql;
      
      if (!sourceSQL) {
        throw new Error('SQL query is required for SQL source mode');
      }
      
      // Validate SQL
      const validation = validateSQL(sourceSQL);
      if (!validation.valid) {
        throw new Error(`SQL inválido: ${validation.error}`);
      }
      
      sourceDefinition = sourceSQL;
      displayName = 'Custom SQL Query';
      
      // Wrap SQL for safe execution with limit
      dataQuery = wrapSQLForPreview(sourceSQL, MAX_ROWS_TO_FETCH);
      
      console.log(`[ingest-databricks] Using SQL mode with query: ${sourceSQL.substring(0, 100)}...`);
    } else {
      // Table mode - use table name
      const tableName = requestTableName || configTableName;
      
      if (!tableName) {
        throw new Error('Table name is required. Please specify the table to import in the connection settings.');
      }
      
      sourceDefinition = tableName;
      displayName = tableName;
      dataQuery = `SELECT * FROM ${tableName} LIMIT ${MAX_ROWS_TO_FETCH}`;
      
      console.log(`[ingest-databricks] Using table mode with table: ${tableName}`);
    }

    // Clean host
    const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');

    console.log(`[ingest-databricks] Connecting to ${cleanHost}`);

    // Get row count (for table mode only, SQL mode we estimate from results)
    let totalRows = 0;
    if (sourceMode === 'table') {
      const countQuery = `SELECT COUNT(*) AS cnt FROM ${sourceDefinition}`;
      try {
        const countResult = await executeDatabricksQuery(cleanHost, http_path, access_token, countQuery, catalog, schema);
        if (countResult.rows.length > 0) {
          totalRows = parseInt(countResult.rows[0][0]) || 0;
        }
      } catch (error) {
        console.warn('[ingest-databricks] Could not get row count:', error);
      }
    }
    console.log(`[ingest-databricks] Total rows estimated: ${totalRows}`);

    // Execute main query
    const { columns, rows, rowCount } = await executeDatabricksQuery(
      cleanHost, http_path, access_token, dataQuery, catalog, schema
    );

    const sampleRows = rows.length;
    if (totalRows === 0) totalRows = sampleRows;
    const columnsCount = columns.length;

    console.log(`[ingest-databricks] Retrieved ${sampleRows} rows, ${columnsCount} columns`);

    if (sampleRows === 0) {
      throw new Error(`No data found for source: ${displayName}`);
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
    const safeName = displayName.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 50);
    const storagePath = `${project_id}/databricks_${safeName}_${timestamp}.csv`;

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
        name: `${dataSource.name} - ${displayName}`,
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
          source_mode: sourceMode,
          source_definition: sourceDefinition,
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

    // Create or update project_data_contract
    const sourceDefinitionHash = await hashSQL(sourceDefinition);
    const { data: existingContract } = await supabase
      .from('project_data_contract')
      .select('id, locked')
      .eq('project_id', project_id)
      .single();

    if (existingContract) {
      if (!existingContract.locked) {
        await supabase
          .from('project_data_contract')
          .update({
            data_source_id,
            source_mode: sourceMode,
            source_definition: sourceDefinition,
            source_definition_hash: sourceDefinitionHash,
            schema_snapshot: columnInfos,
            row_count_estimate: totalRows
          })
          .eq('id', existingContract.id);
      }
    } else {
      await supabase
        .from('project_data_contract')
        .insert({
          project_id,
          data_source_id,
          source_mode: sourceMode,
          source_definition: sourceDefinition,
          source_definition_hash: sourceDefinitionHash,
          schema_snapshot: columnInfos,
          row_count_estimate: totalRows,
          locked: false
        });
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

    // Update data source with source mode info
    await supabase
      .from("data_sources")
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: "success",
        sync_message: `Successfully ingested ${totalRows} rows from Databricks`,
        source_mode: sourceMode,
        source_sql: sourceMode === 'sql' ? sourceDefinition : null,
        source_sql_hash: sourceMode === 'sql' ? sourceDefinitionHash : null,
        source_table_full_name: sourceMode === 'table' ? sourceDefinition : null
      })
      .eq("id", data_source_id);

    // Update ingestion log
    await supabase
      .from("project_data_ingestion_logs")
      .update({
        status: "success",
        rows_read: totalRows,
        rows_sampled: sampleRows,
        completed_at: new Date().toISOString(),
        metadata: {
          source_mode: sourceMode,
          source_definition: sourceDefinition
        }
      })
      .eq("id", logData.id);

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

    // ── SSOT: Finalize ingestion (atomic manifest + state=done) ──
    const schemaForManifest = columnInfos.map(col => ({
      name: col.column_name, type: col.inferred_type, index: col.column_index,
    }));
    try {
      await supabase.rpc("rpc_finalize_ingestion", {
        p_project_id: project_id,
        p_source_type: "databricks",
        p_config_hash: configHash,
        p_dataset_id: null,
        p_source_pointer: { host: cleanHost, source_mode: sourceMode, source_definition: sourceDefinition, data_source_id, storage_path: storagePath },
        p_schema_json: schemaForManifest,
        p_row_count: totalRows,
        p_col_count: columnsCount,
        p_total_bytes: fileSizeBytes,
        p_sample_strategy: { method: "head", max_rows: 100000 },
        p_file_count: 1,
      });
    } catch (e) {
      console.warn("[ingest-databricks] rpc_finalize_ingestion fallback:", e);
      await rpcCompleteIngestionDatabricks(supabase, project_id, true, {
        rowsDetected: totalRows, colsDetected: columnsCount, fileCount: 1, totalBytes: fileSizeBytes,
      });
    }

    console.log(`[ingest-databricks] Ingestion complete: ${totalRows} rows, ${columnsCount} columns`);

    return new Response(
      JSON.stringify({ 
        success: true,
        status: "DONE",
        ingestion_state: "done",
        rows_read: totalRows,
        rows_sampled: sampleRows,
        columns_count: columnsCount,
        storage_path: storagePath,
        source_mode: sourceMode,
        message: `Successfully ingested data from ${displayName}`
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );

  } catch (error: unknown) {
    console.error("[ingest-databricks] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred during Databricks ingestion";
    const errorCode = classifyDatabricksError(error);

    // ── SSOT: Complete ingestion (failure) ──
    if (projectId) {
      await rpcCompleteIngestionDatabricks(supabase, projectId, false, { errorCode, errorMessage });
    }
    
    return new Response(
      JSON.stringify({ 
        success: false,
        status: "FAILED",
        ingestion_state: "failed",
        error_code: errorCode,
        error_friendly: errorMessage,
        ctas: [
          { label: "Tentar novamente", action: "retry_ingestion" },
          { label: "Revalidar credenciais", action: "revalidate_credentials" },
        ],
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  }
});

// ── SSOT helpers ──
async function hashConfigDatabricks(config: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(config));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function rpcStartIngestionDatabricks(supabase: any, projectId: string, sourceType: string, configHash: string) {
  try {
    const { data, error } = await supabase.rpc("rpc_start_ingestion", {
      p_project_id: projectId, p_source_type: sourceType, p_source_config_hash: configHash,
    });
    if (error) return { canProceed: true };
    const r = data as Record<string, unknown>;
    if (r.status === "ALREADY_DONE") {
      return { canProceed: false, response: new Response(JSON.stringify({
        success: true, status: "ALREADY_DONE", ingestion_state: "done", message: r.message,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }) };
    }
    if (r.error === "INGESTION_ALREADY_RUNNING") {
      return { canProceed: false, response: new Response(JSON.stringify({
        success: false, status: "ALREADY_RUNNING", ingestion_state: "running",
        error_code: "INGESTION_ALREADY_RUNNING",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }) };
    }
    return { canProceed: true };
  } catch { return { canProceed: true }; }
}

async function rpcCompleteIngestionDatabricks(supabase: any, projectId: string, success: boolean, stats: Record<string, unknown> = {}) {
  try {
    await supabase.rpc("rpc_complete_ingestion", {
      p_project_id: projectId, p_success: success,
      p_rows_detected: stats.rowsDetected || 0, p_cols_detected: stats.colsDetected || 0,
      p_file_count: stats.fileCount || 0, p_total_bytes: stats.totalBytes || 0,
      p_dataset_id: stats.datasetId || null, p_manifest_id: stats.manifestId || null,
      p_error_code: stats.errorCode || null, p_error_message: stats.errorMessage || null,
    });
  } catch (e) { console.warn("[ingest-databricks] rpc_complete_ingestion error:", e); }
}

function classifyDatabricksError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("auth") || msg.includes("permission") || msg.includes("401") || msg.includes("403")) return "CONNECTOR_AUTH_ERROR";
  if (msg.includes("timeout") || msg.includes("timed out")) return "CONNECTOR_TIMEOUT";
  if (msg.includes("not found") && msg.includes("table")) return "TABLE_NOT_FOUND";
  if (msg.includes("sql") && (msg.includes("invalid") || msg.includes("proibid"))) return "SQL_VALIDATION_ERROR";
  if (msg.includes("not found")) return "CONNECTOR_NOT_FOUND";
  return "UNKNOWN";
}
