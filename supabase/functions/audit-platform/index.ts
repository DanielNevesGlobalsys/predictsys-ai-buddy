import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const PII_PATTERNS = /cpf|email|phone|telefone|celular|senha|password|token|secret/i;

function stripPII(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripPII);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (PII_PATTERNS.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = stripPII(v);
      }
    }
    return out;
  }
  return obj;
}

interface SafeResult {
  data: unknown[] | null;
  warning?: string;
}

async function safeSelect(
  supabase: ReturnType<typeof createClient>,
  table: string,
  columns: string,
  filters: Record<string, unknown>,
  limit: number,
  orderBy?: string,
  orderAsc?: boolean
): Promise<SafeResult> {
  try {
    let q = supabase.from(table).select(columns);
    for (const [k, v] of Object.entries(filters)) {
      q = q.eq(k, v);
    }
    if (orderBy) q = q.order(orderBy, { ascending: orderAsc ?? false });
    q = q.limit(limit);
    const { data, error } = await q;
    if (error) {
      // Try with wildcard if column issue
      if (error.message?.includes("column") || error.code === "42703") {
        let q2 = supabase.from(table).select("*");
        for (const [k, v] of Object.entries(filters)) {
          q2 = q2.eq(k, v);
        }
        if (orderBy) {
          try {
            q2 = q2.order(orderBy, { ascending: orderAsc ?? false });
          } catch { /* skip ordering */ }
        }
        q2 = q2.limit(limit);
        const r2 = await q2;
        if (r2.error) {
          return { data: null, warning: `${table}: ${r2.error.message}` };
        }
        return { data: r2.data, warning: `${table}: fell back to select(*)` };
      }
      return { data: null, warning: `${table}: ${error.message}` };
    }
    return { data };
  } catch (e) {
    return { data: null, warning: `${table}: ${(e as Error).message}` };
  }
}

async function safeRpc(
  supabase: ReturnType<typeof createClient>,
  fn: string,
  params: Record<string, unknown>
): Promise<{ data: unknown; warning?: string }> {
  try {
    const { data, error } = await supabase.rpc(fn, params);
    if (error) return { data: null, warning: `rpc ${fn}: ${error.message}` };
    return { data };
  } catch (e) {
    return { data: null, warning: `rpc ${fn}: ${(e as Error).message}` };
  }
}

// ── Detect available audit table ──
async function detectAuditTable(supabase: ReturnType<typeof createClient>): Promise<{ table: string | null; schema: string; warning?: string }> {
  const candidates = [
    { schema: "public", table: "audit_logs" },
    { schema: "public", table: "audit_log_entries" },
  ];
  for (const c of candidates) {
    const { data, error } = await supabase.from(c.table).select("id").limit(1);
    if (!error && data) return { table: c.table, schema: c.schema };
  }
  return { table: null, schema: "none", warning: "no_audit_table_found" };
}

// ── Detect execution tables for a project ──
const EXEC_TABLE_PATTERNS = ["job", "run", "execution", "pipeline", "scoring", "ingestion", "contract", "prediction_state", "schedule"];

async function findProjectExecTables(supabase: ReturnType<typeof createClient>): Promise<string[]> {
  // We know certain tables exist from the schema
  const knownTables = [
    "import_jobs",
    "import_job_files",
    "import_job_events",
    "import_manifests",
    "export_jobs",
    "project_data_ingestion_logs",
    "project_contract_audits",
    "project_scoring_jobs",
    "project_score_reports",
    "project_schedule_runs",
    "project_prediction_state",
    "project_modeling_contracts",
    "project_modeling_datasets",
  ];
  return knownTables;
}

function pickOrderColumn(row: Record<string, unknown>): string | undefined {
  for (const col of ["created_at", "updated_at", "finished_at", "started_at", "timestamp"]) {
    if (col in row) return col;
  }
  return undefined;
}

// ── SCOPE: global ──
async function handleGlobal(supabase: ReturnType<typeof createClient>, warnings: string[]) {
  // 1) Audit table detection
  const auditInfo = await detectAuditTable(supabase);
  if (auditInfo.warning) warnings.push(auditInfo.warning);

  // 2) Top errors by resource_type last 7 days
  let topErrors: unknown[] = [];
  if (auditInfo.table) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const res = await safeSelect(
      supabase, auditInfo.table, "*",
      {}, 200
    );
    if (res.warning) warnings.push(res.warning);
    if (res.data && Array.isArray(res.data)) {
      // Filter errors from last 7 days
      const recent = (res.data as Record<string, unknown>[]).filter((r) => {
        const ts = (r.timestamp || r.created_at) as string;
        return ts && ts >= sevenDaysAgo && (r.action as string)?.toLowerCase().includes("error");
      });
      // Group by resource_type
      const grouped: Record<string, number> = {};
      for (const r of recent) {
        const key = (r.resource_type || r.action || "unknown") as string;
        grouped[key] = (grouped[key] || 0) + 1;
      }
      topErrors = Object.entries(grouped)
        .map(([k, v]) => ({ resource_type: k, count: v }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
    }
  }

  // 3) Error count by day (last 7 days)
  let errorsByDay: Record<string, number> = {};
  if (auditInfo.table) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const res = await safeSelect(supabase, auditInfo.table, "*", {}, 500);
    if (res.data && Array.isArray(res.data)) {
      for (const r of res.data as Record<string, unknown>[]) {
        const ts = (r.timestamp || r.created_at) as string;
        if (!ts || ts < sevenDaysAgo) continue;
        const action = (r.action || "") as string;
        if (!action.toLowerCase().includes("error")) continue;
        const day = ts.slice(0, 10);
        errorsByDay[day] = (errorsByDay[day] || 0) + 1;
      }
    }
  }

  // 4) Tables containing "audit" or "log"
  const auditTables: string[] = [];
  const knownAuditish = [
    "audit_logs", "import_job_events", "project_data_ingestion_logs",
    "project_contract_audits", "platform_events", "platform_metrics_daily",
  ];
  for (const t of knownAuditish) {
    const check = await safeSelect(supabase, t, "id", {}, 1);
    if (check.data) auditTables.push(t);
  }

  return {
    audit_table_used: auditInfo.table,
    audit_tables_found: auditTables,
    top_errors_7d: topErrors,
    errors_by_day_7d: errorsByDay,
  };
}

// ── SCOPE: project ──
async function handleProject(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
  warnings: string[]
) {
  // 1) project_settings snapshot
  const settingsRes = await safeSelect(supabase, "project_settings", "*", { project_id: projectId }, 1);
  if (settingsRes.warning) warnings.push(settingsRes.warning);

  // 2) projects snapshot
  const projectRes = await safeSelect(supabase, "projects", "*", { id: projectId }, 1);
  if (projectRes.warning) warnings.push(projectRes.warning);

  // 3) Schema probe for project_settings columns
  let schemaProbe: string[] = [];
  if (settingsRes.data && settingsRes.data.length > 0) {
    schemaProbe = Object.keys(settingsRes.data[0] as Record<string, unknown>);
  }

  // 4) Execution tables
  const execTables = await findProjectExecTables(supabase);
  const execSnapshots: Record<string, unknown> = {};
  for (const table of execTables) {
    // First get 1 row to detect order column
    const probe = await safeSelect(supabase, table, "*", { project_id: projectId }, 1);
    if (probe.warning) {
      warnings.push(probe.warning);
      continue;
    }
    if (!probe.data || probe.data.length === 0) continue;

    const orderCol = pickOrderColumn(probe.data[0] as Record<string, unknown>);
    const full = await safeSelect(
      supabase, table, "*", { project_id: projectId }, 50, orderCol
    );
    if (full.warning) warnings.push(full.warning);
    if (full.data && full.data.length > 0) {
      execSnapshots[table] = full.data;
    }
  }

  // 5) Audit logs for project
  const auditInfo = await detectAuditTable(supabase);
  let projectLogs: unknown[] = [];
  if (auditInfo.table) {
    const logsRes = await safeSelect(
      supabase, auditInfo.table, "*", { project_id: projectId }, 50, "timestamp"
    );
    if (logsRes.warning) warnings.push(logsRes.warning);
    projectLogs = logsRes.data || [];
  }

  return {
    project_settings: settingsRes.data?.[0] || null,
    project: projectRes.data?.[0] || null,
    schema_probe: schemaProbe,
    execution_tables: execSnapshots,
    audit_logs: projectLogs,
  };
}

// ── SCOPE: compare ──
async function handleCompare(
  supabase: ReturnType<typeof createClient>,
  projectIds: string[],
  warnings: string[]
) {
  const KEY_FIELDS = ["entity_key", "time_anchor_column", "prerequisites_resolved_at", "value_column"];
  const projects: Record<string, unknown> = {};
  const diffSummary: Record<string, Record<string, string>> = {};

  for (const pid of projectIds) {
    const settingsRes = await safeSelect(supabase, "project_settings", "*", { project_id: pid }, 1);
    if (settingsRes.warning) warnings.push(settingsRes.warning);
    const settings = (settingsRes.data?.[0] || {}) as Record<string, unknown>;

    // Latest runs from a few tables
    const latestRuns: Record<string, unknown> = {};
    for (const table of ["import_jobs", "export_jobs", "project_scoring_jobs"]) {
      const probe = await safeSelect(supabase, table, "*", { project_id: pid }, 1);
      if (probe.data && probe.data.length > 0) {
        const orderCol = pickOrderColumn(probe.data[0] as Record<string, unknown>);
        const r = await safeSelect(supabase, table, "*", { project_id: pid }, 5, orderCol);
        if (r.data && r.data.length > 0) latestRuns[table] = r.data;
      }
    }

    projects[pid] = { settings, latest_runs: latestRuns };

    // Diff summary
    diffSummary[pid] = {};
    for (const k of KEY_FIELDS) {
      diffSummary[pid][k] = settings[k] != null ? "present" : "absent";
    }
  }

  return { projects, diff_summary: diffSummary };
}

// ── Main handler ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const scope: string = body.scope || "global";
    const projectId: string | undefined = body.project_id;
    const projectIds: string[] | undefined = body.project_ids;
    const url = new URL(req.url);
    const download = url.searchParams.get("download") === "1";

    console.log(`[audit-platform] scope=${scope} project_id=${projectId || "n/a"}`);

    const warnings: string[] = [];
    let result: Record<string, unknown> = {};
    let filename = "platform_audit.json";

    if (scope === "global") {
      result = await handleGlobal(supabase, warnings);
      filename = "platform_audit.json";
    } else if (scope === "project") {
      if (!projectId) {
        return new Response(
          JSON.stringify({ success: false, error: "project_id is required for scope=project" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      result = await handleProject(supabase, projectId, warnings);
      filename = `project_audit_${projectId}.json`;
    } else if (scope === "compare") {
      if (!projectIds || !Array.isArray(projectIds) || projectIds.length < 1) {
        return new Response(
          JSON.stringify({ success: false, error: "project_ids array is required for scope=compare" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      result = await handleCompare(supabase, projectIds, warnings);
      filename = "project_audit_compare.json";
    } else {
      return new Response(
        JSON.stringify({ success: false, error: `Unknown scope: ${scope}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const output = stripPII({
      success: true,
      scope,
      generated_at: new Date().toISOString(),
      warnings,
      ...result,
    });

    const jsonStr = JSON.stringify(output, null, 2);
    const headers: Record<string, string> = {
      ...corsHeaders,
      "Content-Type": "application/json",
    };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename=${filename}`;
    }

    return new Response(jsonStr, { headers });
  } catch (err) {
    console.error("[audit-platform] Fatal:", err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
