import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PREVIEW_LIMIT = 50;

interface ColumnDetail {
  name: string;
  type: string;
  is_key: boolean;
  is_temporal: boolean;
  nullable: boolean;
}

// ═══════════════════════════════════════════════════
// PostgreSQL Inspection
// ═══════════════════════════════════════════════════
async function inspectPostgreSQL(config: Record<string, any>, schema: string, tableName: string) {
  const sql = postgres({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    username: config.username,
    password: config.password,
    ssl: config.ssl ? 'require' : false,
    max: 1, idle_timeout: 20, connect_timeout: 30,
  });

  try {
    // Get columns
    const cols = await sql`
      SELECT 
        c.column_name, c.data_type, c.is_nullable,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
        WHERE tc.table_schema = ${schema} AND tc.table_name = ${tableName} AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      WHERE c.table_schema = ${schema} AND c.table_name = ${tableName}
      ORDER BY c.ordinal_position
    `;

    const columns: ColumnDetail[] = cols.map((c: any) => ({
      name: c.column_name,
      type: c.data_type,
      is_key: c.is_pk,
      is_temporal: ['timestamp', 'date', 'time'].some(t => c.data_type.toLowerCase().includes(t)),
      nullable: c.is_nullable === 'YES'
    }));

    // Get preview rows
    const preview = await sql.unsafe(`SELECT * FROM "${schema}"."${tableName}" LIMIT ${PREVIEW_LIMIT}`);
    const rows = preview.map((r: any) => ({ ...r }));

    await sql.end();
    return { columns, rows, row_count: rows.length };
  } catch (error) {
    await sql.end();
    throw error;
  }
}

// ═══════════════════════════════════════════════════
// Databricks Inspection
// ═══════════════════════════════════════════════════
async function inspectDatabricks(config: Record<string, any>, fullSchema: string, tableName: string) {
  const host = config.host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const httpPath = config.http_path;
  const accessToken = config.access_token;
  const warehouseId = httpPath.replace(/^\/sql\/1\.0\/warehouses\//, '').replace(/^\/sql\/protocolv1\/o\/\d+\//, '');

  // Parse catalog.schema from fullSchema
  const parts = fullSchema.split('.');
  const catalog = parts[0] || config.catalog || 'hive_metastore';
  const schema = parts[1] || config.schema || 'default';
  const fullTableName = `${catalog}.${schema}.${tableName}`;

  // Describe table
  const descResult = await execDatabricks(host, warehouseId, accessToken, `DESCRIBE TABLE ${fullTableName}`, catalog, schema);
  
  const columns: ColumnDetail[] = descResult.rows
    .filter((r: any) => r[0] && !r[0].startsWith('#'))
    .map((r: any) => ({
      name: r[0],
      type: r[1] || 'string',
      is_key: (r[0] || '').toLowerCase().endsWith('_id') || (r[0] || '').toLowerCase() === 'id',
      is_temporal: ['date', 'timestamp', 'datetime'].some(t => (r[1] || '').toLowerCase().includes(t)),
      nullable: true
    }));

  // Preview
  const previewResult = await execDatabricks(host, warehouseId, accessToken, `SELECT * FROM ${fullTableName} LIMIT ${PREVIEW_LIMIT}`, catalog, schema);
  const colNames = previewResult.columns;
  const rows = previewResult.rows.map((row: any[]) => {
    const obj: Record<string, any> = {};
    colNames.forEach((c: string, i: number) => { obj[c] = row[i]; });
    return obj;
  });

  return { columns, rows, row_count: rows.length };
}

async function execDatabricks(host: string, warehouseId: string, token: string, sql: string, catalog?: string, schema?: string) {
  const body: Record<string, any> = { statement: sql, warehouse_id: warehouseId, wait_timeout: "30s", on_wait_timeout: "CONTINUE" };
  if (catalog) body.catalog = catalog;
  if (schema) body.schema = schema;

  const resp = await fetch(`https://${host}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Databricks: ${resp.status}`);
  let data = await resp.json();

  if (['PENDING', 'RUNNING'].includes(data.status?.state)) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://${host}/api/2.0/sql/statements/${data.statement_id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      data = await poll.json();
      if (data.status?.state === 'SUCCEEDED') break;
      if (['FAILED', 'CANCELED', 'CLOSED'].includes(data.status?.state)) throw new Error(data.status?.error?.message);
    }
  }

  return {
    columns: (data.manifest?.schema?.columns || []).map((c: any) => c.name),
    rows: data.result?.data_array || []
  };
}

// ═══════════════════════════════════════════════════
// Power BI Inspection
// ═══════════════════════════════════════════════════
async function inspectPowerBI(config: Record<string, any>, tableName: string) {
  const { workspace_id, dataset_id, client_id, client_secret, tenant_id } = config;

  const tokenUrl = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials', client_id, client_secret,
    scope: 'https://analysis.windows.net/powerbi/api/.default'
  });
  const tokenResp = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  if (!tokenResp.ok) throw new Error(`Azure AD token error: ${tokenResp.status}`);
  const { access_token } = await tokenResp.json();

  const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;

  // Get columns
  const colResp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ query: `EVALUATE FILTER(INFO.COLUMNS(), [TableName] = "${tableName}")` }], serializerSettings: { includeNulls: true } })
  });
  
  const colResult = await colResp.json();
  const colRows = colResult.results?.[0]?.tables?.[0]?.rows || [];
  
  const columns: ColumnDetail[] = colRows.map((r: any) => {
    const name = r['[ExplicitName]'] || r['[Name]'] || r['ExplicitName'] || r['Name'] || '';
    const dataType = r['[DataType]'] || r['DataType'] || '';
    return {
      name,
      type: dataType,
      is_key: name.toLowerCase().endsWith('_id') || name.toLowerCase() === 'id' || name.toLowerCase().endsWith('key'),
      is_temporal: ['Date', 'DateTime'].some(t => dataType.includes(t)),
      nullable: true
    };
  });

  // Preview rows
  const previewResp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ query: `EVALUATE TOPN(${PREVIEW_LIMIT}, '${tableName}')` }], serializerSettings: { includeNulls: true } })
  });
  
  const previewResult = await previewResp.json();
  const rawRows = previewResult.results?.[0]?.tables?.[0]?.rows || [];
  
  // Clean column names
  const rows = rawRows.map((r: any) => {
    const clean: Record<string, any> = {};
    for (const [key, val] of Object.entries(r)) {
      clean[key.replace(/^\[/, '').replace(/\]$/, '')] = val;
    }
    return clean;
  });

  return { columns, rows, row_count: rows.length };
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
    const { object_id } = await req.json();
    if (!object_id) throw new Error("object_id is required");

    // Get discovery object + connection + data source
    const { data: obj, error: objError } = await supabase
      .from("external_discovery_objects")
      .select("*, external_connections!external_discovery_objects_connection_id_fkey(*, data_sources!external_connections_data_source_id_fkey(*))")
      .eq("id", object_id)
      .single();

    if (objError || !obj) throw new Error("Object not found");

    const connection = obj.external_connections;
    const dataSource = connection?.data_sources;
    if (!dataSource) throw new Error("No data source linked");

    const connectorType = connection.connector_type;
    const config = dataSource.connection_config as Record<string, any>;

    let result: { columns: ColumnDetail[]; rows: Record<string, any>[]; row_count: number };

    switch (connectorType) {
      case 'postgresql':
      case 'aws_rds':
      case 'aws_redshift': {
        const pgConfig = connectorType === 'postgresql' ? config : {
          host: config.endpoint, port: config.port || 5432,
          database: config.database, username: config.username, password: config.password, ssl: true
        };
        result = await inspectPostgreSQL(pgConfig, obj.object_schema || 'public', obj.object_name);
        break;
      }
      case 'databricks':
        result = await inspectDatabricks(config, obj.object_schema || '', obj.object_name);
        break;
      case 'powerbi':
        result = await inspectPowerBI(config, obj.object_name);
        break;
      default:
        throw new Error(`Inspection not supported for: ${connectorType}`);
    }

    // Persist column preview and sample rows on the object
    await supabase
      .from("external_discovery_objects")
      .update({
        column_preview: result.columns,
        sample_rows: result.rows,
        estimated_columns: result.columns.length
      })
      .eq("id", object_id);

    return new Response(
      JSON.stringify({ success: true, columns: result.columns, rows: result.rows, row_count: result.row_count }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    console.error("[inspect] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Inspection failed";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  }
});
