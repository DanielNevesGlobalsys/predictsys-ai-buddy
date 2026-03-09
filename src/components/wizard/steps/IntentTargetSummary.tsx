import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Target, Sparkles, Loader2, CheckCircle, AlertTriangle, Info,
  ChevronDown, ChevronUp, XCircle, Zap, RefreshCw, ShieldCheck, ShieldAlert,
} from "lucide-react";
import { useIntentDrivenTarget, type IntentTargetResolution, type TargetCandidateResolved } from "@/hooks/useIntentDrivenTarget";

interface Props {
  projectId: string;
  onApplyTarget?: (candidate: TargetCandidateResolved) => void;
  onApplyEntityKey?: (key: string) => void;
  onApplyTimeAnchor?: (col: string) => void;
  onApplyFeatures?: (features: string[], blocked: { column: string; reason: string }[]) => void;
  currentTarget?: string | null;
}

const STRATEGY_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  explicit: { label: "Alvo explícito", icon: <CheckCircle className="w-4 h-4" />, color: "text-accent" },
  derived: { label: "Alvo derivado", icon: <Sparkles className="w-4 h-4" />, color: "text-primary" },
  insufficient: { label: "Dados insuficientes", icon: <AlertTriangle className="w-4 h-4" />, color: "text-amber-500" },
};

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  if (pct >= 70) return <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">{pct}% confiança</Badge>;
  if (pct >= 40) return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">{pct}% confiança</Badge>;
  return <Badge variant="outline" className="text-[10px]">{pct}% confiança</Badge>;
}

export default function IntentTargetSummary({
  projectId,
  onApplyTarget,
  onApplyEntityKey,
  onApplyTimeAnchor,
  onApplyFeatures,
  currentTarget,
}: Props) {
  const { resolution, loading, loaded, error, loadFromSSOT, resolve, hasCandidate } = useIntentDrivenTarget(projectId);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [persisting, setPersisting] = useState(false);

  useEffect(() => {
    loadFromSSOT();
  }, [loadFromSSOT]);

  /**
   * Persist the applied target, entity key, time anchor to project_settings SSOT.
   * This ensures preflight and downstream stages see the applied values.
   */
  const persistAppliedToSSOT = async (candidate: TargetCandidateResolved, entityKey?: string | null, timeAnchor?: string | null) => {
    setPersisting(true);
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      await supabase
        .from("project_settings")
        .update({
          target_column: candidate.column,
          problem_type: candidate.problem_type,
          active_target_column: candidate.column,
          active_target_mode: candidate.strategy === "derived" ? "template" : "column",
          target_source: candidate.strategy === "derived" ? "label_builder" : "manual",
          target_state: "ready",
          ...(entityKey ? { entity_key: entityKey } : {}),
          ...(timeAnchor ? { time_anchor_column: timeAnchor } : {}),
          updated_at: new Date().toISOString(),
        } as any)
        .eq("project_id", projectId);
      console.log(`[IntentTargetSummary] Persisted to SSOT: target=${candidate.column}, entity=${entityKey}, time=${timeAnchor}`);
    } catch (err) {
      console.error("[IntentTargetSummary] Failed to persist to SSOT:", err);
    } finally {
      setPersisting(false);
    }
  };

  const applyFullSuggestion = (candidate: TargetCandidateResolved) => {
    onApplyTarget?.(candidate);
    if (resolution.suggested_entity_key) onApplyEntityKey?.(resolution.suggested_entity_key);
    if (resolution.suggested_time_anchor) onApplyTimeAnchor?.(resolution.suggested_time_anchor);
    if (resolution.suggested_features.length > 0) {
      onApplyFeatures?.(resolution.suggested_features, resolution.blocked_features);
    }
    // Persist to SSOT so preflight sees the applied values
    persistAppliedToSSOT(candidate, resolution.suggested_entity_key, resolution.suggested_time_anchor);
  };

  const handleResolve = async () => {
    const result = await resolve();
    if (result?.main_candidate && onApplyTarget) {
      // Auto-apply if confidence is high enough
      if (result.confidence_score >= 0.6) {
        applyFullSuggestion(result.main_candidate);
      }
    }
  };

  // No resolution yet — show CTA
  if (!loaded || (!hasCandidate && !loading)) {
    return (
      <Card className="border border-primary/20 bg-primary/5 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold">Resolução inteligente do alvo</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Analise o contrato de intenção, EDA e dados para receber sugestões de alvo baseadas no objetivo do projeto.
        </p>
        <Button onClick={handleResolve} disabled={loading} className="w-full sm:w-auto">
          {loading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analisando...</>
          ) : (
            <><Sparkles className="w-4 h-4 mr-2" /> Resolver alvo pelo contrato de intenção</>
          )}
        </Button>
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="border border-primary/20 bg-primary/5 p-5">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Resolvendo alvo com base no contrato de intenção...</p>
        </div>
      </Card>
    );
  }

  const main = resolution.main_candidate;
  const strategyInfo = STRATEGY_LABELS[resolution.target_strategy_used] || STRATEGY_LABELS.insufficient;
  const isApplied = currentTarget === main?.column;

  return (
    <Card className="border border-primary/20 bg-gradient-to-br from-primary/5 to-accent/5 p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold">Recomendação baseada no contrato de intenção</h3>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleResolve} disabled={loading}>
          <RefreshCw className={`w-3 h-3 mr-1 ${loading ? "animate-spin" : ""}`} />
          Reanalisar
        </Button>
      </div>

      {/* Insufficient data */}
      {resolution.is_insufficient && (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <AlertDescription className="text-sm">
            <strong>Dados insuficientes para sugestão automática.</strong> O dataset não possui sinais claros que
            permitam definir um alvo com segurança para o objetivo declarado. Considere:
            <ul className="list-disc pl-4 mt-1 space-y-0.5 text-xs text-muted-foreground">
              <li>Verificar se o contrato de intenção está preenchido (Etapa 1)</li>
              <li>Usar o modo assistido para criar um alvo derivado</li>
              <li>Escolher uma coluna manualmente no seletor abaixo</li>
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Main candidate */}
      {main && (
        <div className={`p-4 rounded-lg border space-y-3 ${
          isApplied ? "border-accent/40 bg-accent/5" : "border-primary/30 bg-background"
        }`}>
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={strategyInfo.color}>{strategyInfo.icon}</span>
                <Badge variant="outline" className="text-[10px]">{strategyInfo.label}</Badge>
                <ConfidenceBadge score={resolution.confidence_score} />
                {isApplied && (
                  <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
                    <CheckCircle className="w-3 h-3 mr-0.5" /> Aplicado
                  </Badge>
                )}
              </div>
              <p className="text-lg font-semibold">{main.column}</p>
              <p className="text-sm text-muted-foreground">
                {main.problem_type === "classification" ? "Classificação" :
                 main.problem_type === "regression" ? "Regressão" :
                 main.problem_type === "multiclass" ? "Classificação multiclasse" :
                 main.problem_type === "ranking" ? "Ranking / priorização" :
                 main.problem_type === "segmentation" ? "Segmentação" : main.problem_type}
              </p>
            </div>
            {!isApplied && onApplyTarget && (
              <Button size="sm" disabled={persisting} onClick={() => applyFullSuggestion(main)}>
                <Zap className="w-3 h-3 mr-1" /> Aplicar sugestão
              </Button>
            )}
          </div>

          {main.reasoning && (
            <p className="text-sm text-muted-foreground">{main.reasoning}</p>
          )}

          {resolution.is_derived && main.derivation_formula && (
            <div className="p-2 bg-muted/30 rounded text-xs font-mono text-muted-foreground">
              {main.derivation_formula}
            </div>
          )}
        </div>
      )}

      {/* Business fit assessment */}
      {resolution.business_fit_assessment && (
        <div className="flex items-start gap-2 p-3 bg-muted/30 rounded-lg">
          <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">{resolution.business_fit_assessment}</p>
        </div>
      )}

      {/* Suggested entity/time */}
      {(resolution.suggested_entity_key || resolution.suggested_time_anchor) && (
        <div className="flex flex-wrap gap-2">
          {resolution.suggested_entity_key && (
            <Badge variant="outline" className="text-xs">
              Entidade sugerida: <strong className="ml-1">{resolution.suggested_entity_key}</strong>
            </Badge>
          )}
          {resolution.suggested_time_anchor && (
            <Badge variant="outline" className="text-xs">
              Tempo sugerido: <strong className="ml-1">{resolution.suggested_time_anchor}</strong>
            </Badge>
          )}
        </div>
      )}

      {/* Blocked targets */}
      {resolution.blocked_target_reasons.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" /> Alvos bloqueados
          </p>
          <div className="flex flex-wrap gap-1">
            {resolution.blocked_target_reasons.map((b, i) => (
              <Badge key={i} variant="outline" className="text-[10px] text-destructive/80 border-destructive/30">
                <XCircle className="w-2.5 h-2.5 mr-0.5" /> {b.column}: {b.reason}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Alternatives */}
      {resolution.alternatives.length > 0 && (
        <div className="space-y-2">
          <button
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setShowAlternatives(!showAlternatives)}
          >
            {showAlternatives ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showAlternatives ? "Ocultar alternativas" : `Ver ${resolution.alternatives.length} alternativa(s)`}
          </button>
          {showAlternatives && (
            <div className="grid gap-2 sm:grid-cols-2">
              {resolution.alternatives.map((alt, i) => (
                <div key={i} className="p-3 rounded-lg border border-border bg-background space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{alt.column}</p>
                    {alt.confidence && <ConfidenceBadge score={alt.confidence} />}
                  </div>
                  <p className="text-xs text-muted-foreground">{alt.reasoning}</p>
                    {onApplyTarget && (
                      <Button
                        variant="outline" size="sm" className="w-full h-6 text-[10px]"
                        disabled={persisting}
                        onClick={() => {
                          onApplyTarget(alt);
                          persistAppliedToSSOT(alt, resolution.suggested_entity_key, resolution.suggested_time_anchor);
                        }}
                      >
                      Usar esta alternativa
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reasoning */}
      {resolution.target_reasoning_summary && (
        <div className="space-y-1">
          <button
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setShowReasoning(!showReasoning)}
          >
            {showReasoning ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showReasoning ? "Ocultar raciocínio" : "Ver raciocínio completo"}
          </button>
          {showReasoning && (
            <div className="p-3 bg-muted/30 rounded-lg">
              <p className="text-xs text-muted-foreground whitespace-pre-line">{resolution.target_reasoning_summary}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
