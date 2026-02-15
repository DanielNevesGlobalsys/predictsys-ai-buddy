import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Trophy, Shield, Target, BarChart3, ChevronDown, Rocket, Eye, Info, AlertTriangle, CheckCircle } from "lucide-react";
import { useState } from "react";
import { resolveMetricsProfile, type MetricsProfile } from "@/config/metricsProfiles";

interface ModelRanking {
  model_id: string;
  name: string;
  score: number;
  sanity: boolean;
  is_champion: boolean;
  metrics?: Record<string, number>;
}

interface CalibrationInfo {
  method: string;
  brier_before?: number;
  brier_after?: number;
}

interface TrainingResultsPanelProps {
  projectId: string;
  problemType: string;
  models: ModelRanking[];
  champion: ModelRanking | null;
  calibration?: CalibrationInfo | null;
  recommendedThreshold?: number | null;
  profile?: MetricsProfile | null;
  profileSource?: string;
  predictabilityScore?: number | null;
  auditStatus?: string | null;
  onDeploy?: () => void;
  canDeploy?: boolean;
}

function metricLabel(key: string): string {
  const map: Record<string, string> = {
    AUC: "AUC-ROC",
    "R²": "R²",
    F1: "F1-Score",
    Recall: "Recall (Sensibilidade)",
    "Precisão": "Precisão",
    Acurácia: "Acurácia",
    MAE: "Erro Absoluto Médio",
    RMSE: "Erro Quadrático Médio",
    pr_auc: "PR-AUC",
    brier: "Brier Score",
  };
  return map[key] || key;
}

function scoreColor(val: number, isError = false): string {
  if (isError) return val < 0.5 ? "text-accent" : "text-destructive";
  return val >= 0.8 ? "text-accent" : val >= 0.6 ? "text-amber-500" : "text-destructive";
}

function getBusinessExplanation(profile: MetricsProfile, primaryScore: number, isWeak: boolean): string {
  if (isWeak) return profile.explanation.weak;
  return profile.explanation.good;
}

export default function TrainingResultsPanel({
  problemType,
  models,
  champion,
  calibration,
  recommendedThreshold,
  profile,
  profileSource,
  predictabilityScore,
  auditStatus,
  onDeploy,
  canDeploy = true,
}: TrainingResultsPanelProps) {
  const [showChallengers, setShowChallengers] = useState(false);

  if (!champion) return null;

  const effectiveProfile = profile || resolveMetricsProfile({}, {}, problemType).profile;
  const primaryMetricKey = effectiveProfile.primary;
  const primaryScore = champion.metrics?.[primaryMetricKey] ?? champion.score;
  const isClassification = problemType === "classification";
  const isWeak = primaryScore < (isClassification ? 0.6 : 0.3);
  const isRegError = ["MAE", "RMSE"].includes(primaryMetricKey);

  return (
    <Card className="p-5 space-y-4 border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      {/* Header: Champion */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
            <Trophy className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h3 className="text-sm font-bold">Modelo Campeão</h3>
            <p className="text-xs text-muted-foreground">{champion.name}</p>
          </div>
        </div>
        <div className="text-right">
          <span className={`text-2xl font-bold ${scoreColor(primaryScore, isRegError)}`}>
            {isRegError ? primaryScore.toFixed(2) : `${(primaryScore * 100).toFixed(1)}%`}
          </span>
          <p className="text-[10px] text-muted-foreground">{metricLabel(primaryMetricKey)}</p>
        </div>
      </div>

      {/* Business explanation */}
      <div className={`rounded-lg p-3 text-xs ${isWeak ? "bg-amber-500/10 border border-amber-500/30" : "bg-accent/10 border border-accent/30"}`}>
        <div className="flex items-start gap-2">
          {isWeak ? <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" /> : <CheckCircle className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />}
          <div>
            <p className="font-medium mb-1">{isWeak ? "Atenção" : "O que isso significa?"}</p>
            <p className="text-muted-foreground">{getBusinessExplanation(effectiveProfile, primaryScore, isWeak)}</p>
          </div>
        </div>
      </div>

      {/* Key cards row */}
      <div className="grid grid-cols-3 gap-2">
        {/* Calibration card */}
        <div className="bg-background/60 rounded-lg p-2.5 text-center space-y-1">
          <Shield className="w-4 h-4 mx-auto text-primary" />
          <p className="text-[10px] text-muted-foreground">Calibragem</p>
          {calibration && calibration.method !== "none" ? (
            <>
              <p className="text-xs font-semibold capitalize">{calibration.method}</p>
              {calibration.brier_before != null && calibration.brier_after != null && (
                <p className="text-[10px] text-muted-foreground">
                  Brier: {calibration.brier_before.toFixed(3)} → {calibration.brier_after.toFixed(3)}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">—</p>
          )}
        </div>

        {/* Threshold card */}
        <div className="bg-background/60 rounded-lg p-2.5 text-center space-y-1">
          <Target className="w-4 h-4 mx-auto text-primary" />
          <p className="text-[10px] text-muted-foreground">Threshold</p>
          {recommendedThreshold != null && isClassification ? (
            <>
              <p className="text-xs font-semibold">{(recommendedThreshold * 100).toFixed(0)}%</p>
              <p className="text-[10px] text-muted-foreground">
                {effectiveProfile.threshold_strategy === "max_recall_min_precision" ? "prioriza recall"
                  : effectiveProfile.threshold_strategy === "max_precision_at_k" ? "prioriza precisão"
                  : effectiveProfile.threshold_strategy === "max_recall" ? "máx. sensibilidade"
                  : effectiveProfile.threshold_strategy === "max_f1" ? "equilíbrio (F1)"
                  : "recomendado"}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{isClassification ? "50%" : "N/A"}</p>
          )}
        </div>

        {/* Profile card */}
        <div className={`bg-background/60 rounded-lg p-2.5 text-center space-y-1 ${profileSource?.includes("fallback") ? "ring-1 ring-amber-500/40" : ""}`}>
          <BarChart3 className="w-4 h-4 mx-auto text-primary" />
          <p className="text-[10px] text-muted-foreground">Perfil</p>
          <p className="text-xs font-semibold">{effectiveProfile.label}</p>
          {profileSource && profileSource.includes("fallback") && (
            <Badge variant="outline" className="text-[9px] border-amber-500/50 text-amber-600">
              <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />genérico
            </Badge>
          )}
        </div>
      </div>

      {/* Audit score (if available) */}
      {predictabilityScore != null && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Predictability Score</span>
            <span className={scoreColor(predictabilityScore / 100)}>{predictabilityScore}/100</span>
          </div>
          <Progress value={predictabilityScore} className="h-1.5" />
        </div>
      )}

      {/* Secondary metrics */}
      {champion.metrics && Object.keys(champion.metrics).length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(champion.metrics)
            .filter(([k]) => k !== primaryMetricKey)
            .slice(0, 4)
            .map(([key, val]) => (
              <Badge key={key} variant="outline" className="text-[10px] gap-1">
                {metricLabel(key)}: {typeof val === "number" ? (["MAE", "RMSE", "MSE"].includes(key) ? val.toFixed(2) : (val * 100).toFixed(1) + "%") : val}
              </Badge>
            ))}
        </div>
      )}

      {/* Metric meaning tooltip */}
      <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
        <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <span>{effectiveProfile.explanation.metric_meaning}</span>
      </div>

      {/* Challengers */}
      {models.length > 1 && (
        <Collapsible open={showChallengers} onOpenChange={setShowChallengers}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between text-xs h-7">
              <span className="flex items-center gap-1.5">
                <Eye className="w-3 h-3" />
                Comparar modelos ({models.length})
              </span>
              <ChevronDown className={`w-3 h-3 transition-transform ${showChallengers ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-1">
            {models.map((m, i) => (
              <div
                key={m.model_id}
                className={`flex items-center justify-between text-xs py-1.5 px-3 rounded ${m.is_champion ? "bg-accent/10 border border-accent/20" : "bg-background/50"}`}
              >
                <div className="flex items-center gap-2">
                  {m.is_champion && <Trophy className="w-3 h-3 text-accent" />}
                  <span className={m.is_champion ? "font-medium" : ""}>{m.name}</span>
                  {!m.sanity && <Badge variant="destructive" className="text-[9px]">sanity fail</Badge>}
                </div>
                <span className={`font-mono ${scoreColor(m.score, isRegError)}`}>
                  {isRegError ? m.score.toFixed(3) : (m.score * 100).toFixed(1) + "%"}
                </span>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Deploy CTA */}
      {onDeploy && (
        <Button
          className="w-full"
          disabled={!canDeploy || auditStatus === "block"}
          onClick={onDeploy}
        >
          <Rocket className="w-4 h-4 mr-2" />
          {auditStatus === "block" ? "Auditoria bloqueada — corrija antes" : "Deploy do Campeão"}
        </Button>
      )}
    </Card>
  );
}
