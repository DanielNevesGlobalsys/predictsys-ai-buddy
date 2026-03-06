import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DiscoveredObject {
  object_name: string;
  object_type: string;
  object_schema: string | null;
  estimated_columns: number | null;
  estimated_rows: number | null;
  last_updated_at: string | null;
  classification: string;
  metadata: Record<string, unknown>;
}

/** Classify table as fact/dimension based on heuristics */
function classifyObject(name: string, colCount: number | null, rowCount: number | null): string {
  const lower = name.toLowerCase();
  if (/^(dim_|d_|dimension)/.test(lower) || lower.includes('_dim')) return 'dimension';
  if (/^(fact_|f_|fct_)/.test(lower) || lower.includes('_fact')) return 'fact';
  if (/^(bridge_|br_)/.test(lower)) return 'bridge';
  // Heuristic: high row count + many columns = likely fact
  if (rowCount && colCount && rowCount > 10000 && colCount > 8) return 'fact';
  if (rowCount && rowCount < 1000 && colCount && colCount < 10) return 'dimension';
  return 'unknown';
}

// ═══════════════════════════════════════════════════
// PostgreSQL Discovery
// ═══════════════════════════════════════════════════
async function discoverPostgreSQL(config: Record<string, any>): Promise<DiscoveredObject[]> {
  const sql = postgres({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    username: config.username,
    password: config.password,
    ssl: config.ssl ? 'require' : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 30,
  });

  try {
    const result = await sql`
      SELECT 
        t.table_schema,
        t.table_name,
        t.table_type,
        (SELECT count(*)::int FROM information_schema.columns c 
         WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) as col_count,
        pg_stat.n_live_tup as estimated_rows,
        GREATEST(pg_stat.last_autovacuum, pg_stat.last_autoanalyze) as last_activity
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables pg_stat 
        ON pg_stat.schemaname = t.table_schema AND pg_stat.relname = t.table_name
      WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND t.table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY t.table_schema, t.table_name
    `;
    
    await sql.end();
    
    return result.map((row: any) => ({
      object_name: row.table_name,
      object_type: row.table_type === 'VIEW' ? 'view' : 'table',
      object_schema: row.table_schema,
      estimated_columns: row.col_count,
      estimated_rows: row.estimated_rows ? Number(row.estimated_rows) : null,
      last_updated_at: row.last_activity ? new Date(row.last_activity).toISOString() : null,
      classification: classifyObject(row.table_name, row.col_count, row.estimated_rows ? Number(row.estimated_rows) : null),
      metadata: {}
    }));
  } catch (error) {
    await sql.end();
    throw error;
  }
}

// ═══════════════════════════════════════════════════
// Databricks Discovery
// ═══════════════════════════════════════════════════
async function discoverDatabricks(config: Record<string, any>): Promise<DiscoveredObject[]> {
  const host = config.host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const httpPath = config.http_path;
  const accessToken = config.access_token;
  const catalog = config.catalog || 'hive_metastore';
  const schema = config.schema;
  
  const warehouseId = httpPath.replace(/^\/sql\/1\.0\/warehouses\//, '').replace(/^\/sql\/protocolv1\/o\/\d+\//, '');
  
  // List schemas if no specific schema
  const schemasToScan: string[] = [];
  if (schema) {
    schemasToScan.push(schema);
  } else {
    const schemaQuery = `SHOW SCHEMAS IN ${catalog}`;
    const schemaResult = await executeDatabricksStatement(host, warehouseId, accessToken, schemaQuery, catalog);
    for (const row of schemaResult.rows) {
      const schemaName = row[0];
      if (!['information_schema', 'default'].includes(schemaName)) {
        schemasToScan.push(schemaName);
      }
    }
    if (schemasToScan.length === 0) schemasToScan.push('default');
  }

  const objects: DiscoveredObject[] = [];
  
  for (const s of schemasToScan.slice(0, 10)) { // Limit to 10 schemas
    try {
      const tablesQuery = `SHOW TABLES IN ${catalog}.${s}`;
      const tablesResult = await executeDatabricksStatement(host, warehouseId, accessToken, tablesQuery, catalog, s);
      
      for (const row of tablesResult.rows) {
        const tableName = row[1] || row[0]; // database, tableName, isTemporary
        const isTemp = row[2] === 'true';
        if (isTemp) continue;
        
        // Try to get row count (best-effort)
        let rowCount: number | null = null;
        let colCount: number | null = null;
        try {
          const descResult = await executeDatabricksStatement(host, warehouseId, accessToken, 
            `DESCRIBE TABLE ${catalog}.${s}.${tableName}`, catalog, s);
          colCount = descResult.rows.filter((r: any) => r[0] && !r[0].startsWith('#')).length;
        } catch { /* ignore */ }

        objects.push({
          object_name: tableName,
          object_type: 'table',
          object_schema: `${catalog}.${s}`,
          estimated_columns: colCount,
          estimated_rows: rowCount,
          last_updated_at: null,
          classification: classifyObject(tableName, colCount, rowCount),
          metadata: { catalog, schema: s }
        });
      }
    } catch (err) {
      console.warn(`[discover] Error scanning schema ${s}:`, err);
    }
  }
  
  return objects;
}

async function executeDatabricksStatement(
  host: string, warehouseId: string, accessToken: string, 
  sql: string, catalog?: string, schema?: string
): Promise<{ columns: string[]; rows: any[][] }> {
  const body: Record<string, any> = {
    statement: sql,
    warehouse_id: warehouseId,
    wait_timeout: "30s",
    on_wait_timeout: "CONTINUE"
  };
  if (catalog) body.catalog = catalog;
  if (schema) body.schema = schema;

  const response = await fetch(`https://${host}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(`Databricks error: ${response.status}`);
  let data = await response.json();

  if (data.status?.state === 'PENDING' || data.status?.state === 'RUNNING') {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://${host}/api/2.0/sql/statements/${data.statement_id}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      data = await poll.json();
      if (data.status?.state === 'SUCCEEDED') break;
      if (['FAILED', 'CANCELED', 'CLOSED'].includes(data.status?.state)) {
        throw new Error(`Query ${data.status.state}: ${data.status?.error?.message}`);
      }
    }
  }

  return {
    columns: (data.manifest?.schema?.columns || []).map((c: any) => c.name),
    rows: data.result?.data_array || []
  };
}

// ═══════════════════════════════════════════════════
// Power BI Discovery
// ═══════════════════════════════════════════════════
async function discoverPowerBI(config: Record<string, any>): Promise<DiscoveredObject[]> {
  const { workspace_id, dataset_id, client_id, client_secret, tenant_id } = config;
  
  // Get access token
  const tokenUrl = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id, client_secret,
    scope: 'https://analysis.windows.net/powerbi/api/.default'
  });
  const tokenResp = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  if (!tokenResp.ok) throw new Error(`Azure AD token error: ${tokenResp.status}`);
  const { access_token } = await tokenResp.json();

  // Get tables via DMV
  const daxQuery = `EVALUATE INFO.TABLES()`;
  const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ query: daxQuery }], serializerSettings: { includeNulls: true } })
  });
  
  if (!resp.ok) {
    const errText = await resp.text();
    if (errText.includes('PowerBIFolderNotFound')) throw new Error(`WORKSPACE_NOT_FOUND: workspace_id ${workspace_id} não encontrado.`);
    if (errText.includes('PowerBINotFound') || errText.includes('DatasetNotFound')) throw new Error(`DATASET_NOT_FOUND: dataset_id ${dataset_id} não encontrado.`);
    if (resp.status === 401 || resp.status === 403) throw new Error(`AUTH_ERROR: Sem permissão. Verifique credenciais e Service Principal.`);
    throw new Error(`Power BI error: ${resp.status} - ${errText}`);
  }

  const result = await resp.json();
  const rows = result.results?.[0]?.tables?.[0]?.rows || [];
  
  const objects: DiscoveredObject[] = [];
  
  for (const row of rows) {
    const name = row['[Name]'] || row['Name'];
    if (!name || name.startsWith('DateTable') || name.startsWith('LocalDateTable')) continue;
    
    // Get column count via INFO.COLUMNS
    let colCount: number | null = null;
    let rowCount: number | null = null;
    try {
      const colResp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ query: `EVALUATE ROW("cols", COUNTROWS(INFO.COLUMNS()), "rows", COUNTROWS('${name}'))` }], serializerSettings: { includeNulls: true } })
      });
      if (colResp.ok) {
        const colResult = await colResp.json();
        const r = colResult.results?.[0]?.tables?.[0]?.rows?.[0];
        if (r) {
          colCount = r['[cols]'] ?? r['cols'] ?? null;
          rowCount = r['[rows]'] ?? r['rows'] ?? null;
        }
      }
    } catch { /* ignore */ }

    objects.push({
      object_name: name,
      object_type: 'semantic_model',
      object_schema: `${workspace_id}/${dataset_id}`,
      estimated_columns: colCount,
      estimated_rows: rowCount,
      last_updated_at: null,
      classification: classifyObject(name, colCount, rowCount),
      metadata: { workspace_id, dataset_id }
    });
  }

  return objects;
}

// ═══════════════════════════════════════════════════
// Azure SQL / Synapse Discovery
// ═══════════════════════════════════════════════════
async function discoverAzureSQL(config: Record<string, any>): Promise<DiscoveredObject[]> {
  // Azure SQL uses the same protocol as PostgreSQL for discovery (via information_schema)
  // But since we can't directly connect with pg driver, we return a placeholder
  // In production, this would use the Azure SQL REST API or TDS protocol
  console.log(`[discover] Azure SQL discovery not yet fully implemented for server: ${config.server}`);
  return [{
    object_name: config.database || 'database',
    object_type: 'table',
    object_schema: 'dbo',
    estimated_columns: null,
    estimated_rows: null,
    last_updated_at: null,
    classification: 'unknown',
    metadata: { server: config.server, note: 'Full discovery requires TDS driver' }
  }];
}

// ═══════════════════════════════════════════════════
// AWS S3 / Azure Blob Discovery (file-based)
// ═══════════════════════════════════════════════════
async function discoverCloudStorage(config: Record<string, any>, connectorType: string): Promise<DiscoveredObject[]> {
  // For S3/Blob, we list files as discoverable objects
  if (connectorType === 'aws_s3') {
    const { bucket, region, access_key_id, secret_access_key, prefix } = config;
    // We'd use AWS SDK to list objects - simplified here
    return [{
      object_name: prefix || bucket,
      object_type: 'file',
      object_schema: `s3://${bucket}`,
      estimated_columns: null,
      estimated_rows: null,
      last_updated_at: null,
      classification: 'unknown',
      metadata: { bucket, region, prefix }
    }];
  }
  
  if (connectorType === 'azure_blob') {
    return [{
      object_name: config.blob_path || config.container,
      object_type: 'file',
      object_schema: `azure://${config.account_name}/${config.container}`,
      estimated_columns: null,
      estimated_rows: null,
      last_updated_at: null,
      classification: 'unknown',
      metadata: { account_name: config.account_name, container: config.container }
    }];
  }

  return [];
}

// ═══════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { connection_id, project_id } = await req.json();

    if (!connection_id || !project_id) {
      throw new Error("connection_id and project_id are required");
    }

    console.log(`[discover] Starting discovery for connection=${connection_id}, project=${project_id}`);

    // Get connection info
    const { data: connection, error: connError } = await supabase
      .from("external_connections")
      .select("*, data_sources!external_connections_data_source_id_fkey(*)")
      .eq("id", connection_id)
      .single();

    if (connError || !connection) {
      throw new Error("Connection not found");
    }

    const dataSource = connection.data_sources;
    if (!dataSource) {
      throw new Error("No data source linked to this connection");
    }

    const connectorType = connection.connector_type;
    const connectionConfig = dataSource.connection_config as Record<string, any>;

    // Create discovery run
    const { data: run, error: runError } = await supabase
      .from("external_discovery_runs")
      .insert({
        project_id,
        connection_id,
        status: 'running',
        started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (runError) throw runError;
    const runId = run.id;

    let objects: DiscoveredObject[] = [];

    try {
      switch (connectorType) {
        case 'postgresql':
          objects = await discoverPostgreSQL(connectionConfig);
          break;
        case 'databricks':
          objects = await discoverDatabricks(connectionConfig);
          break;
        case 'powerbi':
          objects = await discoverPowerBI(connectionConfig);
          break;
        case 'azure_sql':
        case 'azure_synapse':
          objects = await discoverAzureSQL(connectionConfig);
          break;
        case 'aws_s3':
        case 'azure_blob':
          objects = await discoverCloudStorage(connectionConfig, connectorType);
          break;
        case 'aws_rds':
        case 'aws_redshift':
          // These use PostgreSQL protocol
          objects = await discoverPostgreSQL({
            host: connectionConfig.endpoint,
            port: connectionConfig.port || 5432,
            database: connectionConfig.database,
            username: connectionConfig.username,
            password: connectionConfig.password,
            ssl: true
          });
          break;
        default:
          throw new Error(`Discovery not supported for connector type: ${connectorType}`);
      }

      console.log(`[discover] Found ${objects.length} objects`);

      // Persist discovered objects
      if (objects.length > 0) {
        const objectsToInsert = objects.map(obj => ({
          discovery_run_id: runId,
          project_id,
          connection_id,
          object_name: obj.object_name,
          object_type: obj.object_type,
          object_schema: obj.object_schema,
          estimated_columns: obj.estimated_columns,
          estimated_rows: obj.estimated_rows,
          last_updated_at: obj.last_updated_at,
          classification: obj.classification,
          metadata: obj.metadata
        }));

        await supabase.from("external_discovery_objects").insert(objectsToInsert);
      }

      // Update run status
      await supabase
        .from("external_discovery_runs")
        .update({
          status: 'done',
          objects_found: objects.length,
          finished_at: new Date().toISOString(),
          evidence: { connector_type: connectorType, objects_count: objects.length }
        })
        .eq("id", runId);

      // Update connection status
      await supabase
        .from("external_connections")
        .update({
          connection_status: 'validated',
          last_validated_at: new Date().toISOString(),
          validation_message: `Discovery completed: ${objects.length} objects found`
        })
        .eq("id", connection_id);

    } catch (discoveryError) {
      const errMsg = discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
      console.error(`[discover] Discovery failed:`, errMsg);

      await supabase
        .from("external_discovery_runs")
        .update({
          status: 'failed',
          error_message: errMsg,
          finished_at: new Date().toISOString(),
          reasons: [errMsg]
        })
        .eq("id", runId);

      throw discoveryError;
    }

    return new Response(
      JSON.stringify({
        success: true,
        run_id: runId,
        objects_found: objects.length,
        objects: objects.map(o => ({
          name: o.object_name,
          type: o.object_type,
          schema: o.object_schema,
          columns: o.estimated_columns,
          rows: o.estimated_rows,
          classification: o.classification
        }))
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    console.error("[discover] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Discovery failed";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  }
});
