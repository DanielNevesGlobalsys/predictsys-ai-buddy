import { useState, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Calculator, DollarSign, TrendingUp, Users } from "lucide-react";

interface ExtendedMetrics {
  base_rate: number;
  precision_at_5: number;
  precision_at_10: number;
  precision_at_20: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_at_20: number;
  lift_at_10: number;
  confusion_matrix: { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; f1: number };
  threshold_curve: { threshold: number; precision: number; recall: number; f1: number; tp: number; fp: number }[];
  chosen_threshold: number;
}

interface ChurnSimulatorProps {
  extendedMetrics: ExtendedMetrics;
  totalEntities: number;
}

export default function ChurnSimulator({ extendedMetrics, totalEntities }: ChurnSimulatorProps) {
  const [kPercent, setKPercent] = useState(10);
  const [costPerAction, setCostPerAction] = useState(15);
  const [valuePerSaved, setValuePerSaved] = useState(500);
  const [efficacy, setEfficacy] = useState(30);
  const [marginPercent, setMarginPercent] = useState(100);

  const results = useMemo(() => {
    const baseRate = extendedMetrics.base_rate;
    const totalChurners = Math.round(totalEntities * baseRate);
    const kCount = Math.max(1, Math.round((kPercent / 100) * totalEntities));

    // Interpolate precision@K and recall@K from threshold curve
    // Find closest K% in our pre-computed metrics
    let precisionAtK: number;
    let recallAtK: number;
    if (kPercent <= 5) {
      precisionAtK = extendedMetrics.precision_at_5;
      recallAtK = extendedMetrics.recall_at_5;
    } else if (kPercent <= 10) {
      const t = (kPercent - 5) / 5;
      precisionAtK = extendedMetrics.precision_at_5 * (1 - t) + extendedMetrics.precision_at_10 * t;
      recallAtK = extendedMetrics.recall_at_5 * (1 - t) + extendedMetrics.recall_at_10 * t;
    } else {
      const t = Math.min(1, (kPercent - 10) / 10);
      precisionAtK = extendedMetrics.precision_at_10 * (1 - t) + extendedMetrics.precision_at_20 * t;
      recallAtK = extendedMetrics.recall_at_10 * (1 - t) + extendedMetrics.recall_at_20 * t;
    }

    const tp = Math.round(precisionAtK * kCount);
    const fp = kCount - tp;
    const fn = totalChurners - tp;
    const tn = totalEntities - kCount - fn;

    const clientsSaved = Math.round(tp * (efficacy / 100));
    const revenueSaved = clientsSaved * valuePerSaved * (marginPercent / 100);
    const totalCost = kCount * costPerAction;
    const netProfit = revenueSaved - totalCost;
    const roi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;

    // Break-even: min efficacy for profit >= 0
    const breakEvenEfficacy = tp > 0 && valuePerSaved > 0
      ? (totalCost / (tp * valuePerSaved * (marginPercent / 100))) * 100
      : 100;

    // Break-even: min value per saved for profit >= 0
    const breakEvenValue = clientsSaved > 0 && marginPercent > 0
      ? totalCost / (clientsSaved * (marginPercent / 100))
      : 0;

    return {
      kCount,
      totalChurners,
      precisionAtK,
      recallAtK,
      tp,
      fp,
      fn,
      tn: Math.max(0, tn),
      clientsSaved,
      revenueSaved,
      totalCost,
      netProfit,
      roi,
      breakEvenEfficacy: Math.min(100, breakEvenEfficacy),
      breakEvenValue,
    };
  }, [kPercent, costPerAction, valuePerSaved, efficacy, marginPercent, extendedMetrics, totalEntities]);

  const formatCurrency = (v: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

  return (
    <Card className="p-5 space-y-5 border-primary/20">
      <div className="flex items-center gap-2">
        <Calculator className="w-5 h-5 text-primary" />
        <h3 className="text-sm font-bold">Simulador de Impacto — Churn</h3>
        <Badge variant="outline" className="text-[10px]">
          Base Rate: {(extendedMetrics.base_rate * 100).toFixed(1)}%
        </Badge>
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="space-y-2 col-span-2 md:col-span-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">% da base acionada (K)</Label>
            <span className="text-xs font-mono font-semibold">{kPercent}% ({results.kCount.toLocaleString()} clientes)</span>
          </div>
          <Slider value={[kPercent]} onValueChange={([v]) => setKPercent(v)} min={1} max={50} step={1} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Custo por ação (R$)</Label>
          <Input type="number" value={costPerAction} onChange={e => setCostPerAction(Number(e.target.value))} className="h-8 text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Valor retido por cliente (R$)</Label>
          <Input type="number" value={valuePerSaved} onChange={e => setValuePerSaved(Number(e.target.value))} className="h-8 text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Eficácia da ação (%)</Label>
          <Input type="number" value={efficacy} onChange={e => setEfficacy(Math.min(100, Number(e.target.value)))} className="h-8 text-sm" />
        </div>
      </div>

      {/* Results */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ResultCard icon={Users} label="TP (churners encontrados)" value={results.tp.toString()} sub={`P@${kPercent}%: ${(results.precisionAtK * 100).toFixed(0)}%`} />
        <ResultCard icon={Users} label="FP (falsos alertas)" value={results.fp.toString()} sub={`R@${kPercent}%: ${(results.recallAtK * 100).toFixed(0)}%`} variant="warning" />
        <ResultCard icon={TrendingUp} label="Clientes salvos" value={results.clientsSaved.toString()} sub={`Eficácia: ${efficacy}%`} variant="success" />
        <ResultCard icon={DollarSign} label="Receita retida" value={formatCurrency(results.revenueSaved)} sub={`Margem: ${marginPercent}%`} variant="success" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className={`p-3 rounded-lg border text-center ${results.netProfit > 0 ? "bg-accent/10 border-accent/30" : "bg-destructive/10 border-destructive/30"}`}>
          <p className="text-[10px] text-muted-foreground">Lucro Líquido</p>
          <p className={`text-xl font-bold ${results.netProfit > 0 ? "text-accent" : "text-destructive"}`}>
            {formatCurrency(results.netProfit)}
          </p>
        </div>
        <div className="p-3 rounded-lg border text-center bg-muted/50">
          <p className="text-[10px] text-muted-foreground">Custo Total</p>
          <p className="text-xl font-bold">{formatCurrency(results.totalCost)}</p>
        </div>
        <div className={`p-3 rounded-lg border text-center ${results.roi > 0 ? "bg-accent/10 border-accent/30" : "bg-destructive/10 border-destructive/30"}`}>
          <p className="text-[10px] text-muted-foreground">ROI</p>
          <p className={`text-xl font-bold ${results.roi > 0 ? "text-accent" : "text-destructive"}`}>
            {results.roi.toFixed(0)}%
          </p>
        </div>
      </div>

      {/* Break-even */}
      <div className="flex items-start gap-2 text-[10px] text-muted-foreground p-2 bg-muted/30 rounded">
        <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <div>
          <span>Break-even: eficácia mínima <strong>{results.breakEvenEfficacy.toFixed(0)}%</strong></span>
          {results.breakEvenValue > 0 && (
            <span> | valor mínimo retido <strong>{formatCurrency(results.breakEvenValue)}</strong></span>
          )}
        </div>
      </div>
    </Card>
  );
}

function ResultCard({ icon: Icon, label, value, sub, variant }: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  variant?: "success" | "warning";
}) {
  return (
    <div className="p-2.5 rounded-lg bg-background/60 border border-border/50 text-center space-y-0.5">
      <Icon className={`w-3.5 h-3.5 mx-auto ${variant === "success" ? "text-accent" : variant === "warning" ? "text-amber-500" : "text-primary"}`} />
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-bold">{value}</p>
      {sub && <p className="text-[9px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
