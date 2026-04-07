import { useState } from "react";
import { Shield, FlaskConical, Database, Cpu, TrendingUp, Loader2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import type { LisAgentExecution, LisAgentName } from "@/types/lisAgents";
import { LIS_AGENTS_META } from "@/types/lisAgents";

const ICON_MAP: Record<string, React.ElementType> = {
  Shield, FlaskConical, Database, Cpu, TrendingUp,
};

const STATUS_CONFIG = {
  success: { icon: CheckCircle2, color: "text-green-500", badge: "default" as const, label: "Sucesso" },
  warning: { icon: AlertTriangle, color: "text-yellow-500", badge: "secondary" as const, label: "Atenção" },
  blocked: { icon: XCircle, color: "text-red-500", badge: "destructive" as const, label: "Bloqueado" },
  failed: { icon: XCircle, color: "text-red-500", badge: "destructive" as const, label: "Falhou" },
  running: { icon: Loader2, color: "text-blue-500", badge: "outline" as const, label: "Executando" },
  pending: { icon: Loader2, color: "text-muted-foreground", badge: "outline" as const, label: "Pendente" },
};

interface LisAgentPanelProps {
  executions: LisAgentExecution[];
  loading?: boolean;
}

export default function LisAgentPanel({ executions, loading }: LisAgentPanelProps) {
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mr-2" />
          <span className="text-sm text-muted-foreground">Carregando execuções da LIS...</span>
        </CardContent>
      </Card>
    );
  }

  if (!executions.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Nenhuma execução de agente registrada ainda.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">LIS AI OS — Execuções de Agentes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Accordion type="single" collapsible>
          {executions.map((exec) => {
            const meta = LIS_AGENTS_META.find((a) => a.name === exec.agent_name);
            const IconComp = meta ? ICON_MAP[meta.icon] || Database : Database;
            const statusCfg = STATUS_CONFIG[exec.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.pending;
            const StatusIcon = statusCfg.icon;

            return (
              <AccordionItem key={exec.id} value={exec.id}>
                <AccordionTrigger className="hover:no-underline py-2">
                  <div className="flex items-center gap-3 text-left w-full">
                    <IconComp className="w-4 h-4 flex-shrink-0" style={{ color: meta?.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{meta?.label || exec.agent_name}</span>
                        <Badge variant={statusCfg.badge} className="text-xs">
                          <StatusIcon className={`w-3 h-3 mr-1 ${exec.status === 'running' ? 'animate-spin' : ''}`} />
                          {statusCfg.label}
                        </Badge>
                        {exec.confidence != null && (
                          <span className="text-xs text-muted-foreground">
                            {Math.round(exec.confidence * 100)}%
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {exec.stage} • {exec.execution_mode} • {new Date(exec.created_at).toLocaleString("pt-BR")}
                      </span>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3 pl-7 text-sm">
                    {/* Reasoning */}
                    {exec.reasoning_summary?.length > 0 && (
                      <div>
                        <p className="font-medium text-xs mb-1">Raciocínio</p>
                        <ul className="list-disc pl-4 space-y-1">
                          {exec.reasoning_summary.map((r, i) => (
                            <li key={i} className="text-muted-foreground text-xs">{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Warnings */}
                    {exec.warnings?.length > 0 && (
                      <div>
                        <p className="font-medium text-xs mb-1 text-amber-500 dark:text-amber-400">Avisos</p>
                        <ul className="list-disc pl-4 space-y-1">
                          {exec.warnings.map((w, i) => (
                            <li key={i} className="text-xs text-amber-500 dark:text-amber-400">{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Blocking */}
                    {exec.blocking_issues?.length > 0 && (
                      <div>
                        <p className="font-medium text-xs mb-1 text-destructive">Bloqueios</p>
                        <ul className="list-disc pl-4 space-y-1">
                          {exec.blocking_issues.map((b, i) => (
                            <li key={i} className="text-xs text-destructive">{b}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Actions */}
                    {exec.actions_recommended?.length > 0 && (
                      <div>
                        <p className="font-medium text-xs mb-1">Ações Recomendadas</p>
                        <div className="space-y-1">
                          {exec.actions_recommended.map((a, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs">{a.priority}</Badge>
                              <span className="text-xs">{a.action}</span>
                              {a.auto_applicable && (
                                <Badge variant="secondary" className="text-xs">auto</Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Audit */}
                    {exec.duration_ms != null && (
                      <p className="text-xs text-muted-foreground">
                        Duração: {exec.duration_ms}ms • Modelo: {exec.model_used || "N/A"}
                      </p>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </CardContent>
    </Card>
  );
}
