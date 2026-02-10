import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Target, TrendingUp, Shield, Zap } from "lucide-react";
import type { ColumnInferenceRow } from "./ColumnInferenceMatrix";

interface BlockedTargetCandidatesProps {
  columnInference: ColumnInferenceRow[];
}

const BlockedTargetCandidates = ({ columnInference }: BlockedTargetCandidatesProps) => {
  const { t } = useTranslation();

  // Find columns that are target candidates but have blocks
  const blockedCandidates = columnInference.filter(
    (c) =>
      (c.semantic_role === "TARGET_CANDIDATO_EVENTO" ||
        c.semantic_role === "TARGET_CANDIDATO_ESTADO") &&
      !c.can_be_target &&
      c.block_reasons.length > 0
  );

  if (blockedCandidates.length === 0) return null;

  return (
    <div className="space-y-2 p-4 border border-amber-500/30 bg-amber-500/5 rounded-xl">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
          {t("inference.blockedCandidates", "Targets candidatos detectados (não aprovados):")}
        </span>
      </div>

      <TooltipProvider delayDuration={200}>
        <div className="grid gap-2 sm:grid-cols-2">
          {blockedCandidates.map((candidate) => (
            <Card key={candidate.column_name} className="p-3 bg-background/50 border-amber-500/20">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  {candidate.semantic_role === "TARGET_CANDIDATO_EVENTO" ? (
                    <Zap className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <Shield className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
                  )}
                  <span className="font-mono text-sm font-semibold">
                    {candidate.column_name}
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    className="text-xs"
                  >
                    {candidate.semantic_role === "TARGET_CANDIDATO_EVENTO"
                      ? t("inference.eventType", "Evento")
                      : t("inference.stateType", "Estado")}
                  </Badge>
                  <span className={`text-xs font-medium ${
                    candidate.confidence_score >= 0.6 ? "text-secondary" : "text-muted-foreground"
                  }`}>
                    {t("inference.confidence", "Confiança")}: {(candidate.confidence_score * 100).toFixed(0)}%
                  </span>
                </div>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-start gap-1 cursor-help">
                      <AlertTriangle className="w-3 h-3 text-destructive mt-0.5 flex-shrink-0" />
                      <span className="text-xs text-destructive">
                        {candidate.block_reasons[0]}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="space-y-1">
                      <p className="font-semibold text-xs">Todos os motivos:</p>
                      {candidate.block_reasons.map((r, i) => (
                        <p key={i} className="text-xs">• {r}</p>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            </Card>
          ))}
        </div>
      </TooltipProvider>
    </div>
  );
};

export default BlockedTargetCandidates;
