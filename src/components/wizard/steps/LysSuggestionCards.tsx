import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sparkles, AlertTriangle, Check, Target, TrendingUp } from "lucide-react";

export interface TargetSuggestion {
  id: string;
  target_column: string;
  problem_type: "classification" | "regression";
  confidence: number;
  reasoning: string;
  warnings: string[];
  recommended_features: string[];
  excluded_features: string[];
}

interface LysSuggestionCardsProps {
  suggestions: TargetSuggestion[];
  onApply: (suggestion: TargetSuggestion) => void;
  appliedId?: string | null;
}

const LysSuggestionCards = ({ suggestions, onApply, appliedId }: LysSuggestionCardsProps) => {
  const { t } = useTranslation();

  const getConfidenceBadge = (confidence: number | null | undefined) => {
    if (confidence == null) {
      return <Badge variant="outline" className="text-muted-foreground">—</Badge>;
    }
    if (confidence >= 0.8) {
      return <Badge className="bg-accent/20 text-accent border-accent/30">{t("lysSuggestions.highConfidence", "Alta confiança")}</Badge>;
    }
    if (confidence >= 0.6) {
      return <Badge className="bg-secondary/20 text-secondary border-secondary/30">{t("lysSuggestions.mediumConfidence", "Confiança média")}</Badge>;
    }
    return <Badge variant="outline">{t("lysSuggestions.lowConfidence", "Confiança baixa")}</Badge>;
  };

  const getProblemIcon = (type: string) => {
    return type === "classification" ? (
      <Target className="w-4 h-4" />
    ) : (
      <TrendingUp className="w-4 h-4" />
    );
  };

  if (suggestions.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground text-sm">
        {t("lysSuggestions.noSuggestions", "Nenhuma sugestão disponível para este dataset.")}
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {suggestions.map((sug) => {
        const isApplied = appliedId === sug.id;
        return (
          <Card
            key={sug.id}
            className={`p-4 transition-all ${
              isApplied
                ? "border-accent bg-accent/5 shadow-md"
                : "hover:border-primary/40 hover:shadow-sm"
            }`}
          >
            <div className="space-y-3">
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  {getProblemIcon(sug.problem_type)}
                  <span className="font-semibold text-sm truncate">{sug.target_column}</span>
                </div>
                {getConfidenceBadge(sug.confidence)}
              </div>

              {/* Problem type badge */}
              <Badge variant="secondary" className="text-xs">
                {sug.problem_type === "classification"
                  ? t("project.classification", "Classificação")
                  : t("project.regression", "Regressão")}
              </Badge>

              {/* Reasoning */}
              <p className="text-xs text-muted-foreground leading-relaxed">
                {sug.reasoning}
              </p>

              {/* Warnings */}
              {sug.warnings.length > 0 && (
                <div className="space-y-1">
                  {sug.warnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
                    >
                      <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Features summary */}
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">
                  {sug.recommended_features.length} {t("lysSuggestions.featuresRecommended", "features recomendadas")}
                </span>
                {sug.excluded_features.length > 0 && (
                  <span className="ml-2">
                    · {sug.excluded_features.length} {t("lysSuggestions.excluded", "excluídas")}
                  </span>
                )}
              </div>

              {/* Apply button */}
              <Button
                size="sm"
                variant={isApplied ? "default" : "outline"}
                className={`w-full ${isApplied ? "bg-accent hover:bg-accent/90" : ""}`}
                onClick={() => onApply(sug)}
                disabled={isApplied}
              >
                {isApplied ? (
                  <>
                    <Check className="w-3.5 h-3.5 mr-1.5" />
                    {t("lysSuggestions.applied", "Aplicada")}
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    {t("lysSuggestions.apply", "Aplicar sugestão")}
                  </>
                )}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
};

export default LysSuggestionCards;
