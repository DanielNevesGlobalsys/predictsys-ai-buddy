import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_ROWS = 100000;

// ═══════════════════════════════════════════════════
// CSV conversion utility
// ═══════════════════════════════════════════════════
function rowsToCSV(columns: string[], rows: Record<string, any>[]): Uint8Array {
  const lines: string[] = [];
  lines.push(columns.map(c => `"${c.replace(/"/g, '""')}"`).join(';'));
  for (const row of rows) {
    const vals = columns.map(c => {
      const v = row[c];
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes('"') || s.includes(';') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    });
    lines.push(vals.join(';'));
  }
  return new TextEncoder().encode(lines.join('\n'));
}

function arrayRowsToCSV(columns: string[], rows: any[][]): Uint8Array {
  const lines: string[] = [];
  lines.push(columns.map(c => `"${c.replace(/"/g, '""')}"`).join(';'));
  for (const row of rows) {
    const vals = row.map(v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes('"') || s.includes(';') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    });
    lines.push(vals.join(';'));
  }
  return new TextEncoder().encode(lines.join('\n'));
}

// ═══════════════════════════════════════════════════
// Data fetchers per connector
// ═══════════════════════════════════════════════════
async function fetchPostgreSQL(config: Record<string, any>, schema: string, tableName: string): Promise<{ columns: string[]; csvBytes: Uint8Array; rowCount: number }> {
  const sql = postgres({
    host: config.host, port: config.port || 5432, database: config.database,
    username: config.username, password: config.password,
    ssl: config.ssl ? 'require' : false, max: 1, idle_timeout: 20, connect_timeout: 30,
  });

  try {
    const countResult = await sql.unsafe(`SELECT COUNT(*)::int as cnt FROM "${schema}"."${tableName}"`);
    const totalRows = countResult[0]?.cnt || 0;
    const result = await sql.unsafe(`SELECT * FROM "${schema}"."${tableName}" LIMIT ${MAX_ROWS}`);
    const columns = result.length > 0 ? Object.keys(result[0]) : [];
    const rows = result.map((r: any) => ({ ...r }));
    const csvBytes = rowsToCSV(columns, rows);
    await sql.end();
    return { columns, csvBytes, rowCount: totalRows };
  } catch (e) {
    await sql.end();
    throw e;
  }
}

async function fetchDatabricks(config: Record<string, any>, fullSchema: string, tableName: string): Promise<{ columns: string[]; csvBytes: Uint8Array; rowCount: number }> {
  const host = config.host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const httpPath = config.http_path;
  const accessToken = config.access_token;
  const warehouseId = httpPath.replace(/^\/sql\/1\.0\/warehouses\//, '').replace(/^\/sql\/protocolv1\/o\/\d+\//, '');
  const parts = fullSchema.split('.');
  const catalog = parts[0] || config.catalog;
  const schema = parts[1] || config.schema;
  const fullName = `${catalog}.${schema}.${tableName}`;

  const body: Record<string, any> = { statement: `SELECT * FROM ${fullName} LIMIT ${MAX_ROWS}`, warehouse_id: warehouseId, wait_timeout: "50s", on_wait_timeout: "CONTINUE" };
  if (catalog) body.catalog = catalog;
  if (schema) body.schema = schema;

  const resp = await fetch(`https://${host}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Databricks: ${resp.status}`);
  let data = await resp.json();

  if (['PENDING', 'RUNNING'].includes(data.status?.state)) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://${host}/api/2.0/sql/statements/${data.statement_id}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      data = await poll.json();
      if (data.status?.state === 'SUCCEEDED') break;
      if (['FAILED', 'CANCELED', 'CLOSED'].includes(data.status?.state)) throw new Error(data.status?.error?.message);
    }
  }

  const columns = (data.manifest?.schema?.columns || []).map((c: any) => c.name);
  const rows = data.result?.data_array || [];
  const csvBytes = arrayRowsToCSV(columns, rows);
  return { columns, csvBytes, rowCount: rows.length };
}

async function fetchPowerBI(config: Record<string, any>, tableName: string): Promise<{ columns: string[]; csvBytes: Uint8Array; rowCount: number }> {
  const { workspace_id, dataset_id, client_id, client_secret, tenant_id } = config;

  const tokenResp = await fetch(`https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id, client_secret, scope: 'https://analysis.windows.net/powerbi/api/.default' }).toString()
  });
  if (!tokenResp.ok) throw new Error(`Azure AD: ${tokenResp.status}`);
  const { access_token } = await tokenResp.json();

  const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ query: `EVALUATE TOPN(${MAX_ROWS}, '${tableName}')` }], serializerSettings: { includeNulls: true } })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Power BI query failed: ${resp.status} - ${errText}`);
  }

  const result = await resp.json();
  const rawRows = result.results?.[0]?.tables?.[0]?.rows || [];

  if (rawRows.length === 0) return { columns: [], csvBytes: new Uint8Array(), rowCount: 0 };

  const rawKeys = Object.keys(rawRows[0]);
  const columns = rawKeys.map(k => k.replace(/^\[/, '').replace(/\]$/, ''));
  
  const rows = rawRows.map((r: any) => {
    const clean: Record<string, any> = {};
    rawKeys.forEach((k, i) => { clean[columns[i]] = r[k]; });
    return clean;
  });

  const csvBytes = rowsToCSV(columns, rows);
  return { columns, csvBytes, rowCount: rawRows.length };
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
    const { project_id, object_ids, promote } = await req.json();
    if (!project_id || !object_ids?.length) throw new Error("project_id and object_ids are required");

    console.log(`[import] Starting import of ${object_ids.length} objects for project=${project_id}`);

    // Get objects with their connections
    const { data: objects, error: objError } = await supabase
      .from("external_discovery_objects")
      .select("*, external_connections!external_discovery_objects_connection_id_fkey(*, data_sources!external_connections_data_source_id_fkey(*))")
      .in("id", object_ids)
      .eq("project_id", project_id);

    if (objError || !objects?.length) throw new Error("Objects not found");

    const connection = objects[0].external_connections;
    const connectionId = connection.id;

    // Create import run
    const { data: importRun, error: runError } = await supabase
      .from("external_import_runs")
      .insert({ project_id, connection_id: connectionId, status: 'running', total_objects: objects.length, started_at: new Date().toISOString() })
      .select().single();
    if (runError) throw runError;

    // ── SSOT: Start ingestion ──
    try {
      await supabase.rpc("rpc_start_ingestion", { p_project_id: project_id, p_source_type: "external_connector" });
    } catch { /* ignore */ }

    const importRunId = importRun.id;
    let completed = 0;
    let failed = 0;
    const results: any[] = [];

    // Get project user_id
    const { data: projectData } = await supabase.from("projects").select("user_id, organization_id").eq("id", project_id).single();

    for (const obj of objects) {
      const dataSource = obj.external_connections?.data_sources;
      if (!dataSource) { failed++; continue; }

      const config = dataSource.connection_config as Record<string, any>;
      const connectorType = obj.external_connections.connector_type;

      // Create import object record
      const { data: importObj } = await supabase
        .from("external_import_objects")
        .insert({
          import_run_id: importRunId,
          discovery_object_id: obj.id,
          project_id,
          object_name: obj.object_name,
          status: 'importing',
          started_at: new Date().toISOString()
        })
        .select().single();

      try {
        let fetchResult: { columns: string[]; csvBytes: Uint8Array; rowCount: number };

        switch (connectorType) {
          case 'postgresql':
            fetchResult = await fetchPostgreSQL(config, obj.object_schema || 'public', obj.object_name);
            break;
          case 'aws_rds':
          case 'aws_redshift':
            fetchResult = await fetchPostgreSQL({
              host: config.endpoint, port: config.port || 5432,
              database: config.database, username: config.username, password: config.password, ssl: true
            }, obj.object_schema || 'public', obj.object_name);
            break;
          case 'databricks':
            fetchResult = await fetchDatabricks(config, obj.object_schema || '', obj.object_name);
            break;
          case 'powerbi':
            fetchResult = await fetchPowerBI(config, obj.object_name);
            break;
          default:
            throw new Error(`Import not supported for: ${connectorType}`);
        }

        // Upload to staging in storage
        const timestamp = Date.now();
        const safeName = obj.object_name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 50);
        const storagePath = `${project_id}/staging_${safeName}_${timestamp}.csv`;

        const { error: uploadError } = await supabase.storage
          .from('datasets')
          .upload(storagePath, fetchResult.csvBytes, { contentType: 'text/csv', upsert: true });

        if (uploadError) throw uploadError;

        // Update import object as staged
        await supabase
          .from("external_import_objects")
          .update({
            status: 'staged',
            storage_path: storagePath,
            rows_imported: fetchResult.rowCount,
            columns_imported: fetchResult.columns.length,
            file_size_bytes: fetchResult.csvBytes.length,
            finished_at: new Date().toISOString()
          })
          .eq("id", importObj!.id);

        // If promote flag, create dataset immediately
        if (promote) {
          // Deactivate previous datasets
          await supabase.from('project_datasets').update({ is_active: false }).eq('project_id', project_id);

          const { data: dataset } = await supabase
            .from('project_datasets')
            .insert({
              project_id,
              user_id: projectData?.user_id,
              name: `${obj.object_name} (${connectorType})`,
              storage_path: storagePath,
              source_type: 'cloud',
              total_rows: fetchResult.rowCount,
              sample_rows: Math.min(fetchResult.rowCount, MAX_ROWS),
              columns_count: fetchResult.columns.length,
              file_size_bytes: fetchResult.csvBytes.length,
              is_active: true,
              source_metadata: {
                connector_type: connectorType,
                object_name: obj.object_name,
                object_schema: obj.object_schema,
                import_run_id: importRunId,
                delimiter: ';',
                encoding: 'UTF-8'
              }
            })
            .select().single();

          if (dataset) {
            await supabase.from("external_import_objects")
              .update({ status: 'promoted', dataset_id: dataset.id })
              .eq("id", importObj!.id);

            // Store columns
            await supabase.from('project_columns').delete().eq('project_id', project_id);
            const colsToInsert = fetchResult.columns.map((c, i) => ({
              project_id, column_name: c, column_index: i, inferred_type: 'texto'
            }));
            await supabase.from('project_columns').insert(colsToInsert);

            // Update project
            await supabase.from('projects').update({
              dataset_filename: `staging_${safeName}_${timestamp}.csv`,
              total_rows: fetchResult.rowCount,
              dataset_rows: Math.min(fetchResult.rowCount, MAX_ROWS),
              dataset_columns: fetchResult.columns.length,
              status: 'data_uploaded'
            }).eq('id', project_id);

            // SSOT: complete ingestion
            try {
              await supabase.rpc("rpc_complete_ingestion", {
                p_project_id: project_id,
                p_success: true,
                p_rows_detected: fetchResult.rowCount,
                p_cols_detected: fetchResult.columns.length,
                p_file_count: 1,
                p_total_bytes: fetchResult.csvBytes.length,
                p_dataset_id: dataset.id,
              });
            } catch { /* ignore */ }
          }
        }

        completed++;
        results.push({ object: obj.object_name, status: 'success', rows: fetchResult.rowCount, columns: fetchResult.columns.length });
      } catch (err) {
        failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[import] Failed for ${obj.object_name}:`, errMsg);

        await supabase
          .from("external_import_objects")
          .update({ status: 'failed', error_code: 'IMPORT_ERROR', error_message: errMsg, finished_at: new Date().toISOString() })
          .eq("id", importObj!.id);

        results.push({ object: obj.object_name, status: 'failed', error: errMsg });
      }
    }

    // Update import run
    await supabase
      .from("external_import_runs")
      .update({
        status: failed === objects.length ? 'failed' : 'done',
        objects_completed: completed,
        objects_failed: failed,
        finished_at: new Date().toISOString()
      })
      .eq("id", importRunId);

    // Mark selected objects
    await supabase.from("external_discovery_objects").update({ is_selected: true }).in("id", object_ids);

    // If all failed and we started ingestion, mark it failed
    if (failed === objects.length) {
      try {
        await supabase.rpc("rpc_complete_ingestion", {
          p_project_id: project_id, p_success: false,
          p_error_code: 'IMPORT_ALL_FAILED', p_error_message: 'All objects failed to import'
        });
      } catch { /* ignore */ }
    }

    return new Response(
      JSON.stringify({ success: true, import_run_id: importRunId, completed, failed, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    console.error("[import] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Import failed";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  }
});
