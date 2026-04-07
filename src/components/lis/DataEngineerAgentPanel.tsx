import { useState, useEffect } from "react";
import { useDataEngineerAgent } from "@/hooks/useDataEngineerAgent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Database, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Clock,
  Layers, ArrowRightLeft, HardDrive, Settings2,
} from "lucide-react";
import type { LisStage } from "@/types/lisAgents";

interface Props {
  projectId: string;
  organizationId: string;
  stage?: LisStage;
}

export default function DataEngineerAgentPanel({ projectId, organizationId, stage = "builder" }: Props) {
  const { loading, lastResult, history, runCheck, loadHistory } = useDataEngineerAgent(projectId, organizationId);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const de = lastResult?.de_decision as any;

  const statusIcon = (ok: boolean | undefined) =>
    ok ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-destructive" />;

  return (
    <Card className="border-l-4 border-l-[hsl(150,60%,45%)]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-5 w-5 text-[hsl(150,60%,45%)]" />
            Data Engineer Agent
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => runCheck(stage)} disabled={loading}>
              {loading ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : <Settings2 className="h-3 w-3 mr-1" />}
              Analisar
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!de && !loading && (
          <p className="text-sm text-muted-foreground">
            Clique em "Analisar" para executar a validação de engenharia de dados.
          </p>
        )}

        {de && (
          <>
            {/* Readiness */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "Builder", ready: de.readiness_assessment?.builder_ready },
                { label: "Treino", ready: de.readiness_assessment?.training_ready },
                { label: "Scoring", ready: de.readiness_assessment?.scoring_ready },
              ].map(r => (
                <div key={r.label} className="flex items-center gap-1.5 rounded-md border px-3 py-2">
                  {statusIcon(r.ready)}
                  <span className="text-xs font-medium">{r.label}</span>
                </div>
              ))}
            </div>

            {/* Schema */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Layers className="h-3.5 w-3.5" /> Schema
              </h4>
              <p className="text-sm">{de.schema_assessment?.dataset_shape}</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {(de.schema_assessment?.entity_columns || []).map((c: string) => (
                  <Badge key={c} variant="outline" className="text-[10px]">🔑 {c}</Badge>
                ))}
                {(de.schema_assessment?.time_columns || []).map((c: string) => (
                  <Badge key={c} variant="outline" className="text-[10px]">🕐 {c}</Badge>
                ))}
              </div>
              {(de.schema_assessment?.schema_blockers?.length > 0) && (
                <div className="mt-1 space-y-0.5">
                  {de.schema_assessment.schema_blockers.map((b: string, i: number) => (
                    <p key={i} className="text-xs text-destructive flex items-center gap-1">
                      <XCircle className="h-3 w-3" /> {b}
                    </p>
                  ))}
                </div>
              )}
              {(de.schema_assessment?.schema_warnings?.length > 0) && (
                <div className="mt-1 space-y-0.5">
                  {de.schema_assessment.schema_warnings.map((w: string, i: number) => (
                    <p key={i} className="text-xs text-yellow-600 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> {w}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* Builder Plan */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <HardDrive className="h-3.5 w-3.5" /> Builder Plan
              </h4>
              <Badge className="mb-1">{de.builder_plan?.dataset_build_mode}</Badge>
              <div className="flex gap-2 flex-wrap mt-1">
                {de.builder_plan?.requires_aggregation && <Badge variant="secondary" className="text-[10px]">Agregação</Badge>}
                {de.builder_plan?.requires_snapshots && <Badge variant="secondary" className="text-[10px]">Snapshots</Badge>}
                {de.builder_plan?.requires_feature_rebuild && <Badge variant="secondary" className="text-[10px]">Rebuild Features</Badge>}
              </div>
              {(de.builder_plan?.reasoning?.length > 0) && (
                <ul className="mt-1 space-y-0.5">
                  {de.builder_plan.reasoning.slice(0, 3).map((r: string, i: number) => (
                    <li key={i} className="text-xs text-muted-foreground">• {r}</li>
                  ))}
                </ul>
              )}
            </div>

            <Separator />

            {/* Training/Scoring Compatibility */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <ArrowRightLeft className="h-3.5 w-3.5" /> Treino × Scoring
              </h4>
              <div className="flex items-center gap-1.5">
                {statusIcon(de.training_scoring_compatibility?.compatible)}
                <span className="text-sm font-medium">
                  {de.training_scoring_compatibility?.compatible ? "Compatível" : "Incompatível"}
                </span>
              </div>
              {(de.training_scoring_compatibility?.missing_features?.length > 0) && (
                <div className="mt-1">
                  <p className="text-xs text-destructive">Features faltantes:</p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {de.training_scoring_compatibility.missing_features.map((f: string) => (
                      <Badge key={f} variant="destructive" className="text-[10px]">{f}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Confidence */}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">Confiança</span>
              <Badge variant={de.confidence >= 0.7 ? "default" : de.confidence >= 0.4 ? "secondary" : "destructive"}>
                {Math.round((de.confidence || 0) * 100)}%
              </Badge>
            </div>

            {/* Expand actions */}
            {de.actions_recommended?.length > 0 && (
              <div>
                <button onClick={() => setExpanded(!expanded)} className="text-xs text-primary hover:underline">
                  {expanded ? "Ocultar" : "Ver"} {de.actions_recommended.length} ações recomendadas
                </button>
                {expanded && (
                  <ul className="mt-1 space-y-1">
                    {de.actions_recommended.map((a: any, i: number) => (
                      <li key={i} className="text-xs border rounded px-2 py-1 flex items-center justify-between">
                        <span>{a.action}</span>
                        <Badge variant={a.priority === "critical" ? "destructive" : "secondary"} className="text-[10px]">{a.priority}</Badge>
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
