import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Sparkles,
  AlertTriangle,
  Check,
  Target,
  TrendingUp,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { SuggestedTarget } from "@/hooks/useProblemInference";

interface TargetCardProps {
  target: SuggestedTarget;
  isApplied: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onApply: () => void;
}

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

const TargetCard = ({
  target,
  isApplied,
  isExpanded,
  onToggleExpand,
  onApply,
}: TargetCardProps) => {
  const { t } = useTranslation();

  return (
    <Card
      className={`p-3 transition-all cursor-pointer ${
        isApplied
          ? "border-accent bg-accent/5 shadow-md"
          : "hover:border-primary/40 hover:shadow-sm"
      }`}
      onClick={onToggleExpand}
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
            <Badge variant="secondary" className="text-xs flex-shrink-0">
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
                    className="flex items-start gap-1.5 text-xs text-destructive/80"
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
                  onApply();
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
                  {t("inference.applyTarget", "Aplicar como target")}
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
};

export default TargetCard;
