import { useState, useCallback, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Users, Loader2, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronUp, ThumbsUp, ThumbsDown, HelpCircle,
  BarChart3, Cpu, Zap,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface EntitySample {
  entity_id: string;
  mini_features: Record<string, any>;
}

interface ModelMetrics {
  auc: number;
  f1: number;
  accuracy: number;
  train_size: number;
  holdout_size: number;
  calibration: string;
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

  // Result state
  const [nLabeled, setNLabeled] = useState(0);
  const [balance, setBalance] = useState(0);
  const [modelMetrics, setModelMetrics] = useState<ModelMetrics | null>(null);
  const [seedReady, setSeedReady] = useState(false);

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
        if (d.human_label_result) {
          setNLabeled(d.human_label_result.n_labeled || 0);
          setBalance(d.human_label_result.balance || 0);
          if (d.human_label_result.model_metrics) {
            setModelMetrics(d.human_label_result.model_metrics);
            setSeedReady(d.human_label_result.seed_model_ready || false);
          }
          if (d.human_label_result.round_id) setRoundId(d.human_label_result.round_id);
        }
      }
    })();
  }, [projectId]);

  const generateSample = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await supabase.functions.invoke("tde-sample-entities-for-labeling", {
        body: { project_id: projectId, n: 50, strategy: "diversity" },
      });
      if (response.error) throw new Error(response.error.message);
      const data = response.data as any;
      if (data.success) {
        setEntities(data.entities || []);
        setSummaryCols(data.summary_columns || []);
        setRoundId(data.round_id);
        setLabelMap({});
        toast({ title: "Amostra gerada", description: `${data.total_sampled} entidades prontas para rotulagem.` });
      } else {
        setError(data.error || "Erro desconhecido");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao gerar amostra");
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

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

  const saveLabels = useCallback(async () => {
    if (!roundId) return;
    setSaving(true);
    try {
      const labels = Object.entries(labelMap).map(([entity_id, label_status]) => ({
        entity_id,
        label_status,
      }));
      const response = await supabase.functions.invoke("tde-submit-human-labels", {
        body: { project_id: projectId, round_id: roundId, labels },
      });
      if (response.error) throw new Error(response.error.message);
      const data = response.data as any;
      if (data.success) {
        setNLabeled(data.n_labeled);
        setBalance(data.balance);
        toast({ title: "Rótulos salvos", description: `${data.n_saved} rótulos salvos, ${data.n_skipped} "Não sei" ignorados.` });
      }
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro ao salvar", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [projectId, roundId, labelMap, toast]);

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
  const canTrain = nLabeled >= 30;
  const canActivate = seedReady && nLabeled >= 30;

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
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Info */}
          <div className="flex items-start gap-2 p-3 bg-primary/10 border border-primary/20 rounded-lg">
            <Users className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted-foreground">
              Para datasets sem resultado claro, rotule manualmente <strong>30–200 casos</strong> (Sim/Não).
              O sistema treina um modelo simples para generalizar para todo o dataset.
              Recomendado quando o Modo Assistido não consegue gerar confiança suficiente.
            </p>
          </div>

          {/* Stats if already labeled */}
          {nLabeled > 0 && (
            <div className="grid grid-cols-3 gap-2">
              <div className="p-2 rounded border border-border bg-background text-center">
                <p className="text-lg font-bold">{nLabeled}</p>
                <p className="text-[10px] text-muted-foreground">Rotulados</p>
              </div>
              <div className="p-2 rounded border border-border bg-background text-center">
                <p className="text-lg font-bold">{(balance * 100).toFixed(0)}%</p>
                <p className="text-[10px] text-muted-foreground">% Sim</p>
              </div>
              <div className={`p-2 rounded border text-center ${
                nLabeled >= 30 ? "border-accent/30 bg-accent/5" : "border-amber-500/30 bg-amber-500/5"
              }`}>
                <p className="text-lg font-bold">{nLabeled >= 30 ? "✓" : `${30 - nLabeled}`}</p>
                <p className="text-[10px] text-muted-foreground">{nLabeled >= 30 ? "Mín. OK" : "Faltam"}</p>
              </div>
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

          {/* Generate sample */}
          <Button onClick={generateSample} disabled={loading} className="w-full" variant="outline">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
            Gerar amostra ({entities.length > 0 ? "nova" : "50 entidades"})
          </Button>

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
                </div>
              </div>

              <div className="max-h-[400px] overflow-y-auto space-y-1.5 border border-border rounded-lg p-2">
                {entities.map((entity) => {
                  const currentLabel = labelMap[entity.entity_id];
                  return (
                    <div
                      key={entity.entity_id}
                      className={`flex items-center gap-2 p-2 rounded border transition-colors ${
                        currentLabel === "yes" ? "border-accent/40 bg-accent/5" :
                        currentLabel === "no" ? "border-destructive/40 bg-destructive/5" :
                        currentLabel === "unsure" ? "border-amber-500/40 bg-amber-500/5" :
                        "border-border/50 bg-background"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-mono font-medium truncate">{entity.entity_id}</p>
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
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => setLabel(entity.entity_id, "yes")}
                          className={`p-1.5 rounded transition-colors ${
                            currentLabel === "yes" ? "bg-accent text-accent-foreground" : "hover:bg-accent/20 text-muted-foreground"
                          }`}
                          title="Sim"
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setLabel(entity.entity_id, "no")}
                          className={`p-1.5 rounded transition-colors ${
                            currentLabel === "no" ? "bg-destructive text-destructive-foreground" : "hover:bg-destructive/20 text-muted-foreground"
                          }`}
                          title="Não"
                        >
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setLabel(entity.entity_id, "unsure")}
                          className={`p-1.5 rounded transition-colors ${
                            currentLabel === "unsure" ? "bg-amber-500 text-white" : "hover:bg-amber-500/20 text-muted-foreground"
                          }`}
                          title="Não sei"
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
                  Recomendado rotular pelo menos 50 casos (mínimo: 30)
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
