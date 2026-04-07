import { ShieldCheck, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardIntelligence } from "@/components/business-dashboard/dashboardIntelligence";

interface Props {
  layer: DashboardIntelligence["technical_summary_layer"];
}

export default function ModelConfidencePanel({ layer }: Props) {
  if (!layer.model_quality_summary && !layer.score_reliability_summary) return null;

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-muted-foreground" />
          Confiança Técnica do Modelo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {layer.model_quality_summary && (
          <div className="flex gap-2 items-start text-sm">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-primary flex-shrink-0" />
            <p>{layer.model_quality_summary}</p>
          </div>
        )}
        {layer.score_reliability_summary && (
          <div className="flex gap-2 items-start text-sm">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-primary flex-shrink-0" />
            <p>{layer.score_reliability_summary}</p>
          </div>
        )}
        {layer.main_limitation && (
          <div className="flex gap-2 items-start text-sm border-t pt-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-muted-foreground flex-shrink-0" />
            <p className="text-muted-foreground">{layer.main_limitation}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
