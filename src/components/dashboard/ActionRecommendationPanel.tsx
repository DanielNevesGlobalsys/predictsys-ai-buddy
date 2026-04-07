import { ListChecks, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { DashboardIntelligence } from "@/components/business-dashboard/dashboardIntelligence";

interface Props {
  layer: DashboardIntelligence["action_layer"];
}

const URGENCY_COLORS: Record<string, string> = {
  immediate: "bg-destructive text-destructive-foreground",
  high: "bg-primary text-primary-foreground",
  medium: "bg-secondary text-secondary-foreground",
  normal: "bg-muted text-muted-foreground",
};

export default function ActionRecommendationPanel({ layer }: Props) {
  if (layer.recommended_actions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ListChecks className="w-5 h-5 text-primary" />
          Ações Recomendadas
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {layer.recommended_actions.slice(0, 6).map((action, i) => (
          <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border">
            <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary flex-shrink-0 mt-0.5">
              {i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium">{action.action}</p>
                <Badge className={`text-[9px] ${URGENCY_COLORS[action.urgency] || URGENCY_COLORS.normal}`}>
                  {action.urgency}
                </Badge>
              </div>
              {action.target_segment && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  <ArrowRight className="w-3 h-3 inline mr-1" />
                  {action.target_segment}
                </p>
              )}
              {action.expected_result && (
                <p className="text-xs text-muted-foreground mt-0.5 italic">{action.expected_result}</p>
              )}
            </div>
          </div>
        ))}

        {layer.segments_to_watch.length > 0 && (
          <div className="border-t pt-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Segmentos para acompanhar</p>
            <div className="flex flex-wrap gap-1">
              {layer.segments_to_watch.map((s, i) => (
                <Badge key={i} variant="outline" className="text-[10px]">{s}</Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
