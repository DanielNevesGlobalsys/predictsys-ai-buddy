import { Badge } from "@/components/ui/badge";
import { Briefcase, Target, Factory, Sparkles } from "lucide-react";
import type { BusinessIntentContract } from "@/lib/industryRules";

interface Props {
  contract: BusinessIntentContract | null;
  industry: string | null;
  objective: string | null;
  problemType: string | null;
  industryLabel: string;
  objectiveLabel: string;
}

const PROBLEM_TYPE_LABELS: Record<string, string> = {
  classification: "Classificação binária",
  regression: "Regressão",
  multiclass: "Classificação multiclasse",
  clustering: "Segmentação / agrupamento",
  ranking: "Ranking / priorização",
};

export default function TargetBusinessContext({
  contract,
  industry,
  objective,
  problemType,
  industryLabel,
  objectiveLabel,
}: Props) {
  if (!contract && !industry && !objective) return null;

  const resolvedProblemType = problemType || contract?.problem_type_default || null;

  return (
    <div className="p-5 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 to-accent/5 space-y-3">
      <div className="flex items-center gap-2">
        <Briefcase className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold">Problema de negócio</h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Industry */}
        <div className="flex items-center gap-2 p-3 bg-background/80 rounded-lg border border-border/50">
          <Factory className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <div>
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">Indústria</p>
            <p className="text-sm font-medium">{industryLabel || industry || "—"}</p>
          </div>
        </div>

        {/* Objective */}
        <div className="flex items-center gap-2 p-3 bg-background/80 rounded-lg border border-border/50">
          <Target className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <div>
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">Objetivo</p>
            <p className="text-sm font-medium">{objectiveLabel || objective || "—"}</p>
          </div>
        </div>

        {/* Problem Type */}
        <div className="flex items-center gap-2 p-3 bg-background/80 rounded-lg border border-border/50">
          <Sparkles className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <div>
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">Tipo de problema</p>
            <p className="text-sm font-medium">
              {resolvedProblemType ? (PROBLEM_TYPE_LABELS[resolvedProblemType] || resolvedProblemType) : "—"}
            </p>
          </div>
        </div>
      </div>

      {contract?.guardrails?.description_pt && (
        <p className="text-xs text-muted-foreground">{contract.guardrails.description_pt}</p>
      )}
    </div>
  );
}
