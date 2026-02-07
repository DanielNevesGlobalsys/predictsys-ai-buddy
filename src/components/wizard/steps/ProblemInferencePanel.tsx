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
  Building2,
} from "lucide-react";
import { useState } from "react";
import type {
  ProblemInference,
  SuggestedTarget,
  SuggestedPredictor,
} from "@/hooks/useProblemInference";
import IndustryBadge from "./IndustryBadge";
import TargetCard from "./TargetCard";

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
          "A Lys analisa o EDA, identifica o segmento de negócio e infere problemas previsíveis — tudo por heurística, sem custo de IA."
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
          {/* Industry detection */}
          {inference.industry && inference.industry.label !== "generic" && (
            <IndustryBadge industry={inference.industry} />
          )}

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

          {/* Didactic summary */}
          {inference.industry && inference.suggested_targets.length > 0 && (
            <div className="p-3 bg-primary/5 border border-primary/15 rounded-lg">
              <p className="text-xs text-foreground leading-relaxed">
                {getDidacticText(
                  inference.industry.label,
                  inference.suggested_targets[0],
                  t
                )}
              </p>
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
                {inference.suggested_targets.map((target) => (
                  <TargetCard
                    key={target.column}
                    target={target}
                    isApplied={appliedTargetColumn === target.column}
                    isExpanded={expandedTarget === target.column}
                    onToggleExpand={() =>
                      setExpandedTarget(
                        expandedTarget === target.column ? null : target.column
                      )
                    }
                    onApply={() =>
                      onApplyTarget(target, inference.suggested_predictors)
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {/* Top predictors summary */}
          {inference.suggested_predictors.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-secondary" />
                <span className="text-sm font-medium">
                  {t("inference.topPredictors", "Melhores preditoras")}
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

function getDidacticText(
  industryLabel: string,
  bestTarget: SuggestedTarget,
  t: any
): string {
  const targetType = bestTarget.type === "regression" ? "regressão" : "classificação";

  const industryTexts: Record<string, string> = {
    education:
      "Com base nos dados importados, identificamos um padrão típico do setor educacional. O modelo sugere prever eventos que impactam a jornada do aluno, permitindo ações preventivas pela instituição.",
    retail_shopping:
      "Os dados apresentam características de varejo/shopping. O modelo pode antecipar comportamentos de lojistas e clientes, viabilizando estratégias comerciais mais assertivas.",
    healthcare:
      "O perfil dos dados é compatível com o setor de saúde. Modelos preditivos aqui podem reduzir custos, melhorar a alocação de recursos e antecipar eventos clínicos.",
    logistics:
      "O dataset tem perfil logístico. Predições podem melhorar pontualidade, reduzir custos com devoluções e otimizar a cadeia de suprimentos.",
    financial:
      "Os dados apresentam perfil financeiro. Modelos preditivos auxiliam na gestão de risco, aprovação de crédito e prevenção de inadimplência.",
    generic:
      `Com base nos padrões estatísticos, o modelo sugere um problema de ${targetType} que pode ser usado para antecipar eventos e apoiar decisões de negócio.`,
  };

  return industryTexts[industryLabel] || industryTexts.generic;
}

export default ProblemInferencePanel;
