import { Lightbulb, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { BusinessTranslation } from "@/lib/businessTranslator";

interface BusinessSummaryCardProps {
  translation: BusinessTranslation | null;
}

export function BusinessSummaryCard({ translation }: BusinessSummaryCardProps) {
  if (!translation) return null;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Lightbulb className="w-4 h-4 text-primary" />
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold text-base">{translation.headline}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{translation.whatItMeans}</p>
          </div>
        </div>

        {translation.recommendedActions.length > 0 && (
          <div className="space-y-2 pl-11">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ações recomendadas</p>
            <ul className="space-y-1.5">
              {translation.recommendedActions.map((action, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                  <ArrowRight className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
                  <span>{action}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
