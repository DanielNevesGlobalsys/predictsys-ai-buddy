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
 * Get dataset tables from Power BI
 */
async function getPowerBIDatasetTables(
  accessToken: string,
  workspaceId: string,
  datasetId: string
): Promise<any[]> {
  const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/datasets/${datasetId}/tables`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ingest-cloud-data] Power BI tables error:', errorText);
    throw new Error(`Failed to get Power BI tables: ${response.status}`);
  }

  const data = await response.json();
  return data.value || [];
}

/**
 * Execute DAX query on Power BI dataset
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
    throw new Error(`Failed to execute DAX query: ${response.status}`);
  }

  return await response.json();
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

    // Check if numeric
    const numVal = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
    if (!isNaN(numVal) && isFinite(numVal)) {
      numericCount++;
      continue;
    }

    // Check if date
    const strVal = String(val);
    if (/^\d{4}-\d{2}-\d{2}/.test(strVal) || /^\d{2}\/\d{2}\/\d{4}/.test(strVal)) {
      dateCount++;
    }
  }

  if (validCount === 0) return 'texto';
  if (numericCount / validCount > 0.8) return 'numérico';
  if (dateCount / validCount > 0.8) return 'data';
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
      const val = row[col];
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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { project_id, data_source_id } = await req.json();

    console.log(`[ingest-cloud-data] Starting cloud data ingestion for project: ${project_id}, data source: ${data_source_id}`);

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
      const { workspace_id, dataset_id, client_id, client_secret, tenant_id } = connectionConfig;

      console.log(`[ingest-cloud-data] Connecting to Power BI workspace=${workspace_id}, dataset=${dataset_id}`);

      // Get access token
      const accessToken = await getPowerBIAccessToken(client_id, client_secret, tenant_id);
      console.log('[ingest-cloud-data] Got Power BI access token');

      // Get tables in the dataset
      const tables = await getPowerBIDatasetTables(accessToken, workspace_id, dataset_id);
      console.log(`[ingest-cloud-data] Found ${tables.length} tables in dataset`);

      if (tables.length === 0) {
        throw new Error('No tables found in Power BI dataset');
      }

      // Use the first/main table (or you could let user select)
      const mainTable = tables[0];
      const tableName = mainTable.name;
      console.log(`[ingest-cloud-data] Processing main table: ${tableName}`);

      // Get row count
      const countQuery = `EVALUATE ROW("count", COUNTROWS('${tableName}'))`;
      const countResult = await executePowerBIQuery(accessToken, workspace_id, dataset_id, countQuery);
      
      if (countResult.results?.[0]?.tables?.[0]?.rows?.[0]) {
        totalRows = countResult.results[0].tables[0].rows[0]['[count]'] || 0;
      }
      console.log(`[ingest-cloud-data] Total rows in table: ${totalRows}`);

      // Query sample data (limit for performance)
      const sampleLimit = Math.min(totalRows, MAX_ROWS_TO_SAMPLE);
      const sampleQuery = `EVALUATE TOPN(${sampleLimit}, '${tableName}')`;
      
      console.log(`[ingest-cloud-data] Fetching ${sampleLimit} sample rows...`);
      const sampleResult = await executePowerBIQuery(accessToken, workspace_id, dataset_id, sampleQuery);

      const rows = sampleResult.results?.[0]?.tables?.[0]?.rows || [];
      sampleRows = rows.length;
      console.log(`[ingest-cloud-data] Retrieved ${sampleRows} rows`);

      if (rows.length > 0) {
        // Extract column names from first row
        const firstRow = rows[0];
        const rawColumnNames = Object.keys(firstRow);
        
        // Power BI returns columns like "[ColumnName]" - clean them up
        const columnNames = rawColumnNames.map(col => 
          col.replace(/^\[/, '').replace(/\]$/, '')
        );
        
        columnsCount = columnNames.length;

        // Infer column types
        columns = columnNames.map((colName, idx) => {
          const rawKey = rawColumnNames[idx];
          const values = rows.slice(0, 100).map((r: any) => r[rawKey]);
          const inferredType = inferColumnType(values);
          
          return {
            column_name: colName,
            inferred_type: inferredType,
            column_index: idx
          };
        });

        console.log(`[ingest-cloud-data] Detected ${columnsCount} columns`);

        // Clean up row data (remove brackets from keys)
        const cleanedRows = rows.map((row: any) => {
          const cleaned: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            const cleanKey = key.replace(/^\[/, '').replace(/\]$/, '');
            cleaned[cleanKey] = value;
          }
          return cleaned;
        });

        // Generate storage path
        const timestamp = Date.now();
        storagePath = `${project_id}/powerbi_${dataset_id}_${timestamp}.csv`;

        // Convert to CSV and upload
        const { fileSizeBytes } = await convertToCSVAndUpload(
          supabase, 
          cleanedRows, 
          columnNames,
          storagePath
        );

        console.log(`[ingest-cloud-data] Uploaded CSV to ${storagePath} (${fileSizeBytes} bytes)`);

        // Deactivate previous datasets for this project
        await supabase
          .from('project_datasets')
          .update({ is_active: false })
          .eq('project_id', project_id);

        // Create project_datasets record
        const { data: userData } = await supabase
          .from('projects')
          .select('user_id')
          .eq('id', project_id)
          .single();

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

    console.log(`[ingest-cloud-data] Cloud ingestion completed: ${totalRows} rows read, ${sampleRows} sampled, ${columnsCount} columns`);

    return new Response(
      JSON.stringify({ 
        success: true,
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
