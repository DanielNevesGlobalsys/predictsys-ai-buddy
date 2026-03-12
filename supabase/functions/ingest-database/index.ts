import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

interface ColumnInfo {
  name: string;
  type: string;
  index: number;
}

function inferTypeFromDbType(dbType: string): string {
  const type = dbType.toLowerCase();
  
  if (['int', 'integer', 'bigint', 'smallint', 'decimal', 'numeric', 'float', 'double', 'real', 'money'].some(t => type.includes(t))) {
    return 'numérico';
  }
  if (['date', 'time', 'timestamp', 'datetime'].some(t => type.includes(t))) {
    return 'data';
  }
  if (['bool', 'boolean', 'bit'].some(t => type.includes(t))) {
    return 'booleano';
  }
  return 'texto';
}

async function queryPostgreSQL(config: ConnectionConfig, query: string, maxRows: number): Promise<{ columns: ColumnInfo[]; rows: Record<string, unknown>[]; totalRows: number }> {
  console.log(`[ingest-database] Connecting to PostgreSQL at ${config.host}:${config.port}/${config.database}`);
  
  const sql = postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    ssl: config.ssl ? 'require' : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 30,
  });

  try {
    // Get count first
    const countQuery = `SELECT COUNT(*) as total FROM (${query}) as subquery`;
    const countResult = await sql.unsafe(countQuery);
    const totalRows = parseInt(countResult[0]?.total || '0');
    
    // Execute with limit
    const limitedQuery = `${query} LIMIT ${maxRows}`;
    const result = await sql.unsafe(limitedQuery);
    
    if (!result || result.length === 0) {
      await sql.end();
      return { columns: [], rows: [], totalRows: 0 };
    }

    // Extract column info from first row
    const columns: ColumnInfo[] = Object.keys(result[0]).map((name, index) => ({
      name,
      type: inferTypeFromValue(result[0][name]),
      index
    }));

    const rows = result.map(row => ({ ...row }));
    
    await sql.end();
    console.log(`[ingest-database] PostgreSQL query complete: ${columns.length} columns, ${totalRows} total rows, ${rows.length} fetched`);
    
    return { columns, rows, totalRows };
  } catch (error) {
    await sql.end();
    throw error;
  }
}

function inferTypeFromValue(value: unknown): string {
  if (value === null || value === undefined) return 'texto';
  if (typeof value === 'number') return 'numérico';
  if (typeof value === 'boolean') return 'booleano';
  if (value instanceof Date) return 'data';
  if (typeof value === 'string') {
    // Try to detect date strings
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'data';
    // Try to detect numbers
    if (!isNaN(Number(value)) && value.trim() !== '') return 'numérico';
  }
  return 'texto';
}

async function queryMySQL(config: ConnectionConfig, query: string, maxRows: number): Promise<{ columns: ColumnInfo[]; rows: Record<string, unknown>[]; totalRows: number }> {
  console.log(`[ingest-database] MySQL connection requested to ${config.host}:${config.port}/${config.database}`);
  
  // MySQL in Deno requires mysql2 which has compatibility issues
  // For now, provide a helpful error message
  throw new Error(
    "MySQL direct connection is not yet fully supported in this environment. " +
    "Please export your data to CSV/Excel and use the file upload feature, " +
    "or use a PostgreSQL database which has full support."
  );
}

async function querySQLServer(config: ConnectionConfig, query: string, maxRows: number): Promise<{ columns: ColumnInfo[]; rows: Record<string, unknown>[]; totalRows: number }> {
  console.log(`[ingest-database] SQL Server connection requested to ${config.host}:${config.port}/${config.database}`);
  
  // SQL Server in Deno requires tedious which has compatibility issues
  // For now, provide a helpful error message
  throw new Error(
    "SQL Server direct connection is not yet fully supported in this environment. " +
    "Please export your data to CSV/Excel and use the file upload feature, " +
    "or use a PostgreSQL database which has full support."
  );
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
    const { project_id, data_source_id, custom_query } = await req.json();
    projectId = project_id;

    console.log(`[ingest-database] Starting database ingestion for project: ${project_id}, data source: ${data_source_id}`);

    // ── SSOT: Start ingestion ──
    const configHash = await hashConfig({ data_source_id, custom_query });
    const startResult = await rpcStartIngestion(supabase, project_id, "database", configHash);
    if (!startResult.canProceed && startResult.response) return startResult.response;

    // Create ingestion log
    const { data: logData, error: logError } = await supabase
      .from("project_data_ingestion_logs")
      .insert({
        project_id,
        data_source_id,
        status: "processing",
        metadata: { custom_query: custom_query || null }
      })
      .select()
      .single();

    if (logError) {
      console.error("[ingest-database] Error creating ingestion log:", logError);
      throw logError;
    }

    // Get data source configuration
    const { data: dataSource, error: dsError } = await supabase
      .from("data_sources")
      .select("*")
      .eq("id", data_source_id)
      .single();

    if (dsError || !dataSource) {
      console.error("[ingest-database] Data source not found:", dsError);
      throw new Error("Data source not found");
    }

    console.log(`[ingest-database] Data source type: ${dataSource.connector_type}`);

    const config = dataSource.connection_config as ConnectionConfig;
    const query = custom_query || 'SELECT * FROM ' + (config as unknown as { table?: string }).table || 'SELECT 1';
    const maxSampleRows = 100000;

    let result: { columns: ColumnInfo[]; rows: Record<string, unknown>[]; totalRows: number };

    switch (dataSource.connector_type) {
      case 'postgresql':
        result = await queryPostgreSQL(config, query, maxSampleRows);
        break;
      case 'mysql':
        result = await queryMySQL(config, query, maxSampleRows);
        break;
      case 'sqlserver':
        result = await querySQLServer(config, query, maxSampleRows);
        break;
      case 'oracle':
        throw new Error("Oracle connections are not yet supported. Please export your data to CSV/Excel.");
      default:
        throw new Error(`Unsupported connector type: ${dataSource.connector_type}`);
    }

    // Store columns
    await supabase
      .from('project_columns')
      .delete()
      .eq('project_id', project_id);

    if (result.columns.length > 0) {
      const columnsToInsert = result.columns.map(col => ({
        project_id,
        column_name: col.name,
        column_index: col.index,
        inferred_type: col.type
      }));

      await supabase
        .from('project_columns')
        .insert(columnsToInsert);
    }

    // Update ingestion log with results
    await supabase
      .from("project_data_ingestion_logs")
      .update({
        status: "success",
        rows_read: result.totalRows,
        rows_sampled: result.rows.length,
        completed_at: new Date().toISOString()
      })
      .eq("id", logData.id);

    // Update data source last sync
    await supabase
      .from("data_sources")
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: "success",
        sync_message: `Successfully ingested ${result.totalRows} rows`
      })
      .eq("id", data_source_id);

    // Update project with data info
    await supabase
      .from("projects")
      .update({
        data_source_id,
        total_rows: result.totalRows,
        sample_rows: result.rows.length,
        dataset_rows: result.rows.length,
        dataset_columns: result.columns.length,
        status: "data_uploaded"
      })
      .eq("id", project_id);

    // ── SSOT: Complete ingestion (success) ──
    await rpcCompleteIngestion(supabase, project_id, true, {
      rowsDetected: result.totalRows,
      colsDetected: result.columns.length,
      fileCount: 1,
    });

    console.log(`[ingest-database] Ingestion completed: ${result.totalRows} rows read, ${result.rows.length} sampled`);

    return new Response(
      JSON.stringify({ 
        success: true,
        status: "DONE",
        ingestion_state: "done",
        columns: result.columns,
        rows_read: result.totalRows,
        rows_sampled: result.rows.length,
        preview: result.rows.slice(0, 10),
        message: `Successfully ingested data from ${dataSource.name}`
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  } catch (error: unknown) {
    console.error("[ingest-database] Error during database ingestion:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred during data ingestion";
    const errorCode = classifyDbError(error);

    // ── SSOT: Complete ingestion (failure) ──
    if (projectId) {
      await rpcCompleteIngestion(supabase, projectId, false, { errorCode, errorMessage });
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
async function hashConfig(config: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(config));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function rpcStartIngestion(supabase: any, projectId: string, sourceType: string, configHash: string) {
  try {
    const { data, error } = await supabase.rpc("rpc_start_ingestion", {
      p_project_id: projectId, p_source_type: sourceType, p_source_config_hash: configHash,
    });
    if (error) { console.warn("[ingest-database] rpc_start_ingestion error:", error); return { canProceed: true }; }
    const r = data as Record<string, unknown>;
    if (r.status === "ALREADY_DONE") {
      return { canProceed: false, response: new Response(JSON.stringify({
        success: true, status: "ALREADY_DONE", ingestion_state: "done", message: r.message,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }) };
    }
    if (r.error === "INGESTION_ALREADY_RUNNING") {
      return { canProceed: false, response: new Response(JSON.stringify({
        success: false, status: "ALREADY_RUNNING", ingestion_state: "running",
        error_code: "INGESTION_ALREADY_RUNNING", error_friendly: "Já existe uma ingestão em andamento.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }) };
    }
    return { canProceed: true };
  } catch { return { canProceed: true }; }
}

async function rpcCompleteIngestion(supabase: any, projectId: string, success: boolean, stats: Record<string, unknown> = {}) {
  try {
    await supabase.rpc("rpc_complete_ingestion", {
      p_project_id: projectId, p_success: success,
      p_rows_detected: stats.rowsDetected || 0, p_cols_detected: stats.colsDetected || 0,
      p_file_count: stats.fileCount || 0, p_total_bytes: stats.totalBytes || 0,
      p_dataset_id: stats.datasetId || null, p_manifest_id: stats.manifestId || null,
      p_error_code: stats.errorCode || null, p_error_message: stats.errorMessage || null,
    });
  } catch (e) { console.warn("[ingest-database] rpc_complete_ingestion error:", e); }
}

function classifyDbError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("auth") || msg.includes("permission") || msg.includes("401") || msg.includes("403")) return "CONNECTOR_AUTH_ERROR";
  if (msg.includes("timeout") || msg.includes("timed out")) return "CONNECTOR_TIMEOUT";
  if (msg.includes("not found")) return "CONNECTOR_NOT_FOUND";
  return "UNKNOWN";
}
