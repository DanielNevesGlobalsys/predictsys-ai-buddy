import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Trophy, Cpu, TrendingUp, HelpCircle, Sparkles } from "lucide-react";

interface SmartTrainingPanelProps {
  recommendedModel: {
    name: string;
    reason: string;
    strength: string;
    metric: string;
    metricValue: number;
  } | null;
  problemType: string;
  detectedProblemType?: string | null;
  userProblemType: string;
}

const SmartTrainingPanel = ({
  recommendedModel,
  problemType,
  detectedProblemType,
  userProblemType,
}: SmartTrainingPanelProps) => {
  const { t } = useTranslation();

  const problemTypeSource = detectedProblemType && detectedProblemType !== userProblemType
    ? "detected"
    : "user";

  if (!recommendedModel) {
    return null;
  }

  return (
    <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20 p-6">
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 bg-gradient-primary rounded-xl flex items-center justify-center flex-shrink-0">
          <Trophy className="w-7 h-7 text-primary-foreground" />
        </div>
        
        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-lg">
              {t("training.recommendedModel")}
            </h3>
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="w-3 h-3" />
              {t("training.smartSelection")}
            </Badge>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-card px-3 py-2 rounded-lg">
              <Cpu className="w-4 h-4 text-primary" />
              <span className="font-semibold">{recommendedModel.name}</span>
            </div>
            
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 bg-accent/20 px-3 py-2 rounded-lg cursor-help">
                    <TrendingUp className="w-4 h-4 text-accent" />
                    <span className="font-semibold">{recommendedModel.metric}:</span>
                    <span className="text-accent font-bold">
                      {recommendedModel.metricValue.toFixed(4)}
                    </span>
                    <HelpCircle className="w-3.5 h-3.5 text-muted-foreground ml-1" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-sm text-sm">
                  <p>
                    {problemType === "classification" 
                      ? t("training.metricExplanation.AUC")
                      : t("training.metricExplanation.R2")
                    }
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              <strong className="text-foreground">{t("training.whyRecommended")}:</strong>{" "}
              {recommendedModel.reason}
            </p>
            <p>
              <strong className="text-foreground">{t("training.strength")}:</strong>{" "}
              {recommendedModel.strength}
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t border-border/50">
            <span>
              {t("training.problemType")}: <strong>{t(`project.${problemType}`)}</strong>
            </span>
            <span className="text-muted-foreground/50">•</span>
            <span>
              {problemTypeSource === "detected" 
                ? t("training.autoDetected")
                : t("training.userSelected")
              }
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default SmartTrainingPanel;
