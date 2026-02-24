import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveActiveTarget, buildTrainabilityReport, type ActiveTargetResolution, type TargetVectorStats } from "../_shared/resolve-active-target.ts";

Deno.test("resolveActiveTarget: human mode returns correct resolution", () => {
  const settings = {
    active_target_mode: "human",
    active_target_column: null,
    active_target_ref: { human_label_result_id: "round_1" },
  };
  const result = resolveActiveTarget(settings);
  assertEquals(result.mode, "human");
  assertEquals(result.column, null);
  assertEquals(result.target_source, "human_labeling");
});

Deno.test("resolveActiveTarget: column mode returns target_column", () => {
  const settings = {
    active_target_mode: "column",
    active_target_column: "churn_flag",
    active_target_ref: null,
  };
  const result = resolveActiveTarget(settings);
  assertEquals(result.mode, "column");
  assertEquals(result.column, "churn_flag");
  assertEquals(result.target_source, "manual");
});

Deno.test("resolveActiveTarget: template mode returns label_builder", () => {
  const settings = {
    active_target_mode: "template",
    active_target_column: "_label_",
    active_target_ref: { label_builder_id: "tpl_123" },
  };
  const result = resolveActiveTarget(settings);
  assertEquals(result.mode, "template");
  assertEquals(result.column, "_label_");
  assertEquals(result.target_source, "label_builder");
});

Deno.test("resolveActiveTarget: defaults to column when no mode set", () => {
  const settings = {};
  const result = resolveActiveTarget(settings);
  assertEquals(result.mode, "column");
  assertEquals(result.target_source, "manual");
});

Deno.test("buildTrainabilityReport: OK stats produce trainable=true", () => {
  const resolution: ActiveTargetResolution = {
    mode: "human", column: null, ref: null, target_source: "human_labeling",
  };
  const stats: TargetVectorStats = {
    join_rows: 100, distinct_y: 2, pos: 60, neg: 40,
    values: [], reason_code: null, error_message: null,
  };
  const report = buildTrainabilityReport(resolution, stats);
  assertEquals(report.trainable, true);
  assertEquals(report.active_target_mode, "human");
  assertEquals((report.reason_codes as string[]).length, 0);
});

Deno.test("buildTrainabilityReport: ONLY_ONE_CLASS produces trainable=false", () => {
  const resolution: ActiveTargetResolution = {
    mode: "human", column: null, ref: null, target_source: "human_labeling",
  };
  const stats: TargetVectorStats = {
    join_rows: 50, distinct_y: 1, pos: 50, neg: 0,
    values: [], reason_code: "ONLY_ONE_CLASS", error_message: "Only one class",
  };
  const report = buildTrainabilityReport(resolution, stats);
  assertEquals(report.trainable, false);
  assertEquals((report.reason_codes as string[])[0], "ONLY_ONE_CLASS");
});

Deno.test("buildTrainabilityReport: empty join produces trainable=false", () => {
  const resolution: ActiveTargetResolution = {
    mode: "human", column: null, ref: null, target_source: "human_labeling",
  };
  const stats: TargetVectorStats = {
    join_rows: 0, distinct_y: 0, pos: 0, neg: 0,
    values: [], reason_code: "HUMAN_LABEL_JOIN_EMPTY", error_message: "No labels",
  };
  const report = buildTrainabilityReport(resolution, stats);
  assertEquals(report.trainable, false);
});
