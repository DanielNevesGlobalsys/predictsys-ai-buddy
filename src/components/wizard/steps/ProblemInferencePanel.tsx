import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Bot,
  Sparkles,
  Loader2,
  AlertTriangle,
  Check,
  Target,
  TrendingUp,
  Brain,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import type {
  ProblemInference,
  SuggestedTarget,
  SuggestedPredictor,
} from "@/hooks/useProblemInference";

interface ProblemInferencePanelProps {
  inference: ProblemInference | null;
  loading: boolean;
  error: string | null;
  onGenerate: () => void;
  onApplyTarget: (target: SuggestedTarget, predictors: SuggestedPredictor[]) => void;
  appliedTargetColumn?: string | null;
  hasEDA: boolean;
}

const ProblemInferencePanel = ({
  inference,
  loading,
  error,
  onGenerate,
  onApplyTarget,
  appliedTargetColumn,
  hasEDA,
}: ProblemInferencePanelProps) => {
  const { t } = useTranslation();
  const [expandedTarget, setExpandedTarget] = useState<string | null>(null);
  const [showNarrative, setShowNarrative] = useState(false);

  if (!hasEDA) {
    return (
      <div className="p-5 border border-secondary/30 rounded-xl bg-secondary/5">
        <div className="flex items-center gap-2 mb-3">
          <Bot className="w-5 h-5 text-secondary" />
          <h3 className="font-semibold text-sm">
            {t("inference.title", "Inferência de Problema — Lys")}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(
            "inference.needEDA",
            "Gere o EDA para receber sugestões da Lys. A análise exploratória é necessária para identificar problemas de negócio no seu dataset."
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-5 border border-secondary/30 rounded-xl bg-secondary/5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-secondary" />
          <h3 className="font-semibold text-sm">
            {t("inference.title", "Inferência de Problema — Lys")}
          </h3>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onGenerate}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              {t("inference.analyzing", "Analisando...")}
            </>
          ) : inference ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              {t("inference.refresh", "Reanalisar")}
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              {t("inference.generate", "Analisar dataset")}
            </>
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          "inference.description",
          "A Lys analisa o EDA e identifica problemas de negócio, targets e colunas preditoras — tudo por heurística, sem custo de IA."
        )}
      </p>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Inference Results */}
      {inference && (
        <div className="space-y-4">
          {/* Problem labels */}
          {inference.suggested_problem_labels.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-secondary" />
                <span className="text-sm font-medium">
                  {t("inference.suggestedProblems", "Problemas identificados")}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {inference.suggested_problem_labels.map((label) => (
                  <Badge
                    key={label.label}
                    variant="secondary"
                    className="text-xs"
                  >
                    {label.label}
                    <span className="ml-1 opacity-60">
                      {(label.relevance * 100).toFixed(0)}%
                    </span>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Target suggestions */}
          {inference.suggested_targets.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">
                  {t("inference.suggestedTargets", "Targets sugeridos")}
                </span>
                <Badge variant="outline" className="text-xs">
                  {inference.suggested_targets.length}
                </Badge>
              </div>

              <div className="grid gap-2">
                {inference.suggested_targets.map((target) => {
                  const isApplied = appliedTargetColumn === target.column;
                  const isExpanded = expandedTarget === target.column;

                  return (
                    <Card
                      key={target.column}
                      className={`p-3 transition-all cursor-pointer ${
                        isApplied
                          ? "border-accent bg-accent/5 shadow-md"
                          : "hover:border-primary/40 hover:shadow-sm"
                      }`}
                      onClick={() =>
                        setExpandedTarget(isExpanded ? null : target.column)
                      }
                    >
                      <div className="space-y-2">
                        {/* Target header */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {target.type === "regression" ? (
                              <TrendingUp className="w-4 h-4 text-secondary flex-shrink-0" />
                            ) : (
                              <Target className="w-4 h-4 text-primary flex-shrink-0" />
                            )}
                            <span className="font-semibold text-sm truncate">
                              {target.column}
                            </span>
                            <Badge
                              variant="secondary"
                              className="text-xs flex-shrink-0"
                            >
                              {target.type === "binary"
                                ? t("inference.binary", "Binária")
                                : target.type === "class"
                                ? t("inference.multiclass", "Multiclasse")
                                : t("inference.regression", "Regressão")}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <ConfidenceBadge confidence={target.confidence} />
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            )}
                          </div>
                        </div>

                        {/* Business summary (always visible) */}
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {target.business_summary}
                        </p>

                        {/* Expanded details */}
                        {isExpanded && (
                          <div className="space-y-2 pt-2 border-t border-border">
                            {/* Why this target */}
                            <div className="text-xs">
                              <span className="font-medium">
                                {t("inference.why", "Por que essa sugestão?")}
                              </span>
                              <p className="text-muted-foreground mt-0.5">
                                {target.why_this_target}
                              </p>
                            </div>

                            {/* Caveats */}
                            {target.caveats.length > 0 && (
                              <div className="space-y-1">
                                {target.caveats.map((c, i) => (
                                  <div
                                    key={i}
                                    className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
                                  >
                                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                    <span>{c}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Apply button */}
                            <Button
                              size="sm"
                              variant={isApplied ? "default" : "outline"}
                              className={`w-full ${
                                isApplied ? "bg-accent hover:bg-accent/90" : ""
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!isApplied) {
                                  onApplyTarget(
                                    target,
                                    inference.suggested_predictors
                                  );
                                }
                              }}
                              disabled={isApplied}
                            >
                              {isApplied ? (
                                <>
                                  <Check className="w-3.5 h-3.5 mr-1.5" />
                                  {t("inference.applied", "Aplicada")}
                                </>
                              ) : (
                                <>
                                  <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                                  {t(
                                    "inference.applyTarget",
                                    "Aplicar como target"
                                  )}
                                </>
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* Top predictors summary */}
          {inference.suggested_predictors.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-secondary" />
                <span className="text-sm font-medium">
                  {t(
                    "inference.topPredictors",
                    "Melhores preditoras"
                  )}
                </span>
                <Badge variant="outline" className="text-xs">
                  {inference.suggested_predictors.length}{" "}
                  {t("inference.columns", "colunas")}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-1">
                {inference.suggested_predictors.slice(0, 8).map((p) => (
                  <Badge
                    key={p.column}
                    variant="outline"
                    className="text-xs font-mono"
                  >
                    {p.column}
                  </Badge>
                ))}
                {inference.suggested_predictors.length > 8 && (
                  <Badge variant="outline" className="text-xs">
                    +{inference.suggested_predictors.length - 8}
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Narrative toggle */}
          {inference.narrative && (
            <div className="space-y-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() => setShowNarrative(!showNarrative)}
              >
                <Bot className="w-3.5 h-3.5 mr-1.5" />
                {showNarrative
                  ? t("inference.hideNarrative", "Ocultar análise completa")
                  : t("inference.showNarrative", "Ver análise completa da Lys")}
                {showNarrative ? (
                  <ChevronUp className="w-3.5 h-3.5 ml-1" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 ml-1" />
                )}
              </Button>
              {showNarrative && (
                <div className="p-4 bg-background rounded-lg border text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
                  {inference.narrative}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function ConfidenceBadge({ confidence }: { confidence: number }) {
  if (confidence >= 0.8) {
    return (
      <Badge className="bg-accent/20 text-accent border-accent/30 text-xs">
        {(confidence * 100).toFixed(0)}%
      </Badge>
    );
  }
  if (confidence >= 0.6) {
    return (
      <Badge className="bg-secondary/20 text-secondary border-secondary/30 text-xs">
        {(confidence * 100).toFixed(0)}%
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs">
      {(confidence * 100).toFixed(0)}%
    </Badge>
  );
}

export default ProblemInferencePanel;
