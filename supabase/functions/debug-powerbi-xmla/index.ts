import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface DiagnosticStep {
  step: string;
  label: string;
  status: 'ok' | 'fail' | 'skip';
  detail: string;
  data?: unknown;
  duration_ms?: number;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader || '' } },
    });

    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'auth_required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 });
    }

    const body = await req.json();
    const {
      project_id, connection_id, table_name,
      client_id: ciInput, client_secret: csInput, tenant_id: tiInput,
      workspace_id: wiInput, dataset_id: diInput,
      materialize = false,
    } = body;

    if (!project_id) {
      return new Response(JSON.stringify({ success: false, error: 'missing_project_id' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }

    // Resolve credentials from connection if not provided
    let client_id = ciInput, client_secret = csInput, tenant_id = tiInput;
    let workspace_id = wiInput, dataset_id = diInput;

    if (connection_id && (!client_id || !client_secret || !tenant_id || !workspace_id || !dataset_id)) {
      const { data: conn } = await supabaseAdmin
        .from('external_connections')
        .select('data_source_id, metadata, data_sources!external_connections_data_source_id_fkey(connection_config)')
        .eq('id', connection_id)
        .maybeSingle();

      if (conn) {
        const dsRel = (conn as any).data_sources;
        const cfg = (Array.isArray(dsRel) ? dsRel[0]?.connection_config : dsRel?.connection_config) || {};
        const meta = (conn.metadata as Record<string, any>) || {};
        client_id = client_id || cfg.client_id;
        client_secret = client_secret || cfg.client_secret;
        tenant_id = tenant_id || cfg.tenant_id;
        workspace_id = workspace_id || cfg.workspace_id || meta.workspace_id;
        dataset_id = dataset_id || cfg.dataset_id || meta.dataset_id;
      }
    }

    const steps: DiagnosticStep[] = [];
    let accessToken: string | null = null;

    // ═══════════════════════════════════════════
    // STEP A: Azure AD Authentication
    // ═══════════════════════════════════════════
    const stepA = Date.now();
    try {
      if (!client_id || !client_secret || !tenant_id) {
        steps.push({ step: 'A', label: 'Azure AD Auth', status: 'fail',
          detail: 'Credenciais ausentes: client_id, client_secret ou tenant_id não configurados.' });
      } else {
        const tokenUrl = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`;
        const params = new URLSearchParams({
          grant_type: 'client_credentials', client_id, client_secret,
          scope: 'https://analysis.windows.net/powerbi/api/.default',
        });
        const tokenResp = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        if (tokenResp.ok) {
          const tokenData = await tokenResp.json();
          accessToken = tokenData.access_token;
          steps.push({ step: 'A', label: 'Azure AD Auth', status: 'ok',
            detail: 'Token obtido com sucesso.', duration_ms: Date.now() - stepA });
        } else {
          const errText = await tokenResp.text();
          steps.push({ step: 'A', label: 'Azure AD Auth', status: 'fail',
            detail: `Falha na autenticação: HTTP ${tokenResp.status}`,
            data: { error: errText.substring(0, 500) }, duration_ms: Date.now() - stepA });
        }
      }
    } catch (err) {
      steps.push({ step: 'A', label: 'Azure AD Auth', status: 'fail',
        detail: `Exceção: ${(err as Error).message}`, duration_ms: Date.now() - stepA });
    }

    // Log auth event
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_xmla_auth', project_id, source: 'connector_powerbi',
        status: steps[0]?.status === 'ok' ? 'info' : 'error',
        metadata: { connection_id, workspace_id, dataset_id, step: 'A',
          result: steps[0]?.status, detail: steps[0]?.detail?.substring(0, 300) },
      });
    } catch { /* best-effort */ }

    if (!accessToken) {
      return new Response(JSON.stringify({ success: false, steps, error: 'auth_failed' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    // ═══════════════════════════════════════════
    // STEP B1: Workspace Check
    // ═══════════════════════════════════════════
    const stepB1 = Date.now();
    let workspaceValid = false;
    let workspaceName = '';
    try {
      if (!workspace_id) {
        steps.push({ step: 'B1', label: 'Workspace', status: 'fail',
          detail: 'workspace_id não informado.' });
      } else {
        const wsUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}`;
        const wsResp = await fetch(wsUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (wsResp.ok) {
          const wsData = await wsResp.json();
          workspaceName = wsData.name || workspace_id;
          const isOnDedicatedCapacity = wsData.isOnDedicatedCapacity === true;
          workspaceValid = true;
          steps.push({ step: 'B1', label: 'Workspace', status: 'ok',
            detail: `Workspace "${workspaceName}" acessível.${isOnDedicatedCapacity ? ' Capacidade dedicada: Sim (XMLA compatível).' : ' Sem capacidade dedicada (XMLA pode não estar disponível).'}`,
            data: { name: workspaceName, isOnDedicatedCapacity, capacityId: wsData.capacityId },
            duration_ms: Date.now() - stepB1 });
        } else {
          const errText = await wsResp.text();
          steps.push({ step: 'B1', label: 'Workspace', status: 'fail',
            detail: `Workspace não encontrado ou sem permissão: HTTP ${wsResp.status}`,
            data: { error: errText.substring(0, 300) }, duration_ms: Date.now() - stepB1 });
        }
      }
    } catch (err) {
      steps.push({ step: 'B1', label: 'Workspace', status: 'fail',
        detail: `Exceção: ${(err as Error).message}`, duration_ms: Date.now() - stepB1 });
    }

    // Log workspace check
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_xmla_workspace_check', project_id, source: 'connector_powerbi',
        status: workspaceValid ? 'info' : 'error',
        metadata: { connection_id, workspace_id, workspace_name: workspaceName,
          result: workspaceValid ? 'ok' : 'fail' },
      });
    } catch { /* best-effort */ }

    // ═══════════════════════════════════════════
    // STEP B2: Dataset / Semantic Model Check
    // ═══════════════════════════════════════════
    const stepB2 = Date.now();
    let datasetValid = false;
    let datasetInfo: Record<string, unknown> = {};
    try {
      if (!dataset_id) {
        steps.push({ step: 'B2', label: 'Dataset/Semantic Model', status: 'fail',
          detail: 'dataset_id não informado.' });
      } else if (!workspaceValid) {
        steps.push({ step: 'B2', label: 'Dataset/Semantic Model', status: 'skip',
          detail: 'Pulado — workspace inválido.' });
      } else {
        const dsUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}`;
        const dsResp = await fetch(dsUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (dsResp.ok) {
          const ds = await dsResp.json();
          datasetValid = true;
          datasetInfo = {
            name: ds.name, id: ds.id, configuredBy: ds.configuredBy,
            defaultMode: ds.defaultMode, isEffectiveIdentityRequired: ds.isEffectiveIdentityRequired,
            isOnPremGatewayRequired: ds.isOnPremGatewayRequired,
          };
          steps.push({ step: 'B2', label: 'Dataset/Semantic Model', status: 'ok',
            detail: `Dataset "${ds.name}" encontrado. Modo: ${ds.defaultMode || 'N/A'}.`,
            data: datasetInfo, duration_ms: Date.now() - stepB2 });
        } else {
          const errText = await dsResp.text();
          steps.push({ step: 'B2', label: 'Dataset/Semantic Model', status: 'fail',
            detail: `Dataset não encontrado: HTTP ${dsResp.status}`,
            data: { error: errText.substring(0, 300) }, duration_ms: Date.now() - stepB2 });
        }
      }
    } catch (err) {
      steps.push({ step: 'B2', label: 'Dataset/Semantic Model', status: 'fail',
        detail: `Exceção: ${(err as Error).message}`, duration_ms: Date.now() - stepB2 });
    }

    // Log dataset check
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_xmla_dataset_check', project_id, source: 'connector_powerbi',
        status: datasetValid ? 'info' : 'error',
        metadata: { connection_id, workspace_id, dataset_id, ...datasetInfo,
          result: datasetValid ? 'ok' : 'fail' },
      });
    } catch { /* best-effort */ }

    if (!datasetValid) {
      return new Response(JSON.stringify({ success: false, steps, error: 'dataset_not_found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const executeUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;

    // Helper to execute DAX and return rows
    async function executeDax(query: string): Promise<{ ok: boolean; rows: any[]; error?: string; http_status?: number }> {
      try {
        const resp = await fetch(executeUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true } }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return { ok: false, rows: [], error: errText.substring(0, 500), http_status: resp.status };
        }
        const result = await resp.json();
        const error = result.results?.[0]?.error;
        if (error) {
          return { ok: false, rows: [], error: JSON.stringify(error).substring(0, 500) };
        }
        const rows = result.results?.[0]?.tables?.[0]?.rows || [];
        return { ok: true, rows };
      } catch (err) {
        return { ok: false, rows: [], error: (err as Error).message };
      }
    }

    // Helper: escape table name for DAX (handles spaces, special chars)
    function daxTable(name: string): string {
      // If name contains spaces or special chars, wrap in single quotes
      if (/[^a-zA-Z0-9_]/.test(name)) return `'${name}'`;
      return `'${name}'`;
    }

    // ═══════════════════════════════════════════
    // STEP C1: Tables Discovery (DAX-native first, DMV fallback)
    // ═══════════════════════════════════════════
    const stepC1 = Date.now();
    let tables: Array<{ name: string; id?: number; tableType?: string }> = [];

    // Priority order: DAX-native functions first (work via executeQueries), DMV last
    const tableQueries = [
      { q: `EVALUATE FILTER(INFO.TABLES(), [IsHidden] = FALSE())`, method: 'INFO.TABLES' },
      { q: `SELECT [TABLE_NAME] FROM $SYSTEM.DBSCHEMA_TABLES WHERE [TABLE_TYPE] = 'TABLE'`, method: 'DBSCHEMA_TABLES' },
      { q: `SELECT [ID], [Name], [SystemFlags] FROM $SYSTEM.TMSCHEMA_TABLES WHERE NOT [IsHidden]`, method: 'TMSCHEMA_TABLES' },
    ];

    let tablesMethod = 'none';
    let tableErrors: string[] = [];
    for (const { q, method } of tableQueries) {
      const result = await executeDax(q);
      if (result.ok && result.rows.length > 0) {
        tables = result.rows.map((r: any) => {
          // INFO.TABLES returns [Name], [ID], etc. — keys may have brackets
          const name = r['[Name]'] || r['Name'] || r['[TABLE_NAME]'] || r['TABLE_NAME'] || Object.values(r)[0] as string;
          const id = r['[ID]'] || r['ID'];
          return { name: String(name), id: typeof id === 'number' ? id : undefined, tableType: r['[SystemFlags]'] || r['SystemFlags'] };
        }).filter(t => t.name && !t.name.startsWith('DateTable') && !t.name.startsWith('LocalDateTable'));
        tablesMethod = method;
        break;
      } else {
        tableErrors.push(`${method}: ${result.error?.substring(0, 120) || 'empty'}`);
      }
    }

    if (tables.length > 0) {
      steps.push({ step: 'C1', label: 'Tabelas (DMV)', status: 'ok',
        detail: `${tables.length} tabela(s) encontrada(s) via ${tablesMethod}.`,
        data: { tables: tables.map(t => t.name), method: tablesMethod, ids: tables.map(t => ({ name: t.name, id: t.id })) },
        duration_ms: Date.now() - stepC1 });
    } else {
      steps.push({ step: 'C1', label: 'Tabelas (DMV)', status: 'fail',
        detail: 'Nenhuma tabela retornada. Métodos tentados: ' + tableErrors.join(' | '),
        data: { errors: tableErrors },
        duration_ms: Date.now() - stepC1 });
    }

    // Log tables event
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_xmla_tables', project_id, source: 'connector_powerbi',
        status: tables.length > 0 ? 'info' : 'error',
        metadata: { connection_id, workspace_id, dataset_id, method: tablesMethod,
          tables_found: tables.length, table_names: tables.map(t => t.name).slice(0, 50),
          table_ids: tables.slice(0, 50).map(t => ({ name: t.name, id: t.id })) },
      });
    } catch { /* best-effort */ }

    // ═══════════════════════════════════════════
    // STEP C2: Columns Discovery (multi-method cascade)
    // ═══════════════════════════════════════════
    const stepC2 = Date.now();
    interface ColumnInfo { table_name: string; column_name: string; data_type: string; table_id?: number; }
    let allColumns: ColumnInfo[] = [];

    const targetTableName = table_name?.trim();
    const tablesToInspect = targetTableName
      ? tables.filter(t => t.name.toLowerCase() === targetTableName.toLowerCase()).length > 0
        ? [targetTableName]
        : [targetTableName, ...tables.slice(0, 3).map(t => t.name)]
      : tables.slice(0, 10).map(t => t.name);

    let columnsMethod = 'none';
    let columnErrors: string[] = [];

    // ── Method 1: INFO.COLUMNS() (DAX-native, most reliable via REST)
    {
      const result = await executeDax(`EVALUATE INFO.COLUMNS()`);
      if (result.ok && result.rows.length > 0) {
        // INFO.COLUMNS() returns [TableID], [Name], [DataType], [IsHidden], etc.
        const tableIdMap = new Map(tables.map(t => [t.id, t.name]));
        // Also build name-based lookup from INFO.TABLES if IDs don't match
        const tableNameSet = new Set(tables.map(t => t.name.toLowerCase()));

        for (const r of result.rows) {
          const isHidden = r['[IsHidden]'] ?? r['IsHidden'] ?? false;
          if (isHidden === true || isHidden === 'TRUE') continue;

          const tableId = r['[TableID]'] ?? r['TableID'];
          const tableName = tableIdMap.get(tableId);
          if (!tableName) continue;

          const colName = r['[Name]'] || r['Name'] || r['[ExplicitName]'] || r['ExplicitName'] || '';
          if (!colName) continue;

          const dataType = String(r['[DataType]'] ?? r['DataType'] ?? r['[ExplicitDataType]'] ?? r['ExplicitDataType'] ?? 'unknown');
          allColumns.push({ table_name: tableName, column_name: String(colName), data_type: dataType, table_id: tableId });
        }

        if (allColumns.length > 0) columnsMethod = 'INFO.COLUMNS';
      } else {
        columnErrors.push(`INFO.COLUMNS: ${result.error?.substring(0, 120) || 'empty'}`);
      }
    }

    // ── Method 2: TMSCHEMA_COLUMNS filtered by TableID (DMV, may work on some endpoints)
    if (allColumns.length === 0 && tables.length > 0) {
      // Try global query first
      const result = await executeDax(
        `SELECT [TableID], [ExplicitName], [InferredName], [ExplicitDataType], [DataType], [IsHidden] FROM $SYSTEM.TMSCHEMA_COLUMNS WHERE NOT [IsHidden]`
      );
      if (result.ok && result.rows.length > 0) {
        const tableIdMap = new Map(tables.map(t => [t.id, t.name]));
        allColumns = result.rows
          .map((r: any) => {
            const tableId = r['[TableID]'] || r['TableID'];
            return {
              table_name: tableIdMap.get(tableId) || '',
              column_name: r['[ExplicitName]'] || r['ExplicitName'] || r['[InferredName]'] || r['InferredName'] || '',
              data_type: String(r['[ExplicitDataType]'] || r['ExplicitDataType'] || r['[DataType]'] || r['DataType'] || 'unknown'),
              table_id: tableId,
            };
          })
          .filter(c => c.column_name && c.table_name);
        if (allColumns.length > 0) columnsMethod = 'TMSCHEMA_COLUMNS';
      } else {
        columnErrors.push(`TMSCHEMA_COLUMNS: ${result.error?.substring(0, 120) || 'empty'}`);
      }
    }

    // ── Method 3: DISCOVER_CSDL_METADATA via DBSCHEMA_COLUMNS (DMV fallback)
    if (allColumns.length === 0) {
      const result = await executeDax(
        `SELECT [TABLE_NAME], [COLUMN_NAME], [DATA_TYPE] FROM $SYSTEM.DBSCHEMA_COLUMNS`
      );
      if (result.ok && result.rows.length > 0) {
        const tableNameSet = new Set(tables.map(t => t.name.toLowerCase()));
        allColumns = result.rows
          .map((r: any) => ({
            table_name: r['[TABLE_NAME]'] || r['TABLE_NAME'] || '',
            column_name: r['[COLUMN_NAME]'] || r['COLUMN_NAME'] || '',
            data_type: String(r['[DATA_TYPE]'] || r['DATA_TYPE'] || 'unknown'),
          }))
          .filter(c => c.column_name && c.table_name && tableNameSet.has(c.table_name.toLowerCase()));
        if (allColumns.length > 0) columnsMethod = 'DBSCHEMA_COLUMNS';
      } else {
        columnErrors.push(`DBSCHEMA_COLUMNS: ${result.error?.substring(0, 120) || 'empty'}`);
      }
    }

    // ── Method 4: Per-table DAX TOPN(1) to extract column names from actual data
    if (allColumns.length === 0 && tablesToInspect.length > 0) {
      for (const tbl of tablesToInspect) {
        const escaped = daxTable(tbl);
        // Try SELECTCOLUMNS approach first (extracts column names even with complex models)
        const scResult = await executeDax(`EVALUATE TOPN(1, ${escaped})`);
        if (scResult.ok && scResult.rows.length > 0) {
          const keys = Object.keys(scResult.rows[0]);
          for (const k of keys) {
            // Keys come as "[TableName][ColumnName]" — extract column name
            const match = k.match(/\[([^\]]+)\]$/);
            const cleanName = match ? match[1] : k.replace(/^\[/, '').replace(/\]$/, '');
            allColumns.push({ table_name: tbl, column_name: cleanName, data_type: 'unknown' });
          }
        } else {
          columnErrors.push(`TOPN(1,${tbl}): ${scResult.error?.substring(0, 80) || 'empty'}`);
          // Last resort: SELECTCOLUMNS with dummy column to enumerate
          const altResult = await executeDax(
            `EVALUATE SAMPLE(1, SELECTCOLUMNS(${escaped}, "___probe", 1), [___probe])`
          );
          // This won't give us column names but confirms table access
          if (altResult.ok) {
            columnErrors.push(`SAMPLE(1,${tbl}): accessible but columns not extractable`);
          }
        }
      }
      if (allColumns.length > 0) columnsMethod = 'DAX_TOPN_FALLBACK';
    }

    if (allColumns.length > 0) {
      const uniqueTables = new Set(allColumns.map(c => c.table_name));
      steps.push({ step: 'C2', label: 'Colunas (DMV)', status: 'ok',
        detail: `${allColumns.length} coluna(s) em ${uniqueTables.size} tabela(s) via ${columnsMethod}.`,
        data: { method: columnsMethod, total_columns: allColumns.length,
          by_table: Object.fromEntries([...uniqueTables].map(t =>
            [t, allColumns.filter(c => c.table_name === t).map(c => ({ name: c.column_name, type: c.data_type }))]
          )),
          errors_from_previous_methods: columnErrors.length > 0 ? columnErrors : undefined },
        duration_ms: Date.now() - stepC2 });
    } else {
      steps.push({ step: 'C2', label: 'Colunas (DMV)', status: 'fail',
        detail: 'Nenhuma coluna extraída. Métodos tentados: ' + columnErrors.join(' | '),
        data: { errors: columnErrors },
        duration_ms: Date.now() - stepC2 });
    }

    // Log columns event
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_xmla_columns', project_id, source: 'connector_powerbi',
        status: allColumns.length > 0 ? 'info' : 'error',
        metadata: { connection_id, workspace_id, dataset_id, method: columnsMethod,
          columns_found: allColumns.length, tables_with_columns: [...new Set(allColumns.map(c => c.table_name))].length,
          errors: columnErrors.slice(0, 5) },
      });
    } catch { /* best-effort */ }

    // ═══════════════════════════════════════════
    // STEP D: Sample data via DAX TOPN
    // ═══════════════════════════════════════════
    const stepD = Date.now();
    const sampleTable = targetTableName || tables[0]?.name;
    let sampleRows: any[] = [];
    let sampleColumns: string[] = [];

    if (sampleTable) {
      const escaped = daxTable(sampleTable);
      const result = await executeDax(`EVALUATE TOPN(10, ${escaped})`);
      if (result.ok && result.rows.length > 0) {
        sampleRows = result.rows;
        sampleColumns = Object.keys(result.rows[0]).map(k => {
          const match = k.match(/\[([^\]]+)\]$/);
          return match ? match[1] : k.replace(/^\[/, '').replace(/\]$/, '');
        });
        steps.push({ step: 'D', label: 'Amostra de dados', status: 'ok',
          detail: `${result.rows.length} linha(s) retornada(s) de "${sampleTable}" com ${sampleColumns.length} colunas.`,
          data: { table: sampleTable, row_count: result.rows.length, columns: sampleColumns,
            sample_preview: result.rows.slice(0, 3) },
          duration_ms: Date.now() - stepD });

        // If columns weren't extracted earlier, populate from sample
        if (allColumns.filter(c => c.table_name.toLowerCase() === sampleTable.toLowerCase()).length === 0) {
          for (const col of sampleColumns) {
            allColumns.push({ table_name: sampleTable, column_name: col, data_type: 'unknown' });
          }
          if (columnsMethod === 'none') columnsMethod = 'DAX_SAMPLE_EXTRACT';
          // Update C2 step if it was a fail
          const c2Step = steps.find(s => s.step === 'C2');
          if (c2Step && c2Step.status === 'fail') {
            c2Step.status = 'ok';
            c2Step.detail = `${sampleColumns.length} coluna(s) extraídas da amostra de "${sampleTable}" via DAX_SAMPLE_EXTRACT.`;
            c2Step.data = { method: 'DAX_SAMPLE_EXTRACT', total_columns: sampleColumns.length,
              by_table: { [sampleTable]: sampleColumns.map(c => ({ name: c, type: 'unknown' })) } };
          }
        }
      } else {
        steps.push({ step: 'D', label: 'Amostra de dados', status: 'fail',
          detail: `DAX TOPN falhou para "${sampleTable}": ${result.error || 'sem dados'}`,
          data: { table: sampleTable, error: result.error, dax_query: `EVALUATE TOPN(10, ${escaped})` },
          duration_ms: Date.now() - stepD });
      }
    } else {
      steps.push({ step: 'D', label: 'Amostra de dados', status: 'skip',
        detail: 'Nenhuma tabela disponível para amostragem.' });
    }

    // Log sample event
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_xmla_sample_query', project_id, source: 'connector_powerbi',
        status: sampleRows.length > 0 ? 'info' : 'error',
        metadata: { connection_id, workspace_id, dataset_id, table: sampleTable,
          rows_returned: sampleRows.length, columns_count: sampleColumns.length },
      });
    } catch { /* best-effort */ }

    // ═══════════════════════════════════════════
    // STEP E: Row count via COUNTROWS
    // ═══════════════════════════════════════════
    const stepE = Date.now();
    let rowCount = 0;

    if (sampleTable) {
      const result = await executeDax(`EVALUATE ROW("count", COUNTROWS('${sampleTable}'))`);
      if (result.ok && result.rows.length > 0) {
        const val = result.rows[0]?.['[count]'] ?? result.rows[0]?.count;
        rowCount = typeof val === 'number' ? val : parseInt(String(val), 10) || 0;
        steps.push({ step: 'E', label: 'Contagem de linhas', status: 'ok',
          detail: `"${sampleTable}" contém ${rowCount.toLocaleString()} linhas.`,
          data: { table: sampleTable, row_count: rowCount },
          duration_ms: Date.now() - stepE });
      } else {
        steps.push({ step: 'E', label: 'Contagem de linhas', status: 'fail',
          detail: `COUNTROWS falhou para "${sampleTable}": ${result.error || 'sem resultado'}`,
          duration_ms: Date.now() - stepE });
      }
    } else {
      steps.push({ step: 'E', label: 'Contagem de linhas', status: 'skip',
        detail: 'Nenhuma tabela para contar.' });
    }

    // ═══════════════════════════════════════════
    // MATERIALIZATION (if requested and successful)
    // ═══════════════════════════════════════════
    const targetColumns = targetTableName
      ? allColumns.filter(c => c.table_name.toLowerCase() === targetTableName.toLowerCase())
      : sampleColumns.length > 0
        ? sampleColumns.map(c => ({ table_name: sampleTable, column_name: c, data_type: 'unknown' }))
        : [];

    const canMaterialize = (targetColumns.length > 0 || sampleColumns.length > 0) && (rowCount > 0 || sampleRows.length > 0);
    let materialized = false;

    if (materialize && canMaterialize && sampleTable) {
      const finalColumns = targetColumns.length > 0
        ? targetColumns.map(c => c.column_name)
        : sampleColumns;
      const finalRowCount = rowCount > 0 ? rowCount : sampleRows.length;
      const finalColCount = finalColumns.length;

      try {
        // Build schema JSON
        const schemaJson = finalColumns.map((col, i) => {
          const colInfo = allColumns.find(c => c.column_name === col);
          return { name: col, type: colInfo?.data_type || 'text', index: i, source: 'powerbi_dmv' };
        });

        // Call rpc_finalize_ingestion
        const { data: finResult, error: finError } = await supabaseAdmin.rpc('rpc_finalize_ingestion', {
          p_project_id: project_id,
          p_source_type: 'powerbi_xmla',
          p_config_hash: `pbi_xmla_${project_id}_${sampleTable}`,
          p_dataset_id: null,
          p_source_pointer: {
            connector_type: 'powerbi_xmla',
            connection_mode: 'xmla_materialized',
            workspace_id, dataset_id,
            table_name: sampleTable,
            connection_id: connection_id || null,
            discovery_method: tablesMethod,
            columns_method: columnsMethod,
            columns_extracted: finalColCount,
          },
          p_schema_json: schemaJson,
          p_row_count: finalRowCount,
          p_col_count: finalColCount,
          p_total_bytes: 0,
          p_sample_strategy: { method: 'dmv_extraction', source: 'powerbi_xmla' },
          p_file_count: 0,
        });

        if (finError) {
          console.error('[debug-pbi-xmla] rpc_finalize_ingestion error:', JSON.stringify(finError));
          steps.push({ step: 'F', label: 'Materialização', status: 'fail',
            detail: `Erro ao finalizar ingestão: ${finError.message}` });
        } else {
          const result = finResult as Record<string, any>;

          // Deactivate old datasets, create new one
          await supabaseAdmin
            .from('project_datasets')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('project_id', project_id)
            .eq('is_active', true);

          const { data: pdData } = await supabaseAdmin
            .from('project_datasets')
            .insert({
              project_id,
              user_id: user.id,
              name: `Power BI XMLA: ${sampleTable}`,
              storage_path: `powerbi_xmla/${project_id}/${sampleTable}`,
              file_size_bytes: 0,
              total_rows: finalRowCount,
              sample_rows: sampleRows.length,
              columns_count: finalColCount,
              is_active: true,
              source_type: 'powerbi_xmla',
              source_metadata: {
                connector_type: 'powerbi_xmla',
                connection_mode: 'xmla_materialized',
                table_name: sampleTable,
                connection_id, workspace_id, dataset_id,
                manifest_id: result?.manifest_id,
                columns_extracted: finalColCount,
                discovery_method: tablesMethod,
                columns_method: columnsMethod,
              },
            })
            .select('id')
            .single();

          // Persist columns to project_columns
          await supabaseAdmin.from('project_columns').delete().eq('project_id', project_id);

          const dmvTypeMap: Record<string, string> = {
            '2': 'texto', '6': 'inteiro', '8': 'decimal', '9': 'data',
            '10': 'decimal', '11': 'booleano', '17': 'binario',
            'string': 'texto', 'int64': 'inteiro', 'double': 'decimal',
            'datetime': 'data', 'boolean': 'booleano', 'decimal': 'decimal',
          };

          const colsToInsert = finalColumns.map((col, i) => {
            const colInfo = allColumns.find(c => c.column_name === col);
            const rawType = (colInfo?.data_type || 'unknown').toLowerCase();
            return {
              project_id,
              column_name: col,
              column_index: i,
              inferred_type: dmvTypeMap[rawType] || 'texto',
            };
          });

          const { error: colErr } = await supabaseAdmin.from('project_columns').insert(colsToInsert);
          if (colErr) console.warn('[debug-pbi-xmla] project_columns insert warning:', JSON.stringify(colErr));

          // Update project_dataset_state with real schema
          await supabaseAdmin
            .from('project_dataset_state')
            .update({
              col_count: finalColCount,
              row_count: finalRowCount,
              active_schema_json: schemaJson,
              source_type: 'powerbi_xmla',
              updated_at: new Date().toISOString(),
            })
            .eq('project_id', project_id);

          // Update connection status
          if (connection_id) {
            try {
              const { data: connData } = await supabaseAdmin
                .from('external_connections')
                .select('metadata')
                .eq('id', connection_id)
                .single();
              const existingMeta = (connData?.metadata as Record<string, any>) || {};
              await supabaseAdmin
                .from('external_connections')
                .update({
                  connection_status: 'connected_full_discovery',
                  validation_message: `XMLA materializado: ${sampleTable} (${finalColCount} cols, ${finalRowCount} rows)`,
                  last_validated_at: new Date().toISOString(),
                  metadata: {
                    ...existingMeta,
                    connection_mode: 'xmla_materialized',
                    xmla_table_name: sampleTable,
                    source_mode: 'powerbi_xmla',
                  },
                })
                .eq('id', connection_id);
            } catch { /* best-effort */ }
          }

          materialized = true;
          steps.push({ step: 'F', label: 'Materialização', status: 'ok',
            detail: `Dataset "${sampleTable}" materializado: ${finalColCount} colunas, ${finalRowCount} linhas.`,
            data: { manifest_id: result?.manifest_id, dataset_id: pdData?.id,
              columns: finalColCount, rows: finalRowCount } });

          // Log materialization success
          try {
            await supabaseAdmin.from('platform_events').insert({
              event_type: 'powerbi_xmla_materialization_success', project_id, source: 'connector_powerbi',
              status: 'info',
              metadata: { connection_id, workspace_id, dataset_id: dataset_id,
                table_name: sampleTable, columns: finalColCount, rows: finalRowCount,
                manifest_id: result?.manifest_id, project_dataset_id: pdData?.id },
            });
          } catch { /* best-effort */ }
        }
      } catch (matErr) {
        const msg = (matErr as Error).message;
        steps.push({ step: 'F', label: 'Materialização', status: 'fail',
          detail: `Erro inesperado: ${msg}` });
        try {
          await supabaseAdmin.from('platform_events').insert({
            event_type: 'powerbi_xmla_materialization_failed', project_id, source: 'connector_powerbi',
            status: 'error',
            metadata: { connection_id, workspace_id, dataset_id, table_name: sampleTable, error: msg },
          });
        } catch { /* best-effort */ }
      }
    } else if (materialize && !canMaterialize) {
      steps.push({ step: 'F', label: 'Materialização', status: 'fail',
        detail: 'Não é possível materializar: schema ou dados não extraídos.' });

      try {
        await supabaseAdmin.from('platform_events').insert({
          event_type: 'powerbi_xmla_materialization_failed', project_id, source: 'connector_powerbi',
          status: 'error',
          metadata: { connection_id, workspace_id, dataset_id,
            error_code: 'SCHEMA_NOT_MATERIALIZED_XMLA',
            columns_found: targetColumns.length, sample_rows: sampleRows.length, row_count: rowCount },
        });
      } catch { /* best-effort */ }
    }

    // Build summary
    const allOk = steps.every(s => s.status === 'ok' || s.status === 'skip');
    const xmlaEndpointUrl = workspaceName
      ? `powerbi://api.powerbi.com/v1.0/myorg/${encodeURIComponent(workspaceName)}`
      : workspace_id ? `powerbi://api.powerbi.com/v1.0/myorg/${workspace_id}` : null;

    console.log(`[debug-pbi-xmla] Diagnostic complete: ${steps.filter(s => s.status === 'ok').length}/${steps.length} OK, materialized=${materialized}`);

    return new Response(JSON.stringify({
      success: true,
      diagnostic: {
        xmla_endpoint: xmlaEndpointUrl,
        steps,
        summary: {
          auth_ok: steps.find(s => s.step === 'A')?.status === 'ok',
          workspace_ok: workspaceValid,
          dataset_ok: datasetValid,
          tables_found: tables.length,
          columns_found: allColumns.length,
          sample_ok: sampleRows.length > 0,
          row_count: rowCount,
          all_ok: allOk,
        },
        tables: tables.map(t => t.name),
        columns_by_table: Object.fromEntries(
          [...new Set(allColumns.map(c => c.table_name))].map(t =>
            [t, allColumns.filter(c => c.table_name === t).map(c => ({ name: c.column_name, type: c.data_type }))]
          )
        ),
      },
      materialized,
      can_materialize: canMaterialize,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });

  } catch (error: unknown) {
    console.error('[debug-pbi-xmla] Error:', error);
    const msg = error instanceof Error ? error.message : 'Erro desconhecido';
    return new Response(JSON.stringify({ success: false, error: msg }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
