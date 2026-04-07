import { Sparkles, TrendingUp, AlertTriangle, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardIntelligence } from "@/components/business-dashboard/dashboardIntelligence";

interface Props {
  layer: DashboardIntelligence["executive_layer"];
}

export default function ExecutiveSummaryPanel({ layer }: Props) {
  if (!layer.main_message) return null;

  const items = [
    { icon: Sparkles, label: "Oportunidade", text: layer.main_opportunity, color: "text-primary" },
    { icon: AlertTriangle, label: "Risco", text: layer.main_risk, color: "text-destructive" },
    { icon: Zap, label: "Ação recomendada", text: layer.main_action, color: "text-accent-foreground" },
  ].filter((i) => i.text);

  return (
    <Card className="border-2 border-primary/20 bg-primary/[0.02]">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-primary" />
          Resumo Executivo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed font-medium">{layer.main_message}</p>

        {items.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {items.map((item) => (
              <div key={item.label} className="flex gap-2 items-start p-3 rounded-lg bg-muted/50">
                <item.icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${item.color}`} />
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{item.label}</p>
                  <p className="text-sm mt-0.5">{item.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {layer.confidence_message && (
          <p className="text-xs text-muted-foreground italic border-t pt-2">{layer.confidence_message}</p>
        )}
      </CardContent>
    </Card>
  );
}
