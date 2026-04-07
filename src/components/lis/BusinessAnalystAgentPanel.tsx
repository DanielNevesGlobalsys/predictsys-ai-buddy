import { useState, useEffect } from "react";
import { useBusinessAnalystAgent } from "@/hooks/useBusinessAnalystAgent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  TrendingUp, RefreshCw, Clock, Target, Zap, BarChart3,
  Lightbulb, Users, DollarSign, LayoutDashboard,
} from "lucide-react";
import type { LisStage } from "@/types/lisAgents";

interface Props {
  projectId: string;
  organizationId: string;
  stage?: LisStage;
}

const urgencyLabel: Record<string, string> = {
  immediate: "Imediato",
  short_term: "Curto prazo",
  medium_term: "Médio prazo",
  long_term: "Longo prazo",
};

export default function BusinessAnalystAgentPanel({ projectId, organizationId, stage = "dashboard" }: Props) {
  const { loading, lastResult, history, runCheck, loadHistory } = useBusinessAnalystAgent(projectId, organizationId);
  const [showActions, setShowActions] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const ba = lastResult?.business_decision as any;

  return (
    <Card className="border-l-4 border-l-[hsl(35,90%,55%)]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-5 w-5 text-[hsl(35,90%,55%)]" />
            Business Analyst Agent
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => runCheck(stage)} disabled={loading}>
            {loading ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : <Lightbulb className="h-3 w-3 mr-1" />}
            Analisar
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!ba && !loading && (
          <p className="text-sm text-muted-foreground">
            Clique em "Analisar" para gerar a leitura executiva e recomendações de negócio.
          </p>
        )}

        {ba && (
          <>
            {/* Executive Summary */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Target className="h-3.5 w-3.5" /> Resumo Executivo
              </h4>
              {ba.executive_summary?.main_message && (
                <p className="text-sm font-medium leading-snug">{ba.executive_summary.main_message}</p>
              )}
              {ba.executive_summary?.main_opportunities?.length > 0 && (
                <div className="mt-1.5">
                  {ba.executive_summary.main_opportunities.slice(0, 3).map((o: string, i: number) => (
                    <p key={i} className="text-xs text-green-600 dark:text-green-400">🟢 {o}</p>
                  ))}
                </div>
              )}
              {ba.executive_summary?.main_risks?.length > 0 && (
                <div className="mt-1">
                  {ba.executive_summary.main_risks.slice(0, 3).map((r: string, i: number) => (
                    <p key={i} className="text-xs text-destructive">🔴 {r}</p>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* Who to Prioritize */}
            {ba.action_layer?.who_to_prioritize?.length > 0 && (
              <>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" /> Quem Priorizar
                  </h4>
                  <div className="space-y-1.5">
                    {ba.action_layer.who_to_prioritize.slice(0, 4).map((p: any, i: number) => (
                      <div key={i} className="border rounded px-2.5 py-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{p.segment}</span>
                          <Badge variant={p.priority === "critical" ? "destructive" : p.priority === "high" ? "default" : "secondary"} className="text-[10px]">
                            {p.priority}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{p.reason}</p>
                        <p className="text-xs mt-0.5">→ {p.suggested_action}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <Separator />
              </>
            )}

            {/* Business Impact */}
            {(ba.business_impact?.financial_interpretation?.length > 0 || ba.business_impact?.expected_impact?.length > 0) && (
              <>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                    <DollarSign className="h-3.5 w-3.5" /> Impacto
                  </h4>
                  {ba.business_impact.expected_impact?.slice(0, 3).map((e: string, i: number) => (
                    <p key={i} className="text-xs">📊 {e}</p>
                  ))}
                  {ba.business_impact.financial_interpretation?.slice(0, 2).map((f: string, i: number) => (
                    <p key={i} className="text-xs text-muted-foreground">💰 {f}</p>
                  ))}
                </div>
                <Separator />
              </>
            )}

            {/* Metric Translation */}
            {ba.technical_to_business_translation?.metric_translation?.length > 0 && (
              <>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                    <BarChart3 className="h-3.5 w-3.5" /> Tradução Técnica
                  </h4>
                  <div className="space-y-1">
                    {ba.technical_to_business_translation.metric_translation.slice(0, 4).map((m: any, i: number) => (
                      <div key={i} className="text-xs border rounded px-2 py-1">
                        <span className="font-mono text-muted-foreground">{m.metric_name}{m.metric_value ? ` = ${m.metric_value}` : ""}</span>
                        <p>{m.business_meaning}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <Separator />
              </>
            )}

            {/* Actions toggle */}
            {ba.action_layer?.recommended_actions?.length > 0 && (
              <div>
                <button onClick={() => setShowActions(!showActions)} className="text-xs text-primary hover:underline flex items-center gap-1">
                  <Zap className="h-3 w-3" />
                  {showActions ? "Ocultar" : "Ver"} {ba.action_layer.recommended_actions.length} ações recomendadas
                </button>
                {showActions && (
                  <ul className="mt-1.5 space-y-1">
                    {ba.action_layer.recommended_actions.map((a: any, i: number) => (
                      <li key={i} className="text-xs border rounded px-2 py-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{a.action}</span>
                          <Badge variant="outline" className="text-[10px]">{urgencyLabel[a.urgency] || a.urgency}</Badge>
                        </div>
                        <p className="text-muted-foreground mt-0.5">Alvo: {a.target_segment}</p>
                        <p className="mt-0.5">Resultado: {a.expected_outcome}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Dashboard intelligence toggle */}
            {(ba.dashboard_blocks?.new_blocks?.length > 0 || ba.dashboard_blocks?.remove_blocks?.length > 0) && (
              <div>
                <button onClick={() => setShowDashboard(!showDashboard)} className="text-xs text-primary hover:underline flex items-center gap-1">
                  <LayoutDashboard className="h-3 w-3" />
                  {showDashboard ? "Ocultar" : "Ver"} inteligência do dashboard
                </button>
                {showDashboard && (
                  <div className="mt-1.5 space-y-1 text-xs">
                    {ba.dashboard_blocks.new_blocks?.map((b: any, i: number) => (
                      <p key={`n-${i}`} className="text-green-600">+ {b.block_name}: {b.reasoning}</p>
                    ))}
                    {ba.dashboard_blocks.remove_blocks?.map((b: string, i: number) => (
                      <p key={`r-${i}`} className="text-destructive">− {b}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Confidence */}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">Confiança</span>
              <Badge variant={ba.confidence >= 0.7 ? "default" : ba.confidence >= 0.4 ? "secondary" : "destructive"}>
                {Math.round((ba.confidence || 0) * 100)}%
              </Badge>
            </div>
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
