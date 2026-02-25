import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertTriangle, XCircle, Target, ArrowLeft, Lightbulb,
  ChevronDown, Settings2, Tag, Users, Pencil
} from "lucide-react";
import { useState } from "react";

interface FixSuggestion {
  label: string;
  action: string;
  hint?: Record<string, unknown>;
}

interface TrainabilityDetails {
  n_rows: number;
  n_non_null: number;
  n_unique: number;
  positive_rate: number;
  top_class_pct: number;
  minor_class_count: number;
  conflict_rate: number;
  coverage: number;
  target_type?: string;
  // SSOT fields from evaluateTargetTrainabilityFromSSOT
  join_rows?: number;
  distinct_y?: number;
  pos?: number;
  neg?: number;
  mode?: string;
  target_col?: string | null;
}

interface TrainabilityDiagnosticProps {
  reasonCode: string;
  details: TrainabilityDetails;
  fixSuggestions: FixSuggestion[];
  warnings?: string[];
  humanMessage: string;
  onGoToStep?: (step: number) => void;
  onBack?: () => void;
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  open_target_strategy: <Settings2 className="w-3.5 h-3.5" />,
  enable_weak_supervision: <Tag className="w-3.5 h-3.5" />,
  open_human_labeling: <Pencil className="w-3.5 h-3.5" />,
  open_manual_target: <Target className="w-3.5 h-3.5" />,
  go_to_step_2: <Users className="w-3.5 h-3.5" />,
  change_problem_type: <Settings2 className="w-3.5 h-3.5" />,
  open_weak_supervision_config: <Settings2 className="w-3.5 h-3.5" />,
};

export default function TrainabilityDiagnosticCard({
  reasonCode,
  details,
  fixSuggestions,
  warnings = [],
  humanMessage,
  onGoToStep,
  onBack,
}: TrainabilityDiagnosticProps) {
  const [showDetails, setShowDetails] = useState(false);

  const handleAction = (action: string) => {
    switch (action) {
      case "open_target_strategy":
      case "open_manual_target":
      case "enable_weak_supervision":
      case "open_weak_supervision_config":
      case "open_human_labeling":
      case "change_problem_type":
        // Step 4 = Target/Features in wizard
        onGoToStep?.(4);
        break;
      case "go_to_step_2":
        // Step 2 = Data Upload
        onGoToStep?.(2);
        break;
      default:
        onBack?.();
    }
  };

  return (
    <Card className="p-5 space-y-4 border-destructive/30 bg-destructive/5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-destructive/20 flex items-center justify-center flex-shrink-0">
          <XCircle className="w-5 h-5 text-destructive" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-bold text-destructive">
            Não foi possível treinar com o alvo atual
          </h3>
          <p className="text-xs text-muted-foreground mt-1">{humanMessage}</p>
        </div>
        <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive flex-shrink-0">
          {reasonCode}
        </Badge>
        {details.mode && (
          <Badge variant="secondary" className="text-[10px] flex-shrink-0">
            {details.mode === "human" ? "Rotulagem Humana" : details.mode === "weak" ? "Assistido" : details.mode === "template" ? "Template" : "Manual"}
          </Badge>
        )}
      </div>

      {/* Expandable details */}
      <Collapsible open={showDetails} onOpenChange={setShowDetails}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-full justify-between text-xs h-7">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" />
              Detalhes do diagnóstico
            </span>
            <ChevronDown className={`w-3 h-3 transition-transform ${showDetails ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            {details.join_rows != null && details.join_rows > 0 && (
              <DetailItem label="Join Rows" value={details.join_rows.toLocaleString()} />
            )}
            {details.pos != null && (
              <DetailItem label="Positivos" value={String(details.pos)} warn={details.pos === 0} />
            )}
            {details.neg != null && (
              <DetailItem label="Negativos" value={String(details.neg)} warn={details.neg === 0} />
            )}
            {details.distinct_y != null && (
              <DetailItem label="Classes" value={String(details.distinct_y)} warn={details.distinct_y < 2} />
            )}
            <DetailItem label="Linhas" value={details.n_rows.toLocaleString()} />
            <DetailItem label="Não-nulos" value={details.n_non_null.toLocaleString()} />
            <DetailItem label="Valores únicos" value={String(details.n_unique)} />
            <DetailItem
              label="Classe dominante"
              value={`${(details.top_class_pct * 100).toFixed(1)}%`}
              warn={details.top_class_pct > 0.90}
            />
            <DetailItem
              label="Classe rara"
              value={String(details.minor_class_count)}
              warn={details.minor_class_count < 50}
            />
            <DetailItem
              label="Taxa positivos"
              value={`${(details.positive_rate * 100).toFixed(2)}%`}
              warn={details.positive_rate < 0.01 || details.positive_rate > 0.99}
            />
            {details.conflict_rate > 0 && (
              <DetailItem
                label="Conflito"
                value={`${(details.conflict_rate * 100).toFixed(0)}%`}
                warn={details.conflict_rate > 0.40}
              />
            )}
            {details.coverage < 1 && (
              <DetailItem
                label="Cobertura"
                value={`${(details.coverage * 100).toFixed(0)}%`}
                warn={details.coverage < 0.40}
              />
            )}
            {details.target_type && (
              <DetailItem label="Tipo" value={details.target_type} />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-600 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              {w}
            </p>
          ))}
        </div>
      )}

      {/* Fix suggestions */}
      {fixSuggestions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold flex items-center gap-1.5">
            <Lightbulb className="w-3.5 h-3.5 text-primary" />
            Sugestões para corrigir
          </p>
          <div className="flex flex-wrap gap-2">
            {fixSuggestions.map((s, i) => (
              <Button
                key={i}
                variant="outline"
                size="sm"
                className="text-xs h-7 gap-1.5"
                onClick={() => handleAction(s.action)}
              >
                {ACTION_ICONS[s.action] || <Target className="w-3.5 h-3.5" />}
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Main CTA */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => { if (onGoToStep) onGoToStep(4); else onBack?.(); }}
        className="w-full text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
      >
        <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
        Voltar para Variável Alvo e Ajustar
      </Button>
    </Card>
  );
}

function DetailItem({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`p-1.5 rounded border text-center ${warn ? "bg-amber-500/10 border-amber-500/30" : "bg-muted/50 border-border/50"}`}>
      <p className="text-muted-foreground text-[10px]">{label}</p>
      <p className={`font-semibold ${warn ? "text-amber-600" : ""}`}>{value}</p>
    </div>
  );
}
