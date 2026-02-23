import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sparkles, Loader2, CheckCircle, AlertTriangle, ChevronDown, ChevronUp,
  Eye, Wand2, Star, RefreshCw, User, Clock, DollarSign, Tag, FileText,
  Settings2, Info, XCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { LABEL_TEMPLATES, type LabelTemplate } from "@/config/labelTemplates";
import {
  TARGET_STRATEGIES, STRATEGY_LIST, resolveStrategyFromSignals,
  type TargetStrategy,
} from "@/config/targetStrategies";
import TargetPrerequisitesModal from "./TargetPrerequisitesModal";

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
  profiled_at: string;
  total_rows: number;
  total_cols: number;
}

interface TDERecommendation {
  template_id: string;
  confidence: number;
  business_name: string;
  business_title?: string;
  business_summary?: string;
  why_this: string[];
  params_suggestion: Record<string, unknown>;
  required_signals: string[];
  expected_problem_type: string;
  is_fallback: boolean;
  rank_reason?: string;
  expected_quality?: string;
}

interface TDERecommendResponse {
  success: boolean;
  recommendations: TDERecommendation[];
  fallback_used: boolean;
  notes: string[];
  signals: {
    entity_ok: boolean;
    time_ok: boolean;
    value_ok: boolean;
    status_ok: boolean;
    shape: string;
  };
  compliance_restrictions?: {
    disable_free_text_feedback?: boolean;
  };
}

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
}

interface PreviewStats {
  total_rows_sampled: number;
  entity_count: number;
  positive_rate: number;
  distinct_target_values: number;
  top_class_pct: number;
  per_period_distribution: { period: string; positives: number; total: number; positive_rate: number }[];
  notes: string[];
}

interface PreviewResult {
  success: boolean;
  template_id: string;
  params: Record<string, any>;
  preview: PreviewStats | null;
  gates: GateResult[];
  builder_id?: string;
  builder_status?: string;
}

interface Props {
  projectId: string;
  industry?: string;
  onBuilderReady?: (builderId: string, templateId: string, params: Record<string, any>) => void;
  onWeakSupervisionActivated?: () => void;
  onHumanLabelingActivated?: () => void;
}

// ═══ Helpers ═══════════════════════════════════════════════════

const SHAPE_LABELS: Record<string, string> = {
  transactional: "Transacional",
  snapshot: "Foto estática",
  events: "Eventos",
  timeseries: "Série temporal",
};

function ConfidencePill({ score }: { score: number }) {
  const pct = Math.min(Math.round(score * 10), 100);
  if (pct >= 70) return <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">{pct}%</Badge>;
  if (pct >= 40) return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">{pct}%</Badge>;
  return <Badge variant="outline" className="text-[10px]">{pct}%</Badge>;
}

function GateIcon({ status }: { status: "PASS" | "WARN" | "BLOCK" }) {
  if (status === "PASS") return <CheckCircle className="w-3.5 h-3.5 text-accent" />;
  if (status === "WARN") return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
  return <XCircle className="w-3.5 h-3.5 text-destructive" />;
}

const SIGNAL_ICONS = [
  { key: "entity", icon: User, label: "Entidade (ID)" },
  { key: "time", icon: Clock, label: "Data / Tempo" },
  { key: "value", icon: DollarSign, label: "Valor" },
  { key: "status", icon: Tag, label: "Status / Evento" },
  { key: "text", icon: FileText, label: "Texto" },
];

// ═══ RecCard (extracted to avoid hooks-in-loop) ════════════════

function RecCard({ rec, isTop, isActive, onSelect }: {
  rec: TDERecommendation; isTop: boolean; isActive: boolean; onSelect: () => void;
}) {
  const [showTech, setShowTech] = useState(false);
  const title = rec.business_title || rec.business_name;
  const summary = rec.business_summary || "";

  return (
    <div
      className={`relative p-3 rounded-lg border transition-all cursor-pointer hover:shadow-md ${
        isActive ? "border-primary bg-primary/10 shadow-sm"
          : rec.is_fallback ? "border-amber-500/30 bg-amber-500/5 hover:border-amber-500/50"
          : "border-accent/30 bg-accent/5 hover:border-accent/50"
      }`}
      onClick={onSelect}
    >
      {isTop && (
        <Badge className="absolute -top-2 -right-2 bg-primary text-primary-foreground text-[9px] px-1.5">
          Melhor opção
        </Badge>
      )}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <p className="text-xs font-semibold leading-tight">{title}</p>
        <Badge variant="outline" className={`text-[10px] shrink-0 ${
          rec.confidence >= 0.7 ? "border-accent/50 text-accent" :
          rec.confidence >= 0.5 ? "border-primary/50 text-primary" :
          "border-muted-foreground/50 text-muted-foreground"
        }`}>
          {(rec.confidence * 100).toFixed(0)}%
        </Badge>
      </div>
      {summary ? (
        <p className="text-[10px] text-muted-foreground mb-2 leading-relaxed">{summary}</p>
      ) : rec.why_this.length > 0 ? (
        <ul className="space-y-0.5 mb-2">
          {rec.why_this.slice(0, 2).map((reason, i) => (
            <li key={i} className="text-[10px] text-muted-foreground flex items-start gap-1">
              <span className="text-primary mt-0.5">•</span><span>{reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        className="text-[10px] text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1"
        onClick={(e) => { e.stopPropagation(); setShowTech(!showTech); }}
      >
        {showTech ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {showTech ? "Ocultar detalhes" : "Ver detalhes"}
      </button>
      {showTech && (
        <div className="text-[10px] text-muted-foreground space-y-0.5 mb-2 p-2 bg-muted/30 rounded">
          <p><span className="font-medium">ID:</span> {rec.template_id}</p>
          <p><span className="font-medium">Tipo:</span> {rec.expected_problem_type === "classification" ? "Classificação" : "Regressão"}</p>
          {rec.rank_reason && <p><span className="font-medium">Razão:</span> {rec.rank_reason}</p>}
          {rec.expected_quality && <p><span className="font-medium">Qualidade esperada:</span> {rec.expected_quality}</p>}
        </div>
      )}
      <Button
        variant={isActive ? "default" : "outline"}
        size="sm"
        className="w-full text-[11px] h-7"
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
      >
        {isActive ? (
          <><CheckCircle className="w-3 h-3 mr-1" /> Selecionado</>
        ) : (
          <><Wand2 className="w-3 h-3 mr-1" /> Usar esta forma</>
        )}
      </Button>
    </div>
  );
}

// ═══ Component ═════════════════════════════════════════════════

export default function TargetStrategyPanel({
  projectId,
  industry,
  onBuilderReady,
}: Props) {
  const { toast } = useToast();

  // TDE Profile
  const [profile, setProfile] = useState<TDEProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  // TDE Recommendations
  const [recs, setRecs] = useState<TDERecommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsLoaded, setRecsLoaded] = useState(false);
  const [fallbackUsed, setFallbackUsed] = useState(false);

  // Resolved strategy
  const [resolvedStrategy, setResolvedStrategy] = useState<TargetStrategy | null>(null);
  const [signals, setSignals] = useState<TDERecommendResponse["signals"] | null>(null);

  // Selection & preview
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [params, setParams] = useState<Record<string, any>>({});
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Prerequisites modal
  const [prereqOpen, setPrereqOpen] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);

  // Expanded sections
  const [showDatasetDetails, setShowDatasetDetails] = useState(false);

  // ─── Load TDE Profile from cache ─────────────────────────────
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
          setProfile(ctx.tde_profile as TDEProfile);
        }
      }
    })();
  }, [projectId]);

  // ─── Fetch TDE Recommendations ───────────────────────────────
  const fetchRecommendations = useCallback(async () => {
    setRecsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("tde-recommend-targets", {
        body: { project_id: projectId },
      });
      if (error) throw error;
      const resp = data as TDERecommendResponse;
      if (resp.success) {
        setRecs(resp.recommendations || []);
        setFallbackUsed(resp.fallback_used);
        setSignals(resp.signals);

        // Resolve strategy
        if (resp.signals) {
          const strat = resolveStrategyFromSignals(resp.signals);
          setResolvedStrategy(strat);
        }

        // Auto-select top recommendation
        if (resp.recommendations?.length > 0 && !selectedTemplateId) {
          const topRec = resp.recommendations[0];
          setSelectedTemplateId(topRec.template_id);
          const tmpl = LABEL_TEMPLATES[topRec.template_id];
          if (tmpl) {
            const defaults: Record<string, any> = {};
            for (const p of tmpl.params) {
              defaults[p.key] = (topRec.params_suggestion as any)?.[p.key] ?? p.default_value;
            }
            setParams(defaults);
          }
        }
      }
    } catch (err) {
      console.error("[TargetStrategyPanel] Recommendations error:", err);
    } finally {
      setRecsLoading(false);
      setRecsLoaded(true);
    }
  }, [projectId, selectedTemplateId]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  // ─── Auto-resolve & check prerequisites ──────────────────────
  const AUTO_CONF_THRESHOLD = 8; // score >= 8 (out of 10) = auto-resolve

  const autoResolvePrerequisites = useCallback(async (templateId: string): Promise<string[]> => {
    const tmpl = LABEL_TEMPLATES[templateId];
    if (!tmpl) return [];
    const cands = profile?.candidates;
    if (!cands) return [];

    const resolved: Record<string, string> = {};
    const missing: string[] = [];

    // Entity key
    if (tmpl.requires_entity_key) {
      const best = cands.entity_candidates?.[0];
      if (best && best.score >= AUTO_CONF_THRESHOLD) {
        resolved.entity_key = best.column;
      } else {
        missing.push("entity_key");
      }
    }

    // Time anchor
    if (tmpl.requires_time_anchor) {
      const best = cands.time_candidates?.[0];
      if (best && best.score >= AUTO_CONF_THRESHOLD) {
        resolved.time_anchor = best.column;
      } else {
        missing.push("time_anchor");
      }
    }

    // If we have auto-resolved values, persist them to SSOT
    if (Object.keys(resolved).length > 0) {
      const updatePayload: Record<string, unknown> = {};
      if (resolved.entity_key) updatePayload.entity_key = resolved.entity_key;
      if (resolved.time_anchor) updatePayload.time_anchor_column = resolved.time_anchor;

      console.log("[TargetStrategyPanel] Auto-resolving prerequisites:", resolved);

      await supabase
        .from("project_settings")
        .update(updatePayload as any)
        .eq("project_id", projectId);
    }

    return missing;
  }, [profile, projectId]);

  // ─── Select recommendation ──────────────────────────────────
  const handleSelectRecommendation = (rec: TDERecommendation) => {
    setSelectedTemplateId(rec.template_id);
    const tmpl = LABEL_TEMPLATES[rec.template_id];
    if (tmpl) {
      const merged: Record<string, any> = {};
      for (const p of tmpl.params) {
        merged[p.key] = (rec.params_suggestion as any)?.[p.key] ?? p.default_value;
      }
      setParams(merged);
    }
    setPreviewResult(null);
  };

  // ─── Run preview & activate ─────────────────────────────────
  const handleActivate = useCallback(async () => {
    if (!selectedTemplateId) return;

    // Auto-resolve high-confidence prerequisites, only prompt for truly missing ones
    const missing = await autoResolvePrerequisites(selectedTemplateId);
    if (missing.length > 0) {
      setMissingFields(missing);
      setPrereqOpen(true);
      return;
    }

    setPreviewLoading(true);
    try {
      // Preview
      const { data, error } = await supabase.functions.invoke("preview-target-template", {
        body: { project_id: projectId, template_id: selectedTemplateId, params },
      });
      if (error) throw error;
      const result = data as PreviewResult;
      setPreviewResult(result);

      const hasBlock = result?.gates?.some(g => g.status === "BLOCK");

      if (result?.builder_status === "ready" && result?.builder_id && !hasBlock) {
        // Activate
        const tmplDef = LABEL_TEMPLATES[selectedTemplateId];
        const { data: activateData, error: activateErr } = await supabase.functions.invoke(
          "activate-target-template",
          {
            body: {
              project_id: projectId,
              template_id: selectedTemplateId,
              params: { ...params, problem_type: tmplDef?.problem_type || "classification" },
            },
          },
        );
        if (activateErr) {
          console.error("[TargetStrategyPanel] Activate error:", activateErr);
        } else if (activateData?.success) {
          toast({
            title: "Alvo definido com sucesso",
            description: "O alvo foi gerado e configurado automaticamente.",
          });
        }
        onBuilderReady?.(result.builder_id, selectedTemplateId, params);
      } else if (hasBlock) {
        const blockMessages = result.gates.filter(g => g.status === "BLOCK").map(g => g.message);
        toast({
          title: "Verificação falhou",
          description: blockMessages.length > 0
            ? blockMessages.join(" | ")
            : "O alvo não passou nas verificações de qualidade. Ajuste os parâmetros.",
          variant: "destructive",
        });
      }
    } catch (err) {
      console.error("[TargetStrategyPanel] Preview/activate error:", err);
      toast({
        title: "Erro",
        description: err instanceof Error ? err.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setPreviewLoading(false);
    }
  }, [projectId, selectedTemplateId, params, onBuilderReady, toast, profile, autoResolvePrerequisites]);

  const handlePrereqSave = (config: Record<string, string>) => {
    // After saving prereqs, retry activation
    setTimeout(() => handleActivate(), 500);
  };

  const template = selectedTemplateId ? LABEL_TEMPLATES[selectedTemplateId] : null;
  const hasBlock = previewResult?.gates?.some(g => g.status === "BLOCK");
  const isReady = previewResult?.builder_status === "ready" && !hasBlock;

  return (
    <TooltipProvider>
      <Card className="border border-primary/20 bg-primary/[0.02] overflow-hidden">
        {/* ═══ Section 1: Dataset Understanding ═══ */}
        <div className="p-4 space-y-3 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">Entendemos seu dataset</span>
              {profile && (
                <Badge variant="outline" className="text-[10px]">
                  {SHAPE_LABELS[profile.dataset_shape] || profile.dataset_shape_label}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-[10px] h-6"
              onClick={() => setShowDatasetDetails(!showDatasetDetails)}
            >
              {showDatasetDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </Button>
          </div>

          {/* Inline signal summary */}
          {profile && (
            <div className="flex flex-wrap gap-2">
              {SIGNAL_ICONS.map(({ key, icon: Icon, label }) => {
                const candidateKey = `${key}_candidates` as keyof typeof profile.candidates;
                const items = profile.candidates[candidateKey] || [];
                const best = items[0];
                return (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs ${
                        best && best.score >= 7
                          ? "border-accent/30 bg-accent/5 text-foreground"
                          : best
                            ? "border-border bg-muted/30 text-muted-foreground"
                            : "border-border/50 bg-muted/10 text-muted-foreground/60"
                      }`}>
                        <Icon className="w-3.5 h-3.5" />
                        <span className="font-medium">{best ? best.column : "—"}</span>
                        {best && <ConfidencePill score={best.score} />}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p className="text-xs font-semibold mb-1">{label}</p>
                      {best ? (
                        <>
                          {best.reasons.map((r, i) => <p key={i} className="text-xs">• {r}</p>)}
                          {items.length > 1 && (
                            <p className="text-xs mt-1 text-muted-foreground">
                              +{items.length - 1} outro(s): {items.slice(1, 3).map(c => c.column).join(", ")}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">Nenhum candidato detectado</p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          )}

          {!profile && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Info className="w-3.5 h-3.5" />
              Rode o EDA para que o sistema detecte automaticamente a estrutura do seu dataset.
            </div>
          )}

          {/* Expanded details */}
          {showDatasetDetails && profile && (
            <div className="p-3 rounded-lg bg-muted/20 border border-border/50 space-y-1 text-xs text-muted-foreground">
              {profile.summary.map((line, i) => (
                <p key={i} dangerouslySetInnerHTML={{
                  __html: line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground">$1</strong>'),
                }} />
              ))}
              {profile.profiled_at && (
                <p className="text-[10px] mt-2">
                  Última análise: {new Date(profile.profiled_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ═══ Section 2: Strategy Recommendations ═══ */}
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Star className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">Forma de construir o alvo</span>
              {resolvedStrategy && (
                <Badge className="bg-primary/10 text-primary border-primary/20 text-[10px]">
                  {resolvedStrategy.icon_emoji} {resolvedStrategy.label}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px]"
              onClick={fetchRecommendations}
              disabled={recsLoading}
            >
              {recsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </Button>
          </div>

          {/* Strategy description */}
          {resolvedStrategy && (
            <div className="p-3 bg-primary/5 border border-primary/10 rounded-lg">
              <p className="text-xs text-foreground leading-relaxed">
                <strong>{resolvedStrategy.label}:</strong> {resolvedStrategy.description}
              </p>
              {resolvedStrategy.health_disclaimer && industry === "health" && (
                <p className="text-[11px] text-amber-600 mt-1.5 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {resolvedStrategy.health_disclaimer}
                </p>
              )}
            </div>
          )}

          {/* Loading state */}
          {recsLoading && !recsLoaded && (
            <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Analisando seu dataset para recomendar a melhor forma...
            </div>
          )}

          {/* Top 3 recommendation cards */}
          {recsLoaded && recs.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {recs.map((rec, idx) => (
                <RecCard
                  key={rec.template_id}
                  rec={rec}
                  isTop={idx === 0}
                  isActive={selectedTemplateId === rec.template_id}
                  onSelect={() => handleSelectRecommendation(rec)}
                />
              ))}
            </div>
          )}

          {/* Fallback notice */}
          {recsLoaded && fallbackUsed && (
            <div className="flex items-start gap-2 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Forma genérica recomendada — revise os parâmetros para melhor adequação ao seu caso.
              </p>
            </div>
          )}

          {/* Parameter editor */}
          {template && selectedTemplateId && (
            <div className="space-y-3 p-3 bg-muted/20 rounded-lg border border-border/50">
              <p className="text-xs font-medium">Parâmetros</p>
              {template.params.map((paramDef) => (
                <div key={paramDef.key} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium">{paramDef.label}</label>
                    <Tooltip>
                      <TooltipTrigger><Info className="w-3 h-3 text-muted-foreground" /></TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <p className="text-xs">{paramDef.description}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {paramDef.type === "number" ? (
                    <input
                      type="number"
                      value={params[paramDef.key] ?? paramDef.default_value}
                      onChange={(e) => {
                        setParams(prev => ({ ...prev, [paramDef.key]: parseInt(e.target.value) || 0 }));
                        setPreviewResult(null);
                      }}
                      className="w-full h-8 text-sm px-3 rounded-md border border-input bg-background"
                    />
                  ) : paramDef.type === "string" ? (
                    <input
                      value={params[paramDef.key] ?? paramDef.default_value}
                      onChange={(e) => {
                        setParams(prev => ({ ...prev, [paramDef.key]: e.target.value }));
                        setPreviewResult(null);
                      }}
                      className="w-full h-8 text-sm px-3 rounded-md border border-input bg-background"
                    />
                  ) : (
                    <input
                      value={Array.isArray(params[paramDef.key]) ? params[paramDef.key].join(", ") : ""}
                      onChange={(e) => {
                        setParams(prev => ({ ...prev, [paramDef.key]: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) }));
                        setPreviewResult(null);
                      }}
                      placeholder="valor1, valor2, ..."
                      className="w-full h-8 text-sm px-3 rounded-md border border-input bg-background"
                    />
                  )}
                </div>
              ))}
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-background/50 p-2 rounded">
                <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary" />
                <span>{template.derivation_summary}</span>
              </div>
            </div>
          )}

          {/* Activate button */}
          {selectedTemplateId && (
            <Button
              onClick={handleActivate}
              disabled={previewLoading}
              className="w-full bg-gradient-primary"
            >
              {previewLoading ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Eye className="w-4 h-4 mr-2" />
              )}
              Verificar e ativar alvo
            </Button>
          )}

          {/* Preview results */}
          {previewResult?.preview && (
            <div className="space-y-3">
              <p className="text-sm font-semibold flex items-center gap-2">
                <Eye className="w-4 h-4 text-primary" />
                Resultado da verificação
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{(previewResult.preview.positive_rate * 100).toFixed(1)}%</p>
                  <p className="text-[10px] text-muted-foreground">Taxa Positiva</p>
                </div>
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{previewResult.preview.distinct_target_values}</p>
                  <p className="text-[10px] text-muted-foreground">Classes</p>
                </div>
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{(previewResult.preview.top_class_pct * 100).toFixed(1)}%</p>
                  <p className="text-[10px] text-muted-foreground">Classe Dominante</p>
                </div>
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{previewResult.preview.entity_count.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">Entidades</p>
                </div>
              </div>
            </div>
          )}

          {/* Gates */}
          {previewResult?.gates && previewResult.gates.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Verificações de qualidade</p>
              {previewResult.gates.map((g, i) => (
                <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                  <GateIcon status={g.status} />
                  <span>{g.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Success badge */}
          {isReady && (
            <div className="flex items-center gap-2 p-3 bg-accent/10 border border-accent/20 rounded-lg">
              <CheckCircle className="w-4 h-4 text-accent" />
              <span className="text-sm font-medium text-accent">Alvo configurado com sucesso!</span>
            </div>
          )}
        </div>

        {/* Prerequisites Modal */}
        {profile && (
          <TargetPrerequisitesModal
            open={prereqOpen}
            onOpenChange={setPrereqOpen}
            projectId={projectId}
            requiredFields={missingFields}
            candidates={{
              entity_candidates: profile.candidates.entity_candidates,
              time_candidates: profile.candidates.time_candidates,
              value_candidates: profile.candidates.value_candidates,
              status_candidates: profile.candidates.status_candidates,
            }}
            onSave={handlePrereqSave}
          />
        )}
      </Card>
    </TooltipProvider>
  );
}
