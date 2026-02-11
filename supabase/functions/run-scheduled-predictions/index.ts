import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Compute next_run_at in UTC based on schedule config.
 * Uses timezone-aware Date math via Intl for DST safety.
 */
function computeNextRunAt(
  scheduleType: string,
  hour: number,
  minute: number,
  timezone: string,
  intervalHours: number | null,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
): string {
  const now = new Date();

  if (scheduleType === "interval_hours" && intervalHours) {
    return new Date(now.getTime() + intervalHours * 3600_000).toISOString();
  }

  // Build target date in the schedule's timezone
  // Start from "today at HH:MM in tz", then advance if needed
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map(p => [p.type, p.value])
  );

  // Create a date string in the target timezone then parse
  const todayStr = `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  
  // Use a simple approach: set UTC time then adjust
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  switch (scheduleType) {
    case "daily":
      // Already set to next occurrence
      break;
    case "weekly":
      while (next.getUTCDay() !== (dayOfWeek ?? 1)) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      break;
    case "monthly":
      next.setUTCDate(dayOfMonth ?? 1);
      if (next <= now) next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }

  return next.toISOString();
}

/**
 * Read SSOT gates for a project. Returns { allowed, reasons[] }.
 */
async function checkSSOTGates(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
): Promise<{ allowed: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  // 1) project_dataset_state
  const { data: dsState } = await supabase
    .from("project_dataset_state")
    .select("production_model_id, model_ready")
    .eq("project_id", projectId)
    .maybeSingle();

  const prodModelId = dsState?.production_model_id;
  if (!prodModelId) {
    reasons.push("NO_PRODUCTION_MODEL");
    return { allowed: false, reasons };
  }

  // 2) production model quality
  const { data: model } = await supabase
    .from("project_models")
    .select("hyperparameters, deployed_selection_version")
    .eq("id", prodModelId)
    .maybeSingle();

  const hp = (model?.hyperparameters as Record<string, any>) || {};
  if (hp.dashboard_allowed === false) {
    reasons.push("DASHBOARD_NOT_ALLOWED");
  }
  if (hp.model_quality_flag && hp.model_quality_flag !== "ok" && hp.model_quality_flag !== "pass") {
    reasons.push("MODEL_QUALITY_FAIL");
  }

  // 3) selection_version mismatch
  const { data: sel } = await supabase
    .from("project_model_selection")
    .select("selection_version")
    .eq("project_id", projectId)
    .maybeSingle();

  if (sel && model?.deployed_selection_version != null) {
    if (sel.selection_version !== model.deployed_selection_version) {
      reasons.push("SELECTION_VERSION_MISMATCH");
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log("[run-scheduled-predictions] Starting scheduler tick");

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date().toISOString();

    // 1) Find enabled schedules due for execution
    const { data: dueSchedules, error: fetchError } = await supabase
      .from("project_schedules")
      .select("*")
      .eq("is_enabled", true)
      .lte("next_run_at", now);

    if (fetchError) {
      console.error("[scheduler] Fetch error:", fetchError);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!dueSchedules?.length) {
      console.log("[scheduler] No schedules due");
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[scheduler] ${dueSchedules.length} schedule(s) due`);
    const results: any[] = [];

    for (const schedule of dueSchedules) {
      const projectId = schedule.project_id;

      // 2) Idempotency: skip if a RUNNING run exists in last 30 min
      const { data: runningRuns } = await supabase
        .from("project_schedule_runs")
        .select("id")
        .eq("project_id", projectId)
        .eq("status", "RUNNING")
        .gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString())
        .limit(1);

      if (runningRuns?.length) {
        console.log(`[scheduler] Skipping ${projectId} — RUNNING run exists`);
        results.push({ project_id: projectId, skipped: true, reason: "RUNNING_EXISTS" });
        continue;
      }

      // 3) Create schedule_run record
      const { data: run } = await supabase
        .from("project_schedule_runs")
        .insert({
          project_id: projectId,
          scheduled_at: schedule.next_run_at,
          started_at: new Date().toISOString(),
          status: "RUNNING",
        })
        .select("id")
        .single();

      const runId = run?.id;

      // 4) Check SSOT gates
      const gates = await checkSSOTGates(supabase, projectId);

      if (!gates.allowed) {
        console.log(`[scheduler] ${projectId} BLOCKED: ${gates.reasons.join(", ")}`);

        // Mark run as BLOCKED
        await supabase
          .from("project_schedule_runs")
          .update({
            status: "BLOCKED",
            finished_at: new Date().toISOString(),
            blocked_reason_code: gates.reasons.join(", "),
            diagnostics: { gates: gates.reasons, timestamp: new Date().toISOString() },
          })
          .eq("id", runId);

        // If pause_on_blocked, disable schedule
        if (schedule.pause_on_blocked) {
          await supabase
            .from("project_schedules")
            .update({
              is_enabled: false,
              last_run_at: new Date().toISOString(),
            })
            .eq("project_id", projectId);

          console.log(`[scheduler] ${projectId} schedule PAUSED due to blocked gates`);
        }

        // Still compute next_run_at for when user re-enables
        const nextRun = computeNextRunAt(
          schedule.schedule_type, schedule.hour, schedule.minute,
          schedule.timezone, schedule.interval_hours,
          schedule.day_of_week, schedule.day_of_month,
        );
        await supabase
          .from("project_schedules")
          .update({ next_run_at: nextRun, last_run_at: new Date().toISOString() })
          .eq("project_id", projectId);

        results.push({ project_id: projectId, status: "BLOCKED", reasons: gates.reasons });
        continue;
      }

      // 5) Gates passed — call run-batch-predictions (scoring only)
      try {
        console.log(`[scheduler] ${projectId} — calling run-batch-predictions`);

        const scoringResp = await fetch(`${supabaseUrl}/functions/v1/run-batch-predictions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            project_id: projectId,
            trigger: "schedule",
            mode: schedule.mode,
          }),
        });

        const scoringResult = await scoringResp.json();

        if (!scoringResp.ok || scoringResult.error) {
          throw new Error(scoringResult.error || `HTTP ${scoringResp.status}`);
        }

        // Mark run as DONE
        await supabase
          .from("project_schedule_runs")
          .update({
            status: "DONE",
            finished_at: new Date().toISOString(),
            scoring_job_id: scoringResult.scoring_job_id || null,
            diagnostics: {
              predictions_count: scoringResult.predictions_count || 0,
              coverage_pct: scoringResult.coverage_pct || 0,
              batch_id: scoringResult.batch_id || null,
            },
          })
          .eq("id", runId);

        results.push({ project_id: projectId, status: "DONE" });

      } catch (scoringErr) {
        const errMsg = scoringErr instanceof Error ? scoringErr.message : "Unknown scoring error";
        console.error(`[scheduler] ${projectId} scoring ERROR:`, errMsg);

        await supabase
          .from("project_schedule_runs")
          .update({
            status: "ERROR",
            finished_at: new Date().toISOString(),
            diagnostics: { error: errMsg },
          })
          .eq("id", runId);

        results.push({ project_id: projectId, status: "ERROR", error: errMsg });
      }

      // 6) Update next_run_at and last_run_at
      const nextRun = computeNextRunAt(
        schedule.schedule_type, schedule.hour, schedule.minute,
        schedule.timezone, schedule.interval_hours,
        schedule.day_of_week, schedule.day_of_month,
      );
      await supabase
        .from("project_schedules")
        .update({ next_run_at: nextRun, last_run_at: new Date().toISOString() })
        .eq("project_id", projectId);
    }

    const duration = Date.now() - startTime;
    console.log(`[scheduler] Done in ${duration}ms, processed ${results.length}`);

    return new Response(JSON.stringify({ processed: results.length, duration_ms: duration, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[scheduler] Fatal:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
