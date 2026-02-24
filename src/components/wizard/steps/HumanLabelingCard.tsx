import { useState, useCallback, useEffect, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users, Loader2, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronUp, ThumbsUp, ThumbsDown, HelpCircle,
  BarChart3, Cpu, Zap, RotateCcw, CheckCheck, ArrowUpDown,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface EntitySample {
  entity_id: string;
  mini_features: Record<string, any>;
  suggested_label: number;
  confidence: number;
  reason: string;
  group: string;
}

interface SamplingReport {
  total_sampled: number;
  default_sample_size: number;
  groups: { UNCERTAIN: number; HIGH_POS_PROB: number; HIGH_NEG_PROB: number };
  suggested_labels: { positive: number; negative: number };
  avg_confidence: number;
  has_weak_supervision: boolean;
  leakage_cols_excluded: string[];
}

interface ModelMetrics {
  auc: number;
  f1: number;
  accuracy: number;
  train_size: number;
  holdout_size: number;
  calibration: string;
}

interface TrainabilityCTA {
  label: string;
  action: string;
  direction?: string;
}

interface Props {
  projectId: string;
  onActivated?: () => void;
}

export default function HumanLabelingCard({ projectId, onActivated }: Props) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [training, setTraining] = useState(false);
  const [activating, setActivating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [entities, setEntities] = useState<EntitySample[]>([]);
  const [summaryCols, setSummaryCols] = useState<string[]>([]);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [labelMap, setLabelMap] = useState<Record<string, "yes" | "no" | "unsure">>({});
  const [error, setError] = useState<string | null>(null);

  // Sample size
  const [sampleSizeOptions, setSampleSizeOptions] = useState<number[]>([50, 100, 200, 400, 800]);
  const [defaultSampleSize, setDefaultSampleSize] = useState(200);
  const [selectedSampleSize, setSelectedSampleSize] = useState<number>(200);
  const [samplingReport, setSamplingReport] = useState<SamplingReport | null>(null);

  // Result state
  const [nLabeled, setNLabeled] = useState(0);
  const [nPositive, setNPositive] = useState(0);
  const [nNegative, setNNegative] = useState(0);
  const [balance, setBalance] = useState(0);
  const [minClass, setMinClass] = useState(0);
  const [modelMetrics, setModelMetrics] = useState<ModelMetrics | null>(null);
  const [seedReady, setSeedReady] = useState(false);
  const [suggestionAccuracy, setSuggestionAccuracy] = useState<number | null>(null);

  // Trainability
  const [trainabilityStatus, setTrainabilityStatus] = useState<string>("ok");
  const [trainabilityReason, setTrainabilityReason] = useState<string | null>(null);
  const [trainabilityCTAs, setTrainabilityCTAs] = useState<TrainabilityCTA[]>([]);

  // Batch selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Load existing state
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const { data } = await supabase
        .from("project_settings")
        .select("human_label_result, human_label_config, target_source")
        .eq("project_id", projectId)
        .maybeSingle();
      if (data) {
        const d = data as any;
        if (d.target_source === "human_labeling") setExpanded(true);
        if (d.human_label_config?.human_label_sample_size) {
          setSelectedSampleSize(d.human_label_config.human_label_sample_size);
        }
        if (d.human_label_config?.default_sample_size) {
          setDefaultSampleSize(d.human_label_config.default_sample_size);
        }
        if (d.human_label_result) {
          setNLabeled(d.human_label_result.n_labeled || 0);
          setNPositive(d.human_label_result.n_positive || 0);
          setNNegative(d.human_label_result.n_negative || 0);
          setBalance(d.human_label_result.balance || 0);
          setMinClass(d.human_label_result.min_class || 0);
          if (d.human_label_result.model_metrics) {
            setModelMetrics(d.human_label_result.model_metrics);
            setSeedReady(d.human_label_result.seed_model_ready || false);
          }
          if (d.human_label_result.round_id) setRoundId(d.human_label_result.round_id);
          if (d.human_label_result.suggestion_accuracy != null) setSuggestionAccuracy(d.human_label_result.suggestion_accuracy);
          if (d.human_label_result.trainability_status) {
            setTrainabilityStatus(d.human_label_result.trainability_status);
            setTrainabilityReason(d.human_label_result.trainability_reason || null);
            setTrainabilityCTAs(d.human_label_result.trainability_ctas || []);
          }
        }
      }
    })();
  }, [projectId]);

  const generateSample = useCallback(async (directedStrategy?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await supabase.functions.invoke("tde-sample-entities-for-labeling", {
        body: {
          project_id: projectId,
          n: selectedSampleSize,
          strategy: directedStrategy || "stratified",
        },
      });
      if (response.error) throw new Error(response.error.message);
      const data = response.data as any;
      if (data.success) {
        setEntities(data.entities || []);
        setSummaryCols(data.summary_columns || []);
        setRoundId(data.round_id);
        setLabelMap({});
        setSelectedIds(new Set());
        if (data.default_sample_size) setDefaultSampleSize(data.default_sample_size);
        if (data.sample_size_options) setSampleSizeOptions(data.sample_size_options);
        if (data.sampling_report) setSamplingReport(data.sampling_report);
        // Pre-fill labels from suggestions
        const prefilled: Record<string, "yes" | "no" | "unsure"> = {};
        for (const e of (data.entities || []) as EntitySample[]) {
          prefilled[e.entity_id] = e.suggested_label === 1 ? "yes" : "no";
        }
        setLabelMap(prefilled);
        toast({ title: "Amostra gerada", description: `${data.total_sampled} entidades com pré-rotulagem automática.` });
      } else {
        setError(data.error || "Erro desconhecido");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao gerar amostra");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedSampleSize, toast]);

  const setLabel = (entityId: string, status: "yes" | "no" | "unsure") => {
    setLabelMap(prev => {
      if (prev[entityId] === status) {
        const next = { ...prev };
        delete next[entityId];
        return next;
      }
      return { ...prev, [entityId]: status };
    });
  };

  const toggleSelect = (entityId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entityId)) next.delete(entityId);
      else next.add(entityId);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(entities.map(e => e.entity_id)));
  };

  const applyBatch = (status: "yes" | "no" | "unsure") => {
    setLabelMap(prev => {
      const next = { ...prev };
      for (const id of selectedIds) {
        next[id] = status;
      }
      return next;
    });
    setSelectedIds(new Set());
  };

  const saveLabels = useCallback(async () => {
    if (!roundId) return;
    setSaving(true);
    try {
      const labels = Object.entries(labelMap).map(([entity_id, label_status]) => {
        const entity = entities.find(e => e.entity_id === entity_id);
        return {
          entity_id,
          label_status,
          suggested_label: entity?.suggested_label,
          confidence: entity?.confidence,
        };
      });
      const response = await supabase.functions.invoke("tde-submit-human-labels", {
        body: { project_id: projectId, round_id: roundId, labels },
      });
      if (response.error) throw new Error(response.error.message);
      const data = response.data as any;
      if (data.success) {
        setNLabeled(data.n_labeled);
        setNPositive(data.n_positive);
        setNNegative(data.n_negative);
        setBalance(data.balance);
        setMinClass(data.min_class);
        if (data.suggestion_accuracy != null) setSuggestionAccuracy(data.suggestion_accuracy);
        setTrainabilityStatus(data.trainability_status || "ok");
        setTrainabilityReason(data.trainability_reason || null);
        setTrainabilityCTAs(data.trainability_ctas || []);
        toast({ title: "Rótulos salvos", description: `${data.n_saved} salvos, ${data.n_skipped} "Não sei" ignorados.` });
      }
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro ao salvar", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [projectId, roundId, labelMap, entities, toast]);

  const trainSeedModel = useCallback(async () => {
    if (!roundId) return;
    setTraining(true);
    try {
      const response = await supabase.functions.invoke("tde-train-human-seed-model", {
        body: { project_id: projectId, round_id: roundId },
      });
      if (response.error) throw new Error(response.error.message);
      const data = response.data as any;
      if (data.success) {
        setModelMetrics(data.model_metrics);
        setSeedReady(data.seed_model_ready);
        setNLabeled(data.n_labeled);
        setBalance(data.balance);
        toast({ title: "Modelo seed treinado", description: `AUC: ${data.model_metrics.auc}, F1: ${data.model_metrics.f1}` });
      } else {
        toast({ title: "Aviso", description: data.error, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro ao treinar", variant: "destructive" });
    } finally {
      setTraining(false);
    }
  }, [projectId, roundId, toast]);

  const activateHumanLabeling = useCallback(async () => {
    setActivating(true);
    try {
      await supabase
        .from("project_settings")
        .update({
          target_source: "human_labeling",
          target_column: "label",
          selected_template_id: "human_labeling_assisted",
        } as any)
        .eq("project_id", projectId);
      toast({ title: "Target por rotulagem ativado", description: "O target será baseado nos rótulos humanos + modelo seed." });
      onActivated?.();
    } catch (err) {
      toast({ title: "Erro", description: "Não foi possível ativar.", variant: "destructive" });
    } finally {
      setActivating(false);
    }
  }, [projectId, toast, onActivated]);

  const labeledCount = Object.keys(labelMap).length;
  const yesCount = Object.values(labelMap).filter(v => v === "yes").length;
  const noCount = Object.values(labelMap).filter(v => v === "no").length;
  const unsureCount = Object.values(labelMap).filter(v => v === "unsure").length;
  const canTrain = nLabeled >= 30;
  const canActivate = seedReady && nLabeled >= 30;

  // Count inversions from suggestion
  const inversionCount = useMemo(() => {
    let count = 0;
    for (const e of entities) {
      const userLabel = labelMap[e.entity_id];
      if (!userLabel || userLabel === "unsure") continue;
      const userBinary = userLabel === "yes" ? 1 : 0;
      if (userBinary !== e.suggested_label) count++;
    }
    return count;
  }, [entities, labelMap]);

  const hasTrainabilityIssue = trainabilityStatus !== "ok" && nLabeled > 0;
  const MIN_TOTAL = 100;
  const MIN_PER_CLASS = 30;

  return (
    <Card className="border border-primary/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Rotulagem Rápida (Human-in-the-loop)</span>
          {nLabeled > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {nLabeled} rotulados
            </Badge>
          )}
          {seedReady && (
            <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
              <CheckCircle className="w-3 h-3 mr-1" />
              SEED PRONTO
            </Badge>
          )}
          {hasTrainabilityIssue && (
            <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">
              <AlertTriangle className="w-3 h-3 mr-1" />
              AÇÃO NECESSÁRIA
            </Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Info */}
          <div className="flex items-start gap-2 p-3 bg-primary/10 border border-primary/20 rounded-lg">
            <Users className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted-foreground">
              Rotule manualmente <strong>{defaultSampleSize}–800 casos</strong> (Sim/Não).
              A amostra é estratificada (40% incertos, 30% prováveis positivos, 30% prováveis negativos)
              com <strong>pré-rotulagem automática</strong> — confirme ou corrija rapidamente.
            </p>
          </div>

          {/* Stats */}
          {nLabeled > 0 && (
            <div className="grid grid-cols-4 gap-2">
              <div className="p-2 rounded border border-border bg-background text-center">
                <p className="text-lg font-bold">{nLabeled}</p>
                <p className="text-[10px] text-muted-foreground">Rotulados</p>
              </div>
              <div className="p-2 rounded border border-accent/30 bg-accent/5 text-center">
                <p className="text-lg font-bold text-accent">{nPositive}</p>
                <p className="text-[10px] text-muted-foreground">Sim</p>
              </div>
              <div className="p-2 rounded border border-destructive/30 bg-destructive/5 text-center">
                <p className="text-lg font-bold text-destructive">{nNegative}</p>
                <p className="text-[10px] text-muted-foreground">Não</p>
              </div>
              <div className={`p-2 rounded border text-center ${
                minClass >= MIN_PER_CLASS ? "border-accent/30 bg-accent/5" : "border-amber-500/30 bg-amber-500/5"
              }`}>
                <p className="text-lg font-bold">{minClass >= MIN_PER_CLASS ? "✓" : minClass}</p>
                <p className="text-[10px] text-muted-foreground">{minClass >= MIN_PER_CLASS ? "Mín. OK" : `Mín classe (${MIN_PER_CLASS})`}</p>
              </div>
            </div>
          )}

          {/* Trainability diagnostic */}
          {hasTrainabilityIssue && (
            <Alert className="bg-amber-500/5 border-amber-500/20">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <AlertDescription className="text-xs space-y-2">
                <p>{trainabilityReason}</p>
                <div className="flex flex-wrap gap-2">
                  {trainabilityCTAs.map((cta, i) => (
                    <Button
                      key={i}
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      onClick={() => {
                        if (cta.action === "generate_more" || cta.action === "generate_directed") {
                          generateSample(cta.direction === "positive" ? "bias_positive" : cta.direction === "negative" ? "bias_negative" : undefined);
                        }
                      }}
                    >
                      {cta.label}
                    </Button>
                  ))}
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Suggestion accuracy */}
          {suggestionAccuracy != null && nLabeled > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Acurácia da pré-rotulagem: <strong>{suggestionAccuracy}%</strong></span>
              {inversionCount > 0 && <span className="text-amber-600">({inversionCount} corrigidos)</span>}
            </div>
          )}

          {/* Seed model metrics */}
          {modelMetrics && (
            <div className="p-3 rounded border border-accent/20 bg-accent/5 space-y-2">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-accent" />
                <span className="text-xs font-semibold">Modelo Seed</span>
                <Badge variant="outline" className={`text-[9px] ${
                  modelMetrics.calibration === "good" ? "border-accent/50 text-accent" :
                  modelMetrics.calibration === "fair" ? "border-amber-500/50 text-amber-600" :
                  "border-destructive/50 text-destructive"
                }`}>
                  {modelMetrics.calibration === "good" ? "Bom" : modelMetrics.calibration === "fair" ? "Regular" : "Fraco"}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-sm font-bold">{(modelMetrics.auc * 100).toFixed(0)}%</p>
                  <p className="text-[10px] text-muted-foreground">AUC</p>
                </div>
                <div>
                  <p className="text-sm font-bold">{(modelMetrics.f1 * 100).toFixed(0)}%</p>
                  <p className="text-[10px] text-muted-foreground">F1</p>
                </div>
                <div>
                  <p className="text-sm font-bold">{(modelMetrics.accuracy * 100).toFixed(0)}%</p>
                  <p className="text-[10px] text-muted-foreground">Acurácia</p>
                </div>
              </div>
            </div>
          )}

          {/* Sample size selector + generate */}
          <div className="flex gap-2 items-center">
            <Select
              value={String(selectedSampleSize)}
              onValueChange={(v) => setSelectedSampleSize(Number(v))}
            >
              <SelectTrigger className="w-32 h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sampleSizeOptions.map(size => (
                  <SelectItem key={size} value={String(size)}>
                    {size} entidades{size === defaultSampleSize ? " (rec.)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => generateSample()} disabled={loading} className="flex-1" variant="outline">
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
              Gerar amostra estratificada
            </Button>
          </div>

          {/* Sampling report */}
          {samplingReport && (
            <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
              <div className="p-1.5 rounded border border-amber-500/20 bg-amber-500/5">
                <p className="font-bold text-amber-600">{samplingReport.groups.UNCERTAIN}</p>
                <p className="text-muted-foreground">Incertos</p>
              </div>
              <div className="p-1.5 rounded border border-accent/20 bg-accent/5">
                <p className="font-bold text-accent">{samplingReport.groups.HIGH_POS_PROB}</p>
                <p className="text-muted-foreground">Prov. Sim</p>
              </div>
              <div className="p-1.5 rounded border border-destructive/20 bg-destructive/5">
                <p className="font-bold text-destructive">{samplingReport.groups.HIGH_NEG_PROB}</p>
                <p className="text-muted-foreground">Prov. Não</p>
              </div>
            </div>
          )}

          {error && (
            <Alert className="bg-destructive/5 border-destructive/20">
              <XCircle className="w-4 h-4 text-destructive" />
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          {/* Labeling interface */}
          {entities.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">
                  Rotulagem: {labeledCount}/{entities.length}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="text-accent">Sim: {yesCount}</span>
                  <span className="text-destructive">Não: {noCount}</span>
                  {unsureCount > 0 && <span className="text-amber-500">Dúvida: {unsureCount}</span>}
                </div>
              </div>

              {/* Batch actions */}
              {selectedIds.size > 0 && (
                <div className="flex items-center gap-2 p-2 bg-muted/30 border border-border rounded-lg">
                  <span className="text-xs font-medium">{selectedIds.size} selecionados:</span>
                  <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => applyBatch("yes")}>
                    <ThumbsUp className="w-3 h-3 mr-1" /> Sim
                  </Button>
                  <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => applyBatch("no")}>
                    <ThumbsDown className="w-3 h-3 mr-1" /> Não
                  </Button>
                  <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => applyBatch("unsure")}>
                    <HelpCircle className="w-3 h-3 mr-1" /> Dúvida
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 ml-auto" onClick={() => setSelectedIds(new Set())}>
                    Limpar
                  </Button>
                </div>
              )}

              <div className="flex items-center gap-2 mb-1">
                <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={selectAll}>
                  <CheckCheck className="w-3 h-3 mr-1" /> Selecionar todos
                </Button>
                <Button
                  size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                  onClick={() => {
                    // Accept all suggestions as-is
                    const prefilled: Record<string, "yes" | "no" | "unsure"> = {};
                    for (const e of entities) {
                      prefilled[e.entity_id] = e.suggested_label === 1 ? "yes" : "no";
                    }
                    setLabelMap(prefilled);
                  }}
                >
                  <CheckCircle className="w-3 h-3 mr-1" /> Aceitar todas sugestões
                </Button>
              </div>

              <div className="max-h-[400px] overflow-y-auto space-y-1.5 border border-border rounded-lg p-2">
                {entities.map((entity) => {
                  const currentLabel = labelMap[entity.entity_id];
                  const isSelected = selectedIds.has(entity.entity_id);
                  const isInverted = currentLabel && currentLabel !== "unsure" && (currentLabel === "yes" ? 1 : 0) !== entity.suggested_label;
                  return (
                    <div
                      key={entity.entity_id}
                      className={`flex items-center gap-2 p-2 rounded border transition-colors cursor-pointer ${
                        isSelected ? "ring-1 ring-primary" : ""
                      } ${
                        currentLabel === "yes" ? "border-accent/40 bg-accent/5" :
                        currentLabel === "no" ? "border-destructive/40 bg-destructive/5" :
                        currentLabel === "unsure" ? "border-amber-500/40 bg-amber-500/5" :
                        "border-border/50 bg-background"
                      }`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button")) return;
                        toggleSelect(entity.entity_id);
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-mono font-medium truncate">{entity.entity_id}</p>
                          {/* Suggestion badge */}
                          <Badge variant="outline" className={`text-[8px] py-0 px-1 ${
                            entity.group === "UNCERTAIN" ? "border-amber-500/40 text-amber-600" :
                            entity.group === "HIGH_POS_PROB" ? "border-accent/40 text-accent" :
                            "border-destructive/40 text-destructive"
                          }`}>
                            {entity.group === "UNCERTAIN" ? "?" : entity.group === "HIGH_POS_PROB" ? "+" : "−"} {entity.confidence}%
                          </Badge>
                          {isInverted && (
                            <Badge variant="outline" className="text-[8px] py-0 px-1 border-amber-500/40 text-amber-600">
                              <ArrowUpDown className="w-2.5 h-2.5 mr-0.5" /> corrigido
                            </Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {Object.entries(entity.mini_features)
                            .filter(([k]) => !k.startsWith("_"))
                            .slice(0, 4)
                            .map(([k, v]) => (
                              <Badge key={k} variant="outline" className="text-[9px] py-0">
                                {k}: {typeof v === "number" ? v.toLocaleString("pt-BR") : String(v).slice(0, 15)}
                              </Badge>
                            ))}
                        </div>
                        <p className="text-[9px] text-muted-foreground mt-0.5 italic">{entity.reason}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => setLabel(entity.entity_id, "yes")}
                          className={`p-1.5 rounded transition-colors ${
                            currentLabel === "yes" ? "bg-accent text-accent-foreground" : "hover:bg-accent/20 text-muted-foreground"
                          }`}
                          title="Sim (Confirmar)"
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setLabel(entity.entity_id, "no")}
                          className={`p-1.5 rounded transition-colors ${
                            currentLabel === "no" ? "bg-destructive text-destructive-foreground" : "hover:bg-destructive/20 text-muted-foreground"
                          }`}
                          title="Não (Inverter)"
                        >
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setLabel(entity.entity_id, "unsure")}
                          className={`p-1.5 rounded transition-colors ${
                            currentLabel === "unsure" ? "bg-amber-500 text-white" : "hover:bg-amber-500/20 text-muted-foreground"
                          }`}
                          title="Dúvida"
                        >
                          <HelpCircle className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <Button onClick={saveLabels} disabled={saving || labeledCount === 0} className="flex-1" variant="outline">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle className="w-4 h-4 mr-2" />}
                  Salvar rótulos ({labeledCount})
                </Button>
                <Button onClick={trainSeedModel} disabled={training || !canTrain} className="flex-1" variant="secondary">
                  {training ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Cpu className="w-4 h-4 mr-2" />}
                  Treinar modelo
                </Button>
              </div>

              {!canTrain && nLabeled < 30 && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Mínimo: 30 rótulos para treinar ({30 - nLabeled} restantes)
                </p>
              )}
            </div>
          )}

          {/* Activate button */}
          {canActivate && (
            <Button onClick={activateHumanLabeling} disabled={activating} className="w-full">
              {activating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle className="w-4 h-4 mr-2" />}
              Ativar Target por Rotulagem
            </Button>
          )}

          {!canActivate && nLabeled > 0 && !seedReady && (
            <Alert className="bg-amber-500/5 border-amber-500/20">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <AlertDescription className="text-xs">
                Treine o modelo seed para poder ativar o target por rotulagem.
                {nLabeled < 30 && ` Ainda faltam ${30 - nLabeled} rótulos para o mínimo.`}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </Card>
  );
}
