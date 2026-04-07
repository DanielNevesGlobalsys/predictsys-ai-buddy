import { XCircle, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { LisAgentExecution } from "@/types/lisAgents";
import { LIS_AGENTS_META } from "@/types/lisAgents";

interface AgentBlockingBannerProps {
  executions: LisAgentExecution[];
  stage?: string;
}

export default function AgentBlockingBanner({ executions, stage }: AgentBlockingBannerProps) {
  const blockers = executions.filter(
    (e) =>
      (e.status === "blocked" || (e.blocking_issues as string[])?.length > 0) &&
      (!stage || e.stage === stage),
  );

  if (blockers.length === 0) return null;

  return (
    <div className="space-y-2">
      {blockers.map((exec) => {
        const meta = LIS_AGENTS_META.find((a) => a.name === exec.agent_name);
        const issues = (exec.blocking_issues as string[]) || [];
        const actions = (exec.actions_recommended as any[]) || [];

        return (
          <Alert key={exec.id} variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle className="flex items-center gap-2">
              <span>Bloqueio: {meta?.label || exec.agent_name}</span>
              <Badge variant="destructive" className="text-xs">{exec.stage}</Badge>
            </AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 mt-1 space-y-1">
                {issues.map((issue, i) => (
                  <li key={i} className="text-sm">{issue}</li>
                ))}
              </ul>
              {actions.filter((a: any) => a.priority === "critical").length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium mb-1">Ações necessárias:</p>
                  {actions
                    .filter((a: any) => a.priority === "critical")
                    .map((a: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <XCircle className="w-3 h-3" />
                        <span>{a.action}</span>
                      </div>
                    ))}
                </div>
              )}
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
