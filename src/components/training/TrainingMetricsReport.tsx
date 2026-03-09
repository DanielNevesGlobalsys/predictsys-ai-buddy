import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertTriangle, ChevronDown, Shield, Target, BarChart3, Info, CheckCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { getValidMetricsForProblemType, normalizeProblemFamily } from "@/config/metricsProfiles";

interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

interface ThresholdPoint {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
}

interface ExtendedMetrics {
  base_rate: number;
  precision_at_5: number;
  precision_at_10: number;
  precision_at_20: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_at_20: number;
  lift_at_10: number;
  confusion_matrix: ConfusionMatrix;
  threshold_curve: ThresholdPoint[];
  chosen_threshold: number;
  threshold_method: string;
}

interface LeakageReport {
  blocked: string[];
  blockReasons: Record<string, string>;
  suspects: { leakage: string[]; id_like: string[] };
  base_rate: number | null;
}

interface TrainingMetricsReportProps {
  metrics: Record<string, number>;
  baselineMetrics: Record<string, number>;
  extended?: ExtendedMetrics | null;
  leakageReport?: LeakageReport | null;
  splitStrategy?: string;
  warnings?: string[];
  improvementVsBaseline?: number;
  problemType?: string;
  primaryMetricName?: string;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number, decimals = 4): string {
  return v.toFixed(decimals);
}

export default function TrainingMetricsReport({
  metrics,
  baselineMetrics,
  extended,
  leakageReport,
  splitStrategy,
  warnings = [],
  improvementVsBaseline,
  problemType = "classification",
  primaryMetricName,
}: TrainingMetricsReportProps) {
  const [showThresholdCurve, setShowThresholdCurve] = useState(false);
  const family = normalizeProblemFamily(problemType);
  const validMetrics = getValidMetricsForProblemType(problemType);
  const isRegression = family === "regression";
  const isClassification = family === "binary_classification";
  const isMulticlass = family === "multiclass";

  const hasLeakageSuspects = leakageReport && (
    leakageReport.suspects.leakage.length > 0 ||
    leakageReport.suspects.id_like.length > 0 ||
    leakageReport.blocked.length > 0
  );

  // Filter metrics to only show valid ones for this problem type
  const filteredMetrics = Object.entries(metrics).filter(([k]) => validMetrics.includes(k));

  return (
    <div className="space-y-4">
      {/* Leakage Warning */}
      {hasLeakageSuspects && (
        <Card className="p-4 border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="space-y-2 text-sm">
              <p className="font-semibold text-amber-700 dark:text-amber-400">Possível Leakage / ID-like detectado</p>
              {leakageReport!.blocked.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Features bloqueadas ({leakageReport!.blocked.length}):</p>
                  <div className="flex flex-wrap gap-1">
                    {leakageReport!.blocked.map(f => (
                      <Badge key={f} variant="destructive" className="text-[10px]">
                        <XCircle className="w-2.5 h-2.5 mr-0.5" />{f}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {leakageReport!.suspects.leakage.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Suspeitas de vazamento ({leakageReport!.suspects.leakage.length}):</p>
                  <div className="flex flex-wrap gap-1">
                    {leakageReport!.suspects.leakage.slice(0, 10).map(f => (
                      <Badge key={f} variant="outline" className="text-[10px] border-amber-500/50 text-amber-600">
                        {f}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {leakageReport!.suspects.id_like.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Possíveis IDs ({leakageReport!.suspects.id_like.length}):</p>
                  <div className="flex flex-wrap gap-1">
                    {leakageReport!.suspects.id_like.slice(0, 10).map(f => (
                      <Badge key={f} variant="outline" className="text-[10px]">{f}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ═══ CLASSIFICATION METRICS ═══ */}
      {isClassification && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="ROC-AUC" value={metrics.AUC} baseline={baselineMetrics.AUC} format="pct" primary={primaryMetricName === "AUC"} />
            <MetricCard label="PR-AUC" value={metrics.pr_auc} baseline={undefined} format="pct" primary={primaryMetricName === "pr_auc"} />
            <MetricCard label="F1 Score" value={metrics.F1} baseline={baselineMetrics.F1} format="pct" primary={primaryMetricName === "F1"} />
            <MetricCard label="Base Rate" value={extended?.base_rate} format="pct" highlight />
          </div>

          {/* Precision@K / Recall@K / Lift */}
          {extended && (
            <Card className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-primary" />
                <h4 className="text-sm font-semibold">Performance por Corte (Top K%)</h4>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border/50">
                      <th className="text-left py-1.5 font-medium">K</th>
                      <th className="text-right py-1.5 font-medium">Precision@K</th>
                      <th className="text-right py-1.5 font-medium">Recall@K</th>
                      <th className="text-right py-1.5 font-medium">Lift</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border/20">
                      <td className="py-1.5 font-medium">5%</td>
                      <td className="text-right font-mono">{pct(extended.precision_at_5)}</td>
                      <td className="text-right font-mono">{pct(extended.recall_at_5)}</td>
                      <td className="text-right font-mono text-muted-foreground">—</td>
                    </tr>
                    <tr className="border-b border-border/20 bg-primary/5">
                      <td className="py-1.5 font-medium">10%</td>
                      <td className="text-right font-mono">{pct(extended.precision_at_10)}</td>
                      <td className="text-right font-mono">{pct(extended.recall_at_10)}</td>
                      <td className="text-right font-mono font-semibold">{extended.lift_at_10.toFixed(2)}x</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 font-medium">20%</td>
                      <td className="text-right font-mono">{pct(extended.precision_at_20)}</td>
                      <td className="text-right font-mono">{pct(extended.recall_at_20)}</td>
                      <td className="text-right font-mono text-muted-foreground">—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Confusion Matrix */}
          {extended?.confusion_matrix && (
            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-primary" />
                  <h4 className="text-sm font-semibold">Matriz de Confusão</h4>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  Threshold: {pct(extended.chosen_threshold)} ({extended.threshold_method})
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-1 max-w-xs mx-auto text-center text-xs">
                <div className="p-3 rounded bg-accent/20 border border-accent/30">
                  <p className="text-[10px] text-muted-foreground">TP (Verdadeiro +)</p>
                  <p className="text-lg font-bold text-accent">{extended.confusion_matrix.tp}</p>
                </div>
                <div className="p-3 rounded bg-destructive/10 border border-destructive/20">
                  <p className="text-[10px] text-muted-foreground">FP (Falso +)</p>
                  <p className="text-lg font-bold text-destructive">{extended.confusion_matrix.fp}</p>
                </div>
                <div className="p-3 rounded bg-amber-500/10 border border-amber-500/20">
                  <p className="text-[10px] text-muted-foreground">FN (Falso −)</p>
                  <p className="text-lg font-bold text-amber-600">{extended.confusion_matrix.fn}</p>
                </div>
                <div className="p-3 rounded bg-muted border border-border">
                  <p className="text-[10px] text-muted-foreground">TN (Verdadeiro −)</p>
                  <p className="text-lg font-bold">{extended.confusion_matrix.tn}</p>
                </div>
              </div>
              <div className="flex justify-center gap-4 text-xs text-muted-foreground">
                <span>Precision: <strong>{pct(extended.confusion_matrix.precision)}</strong></span>
                <span>Recall: <strong>{pct(extended.confusion_matrix.recall)}</strong></span>
                <span>F1: <strong>{pct(extended.confusion_matrix.f1)}</strong></span>
              </div>
            </Card>
          )}

          {/* Threshold Curve (collapsible) */}
          {extended?.threshold_curve && extended.threshold_curve.length > 0 && (
            <Collapsible open={showThresholdCurve} onOpenChange={setShowThresholdCurve}>
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-foreground py-2 px-3 rounded border border-border/50 hover:bg-muted/30 transition-colors">
                  <span className="flex items-center gap-1.5">
                    <Shield className="w-3 h-3" />
                    Curva de Threshold ({extended.threshold_curve.length} pontos)
                  </span>
                  <ChevronDown className={`w-3 h-3 transition-transform ${showThresholdCurve ? "rotate-180" : ""}`} />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <div className="max-h-48 overflow-y-auto">
                  <table className="w-full text-[10px]">
                    <thead className="sticky top-0 bg-background">
                      <tr className="text-muted-foreground border-b">
                        <th className="text-left py-1 font-medium">Threshold</th>
                        <th className="text-right py-1 font-medium">Precision</th>
                        <th className="text-right py-1 font-medium">Recall</th>
                        <th className="text-right py-1 font-medium">F1</th>
                        <th className="text-right py-1 font-medium">TP</th>
                        <th className="text-right py-1 font-medium">FP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {extended.threshold_curve
                        .filter((_, i) => i % 2 === 0)
                        .map((p, i) => (
                        <tr key={i} className={`border-b border-border/10 ${Math.abs(p.threshold - extended.chosen_threshold) < 0.02 ? "bg-primary/10 font-semibold" : ""}`}>
                          <td className="py-0.5 font-mono">{pct(p.threshold)}</td>
                          <td className="text-right font-mono">{pct(p.precision)}</td>
                          <td className="text-right font-mono">{pct(p.recall)}</td>
                          <td className="text-right font-mono">{pct(p.f1)}</td>
                          <td className="text-right font-mono">{p.tp}</td>
                          <td className="text-right font-mono">{p.fp}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      {/* ═══ REGRESSION METRICS ═══ */}
      {isRegression && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="R²" value={metrics["R²"]} baseline={baselineMetrics["R²"]} format="num" primary={primaryMetricName === "R²"} />
          <MetricCard label="MAE" value={metrics.MAE} baseline={baselineMetrics.MAE} format="num" lowerIsBetter primary={primaryMetricName === "MAE"} />
          <MetricCard label="RMSE" value={metrics.RMSE} baseline={baselineMetrics.RMSE} format="num" lowerIsBetter primary={primaryMetricName === "RMSE"} />
          <MetricCard label="MAPE" value={metrics.MAPE} format="num" lowerIsBetter primary={primaryMetricName === "MAPE"} suffix="%" />
        </div>
      )}

      {/* ═══ MULTICLASS METRICS ═══ */}
      {isMulticlass && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Macro F1" value={metrics.macro_f1} format="pct" primary={primaryMetricName === "macro_f1"} />
          <MetricCard label="Weighted F1" value={metrics.weighted_f1} format="pct" primary={primaryMetricName === "weighted_f1"} />
          <MetricCard label="Acurácia" value={metrics.Acurácia} format="pct" primary={primaryMetricName === "Acurácia"} />
        </div>
      )}

      {/* ═══ GENERIC FALLBACK (non-standard family) ═══ */}
      {!isClassification && !isRegression && !isMulticlass && filteredMetrics.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {filteredMetrics.slice(0, 4).map(([k, v]) => (
            <MetricCard key={k} label={k} value={v} format="num" primary={primaryMetricName === k} />
          ))}
        </div>
      )}

      {/* Split + Warnings */}
      <div className="space-y-2">
        {splitStrategy && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Info className="w-3 h-3" />
            <span>Split: <strong>{splitStrategy}</strong></span>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="space-y-1">
            {warnings.slice(0, 5).map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-600">
                <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, baseline, format, highlight, primary, lowerIsBetter, suffix }: {
  label: string;
  value?: number | null;
  baseline?: number;
  format: "pct" | "num";
  highlight?: boolean;
  primary?: boolean;
  lowerIsBetter?: boolean;
  suffix?: string;
}) {
  if (value == null) return null;
  const displayValue = format === "pct" 
    ? `${(value * 100).toFixed(1)}%` 
    : `${value.toFixed(4)}${suffix || ""}`;
  const improvement = baseline != null ? (lowerIsBetter ? baseline - value : value - baseline) : null;
  const isGood = improvement != null ? improvement > 0 : (format === "pct" ? value > 0.6 : true);

  return (
    <div className={`p-3 rounded-lg border text-center space-y-1 ${
      primary ? "bg-primary/10 border-primary/30 ring-1 ring-primary/20" :
      highlight ? "bg-primary/5 border-primary/20" : 
      "bg-background/60 border-border/50"
    }`}>
      <p className="text-[10px] text-muted-foreground">
        {label}
        {primary && <span className="ml-1 text-primary font-semibold">★</span>}
      </p>
      <p className={`text-lg font-bold ${isGood ? "text-accent" : "text-amber-500"}`}>{displayValue}</p>
      {improvement != null && (
        <p className={`text-[10px] ${improvement > 0 ? "text-accent" : "text-destructive"}`}>
          {improvement > 0 ? "+" : ""}{format === "pct" ? `${(improvement * 100).toFixed(1)}%` : improvement.toFixed(4)} vs baseline
        </p>
      )}
    </div>
  );
}