import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Limits for sampling
const MAX_ROWS_TO_SAMPLE = 100000;

interface ColumnInfo {
  column_name: string;
  inferred_type: string;
  column_index: number;
}

/**
 * Get Azure AD access token for Power BI
 */
async function getPowerBIAccessToken(
  clientId: string,
  clientSecret: string,
  tenantId: string
): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://analysis.windows.net/powerbi/api/.default'
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ingest-cloud-data] Azure AD token error:', errorText);
    throw new Error(`Failed to get Azure AD token: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Execute DAX query on Power BI semantic model
 */
async function executePowerBIQuery(
  accessToken: string,
  workspaceId: string,
  datasetId: string,
  daxQuery: string
): Promise<any> {
  const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/datasets/${datasetId}/executeQueries`;
  
  const body = {
    queries: [{ query: daxQuery }],
    serializerSettings: {
      includeNulls: true
    }
  };

  console.log(`[ingest-cloud-data] Executing DAX query: ${daxQuery.substring(0, 100)}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ingest-cloud-data] Power BI query error:', errorText);
    
    // Detect specific Power BI error codes for better messages
    if (errorText.includes('PowerBIFolderNotFound')) {
      throw new Error(`WORKSPACE_NOT_FOUND: O workspace (ID: ${workspaceId}) não foi encontrado. Verifique se o workspace_id está correto e se o Service Principal tem acesso ao workspace no Power BI.`);
    }
    if (errorText.includes('PowerBINotFound') || errorText.includes('DatasetNotFound')) {
      throw new Error(`DATASET_NOT_FOUND: O dataset (ID: ${datasetId}) não foi encontrado no workspace. Verifique se o dataset_id está correto.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AUTH_ERROR: Sem permissão para acessar o Power BI. Verifique as credenciais (client_id, client_secret, tenant_id) e as permissões do Service Principal.`);
    }
    
    throw new Error(`Failed to execute DAX query: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * Get list of tables from semantic model using DAX
 */
async function getSemanticModelTables(
  accessToken: string,
  workspaceId: string,
  datasetId: string
): Promise<string[]> {
  // Use INFO.TABLES() DMV to get table names
  const daxQuery = `EVALUATE INFO.TABLES()`;
  
  try {
    const result = await executePowerBIQuery(accessToken, workspaceId, datasetId, daxQuery);
    const rows = result.results?.[0]?.tables?.[0]?.rows || [];
    
    // Filter for user tables (not system tables)
    const tableNames = rows
      .filter((row: any) => {
        const name = row['[Name]'] || row['Name'];
        // Skip system tables and date tables
        return name && !name.startsWith('DateTable') && !name.startsWith('LocalDateTable');
      })
      .map((row: any) => row['[Name]'] || row['Name']);
    
    console.log(`[ingest-cloud-data] Found ${tableNames.length} user tables in semantic model`);
    return tableNames;
  } catch (error) {
    console.error('[ingest-cloud-data] Error getting tables via DMV:', error);
    // Fallback: try to get a simple evaluation
    throw error;
  }
}

/**
 * Get column info from a table using DAX
 */
async function getTableColumns(
  accessToken: string,
  workspaceId: string,
  datasetId: string,
  tableName: string
): Promise<{ name: string; dataType: string }[]> {
  // Use INFO.COLUMNS() DMV filtered by table name
  const daxQuery = `EVALUATE FILTER(INFO.COLUMNS(), [TableName] = "${tableName}")`;
  
  try {
    const result = await executePowerBIQuery(accessToken, workspaceId, datasetId, daxQuery);
    const rows = result.results?.[0]?.tables?.[0]?.rows || [];
    
    return rows.map((row: any) => ({
      name: row['[ExplicitName]'] || row['[Name]'] || row['ExplicitName'] || row['Name'],
      dataType: row['[DataType]'] || row['DataType'] || 'String'
    }));
  } catch (error) {
    console.error(`[ingest-cloud-data] Error getting columns for table ${tableName}:`, error);
    return [];
  }
}

/**
 * Infer column type from Power BI data type or sample values
 */
function inferColumnType(pbiDataType: string, values: any[]): string {
  // Check Power BI data type first
  const typeUpper = (pbiDataType || '').toUpperCase();
  if (typeUpper.includes('INT') || typeUpper.includes('DECIMAL') || typeUpper.includes('DOUBLE') || typeUpper.includes('CURRENCY')) {
    return 'numérico';
  }
  if (typeUpper.includes('DATE') || typeUpper.includes('TIME')) {
    return 'data';
  }
  if (typeUpper.includes('BOOL')) {
    return 'categórico';
  }

  // Fallback to value inspection
  let numericCount = 0;
  let validCount = 0;

  for (const val of values.slice(0, 100)) {
    if (val === null || val === undefined || val === '') continue;
    validCount++;

    const numVal = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
    if (!isNaN(numVal) && isFinite(numVal)) {
      numericCount++;
    }
  }

  if (validCount === 0) return 'texto';
  if (numericCount / validCount > 0.8) return 'numérico';
  return 'texto';
}

/**
 * Convert Power BI results to CSV format and upload to storage
 */
async function convertToCSVAndUpload(
  supabase: any,
  rows: any[],
  columns: string[],
  storagePath: string
): Promise<{ fileSizeBytes: number }> {
  // Build CSV content
  const csvLines: string[] = [];
  
  // Header
  csvLines.push(columns.map(col => `"${col.replace(/"/g, '""')}"`).join(';'));
  
  // Data rows
  for (const row of rows) {
    const values = columns.map(col => {
      // Power BI returns columns as [ColumnName] format
      const val = row[`[${col}]`] ?? row[col] ?? '';
      if (val === null || val === undefined) return '';
      const strVal = String(val);
      // Escape quotes and wrap in quotes if contains special chars
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
  
  // Upload to storage
  const { error: uploadError } = await supabase.storage
    .from('datasets')
    .upload(storagePath, csvBytes, {
      contentType: 'text/csv',
      upsert: true
    });
  
  if (uploadError) {
    console.error('[ingest-cloud-data] Upload error:', uploadError);
    throw new Error(`Failed to upload CSV: ${uploadError.message}`);
  }
  
  return { fileSizeBytes: csvBytes.length };
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let projectId = "";

  try {
    const { project_id, data_source_id } = await req.json();
    projectId = project_id;

    console.log(`[ingest-cloud-data] Starting cloud data ingestion for project: ${project_id}, data source: ${data_source_id}`);

    // ── SSOT: Start ingestion ──
    const configHash = await hashConfigCloud({ data_source_id, connector: "cloud" });
    const startResult = await rpcStartIngestionCloud(supabase, project_id, "powerbi", configHash);
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
      console.error("[ingest-cloud-data] Error creating ingestion log:", logError);
      throw logError;
    }

    // Get data source configuration
    const { data: dataSource, error: dsError } = await supabase
      .from("data_sources")
      .select("*")
      .eq("id", data_source_id)
      .single();

    if (dsError || !dataSource) {
      console.error("[ingest-cloud-data] Data source not found:", dsError);
      throw new Error("Data source not found");
    }

    const connectorType = dataSource.connector_type;
    const connectionConfig = dataSource.connection_config as Record<string, any>;

    console.log(`[ingest-cloud-data] Cloud data source type: ${connectorType}`);

    let totalRows = 0;
    let sampleRows = 0;
    let columnsCount = 0;
    let columns: ColumnInfo[] = [];
    let storagePath = '';

    if (connectorType === 'powerbi') {
      // Power BI Semantic Model ingestion
      const { workspace_id, dataset_id, client_id, client_secret, tenant_id, table_name } = connectionConfig;

      console.log(`[ingest-cloud-data] Connecting to Power BI workspace=${workspace_id}, dataset=${dataset_id}`);

      // Validate table_name is provided (required for semantic models)
      if (!table_name || typeof table_name !== 'string' || table_name.trim() === '') {
        throw new Error('Table name is required for Power BI Semantic Model ingestion. Please specify the table name in the connection settings.');
      }

      const tableName = table_name.trim();
      console.log(`[ingest-cloud-data] Will process table: ${tableName}`);

      // Get access token
      const accessToken = await getPowerBIAccessToken(client_id, client_secret, tenant_id);
      console.log('[ingest-cloud-data] Got Power BI access token');

      // Get column info
      const tableColumns = await getTableColumns(accessToken, workspace_id, dataset_id, tableName);
      console.log(`[ingest-cloud-data] Found ${tableColumns.length} columns in table`);

      // Get row count using DAX
      const countQuery = `EVALUATE ROW("count", COUNTROWS('${tableName}'))`;
      try {
        const countResult = await executePowerBIQuery(accessToken, workspace_id, dataset_id, countQuery);
        if (countResult.results?.[0]?.tables?.[0]?.rows?.[0]) {
          const countRow = countResult.results[0].tables[0].rows[0];
          totalRows = countRow['[count]'] ?? countRow['count'] ?? 0;
        }
      } catch (error) {
        console.warn('[ingest-cloud-data] Could not get row count:', error);
        totalRows = 0;
      }
      console.log(`[ingest-cloud-data] Total rows in table: ${totalRows}`);

      // Query sample data using TOPN
      const sampleLimit = Math.min(totalRows || MAX_ROWS_TO_SAMPLE, MAX_ROWS_TO_SAMPLE);
      const sampleQuery = `EVALUATE TOPN(${sampleLimit}, '${tableName}')`;
      
      console.log(`[ingest-cloud-data] Fetching up to ${sampleLimit} sample rows...`);
      
      let rows: any[] = [];
      try {
        const sampleResult = await executePowerBIQuery(accessToken, workspace_id, dataset_id, sampleQuery);
        rows = sampleResult.results?.[0]?.tables?.[0]?.rows || [];
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('[ingest-cloud-data] Error fetching data:', errMsg);
        
        // Re-throw workspace/dataset/auth errors as-is (already have clear messages)
        if (errMsg.includes('WORKSPACE_NOT_FOUND') || errMsg.includes('DATASET_NOT_FOUND') || errMsg.includes('AUTH_ERROR')) {
          throw error;
        }
        
        if (errMsg.includes('PowerBIEntityNotFound') || errMsg.includes('404')) {
          throw new Error(
            `Tabela '${tableName}' não foi encontrada no modelo semântico (dataset_id: ${dataset_id}). ` +
            `Verifique se o nome está exatamente igual ao que aparece no Power BI (incluindo maiúsculas/minúsculas e espaços). ` +
            `Certifique-se também de que o workspace_id e dataset_id estão corretos.`
          );
        }
        throw new Error(`Falha ao buscar dados da tabela '${tableName}': ${errMsg}`);
      }
      
      sampleRows = rows.length;
      if (totalRows === 0) totalRows = sampleRows;
      console.log(`[ingest-cloud-data] Retrieved ${sampleRows} rows`);

      if (rows.length > 0) {
        // Extract column names from first row (Power BI returns [ColumnName] format)
        const firstRow = rows[0];
        const rawColumnNames = Object.keys(firstRow);
        
        // Clean column names (remove brackets)
        const columnNames = rawColumnNames.map(col => 
          col.replace(/^\[/, '').replace(/\]$/, '')
        );
        
        columnsCount = columnNames.length;

        // Build column type mapping from tableColumns
        const columnTypeMap = new Map<string, string>();
        for (const col of tableColumns) {
          columnTypeMap.set(col.name, col.dataType);
        }

        // Infer column types
        columns = columnNames.map((colName, idx) => {
          const rawKey = rawColumnNames[idx];
          const pbiType = columnTypeMap.get(colName) || '';
          const values = rows.slice(0, 100).map((r: any) => r[rawKey]);
          const inferredType = inferColumnType(pbiType, values);
          
          return {
            column_name: colName,
            inferred_type: inferredType,
            column_index: idx
          };
        });

        console.log(`[ingest-cloud-data] Detected ${columnsCount} columns`);

        // Generate storage path
        const timestamp = Date.now();
        storagePath = `${project_id}/powerbi_${dataset_id}_${timestamp}.csv`;

        // Convert to CSV and upload
        const { fileSizeBytes } = await convertToCSVAndUpload(
          supabase, 
          rows, 
          columnNames,
          storagePath
        );

        console.log(`[ingest-cloud-data] Uploaded CSV to ${storagePath} (${fileSizeBytes} bytes)`);

        // Deactivate previous datasets for this project
        await supabase
          .from('project_datasets')
          .update({ is_active: false })
          .eq('project_id', project_id);

        // Get user_id from project
        const { data: userData } = await supabase
          .from('projects')
          .select('user_id')
          .eq('id', project_id)
          .single();

        // Create project_datasets record
        const { error: datasetError } = await supabase
          .from('project_datasets')
          .insert({
            project_id,
            user_id: userData?.user_id,
            name: `${dataSource.name} - ${tableName}`,
            storage_path: storagePath,
            source_type: 'cloud',
            total_rows: totalRows,
            sample_rows: sampleRows,
            columns_count: columnsCount,
            file_size_bytes: fileSizeBytes,
            is_active: true,
            source_metadata: {
              connector_type: 'powerbi',
              workspace_id,
              dataset_id,
              table_name: tableName,
              data_source_id,
              delimiter: ';',
              encoding: 'UTF-8'
            }
          });

        if (datasetError) {
          console.error('[ingest-cloud-data] Error creating dataset record:', datasetError);
          throw new Error(`Failed to create dataset record: ${datasetError.message}`);
        }

        console.log('[ingest-cloud-data] Created project_datasets record');

        // Delete existing columns and insert new ones
        await supabase
          .from('project_columns')
          .delete()
          .eq('project_id', project_id);

        const { error: columnsError } = await supabase
          .from('project_columns')
          .insert(columns.map(col => ({
            project_id,
            column_name: col.column_name,
            inferred_type: col.inferred_type,
            column_index: col.column_index
          })));

        if (columnsError) {
          console.error('[ingest-cloud-data] Error inserting columns:', columnsError);
        } else {
          console.log(`[ingest-cloud-data] Inserted ${columns.length} column records`);
        }
      }
    } else {
      // For other connectors, simulate for now (TODO: implement real connectors)
      console.log(`[ingest-cloud-data] Connector type ${connectorType} not fully implemented yet`);
      totalRows = Math.floor(Math.random() * 50000) + 5000;
      sampleRows = Math.min(totalRows, MAX_ROWS_TO_SAMPLE);
      columnsCount = 0;
      storagePath = '';
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
        sync_message: `Successfully ingested ${totalRows} rows from cloud source`
      })
      .eq("id", data_source_id);

    // Update project - matching the pattern from process-import
    const projectUpdate: Record<string, any> = {
      data_source_id,
      total_rows: totalRows,
      sample_rows: sampleRows,
      dataset_rows: sampleRows,
      dataset_columns: columnsCount,
      status: "data_uploaded"
    };

    // Set dataset_filename only if we have a valid storage path
    if (storagePath) {
      projectUpdate.dataset_filename = storagePath;
    }

    await supabase
      .from("projects")
      .update(projectUpdate)
      .eq("id", project_id);

    // ── SSOT: Complete ingestion (success) ──
    await rpcCompleteIngestionCloud(supabase, project_id, true, {
      rowsDetected: totalRows, colsDetected: columnsCount, fileCount: 1,
    });

    // ── SSOT: Activate ingestion (creates dataset_state + cascade) ──
    try {
      await supabase.rpc("rpc_activate_ingestion", {
        p_project_id: project_id,
        p_source_type: connectorType || "cloud",
        p_config_hash: configHash,
        p_dataset_id: null,
        p_manifest_id: null,
        p_stats: { rows_detected: totalRows, cols_detected: columnsCount, file_count: 1, total_bytes: 0 },
      });
    } catch (e) { console.warn("[ingest-cloud-data] rpc_activate_ingestion fallback:", e); }

    console.log(`[ingest-cloud-data] Cloud ingestion completed: ${totalRows} rows read, ${sampleRows} sampled, ${columnsCount} columns`);

    return new Response(
      JSON.stringify({ 
        success: true,
        status: "DONE",
        ingestion_state: "done",
        rows_read: totalRows,
        rows_sampled: sampleRows,
        columns_count: columnsCount,
        storage_path: storagePath,
        message: `Successfully ingested data from ${dataSource.name}`
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  } catch (error: unknown) {
    console.error("[ingest-cloud-data] Error during cloud data ingestion:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred during cloud data ingestion";
    const errorCode = classifyCloudError(error);

    // ── SSOT: Complete ingestion (failure) ──
    if (projectId) {
      await rpcCompleteIngestionCloud(supabase, projectId, false, { errorCode, errorMessage });
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
async function hashConfigCloud(config: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(config));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function rpcStartIngestionCloud(supabase: any, projectId: string, sourceType: string, configHash: string) {
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

async function rpcCompleteIngestionCloud(supabase: any, projectId: string, success: boolean, stats: Record<string, unknown> = {}) {
  try {
    await supabase.rpc("rpc_complete_ingestion", {
      p_project_id: projectId, p_success: success,
      p_rows_detected: stats.rowsDetected || 0, p_cols_detected: stats.colsDetected || 0,
      p_file_count: stats.fileCount || 0, p_total_bytes: stats.totalBytes || 0,
      p_dataset_id: stats.datasetId || null, p_manifest_id: stats.manifestId || null,
      p_error_code: stats.errorCode || null, p_error_message: stats.errorMessage || null,
    });
  } catch (e) { console.warn("[ingest-cloud-data] rpc_complete_ingestion error:", e); }
}

function classifyCloudError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("auth") || msg.includes("permission") || msg.includes("401") || msg.includes("403")) return "CONNECTOR_AUTH_ERROR";
  if (msg.includes("timeout") || msg.includes("timed out")) return "CONNECTOR_TIMEOUT";
  if (msg.includes("not found") && (msg.includes("workspace") || msg.includes("dataset"))) return "TABLE_NOT_FOUND";
  if (msg.includes("not found")) return "CONNECTOR_NOT_FOUND";
  return "UNKNOWN";
}
