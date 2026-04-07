/**
 * LIS AI OS — Rollout Hook
 * Provides rollout state, visibility, and stage resolution to components.
 */

import { useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { LisAgentExecution } from "@/types/lisAgents";
import {
  getLisRolloutConfig,
  resolveStageFlag,
  isStageEnabled,
  getStageMode,
  getVisibilityPolicy,
  isAgentEnabledForStage,
  evaluatePhaseReadiness,
  createEmptyRolloutReport,
  type RolloutConfig,
  type RolloutPhase,
  type RolloutReport,
  type UserVisibility,
  type VisibilityPolicy,
  type StageFlag,
} from "@/lib/lisRollout";

interface UseLisRolloutOptions {
  organizationId?: string;
  projectId?: string;
  userRole?: UserVisibility;
}

export function useLisRollout({
  organizationId,
  projectId,
  userRole = "standard",
}: UseLisRolloutOptions = {}) {
  const [report, setReport] = useState<RolloutReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const config: RolloutConfig = useMemo(() => getLisRolloutConfig(), []);
  const visibility: VisibilityPolicy = useMemo(() => getVisibilityPolicy(userRole), [userRole]);

  const checkStage = useCallback(
    (stage: string): StageFlag | null => resolveStageFlag(stage, organizationId, projectId),
    [organizationId, projectId],
  );

  const isEnabled = useCallback(
    (stage: string): boolean => isStageEnabled(stage, organizationId, projectId),
    [organizationId, projectId],
  );

  const stageMode = useCallback(
    (stage: string) => getStageMode(stage, organizationId, projectId),
    [organizationId, projectId],
  );

  const isAgentActive = useCallback(
    (stage: string, agent: string): boolean =>
      isAgentEnabledForStage(stage, agent, organizationId, projectId),
    [organizationId, projectId],
  );

  /** Build rollout report from persisted executions */
  const buildReport = useCallback(async (): Promise<RolloutReport> => {
    setReportLoading(true);
    try {
      const emptyReport = createEmptyRolloutReport(organizationId);

      let query = supabase
        .from("lis_agent_executions" as any)
        .select("agent_name, stage, execution_mode, status, confidence, created_at")
        .order("created_at", { ascending: false })
        .limit(500);

      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      const { data, error } = await query;
      if (error || !data) {
        setReport(emptyReport);
        return emptyReport;
      }

      const executions = data as unknown as LisAgentExecution[];
      const agentsSet = new Set<string>();
      const stagesSet = new Set<string>();
      const counts: Record<string, number> = {};
      let blocks = 0;

      for (const exec of executions) {
        agentsSet.add(exec.agent_name);
        stagesSet.add(exec.stage);
        counts[exec.agent_name] = (counts[exec.agent_name] || 0) + 1;
        if (exec.status === "blocked") blocks++;
      }

      const result: RolloutReport = {
        ...emptyReport,
        projects_monitored: projectId ? 1 : executions.length,
        agents_active: Array.from(agentsSet),
        stages_active: Array.from(stagesSet),
        execution_counts: counts,
        blocks_triggered: blocks,
      };

      setReport(result);
      return result;
    } catch (err) {
      console.error("[useLisRollout] buildReport error:", err);
      const empty = createEmptyRolloutReport(organizationId);
      setReport(empty);
      return empty;
    } finally {
      setReportLoading(false);
    }
  }, [organizationId, projectId]);

  const checkPhaseReadiness = useCallback(
    (transition: string) => {
      if (!report) return { ready: false, reasons: ["No report generated yet"] };
      return evaluatePhaseReadiness(report, transition);
    },
    [report],
  );

  return {
    config,
    visibility,
    checkStage,
    isEnabled,
    stageMode,
    isAgentActive,
    buildReport,
    report,
    reportLoading,
    checkPhaseReadiness,
  };
}
