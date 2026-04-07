import { Shield, FlaskConical, Database, Cpu, TrendingUp, CheckCircle2, AlertTriangle, XCircle, Loader2, Clock } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import type { LisAgentExecution } from "@/types/lisAgents";
import { LIS_AGENTS_META } from "@/types/lisAgents";

const ICON_MAP: Record<string, React.ElementType> = {
  Shield, FlaskConical, Database, Cpu, TrendingUp,
};

interface AgentAuditAccordionProps {
  executions: LisAgentExecution[];
  title?: string;
}

export default function AgentAuditAccordion({ executions, title }: AgentAuditAccordionProps) {
  if (!executions.length) return null;

  return (
    <div className="space-y-2">
      {title && <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</h4>}
      <Accordion type="multiple" className="space-y-1">
        {executions.map((exec) => {
          const meta = LIS_AGENTS_META.find((a) => a.name === exec.agent_name);
          const IconComp = meta ? ICON_MAP[meta.icon] || Database : Database;
          const statusColor =
            exec.status === "success" ? "text-green-500" :
            exec.status === "warning" ? "text-amber-500" :
            exec.status === "blocked" || exec.status === "failed" ? "text-destructive" :
            "text-muted-foreground";

          const StatusIcon =
            exec.status === "success" ? CheckCircle2 :
            exec.status === "warning" ? AlertTriangle :
            exec.status === "blocked" || exec.status === "failed" ? XCircle :
            Loader2;

          return (
            <AccordionItem key={exec.id} value={exec.id} className="border rounded-lg px-3">
              <AccordionTrigger className="hover:no-underline py-2 text-sm">
                <div className="flex items-center gap-2 w-full">
                  <IconComp className="w-4 h-4 flex-shrink-0" style={{ color: meta?.color }} />
                  <span className="font-medium">{meta?.label || exec.agent_name}</span>
                  <StatusIcon className={`w-3.5 h-3.5 ${statusColor}`} />
                  <Badge variant="outline" className="text-[10px]">{exec.stage}</Badge>
                  <Badge variant="outline" className="text-[10px]">{exec.execution_mode}</Badge>
                  {exec.confidence != null && (
                    <span className="text-xs text-muted-foreground ml-auto mr-2">
                      {Math.round(exec.confidence * 100)}%
                    </span>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent className="text-sm space-y-3 pb-3">
                {/* Reasoning */}
                {(exec.reasoning_summary as string[])?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-1">Raciocínio</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {(exec.reasoning_summary as string[]).map((r, i) => (
                        <li key={i} className="text-xs text-muted-foreground">{r}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Warnings */}
                {(exec.warnings as string[])?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-amber-500 mb-1">Avisos</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {(exec.warnings as string[]).map((w, i) => (
                        <li key={i} className="text-xs text-amber-500 dark:text-amber-400">{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Blockers */}
                {(exec.blocking_issues as string[])?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-destructive mb-1">Bloqueios</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {(exec.blocking_issues as string[]).map((b, i) => (
                        <li key={i} className="text-xs text-destructive">{b}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Actions */}
                {(exec.actions_recommended as any[])?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-1">Ações Recomendadas</p>
                    {(exec.actions_recommended as any[]).map((a: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <Badge variant="outline" className="text-[10px]">{a.priority}</Badge>
                        <span>{a.action}</span>
                        {a.auto_applicable && <Badge variant="secondary" className="text-[10px]">auto</Badge>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Audit footer */}
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-1 border-t">
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    <span>{new Date(exec.created_at).toLocaleString("pt-BR")}</span>
                  </div>
                  {exec.duration_ms != null && <span>{exec.duration_ms}ms</span>}
                  {exec.model_used && <span>{exec.model_used}</span>}
                  <span className="font-mono text-[10px]">{exec.id.slice(0, 8)}</span>
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
