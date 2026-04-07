import { Shield, FlaskConical, Database, Cpu, TrendingUp, CheckCircle2, AlertTriangle, XCircle, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { LisAgentExecution } from "@/types/lisAgents";
import { LIS_AGENTS_META } from "@/types/lisAgents";
import type { ApplicationPolicy } from "@/types/lisOrchestration";
import { STAGE_ORCHESTRATION_MAP } from "@/types/lisOrchestration";

const ICON_MAP: Record<string, React.ElementType> = {
  Shield, FlaskConical, Database, Cpu, TrendingUp,
};

const STATUS_ICON = {
  success: CheckCircle2,
  warning: AlertTriangle,
  blocked: XCircle,
  failed: XCircle,
};

const POLICY_LABELS: Record<ApplicationPolicy, { label: string; color: string }> = {
  insight: { label: "Insight", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  recommendation: { label: "Recomendação", color: "bg-primary/10 text-primary" },
  warning: { label: "Atenção", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  block: { label: "Bloqueio", color: "bg-destructive/10 text-destructive" },
  auto_apply: { label: "Auto-aplicado", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
};

interface AgentDecisionSummaryCardProps {
  execution: LisAgentExecution;
  stage?: string;
  compact?: boolean;
}

export default function AgentDecisionSummaryCard({ execution, stage, compact }: AgentDecisionSummaryCardProps) {
  const meta = LIS_AGENTS_META.find((a) => a.name === execution.agent_name);
  const IconComp = meta ? ICON_MAP[meta.icon] || Database : Database;
  const StatusIcon = STATUS_ICON[execution.status as keyof typeof STATUS_ICON] || Eye;
  const stageConfig = STAGE_ORCHESTRATION_MAP[stage || execution.stage];
  const policy = stageConfig?.application_policy || "insight";
  const policyInfo = POLICY_LABELS[policy];

  // Extract main message from decision
  const decision = execution.decision as Record<string, unknown> | null;
  let mainMessage = "";
  if (decision) {
    if ((decision as any).executive_summary?.main_message) {
      mainMessage = (decision as any).executive_summary.main_message;
    } else if ((decision as any).technical_summary?.main_recommendation) {
      mainMessage = (decision as any).technical_summary.main_recommendation;
    } else if ((decision as any).builder_plan?.reasoning?.[0]) {
      mainMessage = (decision as any).builder_plan.reasoning[0];
    } else if (execution.reasoning_summary?.[0]) {
      mainMessage = execution.reasoning_summary[0] as string;
    }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
        <IconComp className="w-4 h-4 flex-shrink-0" style={{ color: meta?.color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{meta?.label || execution.agent_name}</span>
            <StatusIcon className={`w-3.5 h-3.5 ${
              execution.status === "success" ? "text-green-500" :
              execution.status === "warning" ? "text-amber-500" :
              "text-destructive"
            }`} />
            {execution.confidence != null && (
              <span className="text-xs text-muted-foreground">{Math.round(execution.confidence * 100)}%</span>
            )}
            <Badge className={`text-[10px] px-1.5 py-0 ${policyInfo.color}`}>
              {policyInfo.label}
            </Badge>
          </div>
          {mainMessage && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{mainMessage}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconComp className="w-5 h-5" style={{ color: meta?.color }} />
            <CardTitle className="text-sm">{meta?.label || execution.agent_name}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={`text-xs ${policyInfo.color}`}>
              {policyInfo.label}
            </Badge>
            <StatusIcon className={`w-4 h-4 ${
              execution.status === "success" ? "text-green-500" :
              execution.status === "warning" ? "text-amber-500" :
              "text-destructive"
            }`} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {mainMessage && <p className="text-sm">{mainMessage}</p>}

        {(execution.warnings as string[])?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(execution.warnings as string[]).slice(0, 3).map((w, i) => (
              <Badge key={i} variant="secondary" className="text-xs text-amber-600 dark:text-amber-400">
                {w.length > 60 ? w.slice(0, 60) + "…" : w}
              </Badge>
            ))}
          </div>
        )}

        {(execution.blocking_issues as string[])?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(execution.blocking_issues as string[]).map((b, i) => (
              <Badge key={i} variant="destructive" className="text-xs">{b}</Badge>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
          <span>{execution.stage}</span>
          <span>{execution.execution_mode}</span>
          {execution.confidence != null && (
            <span>Confiança: {Math.round(execution.confidence * 100)}%</span>
          )}
          <span>{execution.duration_ms}ms</span>
        </div>
      </CardContent>
    </Card>
  );
}
