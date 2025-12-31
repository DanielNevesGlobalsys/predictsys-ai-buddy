import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Settings2, Save, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ModelMetric {
  metric_name: string;
  metric_value: number;
}

interface ModelRecalibrationProps {
  modelName: string;
  metrics: ModelMetric[];
  onSaveThreshold: (threshold: number) => void;
  currentThreshold?: number;
}

const ModelRecalibration = ({
  modelName,
  metrics,
  onSaveThreshold,
  currentThreshold = 0.5
}: ModelRecalibrationProps) => {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(currentThreshold);
  const [isOpen, setIsOpen] = useState(false);

  // Simulate metric changes based on threshold
  // In a real scenario, these would be recalculated from actual predictions
  const simulatedMetrics = useMemo(() => {
    const baseRecall = metrics.find(m => m.metric_name === "Recall")?.metric_value || 0.5;
    const basePrecision = metrics.find(m => m.metric_name === "Precisão")?.metric_value || 0.5;
    const baseF1 = metrics.find(m => m.metric_name === "F1")?.metric_value || 0.5;
    const baseAccuracy = metrics.find(m => m.metric_name === "Acurácia")?.metric_value || 0.5;

    // Simulate how metrics change with threshold
    // Lower threshold = higher recall, lower precision
    // Higher threshold = lower recall, higher precision
    const thresholdDiff = threshold - 0.5;
    
    const newRecall = Math.max(0, Math.min(1, baseRecall - thresholdDiff * 0.6));
    const newPrecision = Math.max(0, Math.min(1, basePrecision + thresholdDiff * 0.4));
    const newF1 = 2 * (newPrecision * newRecall) / (newPrecision + newRecall) || 0;
    const newAccuracy = Math.max(0, Math.min(1, baseAccuracy - Math.abs(thresholdDiff) * 0.1));

    // Estimate positive rate (percentage predicted as positive class)
    const positiveRate = Math.max(5, Math.min(95, 50 - thresholdDiff * 80));

    return {
      recall: newRecall,
      precision: newPrecision,
      f1: newF1,
      accuracy: newAccuracy,
      positiveRate
    };
  }, [threshold, metrics]);

  const handleSave = () => {
    onSaveThreshold(threshold);
    toast.success(t("models.recalibration.saved"));
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 className="w-4 h-4 mr-2" />
          {t("models.recalibration.button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            {t("models.recalibration.title")}
          </DialogTitle>
          <DialogDescription>
            {t("models.recalibration.description", { model: modelName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Explanation */}
          <Card className="bg-muted/30 border-muted">
            <CardContent className="p-4">
              <div className="flex gap-3">
                <Info className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
                  {t("models.recalibration.explanation")}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Threshold Slider */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                {t("models.recalibration.threshold")}
              </label>
              <span className="text-lg font-bold text-primary">{threshold.toFixed(2)}</span>
            </div>
            <Slider
              value={[threshold]}
              onValueChange={([val]) => setThreshold(val)}
              min={0.1}
              max={0.9}
              step={0.05}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{t("models.recalibration.moreRecall")}</span>
              <span>{t("models.recalibration.morePrecision")}</span>
            </div>
          </div>

          {/* Simulated Metrics */}
          <TooltipProvider>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                label="Recall"
                value={simulatedMetrics.recall}
                tooltip={t("models.metrics.Recall")}
              />
              <MetricCard
                label={t("models.metrics.Precision")}
                value={simulatedMetrics.precision}
                tooltip={t("models.metrics.PrecisionDesc")}
              />
              <MetricCard
                label="F1"
                value={simulatedMetrics.f1}
                tooltip={t("models.metrics.F1")}
              />
              <MetricCard
                label={t("models.metrics.Accuracy")}
                value={simulatedMetrics.accuracy}
                tooltip={t("models.metrics.AccuracyDesc")}
              />
            </div>
          </TooltipProvider>

          {/* Business Impact Estimate */}
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="p-4">
              <p className="text-sm">
                <strong>{t("models.recalibration.businessImpact")}:</strong>{" "}
                {t("models.recalibration.impactText", {
                  positiveRate: simulatedMetrics.positiveRate.toFixed(0)
                })}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave}>
            <Save className="w-4 h-4 mr-2" />
            {t("models.recalibration.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const MetricCard = ({ label, value, tooltip }: { label: string; value: number; tooltip: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Card className="bg-background cursor-help">
        <CardContent className="p-3 text-center">
          <p className="text-xs text-muted-foreground mb-1">{label}</p>
          <p className="text-lg font-bold">{value.toFixed(4)}</p>
        </CardContent>
      </Card>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-xs">
      <p className="text-sm">{tooltip}</p>
    </TooltipContent>
  </Tooltip>
);

export default ModelRecalibration;
