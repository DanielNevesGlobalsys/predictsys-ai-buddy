import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Lightbulb, ShieldAlert, BookOpen, CheckCircle, Zap, Sparkles, Settings2 } from "lucide-react";
import type { BusinessIntentContract } from "@/lib/industryRules";

/** A suggested target card for 1-click application */
export interface TargetSuggestionCard {
  id: string;
  title: string;
  description: string;
  variant: "recommended" | "alternative" | "advanced";
  action: {
    mode?: string;
    targetColumn?: string;
    windowDays?: number;
    anchorCol?: string;
    entityKey?: string;
    timeAnchor?: string;
    problemType?: string;
  };
}

interface BusinessGuidancePanelProps {
  contract: BusinessIntentContract;
  objectiveLabel: string;
  industryLabel: string;
  /** Schema columns for matching suggestions */
  schemaColumns?: string[];
  /** Whether advanced mode is on */
  advancedMode?: boolean;
  /** Called when user clicks a suggestion card */
  onApplySuggestion?: (card: TargetSuggestionCard) => void;
}

const VARIANT_STYLES = {
  recommended: {
    border: "border-accent/40",
    bg: "bg-accent/5",
    badge: "bg-accent/20 text-accent border-accent/30",
    badgeLabel: "Mais recomendado",
    icon: <CheckCircle className="w-4 h-4 text-accent" />,
  },
  alternative: {
    border: "border-primary/30",
    bg: "bg-primary/5",
    badge: "bg-primary/20 text-primary border-primary/30",
    badgeLabel: "Alternativa",
    icon: <Zap className="w-4 h-4 text-primary" />,
  },
  advanced: {
    border: "border-muted-foreground/20",
    bg: "bg-muted/30",
    badge: "bg-muted text-muted-foreground border-border",
    badgeLabel: "Avançado",
    icon: <Settings2 className="w-4 h-4 text-muted-foreground" />,
  },
};

/**
 * Build suggestion cards from contract + schema columns.
 */
function buildSuggestionCards(
  contract: BusinessIntentContract,
  schemaColumns: string[],
  advancedMode: boolean
): TargetSuggestionCard[] {
  const cards: TargetSuggestionCard[] = [];
  const lowerCols = schemaColumns.map(c => c.toLowerCase());

  // Find best entity key match
  const entityMatch = contract.entity_key_hint_patterns.find(p =>
    lowerCols.some(c => c.includes(p.toLowerCase()))
  );
  const matchedEntityCol = entityMatch
    ? schemaColumns.find(c => c.toLowerCase().includes(entityMatch.toLowerCase()))
    : undefined;

  // Find best time anchor match
  const timeMatch = contract.time_anchor_candidates.find(p =>
    lowerCols.some(c => c.includes(p.toLowerCase()))
  );
  const matchedTimeCol = timeMatch
    ? schemaColumns.find(c => c.toLowerCase().includes(timeMatch.toLowerCase()))
    : undefined;

  // Find state columns for state→event conversion
  const stateMatch = contract.state_to_event_candidates.find(p =>
    lowerCols.some(c => c.includes(p.toLowerCase()))
  );
  const matchedStateCol = stateMatch
    ? schemaColumns.find(c => c.toLowerCase().includes(stateMatch.toLowerCase()))
    : undefined;

  // Find recommended target match
  const targetMatch = contract.recommended_target_patterns.find(p =>
    lowerCols.some(c => c.includes(p.toLowerCase()))
  );
  const matchedTargetCol = targetMatch
    ? schemaColumns.find(c => c.toLowerCase().includes(targetMatch.toLowerCase()))
    : undefined;

  // Card 1: Best recommended path
  if (contract.target_modes_allowed.includes("assisted_build")) {
    cards.push({
      id: "assisted",
      title: "Construção assistida do alvo",
      description: matchedStateCol
        ? `Transformar "${matchedStateCol}" em evento temporal (ex: mudou em 30 dias)`
        : "Deixar o sistema criar o alvo com base em regras de negócio",
      variant: "recommended",
      action: {
        mode: "assisted_build",
        targetColumn: matchedStateCol || undefined,
        windowDays: 30,
        anchorCol: matchedTimeCol || undefined,
        entityKey: matchedEntityCol || undefined,
        timeAnchor: matchedTimeCol || undefined,
        problemType: contract.problem_type_default === "clustering" ? undefined : contract.problem_type_default,
      },
    });
  } else if (matchedTargetCol) {
    cards.push({
      id: "direct_target",
      title: `Usar "${matchedTargetCol}" como alvo`,
      description: "Essa coluna parece adequada para o objetivo escolhido",
      variant: "recommended",
      action: {
        mode: "choose_existing",
        targetColumn: matchedTargetCol,
        entityKey: matchedEntityCol || undefined,
        timeAnchor: matchedTimeCol || undefined,
        problemType: contract.problem_type_default,
      },
    });
  }

  // Card 2: Alternative
  if (matchedTargetCol && cards[0]?.action.mode === "assisted_build") {
    cards.push({
      id: "direct_column",
      title: `Usar coluna "${matchedTargetCol}" diretamente`,
      description: "Usar essa coluna existente como alvo, sem transformação",
      variant: "alternative",
      action: {
        mode: "choose_existing",
        targetColumn: matchedTargetCol,
        entityKey: matchedEntityCol || undefined,
        problemType: contract.problem_type_default,
      },
    });
  } else if (contract.target_modes_allowed.includes("quick_label") && !cards.some(c => c.id === "assisted")) {
    cards.push({
      id: "quick_label",
      title: "Rotulagem rápida",
      description: "Criar rótulos automaticamente com regras simples",
      variant: "alternative",
      action: {
        mode: "quick_label",
        entityKey: matchedEntityCol || undefined,
        problemType: "classification",
      },
    });
  }

  // Card 3: Advanced (only if advancedMode)
  if (advancedMode) {
    cards.push({
      id: "manual_advanced",
      title: "Configuração manual (avançado)",
      description: "Escolher qualquer coluna como alvo, sem restrições",
      variant: "advanced",
      action: {
        mode: "manual",
        entityKey: matchedEntityCol || undefined,
      },
    });
  }

  return cards.slice(0, 3);
}

const BusinessGuidancePanel = ({
  contract,
  objectiveLabel,
  industryLabel,
  schemaColumns = [],
  advancedMode = false,
  onApplySuggestion,
}: BusinessGuidancePanelProps) => {
  const recs = contract.target_recommendations;
  const cards = schemaColumns.length > 0
    ? buildSuggestionCards(contract, schemaColumns, advancedMode)
    : [];

  return (
    <Card className="border border-primary/20 bg-primary/5 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold">
          Guia do seu objetivo: {objectiveLabel}
        </h3>
        <Badge variant="outline" className="text-[10px] ml-auto">{industryLabel}</Badge>
      </div>

      {/* Suggestion Cards */}
      {cards.length > 0 && onApplySuggestion && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(card => {
            const style = VARIANT_STYLES[card.variant];
            return (
              <div
                key={card.id}
                className={`p-3 rounded-lg border ${style.border} ${style.bg} space-y-2`}
              >
                <div className="flex items-center gap-1.5">
                  {style.icon}
                  <Badge className={`${style.badge} text-[9px]`}>{style.badgeLabel}</Badge>
                </div>
                <p className="text-sm font-medium">{card.title}</p>
                <p className="text-xs text-muted-foreground">{card.description}</p>
                <Button
                  size="sm"
                  variant={card.variant === "recommended" ? "default" : "outline"}
                  className="w-full h-7 text-xs"
                  onClick={() => onApplySuggestion(card)}
                >
                  <Sparkles className="w-3 h-3 mr-1" />
                  Aplicar
                </Button>
              </div>
            );
          })}
        </div>
      )}

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
