import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Lightbulb, ShieldAlert, BookOpen, CheckCircle, XCircle } from "lucide-react";
import type { BusinessIntentContract } from "@/lib/industryRules";

interface BusinessGuidancePanelProps {
  contract: BusinessIntentContract;
  objectiveLabel: string;
  industryLabel: string;
}

const BusinessGuidancePanel = ({ contract, objectiveLabel, industryLabel }: BusinessGuidancePanelProps) => {
  const recs = contract.target_recommendations;

  return (
    <Card className="border border-primary/20 bg-primary/5 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold">
          Guia do seu objetivo: {objectiveLabel}
        </h3>
        <Badge variant="outline" className="text-[10px] ml-auto">{industryLabel}</Badge>
      </div>

      {/* Do */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-primary flex items-center gap-1">
          <CheckCircle className="w-3.5 h-3.5" />
          O que faz sentido como alvo
        </p>
        <ul className="space-y-1 pl-5">
          {recs.do.map((item, i) => (
            <li key={i} className="text-sm text-foreground/80 list-disc">{item}</li>
          ))}
        </ul>
      </div>

      {/* Avoid */}
      {recs.avoid.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-destructive flex items-center gap-1">
            <ShieldAlert className="w-3.5 h-3.5" />
            Evite estes campos
          </p>
          <ul className="space-y-1 pl-5">
            {recs.avoid.map((item, i) => (
              <li key={i} className="text-sm text-foreground/80 list-disc">{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Examples */}
      {recs.examples.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            <BookOpen className="w-3.5 h-3.5" />
            Exemplos prontos
          </p>
          <div className="flex flex-wrap gap-2">
            {recs.examples.map((ex, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 bg-muted/50 rounded-md border border-border/50">
                <Badge className="bg-accent/20 text-accent border-accent/30 text-[9px]">Exemplo</Badge>
                <span className="text-xs"><strong>{ex.title}:</strong> {ex.rule}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};

export default BusinessGuidancePanel;
