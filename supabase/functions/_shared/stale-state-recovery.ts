/**
 * stale-state-recovery.ts
 * 
 * Auto-recovery for pipeline stages stuck in "running" for too long.
 * MVP-Soft: detects stale states and resets to "failed" with observability.
 */

const STALE_THRESHOLD_MINUTES = 30;

interface StaleRecoveryResult {
  recovered: boolean;
  stage: string;
  prev_state: string;
  minutes_stale: number;
}

/**
 * Checks if a specific pipeline stage is stale (running > 30min)
 * and resets it to "failed" if so.
 */
export async function recoverStaleState(
  supabase: any,
  projectId: string,
  stage: string,
): Promise<StaleRecoveryResult | null> {
  const stateCol = `${stage}_state`;

  const { data: settings } = await supabase
    .from("project_settings")
    .select(`${stateCol}, updated_at`)
    .eq("project_id", projectId)
    .maybeSingle();

  if (!settings) return null;

  const currentState = (settings as any)[stateCol];
  if (currentState !== "running") return null;

  const updatedAt = new Date((settings as any).updated_at);
  const minutesStale = (Date.now() - updatedAt.getTime()) / 60_000;

  if (minutesStale < STALE_THRESHOLD_MINUTES) return null;

  // Reset to failed
  try {
    await supabase.rpc("rpc_set_pipeline_state", {
      p_project_id: projectId,
      p_stage: stage,
      p_state: "failed",
      p_meta: {
        auto_recovery: true,
        prev_state: "running",
        minutes_stale: Math.round(minutesStale),
        recovered_at: new Date().toISOString(),
      },
    });
  } catch {
    // Fallback: direct update
    await supabase
      .from("project_settings")
      .update({ [stateCol]: "failed", updated_at: new Date().toISOString() })
      .eq("project_id", projectId);
  }

  // Log event
  await supabase.from("platform_events").insert({
    event_type: "pipeline_stale_recovered",
    project_id: projectId,
    status: "warning",
    source: "edge",
    metadata: {
      stage,
      prev_state: "running",
      minutes_stale: Math.round(minutesStale),
    },
  });

  console.log(`[stale-recovery] Recovered ${stage} for ${projectId} after ${Math.round(minutesStale)}min`);

  return {
    recovered: true,
    stage,
    prev_state: "running",
    minutes_stale: Math.round(minutesStale),
  };
}

/**
 * Checks all pipeline stages for staleness.
 * Returns list of recovered stages.
 */
export async function recoverAllStaleStates(
  supabase: any,
  projectId: string,
): Promise<StaleRecoveryResult[]> {
  const stages = ["builder", "training", "scoring", "dashboard"];
  const results: StaleRecoveryResult[] = [];

  for (const stage of stages) {
    const result = await recoverStaleState(supabase, projectId, stage);
    if (result) results.push(result);
  }

  return results;
}
