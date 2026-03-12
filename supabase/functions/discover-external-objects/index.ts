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
  
  for (const s of schemasToScan.slice(0, 10)) {
    try {
      const tablesQuery = `SHOW TABLES IN ${catalog}.${s}`;
      const tablesResult = await executeDatabricksStatement(host, warehouseId, accessToken, tablesQuery, catalog, s);
      
      for (const row of tablesResult.rows) {
        const tableName = row[1] || row[0];
        const isTemp = row[2] === 'true';
        if (isTemp) continue;
        
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
// Power BI Discovery with 3-level fallback
// ═══════════════════════════════════════════════════

interface SourceTraceResult {
  detected: boolean;
  datasource_type: string | null;
  datasource_server: string | null;
  datasource_database: string | null;
  datasource_path: string | null;
  lineage_available: boolean;
  source_trace_status: 'detected' | 'partial' | 'not_available';
  source_trace_reason_code: string;
  confidence: 'high' | 'medium' | 'low';
  source_role: 'primary' | 'auxiliary';
  raw_datasources: any[];
  semantic_model_type: string | null;
}

const PRIMARY_SOURCE_TYPES_SET = new Set([
  'sql', 'sqlserver', 'azure_sql', 'azuresqldw', 'azure_synapse',
  'databricks', 'synapse', 'postgresql', 'mysql', 'oracle',
  'snowflake', 'bigquery', 'amazonredshift', 'aws_redshift',
  'microsoftfabricwarehouse', 'microsoftfabriclakehouse',
  'fabric_warehouse', 'fabric_lakehouse', 'sql_server',
  'analysisservices', 'analysis_services',
]);

interface PowerBIDiscoveryResult {
  objects: DiscoveredObject[];
  fallback_used: boolean;
  discovery_method: string;
  reason_code?: string;
  error_detail?: string;
  source_trace?: SourceTraceResult;
}

function classifyPowerBIError(errText: string): { reason_code: string; user_message: string; admin_message: string; fix_suggestion: string } {
  if (errText.includes('DatasetExecuteQueriesError') || errText.includes('AnalysisServicesErrorCode') || errText.includes('Failed to execute the DAX query') || errText.includes('DAX')) {
    return {
      reason_code: 'powerbi_dax_discovery_failed',
      user_message: 'A conexão com o dataset do Power BI foi estabelecida, mas o discovery automático falhou ao executar a consulta DAX de inspeção. Isso pode ocorrer por limitação do semantic model ou incompatibilidade do método de discovery.',
      admin_message: 'Power BI discovery reached ExecuteQueries but DAX query failed.',
      fix_suggestion: 'Use fallback metadata discovery, manual assisted selection, or connect to the SQL/lake source behind the semantic model.',
    };
  }
  if (errText.includes('WORKSPACE_NOT_FOUND') || errText.includes('PowerBIFolderNotFound')) {
    return {
      reason_code: 'powerbi_workspace_not_found',
      user_message: 'O workspace do Power BI não foi encontrado. Verifique o ID do workspace.',
      admin_message: 'Workspace ID not found in Power BI tenant.',
      fix_suggestion: 'Verify workspace_id and Service Principal access.',
    };
  }
  if (errText.includes('DATASET_NOT_FOUND') || errText.includes('DatasetNotFound')) {
    return {
      reason_code: 'powerbi_dataset_not_found',
      user_message: 'O dataset do Power BI não foi encontrado. Verifique o ID do dataset.',
      admin_message: 'Dataset ID not found in Power BI workspace.',
      fix_suggestion: 'Verify dataset_id exists and Service Principal has access.',
    };
  }
  if (errText.includes('AUTH_ERROR') || errText.includes('401') || errText.includes('403')) {
    return {
      reason_code: 'powerbi_auth_error',
      user_message: 'Erro de autenticação ao acessar o Power BI. Verifique as credenciais do Service Principal.',
      admin_message: 'Authentication/authorization error with Power BI API.',
      fix_suggestion: 'Verify client_id, client_secret, tenant_id and Service Principal permissions.',
    };
  }
  return {
    reason_code: 'powerbi_unknown_error',
    user_message: 'Ocorreu um erro ao acessar o Power BI. Tente novamente ou use um método alternativo de importação.',
    admin_message: `Power BI error: ${errText.substring(0, 200)}`,
    fix_suggestion: 'Check Power BI API logs and retry.',
  };
}

/** Map Power BI datasource connectionDetails to a known type */
function classifyDatasource(ds: any): { type: string; server: string | null; database: string | null; path: string | null } {
  const kind = (ds.datasourceType || '').toLowerCase();
  const details = ds.connectionDetails || {};
  const server = details.server || details.url || null;
  const database = details.database || null;
  const path = details.path || details.url || null;

  const typeMap: Record<string, string> = {
    'sql': 'azure_sql', 'azuresqldw': 'azure_synapse', 'analysisservices': 'analysis_services',
    'oracle': 'oracle', 'postgresql': 'postgresql', 'mysql': 'mysql',
    'azureblobs': 'azure_blob', 'azuredatalakestoragegen2': 'azure_data_lake',
    'azuredatalakestore': 'azure_data_lake', 'databricks': 'databricks',
    'snowflake': 'snowflake', 'web': 'web_api', 'odata': 'odata',
    'sharepoint': 'sharepoint', 'exchange': 'exchange',
    'sqlserver': 'sql_server', 'file': 'file', 'folder': 'folder',
    'azuretables': 'azure_tables', 'amazons3': 'aws_s3',
    'amazonredshift': 'aws_redshift', 'googleanalytics': 'google_analytics',
    'microsoftfabricwarehouse': 'fabric_warehouse', 'microsoftfabriclakehouse': 'fabric_lakehouse',
  };

  return {
    type: typeMap[kind] || kind || 'unknown',
    server,
    database,
    path: path !== server ? path : null,
  };
}

/** Level 2: Source tracing — identify underlying data source */
async function traceUnderlyingSource(
  accessToken: string,
  workspaceId: string,
  datasetId: string,
  supabaseClient: any,
  connectionId: string,
  projectId: string,
): Promise<SourceTraceResult> {
  const empty: SourceTraceResult = {
    detected: false, datasource_type: null, datasource_server: null,
    datasource_database: null, datasource_path: null,
    lineage_available: false, source_trace_status: 'not_available',
    source_trace_reason_code: 'no_datasource_info', confidence: 'low',
    source_role: 'auxiliary',
    raw_datasources: [], semantic_model_type: null,
  };

  // Log start (best-effort, never fatal)
  try {
    await Promise.resolve(supabaseClient.from('platform_events').insert({
      event_type: 'powerbi_source_trace_started',
      project_id: projectId,
      source: 'connector_powerbi',
      status: 'info',
      metadata: { connection_id: connectionId, workspace_id: workspaceId, dataset_id: datasetId, timestamp: new Date().toISOString() },
    }));
  } catch { /* best-effort */ }

  // Try GET /datasets/{id}/datasources
  const dsUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/datasets/${datasetId}/datasources`;
  try {
    const resp = await fetch(dsUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (!resp.ok) {
      const errText = await resp.text();
      try {
        await Promise.resolve(supabaseClient.from('platform_events').insert({
          event_type: 'powerbi_source_trace_failed',
          project_id: projectId, source: 'connector_powerbi', status: 'warn',
          metadata: { connection_id: connectionId, http_status: resp.status, error: errText.substring(0, 500), endpoint: dsUrl, timestamp: new Date().toISOString() },
        }));
      } catch (logErr) { console.warn('[source-trace] log persist failed:', logErr); }
      empty.source_trace_reason_code = `http_${resp.status}`;
      return empty;
    }

    const body = await resp.json();
    const datasources = body.value || [];
    empty.raw_datasources = datasources;

    if (datasources.length === 0) {
      empty.source_trace_reason_code = 'empty_datasources_response';
      return empty;
    }

    // Pick primary datasource (first SQL-like one, or first overall)
    const sqlLike = datasources.find((d: any) => {
      const t = (d.datasourceType || '').toLowerCase();
      return ['sql', 'sqlserver', 'azuresqldw', 'postgresql', 'mysql', 'oracle', 'snowflake', 'databricks',
        'amazonredshift', 'microsoftfabricwarehouse', 'microsoftfabriclakehouse'].includes(t);
    });
    const primary = sqlLike || datasources[0];
    const classified = classifyDatasource(primary);

    const sourceRole = PRIMARY_SOURCE_TYPES_SET.has(classified.type.toLowerCase()) ? 'primary' as const : 'auxiliary' as const;
    const result: SourceTraceResult = {
      detected: true,
      datasource_type: classified.type,
      datasource_server: classified.server,
      datasource_database: classified.database,
      datasource_path: classified.path,
      lineage_available: true,
      source_trace_status: classified.server ? 'detected' : 'partial',
      source_trace_reason_code: 'datasource_api_ok',
      confidence: sourceRole === 'primary' && classified.server && classified.database ? 'high' : classified.server ? 'medium' : 'low',
      source_role: sourceRole,
      raw_datasources: datasources,
      semantic_model_type: null,
    };

    // Try to get dataset details for semantic_model_type
    try {
      const detailUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/datasets/${datasetId}`;
      const detailResp = await fetch(detailUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      if (detailResp.ok) {
        const detail = await detailResp.json();
        // defaultMode: "Import" | "DirectQuery" | "Push" | "Streaming" | "PushStreaming"
        result.semantic_model_type = detail.defaultMode || null;
      }
    } catch { /* ignore */ }

    // Log success (best-effort)
    try {
      await Promise.resolve(supabaseClient.from('platform_events').insert({
        event_type: 'powerbi_source_detected',
        project_id: projectId, source: 'connector_powerbi', status: 'info',
        metadata: {
          connection_id: connectionId, datasource_type: result.datasource_type,
          datasource_server: result.datasource_server, datasource_database: result.datasource_database,
          confidence: result.confidence, semantic_model_type: result.semantic_model_type,
          datasources_count: datasources.length, timestamp: new Date().toISOString(),
        },
      }));
    } catch (logErr) { console.warn('[source-trace] log persist failed:', logErr); }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await Promise.resolve(supabaseClient.from('platform_events').insert({
        event_type: 'powerbi_source_trace_failed',
        project_id: projectId, source: 'connector_powerbi', status: 'warn',
        metadata: { connection_id: connectionId, error: msg.substring(0, 500), timestamp: new Date().toISOString() },
      }));
    } catch (logErr) { console.warn('[source-trace] log persist failed:', logErr); }
    empty.source_trace_reason_code = 'exception';
    return empty;
  }
}

async function discoverPowerBIWithFallback(
  config: Record<string, any>,
  supabaseClient: any,
  connectionId: string,
  projectId: string,
): Promise<PowerBIDiscoveryResult> {
  const { workspace_id, dataset_id, client_id, client_secret, tenant_id } = config;

  /** Helper to persist a diagnostic event to platform_events */
  async function logDiagnostic(eventType: string, meta: Record<string, unknown>) {
    const safeMeta = { ...meta };
    delete safeMeta.access_token;
    delete safeMeta.client_secret;
    delete safeMeta.authorization;
    if (safeMeta.headers && typeof safeMeta.headers === 'object') {
      const h = { ...(safeMeta.headers as Record<string, unknown>) };
      delete h.Authorization;
      delete h.authorization;
      safeMeta.headers = h;
    }

    const event = {
      event_type: eventType,
      project_id: projectId,
      source: 'connector_powerbi',
      status: 'info',
      metadata: {
        connection_id: connectionId,
        connector_type: 'powerbi',
        workspace_id,
        dataset_id,
        ...safeMeta,
        timestamp: new Date().toISOString(),
      },
    };
    try {
      await Promise.resolve(supabaseClient.from('platform_events').insert(event));
    } catch (e) {
      console.warn('[discover-pbi-diag] Failed to persist diagnostic event:', e);
    }
  }

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

  const executeUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;

  // ─── Level 1 Primary: DAX discovery with fallback chain ───
  const daxQueries = [
    { query: 'EVALUATE INFO.TABLES()', method: 'dax_info_tables' },
    { query: "SELECT [Name] FROM $SYSTEM.TMSCHEMA_TABLES WHERE NOT [IsHidden]", method: 'tmschema_tables' },
  ];

  let discoveryMethod = 'none';
  let daxDurationMs = 0;
  let daxObjects: DiscoveredObject[] = [];

  for (const dq of daxQueries) {
    const daxStartMs = Date.now();

    await logDiagnostic('powerbi_discovery_request', {
      endpoint: executeUrl, dax_query: dq.query, method: 'POST', phase: dq.method,
    });

    try {
      const resp = await fetch(executeUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ query: dq.query }], serializerSettings: { includeNulls: true } })
      });

      daxDurationMs = Date.now() - daxStartMs;

      if (!resp.ok) {
        const errText = await resp.text();
        await logDiagnostic('powerbi_discovery_error', {
          http_status: resp.status, error_payload_raw: errText.substring(0, 2000),
          dax_query: dq.query, endpoint_called: executeUrl, duration_ms: daxDurationMs, phase: dq.method,
        });
        continue; // Try next fallback
      }

      const result = await resp.json();
      const rows = result.results?.[0]?.tables?.[0]?.rows || [];

      await logDiagnostic('powerbi_discovery_response', {
        http_status: 200, duration_ms: daxDurationMs, rows_returned: rows.length,
        raw_response_size: JSON.stringify(result).length, endpoint: executeUrl, phase: dq.method,
      });

      for (const row of rows) {
        const name = row['[Name]'] || row['Name'] || Object.values(row)[0];
        if (!name || typeof name !== 'string' || name.startsWith('DateTable') || name.startsWith('LocalDateTable')) continue;

        let colCount: number | null = null;
        let rowCount: number | null = null;
        try {
          const colResp = await fetch(executeUrl, {
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

        daxObjects.push({
          object_name: name,
          object_type: 'semantic_model',
          object_schema: `${workspace_id}/${dataset_id}`,
          estimated_columns: colCount,
          estimated_rows: rowCount,
          last_updated_at: null,
          classification: classifyObject(name, colCount, rowCount),
          metadata: { workspace_id, dataset_id, discovery_source: dq.method }
        });
      }

      if (daxObjects.length > 0) {
        discoveryMethod = dq.method;
        break; // Success, no need to try next fallback
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await logDiagnostic('powerbi_discovery_error', {
        error_message: errMsg.substring(0, 500), phase: dq.method,
        duration_ms: Date.now() - daxStartMs,
      });
      continue;
    }
  }

  if (daxObjects.length > 0) {
    return { objects: daxObjects, fallback_used: discoveryMethod !== 'dax_info_tables', discovery_method: discoveryMethod };
  }

  // All DAX methods failed - continue to REST and source trace fallbacks
  const daxErrMsg = 'All DAX discovery methods failed';
  console.warn(`[discover] Power BI DAX discovery failed, attempting REST fallback`);

  const classified = classifyPowerBIError(daxErrMsg);

  // ─── Level 1 Fallback: REST API metadata ───
  const fallbackUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/tables`;
  const fallbackStartMs = Date.now();

  await logDiagnostic('powerbi_discovery_request', {
    endpoint: fallbackUrl, method: 'GET', phase: 'rest_fallback',
  });

  let restObjects: DiscoveredObject[] = [];
  let restFallbackWorked = false;

  try {
    const tablesResp = await fetch(fallbackUrl, {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });
    const fallbackDurationMs = Date.now() - fallbackStartMs;

    if (tablesResp.ok) {
      const tablesData = await tablesResp.json();
      const tables = tablesData.value || [];

      await logDiagnostic('powerbi_discovery_response', {
        http_status: 200, duration_ms: fallbackDurationMs, rows_returned: tables.length,
        raw_response_size: JSON.stringify(tablesData).length, endpoint: fallbackUrl, phase: 'rest_fallback',
      });

      restObjects = tables.map((t: any) => ({
        object_name: t.name,
        object_type: 'semantic_model',
        object_schema: `${workspace_id}/${dataset_id}`,
        estimated_columns: t.columns?.length ?? null,
        estimated_rows: null,
        last_updated_at: null,
        classification: classifyObject(t.name, t.columns?.length ?? null, null),
        metadata: { workspace_id, dataset_id, source: 'rest_fallback' }
      }));

      if (restObjects.length > 0) restFallbackWorked = true;
    } else {
      const fallbackErrText = await tablesResp.text();
      await logDiagnostic('powerbi_discovery_error', {
        http_status: tablesResp.status, error_payload_raw: fallbackErrText.substring(0, 2000),
        endpoint_called: fallbackUrl, duration_ms: fallbackDurationMs, phase: 'rest_fallback',
      });
    }
  } catch (fallbackErr) {
    const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    await logDiagnostic('powerbi_discovery_error', {
      error_message: fbMsg.substring(0, 500), endpoint_called: fallbackUrl,
      duration_ms: Date.now() - fallbackStartMs, phase: 'rest_fallback',
    });
    console.warn(`[discover] Power BI REST fallback also failed:`, fbMsg);
  }

  // ─── Level 2: Source tracing ───
  await logDiagnostic('powerbi_metadata_fallback_started', { phase: 'source_trace' });

  const sourceTrace = await traceUnderlyingSource(
    access_token, workspace_id, dataset_id,
    supabaseClient, connectionId, projectId,
  );

  await logDiagnostic('powerbi_metadata_fallback_finished', {
    phase: 'source_trace',
    source_detected: sourceTrace.detected,
    datasource_type: sourceTrace.datasource_type,
    confidence: sourceTrace.confidence,
    semantic_model_type: sourceTrace.semantic_model_type,
  });

  // Log assisted mode activated
  await logDiagnostic('powerbi_assisted_mode', {
    phase: 'level3',
    rest_fallback_worked: restFallbackWorked,
    rest_objects_count: restObjects.length,
    source_detected: sourceTrace.detected,
    datasource_type: sourceTrace.datasource_type,
  });

  // If REST fallback gave objects, return them with source trace
  if (restFallbackWorked) {
    return {
      objects: restObjects,
      fallback_used: true,
      discovery_method: 'rest_api_tables',
      reason_code: classified.reason_code,
      error_detail: daxErrMsg.substring(0, 500),
      source_trace: sourceTrace,
    };
  }

  // Both DAX and REST failed — return failure with source trace
  return {
    objects: [],
    fallback_used: true,
    discovery_method: 'none',
    reason_code: classified.reason_code,
    error_detail: daxErrMsg.substring(0, 500),
    source_trace: sourceTrace,
  };
}

// ═══════════════════════════════════════════════════
// Azure SQL / Synapse Discovery
// ═══════════════════════════════════════════════════
async function discoverAzureSQL(config: Record<string, any>): Promise<DiscoveredObject[]> {
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
  if (connectorType === 'aws_s3') {
    const { bucket, region, prefix } = config;
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
    const body = await req.json();
    const { connection_id, project_id, create_connection, data_source_id, connector_type, connection_name, organization_id, user_id } = body;

    if (!project_id) {
      throw new Error("project_id is required");
    }

    let effectiveConnectionId = connection_id;

    // If create_connection mode: create or find existing connection via service role
    if (create_connection && data_source_id && connector_type && connection_name && organization_id && user_id) {
      console.log(`[discover] Creating connection for data_source=${data_source_id}, project=${project_id}`);

      const { data: existing } = await supabase
        .from("external_connections")
        .select("id")
        .eq("project_id", project_id)
        .eq("data_source_id", data_source_id)
        .limit(1);

      if (existing && existing.length > 0) {
        effectiveConnectionId = existing[0].id;
        console.log(`[discover] Found existing connection=${effectiveConnectionId}`);
      } else {
        const { data: newConn, error: createError } = await supabase
          .from("external_connections")
          .insert({
            project_id,
            organization_id,
            user_id,
            data_source_id: data_source_id,
            connector_type,
            connection_name,
          })
          .select()
          .single();

        if (createError) {
          console.error(`[discover] Failed to create connection:`, createError.message);
          throw new Error(`Failed to create connection: ${createError.message}`);
        }
        effectiveConnectionId = newConn.id;
        console.log(`[discover] Created connection=${effectiveConnectionId}`);
      }
    }

    if (!effectiveConnectionId) {
      throw new Error("connection_id is required (or provide create_connection params)");
    }

    console.log(`[discover] Starting discovery for connection=${effectiveConnectionId}, project=${project_id}`);

    // Get connection info
    const { data: connection, error: connError } = await supabase
      .from("external_connections")
      .select("*, data_sources!external_connections_data_source_id_fkey(*)")
      .eq("id", effectiveConnectionId)
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
        connection_id: effectiveConnectionId,
        status: 'running',
        started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (runError) throw runError;
    const runId = run.id;

    let objects: DiscoveredObject[] = [];
    let powerbiResult: PowerBIDiscoveryResult | null = null;

    try {
      switch (connectorType) {
        case 'postgresql':
          objects = await discoverPostgreSQL(connectionConfig);
          break;
        case 'databricks':
          objects = await discoverDatabricks(connectionConfig);
          break;
        case 'powerbi':
          powerbiResult = await discoverPowerBIWithFallback(connectionConfig, supabase, effectiveConnectionId, project_id);
          objects = powerbiResult.objects;
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

      const isPowerBIFallbackFailure = connectorType === 'powerbi' && powerbiResult && powerbiResult.reason_code && objects.length === 0;

      // Persist discovered objects
      if (objects.length > 0) {
        const objectsToInsert = objects.map(obj => ({
          discovery_run_id: runId,
          project_id,
          connection_id: effectiveConnectionId,
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

      // Build evidence
      const evidence: Record<string, any> = { connector_type: connectorType, objects_count: objects.length };
      if (powerbiResult) {
        evidence.discovery_method = powerbiResult.discovery_method;
        evidence.fallback_used = powerbiResult.fallback_used;
        if (powerbiResult.reason_code) evidence.reason_code = powerbiResult.reason_code;
        if (powerbiResult.error_detail) evidence.error_detail = powerbiResult.error_detail;
        if (powerbiResult.reason_code) {
          const classified = classifyPowerBIError(powerbiResult.error_detail || '');
          evidence.message_admin = classified.admin_message;
          evidence.fix_suggestion = classified.fix_suggestion;
        }
        // Persist source trace in evidence
        if (powerbiResult.source_trace) {
          const st = powerbiResult.source_trace;
          evidence.source_trace = {
            detected: st.detected,
            datasource_type: st.datasource_type,
            datasource_server: st.datasource_server,
            datasource_database: st.datasource_database,
            datasource_path: st.datasource_path,
            lineage_available: st.lineage_available,
            source_trace_status: st.source_trace_status,
            source_trace_reason_code: st.source_trace_reason_code,
            confidence: st.confidence,
            semantic_model_type: st.semantic_model_type,
            datasources_count: st.raw_datasources?.length || 0,
          };
        }
      }

      // Determine run status
      let runStatus = 'done';
      let runErrorMessage: string | null = null;
      let runReasons: string[] | null = null;

      if (isPowerBIFallbackFailure) {
        runStatus = 'failed_with_fallback';
        const classified = classifyPowerBIError(powerbiResult!.error_detail || '');
        // Use source-trace-aware message
        if (powerbiResult!.source_trace?.detected) {
          runErrorMessage = `Foi possível estabelecer conexão com o dataset do Power BI, mas o discovery automático do semantic model não está disponível para este caso. Detectamos uma possível fonte analítica subjacente (${powerbiResult!.source_trace.datasource_type}) e recomendamos conectar diretamente essa fonte para uma ingestão mais estável no PredictSys.`;
        } else {
          runErrorMessage = 'O dataset do Power BI foi localizado, mas a inspeção automática do semantic model não pôde ser concluída. Você pode usar um arquivo exportado ou conectar manualmente a fonte analítica de origem.';
        }
        runReasons = [powerbiResult!.reason_code!];
      }

      // Update run status
      await supabase
        .from("external_discovery_runs")
        .update({
          status: runStatus,
          objects_found: objects.length,
          finished_at: new Date().toISOString(),
          evidence,
          error_message: runErrorMessage,
          reasons: runReasons,
        })
        .eq("id", runId);

      // Update connection status with granular Power BI states
      let connStatus = 'validated';
      if (connectorType === 'powerbi') {
        if (isPowerBIFallbackFailure) {
          connStatus = 'connected_partial_discovery';
        } else if (objects.length > 0) {
          connStatus = 'connected_full_discovery';
        }
      }
      const connMessage = isPowerBIFallbackFailure
        ? `Discovery parcial: DAX falhou, conexão válida. ${powerbiResult?.reason_code}`
        : `Discovery completed: ${objects.length} objects found`;

      await supabase
        .from("external_connections")
        .update({
          connection_status: connStatus,
          last_validated_at: new Date().toISOString(),
          validation_message: connMessage
        })
        .eq("id", effectiveConnectionId);

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

    // Build response
    const responsePayload: Record<string, any> = {
      success: true,
      connection_id: effectiveConnectionId,
      run_id: runId,
      objects_found: objects.length,
      objects: objects.map(o => ({
        name: o.object_name, type: o.object_type, schema: o.object_schema,
        columns: o.estimated_columns, rows: o.estimated_rows, classification: o.classification
      })),
    };

    // Attach fallback info
    if (powerbiResult && powerbiResult.reason_code) {
      const classified = classifyPowerBIError(powerbiResult.error_detail || '');
      responsePayload.fallback = {
        reason_code: powerbiResult.reason_code,
        discovery_method: powerbiResult.discovery_method,
        fallback_used: powerbiResult.fallback_used,
        user_message: classified.user_message,
        fix_suggestion: classified.fix_suggestion,
      };

      // Attach source trace info for frontend
      if (powerbiResult.source_trace) {
        responsePayload.source_trace = {
          detected: powerbiResult.source_trace.detected,
          datasource_type: powerbiResult.source_trace.datasource_type,
          datasource_server: powerbiResult.source_trace.datasource_server,
          datasource_database: powerbiResult.source_trace.datasource_database,
          datasource_path: powerbiResult.source_trace.datasource_path,
          semantic_model_type: powerbiResult.source_trace.semantic_model_type,
          confidence: powerbiResult.source_trace.confidence,
          source_role: powerbiResult.source_trace.source_role,
          source_trace_status: powerbiResult.source_trace.source_trace_status,
        };
      }
    }

    return new Response(
      JSON.stringify(responsePayload),
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
