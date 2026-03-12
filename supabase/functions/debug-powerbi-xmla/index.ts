import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type StepStatus = "ok" | "fail" | "skip";

interface DiagnosticStep {
  step: string;
  label: string;
  status: StepStatus;
  detail: string;
  data?: unknown;
  duration_ms?: number;
}

interface ExecuteDaxResult {
  ok: boolean;
  rows: Record<string, unknown>[];
  error?: string;
  http_status?: number;
  xmla_status?: string;
  raw_response?: string;
  query: string;
}

interface DiscoveredTable {
  discovered_name: string;
  effective_name: string;
  source_method: string;
  table_id?: number;
  is_hidden?: boolean;
}

interface IgnoredTable {
  name: string;
  reason: string;
  source_method: string;
}

interface ColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
}

const truncate = (value: unknown, max = 1800): string | undefined => {
  if (value == null) return undefined;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > max ? `${str.slice(0, max)}...` : str;
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const stripLeadingDollar = (name: string): string => name.replace(/^\$+/, "");

const uniqueBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item).toLowerCase();
    if (!map.has(k)) map.set(k, item);
  }
  return [...map.values()];
};

const parseBool = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    return v === "true" || v === "1";
  }
  if (typeof value === "number") return value === 1;
  return false;
};

const escapeDaxTable = (name: string): string => `'${name.replace(/'/g, "''")}'`;
const escapeDaxString = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const cleanupColumnKey = (key: string): string => {
  const noBrackets = key.replace(/^\[/, "").replace(/\]$/, "");
  const parts = noBrackets.split("][");
  return parts[parts.length - 1] || noBrackets;
};

const typeToInferred = (rawType: string): string => {
  const t = rawType.toLowerCase();
  if (["int", "int64", "whole", "whole number", "integer", "6", "7"].some((x) => t.includes(x))) return "inteiro";
  if (["decimal", "double", "currency", "8", "10"].some((x) => t.includes(x))) return "decimal";
  if (["date", "datetime", "time", "9"].some((x) => t.includes(x))) return "data";
  if (["bool", "boolean", "11"].some((x) => t.includes(x))) return "booleano";
  return "texto";
};

const ignoredReasonForTable = (name: string, isHidden?: boolean): string | null => {
  if (isHidden) return "hidden";
  if (name.startsWith("$")) return "technical_prefix_$";
  if (/localdatatable|datetabletemplate/i.test(name)) return "auto_date_table";
  if (/^_?(medidas?|measures?)$/i.test(name) || /(^|[_\s])(medidas?|measures?)$/i.test(name)) return "measures_table";
  return null;
};

/** Score a table name for business relevance (higher = more likely business table). */
const tableBusinessScore = (name: string): number => {
  const lower = name.toLowerCase();
  // Strong negative signals — calendar / date / dimension-date / measures
  if (/^d?_?calend[aá]rio$|^d?_?calendar$|^dim_?date$|^dim_?calendar/i.test(lower)) return -10;
  if (/calend[aá]rio|calendar|localdate|datetable/i.test(lower)) return -5;
  if (/^_?(medidas?|measures?)$/i.test(lower)) return -8;
  // Positive signals — fact / transactional tables
  if (/^fat[oa]?_|^fato_|^fact_|^f_/i.test(lower)) return 20;
  if (/vendas|sales|orders|pedidos|transac|receita|revenue|faturamento/i.test(lower)) return 15;
  if (/clientes?|customers?|leads?|contacts?|accounts?/i.test(lower)) return 10;
  if (/^dim_/i.test(lower)) return 2; // dimensions are ok but lower priority than facts
  // Neutral
  return 5;
};

/** Canonical source_type for Power BI (matches project_dataset_state check constraint). */
const PBI_SOURCE_TYPE = "powerbi";

const pickRowValue = (row: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    const withBrackets = `[${key}]`;
    if (Object.prototype.hasOwnProperty.call(row, withBrackets)) return row[withBrackets];
  }
  return undefined;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, serviceKey);
    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader || "" } },
    });

    const {
      data: { user },
    } = await supabaseUser.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ success: false, error: "auth_required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    const body = await req.json();
    const project_id = normalizeString(body?.project_id);
    const connection_id = normalizeString(body?.connection_id);
    const requested_table_name = normalizeString(body?.table_name);
    const materialize = Boolean(body?.materialize);

    if (!project_id) {
      return new Response(JSON.stringify({ success: false, error: "missing_project_id" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    let client_id = normalizeString(body?.client_id);
    let client_secret = normalizeString(body?.client_secret);
    let tenant_id = normalizeString(body?.tenant_id);
    let workspace_id = normalizeString(body?.workspace_id);
    let dataset_id = normalizeString(body?.dataset_id);

    if (connection_id && (!client_id || !client_secret || !tenant_id || !workspace_id || !dataset_id)) {
      const { data: conn } = await supabaseAdmin
        .from("external_connections")
        .select("metadata, data_sources!external_connections_data_source_id_fkey(connection_config)")
        .eq("id", connection_id)
        .maybeSingle();

      if (conn) {
        const dsRel = (conn as { data_sources?: Array<{ connection_config?: Record<string, unknown> }> | { connection_config?: Record<string, unknown> } }).data_sources;
        const cfg = Array.isArray(dsRel) ? dsRel[0]?.connection_config || {} : dsRel?.connection_config || {};
        const meta = (conn.metadata as Record<string, unknown> | null) || {};

        client_id = client_id ?? normalizeString(cfg.client_id);
        client_secret = client_secret ?? normalizeString(cfg.client_secret);
        tenant_id = tenant_id ?? normalizeString(cfg.tenant_id);
        workspace_id = workspace_id ?? normalizeString(cfg.workspace_id) ?? normalizeString(meta.workspace_id);
        dataset_id = dataset_id ?? normalizeString(cfg.dataset_id) ?? normalizeString(meta.dataset_id);
      }
    }

    const steps: DiagnosticStep[] = [];

    const insertEvent = async (event_type: string, status: "info" | "error", metadata: Record<string, unknown>) => {
      try {
        await supabaseAdmin.from("platform_events").insert({
          event_type,
          project_id,
          source: "connector_powerbi",
          status,
          metadata,
        });
      } catch {
        // no-op (best effort)
      }
    };

    let accessToken: string | null = null;

    // STEP A - AUTH
    {
      const started = Date.now();
      if (!client_id || !client_secret || !tenant_id) {
        steps.push({
          step: "A",
          label: "Auth",
          status: "fail",
          detail: "Credenciais ausentes (client_id, client_secret ou tenant_id).",
          duration_ms: Date.now() - started,
        });
      } else {
        const tokenUrl = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`;
        const params = new URLSearchParams({
          grant_type: "client_credentials",
          client_id,
          client_secret,
          scope: "https://analysis.windows.net/powerbi/api/.default",
        });

        try {
          const tokenResp = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          });

          const raw = await tokenResp.text();
          if (tokenResp.ok) {
            const parsed = JSON.parse(raw);
            accessToken = parsed.access_token || null;
          }

          steps.push({
            step: "A",
            label: "Auth",
            status: accessToken ? "ok" : "fail",
            detail: accessToken ? "Token obtido com sucesso." : `Falha de autenticação HTTP ${tokenResp.status}.`,
            data: accessToken ? undefined : { error: truncate(raw) },
            duration_ms: Date.now() - started,
          });

          await insertEvent("powerbi_xmla_auth", accessToken ? "info" : "error", {
            workspace_id,
            dataset_id,
            connection_id,
            request: { has_client_id: !!client_id, has_tenant_id: !!tenant_id },
            response_summary: { ok: tokenResp.ok },
            http_status: tokenResp.status,
            error_message: accessToken ? null : truncate(raw),
          });
        } catch (error) {
          steps.push({
            step: "A",
            label: "Auth",
            status: "fail",
            detail: `Exceção de autenticação: ${(error as Error).message}`,
            duration_ms: Date.now() - started,
          });

          await insertEvent("powerbi_xmla_auth", "error", {
            workspace_id,
            dataset_id,
            connection_id,
            request: { has_client_id: !!client_id, has_tenant_id: !!tenant_id },
            error_message: (error as Error).message,
          });
        }
      }
    }

    if (!accessToken) {
      return new Response(JSON.stringify({ success: false, error: "auth_failed", steps }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // STEP B1 - WORKSPACE
    let workspaceName: string | null = null;
    let workspaceOk = false;
    {
      const started = Date.now();
      if (!workspace_id) {
        steps.push({ step: "B1", label: "Workspace", status: "fail", detail: "workspace_id ausente.", duration_ms: Date.now() - started });
      } else {
        const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const raw = await resp.text();
        if (resp.ok) {
          const json = JSON.parse(raw);
          workspaceOk = true;
          workspaceName = json.name || workspace_id;
          steps.push({
            step: "B1",
            label: "Workspace",
            status: "ok",
            detail: `Workspace \"${workspaceName}\" acessível.`,
            data: {
              name: workspaceName,
              isOnDedicatedCapacity: json.isOnDedicatedCapacity === true,
              capacityId: json.capacityId || null,
            },
            duration_ms: Date.now() - started,
          });
        } else {
          steps.push({
            step: "B1",
            label: "Workspace",
            status: "fail",
            detail: `Falha ao validar workspace (HTTP ${resp.status}).`,
            data: { error: truncate(raw) },
            duration_ms: Date.now() - started,
          });
        }

        await insertEvent("powerbi_xmla_workspace_check", workspaceOk ? "info" : "error", {
          workspace_id,
          dataset_id,
          project_id,
          connection_id,
          request: { workspace_id },
          response_summary: { workspace_name: workspaceName },
          http_status: resp.status,
          error_message: workspaceOk ? null : truncate(raw),
        });
      }
    }

    // STEP B2 - DATASET
    let datasetOk = false;
    let datasetInfo: Record<string, unknown> = {};
    {
      const started = Date.now();
      if (!dataset_id) {
        steps.push({ step: "B2", label: "Dataset", status: "fail", detail: "dataset_id ausente.", duration_ms: Date.now() - started });
      } else if (!workspaceOk) {
        steps.push({ step: "B2", label: "Dataset", status: "skip", detail: "Workspace inválido; etapa pulada.", duration_ms: Date.now() - started });
      } else {
        const url = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const raw = await resp.text();

        if (resp.ok) {
          const json = JSON.parse(raw);
          datasetOk = true;
          datasetInfo = {
            id: json.id,
            name: json.name,
            configuredBy: json.configuredBy,
            defaultMode: json.defaultMode,
            isEffectiveIdentityRequired: json.isEffectiveIdentityRequired,
            isOnPremGatewayRequired: json.isOnPremGatewayRequired,
          };
          steps.push({
            step: "B2",
            label: "Dataset",
            status: "ok",
            detail: `Dataset \"${json.name}\" acessível.`,
            data: datasetInfo,
            duration_ms: Date.now() - started,
          });
        } else {
          steps.push({
            step: "B2",
            label: "Dataset",
            status: "fail",
            detail: `Falha ao validar dataset (HTTP ${resp.status}).`,
            data: { error: truncate(raw) },
            duration_ms: Date.now() - started,
          });
        }

        await insertEvent("powerbi_xmla_dataset_check", datasetOk ? "info" : "error", {
          workspace_id,
          dataset_id,
          project_id,
          connection_id,
          request: { dataset_id },
          response_summary: datasetInfo,
          http_status: resp.status,
          error_message: datasetOk ? null : truncate(raw),
        });
      }
    }

    if (!datasetOk || !workspace_id || !dataset_id) {
      return new Response(JSON.stringify({ success: false, error: "dataset_or_workspace_invalid", steps }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const executeUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;

    const executeDax = async (query: string): Promise<ExecuteDaxResult> => {
      try {
        const response = await fetch(executeUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            queries: [{ query }],
            serializerSettings: { includeNulls: true },
          }),
        });

        const raw = await response.text();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        if (!response.ok) {
          return {
            ok: false,
            rows: [],
            error: `HTTP ${response.status}`,
            http_status: response.status,
            raw_response: truncate(raw, 3500),
            query,
          };
        }

        const first = (parsed?.results as Array<Record<string, unknown>> | undefined)?.[0];
        const embeddedError = (first?.error as Record<string, unknown> | undefined) || undefined;
        if (embeddedError) {
          const xmlaStatus = typeof embeddedError.code === "string" ? embeddedError.code : undefined;
          return {
            ok: false,
            rows: [],
            error: truncate(embeddedError, 500),
            http_status: response.status,
            xmla_status: xmlaStatus,
            raw_response: truncate(raw, 3500),
            query,
          };
        }

        const tables = (first?.tables as Array<Record<string, unknown>> | undefined) || [];
        const rows = (tables[0]?.rows as Array<Record<string, unknown>> | undefined) || [];

        return {
          ok: true,
          rows,
          http_status: response.status,
          raw_response: truncate(raw, 3500),
          query,
        };
      } catch (error) {
        return {
          ok: false,
          rows: [],
          error: (error as Error).message,
          raw_response: undefined,
          query,
        };
      }
    };

    // STEP C1 - TABLE DISCOVERY + FILTER
    const ignoredTables: IgnoredTable[] = [];
    let discoveredTables: DiscoveredTable[] = [];
    let tableSourceMethod = "none";
    {
      const started = Date.now();
      const discoveryAttempts = [
        {
          method: "INFO.TABLES",
          query: "EVALUATE INFO.TABLES()",
          parse: (rows: Record<string, unknown>[]): DiscoveredTable[] => rows.map((row) => ({
            discovered_name: String(pickRowValue(row, ["Name", "TABLE_NAME", "TableName"]) ?? "").trim(),
            effective_name: String(pickRowValue(row, ["Name", "TABLE_NAME", "TableName"]) ?? "").trim(),
            source_method: "INFO.TABLES",
            table_id: typeof pickRowValue(row, ["ID", "TableID"]) === "number" ? Number(pickRowValue(row, ["ID", "TableID"])) : undefined,
            is_hidden: parseBool(pickRowValue(row, ["IsHidden"])),
          })).filter((t) => t.discovered_name.length > 0),
        },
        {
          method: "TMSCHEMA_TABLES",
          query: "SELECT [ID], [Name], [IsHidden] FROM $SYSTEM.TMSCHEMA_TABLES",
          parse: (rows: Record<string, unknown>[]): DiscoveredTable[] => rows.map((row) => ({
            discovered_name: String(pickRowValue(row, ["Name", "TABLE_NAME"]) ?? "").trim(),
            effective_name: String(pickRowValue(row, ["Name", "TABLE_NAME"]) ?? "").trim(),
            source_method: "TMSCHEMA_TABLES",
            table_id: typeof pickRowValue(row, ["ID"]) === "number" ? Number(pickRowValue(row, ["ID"])) : undefined,
            is_hidden: parseBool(pickRowValue(row, ["IsHidden"])),
          })).filter((t) => t.discovered_name.length > 0),
        },
        {
          method: "DBSCHEMA_TABLES",
          query: "SELECT [TABLE_NAME], [TABLE_TYPE] FROM $SYSTEM.DBSCHEMA_TABLES WHERE [TABLE_TYPE] = 'TABLE'",
          parse: (rows: Record<string, unknown>[]): DiscoveredTable[] => rows.map((row) => ({
            discovered_name: String(pickRowValue(row, ["TABLE_NAME", "Name"]) ?? "").trim(),
            effective_name: String(pickRowValue(row, ["TABLE_NAME", "Name"]) ?? "").trim(),
            source_method: "DBSCHEMA_TABLES",
          })).filter((t) => t.discovered_name.length > 0),
        },
      ] as const;

      const discoveryErrors: string[] = [];
      for (const attempt of discoveryAttempts) {
        const result = await executeDax(attempt.query);
        if (!result.ok || result.rows.length === 0) {
          discoveryErrors.push(`${attempt.method}: ${result.error || "empty"}`);
          continue;
        }

        const parsed = uniqueBy(attempt.parse(result.rows), (t) => t.discovered_name);
        if (parsed.length > 0) {
          discoveredTables = parsed;
          tableSourceMethod = attempt.method;
          break;
        }
        discoveryErrors.push(`${attempt.method}: parsed_empty`);
      }

      const candidateTables: DiscoveredTable[] = [];
      for (const table of discoveredTables) {
        const reason = ignoredReasonForTable(table.discovered_name, table.is_hidden);
        if (reason) {
          ignoredTables.push({ name: table.discovered_name, reason, source_method: table.source_method });

          const alias = stripLeadingDollar(table.discovered_name);
          const aliasReason = ignoredReasonForTable(alias, false);
          if (alias && alias !== table.discovered_name && !aliasReason) {
            candidateTables.push({
              discovered_name: table.discovered_name,
              effective_name: alias,
              source_method: `${table.source_method}_DERIVED_ALIAS`,
              table_id: table.table_id,
            });
          }
          continue;
        }

        candidateTables.push(table);
      }

      discoveredTables = uniqueBy(candidateTables, (t) => t.effective_name);

      const hasTables = discoveredTables.length > 0;
      steps.push({
        step: "C1",
        label: "Tabelas reais",
        status: hasTables ? "ok" : "fail",
        detail: hasTables
          ? `${discoveredTables.length} tabela(s) candidata(s) após filtro de internas/ocultas.`
          : "Não foi possível obter tabelas reais utilizáveis.",
        data: {
          table_source_method: tableSourceMethod,
          discovered_total: discoveredTables.length + ignoredTables.length,
          candidate_tables: discoveredTables.map((t) => ({ discovered_name: t.discovered_name, effective_name: t.effective_name, source_method: t.source_method })),
          ignored_internal_tables: ignoredTables,
          errors: discoveryErrors.length ? discoveryErrors.slice(0, 6) : undefined,
        },
        duration_ms: Date.now() - started,
      });

      await insertEvent("powerbi_xmla_tables", hasTables ? "info" : "error", {
        workspace_id,
        dataset_id,
        project_id,
        connection_id,
        request: { methods: ["INFO.TABLES", "TMSCHEMA_TABLES", "DBSCHEMA_TABLES"] },
        response_summary: {
          table_source_method: tableSourceMethod,
          candidates: discoveredTables.map((t) => t.effective_name),
          ignored: ignoredTables.slice(0, 25),
        },
        discovered_table_name: discoveredTables[0]?.discovered_name || null,
        effective_query_table_name: discoveredTables[0]?.effective_name || null,
        table_source_method: tableSourceMethod,
      });
    }

    // Resolve effective table name for query context
    let discoveredTableName: string | null = null;
    let effectiveTableName: string | null = null;
    let effectiveTableSource = "none";

    // Sort candidate tables by business relevance (facts first, calendars last)
    const sortedCandidates = [...discoveredTables].sort(
      (a, b) => tableBusinessScore(b.effective_name) - tableBusinessScore(a.effective_name),
    );

    const candidateNamePool = uniqueBy(
      sortedCandidates.map((t) => t.effective_name),
      (name) => name,
    );

    const requestedCandidates = requested_table_name
      ? uniqueBy([requested_table_name, stripLeadingDollar(requested_table_name)], (name) => name)
      : [];

    const probeTable = async (tableName: string) => {
      const result = await executeDax(`EVALUATE TOPN(1, ${escapeDaxTable(tableName)})`);
      return result.ok;
    };

    // If user explicitly requested a table, probe it first; otherwise use ranked order
    const tableProbeQueue = uniqueBy(
      [
        ...requestedCandidates,
        ...candidateNamePool,
      ],
      (name) => name,
    ).slice(0, 12);

    for (const name of tableProbeQueue) {
      const ok = await probeTable(name);
      if (!ok) continue;

      effectiveTableName = name;
      const fromDiscovered = discoveredTables.find((t) => t.effective_name.toLowerCase() === name.toLowerCase())
        || discoveredTables.find((t) => t.discovered_name.toLowerCase() === name.toLowerCase());

      discoveredTableName = fromDiscovered?.discovered_name || requested_table_name || name;
      effectiveTableSource = fromDiscovered?.source_method || (requested_table_name ? "REQUESTED_TABLE" : "PROBED_TABLE");
      break;
    }

    if (!effectiveTableName && requested_table_name) {
      effectiveTableName = requested_table_name;
      discoveredTableName = requested_table_name;
      effectiveTableSource = "REQUESTED_TABLE_UNVERIFIED";
    }

    // STEP C2 - COLUMNS CASCADE
    let extractedColumns: ColumnInfo[] = [];
    let columnsMethod = "none";
    const columnErrors: Array<Record<string, unknown>> = [];

    {
      const started = Date.now();

      if (!effectiveTableName) {
        steps.push({
          step: "C2",
          label: "Colunas",
          status: "fail",
          detail: "Sem tabela efetiva para extração de colunas.",
          data: { requested_table_name, discovered_table_name: discoveredTableName },
          duration_ms: Date.now() - started,
        });
      } else {
        const tableName = effectiveTableName;

        // a) INFO.COLUMNS() com nome real
        const infoQueries = [
          {
            method: "INFO.COLUMNS_TABLE",
            query: `EVALUATE SELECTCOLUMNS(FILTER(INFO.COLUMNS(), LOWER([Table]) = LOWER(${escapeDaxString(tableName)})), "table_name", [Table], "column_name", [Name], "data_type", [DataType] & "", "is_hidden", [IsHidden])`,
          },
          {
            method: "INFO.COLUMNS_TABLENAME",
            query: `EVALUATE SELECTCOLUMNS(FILTER(INFO.COLUMNS(), LOWER([TableName]) = LOWER(${escapeDaxString(tableName)})), "table_name", [TableName], "column_name", [Name], "data_type", [DataType] & "", "is_hidden", [IsHidden])`,
          },
          {
            method: "INFO.COLUMNS_RAW",
            query: "EVALUATE INFO.COLUMNS()",
          },
        ] as const;

        for (const attempt of infoQueries) {
          if (extractedColumns.length > 0) break;
          const result = await executeDax(attempt.query);
          if (!result.ok) {
            columnErrors.push({ method: attempt.method, error: result.error, raw_response: result.raw_response, http_status: result.http_status, xmla_status: result.xmla_status });
            continue;
          }

          const parsed = result.rows
            .map((row) => {
              const table = String(pickRowValue(row, ["table_name", "Table", "TableName", "TABLE_NAME"]) ?? "").trim();
              const column = String(pickRowValue(row, ["column_name", "Name", "ExplicitName", "InferredName", "COLUMN_NAME"]) ?? "").trim();
              const dataType = String(pickRowValue(row, ["data_type", "DataType", "ExplicitDataType", "DATA_TYPE"]) ?? "unknown").trim();
              const hidden = parseBool(pickRowValue(row, ["is_hidden", "IsHidden"]));
              return { table, column, dataType, hidden };
            })
            .filter((c) => c.column.length > 0 && c.table.length > 0 && c.table.toLowerCase() === tableName.toLowerCase() && !c.hidden)
            .map((c) => ({ table_name: c.table, column_name: c.column, data_type: c.dataType }));

          if (parsed.length > 0) {
            extractedColumns = uniqueBy(parsed, (c) => `${c.table_name}.${c.column_name}`);
            columnsMethod = attempt.method;
          }
        }

        // b) TMSCHEMA_COLUMNS por TableID
        if (extractedColumns.length === 0) {
          let tableId: number | null = discoveredTables.find((t) => t.effective_name.toLowerCase() === tableName.toLowerCase())?.table_id ?? null;

          if (tableId == null) {
            const tableIdLookup = await executeDax(`SELECT [ID], [Name] FROM $SYSTEM.TMSCHEMA_TABLES`);
            if (tableIdLookup.ok) {
              const match = tableIdLookup.rows.find((row) => {
                const n = String(pickRowValue(row, ["Name"]) ?? "").trim();
                return n.toLowerCase() === tableName.toLowerCase() || stripLeadingDollar(n).toLowerCase() === tableName.toLowerCase();
              });
              const idVal = pickRowValue(match || {}, ["ID"]);
              tableId = typeof idVal === "number" ? idVal : null;
            }
          }

          if (tableId != null) {
            const tmschema = await executeDax(`SELECT [TableID], [ExplicitName], [InferredName], [ExplicitDataType], [DataType], [IsHidden] FROM $SYSTEM.TMSCHEMA_COLUMNS WHERE [TableID] = ${tableId}`);
            if (tmschema.ok) {
              const parsed = tmschema.rows
                .map((row) => {
                  const hidden = parseBool(pickRowValue(row, ["IsHidden"]));
                  const column = String(pickRowValue(row, ["ExplicitName", "InferredName", "Name"]) ?? "").trim();
                  const dataType = String(pickRowValue(row, ["ExplicitDataType", "DataType"]) ?? "unknown").trim();
                  return { hidden, column, dataType };
                })
                .filter((c) => c.column.length > 0 && !c.hidden)
                .map((c) => ({ table_name: tableName, column_name: c.column, data_type: c.dataType }));

              if (parsed.length > 0) {
                extractedColumns = uniqueBy(parsed, (c) => `${c.table_name}.${c.column_name}`);
                columnsMethod = "TMSCHEMA_COLUMNS_TABLEID";
              }
            } else {
              columnErrors.push({ method: "TMSCHEMA_COLUMNS_TABLEID", error: tmschema.error, raw_response: tmschema.raw_response, http_status: tmschema.http_status, xmla_status: tmschema.xmla_status });
            }
          } else {
            columnErrors.push({ method: "TMSCHEMA_COLUMNS_TABLEID", error: "table_id_not_resolved" });
          }
        }

        // c) DISCOVER_CSDL_METADATA
        if (extractedColumns.length === 0) {
          const csdl = await executeDax("SELECT * FROM $SYSTEM.DISCOVER_CSDL_METADATA");
          if (csdl.ok && csdl.rows.length > 0) {
            const row = csdl.rows[0];
            const rawXml = Object.values(row).find((v) => typeof v === "string") as string | undefined;
            if (rawXml) {
              const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const entityRegex = new RegExp(`<EntityType\\s+Name=\"${escaped}\"[^>]*>([\\s\\S]*?)<\\/EntityType>`, "i");
              const match = rawXml.match(entityRegex);
              const body = match?.[1] || "";
              const props = [...body.matchAll(/<Property\s+Name=\"([^\"]+)\"\s+Type=\"([^\"]+)\"/g)];
              if (props.length > 0) {
                extractedColumns = props.map((p) => ({ table_name: tableName, column_name: p[1], data_type: p[2] || "unknown" }));
                columnsMethod = "DISCOVER_CSDL_METADATA";
              }
            }
          } else {
            columnErrors.push({ method: "DISCOVER_CSDL_METADATA", error: csdl.error, raw_response: csdl.raw_response, http_status: csdl.http_status, xmla_status: csdl.xmla_status });
          }
        }

        // d) DBSCHEMA_COLUMNS
        if (extractedColumns.length === 0) {
          const dbschema = await executeDax("SELECT [TABLE_NAME], [COLUMN_NAME] FROM $SYSTEM.DBSCHEMA_COLUMNS");
          if (dbschema.ok) {
            const tableCandidates = uniqueBy([tableName, `$${tableName}`], (x) => x).map((x) => x.toLowerCase());
            const parsed = dbschema.rows
              .map((row) => ({
                table: String(pickRowValue(row, ["TABLE_NAME", "table_name"]) ?? "").trim(),
                column: String(pickRowValue(row, ["COLUMN_NAME", "column_name"]) ?? "").trim(),
              }))
              .filter((c) => c.table && c.column && tableCandidates.includes(c.table.toLowerCase()))
              .map((c) => ({ table_name: tableName, column_name: c.column, data_type: "unknown" }));

            if (parsed.length > 0) {
              extractedColumns = uniqueBy(parsed, (c) => `${c.table_name}.${c.column_name}`);
              columnsMethod = "DBSCHEMA_COLUMNS";
            }
          } else {
            columnErrors.push({ method: "DBSCHEMA_COLUMNS", error: dbschema.error, raw_response: dbschema.raw_response, http_status: dbschema.http_status, xmla_status: dbschema.xmla_status });
          }
        }

        // e) TOPN(1,tabela_real)
        if (extractedColumns.length === 0) {
          const topn = await executeDax(`EVALUATE TOPN(1, ${escapeDaxTable(tableName)})`);
          if (topn.ok && topn.rows.length > 0) {
            const keys = Object.keys(topn.rows[0]);
            const cols = keys.map(cleanupColumnKey).filter(Boolean);
            extractedColumns = uniqueBy(cols.map((column_name) => ({ table_name: tableName, column_name, data_type: "unknown" })), (c) => `${c.table_name}.${c.column_name}`);
            columnsMethod = "TOPN_KEYS";
          } else {
            columnErrors.push({ method: "TOPN_KEYS", error: topn.error, raw_response: topn.raw_response, http_status: topn.http_status, xmla_status: topn.xmla_status });

            // probe requested in requirement
            const selectColumnsProbe = await executeDax(`EVALUATE SELECTCOLUMNS(TOPN(1, ${escapeDaxTable(tableName)}), "col", TRUE())`);
            if (!selectColumnsProbe.ok) {
              columnErrors.push({ method: "SELECTCOLUMNS_TOPN_PROBE", error: selectColumnsProbe.error, raw_response: selectColumnsProbe.raw_response, http_status: selectColumnsProbe.http_status, xmla_status: selectColumnsProbe.xmla_status });
            }
          }
        }

        const ok = extractedColumns.length > 0;
        steps.push({
          step: "C2",
          label: "Colunas",
          status: ok ? "ok" : "fail",
          detail: ok
            ? `${extractedColumns.length} coluna(s) extraída(s) via ${columnsMethod}.`
            : "Falha ao extrair colunas com todos os métodos em cascata.",
          data: {
            discovered_table_name: discoveredTableName,
            effective_query_table_name: effectiveTableName,
            table_source_method: effectiveTableSource,
            columns_method: columnsMethod,
            columns: extractedColumns.slice(0, 200),
            errors: columnErrors.slice(0, 10),
          },
          duration_ms: Date.now() - started,
        });

        await insertEvent("powerbi_xmla_columns", ok ? "info" : "error", {
          workspace_id,
          dataset_id,
          project_id,
          connection_id,
          discovered_table_name: discoveredTableName,
          effective_query_table_name: effectiveTableName,
          table_source_method: effectiveTableSource,
          request: {
            table_name: effectiveTableName,
            methods: ["INFO.COLUMNS", "TMSCHEMA_COLUMNS", "DISCOVER_CSDL_METADATA", "DBSCHEMA_COLUMNS", "TOPN_KEYS"],
          },
          response_summary: {
            columns_found: extractedColumns.length,
            columns_method: columnsMethod,
          },
          error_message: extractedColumns.length > 0 ? null : truncate(columnErrors),
        });
      }
    }

    // STEP D - SAMPLE
    let sampleRows: Record<string, unknown>[] = [];
    let sampleColumns: string[] = [];
    let sampleMethod = "none";
    let sampleError: Record<string, unknown> | null = null;

    {
      const started = Date.now();

      if (!effectiveTableName) {
        steps.push({ step: "D", label: "Amostra", status: "fail", detail: "Tabela efetiva não resolvida.", duration_ms: Date.now() - started });
      } else {
        const query = `EVALUATE TOPN(10, ${escapeDaxTable(effectiveTableName)})`;
        const sample = await executeDax(query);

        if (sample.ok) {
          sampleRows = sample.rows;
          sampleColumns = sample.rows.length > 0 ? Object.keys(sample.rows[0]).map(cleanupColumnKey).filter(Boolean) : [];
          sampleMethod = "TOPN_10_EXECUTEQUERIES";

          steps.push({
            step: "D",
            label: "Amostra",
            status: sampleRows.length > 0 ? "ok" : "fail",
            detail: sampleRows.length > 0
              ? `${sampleRows.length} linha(s) retornada(s) em ${sampleColumns.length} coluna(s).`
              : "Query executou, mas não retornou linhas.",
            data: {
              discovered_table_name: discoveredTableName,
              effective_query_table_name: effectiveTableName,
              table_source_method: effectiveTableSource,
              sample_method: sampleMethod,
              query,
              rows_returned: sampleRows.length,
              sample_preview: sampleRows.slice(0, 3),
            },
            duration_ms: Date.now() - started,
          });
        } else {
          sampleError = {
            error: sample.error,
            raw_response: sample.raw_response,
            http_status: sample.http_status,
            xmla_status: sample.xmla_status,
            query,
          };

          steps.push({
            step: "D",
            label: "Amostra",
            status: "fail",
            detail: `Falha ao executar TOPN(10): ${sample.error || "erro desconhecido"}`,
            data: sampleError,
            duration_ms: Date.now() - started,
          });
        }

        await insertEvent("powerbi_xmla_sample_query", sampleRows.length > 0 ? "info" : "error", {
          workspace_id,
          dataset_id,
          project_id,
          connection_id,
          discovered_table_name: discoveredTableName,
          effective_query_table_name: effectiveTableName,
          table_source_method: effectiveTableSource,
          request: { query },
          response_summary: { rows: sampleRows.length, columns: sampleColumns.length, sample_method: sampleMethod },
          http_status: sampleError?.http_status ?? 200,
          xmla_status: sampleError?.xmla_status ?? null,
          error_message: sampleError?.error ?? null,
          raw_response: sampleError?.raw_response ?? null,
        });
      }
    }

    // STEP E - ROW COUNT
    let rowCount = 0;
    let rowCountMethod = "none";
    let rowCountError: Record<string, unknown> | null = null;

    {
      const started = Date.now();
      if (!effectiveTableName) {
        steps.push({ step: "E", label: "Row count", status: "fail", detail: "Tabela efetiva não resolvida.", duration_ms: Date.now() - started });
      } else {
        const query = `EVALUATE ROW("row_count", COUNTROWS(${escapeDaxTable(effectiveTableName)}))`;
        const countResult = await executeDax(query);

        if (countResult.ok && countResult.rows.length > 0) {
          const value = pickRowValue(countResult.rows[0], ["row_count", "count"]);
          rowCount = typeof value === "number" ? value : parseInt(String(value ?? 0), 10) || 0;
          rowCountMethod = "COUNTROWS_EXECUTEQUERIES";

          steps.push({
            step: "E",
            label: "Row count",
            status: rowCount > 0 ? "ok" : "fail",
            detail: rowCount > 0
              ? `COUNTROWS retornou ${rowCount} linhas.`
              : "COUNTROWS retornou 0.",
            data: {
              discovered_table_name: discoveredTableName,
              effective_query_table_name: effectiveTableName,
              row_count_method: rowCountMethod,
              query,
              row_count: rowCount,
            },
            duration_ms: Date.now() - started,
          });
        } else if (sampleRows.length > 0) {
          rowCount = sampleRows.length;
          rowCountMethod = "SAMPLE_MIN_FALLBACK";
          steps.push({
            step: "E",
            label: "Row count",
            status: "ok",
            detail: `COUNTROWS falhou; usado fallback mínimo da amostra (${rowCount}).`,
            data: {
              discovered_table_name: discoveredTableName,
              effective_query_table_name: effectiveTableName,
              row_count_method: rowCountMethod,
              error: countResult.error,
              raw_response: countResult.raw_response,
            },
            duration_ms: Date.now() - started,
          });
        } else {
          rowCountError = {
            error: countResult.error,
            raw_response: countResult.raw_response,
            http_status: countResult.http_status,
            xmla_status: countResult.xmla_status,
            query,
          };
          steps.push({
            step: "E",
            label: "Row count",
            status: "fail",
            detail: `Falha no COUNTROWS: ${countResult.error || "erro desconhecido"}`,
            data: rowCountError,
            duration_ms: Date.now() - started,
          });
        }
      }
    }

    const realTableColumns = effectiveTableName
      ? extractedColumns.filter((c) => c.table_name.toLowerCase() === effectiveTableName.toLowerCase())
      : [];

    if (realTableColumns.length === 0 && sampleColumns.length > 0 && effectiveTableName) {
      realTableColumns.push(
        ...sampleColumns.map((name) => ({ table_name: effectiveTableName!, column_name: name, data_type: "unknown" })),
      );
      if (columnsMethod === "none") columnsMethod = "TOPN_SAMPLE_KEYS";
    }

    const finalColumns = uniqueBy(realTableColumns, (c) => c.column_name);
    const finalRowCount = rowCount > 0 ? rowCount : sampleRows.length;

    await insertEvent("powerbi_xmla_row_count", finalRowCount > 0 ? "info" : "error", {
      workspace_id,
      dataset_id,
      project_id,
      connection_id,
      discovered_table_name: discoveredTableName,
      effective_query_table_name: effectiveTableName,
      table_source_method: effectiveTableSource,
      request: { table_name: effectiveTableName },
      response_summary: { row_count: finalRowCount, row_count_method: rowCountMethod },
      http_status: rowCountError?.http_status ?? 200,
      xmla_status: rowCountError?.xmla_status ?? null,
      error_message: rowCountError?.error ?? null,
      raw_response: rowCountError?.raw_response ?? null,
    });

    // STEP F - MATERIALIZATION
    let materialized = false;
    const hasRealSchema = finalColumns.length > 0;
    const hasRealData = finalRowCount > 0;
    const canMaterialize = Boolean(effectiveTableName && hasRealSchema && hasRealData);

    if (materialize) {
      const started = Date.now();

      if (!canMaterialize || !effectiveTableName) {
        steps.push({
          step: "F",
          label: "Materialização",
          status: "fail",
          detail: "SCHEMA_NOT_MATERIALIZED_XMLA: schema real ou dados reais ausentes.",
          data: {
            effective_query_table_name: effectiveTableName,
            columns_found: finalColumns.length,
            row_count: finalRowCount,
          },
          duration_ms: Date.now() - started,
        });

        await insertEvent("powerbi_xmla_materialization_failed", "error", {
          workspace_id,
          dataset_id,
          project_id,
          connection_id,
          discovered_table_name: discoveredTableName,
          effective_query_table_name: effectiveTableName,
          table_source_method: effectiveTableSource,
          error_code: "SCHEMA_NOT_MATERIALIZED_XMLA",
          error_message: "schema real ou dados reais ausentes",
          response_summary: { columns_found: finalColumns.length, row_count: finalRowCount },
        });
      } else {
        const connectionMode = ["TMSCHEMA_COLUMNS_TABLEID", "DISCOVER_CSDL_METADATA"].includes(columnsMethod)
          ? "xmla"
          : "executequeries";

        const schemaJson = finalColumns.map((col, index) => ({
          name: col.column_name,
          type: col.data_type || "unknown",
          index,
          source: columnsMethod,
        }));

        try {
          const { data: finalizeResult, error: finalizeError } = await supabaseAdmin.rpc("rpc_finalize_ingestion", {
            p_project_id: project_id,
            p_source_type: PBI_SOURCE_TYPE,
            p_config_hash: `pbi_materialized_${project_id}_${effectiveTableName}`,
            p_dataset_id: null,
            p_source_pointer: {
              connector_type: "powerbi",
              connection_mode: connectionMode,
              discovered_table_name: discoveredTableName,
              effective_query_table_name: effectiveTableName,
              table_source_method: effectiveTableSource,
              table_discovery_method: tableSourceMethod,
              columns_method: columnsMethod,
              sample_method: sampleMethod,
              row_count_method: rowCountMethod,
              workspace_id,
              dataset_id,
              connection_id,
            },
            p_schema_json: schemaJson,
            p_row_count: finalRowCount,
            p_col_count: finalColumns.length,
            p_total_bytes: 0,
            p_sample_strategy: {
              method: sampleMethod,
              row_count_method: rowCountMethod,
              source: connectionMode,
            },
            p_file_count: 0,
          });

          if (finalizeError) {
            steps.push({
              step: "F",
              label: "Materialização",
              status: "fail",
              detail: `Falha ao finalizar ingestão: ${finalizeError.message}`,
              data: { error: truncate(finalizeError) },
              duration_ms: Date.now() - started,
            });

            await insertEvent("powerbi_xmla_materialization_failed", "error", {
              workspace_id,
              dataset_id,
              project_id,
              connection_id,
              discovered_table_name: discoveredTableName,
              effective_query_table_name: effectiveTableName,
              table_source_method: effectiveTableSource,
              error_code: "FINALIZE_FAILED",
              error_message: finalizeError.message,
            });
          } else {
            await supabaseAdmin
              .from("project_datasets")
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq("project_id", project_id)
              .eq("is_active", true);

            const { data: datasetRow, error: datasetInsertError } = await supabaseAdmin
              .from("project_datasets")
              .insert({
                project_id,
                user_id: user.id,
                name: `Power BI Materialized: ${effectiveTableName}`,
                storage_path: `powerbi_materialized/${project_id}/${effectiveTableName}`,
                file_size_bytes: 0,
                total_rows: finalRowCount,
                sample_rows: sampleRows.length,
                columns_count: finalColumns.length,
                is_active: true,
                source_type: PBI_SOURCE_TYPE,
                source_metadata: {
                  connector_type: "powerbi",
                  connection_mode: connectionMode,
                  discovered_table_name: discoveredTableName,
                  effective_query_table_name: effectiveTableName,
                  table_source_method: effectiveTableSource,
                  table_discovery_method: tableSourceMethod,
                  columns_method: columnsMethod,
                  sample_method: sampleMethod,
                  row_count_method: rowCountMethod,
                  workspace_id,
                  dataset_id,
                  connection_id,
                  manifest_id: (finalizeResult as Record<string, unknown> | null)?.manifest_id ?? null,
                },
              })
              .select("id")
              .single();

            if (datasetInsertError) throw datasetInsertError;

            await supabaseAdmin.from("project_columns").delete().eq("project_id", project_id);

            const { error: columnsInsertError } = await supabaseAdmin.from("project_columns").insert(
              finalColumns.map((col, index) => ({
                project_id,
                column_name: col.column_name,
                column_index: index,
                inferred_type: typeToInferred(col.data_type),
              })),
            );
            if (columnsInsertError) throw columnsInsertError;

            await supabaseAdmin.from("project_dataset_state").upsert(
              {
                project_id,
                source_type: PBI_SOURCE_TYPE,
                row_count: finalRowCount,
                col_count: finalColumns.length,
                active_schema_json: schemaJson,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "project_id" },
            );

            if (connection_id) {
              const { data: connData } = await supabaseAdmin
                .from("external_connections")
                .select("metadata")
                .eq("id", connection_id)
                .maybeSingle();
              const oldMeta = (connData?.metadata as Record<string, unknown> | null) || {};

              await supabaseAdmin
                .from("external_connections")
                .update({
                  connection_status: "connected_full_discovery",
                  validation_message: `Materializado: ${effectiveTableName} (${finalColumns.length} colunas, ${finalRowCount} linhas)`,
                  last_validated_at: new Date().toISOString(),
                  metadata: {
                    ...oldMeta,
                    source_mode: "powerbi_materialized",
                    connection_mode: connectionMode,
                    discovered_table_name: discoveredTableName,
                    effective_query_table_name: effectiveTableName,
                    columns_method: columnsMethod,
                    sample_method: sampleMethod,
                    row_count_method: rowCountMethod,
                  },
                })
                .eq("id", connection_id);
            }

            materialized = true;
            steps.push({
              step: "F",
              label: "Materialização",
              status: "ok",
              detail: `Dataset materializado com schema real (${finalColumns.length} colunas / ${finalRowCount} linhas).`,
              data: {
                project_dataset_id: datasetRow?.id,
                source_type: PBI_SOURCE_TYPE,
                connection_mode: connectionMode,
              },
              duration_ms: Date.now() - started,
            });

            await insertEvent("powerbi_xmla_materialization_success", "info", {
              workspace_id,
              dataset_id,
              project_id,
              connection_id,
              discovered_table_name: discoveredTableName,
              effective_query_table_name: effectiveTableName,
              table_source_method: effectiveTableSource,
              request: {
                columns_method: columnsMethod,
                sample_method: sampleMethod,
                row_count_method: rowCountMethod,
              },
              response_summary: {
                source_type: PBI_SOURCE_TYPE,
                connection_mode: connectionMode,
                columns: finalColumns.length,
                row_count: finalRowCount,
              },
            });
          }
        } catch (error) {
          steps.push({
            step: "F",
            label: "Materialização",
            status: "fail",
            detail: `Erro inesperado na materialização: ${(error as Error).message}`,
            data: { error: truncate(error) },
            duration_ms: Date.now() - started,
          });

          await insertEvent("powerbi_xmla_materialization_failed", "error", {
            workspace_id,
            dataset_id,
            project_id,
            connection_id,
            discovered_table_name: discoveredTableName,
            effective_query_table_name: effectiveTableName,
            table_source_method: effectiveTableSource,
            error_code: "MATERIALIZATION_EXCEPTION",
            error_message: (error as Error).message,
          });
        }
      }
    }

    const xmlaEndpoint = workspaceName
      ? `powerbi://api.powerbi.com/v1.0/myorg/${encodeURIComponent(workspaceName)}`
      : `powerbi://api.powerbi.com/v1.0/myorg/${workspace_id}`;

    const allOk = steps.every((step) => step.status === "ok" || step.status === "skip");

    return new Response(JSON.stringify({
      success: true,
      diagnostic: {
        xmla_endpoint: xmlaEndpoint,
        steps,
        summary: {
          auth_ok: steps.find((s) => s.step === "A")?.status === "ok",
          workspace_ok: workspaceOk,
          dataset_ok: datasetOk,
          tables_found: discoveredTables.length,
          columns_found: finalColumns.length,
          sample_ok: sampleRows.length > 0,
          row_count: finalRowCount,
          all_ok: allOk,
        },
        ignored_internal_tables: ignoredTables,
        candidate_tables: sortedCandidates.map((t) => ({
          discovered_name: t.discovered_name,
          effective_name: t.effective_name,
          source_method: t.source_method,
          business_score: tableBusinessScore(t.effective_name),
        })),
        source_type_persisted: PBI_SOURCE_TYPE,
        discovered_table_name: discoveredTableName,
        effective_query_table_name: effectiveTableName,
        table_source_method: effectiveTableSource,
        columns_method: columnsMethod,
        sample_method: sampleMethod,
        row_count_method: rowCountMethod,
        tables: discoveredTables.map((t) => t.effective_name),
        columns_by_table: Object.fromEntries(
          uniqueBy(finalColumns.map((c) => c.table_name), (t) => t).map((table) => [
            table,
            finalColumns.filter((c) => c.table_name === table).map((c) => ({ name: c.column_name, type: c.data_type })),
          ]),
        ),
        raw_errors: {
          columns: columnErrors,
          sample: sampleError,
          row_count: rowCountError,
        },
      },
      can_materialize: canMaterialize,
      materialized,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("[debug-powerbi-xmla] Error:", error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
