import { useState, useEffect } from "react";
import { useDataScientistAgent } from "@/hooks/useDataScientistAgent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  FlaskConical, Target, Clock, Layers, AlertTriangle,
  Lightbulb, Loader2, RefreshCw, ChevronDown, ChevronUp,
} from "lucide-react";

interface Props {
  projectId: string;
  organizationId: string;
  stage?: string;
}

export default function DataScientistAgentPanel({ projectId, organizationId, stage = "targeting" }: Props) {
  const { analyze, fetchLatest, loading, result, error } = useDataScientistAgent({ projectId, organizationId });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (projectId && organizationId) fetchLatest();
  }, [projectId, organizationId, fetchLatest]);

  const ds = result?.ds_decision;

  const confidenceColor = (c: number) =>
    c >= 0.8 ? "text-green-600 dark:text-green-400"
      : c >= 0.5 ? "text-yellow-600 dark:text-yellow-400"
      : "text-red-600 dark:text-red-400";

  const kindBadge = (kind: string) => {
    const map: Record<string, string> = {
      explicit: "default",
      derived: "secondary",
      weak: "outline",
      invalid: "destructive",
    };
    return (map[kind] || "outline") as any;
  };

  const totalRisks = ds ? [
    ...ds.modeling_risk_assessment.target_risks,
    ...ds.modeling_risk_assessment.grain_risks,
    ...ds.modeling_risk_assessment.split_risks,
    ...ds.modeling_risk_assessment.data_risks,
    ...ds.modeling_risk_assessment.general_risks,
  ].length : 0;

  return (
    <Card className="border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-blue-500" />
            <CardTitle className="text-base">Cientista de Dados (LIS)</CardTitle>
            {ds && (
              <Badge variant="outline" className={confidenceColor(ds.confidence)}>
                {Math.round(ds.confidence * 100)}%
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => analyze(stage)}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            {ds && (
              <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      {error && (
        <CardContent className="pt-0">
          <p className="text-sm text-destructive">{error}</p>
        </CardContent>
      )}

      {loading && !ds && (
        <CardContent className="pt-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analisando problema preditivo...
          </div>
        </CardContent>
      )}

      {ds && (
        <CardContent className="pt-0 space-y-4">
          {/* Problem Formulation Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <MiniCard label="Família" value={ds.problem_formulation.objective_family} />
            <MiniCard label="Tipo" value={ds.problem_formulation.problem_type} />
            <MiniCard label="Modo" value={ds.problem_formulation.business_mode} />
          </div>

          {/* Target Recommendation */}
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Target Recomendado</span>
              <Badge variant={kindBadge(ds.target_recommendation.target_kind)}>
                {ds.target_recommendation.target_kind}
              </Badge>
              <span className={`text-xs ml-auto ${confidenceColor(ds.target_recommendation.target_confidence)}`}>
                {Math.round(ds.target_recommendation.target_confidence * 100)}%
              </span>
            </div>
            <p className="text-sm font-mono bg-muted px-2 py-1 rounded">
              {ds.target_recommendation.recommended_target || "—"}
            </p>
            {ds.target_recommendation.target_reasoning.length > 0 && (
              <ul className="text-xs text-muted-foreground space-y-0.5 pl-4 list-disc">
                {ds.target_recommendation.target_reasoning.slice(0, 3).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Entity / Time / Grain */}
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Entity / Tempo / Grain</span>
              <span className={`text-xs ml-auto ${confidenceColor(ds.entity_time_grain_recommendation.confidence)}`}>
                {Math.round(ds.entity_time_grain_recommendation.confidence * 100)}%
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Entity:</span>{" "}
                <span className="font-mono">{ds.entity_time_grain_recommendation.recommended_entity_key.join(", ") || "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Tempo:</span>{" "}
                <span className="font-mono">{ds.entity_time_grain_recommendation.recommended_time_column || "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Grain:</span>{" "}
                <span className="font-mono">{ds.entity_time_grain_recommendation.recommended_grain}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Split:</span>{" "}
                <span className="font-mono">{ds.entity_time_grain_recommendation.recommended_split_strategy}</span>
              </div>
            </div>
          </div>

          {/* Risks summary */}
          {totalRisks > 0 && (
            <div className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="h-4 w-4" />
              {totalRisks} risco(s) de modelagem identificado(s)
            </div>
          )}

          {/* Expanded details */}
          {expanded && (
            <>
              <Separator />

              {/* Features */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1">
                  <Lightbulb className="h-4 w-4" /> Features
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Recomendadas:</span>{" "}
                    {ds.feature_reasoning.recommended_features.length}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Bloqueadas:</span>{" "}
                    {ds.feature_reasoning.blocked_features.length}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Risco leakage:</span>{" "}
                    {ds.feature_reasoning.leakage_risk_features.length}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Baixo valor:</span>{" "}
                    {ds.feature_reasoning.low_value_features.length}
                  </div>
                </div>
                {ds.feature_reasoning.leakage_risk_features.length > 0 && (
                  <div className="text-xs text-destructive">
                    ⚠ Leakage: {ds.feature_reasoning.leakage_risk_features.join(", ")}
                  </div>
                )}
              </div>

              {/* Risks detail */}
              {totalRisks > 0 && (
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">Riscos de Modelagem</h4>
                  {[
                    { label: "Target", items: ds.modeling_risk_assessment.target_risks },
                    { label: "Grain", items: ds.modeling_risk_assessment.grain_risks },
                    { label: "Split", items: ds.modeling_risk_assessment.split_risks },
                    { label: "Dados", items: ds.modeling_risk_assessment.data_risks },
                    { label: "Geral", items: ds.modeling_risk_assessment.general_risks },
                  ].filter(g => g.items.length > 0).map(g => (
                    <div key={g.label} className="text-xs">
                      <span className="text-muted-foreground font-medium">{g.label}:</span>
                      <ul className="pl-4 list-disc">
                        {g.items.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {/* Alternatives */}
              {ds.alternatives.alternative_targets.length > 0 && (
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">Alternativas de Target</h4>
                  {ds.alternatives.alternative_targets.map((alt, i) => (
                    <div key={i} className="text-xs border rounded p-2">
                      <span className="font-mono">{alt.column}</span>{" "}
                      <Badge variant="outline" className="text-[10px]">{alt.problem_type}</Badge>
                      <p className="text-muted-foreground mt-0.5">{alt.reasoning}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              {ds.actions_recommended.length > 0 && (
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">Ações Recomendadas</h4>
                  {ds.actions_recommended.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <Badge variant={a.priority === "critical" ? "destructive" : "outline"} className="text-[10px]">
                        {a.priority}
                      </Badge>
                      <span>{a.action}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Audit */}
              {result?.audit_metadata && (
                <div className="text-[10px] text-muted-foreground pt-2 border-t">
                  Modelo: {result.audit_metadata.model_used} |
                  Duração: {result.audit_metadata.duration_ms}ms |
                  {new Date(result.audit_metadata.executed_at).toLocaleString("pt-BR")}
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function MiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border px-2 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-xs font-medium capitalize">{value}</div>
    </div>
  );
}
