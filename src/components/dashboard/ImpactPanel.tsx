import { DollarSign, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardIntelligence } from "@/components/business-dashboard/dashboardIntelligence";

interface Props {
  layer: DashboardIntelligence["impact_layer"];
}

export default function ImpactPanel({ layer }: Props) {
  const hasFinancial = layer.financial_impact.length > 0;
  const hasOperational = layer.operational_impact.length > 0;
  const hasReturn = layer.expected_return.length > 0;
  if (!hasFinancial && !hasOperational && !hasReturn) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-primary" />
          Impacto Estimado
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasFinancial && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Financeiro</p>
            {layer.financial_impact.map((fi, i) => (
              <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/40">
                <span className="text-sm">{fi.description}</span>
                {fi.value && <span className="text-sm font-semibold text-primary">{fi.value}</span>}
              </div>
            ))}
          </div>
        )}

        {hasOperational && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Operacional</p>
            {layer.operational_impact.map((op, i) => (
              <p key={i} className="text-sm text-muted-foreground">{op}</p>
            ))}
          </div>
        )}

        {hasReturn && (
          <div className="space-y-2 border-t pt-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Retorno esperado</p>
            {layer.expected_return.map((ret, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <TrendingUp className="w-3.5 h-3.5 mt-0.5 text-primary flex-shrink-0" />
                <span><strong>{ret.scenario}:</strong> {ret.estimate}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
