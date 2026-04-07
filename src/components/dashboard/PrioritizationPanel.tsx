import { Target, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { DashboardIntelligence } from "@/components/business-dashboard/dashboardIntelligence";

interface Props {
  layer: DashboardIntelligence["prioritization_layer"];
}

export default function PrioritizationPanel({ layer }: Props) {
  const hasSegments = layer.priority_segments.length > 0;
  const hasRules = layer.priority_rules.length > 0;
  if (!hasSegments && !hasRules) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" />
          Quem Priorizar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasSegments && (
          <div className="space-y-2">
            {layer.priority_segments.slice(0, 5).map((seg, i) => (
              <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-muted/40 border">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                    {i + 1}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{seg.segment}</p>
                    {seg.opportunity && <p className="text-xs text-muted-foreground">{seg.opportunity}</p>}
                  </div>
                </div>
                {seg.action && (
                  <Badge variant="outline" className="text-[10px]">{seg.action}</Badge>
                )}
              </div>
            ))}
          </div>
        )}

        {hasRules && (
          <div className="border-t pt-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Regras de priorização</p>
            <ul className="space-y-1">
              {layer.priority_rules.map((rule, i) => (
                <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <Users className="w-3 h-3 mt-0.5 flex-shrink-0" />
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
