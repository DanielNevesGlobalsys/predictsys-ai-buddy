import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bot,
  Sparkles,
  Loader2,
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  RefreshCw,
  Target,
  Eye,
} from "lucide-react";
import { useState } from "react";
import type { ProblemInference } from "@/hooks/useProblemInference";
import IndustryBadge from "./IndustryBadge";

interface ProblemInferencePanelProps {
  inference: ProblemInference | null;
  loading: boolean;
  error: string | null;
  onGenerate: () => void;
  hasEDA: boolean;
  /** If target is already configured, render compact mode */
  targetSource?: string | null;
  /** Scroll/focus callback to target builder */
  onScrollToBuilder?: () => void;
  /** Scroll/focus callback to active target cards */
  onScrollToActiveTarget?: () => void;
}

const ProblemInferencePanel = ({
  inference,
  loading,
  error,
  onGenerate,
  hasEDA,
  targetSource,
  onScrollToBuilder,
  onScrollToActiveTarget,
}: ProblemInferencePanelProps) => {
  const { t } = useTranslation();
  const [showNarrative, setShowNarrative] = useState(false);

  const isCompact = !!targetSource;

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
          {isCompact && (
            <Badge variant="outline" className="text-[10px]">compacto</Badge>
          )}
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

      {!inference && !loading && (
        <p className="text-xs text-muted-foreground">
          A Lys ajuda a entender o objetivo do projeto.
          Para escolher ou gerar a variável alvo, utilize a seção "Forma de construir o alvo" abaixo.
        </p>
      )}

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

          {/* Detected problem type */}
          {inference.problem_type && (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                Tipo detectado: {inference.problem_type === "classification" ? "Classificação" : "Regressão"}
              </Badge>
            </div>
          )}

          {/* Didactic guidance (compact vs full) */}
          <div className="p-3 bg-primary/5 border border-primary/15 rounded-lg">
            <p className="text-xs text-foreground leading-relaxed">
              A Lys ajuda a entender o objetivo do projeto.
              Para escolher ou gerar a variável alvo, utilize a seção <strong>"Forma de construir o alvo"</strong> abaixo.
            </p>
          </div>

          {/* CTA Button */}
          {isCompact ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onScrollToActiveTarget}
            >
              <Eye className="w-3.5 h-3.5 mr-1.5" />
              Ver alvo ativo
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onScrollToBuilder}
            >
              <Target className="w-3.5 h-3.5 mr-1.5" />
              Configurar alvo
            </Button>
          )}

          {/* Narrative toggle (only in full mode) */}
          {!isCompact && inference.narrative && (
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

export default ProblemInferencePanel;
