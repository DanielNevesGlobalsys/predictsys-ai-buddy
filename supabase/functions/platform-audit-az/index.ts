import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── PII redaction ──
const PII_RE = /cpf|email|phone|telefone|celular|senha|password|token|secret/i;
function stripPII(obj: unknown): unknown {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(stripPII);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = PII_RE.test(k) ? "[REDACTED]" : stripPII(v);
    }
    return out;
  }
  return obj;
}

type SB = ReturnType<typeof createClient>;

// ── Safe helpers ──
async function safe<T>(fn: () => Promise<T>, warnings: string[], label: string): Promise<T | null> {
  try { return await fn(); } catch (e) { warnings.push(`${label}: ${(e as Error).message}`); return null; }
}

async function safeSelect(sb: SB, table: string, cols: string, filters: Record<string, unknown>, limit: number, orderBy?: string, asc = false, warnings?: string[]): Promise<unknown[] | null> {
  try {
    let q = sb.from(table).select(cols);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    if (orderBy) q = q.order(orderBy, { ascending: asc });
    q = q.limit(limit);
    const { data, error } = await q;
    if (error) { warnings?.push(`${table}: ${error.message}`); return null; }
    return data;
  } catch (e) { warnings?.push(`${table}: ${(e as Error).message}`); return null; }
}

async function safeCount(sb: SB, table: string, filters: Record<string, unknown>, warnings: string[]): Promise<number> {
  try {
    let q = sb.from(table).select("id", { count: "exact", head: true });
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { count, error } = await q;
    if (error) { warnings.push(`count ${table}: ${error.message}`); return 0; }
    return count ?? 0;
  } catch (e) { warnings.push(`count ${table}: ${(e as Error).message}`); return 0; }
}

// ── Detect failures in a time window via status columns ──
async function countFailures(sb: SB, table: string, sinceISO: string, statusCol: string, failValues: string[], warnings: string[]): Promise<number> {
  try {
    let q = sb.from(table).select("id", { count: "exact", head: true });
    q = q.gte("created_at", sinceISO).in(statusCol, failValues);
    const { count, error } = await q;
    if (error) { warnings.push(`failcount ${table}: ${error.message}`); return 0; }
    return count ?? 0;
  } catch { return 0; }
}

// ── Timeout detection in error messages ──
const TIMEOUT_RE = /statement timeout|canceling statement due to/i;
function isTimeout(msg: unknown): boolean {
  return typeof msg === "string" && TIMEOUT_RE.test(msg);
}

// ── PLATFORM SUMMARY ──
async function buildPlatformSummary(sb: SB, sinceISO: string, w: string[]) {
  const totalProjects = await safeCount(sb, "projects", {}, w);

  // Active projects: have any platform_event in window
  let activeProjects = 0;
  const eventsActive = await safe(async () => {
    const { data, error } = await sb.from("platform_events").select("project_id").gte("timestamp", sinceISO).not("project_id", "is", null).limit(5000);
    if (error) throw error;
    return new Set((data || []).map((r: Record<string, unknown>) => r.project_id)).size;
  }, w, "active_projects");
  activeProjects = eventsActive ?? 0;

  const ingestionFail = await countFailures(sb, "import_jobs", sinceISO, "status", ["error", "failed"], w);
  const trainingFail = await countFailures(sb, "project_models", sinceISO, "status", ["error", "failed"], w);
  const scoringFail = await countFailures(sb, "project_scoring_jobs", sinceISO, "status", ["error", "failed"], w);
  const deployFail = await countFailures(sb, "project_model_deployments", sinceISO, "status", ["error", "failed"], w);
  const scheduleFail = await countFailures(sb, "project_schedule_runs", sinceISO, "status", ["error", "failed", "blocked"], w);

  // DB timeouts from audit_logs
  let dbTimeouts = 0;
  const auditErrors = await safeSelect(sb, "audit_logs", "metadata", {}, 500, "timestamp", false, w);
  if (auditErrors) {
    for (const r of auditErrors as Record<string, unknown>[]) {
      const meta = r.metadata as Record<string, unknown> | null;
      if (meta && isTimeout(meta.error_message || meta.message || meta.details)) dbTimeouts++;
    }
  }
  // Also check import_jobs error_message
  const importErrors = await safe(async () => {
    const { data } = await sb.from("import_jobs").select("error_message").gte("created_at", sinceISO).not("error_message", "is", null).limit(500);
    return data || [];
  }, w, "import_timeout_scan");
  if (importErrors) {
    for (const r of importErrors as Record<string, unknown>[]) {
      if (isTimeout(r.error_message)) dbTimeouts++;
    }
  }

  return {
    total_projects: totalProjects,
    active_projects_last_7d: activeProjects,
    ingestion_failures_last_7d: ingestionFail,
    training_failures_last_7d: trainingFail,
    scoring_failures_last_7d: scoringFail,
    deployment_failures_last_7d: deployFail,
    schedule_errors_last_7d: scheduleFail,
    db_timeouts_last_7d: dbTimeouts,
  };
}

// ── TOP ERROR SIGNATURES ──
async function buildTopErrors(sb: SB, sinceISO: string, w: string[]) {
  const sigs: Record<string, { count: number; source: string; related_function: string; example_project_id: string }> = {};

  const addSig = (sig: string, src: string, fn: string, pid: string) => {
    const key = sig.slice(0, 120);
    if (!sigs[key]) sigs[key] = { count: 0, source: src, related_function: fn, example_project_id: pid };
    sigs[key].count++;
  };

  // Import job errors
  const ijErrs = await safe(async () => {
    const { data } = await sb.from("import_jobs").select("error_message,project_id").gte("created_at", sinceISO).not("error_message", "is", null).limit(200);
    return data || [];
  }, w, "import_errors");
  for (const r of (ijErrs || []) as Record<string, unknown>[]) {
    addSig(String(r.error_message), "job", "process-import", String(r.project_id || ""));
  }

  // Scoring job errors
  const sjErrs = await safe(async () => {
    const { data } = await sb.from("project_scoring_jobs").select("error_code,error_friendly,project_id").gte("started_at", sinceISO).in("status", ["error", "failed"]).limit(200);
    return data || [];
  }, w, "scoring_errors");
  for (const r of (sjErrs || []) as Record<string, unknown>[]) {
    addSig(String(r.error_friendly || r.error_code || "SCORING_ERROR"), "job", "run-batch-predictions", String(r.project_id || ""));
  }

  // Schedule run errors
  const srErrs = await safe(async () => {
    const { data } = await sb.from("project_schedule_runs").select("blocked_reason_code,diagnostics,project_id").gte("created_at", sinceISO).in("status", ["error", "failed", "blocked"]).limit(200);
    return data || [];
  }, w, "schedule_errors");
  for (const r of (srErrs || []) as Record<string, unknown>[]) {
    addSig(String(r.blocked_reason_code || "SCHEDULE_ERROR"), "job", "run-scheduled-predictions", String(r.project_id || ""));
  }

  // Audit log errors
  const alErrs = await safe(async () => {
    const { data } = await sb.from("audit_logs").select("action,resource_type,project_id").gte("timestamp", sinceISO).ilike("action", "%error%").limit(200);
    return data || [];
  }, w, "audit_errors");
  for (const r of (alErrs || []) as Record<string, unknown>[]) {
    addSig(`${r.resource_type}:${r.action}`, "db", "audit-log", String(r.project_id || ""));
  }

  // Platform event errors
  const peErrs = await safe(async () => {
    const { data } = await sb.from("platform_events").select("event_type,source,project_id").gte("timestamp", sinceISO).eq("status", "error").limit(200);
    return data || [];
  }, w, "platform_event_errors");
  for (const r of (peErrs || []) as Record<string, unknown>[]) {
    addSig(`${r.source}:${r.event_type}`, "edge", String(r.source || ""), String(r.project_id || ""));
  }

  return Object.entries(sigs)
    .map(([sig, v]) => ({ signature: sig, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
}

// ── PERFORMANCE HOTSPOTS ──
async function buildPerformanceHotspots(sb: SB, sinceISO: string, w: string[]) {
  const slowJobs = async (table: string, startCol: string, endCol: string, thresholdMs: number) => {
    const rows = await safe(async () => {
      const { data } = await sb.from(table).select(`id,project_id,${startCol},${endCol},status`).gte("created_at", sinceISO).not(endCol, "is", null).limit(500);
      return data || [];
    }, w, `perf_${table}`);
    if (!rows) return [];
    return (rows as Record<string, unknown>[])
      .map(r => {
        const s = new Date(r[startCol] as string).getTime();
        const e = new Date(r[endCol] as string).getTime();
        const dur = e - s;
        return { id: r.id, project_id: r.project_id, duration_ms: dur, status: r.status };
      })
      .filter(r => r.duration_ms > thresholdMs)
      .sort((a, b) => b.duration_ms - a.duration_ms)
      .slice(0, 10);
  };

  return {
    slow_import_jobs: await slowJobs("import_jobs", "created_at", "finished_at", 120000),
    slow_training_jobs: await slowJobs("project_models", "created_at", "trained_at", 300000),
    slow_scoring_jobs: await slowJobs("project_scoring_jobs", "started_at", "finished_at", 120000),
  };
}

// ── INCONSISTENCY FINDINGS ──
async function buildInconsistencies(sb: SB, w: string[]) {
  const findings: { type: string; description: string; project_ids?: string[]; examples?: unknown[] }[] = [];

  // 1) Split inconsistent: strategy=temporal AND time_anchor_column is null
  const splits = await safeSelect(sb, "project_split_policies", "project_id,strategy,time_anchor_column", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (splits) {
    const bad = splits.filter(r => r.strategy === "temporal" && !r.time_anchor_column).map(r => String(r.project_id));
    if (bad.length) findings.push({ type: "SPLIT_TEMPORAL_NO_TIME_ANCHOR", description: "Split strategy=temporal but time_anchor_column is null", project_ids: bad });
  }

  // 2) Target inconsistent: target_source=label_builder but label_build_result empty
  const settings = await safeSelect(sb, "project_settings", "project_id,target_source,label_build_result", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (settings) {
    const bad = settings.filter(r => r.target_source === "label_builder" && (!r.label_build_result || (typeof r.label_build_result === "object" && Object.keys(r.label_build_result as object).length === 0))).map(r => String(r.project_id));
    if (bad.length) findings.push({ type: "TARGET_LABEL_BUILDER_EMPTY", description: "target_source=label_builder but label_build_result is absent/empty", project_ids: bad });
  }

  // 3) Builder version mismatch
  const builders = await safeSelect(sb, "project_label_builders", "project_id,selection_version", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  const selections = await safeSelect(sb, "project_model_selection", "project_id,selection_version", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (builders && selections) {
    const selMap = new Map((selections as Record<string, unknown>[]).map(r => [r.project_id, r.selection_version]));
    const bad = (builders as Record<string, unknown>[]).filter(r => {
      const cur = selMap.get(r.project_id);
      return cur != null && r.selection_version != null && cur !== r.selection_version;
    }).map(r => String(r.project_id));
    if (bad.length) findings.push({ type: "BUILDER_VERSION_MISMATCH", description: "Label builder selection_version differs from current model_selection version", project_ids: bad });
  }

  // 4) Scoring inconsistent: prediction_state has batch_id but predictions_count=0
  const predStates = await safeSelect(sb, "project_prediction_state", "project_id,latest_batch_id,predictions_count,status", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (predStates) {
    const bad = predStates.filter(r => r.latest_batch_id && (r.predictions_count === 0 || r.predictions_count === null)).map(r => ({ project_id: r.project_id, batch_id: r.latest_batch_id, status: r.status }));
    if (bad.length) findings.push({ type: "PREDICTION_STATE_INCONSISTENT", description: "latest_batch_id exists but predictions_count=0", examples: bad });
  }

  // 5) Promotion inconsistent: deployment status=failed but production_model_id changed
  const deploys = await safeSelect(sb, "project_model_deployments", "project_id,model_id,status", {}, 200, "created_at", false, w) as Record<string, unknown>[] | null;
  if (deploys) {
    const failedDeploys = deploys.filter(r => r.status === "failed" || r.status === "error");
    if (failedDeploys.length) {
      // Check if production_model_id matches any failed deploy's model_id
      const dsStates = await safeSelect(sb, "project_dataset_state", "project_id,production_model_id", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
      if (dsStates) {
        const prodMap = new Map((dsStates as Record<string, unknown>[]).map(r => [r.project_id, r.production_model_id]));
        const bad = failedDeploys.filter(r => prodMap.get(r.project_id) === r.model_id).map(r => String(r.project_id));
        if (bad.length) findings.push({ type: "PROMOTION_INCONSISTENT", description: "production_model_id points to a model whose deployment failed", project_ids: bad });
      }
    }
  }

  // 6) DB timeouts in ingestion logs
  const ingLogs = await safeSelect(sb, "project_data_ingestion_logs", "project_id,error_message,status", {}, 300, "started_at", false, w) as Record<string, unknown>[] | null;
  if (ingLogs) {
    const bad = ingLogs.filter(r => isTimeout(r.error_message)).map(r => String(r.project_id));
    if (bad.length) findings.push({ type: "DB_TIMEOUT_INGESTION", description: "Statement timeout detected in data ingestion logs", project_ids: [...new Set(bad)] });
  }

  // 7) Modal loop: multiple updates to project_settings without real change (heuristic: >=5 updates same day)
  // We can't easily detect this without timestamps per-field, so check audit_logs for rapid project_settings updates
  const settingsAudits = await safe(async () => {
    const { data } = await sb.from("audit_logs").select("project_id,timestamp").eq("resource_type", "project_settings").eq("action", "update").order("timestamp", { ascending: false }).limit(500);
    return data || [];
  }, w, "modal_loop_detect");
  if (settingsAudits && (settingsAudits as unknown[]).length > 0) {
    const byProject: Record<string, string[]> = {};
    for (const r of settingsAudits as Record<string, unknown>[]) {
      const pid = String(r.project_id || "");
      if (!pid) continue;
      if (!byProject[pid]) byProject[pid] = [];
      byProject[pid].push(String(r.timestamp));
    }
    const loopProjects: string[] = [];
    for (const [pid, timestamps] of Object.entries(byProject)) {
      // Check for >=5 updates within 10 minutes
      timestamps.sort();
      for (let i = 0; i <= timestamps.length - 5; i++) {
        const span = new Date(timestamps[i + 4]).getTime() - new Date(timestamps[i]).getTime();
        if (span < 600000) { loopProjects.push(pid); break; }
      }
    }
    if (loopProjects.length) findings.push({ type: "MODAL_LOOP_SUSPECTED", description: ">=5 project_settings updates within 10min detected (possible modal loop)", project_ids: loopProjects });
  }

  return findings;
}

// ── PROJECT SAMPLING ──
async function selectProjectSamples(sb: SB, sinceISO: string, sampleSize: number, w: string[]): Promise<string[]> {
  // Gather activity scores
  const scores: Record<string, { activity: number; failure: number; lastAt: string }> = {};
  const bump = (pid: string, act: number, fail: number, ts?: string) => {
    if (!pid) return;
    if (!scores[pid]) scores[pid] = { activity: 0, failure: 0, lastAt: "" };
    scores[pid].activity += act;
    scores[pid].failure += fail;
    if (ts && ts > scores[pid].lastAt) scores[pid].lastAt = ts;
  };

  // Import jobs
  const ij = await safe(async () => {
    const { data } = await sb.from("import_jobs").select("project_id,status,created_at").gte("created_at", sinceISO).limit(1000);
    return data || [];
  }, w, "sample_imports");
  for (const r of (ij || []) as Record<string, unknown>[]) {
    const isFail = ["error", "failed"].includes(String(r.status));
    bump(String(r.project_id), 1, isFail ? 5 : 0, String(r.created_at));
  }

  // Scoring jobs
  const sj = await safe(async () => {
    const { data } = await sb.from("project_scoring_jobs").select("project_id,status,started_at").gte("started_at", sinceISO).limit(1000);
    return data || [];
  }, w, "sample_scoring");
  for (const r of (sj || []) as Record<string, unknown>[]) {
    const isFail = ["error", "failed"].includes(String(r.status));
    bump(String(r.project_id), 3, isFail ? 7 : 0, String(r.started_at));
  }

  // Models
  const md = await safe(async () => {
    const { data } = await sb.from("project_models").select("project_id,status,created_at").gte("created_at", sinceISO).limit(500);
    return data || [];
  }, w, "sample_models");
  for (const r of (md || []) as Record<string, unknown>[]) {
    const isFail = ["error", "failed"].includes(String(r.status));
    bump(String(r.project_id), 2, isFail ? 7 : 0, String(r.created_at));
  }

  // Monitoring states with issues
  const mon = await safeSelect(sb, "project_monitoring_state", "project_id,status,last_run_status", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (mon) {
    for (const r of mon) {
      if (["ALERT", "FAILED"].includes(String(r.last_run_status))) bump(String(r.project_id), 0, 10);
      else if (String(r.last_run_status) === "WARN") bump(String(r.project_id), 0, 3);
    }
  }

  const entries = Object.entries(scores);
  if (entries.length === 0) return [];

  // Top by activity
  const byActivity = [...entries].sort((a, b) => b[1].activity - a[1].activity).slice(0, 5).map(e => e[0]);
  // Top by failure
  const byFailure = [...entries].sort((a, b) => b[1].failure - a[1].failure).slice(0, 5).map(e => e[0]);
  // Most recent
  const byRecent = [...entries].sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt)).slice(0, 2).map(e => e[0]);

  const unique = [...new Set([...byActivity, ...byFailure, ...byRecent])];
  return unique.slice(0, sampleSize);
}

// ── BUILD PROJECT SAMPLE DETAIL ──
async function buildProjectSample(sb: SB, projectId: string, sinceISO: string, w: string[]) {
  // Project info
  const proj = await safeSelect(sb, "projects", "id,name,organization_id,status,created_at,updated_at", { id: projectId }, 1, undefined, false, w) as Record<string, unknown>[] | null;
  const projRow = proj?.[0] as Record<string, unknown> | undefined;

  // Settings
  const settingsArr = await safeSelect(sb, "project_settings", "*", { project_id: projectId }, 1, undefined, false, w) as Record<string, unknown>[] | null;
  const settings = settingsArr?.[0] as Record<string, unknown> | undefined;

  // Dataset state (SSOT)
  const dsArr = await safeSelect(sb, "project_dataset_state", "*", { project_id: projectId }, 1, undefined, false, w) as Record<string, unknown>[] | null;
  const ds = dsArr?.[0] as Record<string, unknown> | undefined;

  // Model selection
  const msArr = await safeSelect(sb, "project_model_selection", "*", { project_id: projectId }, 1, undefined, false, w) as Record<string, unknown>[] | null;
  const ms = msArr?.[0] as Record<string, unknown> | undefined;

  // Split policy
  const spArr = await safeSelect(sb, "project_split_policies", "*", { project_id: projectId }, 1, "created_at", false, w) as Record<string, unknown>[] | null;

  // Label builder
  const lbArr = await safeSelect(sb, "project_label_builders", "*", { project_id: projectId }, 1, "created_at", false, w) as Record<string, unknown>[] | null;

  // Contract audits
  const caArr = await safeSelect(sb, "project_contract_audits", "id,status,predictability_score,selection_version,created_at", { project_id: projectId }, 3, "created_at", false, w) as Record<string, unknown>[] | null;

  // Models
  const modelsArr = await safeSelect(sb, "project_models", "id,algorithm_name,status,is_production,trained_at,deployed_at,deployed_selection_version,created_at", { project_id: projectId }, 10, "created_at", false, w) as Record<string, unknown>[] | null;

  // Scoring jobs
  const sjArr = await safeSelect(sb, "project_scoring_jobs", "id,status,error_code,error_friendly,started_at,finished_at,rows_scored_total", { project_id: projectId }, 5, "started_at", false, w) as Record<string, unknown>[] | null;

  // Prediction state
  const psArr = await safeSelect(sb, "project_prediction_state", "*", { project_id: projectId }, 1, undefined, false, w) as Record<string, unknown>[] | null;

  // Monitoring state
  const monArr = await safeSelect(sb, "project_monitoring_state", "*", { project_id: projectId }, 1, undefined, false, w) as Record<string, unknown>[] | null;

  // Schedule runs
  const srArr = await safeSelect(sb, "project_schedule_runs", "id,status,blocked_reason_code,scheduled_at,finished_at", { project_id: projectId }, 5, "created_at", false, w) as Record<string, unknown>[] | null;

  // Import jobs
  const ijArr = await safeSelect(sb, "import_jobs", "id,status,error_message,file_name,created_at,finished_at", { project_id: projectId }, 5, "created_at", false, w) as Record<string, unknown>[] | null;

  // Ingestion logs
  const ilArr = await safeSelect(sb, "project_data_ingestion_logs", "id,status,error_message,started_at,completed_at", { project_id: projectId }, 5, "started_at", false, w) as Record<string, unknown>[] | null;

  // Exports
  const exArr = await safeSelect(sb, "project_exports", "id,status,export_type,created_at", { project_id: projectId }, 5, "created_at", false, w) as Record<string, unknown>[] | null;

  // EDA snapshot existence
  const edaArr = await safeSelect(sb, "project_eda_snapshots", "id,created_at", { project_id: projectId }, 1, "created_at", false, w) as Record<string, unknown>[] | null;

  // Deployments
  const depArr = await safeSelect(sb, "project_model_deployments", "id,model_id,status,selection_version,created_at", { project_id: projectId }, 3, "created_at", false, w) as Record<string, unknown>[] | null;

  // ── Compute blockers & detections ──
  const blockers: string[] = [];
  const timeoutsDetected: string[] = [];
  const retryLoopsDetected: string[] = [];
  const likelyRootCauses: string[] = [];

  // Timeout scan
  for (const r of (ijArr || []) as Record<string, unknown>[]) {
    if (isTimeout(r.error_message)) timeoutsDetected.push(`import_job ${r.id}`);
  }
  for (const r of (ilArr || []) as Record<string, unknown>[]) {
    if (isTimeout(r.error_message)) timeoutsDetected.push(`ingestion_log ${r.id}`);
  }

  // Blockers
  if (ds && !ds.eda_ready) blockers.push("EDA not ready");
  if (ds && !ds.model_ready) blockers.push("Model dataset not ready");
  if (settings?.target_source === "label_builder" && !settings?.label_build_result) blockers.push("Label builder result missing");
  if (psArr?.[0] && (psArr[0] as Record<string, unknown>).last_error_code) blockers.push(`Prediction error: ${(psArr[0] as Record<string, unknown>).last_error_code}`);
  if (monArr?.[0] && ["FAILED", "ALERT"].includes(String((monArr[0] as Record<string, unknown>).last_run_status))) blockers.push(`Monitoring: ${(monArr[0] as Record<string, unknown>).last_run_status}`);

  // Retry loops: multiple failed scoring jobs in a row
  if (sjArr && sjArr.length >= 3) {
    const failedConsecutive = (sjArr as Record<string, unknown>[]).filter(r => ["error", "failed"].includes(String(r.status)));
    if (failedConsecutive.length >= 3) retryLoopsDetected.push(`${failedConsecutive.length} consecutive scoring failures`);
  }

  // Root causes
  if (timeoutsDetected.length) likelyRootCauses.push("DB statement timeouts causing pipeline stalls");
  if (blockers.includes("Label builder result missing")) likelyRootCauses.push("Target definition incomplete (label_builder without result)");
  if (retryLoopsDetected.length) likelyRootCauses.push("Scoring retry loop — check model compatibility or data drift");

  // Determine last activity
  const timestamps = [
    projRow?.updated_at, ds?.updated_at, ms?.updated_at,
    ...(ijArr || []).map((r: Record<string, unknown>) => r.created_at),
    ...(sjArr || []).map((r: Record<string, unknown>) => r.started_at),
  ].filter(Boolean).map(String).sort().reverse();

  return {
    project_id: projectId,
    name: projRow?.name || null,
    industry: settings?.industry || null,
    last_activity_at: timestamps[0] || null,
    ssot_snapshot: {
      dataset_state: ds || null,
      model_selection: ms || null,
      settings_summary: settings ? {
        target_column: settings.target_column,
        problem_type: settings.problem_type,
        target_source: settings.target_source,
        entity_key: settings.entity_key,
        time_anchor_column: settings.time_anchor_column,
        value_column: settings.value_column,
        prerequisites_source: settings.prerequisites_source,
        prerequisites_resolved_at: settings.prerequisites_resolved_at,
        industry: settings.industry,
      } : null,
    },
    pipeline_trace: {
      ingestion: { latest_jobs: ijArr || [], ingestion_logs: ilArr || [] },
      eda: { has_snapshot: !!(edaArr && edaArr.length > 0), eda_ready: ds?.eda_ready ?? null },
      target: { target_column: settings?.target_column, target_source: settings?.target_source, label_build_result: settings?.label_build_result ? "present" : "absent" },
      split: spArr?.[0] || null,
      builder: lbArr?.[0] || null,
      training: { models: modelsArr || [], contract_audits: caArr || [] },
      deploy: { deployments: depArr || [], production_model_id: ds?.production_model_id || null },
      scoring: { jobs: sjArr || [], prediction_state: psArr?.[0] || null },
      dashboard: { has_predictions: !!(psArr?.[0] && (psArr[0] as Record<string, unknown>).predictions_count) },
      monitoring: monArr?.[0] || null,
      scheduling: { runs: srArr || [] },
    },
    blockers,
    timeouts_detected: timeoutsDetected,
    retry_loops_detected: retryLoopsDetected,
    likely_root_causes: likelyRootCauses,
  };
}

// ── BUSINESS RULES CATALOG ──
async function buildBusinessRulesCatalog(sb: SB, w: string[]) {
  const detected_rules: {
    rule_id: string; layer: string; source: string;
    description: string; dependent_fields: string[];
    expected_effect: string; risk_level: string;
  }[] = [];

  // Static map of known edge-function business rules
  const EDGE_RULES: { id: string; layer: string; fn: string; desc: string; deps: string[]; effect: string; risk: string }[] = [
    { id: "R_INGEST_SCHEMA_LOCK", layer: "ingestion", fn: "process-import", desc: "Schema locked after first successful import via project_data_contract", deps: ["project_data_contract.locked"], effect: "Rejects imports with incompatible schema", risk: "medium" },
    { id: "R_INGEST_DB_CONNECTOR", layer: "ingestion", fn: "ingest-database", desc: "Database connector validates connection before sampling rows", deps: ["data_sources.connection_config"], effect: "Blocks ingestion on connection failure", risk: "medium" },
    { id: "R_TARGET_FALLBACK", layer: "target", fn: "preview-target-template", desc: "Target resolution falls back from intent_contract → settings.target_column", deps: ["project_settings.target_source", "project_settings.target_column", "project_settings.active_intent_contract_id"], effect: "May use stale target if intent not linked", risk: "high" },
    { id: "R_SPLIT_TEMPORAL_NEEDS_ANCHOR", layer: "split", fn: "preview-split-policy", desc: "Temporal split strategy requires time_anchor_column", deps: ["project_split_policies.strategy", "project_split_policies.time_anchor_column"], effect: "Blocks split preview if missing", risk: "high" },
    { id: "R_BUILDER_VERSION_GATE", layer: "builder", fn: "build-modeling-dataset", desc: "Builder must match current selection_version", deps: ["project_label_builders.selection_version", "project_model_selection.selection_version"], effect: "Stale builder produces wrong dataset", risk: "high" },
    { id: "R_TRAIN_PREFLIGHT", layer: "training", fn: "run-training-preflight", desc: "Preflight checks contract audit, dataset readiness, and intent before training", deps: ["project_contract_audits.status", "project_dataset_state.model_ready", "project_settings.active_intent_contract_id"], effect: "Blocks training on BLOCK gates", risk: "high" },
    { id: "R_TRAIN_MODEL", layer: "training", fn: "train-models", desc: "Trains models using modeling dataset and selection_version", deps: ["project_model_selection.selection_version", "project_modeling_datasets"], effect: "Creates project_models entries", risk: "medium" },
    { id: "R_DEPLOY_VERSION_CHECK", layer: "deploy", fn: "deploy-model", desc: "Deploy validates model selection_version matches current", deps: ["project_models.deployed_selection_version", "project_model_selection.selection_version"], effect: "Rejects outdated model promotion", risk: "high" },
    { id: "R_SCORING_BATCH", layer: "scoring", fn: "run-batch-predictions", desc: "Batch scoring reads production_model_id from SSOT", deps: ["project_dataset_state.production_model_id", "project_prediction_state"], effect: "Scores with wrong model if SSOT stale", risk: "high" },
    { id: "R_SCHEDULE_GATE", layer: "scoring", fn: "run-scheduled-predictions", desc: "Scheduled predictions check for active schedule and production model", deps: ["project_schedules", "project_dataset_state.production_model_id"], effect: "Blocks scheduled run if no production model", risk: "medium" },
    { id: "R_RETENTION_POLICY", layer: "monitoring", fn: "enforce-data-retention", desc: "Enforces org data retention policy by deleting old records", deps: ["organization_data_policy.data_retention_months"], effect: "Deletes expired data", risk: "low" },
    { id: "R_AUDIT_LOG", layer: "monitoring", fn: "audit-log", desc: "Records all user actions with org/project context", deps: ["audit_logs"], effect: "Creates audit trail", risk: "low" },
  ];

  for (const r of EDGE_RULES) {
    detected_rules.push({
      rule_id: r.id, layer: r.layer, source: "edge_function",
      description: `[${r.fn}] ${r.desc}`, dependent_fields: r.deps,
      expected_effect: r.effect, risk_level: r.risk,
    });
  }

  // Detect gate rules from contract audits
  const audits = await safeSelect(sb, "project_contract_audits", "project_id,gates,status", {}, 100, "created_at", false, w) as Record<string, unknown>[] | null;
  if (audits) {
    const gateNames = new Set<string>();
    for (const a of audits) {
      const gates = a.gates;
      if (Array.isArray(gates)) {
        for (const g of gates as Record<string, unknown>[]) {
          const name = String(g.gate || g.name || g.check || "");
          if (name && !gateNames.has(name)) {
            gateNames.add(name);
            detected_rules.push({
              rule_id: `R_GATE_${name}`, layer: "training", source: "gate",
              description: `Contract audit gate: ${name}`, dependent_fields: ["project_contract_audits.gates"],
              expected_effect: `Blocks training when gate ${name} fails`, risk_level: "high",
            });
          }
        }
      }
    }
  }

  // Detect SSOT defaults from project_settings
  const allSettings = await safeSelect(sb, "project_settings", "project_id,target_source,prerequisites_source,industry_source", {}, 200, undefined, false, w) as Record<string, unknown>[] | null;
  const defaultPatterns: Record<string, number> = {};
  if (allSettings) {
    for (const s of allSettings) {
      for (const field of ["target_source", "prerequisites_source", "industry_source"]) {
        const val = s[field];
        if (val) {
          const key = `${field}=${val}`;
          defaultPatterns[key] = (defaultPatterns[key] || 0) + 1;
        }
      }
    }
    for (const [pattern, count] of Object.entries(defaultPatterns)) {
      if (count >= 3) {
        detected_rules.push({
          rule_id: `R_DEFAULT_${pattern.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`,
          layer: "target", source: "ssot",
          description: `Default pattern: ${pattern} found in ${count} projects`,
          dependent_fields: [pattern.split("=")[0]],
          expected_effect: "Implicit default may mask missing user configuration",
          risk_level: count > 10 ? "low" : "medium",
        });
      }
    }
  }

  // Redundancy findings
  const redundancy_findings: { type: string; description: string; evidence: string[] }[] = [];

  // Check for duplicate inference: multiple contract audits with same selection_version per project
  if (audits) {
    const byProjVer: Record<string, number> = {};
    for (const a of audits) {
      const key = `${a.project_id}:${(a as Record<string, unknown>).selection_version ?? "?"}`;
      byProjVer[key] = (byProjVer[key] || 0) + 1;
    }
    const dups = Object.entries(byProjVer).filter(([, c]) => c > 1);
    if (dups.length) {
      redundancy_findings.push({
        type: "duplicate_inference_call",
        description: "Multiple contract audits exist for the same project+selection_version",
        evidence: dups.map(([k, c]) => `${k} (${c}x)`),
      });
    }
  }

  // Check for gate overlap: split_policy + contract_audit both checking time_anchor
  if (audits) {
    const splitGateProjects: string[] = [];
    for (const a of audits) {
      const gates = a.gates;
      if (Array.isArray(gates)) {
        for (const g of gates as Record<string, unknown>[]) {
          const name = String(g.gate || g.name || "").toLowerCase();
          if (name.includes("time") || name.includes("temporal") || name.includes("anchor")) {
            splitGateProjects.push(String(a.project_id));
          }
        }
      }
    }
    if (splitGateProjects.length) {
      redundancy_findings.push({
        type: "multiple_gate_overlap",
        description: "Contract audit gates overlap with split_policy temporal validation",
        evidence: [...new Set(splitGateProjects)],
      });
    }
  }

  return { detected_rules, redundancy_findings };
}

// ── RULE OUTCOME DIFF ──
async function buildRuleOutcomeDiff(sb: SB, sinceISO: string, w: string[]) {
  const diffs: {
    rule_id: string; expected_behavior: string; observed_behavior: string;
    mismatch_detected: boolean; affected_projects: string[];
  }[] = [];

  // Reuse data we know how to query (avoid re-fetching what buildInconsistencies does—
  // but this is a separate layer so we query independently for isolation)

  // 1) Split temporal without time_anchor
  const splits = await safeSelect(sb, "project_split_policies", "project_id,strategy,time_anchor_column", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (splits) {
    const bad = splits.filter(r => r.strategy === "temporal" && !r.time_anchor_column).map(r => String(r.project_id));
    diffs.push({
      rule_id: "R_SPLIT_TEMPORAL_NEEDS_ANCHOR",
      expected_behavior: "Temporal split requires time_anchor_column to be set",
      observed_behavior: bad.length ? `${bad.length} projects have temporal split without time_anchor_column` : "All temporal splits have time_anchor_column",
      mismatch_detected: bad.length > 0,
      affected_projects: bad,
    });
  }

  // 2) Label builder without result
  const settings = await safeSelect(sb, "project_settings", "project_id,target_source,label_build_result", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (settings) {
    const bad = settings.filter(r => r.target_source === "label_builder" && (!r.label_build_result || (typeof r.label_build_result === "object" && Object.keys(r.label_build_result as object).length === 0))).map(r => String(r.project_id));
    diffs.push({
      rule_id: "R_TARGET_FALLBACK",
      expected_behavior: "target_source=label_builder implies label_build_result is populated",
      observed_behavior: bad.length ? `${bad.length} projects missing label_build_result` : "All label_builder projects have results",
      mismatch_detected: bad.length > 0,
      affected_projects: bad,
    });
  }

  // 3) Builder version mismatch
  const builders = await safeSelect(sb, "project_label_builders", "project_id,selection_version", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  const selections = await safeSelect(sb, "project_model_selection", "project_id,selection_version", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (builders && selections) {
    const selMap = new Map((selections as Record<string, unknown>[]).map(r => [r.project_id, r.selection_version]));
    const bad = builders.filter(r => { const c = selMap.get(r.project_id); return c != null && r.selection_version != null && c !== r.selection_version; }).map(r => String(r.project_id));
    diffs.push({
      rule_id: "R_BUILDER_VERSION_GATE",
      expected_behavior: "Builder selection_version must match model_selection.selection_version",
      observed_behavior: bad.length ? `${bad.length} projects have version mismatch` : "All builder versions aligned",
      mismatch_detected: bad.length > 0,
      affected_projects: [...new Set(bad)],
    });
  }

  // 4) Deploy gate: production_model_id set but last deploy failed
  const deploys = await safeSelect(sb, "project_model_deployments", "project_id,model_id,status", {}, 200, "created_at", false, w) as Record<string, unknown>[] | null;
  const dsStates = await safeSelect(sb, "project_dataset_state", "project_id,production_model_id", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (deploys && dsStates) {
    const prodMap = new Map((dsStates as Record<string, unknown>[]).map(r => [r.project_id, r.production_model_id]));
    const failedProd = deploys.filter(r => (r.status === "failed" || r.status === "error") && prodMap.get(r.project_id) === r.model_id).map(r => String(r.project_id));
    diffs.push({
      rule_id: "R_DEPLOY_VERSION_CHECK",
      expected_behavior: "production_model_id should only point to successfully deployed models",
      observed_behavior: failedProd.length ? `${failedProd.length} projects have production model from failed deployment` : "All production models deployed successfully",
      mismatch_detected: failedProd.length > 0,
      affected_projects: failedProd,
    });
  }

  // 5) Prediction state: batch_id but count=0
  const predStates = await safeSelect(sb, "project_prediction_state", "project_id,latest_batch_id,predictions_count", {}, 500, undefined, false, w) as Record<string, unknown>[] | null;
  if (predStates) {
    const bad = predStates.filter(r => r.latest_batch_id && (r.predictions_count === 0 || r.predictions_count === null)).map(r => String(r.project_id));
    diffs.push({
      rule_id: "R_SCORING_BATCH",
      expected_behavior: "latest_batch_id implies predictions_count > 0",
      observed_behavior: bad.length ? `${bad.length} projects have batch_id with zero predictions` : "All batches have predictions",
      mismatch_detected: bad.length > 0,
      affected_projects: bad,
    });
  }

  // 6) Duplicate inference: multiple contract audits same selection_version
  const audits = await safeSelect(sb, "project_contract_audits", "project_id,selection_version", {}, 300, undefined, false, w) as Record<string, unknown>[] | null;
  if (audits) {
    const byPV: Record<string, number> = {};
    for (const a of audits) byPV[`${a.project_id}:${a.selection_version}`] = (byPV[`${a.project_id}:${a.selection_version}`] || 0) + 1;
    const bad = Object.entries(byPV).filter(([, c]) => c > 1).map(([k]) => k.split(":")[0]);
    diffs.push({
      rule_id: "R_TRAIN_PREFLIGHT",
      expected_behavior: "One contract audit per selection_version per project",
      observed_behavior: bad.length ? `${bad.length} projects have duplicate audits for same version` : "No duplicate inference",
      mismatch_detected: bad.length > 0,
      affected_projects: [...new Set(bad)],
    });
  }

  // 7) Modal loop: rapid project_settings updates
  const settingsAudits = await safe(async () => {
    const { data } = await sb.from("audit_logs").select("project_id,timestamp").eq("resource_type", "project_settings").eq("action", "update").gte("timestamp", sinceISO).order("timestamp", { ascending: false }).limit(500);
    return data || [];
  }, w, "rod_modal_loop");
  if (settingsAudits && (settingsAudits as unknown[]).length > 0) {
    const byProject: Record<string, string[]> = {};
    for (const r of settingsAudits as Record<string, unknown>[]) {
      const pid = String(r.project_id || ""); if (!pid) continue;
      if (!byProject[pid]) byProject[pid] = [];
      byProject[pid].push(String(r.timestamp));
    }
    const loopPids: string[] = [];
    for (const [pid, ts] of Object.entries(byProject)) {
      ts.sort();
      for (let i = 0; i <= ts.length - 5; i++) {
        if (new Date(ts[i + 4]).getTime() - new Date(ts[i]).getTime() < 600000) { loopPids.push(pid); break; }
      }
    }
    diffs.push({
      rule_id: "R_AUDIT_LOG",
      expected_behavior: "Settings updates should be intentional (not rapid-fire loops)",
      observed_behavior: loopPids.length ? `${loopPids.length} projects show >=5 updates within 10min` : "No modal loop patterns detected",
      mismatch_detected: loopPids.length > 0,
      affected_projects: loopPids,
    });
  }

  return diffs;
}

// ── FLOW TRACE RECONSTRUCTION ──
async function buildFlowTraces(sb: SB, projectIds: string[], sinceISO: string, w: string[]) {
  const reconstructed_flows: {
    project_id: string;
    step_sequence: { step: string; at: string | null }[];
    anomalies: string[];
  }[] = [];

  for (const pid of projectIds) {
    const steps: { step: string; at: string | null }[] = [];
    const anomalies: string[] = [];

    // Ingestion: earliest import_job
    const ij = await safeSelect(sb, "import_jobs", "created_at", { project_id: pid }, 1, "created_at", true, w) as Record<string, unknown>[] | null;
    const ingestionAt = ij?.[0]?.created_at ? String(ij[0].created_at) : null;
    steps.push({ step: "ingestion", at: ingestionAt });

    // EDA: earliest eda_snapshot
    const eda = await safeSelect(sb, "project_eda_snapshots", "created_at", { project_id: pid }, 1, "created_at", true, w) as Record<string, unknown>[] | null;
    steps.push({ step: "eda", at: eda?.[0]?.created_at ? String(eda[0].created_at) : null });

    // Target: project_settings updated_at (proxy)
    const ps = await safeSelect(sb, "project_settings", "updated_at,target_column", { project_id: pid }, 1, undefined, false, w) as Record<string, unknown>[] | null;
    const targetAt = ps?.[0]?.target_column ? String(ps[0].updated_at) : null;
    steps.push({ step: "target", at: targetAt });

    // Split: earliest split_policy
    const sp = await safeSelect(sb, "project_split_policies", "created_at", { project_id: pid }, 1, "created_at", true, w) as Record<string, unknown>[] | null;
    steps.push({ step: "split", at: sp?.[0]?.created_at ? String(sp[0].created_at) : null });

    // Builder: earliest label_builder
    const lb = await safeSelect(sb, "project_label_builders", "created_at", { project_id: pid }, 1, "created_at", true, w) as Record<string, unknown>[] | null;
    const builderAt = lb?.[0]?.created_at ? String(lb[0].created_at) : null;
    steps.push({ step: "builder", at: builderAt });

    // Training: earliest model
    const md = await safeSelect(sb, "project_models", "created_at,trained_at", { project_id: pid }, 1, "created_at", true, w) as Record<string, unknown>[] | null;
    const trainingAt = md?.[0]?.created_at ? String(md[0].created_at) : null;
    steps.push({ step: "training", at: trainingAt });

    // Deploy: earliest deployment
    const dp = await safeSelect(sb, "project_model_deployments", "created_at", { project_id: pid }, 1, "created_at", true, w) as Record<string, unknown>[] | null;
    const deployAt = dp?.[0]?.created_at ? String(dp[0].created_at) : null;
    steps.push({ step: "deploy", at: deployAt });

    // Scoring: earliest scoring_job
    const sj = await safeSelect(sb, "project_scoring_jobs", "started_at", { project_id: pid }, 1, "started_at", true, w) as Record<string, unknown>[] | null;
    const scoringAt = sj?.[0]?.started_at ? String(sj[0].started_at) : null;
    steps.push({ step: "scoring", at: scoringAt });

    // ── Anomaly detection ──
    // Training without builder
    if (trainingAt && !builderAt) anomalies.push("training_called_without_builder");

    // Scoring before deploy
    if (scoringAt && deployAt && scoringAt < deployAt) anomalies.push("scoring_before_deploy");

    // Duplicate inference: multiple contract audits same version
    const ca = await safeSelect(sb, "project_contract_audits", "selection_version", { project_id: pid }, 20, undefined, false, w) as Record<string, unknown>[] | null;
    if (ca) {
      const vers = (ca as Record<string, unknown>[]).map(r => r.selection_version);
      const seen = new Set<unknown>();
      for (const v of vers) { if (seen.has(v)) { anomalies.push("duplicate_inference"); break; } seen.add(v); }
    }

    // Loop detection: multiple scoring failures
    const sjAll = await safeSelect(sb, "project_scoring_jobs", "status", { project_id: pid }, 10, "started_at", false, w) as Record<string, unknown>[] | null;
    if (sjAll) {
      let consecutive = 0;
      for (const r of sjAll as Record<string, unknown>[]) {
        if (["error", "failed"].includes(String(r.status))) consecutive++; else consecutive = 0;
        if (consecutive >= 3) { anomalies.push("loop_detected"); break; }
      }
    }

    reconstructed_flows.push({ project_id: pid, step_sequence: steps, anomalies });
  }

  return { reconstructed_flows };
}

// ── MAIN ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const sampleSize = Math.min(Math.max(body.sample_size ?? 12, 1), 30);
    const days = Math.min(Math.max(body.days ?? 7, 1), 90);
    const sinceISO = new Date(Date.now() - days * 86400000).toISOString();
    const w: string[] = [];

    console.log(`[platform-audit-az] v4.1 days=${days} sample_size=${sampleSize}`);

    // Build core sections in parallel
    const [platformSummary, topErrors, perfHotspots, inconsistencies, businessRules, ruleOutcomeDiff] = await Promise.all([
      buildPlatformSummary(sb, sinceISO, w),
      buildTopErrors(sb, sinceISO, w),
      buildPerformanceHotspots(sb, sinceISO, w),
      buildInconsistencies(sb, w),
      buildBusinessRulesCatalog(sb, w),
      buildRuleOutcomeDiff(sb, sinceISO, w),
    ]);

    // Select project samples
    const sampleIds = await selectProjectSamples(sb, sinceISO, sampleSize, w);

    // Build project details + flow traces (sequential to avoid overloading DB)
    const projectSamples: unknown[] = [];
    for (const pid of sampleIds) {
      projectSamples.push(await buildProjectSample(sb, pid, sinceISO, w));
    }

    // Flow trace reconstruction for sampled projects
    const flowTraces = await buildFlowTraces(sb, sampleIds, sinceISO, w);

    const result = stripPII({
      version: "platform-audit-az-v4.1",
      generated_at: new Date().toISOString(),
      params: { days, sample_size: sampleSize },
      warnings: w,
      platform_summary: platformSummary,
      top_error_signatures: topErrors,
      performance_hotspots: perfHotspots,
      inconsistency_findings: inconsistencies,
      business_rules_catalog: businessRules,
      rule_outcome_diff: ruleOutcomeDiff,
      flow_trace_reconstruction: flowTraces,
      project_samples: projectSamples,
    });

    const url = new URL(req.url);
    const headers: Record<string, string> = { ...corsHeaders, "Content-Type": "application/json" };
    if (url.searchParams.get("download") === "1") {
      headers["Content-Disposition"] = "attachment; filename=platform_audit_az.json";
    }

    return new Response(JSON.stringify(result, null, 2), { headers });
  } catch (err) {
    console.error("[platform-audit-az] Fatal:", err);
    return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
