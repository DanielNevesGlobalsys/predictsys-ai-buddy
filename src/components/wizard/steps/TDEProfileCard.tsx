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
  User, Clock, DollarSign, Tag, FileText,
  Loader2, RefreshCw, Sparkles, ChevronDown, ChevronUp,
  AlertTriangle, Layers,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { extractErrorMessage } from "@/lib/extractErrorMessage";

// ═══ Types ═════════════════════════════════════════════════════

interface ScoredCandidate {
  column: string;
  score: number;
  reasons: string[];
}

interface TDEProfile {
  dataset_shape: string;
  dataset_shape_label: string;
  candidates: {
    entity_candidates: ScoredCandidate[];
    time_candidates: ScoredCandidate[];
    value_candidates: ScoredCandidate[];
    status_candidates: ScoredCandidate[];
    text_candidates: ScoredCandidate[];
  };
  summary: string[];
  gates: { gate: string; status: "WARN"; message: string }[];
  profiled_at: string;
  total_rows: number;
  total_cols: number;
}

interface TDEProfileCardProps {
  projectId: string;
}

// ═══ Helpers ═══════════════════════════════════════════════════

const SHAPE_ICONS: Record<string, string> = {
  transactional: "🔄",
  snapshot: "📸",
  events: "⚡",
  timeseries: "📈",
};

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.min(Math.round(score * 10), 100);
  if (pct >= 70)
    return <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">{pct}%</Badge>;
  if (pct >= 40)
    return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">{pct}%</Badge>;
  return <Badge variant="outline" className="text-[10px]">{pct}%</Badge>;
}

// ═══ Component ═════════════════════════════════════════════════

export default function TDEProfileCard({ projectId }: TDEProfileCardProps) {
  const { toast } = useToast();
  const [profile, setProfile] = useState<TDEProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [hasRun, setHasRun] = useState(false);

  // Load cached tde_profile from AI context
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const { data } = await supabase
        .from("project_ai_context")
        .select("context")
        .eq("project_id", projectId)
        .maybeSingle();
      if (data?.context) {
        const ctx = data.context as Record<string, any>;
        if (ctx.tde_profile) {
          const p = ctx.tde_profile as Record<string, any>;
          // Ensure dataset_shape_label always has a value (defensive for virtual datasets)
          if (!p.dataset_shape_label) {
            p.dataset_shape_label = p.is_virtual_dataset ? "Dataset externo / virtual" : "Não disponível";
          }
          if (!p.candidates) {
            p.candidates = { entity_candidates: [], time_candidates: [], value_candidates: [], status_candidates: [], text_candidates: [] };
          }
          if (!p.summary) p.summary = [];
          if (!p.gates) p.gates = [];
          setProfile(p as TDEProfile);
          setHasRun(true);
        }
      }
    })();
  }, [projectId]);

  const runProfile = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("tde-profile-dataset", {
        body: { project_id: projectId },
      });
      if (error) throw error;
      if (!data?.success) {
        const friendlyMessage =
          data?.error_friendly || data?.message || data?.error || "Falha no profiling";
        throw new Error(friendlyMessage);
      }

      setProfile(data.tde_profile as TDEProfile);
      setHasRun(true);
      toast({ title: "Perfil do dataset atualizado", description: `Classificado como ${data.tde_profile.dataset_shape_label}.` });
    } catch (err) {
      console.error("[TDEProfileCard] Error:", err);
      const message = await extractErrorMessage(err);
      toast({ title: "Erro no profiling", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  const candidateRows = profile ? [
    { icon: User, label: "Entidade (ID)", items: profile.candidates.entity_candidates },
    { icon: Clock, label: "Data / Tempo", items: profile.candidates.time_candidates },
    { icon: DollarSign, label: "Valor Numérico", items: profile.candidates.value_candidates },
    { icon: Tag, label: "Status / Evento", items: profile.candidates.status_candidates },
    { icon: FileText, label: "Texto Livre", items: profile.candidates.text_candidates },
  ] : [];

  return (
    <Card className="border border-secondary/30 bg-secondary/5 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-secondary/10 transition-colors"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Layers className="w-4 h-4 text-secondary" />
          <span className="text-sm font-semibold">Target Discovery — Perfil do Dataset</span>
          {profile && (
            <>
              <Badge variant="outline" className="text-[10px]">
                {SHAPE_ICONS[profile.dataset_shape] || "📊"} {profile.dataset_shape_label}
              </Badge>
              <Badge className="bg-secondary/20 text-secondary border-secondary/30 text-[10px]">
                Baseado no EDA
              </Badge>
            </>
          )}
          {profile?.profiled_at && (
            <span className="text-[10px] text-muted-foreground ml-auto hidden sm:inline">
              Última atualização: {new Date(profile.profiled_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
            </span>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Action button */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={hasRun ? "outline" : "default"}
              onClick={runProfile}
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
              {hasRun ? "Atualizar detecção" : "Detectar estrutura"}
            </Button>
            {!hasRun && (
              <span className="text-xs text-muted-foreground">
                Classifica o dataset e mapeia candidatos para entidade, tempo, valor, status e texto.
              </span>
            )}
          </div>

          {/* Summary */}
          {profile && profile.summary.length > 0 && (
            <div className="p-3 rounded-lg bg-background/50 border border-border/50 space-y-1">
              {profile.summary.map((line, i) => (
                <p key={i} className="text-xs text-muted-foreground" dangerouslySetInnerHTML={{
                  __html: line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground">$1</strong>'),
                }} />
              ))}
            </div>
          )}

          {/* Candidate grid */}
          {profile && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {candidateRows.map(({ icon: Icon, label, items }) => {
                const best = items[0] || null;
                return (
                  <div
                    key={label}
                    className="flex items-start gap-2.5 p-3 rounded-lg bg-background/50 border border-border/50"
                  >
                    <Icon className="w-4 h-4 text-secondary mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-xs font-medium text-muted-foreground">{label}</span>
                        {best && <ConfidenceBadge score={best.score} />}
                      </div>
                      {best ? (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="text-sm font-mono font-medium truncate cursor-help">
                                {best.column}
                                {items.length > 1 && (
                                  <span className="text-muted-foreground text-[10px] ml-1">
                                    +{items.length - 1}
                                  </span>
                                )}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-xs">
                              <p className="text-xs font-semibold mb-1">Motivos ({best.column}):</p>
                              {best.reasons.map((r, i) => (
                                <p key={i} className="text-xs">• {r}</p>
                              ))}
                              {items.length > 1 && (
                                <>
                                  <p className="text-xs font-semibold mt-2">Outros candidatos:</p>
                                  {items.slice(1, 4).map((c, i) => (
                                    <p key={i} className="text-xs text-muted-foreground">
                                      {c.column} ({Math.min(Math.round(c.score * 10), 100)}%)
                                    </p>
                                  ))}
                                </>
                              )}
                            </TooltipContent>
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

          {/* Gates (warnings) */}
          {profile?.gates && profile.gates.length > 0 && (
            <div className="space-y-1">
              {profile.gates.map((gate, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-amber-600">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{gate.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
