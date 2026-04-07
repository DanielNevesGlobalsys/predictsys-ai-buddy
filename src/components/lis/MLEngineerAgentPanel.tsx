import { useState, useEffect } from "react";
import { useMLEngineerAgent } from "@/hooks/useMLEngineerAgent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Cpu, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Clock,
  TrendingUp, Shield, Rocket, ArrowRightLeft,
} from "lucide-react";
import type { LisStage } from "@/types/lisAgents";

interface Props {
  projectId: string;
  organizationId: string;
  stage?: LisStage;
}

const qualityColors: Record<string, string> = {
  excellent: "text-green-600",
  good: "text-green-500",
  acceptable: "text-yellow-600",
  poor: "text-destructive",
};

const deployIcons: Record<string, typeof CheckCircle2> = {
  ready: CheckCircle2,
  warning: AlertTriangle,
  blocked: XCircle,
};

export default function MLEngineerAgentPanel({ projectId, organizationId, stage = "training" }: Props) {
  const { loading, lastResult, history, runCheck, loadHistory } = useMLEngineerAgent(projectId, organizationId);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const ml = lastResult?.ml_decision as any;

  return (
    <Card className="border-l-4 border-l-[hsl(280,65%,55%)]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-5 w-5 text-[hsl(280,65%,55%)]" />
            ML Engineer Agent
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => runCheck(stage)} disabled={loading}>
            {loading ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : <Rocket className="h-3 w-3 mr-1" />}
            Avaliar
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!ml && !loading && (
          <p className="text-sm text-muted-foreground">
            Clique em "Avaliar" para analisar a qualidade do modelo e prontidão para deploy.
          </p>
        )}

        {ml && (
          <>
            {/* Training Assessment */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5" /> Qualidade do Modelo
              </h4>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className={qualityColors[ml.training_assessment?.model_quality] || ""}>
                  {ml.training_assessment?.model_quality || "unknown"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Robustez: <strong>{ml.training_assessment?.robustness_status}</strong>
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-lg font-bold">
                  {typeof ml.training_assessment?.primary_metric_value === "number"
                    ? ml.training_assessment.primary_metric_value.toFixed(4)
                    : "—"}
                </span>
                <span className="text-xs text-muted-foreground">{ml.training_assessment?.primary_metric_name}</span>
              </div>
              {ml.training_assessment?.secondary_metrics && Object.keys(ml.training_assessment.secondary_metrics).length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {Object.entries(ml.training_assessment.secondary_metrics).map(([k, v]: [string, any]) => (
                    <span key={k} className="text-[10px] text-muted-foreground border rounded px-1.5 py-0.5">
                      {k}: {typeof v === "number" ? v.toFixed(3) : v}
                    </span>
                  ))}
                </div>
              )}
              {(ml.training_assessment?.reasoning?.length > 0) && (
                <ul className="mt-1 space-y-0.5">
                  {ml.training_assessment.reasoning.slice(0, 3).map((r: string, i: number) => (
                    <li key={i} className="text-xs text-muted-foreground">• {r}</li>
                  ))}
                </ul>
              )}
            </div>

            <Separator />

            {/* Overfit / Underfit */}
            {(ml.overfit_underfit_assessment?.overfit_signals?.length > 0 ||
              ml.overfit_underfit_assessment?.underfit_signals?.length > 0 ||
              ml.overfit_underfit_assessment?.feature_dominance_risks?.length > 0) && (
              <>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" /> Riscos Técnicos
                  </h4>
                  {ml.overfit_underfit_assessment.overfit_signals?.map((s: string, i: number) => (
                    <p key={`of-${i}`} className="text-xs text-destructive">⬆ Overfit: {s}</p>
                  ))}
                  {ml.overfit_underfit_assessment.underfit_signals?.map((s: string, i: number) => (
                    <p key={`uf-${i}`} className="text-xs text-yellow-600">⬇ Underfit: {s}</p>
                  ))}
                  {ml.overfit_underfit_assessment.feature_dominance_risks?.map((s: string, i: number) => (
                    <p key={`fd-${i}`} className="text-xs text-orange-500">⚠ Dominância: {s}</p>
                  ))}
                </div>
                <Separator />
              </>
            )}

            {/* Deploy Readiness */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Rocket className="h-3.5 w-3.5" /> Deploy Readiness
              </h4>
              {(() => {
                const status = ml.deploy_readiness?.status || "blocked";
                const Icon = deployIcons[status] || XCircle;
                return (
                  <div className="flex items-center gap-1.5">
                    <Icon className={`h-4 w-4 ${status === "ready" ? "text-green-500" : status === "warning" ? "text-yellow-500" : "text-destructive"}`} />
                    <span className="text-sm font-medium capitalize">{status}</span>
                  </div>
                );
              })()}
              {(ml.deploy_readiness?.required_actions?.length > 0) && (
                <ul className="mt-1">
                  {ml.deploy_readiness.required_actions.map((a: string, i: number) => (
                    <li key={i} className="text-xs text-destructive">• {a}</li>
                  ))}
                </ul>
              )}
            </div>

            <Separator />

            {/* Training/Scoring Consistency */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <ArrowRightLeft className="h-3.5 w-3.5" /> Consistência Treino × Scoring
              </h4>
              <div className="grid grid-cols-2 gap-1">
                {[
                  { label: "Consistente", ok: ml.training_scoring_consistency?.consistent },
                  { label: "Builder", ok: ml.training_scoring_consistency?.builder_alignment },
                  { label: "Schema", ok: ml.training_scoring_consistency?.schema_alignment },
                  { label: "Features", ok: ml.training_scoring_consistency?.feature_space_alignment },
                ].map(c => (
                  <div key={c.label} className="flex items-center gap-1 text-xs">
                    {c.ok ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : <XCircle className="h-3 w-3 text-destructive" />}
                    {c.label}
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* Technical Summary */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Shield className="h-3.5 w-3.5" /> Resumo Técnico
              </h4>
              <div className="space-y-0.5 text-xs">
                {ml.technical_summary?.main_strength && <p>✅ <strong>Força:</strong> {ml.technical_summary.main_strength}</p>}
                {ml.technical_summary?.main_weakness && <p>⚠️ <strong>Fraqueza:</strong> {ml.technical_summary.main_weakness}</p>}
                {ml.technical_summary?.main_risk && <p>🔴 <strong>Risco:</strong> {ml.technical_summary.main_risk}</p>}
                {ml.technical_summary?.main_recommendation && <p>💡 <strong>Ação:</strong> {ml.technical_summary.main_recommendation}</p>}
              </div>
            </div>

            {/* Confidence */}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">Confiança</span>
              <Badge variant={ml.confidence >= 0.7 ? "default" : ml.confidence >= 0.4 ? "secondary" : "destructive"}>
                {Math.round((ml.confidence || 0) * 100)}%
              </Badge>
            </div>

            {/* Improvements */}
            {ml.model_improvement_opportunities?.length > 0 && (
              <div>
                <button onClick={() => setExpanded(!expanded)} className="text-xs text-primary hover:underline">
                  {expanded ? "Ocultar" : "Ver"} {ml.model_improvement_opportunities.length} oportunidades
                </button>
                {expanded && (
                  <ul className="mt-1 space-y-1">
                    {ml.model_improvement_opportunities.map((o: any, i: number) => (
                      <li key={i} className="text-xs border rounded px-2 py-1 flex items-center justify-between">
                        <span><strong>{o.area}:</strong> {o.suggestion}</span>
                        <Badge variant="secondary" className="text-[10px]">{o.expected_impact}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="pt-2">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
              <Clock className="h-3 w-3" /> Histórico
            </h4>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {history.slice(0, 5).map((h: any) => (
                <div key={h.id} className="flex items-center justify-between text-xs border rounded px-2 py-1">
                  <span className="text-muted-foreground">{new Date(h.created_at).toLocaleString("pt-BR")}</span>
                  <div className="flex gap-1">
                    <Badge variant={h.status === "success" ? "default" : h.status === "blocked" ? "destructive" : "secondary"} className="text-[10px]">
                      {h.status}
                    </Badge>
                    <span className="text-muted-foreground">{h.duration_ms}ms</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
