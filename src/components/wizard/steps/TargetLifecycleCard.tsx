import { useState, useCallback, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  HeartPulse, Loader2, RefreshCw, CheckCircle, AlertTriangle, XCircle,
  ArrowRight, Fingerprint, HelpCircle
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface LifecycleRecommendation {
  type: string;
  message: string;
  go_to_step: number | null;
  cta_label: string;
}

interface DimensionScores {
  quality: number;
  coverage: number;
  drift: number; // -1 = N/A
  freshness: number;
}

interface TargetLifecycleState {
  current_target_source: string;
  current_template_id: string | null;
  target_health_score: number;
  status: "ok" | "warn" | "alert";
  reasons: string[];
  recommendation: LifecycleRecommendation | null;
  last_checked_at: string;
  dataset_fingerprint?: string;
  target_fingerprint?: string;
  fingerprint_changed?: boolean;
  dimension_scores?: DimensionScores;
  na_dimensions?: string[];
  related_versions: {
    selection_current: number;
    selection_scored: number | null;
    builder_version: number | null;
  };
}

interface Props {
  projectId: string | undefined;
  refreshKey?: number;
  onNavigateToStep?: (step: number) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  label_builder: "Template",
  weak_supervision: "Assistido",
  human_labeling: "Rotulagem humana",
};

const statusConfig = (status: string) => {
  if (status === "ok") return { bg: "bg-accent/10 border-accent/20", text: "text-accent", icon: <CheckCircle className="w-4 h-4 text-accent" />, label: "Saudável" };
  if (status === "warn") return { bg: "bg-amber-500/10 border-amber-500/20", text: "text-amber-600", icon: <AlertTriangle className="w-4 h-4 text-amber-500" />, label: "Atenção" };
  return { bg: "bg-destructive/10 border-destructive/20", text: "text-destructive", icon: <XCircle className="w-4 h-4 text-destructive" />, label: "Crítico" };
};

const dimScoreBg = (score: number) =>
  score < 0 ? "bg-muted/30 text-muted-foreground" :
  score >= 70 ? "bg-accent/10 text-accent" :
  score >= 45 ? "bg-amber-500/10 text-amber-600" :
  "bg-destructive/10 text-destructive";

const TargetLifecycleCard = ({ projectId, refreshKey = 0, onNavigateToStep }: Props) => {
  const [state, setState] = useState<TargetLifecycleState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    // Reset on project change to avoid stale cross-project data
    setState(null);
    setError(null);
    (async () => {
      const { data } = await supabase
        .from("project_settings")
        .select("target_lifecycle_state")
        .eq("project_id", projectId)
        .maybeSingle();
      if (data) {
        const tls = (data as any).target_lifecycle_state as TargetLifecycleState | null;
        if (tls && tls.target_health_score != null && tls.last_checked_at) {
          setState(tls);
        }
      }
    })();
  }, [projectId, refreshKey]);

  const runCheck = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await supabase.functions.invoke("tde-check-target-lifecycle", {
        body: { project_id: projectId },
      });
      if (response.error) { setError(response.error.message); return; }
      const data = response.data as any;
      if (data?.target_lifecycle_state) setState(data.target_lifecycle_state);
      else setError("Nenhum estado retornado");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  if (!state && !loading && !error) {
    return (
      <div className="p-4 rounded-lg border border-border bg-muted/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HeartPulse className="w-5 h-5 text-primary" />
            <h4 className="text-sm font-semibold">Ciclo de Vida do Target</h4>
          </div>
          <Button size="sm" variant="outline" onClick={runCheck} disabled={!projectId}>
            <HeartPulse className="w-3.5 h-3.5 mr-1.5" />
            Verificar Saúde
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Verifique a saúde consolidada do target: qualidade, cobertura, drift e versões.
        </p>
      </div>
    );
  }

  const cfg = state ? statusConfig(state.status) : null;
  const dims = state?.dimension_scores;
  const naDims = state?.na_dimensions || [];

  return (
    <TooltipProvider>
      <div className="p-4 rounded-lg border border-border bg-muted/5 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HeartPulse className="w-5 h-5 text-primary" />
            <h4 className="text-sm font-semibold">Ciclo de Vida do Target</h4>
            {state && cfg && (
              <Badge className={`text-xs ${cfg.bg} ${cfg.text}`}>
                {state.target_health_score}/95 — {cfg.label}
              </Badge>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={runCheck} disabled={loading || !projectId}>
            {loading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
            {state ? "Reavaliar" : "Verificar"}
          </Button>
        </div>

        {error && (
          <Alert className="bg-destructive/5 border-destructive/20">
            <XCircle className="w-4 h-4 text-destructive" />
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Verificando ciclo de vida do target...
          </div>
        )}

        {state && !loading && cfg && (
          <>
            {/* Score bar */}
            <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  state.status === "ok" ? "bg-accent" :
                  state.status === "warn" ? "bg-amber-500" : "bg-destructive"
                }`}
                style={{ width: `${Math.min(100, (state.target_health_score / 95) * 100)}%` }}
              />
            </div>

            {/* Dimension scores */}
            {dims && (
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { key: "quality", label: "Qualidade", score: dims.quality },
                  { key: "coverage", label: "Cobertura", score: dims.coverage },
                  { key: "drift", label: "Drift", score: dims.drift },
                  { key: "freshness", label: "Frescor", score: dims.freshness },
                ].map((d) => (
                  <Tooltip key={d.key}>
                    <TooltipTrigger asChild>
                      <div className={`text-center p-1.5 rounded border text-[10px] ${dimScoreBg(d.score)}`}>
                        {d.score < 0 ? (
                          <div className="flex items-center justify-center gap-0.5">
                            <span className="font-bold">N/A</span>
                            <HelpCircle className="w-2.5 h-2.5" />
                          </div>
                        ) : (
                          <span className="font-bold">{d.score}</span>
                        )}
                        <div>{d.label}</div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[180px]">
                      {d.score < 0 ? (
                        <p className="text-xs">N/A: sem dados para calcular. Peso redistribuído.</p>
                      ) : (
                        <p className="text-xs">{d.label}: {d.score}/95</p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}

            {/* Fingerprint change warning */}
            {state.fingerprint_changed && (
              <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/5 p-2 rounded border border-amber-500/20">
                <Fingerprint className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>Fingerprint mudou desde última validação. Reavalie qualidade e reconstrua o builder.</span>
              </div>
            )}

            {/* Source + versions */}
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
              <span>Fonte: <strong>{SOURCE_LABELS[state.current_target_source] || state.current_target_source}</strong></span>
              {state.current_template_id && <span>Template: {state.current_template_id}</span>}
              <span>Seleção: v{state.related_versions.selection_current}</span>
              {state.related_versions.builder_version != null && (
                <span>Builder: v{state.related_versions.builder_version}</span>
              )}
              {state.dataset_fingerprint && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-0.5 cursor-help">
                      <Fingerprint className="w-3 h-3" />
                      {state.dataset_fingerprint.slice(0, 8)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Dataset: {state.dataset_fingerprint}<br/>Target: {state.target_fingerprint}</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Reasons */}
            {state.reasons.length > 0 && (
              <div className="space-y-1">
                {state.reasons.slice(0, 4).map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs py-0.5">
                    {cfg.icon}
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Recommendation CTA */}
            {state.recommendation && state.status !== "ok" && (
              <div className={`p-3 rounded-md border ${cfg.bg} space-y-2`}>
                <p className="text-xs">{state.recommendation.message}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs w-full"
                  onClick={() => {
                    if (state.recommendation?.go_to_step != null && onNavigateToStep) {
                      onNavigateToStep(state.recommendation.go_to_step);
                    }
                  }}
                >
                  {state.recommendation.cta_label}
                  <ArrowRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            )}

            {/* Last checked */}
            <p className="text-[10px] text-muted-foreground">
              Última verificação: {new Date(state.last_checked_at).toLocaleString("pt-BR")}
            </p>
          </>
        )}
      </div>
    </TooltipProvider>
  );
};

export default TargetLifecycleCard;
