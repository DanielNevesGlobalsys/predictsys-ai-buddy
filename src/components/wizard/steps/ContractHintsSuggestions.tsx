import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  User, Clock, Zap, TrendingUp, CheckCircle, AlertTriangle,
  XCircle, Loader2, RefreshCw, Sparkles, ChevronDown, ChevronUp,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

// ═══ Types ═════════════════════════════════════════════════════

interface SuggestionSingle {
  column: string | null;
  confidence: number;
  reasons: string[];
}

interface SuggestionMulti {
  columns: string[];
  confidence: number;
  reasons: string[];
}

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
}

interface InferenceResult {
  success: boolean;
  suggestions: {
    entity_key: SuggestionSingle;
    time_anchor: SuggestionSingle;
    event_candidates: SuggestionMulti;
    value_candidates: SuggestionMulti;
  };
  gates: GateResult[];
}

interface ContractHintsSuggestionsProps {
  projectId: string;
  onHintsLoaded?: (hints: InferenceResult["suggestions"]) => void;
}

// ═══ Confidence Badge ══════════════════════════════════════════

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  if (pct >= 70)
    return <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">{pct}%</Badge>;
  if (pct >= 40)
    return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">{pct}%</Badge>;
  return <Badge variant="outline" className="text-[10px]">{pct}%</Badge>;
}

// ═══ Gate Icon ═════════════════════════════════════════════════

function GateIcon({ status }: { status: "PASS" | "WARN" | "BLOCK" }) {
  if (status === "PASS") return <CheckCircle className="w-3.5 h-3.5 text-accent" />;
  if (status === "WARN") return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
  return <XCircle className="w-3.5 h-3.5 text-destructive" />;
}

// ═══ Component ═════════════════════════════════════════════════

export default function ContractHintsSuggestions({ projectId, onHintsLoaded }: ContractHintsSuggestionsProps) {
  const { toast } = useToast();
  const [result, setResult] = useState<InferenceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [hasRun, setHasRun] = useState(false);

  // Load cached hints from AI context first
  useEffect(() => {
    if (!projectId) return;
    loadCachedHints();
  }, [projectId]);

  const loadCachedHints = async () => {
    const { data } = await supabase
      .from("project_ai_context")
      .select("context")
      .eq("project_id", projectId)
      .maybeSingle();

    if (data?.context) {
      const ctx = data.context as Record<string, any>;
      if (ctx.contract_hints) {
        const hints = ctx.contract_hints;
        // Reconstruct minimal result from cached hints
        const cached: InferenceResult = {
          success: true,
          suggestions: {
            entity_key: { column: hints.entity_key, confidence: hints.confidence?.entity_key || 0, reasons: [] },
            time_anchor: { column: hints.time_anchor_column, confidence: hints.confidence?.time_anchor || 0, reasons: [] },
            event_candidates: { columns: hints.event_candidates || [], confidence: hints.confidence?.events || 0, reasons: [] },
            value_candidates: { columns: hints.value_candidates || [], confidence: hints.confidence?.values || 0, reasons: [] },
          },
          gates: [],
        };
        setResult(cached);
        setHasRun(true);
        onHintsLoaded?.(cached.suggestions);
      }
    }
  };

  const runInference = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("infer-entity-and-time", {
        body: { project_id: projectId },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Falha na inferência");

      setResult(data as InferenceResult);
      setHasRun(true);
      onHintsLoaded?.(data.suggestions);

      toast({
        title: "Sugestões atualizadas",
        description: "Chaves de entidade, tempo, evento e valor foram detectadas automaticamente.",
      });
    } catch (err) {
      console.error("[ContractHintsSuggestions] Error:", err);
      toast({
        title: "Erro na detecção automática",
        description: err instanceof Error ? err.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [projectId, onHintsLoaded, toast]);

  const suggestions = result?.suggestions;

  const items = suggestions ? [
    {
      icon: User,
      label: "Entidade (ID)",
      value: suggestions.entity_key.column,
      confidence: suggestions.entity_key.confidence,
      reasons: suggestions.entity_key.reasons,
    },
    {
      icon: Clock,
      label: "Âncora Temporal",
      value: suggestions.time_anchor.column,
      confidence: suggestions.time_anchor.confidence,
      reasons: suggestions.time_anchor.reasons,
    },
    {
      icon: Zap,
      label: "Candidatos a Evento",
      value: suggestions.event_candidates.columns.length > 0
        ? suggestions.event_candidates.columns.join(", ")
        : null,
      confidence: suggestions.event_candidates.confidence,
      reasons: suggestions.event_candidates.reasons,
    },
    {
      icon: TrendingUp,
      label: "Candidatos a Valor",
      value: suggestions.value_candidates.columns.length > 0
        ? suggestions.value_candidates.columns.join(", ")
        : null,
      confidence: suggestions.value_candidates.confidence,
      reasons: suggestions.value_candidates.reasons,
    },
  ] : [];

  return (
    <Card className="border border-primary/20 bg-primary/5 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-primary/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Sugestões Automáticas (Adapter)</span>
          {hasRun && suggestions && (
            <Badge variant="outline" className="text-[10px]">
              {[suggestions.entity_key.column, suggestions.time_anchor.column].filter(Boolean).length}/2 chaves
            </Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Run / Refresh button */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={hasRun ? "outline" : "default"}
              onClick={runInference}
              disabled={loading}
              className={!hasRun ? "bg-gradient-primary" : ""}
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              ) : hasRun ? (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              )}
              {hasRun ? "Reanalisar" : "Detectar Chaves"}
            </Button>
            {!hasRun && (
              <span className="text-xs text-muted-foreground">
                Analisa colunas com base no adaptador de indústria do contrato de intenção.
              </span>
            )}
          </div>

          {/* Suggestions grid */}
          {suggestions && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.label}
                    className="flex items-start gap-2.5 p-3 rounded-lg bg-background/50 border border-border/50"
                  >
                    <Icon className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
                        {item.value && <ConfidenceBadge confidence={item.confidence} />}
                      </div>
                      {item.value ? (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="text-sm font-mono font-medium truncate cursor-help">
                                {item.value}
                              </p>
                            </TooltipTrigger>
                            {item.reasons.length > 0 && (
                              <TooltipContent side="bottom" className="max-w-xs">
                                <p className="text-xs font-semibold mb-1">Motivos:</p>
                                {item.reasons.map((r, i) => (
                                  <p key={i} className="text-xs">• {r}</p>
                                ))}
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">Não detectado</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Gates */}
          {result?.gates && result.gates.length > 0 && (
            <div className="space-y-1">
              {result.gates.map((gate, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <GateIcon status={gate.status} />
                  <span className={gate.status === "BLOCK" ? "text-destructive" : gate.status === "WARN" ? "text-amber-600" : "text-muted-foreground"}>
                    {gate.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
