import { Activity, ShieldCheck, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { RolloutReport } from "@/lib/lisRollout";

interface LisOperationalSummaryBarProps {
  report: RolloutReport | null;
  loading?: boolean;
}

export default function LisOperationalSummaryBar({ report, loading }: LisOperationalSummaryBarProps) {
  if (loading || !report) return null;

  const totalExec = Object.values(report.execution_counts).reduce((a, b) => a + b, 0);

  const items = [
    { icon: Activity, label: "Execuções", value: totalExec, color: "text-primary" },
    { icon: ShieldCheck, label: "Agentes ativos", value: report.agents_active.length, color: "text-primary" },
    { icon: AlertTriangle, label: "Bloqueios", value: report.blocks_triggered, color: "text-destructive" },
    { icon: CheckCircle2, label: "Etapas", value: report.stages_active.length, color: "text-primary" },
  ];

  return (
    <Card className="border-dashed">
      <CardContent className="py-2 px-4">
        <div className="flex items-center gap-6 text-xs">
          <span className="font-medium text-muted-foreground">LIS AI OS</span>
          {items.map((item) => (
            <div key={item.label} className="flex items-center gap-1">
              <item.icon className={`w-3.5 h-3.5 ${item.color}`} />
              <span className="text-muted-foreground">{item.label}:</span>
              <span className="font-semibold">{item.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
