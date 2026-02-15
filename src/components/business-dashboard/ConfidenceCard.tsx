import { Shield, ShieldCheck, ShieldAlert, ShieldX, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface ConfidenceCardProps {
  score: number | null;
  inputs?: {
    predictability_score: number | null;
    coverage_pct: number | null;
    missing_feature_pct: number | null;
    sanity_fail: boolean;
  };
}

export function ConfidenceCard({ score, inputs }: ConfidenceCardProps) {
  const displayScore = score ?? 0;
  const hasScore = score !== null;

  const getConfig = () => {
    if (!hasScore) return { icon: Shield, color: "text-muted-foreground", bg: "bg-muted", label: "Não calculado", progressColor: "bg-muted-foreground" };
    if (displayScore >= 70) return { icon: ShieldCheck, color: "text-emerald-600", bg: "bg-emerald-50 dark:bg-emerald-950/30", label: "Alta confiança", progressColor: "bg-emerald-500" };
    if (displayScore >= 40) return { icon: ShieldAlert, color: "text-amber-600", bg: "bg-amber-50 dark:bg-amber-950/30", label: "Confiança moderada", progressColor: "bg-amber-500" };
    return { icon: ShieldX, color: "text-destructive", bg: "bg-destructive/5", label: "Baixa confiança", progressColor: "bg-destructive" };
  };

  const config = getConfig();
  const Icon = config.icon;

  return (
    <Card className={`${config.bg} border`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className={`w-5 h-5 ${config.color}`} />
            <span className="text-sm font-semibold">Confiança do Modelo</span>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="w-4 h-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <p className="text-xs">
                  Combina qualidade do contrato preditivo ({inputs?.predictability_score ?? "N/A"}),
                  cobertura do scoring ({inputs?.coverage_pct?.toFixed(0) ?? "N/A"}%),
                  features ausentes ({inputs?.missing_feature_pct?.toFixed(0) ?? "N/A"}%)
                  {inputs?.sanity_fail ? " e sanity check reprovado" : ""}.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <div className="flex items-end gap-3">
          <span className={`text-3xl font-bold ${config.color}`}>
            {hasScore ? displayScore : "—"}
          </span>
          <span className="text-sm text-muted-foreground mb-1">/ 100</span>
        </div>

        <Progress value={displayScore} className="h-2" />

        <p className={`text-xs font-medium ${config.color}`}>{config.label}</p>
      </CardContent>
    </Card>
  );
}
