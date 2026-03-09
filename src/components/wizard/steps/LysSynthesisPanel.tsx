import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Loader2, RefreshCw, Target, AlertTriangle, CheckCircle, Lightbulb, ShieldAlert } from "lucide-react";
import type { LysSynthesisResult, LysRecommendation } from "@/hooks/useLysSynthesis";

interface LysSynthesisPanelProps {
  synthesis: LysSynthesisResult;
  loading: boolean;
  generating: boolean;
  error: string | null;
  onGenerate: () => void;
  onApplyRecommendation?: (rec: LysRecommendation) => void;
}

const LysSynthesisPanel = ({
  synthesis,
  loading,
  generating,
  error,
  onGenerate,
  onApplyRecommendation,
}: LysSynthesisPanelProps) => {
  const { t } = useTranslation();
  const { narrative, recommendation, confidence_score } = synthesis;

  const hasContent = !!narrative || !!recommendation;

  const getConfidenceBadge = () => {
    if (confidence_score === null) return null;
    if (confidence_score >= 0.8) {
      return <Badge className="bg-accent/20 text-accent border-accent/30 text-xs">Alta confiança ({Math.round(confidence_score * 100)}%)</Badge>;
    }
    if (confidence_score >= 0.5) {
      return <Badge className="bg-secondary/20 text-secondary border-secondary/30 text-xs">Confiança média ({Math.round(confidence_score * 100)}%)</Badge>;
    }
    return <Badge variant="outline" className="text-xs">Confiança baixa ({Math.round(confidence_score * 100)}%)</Badge>;
  };

  return (
    <Card className="bg-gradient-card shadow-card p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Síntese da Lys</h3>
            <p className="text-xs text-muted-foreground">EDA + Target Discovery + Contrato de Intenção</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {getConfidenceBadge()}
          <Button
            variant="outline"
            size="sm"
            onClick={onGenerate}
            disabled={generating || loading}
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : hasContent ? (
              <RefreshCw className="w-4 h-4" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span className="ml-1.5 text-xs">
              {generating ? "Analisando…" : hasContent ? "Recalcular" : "Gerar síntese"}
            </span>
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {/* Loading */}
      {(generating || loading) && !hasContent && (
        <div className="flex items-center justify-center py-8 gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Consolidando EDA, Discovery e Intenção…</span>
        </div>
      )}

      {/* Narrative */}
      {narrative && (
        <div className="p-4 bg-muted/30 rounded-lg space-y-2">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb className="w-4 h-4 text-primary" />
            <span className="text-xs font-medium text-primary">Análise do cenário</span>
          </div>
          <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
            {narrative.split('**').map((part, i) =>
              i % 2 === 1 ? <strong key={i}>{part}</strong> : part
            )}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {recommendation && (
        <div className="space-y-3">
          {/* Target + problem type */}
          {recommendation.suggested_target && (
            <div className="flex items-start gap-3 p-3 bg-accent/5 border border-accent/20 rounded-lg">
              <Target className="w-4 h-4 text-accent mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-medium">Alvo recomendado</p>
                <p className="text-sm font-semibold text-accent">{recommendation.suggested_target}</p>
                {recommendation.suggested_problem_type && (
                  <Badge variant="secondary" className="mt-1 text-[10px]">
                    {recommendation.suggested_problem_type === "classification" ? "Classificação" : "Regressão"}
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Entity key + time anchor */}
          <div className="grid grid-cols-2 gap-2">
            {recommendation.suggested_entity_key && (
              <div className="p-2 bg-muted/30 rounded-lg">
                <p className="text-[10px] text-muted-foreground">Entidade</p>
                <p className="text-xs font-medium">{recommendation.suggested_entity_key}</p>
              </div>
            )}
            {recommendation.suggested_time_anchor && (
              <div className="p-2 bg-muted/30 rounded-lg">
                <p className="text-[10px] text-muted-foreground">Âncora temporal</p>
                <p className="text-xs font-medium">{recommendation.suggested_time_anchor}</p>
              </div>
            )}
          </div>

          {/* Leakage risks */}
          {recommendation.leakage_risks && recommendation.leakage_risks.length > 0 && (
            <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg space-y-1.5">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-destructive" />
                <span className="text-xs font-medium text-destructive">Riscos de leakage</span>
              </div>
              {recommendation.leakage_risks.map((r, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs">
                  <AlertTriangle className="w-3 h-3 mt-0.5 text-destructive/70 flex-shrink-0" />
                  <span><strong>{r.column}</strong> — {r.reason}</span>
                </div>
              ))}
            </div>
          )}

          {/* Features summary */}
          {recommendation.suggested_features && recommendation.suggested_features.length > 0 && (
            <div className="p-3 bg-muted/30 rounded-lg">
              <p className="text-xs font-medium mb-1">
                <CheckCircle className="w-3 h-3 inline mr-1 text-accent" />
                {recommendation.suggested_features.length} features recomendadas
              </p>
              <p className="text-[10px] text-muted-foreground">
                {recommendation.suggested_features.slice(0, 8).join(", ")}
                {recommendation.suggested_features.length > 8 && ` e mais ${recommendation.suggested_features.length - 8}`}
              </p>
            </div>
          )}

          {/* Blocked features */}
          {recommendation.blocked_features && recommendation.blocked_features.length > 0 && (
            <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
              <p className="text-xs font-medium mb-1">
                <AlertTriangle className="w-3 h-3 inline mr-1 text-amber-600" />
                {recommendation.blocked_features.length} features a excluir
              </p>
              {recommendation.blocked_features.map((f, i) => (
                <p key={i} className="text-[10px] text-muted-foreground">
                  <strong>{f.column}</strong>: {f.reason}
                </p>
              ))}
            </div>
          )}

          {/* Alternative targets */}
          {recommendation.alternative_target_candidates && recommendation.alternative_target_candidates.length > 0 && (
            <div className="p-3 bg-muted/30 rounded-lg">
              <p className="text-xs font-medium mb-1">Alvos alternativos</p>
              {recommendation.alternative_target_candidates.map((c, i) => (
                <p key={i} className="text-[10px] text-muted-foreground">
                  <strong>{c.column}</strong> ({c.problem_type}) — {c.reason}
                </p>
              ))}
            </div>
          )}

          {/* Apply button */}
          {onApplyRecommendation && recommendation.suggested_target && (
            <Button
              size="sm"
              className="w-full bg-gradient-primary"
              onClick={() => onApplyRecommendation(recommendation)}
            >
              <Sparkles className="w-4 h-4 mr-1.5" />
              Aplicar recomendações da Lys
            </Button>
          )}

          {/* Reasoning */}
          {recommendation.reasoning_summary && (
            <p className="text-[10px] text-muted-foreground italic">
              {recommendation.reasoning_summary}
            </p>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasContent && !generating && !loading && !error && (
        <div className="text-center py-6">
          <Sparkles className="w-10 h-10 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            A Lys analisará seu EDA e Target Discovery para gerar recomendações estruturadas.
          </p>
          <Button variant="outline" size="sm" onClick={onGenerate} className="mt-3">
            <Sparkles className="w-4 h-4 mr-1.5" />
            Gerar síntese
          </Button>
        </div>
      )}
    </Card>
  );
};

export default LysSynthesisPanel;
