import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Shield, ShieldAlert, ShieldCheck, ShieldX, Loader2, AlertTriangle, CheckCircle2, XCircle, Info } from "lucide-react";
import { useGovernanceAgent, type GovernanceDecision } from "@/hooks/useGovernanceAgent";

interface GovernanceAgentPanelProps {
  projectId: string | undefined;
  organizationId: string | undefined;
  stage?: string;
}

const statusConfig = {
  ready: { icon: ShieldCheck, color: "text-green-500", bg: "bg-green-500/10", badge: "default" as const, label: "Pipeline Governado" },
  warning: { icon: ShieldAlert, color: "text-yellow-500", bg: "bg-yellow-500/10", badge: "secondary" as const, label: "Warnings Detectados" },
  blocked: { icon: ShieldX, color: "text-red-500", bg: "bg-red-500/10", badge: "destructive" as const, label: "Pipeline Bloqueado" },
};

const checkStatusIcon = {
  pass: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  warn: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
  block: <XCircle className="h-4 w-4 text-red-500" />,
};

export function GovernanceAgentPanel({ projectId, organizationId, stage = "targeting" }: GovernanceAgentPanelProps) {
  const { decision, loading, error, runGovernanceCheck, loadLatestDecision, result } = useGovernanceAgent(projectId, organizationId);
  const [expanded, setExpanded] = useState(false);

  const handleRun = () => runGovernanceCheck(stage, "assisted");

  const cfg = decision ? statusConfig[decision.pipeline_status] : null;
  const StatusIcon = cfg?.icon ?? Shield;

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Governance Agent
          </CardTitle>
          <div className="flex items-center gap-2">
            {decision && (
              <Badge variant={cfg?.badge} className="text-xs">
                {cfg?.label}
              </Badge>
            )}
            <Button size="sm" variant="outline" onClick={handleRun} disabled={loading || !projectId}>
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Shield className="h-3 w-3 mr-1" />}
              {loading ? "Analisando..." : "Validar Pipeline"}
            </Button>
          </div>
        </div>
      </CardHeader>

      {error && (
        <CardContent className="pt-0 pb-3">
          <div className="text-xs text-destructive bg-destructive/10 rounded p-2">{error}</div>
        </CardContent>
      )}

      {decision && (
        <CardContent className="pt-0 space-y-3">
          {/* Status banner */}
          <div className={`flex items-center gap-2 p-2 rounded ${cfg?.bg}`}>
            <StatusIcon className={`h-5 w-5 ${cfg?.color}`} />
            <div className="flex-1">
              <span className={`text-sm font-medium ${cfg?.color}`}>{cfg?.label}</span>
              <span className="text-xs text-muted-foreground ml-2">
                Confiança: {Math.round(decision.confidence * 100)}%
              </span>
            </div>
            {decision.governance_conflict && (
              <Badge variant="destructive" className="text-xs">Conflito</Badge>
            )}
          </div>

          {/* Blocking reasons */}
          {decision.blocking_reasons.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-red-500">Bloqueios:</span>
              {decision.blocking_reasons.map((r, i) => (
                <div key={i} className="text-xs bg-red-500/10 text-red-400 rounded p-1.5 flex items-start gap-1.5">
                  <XCircle className="h-3 w-3 mt-0.5 shrink-0" /> {r}
                </div>
              ))}
            </div>
          )}

          {/* Warnings */}
          {decision.warnings.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-yellow-500">Warnings:</span>
              {decision.warnings.map((w, i) => (
                <div key={i} className="text-xs bg-yellow-500/10 text-yellow-400 rounded p-1.5 flex items-start gap-1.5">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {w}
                </div>
              ))}
            </div>
          )}

          {/* Readiness grid */}
          <div className="grid grid-cols-4 gap-1.5">
            {Object.entries(decision.readiness_assessment).map(([key, ready]) => (
              <div key={key} className={`text-center p-1.5 rounded text-xs ${ready ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-400"}`}>
                {ready ? "✓" : "✗"} {key.replace("_ready", "").replace("_", " ")}
              </div>
            ))}
          </div>

          {/* Expandable details */}
          <Accordion type="single" collapsible>
            <AccordionItem value="checks" className="border-none">
              <AccordionTrigger className="text-xs py-1 hover:no-underline">
                Detalhes ({decision.consistency_checks.length} verificações)
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-1">
                  {decision.consistency_checks.map((c, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      {checkStatusIcon[c.status]}
                      <div>
                        <span className="font-medium">{c.check}:</span>{" "}
                        <span className="text-muted-foreground">{c.reason}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Leakage */}
                {decision.leakage_assessment.status !== "clear" && (
                  <div className="mt-2 p-2 rounded bg-muted/50 text-xs space-y-1">
                    <span className="font-medium">Leakage: {decision.leakage_assessment.status}</span>
                    {decision.leakage_assessment.blocking_columns.length > 0 && (
                      <div className="text-red-400">Bloqueiam: {decision.leakage_assessment.blocking_columns.join(", ")}</div>
                    )}
                    {decision.leakage_assessment.reasoning.map((r, i) => (
                      <div key={i} className="text-muted-foreground">{r}</div>
                    ))}
                  </div>
                )}

                {/* Official state */}
                <div className="mt-2 p-2 rounded bg-muted/50 text-xs">
                  <span className="font-medium">Estado Oficial:</span>
                  <div className="grid grid-cols-2 gap-1 mt-1 text-muted-foreground">
                    <span>Target: {decision.official_state_summary.official_target || "—"}</span>
                    <span>Problema: {decision.official_state_summary.official_problem_type || "—"}</span>
                    <span>Entity: {decision.official_state_summary.official_entity_key.join(", ") || "—"}</span>
                    <span>Tempo: {decision.official_state_summary.official_time_column || "—"}</span>
                    <span>Grain: {decision.official_state_summary.official_grain || "—"}</span>
                    <span>Split: {decision.official_state_summary.official_split_strategy || "—"}</span>
                  </div>
                </div>

                {/* Actions required */}
                {decision.actions_required.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <span className="font-medium text-xs">Ações Necessárias:</span>
                    {decision.actions_required.map((a, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <Badge variant={a.priority === "critical" ? "destructive" : "secondary"} className="text-[10px]">
                          {a.priority}
                        </Badge>
                        <span>{a.action}</span>
                        <span className="text-muted-foreground">→ {a.target}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Compliance notes */}
                {decision.compliance_notes.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <span className="font-medium text-xs flex items-center gap-1">
                      <Info className="h-3 w-3" /> Compliance
                    </span>
                    {decision.compliance_notes.map((n, i) => (
                      <div key={i} className="text-xs text-muted-foreground">{n}</div>
                    ))}
                  </div>
                )}

                {/* Audit */}
                {result?.audit_metadata && (
                  <div className="mt-2 text-[10px] text-muted-foreground/60 space-x-3">
                    <span>Modelo: {result.audit_metadata.model_used}</span>
                    <span>Duração: {result.audit_metadata.duration_ms}ms</span>
                    <span>Versão: {result.audit_metadata.context_version}</span>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      )}

      {!decision && !loading && !error && (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">
            Clique em "Validar Pipeline" para executar a análise de governança do estado atual.
          </p>
        </CardContent>
      )}
    </Card>
  );
}
