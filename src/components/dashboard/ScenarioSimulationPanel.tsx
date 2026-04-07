import { FlaskConical, Lightbulb } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardIntelligence } from "@/components/business-dashboard/dashboardIntelligence";

interface Props {
  layer: DashboardIntelligence["simulation_layer"];
}

export default function ScenarioSimulationPanel({ layer }: Props) {
  if (layer.what_if_scenarios.length === 0 && layer.controls_recommended.length === 0) return null;

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-muted-foreground" />
          Cenários Sugeridos
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {layer.what_if_scenarios.length > 0 && (
          <div className="space-y-2">
            {layer.what_if_scenarios.map((sc, i) => (
              <div key={i} className="flex gap-2 items-start p-2 rounded-lg bg-muted/30">
                <Lightbulb className="w-3.5 h-3.5 mt-0.5 text-primary flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium">{sc.scenario}</p>
                  {sc.description && <p className="text-xs text-muted-foreground">{sc.description}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        {layer.assumptions.length > 0 && (
          <div className="border-t pt-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Premissas</p>
            <ul className="space-y-0.5">
              {layer.assumptions.map((a, i) => (
                <li key={i} className="text-xs text-muted-foreground">• {a}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
