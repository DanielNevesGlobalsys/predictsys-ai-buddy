import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Target, Sparkles, Loader2, CheckCircle, AlertTriangle, Info,
  ChevronDown, ChevronUp, XCircle, Zap, RefreshCw, ShieldCheck, ShieldAlert,
} from "lucide-react";
import { useIntentDrivenTarget, type IntentTargetResolution, type TargetCandidateResolved } from "@/hooks/useIntentDrivenTarget";

interface Props {
  projectId: string;
  onApplyTarget?: (candidate: TargetCandidateResolved) => void;
  onApplyEntityKey?: (key: string) => void;
  onApplyTimeAnchor?: (col: string) => void;
  onApplyFeatures?: (features: string[], blocked: { column: string; reason: string }[]) => void;
  currentTarget?: string | null;
}

const STRATEGY_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  explicit: { label: "Alvo explícito", icon: <CheckCircle className="w-4 h-4" />, color: "text-accent" },
  derived: { label: "Alvo derivado", icon: <Sparkles className="w-4 h-4" />, color: "text-primary" },
  insufficient: { label: "Dados insuficientes", icon: <AlertTriangle className="w-4 h-4" />, color: "text-amber-500" },
};

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  if (pct >= 70) return <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">{pct}% confiança</Badge>;
  if (pct >= 40) return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">{pct}% confiança</Badge>;
  return <Badge variant="outline" className="text-[10px]">{pct}% confiança</Badge>;
}

export default function IntentTargetSummary({
  projectId,
  onApplyTarget,
  onApplyEntityKey,
  onApplyTimeAnchor,
  onApplyFeatures,
  currentTarget,
}: Props) {
  const { resolution, loading, loaded, error, loadFromSSOT, resolve, hasCandidate } = useIntentDrivenTarget(projectId);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [builderStatus, setBuilderStatus] = useState<"idle" | "running" | "done" | "error">("idle");

  useEffect(() => {
    loadFromSSOT();
  }, [loadFromSSOT]);

  /**
   * Auto-select minimum valid features from schema when AI returns none.
   */
  const autoSelectFeatures = async (
    targetCol: string,
    entityKey?: string | null,
    timeAnchor?: string | null,
    blockedFeatures?: { column: string; reason: string }[],
  ): Promise<string[]> => {
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data: cols } = await supabase
        .from("project_columns")
        .select("column_name, inferred_type")
        .eq("project_id", projectId)
        .limit(300);

      if (!cols || cols.length === 0) {
        // Fallback: try schema from project_dataset_state
        const { data: dsState } = await supabase
          .from("project_dataset_state")
          .select("active_schema_json")
          .eq("project_id", projectId)
          .maybeSingle();
        const schema = (dsState as any)?.active_schema_json;
        if (schema && typeof schema === "object") {
          const schemaKeys = Object.keys(schema).filter(k => !k.startsWith("_"));
          return filterFeatureColumns(schemaKeys, targetCol, entityKey, timeAnchor, blockedFeatures);
        }
        return [];
      }

      return filterFeatureColumns(
        cols.map((c: any) => c.column_name),
        targetCol, entityKey, timeAnchor, blockedFeatures,
      );
    } catch (err) {
      console.error("[IntentTargetSummary] autoSelectFeatures error:", err);
      return [];
    }
  };

  const filterFeatureColumns = (
    allColumns: string[],
    targetCol: string,
    entityKey?: string | null,
    timeAnchor?: string | null,
    blockedFeatures?: { column: string; reason: string }[],
  ): string[] => {
    const blockedSet = new Set<string>([
      targetCol,
      ...(entityKey ? [entityKey] : []),
      ...(timeAnchor ? [timeAnchor] : []),
      ...(blockedFeatures || []).map(b => b.column),
    ].map(c => c.toLowerCase()));

    const ID_PATTERNS = /^(id|_id$|uuid|pk_|fk_|idx_|index_|codigo|cod_|numero_|num_|chave_|key_)/i;
    const LEAKAGE_PATTERNS = /^(target|label|resultado|result|status_final|outcome|predicted|prediction|y_true|y_pred)/i;

    return allColumns.filter(col => {
      const lower = col.toLowerCase();
      if (blockedSet.has(lower)) return false;
      if (ID_PATTERNS.test(lower)) return false;
      if (LEAKAGE_PATTERNS.test(lower)) return false;
      if (lower.endsWith("_id") || lower.endsWith("_key") || lower.endsWith("_uuid")) return false;
      return true;
    });
  };

  /**
   * Persist the applied target, entity key, time anchor to BOTH project_settings (SSOT)
   * AND project_model_selection. Accepts explicit resolution data to avoid stale state reads.
   */
  const persistAppliedToSSOT = async (
    candidate: TargetCandidateResolved,
    entityKey?: string | null,
    timeAnchor?: string | null,
    features?: string[],
    blockedFeatures?: { column: string; reason: string }[],
    objective?: string | null,
  ) => {
    setPersisting(true);
    setBuilderStatus("idle");
    try {
      const { supabase } = await import("@/integrations/supabase/client");

      // For intent-resolved targets, always use "manual" + "column"
      const targetSource = "manual";
      const targetMode = "column";

      // 1. Ensure minimum valid features
      let selectedFeatures = features && features.length > 0 ? features : [];
      if (selectedFeatures.length === 0) {
        selectedFeatures = await autoSelectFeatures(candidate.column, entityKey, timeAnchor, blockedFeatures);
        console.log(`[IntentTargetSummary] Auto-selected ${selectedFeatures.length} features from schema`);
      }

      // Notify parent component of features
      if (selectedFeatures.length > 0) {
        onApplyFeatures?.(selectedFeatures, blockedFeatures || []);
      }

      // 2. Update project_settings SSOT FIRST with all fields including target_source/mode
      const settingsUpdate: Record<string, any> = {
        target_column: candidate.column,
        problem_type: candidate.problem_type,
        active_target_column: candidate.column,
        active_target_mode: targetMode,
        target_source: targetSource,
        target_state: "ready",
        feature_columns: selectedFeatures,
        updated_at: new Date().toISOString(),
      };
      if (entityKey) settingsUpdate.entity_key = entityKey;
      if (timeAnchor) settingsUpdate.time_anchor_column = timeAnchor;
      if (objective) settingsUpdate.objective = objective;

      await supabase
        .from("project_settings")
        .update(settingsUpdate)
        .eq("project_id", projectId);

      console.log(`[IntentTargetSummary] SSOT updated: target=${candidate.column}, entity=${entityKey}, time=${timeAnchor}, features=${selectedFeatures.length}, target_source=${targetSource}, mode=${targetMode}`);

      // 3. Sync project_model_selection via atomic upsert
      const upsertRes = await supabase.functions.invoke("upsert-model-selection", {
        body: {
          project_id: projectId,
          target_column: candidate.column,
          problem_type: candidate.problem_type || "classification",
          selected_features: selectedFeatures,
          excluded_features: [],
        },
      });

      console.log(`[IntentTargetSummary] model_selection upsert result:`, upsertRes.data);

      // 4. Auto-trigger builder if we have sufficient context
      if (selectedFeatures.length >= 3 && upsertRes.data?.success) {
        setBuilderStatus("running");
        console.log(`[IntentTargetSummary] Auto-triggering build-modeling-dataset with ${selectedFeatures.length} features...`);
        try {
          const builderRes = await supabase.functions.invoke("build-modeling-dataset", {
            body: { project_id: projectId },
          });
          if (builderRes.data?.success || builderRes.data?.status === "READY") {
            setBuilderStatus("done");
            console.log(`[IntentTargetSummary] Builder completed successfully`);
          } else {
            setBuilderStatus("error");
            console.warn(`[IntentTargetSummary] Builder returned:`, builderRes.data?.error || builderRes.data?.status);
          }
        } catch (builderErr) {
          setBuilderStatus("error");
          console.warn("[IntentTargetSummary] Builder auto-trigger failed (non-blocking):", builderErr);
        }
      } else if (selectedFeatures.length < 3) {
        console.warn(`[IntentTargetSummary] Only ${selectedFeatures.length} features — skipping builder auto-trigger (min 3)`);
      }
    } catch (err) {
      console.error("[IntentTargetSummary] Failed to persist to SSOT:", err);
    } finally {
      setPersisting(false);
    }
  };

  /**
   * Apply the full suggestion using EXPLICIT resolution data (not stale state).
   */
  const applyFullSuggestionFromResult = (
    candidate: TargetCandidateResolved,
    res: IntentTargetResolution,
  ) => {
    onApplyTarget?.(candidate);
    if (res.suggested_entity_key) onApplyEntityKey?.(res.suggested_entity_key);
    if (res.suggested_time_anchor) onApplyTimeAnchor?.(res.suggested_time_anchor);
    if (res.suggested_features.length > 0) {
      onApplyFeatures?.(res.suggested_features, res.blocked_features);
    }

    // Derive objective from business_fit_assessment or problem_type
    const objective = res.business_fit_assessment
      ? res.business_fit_assessment.substring(0, 200)
      : null;

    // Persist to SSOT + model_selection + auto-trigger builder
    persistAppliedToSSOT(
      candidate,
      res.suggested_entity_key,
      res.suggested_time_anchor,
      res.suggested_features,
      res.blocked_features,
      objective,
    );
  };

  const applyFullSuggestion = (candidate: TargetCandidateResolved) => {
    // Use current resolution state (for button clicks after state is already updated)
    applyFullSuggestionFromResult(candidate, resolution);
  };

  const handleResolve = async () => {
    const result = await resolve();
    if (result?.main_candidate && onApplyTarget) {
      // Auto-apply if confidence is high enough — use RESULT directly, not stale state
      if (result.confidence_score >= 0.6) {
        applyFullSuggestionFromResult(result.main_candidate, result);
      }
    }
  };

  // No resolution yet — show CTA
  if (!loaded || (!hasCandidate && !loading)) {
    return (
      <Card className="border border-primary/20 bg-primary/5 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold">Resolução inteligente do alvo</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Analise o contrato de intenção, EDA e dados para receber sugestões de alvo baseadas no objetivo do projeto.
        </p>
        <Button onClick={handleResolve} disabled={loading} className="w-full sm:w-auto">
          {loading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analisando...</>
          ) : (
            <><Sparkles className="w-4 h-4 mr-2" /> Resolver alvo pelo contrato de intenção</>
          )}
        </Button>
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="border border-primary/20 bg-primary/5 p-5">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Resolvendo alvo com base no contrato de intenção...</p>
        </div>
      </Card>
    );
  }

  const main = resolution.main_candidate;
  const strategyInfo = STRATEGY_LABELS[resolution.target_strategy_used] || STRATEGY_LABELS.insufficient;
  const isApplied = currentTarget === main?.column;

  return (
    <Card className="border border-primary/20 bg-gradient-to-br from-primary/5 to-accent/5 p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" />
          <h3 className="text-base font-semibold">Recomendação baseada no contrato de intenção</h3>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleResolve} disabled={loading}>
          <RefreshCw className={`w-3 h-3 mr-1 ${loading ? "animate-spin" : ""}`} />
          Reanalisar
        </Button>
      </div>

      {/* Insufficient data */}
      {resolution.is_insufficient && (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <AlertDescription className="text-sm">
            <strong>Dados insuficientes para sugestão automática.</strong> O dataset não possui sinais claros que
            permitam definir um alvo com segurança para o objetivo declarado. Considere:
            <ul className="list-disc pl-4 mt-1 space-y-0.5 text-xs text-muted-foreground">
              <li>Verificar se o contrato de intenção está preenchido (Etapa 1)</li>
              <li>Usar o modo assistido para criar um alvo derivado</li>
              <li>Escolher uma coluna manualmente no seletor abaixo</li>
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Main candidate */}
      {main && (
        <div className={`p-4 rounded-lg border space-y-3 ${
          isApplied ? "border-accent/40 bg-accent/5" : "border-primary/30 bg-background"
        }`}>
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={strategyInfo.color}>{strategyInfo.icon}</span>
                <Badge variant="outline" className="text-[10px]">{strategyInfo.label}</Badge>
                <ConfidenceBadge score={resolution.confidence_score} />
                {isApplied && (
                  <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
                    <CheckCircle className="w-3 h-3 mr-0.5" /> Aplicado
                  </Badge>
                )}
              </div>
              <p className="text-lg font-semibold">{main.column}</p>
              <p className="text-sm text-muted-foreground">
                {main.problem_type === "classification" ? "Classificação" :
                 main.problem_type === "regression" ? "Regressão" :
                 main.problem_type === "multiclass" ? "Classificação multiclasse" :
                 main.problem_type === "ranking" ? "Ranking / priorização" :
                 main.problem_type === "segmentation" ? "Segmentação" : main.problem_type}
              </p>
            </div>
            {!isApplied && onApplyTarget && (
              <Button size="sm" disabled={persisting} onClick={() => applyFullSuggestion(main)}>
                {persisting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Zap className="w-3 h-3 mr-1" />}
                Aplicar sugestão
              </Button>
            )}
          </div>

          {main.reasoning && (
            <p className="text-sm text-muted-foreground">{main.reasoning}</p>
          )}

          {resolution.is_derived && main.derivation_formula && (
            <div className="p-2 bg-muted/30 rounded text-xs font-mono text-muted-foreground">
              {main.derivation_formula}
            </div>
          )}
        </div>
      )}

      {/* Builder status feedback */}
      {(persisting || builderStatus !== "idle") && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-xs ${
          builderStatus === "running" || persisting ? "bg-primary/10 border border-primary/20" :
          builderStatus === "done" ? "bg-accent/10 border border-accent/20" :
          builderStatus === "error" ? "bg-amber-500/10 border border-amber-500/20" : ""
        }`}>
          {(persisting || builderStatus === "running") && (
            <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
            <span>{persisting && builderStatus === "idle" ? "Persistindo seleção..." : "Gerando dataset modelável..."}</span></>
          )}
          {builderStatus === "done" && !persisting && (
            <><CheckCircle className="w-3.5 h-3.5 text-accent" />
            <span className="text-accent font-medium">Seleção aplicada e dataset modelável gerado com sucesso!</span></>
          )}
          {builderStatus === "error" && !persisting && (
            <><AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            <span>Seleção aplicada, mas o dataset modelável precisa ser gerado manualmente na Etapa 4.</span></>
          )}
        </div>
      )}

      {/* Business fit assessment */}
      {resolution.business_fit_assessment && (
        <div className="flex items-start gap-2 p-3 bg-muted/30 rounded-lg">
          <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">{resolution.business_fit_assessment}</p>
        </div>
      )}

      {/* Suggested entity/time */}
      {(resolution.suggested_entity_key || resolution.suggested_time_anchor) && (
        <div className="flex flex-wrap gap-2">
          {resolution.suggested_entity_key && (
            <Badge variant="outline" className="text-xs">
              Entidade sugerida: <strong className="ml-1">{resolution.suggested_entity_key}</strong>
            </Badge>
          )}
          {resolution.suggested_time_anchor && (
            <Badge variant="outline" className="text-xs">
              Tempo sugerido: <strong className="ml-1">{resolution.suggested_time_anchor}</strong>
            </Badge>
          )}
        </div>
      )}

      {/* Features summary */}
      {resolution.suggested_features.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">{resolution.suggested_features.length} features sugeridas:</span>{" "}
          {resolution.suggested_features.slice(0, 5).join(", ")}
          {resolution.suggested_features.length > 5 && ` (+${resolution.suggested_features.length - 5})`}
        </div>
      )}

      {/* Blocked targets */}
      {resolution.blocked_target_reasons.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" /> Alvos bloqueados
          </p>
          <div className="flex flex-wrap gap-1">
            {resolution.blocked_target_reasons.map((b, i) => (
              <Badge key={i} variant="outline" className="text-[10px] text-destructive/80 border-destructive/30">
                <XCircle className="w-2.5 h-2.5 mr-0.5" /> {b.column}: {b.reason}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Alternatives */}
      {resolution.alternatives.length > 0 && (
        <div className="space-y-2">
          <button
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setShowAlternatives(!showAlternatives)}
          >
            {showAlternatives ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showAlternatives ? "Ocultar alternativas" : `Ver ${resolution.alternatives.length} alternativa(s)`}
          </button>
          {showAlternatives && (
            <div className="grid gap-2 sm:grid-cols-2">
              {resolution.alternatives.map((alt, i) => (
                <div key={i} className="p-3 rounded-lg border border-border bg-background space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{alt.column}</p>
                    {alt.confidence && <ConfidenceBadge score={alt.confidence} />}
                  </div>
                  <p className="text-xs text-muted-foreground">{alt.reasoning}</p>
                    {onApplyTarget && (
                      <Button
                        variant="outline" size="sm" className="w-full h-6 text-[10px]"
                        disabled={persisting}
                        onClick={() => {
                          onApplyTarget(alt);
                          persistAppliedToSSOT(alt, resolution.suggested_entity_key, resolution.suggested_time_anchor, resolution.suggested_features, resolution.blocked_features);
                        }}
                      >
                      Usar esta alternativa
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reasoning */}
      {resolution.target_reasoning_summary && (
        <div className="space-y-1">
          <button
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setShowReasoning(!showReasoning)}
          >
            {showReasoning ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showReasoning ? "Ocultar análise" : "Ver análise completa"}
          </button>
          {showReasoning && (
            <div className="p-3 bg-muted/30 rounded-lg text-xs text-muted-foreground whitespace-pre-wrap">
              {resolution.target_reasoning_summary}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
