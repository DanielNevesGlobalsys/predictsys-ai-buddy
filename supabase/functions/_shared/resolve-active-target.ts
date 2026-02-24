/**
 * resolve-active-target.ts
 * 
 * Canonical shared utility for resolving the active target mode.
 * Used by BOTH run-training-preflight AND train-models to ensure
 * deterministic, identical target resolution from the SSOT.
 * 
 * RULE: When active_target_mode='human', target_column is IGNORED.
 */

export interface ActiveTargetResolution {
  mode: "column" | "template" | "human" | "weak";
  column: string | null;       // The physical column name (null for human/weak)
  ref: Record<string, unknown> | null;
  target_source: string;       // Compat field for evaluateTargetTrainability
}

export interface TargetVectorStats {
  join_rows: number;
  distinct_y: number;
  pos: number;
  neg: number;
  values: number[];            // The actual y vector (numeric)
  reason_code: string | null;  // null = OK, otherwise error code
  error_message: string | null;
}

/**
 * Resolve the active target from project_settings SSOT.
 * Pure function — no DB calls.
 */
export function resolveActiveTarget(settings: Record<string, any>): ActiveTargetResolution {
  const mode = (settings.active_target_mode as string) || "column";
  const column = settings.active_target_column as string | null;
  const ref = settings.active_target_ref as Record<string, unknown> | null;

  // Compat: derive target_source for evaluateTargetTrainability
  const targetSourceMap: Record<string, string> = {
    column: "manual",
    template: "label_builder",
    human: "human_labeling",
    weak: "weak_supervision",
  };

  return {
    mode: mode as ActiveTargetResolution["mode"],
    column: mode === "human" ? null : column,
    ref,
    target_source: targetSourceMap[mode] || "manual",
  };
}

/**
 * Build target vector statistics from human labels.
 * Queries project_human_labels and computes pos/neg/distinct.
 */
export async function buildHumanTargetStats(
  supabase: any,
  projectId: string,
): Promise<TargetVectorStats> {
  // Fetch all human labels for this project
  const { data: labels, error } = await supabase
    .from("project_human_labels")
    .select("entity_id, label, label_status")
    .eq("project_id", projectId)
    .neq("label_status", "unsure");

  if (error) {
    return {
      join_rows: 0, distinct_y: 0, pos: 0, neg: 0,
      values: [],
      reason_code: "HUMAN_LABEL_QUERY_ERROR",
      error_message: error.message,
    };
  }

  if (!labels || labels.length === 0) {
    return {
      join_rows: 0, distinct_y: 0, pos: 0, neg: 0,
      values: [],
      reason_code: "HUMAN_LABEL_JOIN_EMPTY",
      error_message: "Nenhum rótulo humano encontrado. Gere amostras e rotule entidades.",
    };
  }

  const values = labels.map((l: any) => (l.label as number));
  const pos = values.filter((v: number) => v === 1).length;
  const neg = values.filter((v: number) => v === 0).length;
  const distinct_y = new Set(values).size;

  let reason_code: string | null = null;
  let error_message: string | null = null;

  if (distinct_y === 1) {
    const onlyClass = pos > 0 ? "positivos" : "negativos";
    reason_code = "ONLY_ONE_CLASS";
    error_message = `Apenas uma classe rotulada (somente ${onlyClass}). Rotule exemplos da classe oposta.`;
  }

  return {
    join_rows: labels.length,
    distinct_y,
    pos,
    neg,
    values,
    reason_code,
    error_message,
  };
}

/**
 * Build a trainability report for the SSOT.
 * Includes active_target_mode and class distribution.
 */
export function buildTrainabilityReport(
  resolution: ActiveTargetResolution,
  stats: TargetVectorStats,
): Record<string, unknown> {
  return {
    active_target_mode: resolution.mode,
    pos: stats.pos,
    neg: stats.neg,
    distinct_y: stats.distinct_y,
    join_rows: stats.join_rows,
    reason_codes: stats.reason_code ? [stats.reason_code] : [],
    trainable: stats.reason_code === null && stats.distinct_y >= 2 && stats.join_rows > 0,
    evaluated_at: new Date().toISOString(),
  };
}
