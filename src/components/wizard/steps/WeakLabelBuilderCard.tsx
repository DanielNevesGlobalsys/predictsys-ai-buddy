import { useState, useCallback, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Sparkles, Loader2, Eye, CheckCircle, AlertTriangle, XCircle,
  ChevronDown, ChevronUp, Zap, Shield, BarChart3,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface LFDefinition {
  lf_id: string;
  lf_name: string;
  description: string;
  enabled: boolean;
  weight: number;
  source_columns: string[];
}

interface WeakLabelResult {
  prevalence: number;
  coverage: number;
  agreement_rate: number;
  conflict_rate: number;
  abstain_rate: number;
  avg_confidence: number;
  top_rules: { lf_id: string; lf_name: string; fire_rate: number; positive_rate: number }[];
  sample_reasons: string[];
  total_rows: number;
  labeled_rows: number;
  positive_count: number;
  leakage_source_columns: string[];
  created_at: string;
}

interface Props {
  projectId: string;
  onActivated?: () => void;
}

const scoreBg = (val: number, good: "high" | "low") => {
  const isGood = good === "high" ? val >= 0.6 : val <= 0.3;
  const isBad = good === "high" ? val < 0.3 : val > 0.6;
  if (isGood) return "bg-accent/10 border-accent/20 text-accent";
  if (isBad) return "bg-destructive/10 border-destructive/20 text-destructive";
  return "bg-amber-500/10 border-amber-500/20 text-amber-600";
};

export default function WeakLabelBuilderCard({ projectId, onActivated }: Props) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);
  const [result, setResult] = useState<WeakLabelResult | null>(null);
  const [lfDefs, setLfDefs] = useState<LFDefinition[]>([]);
  const [threshold, setThreshold] = useState(0.6);
  const [error, setError] = useState<string | null>(null);

  // Load existing result from SSOT
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const { data } = await supabase
        .from("project_settings")
        .select("weak_label_result, weak_label_config, target_source")
        .eq("project_id", projectId)
        .maybeSingle();
      if (data) {
        const d = data as any;
        if (d.weak_label_result) setResult(d.weak_label_result);
        if (d.weak_label_config?.threshold) setThreshold(d.weak_label_config.threshold);
        if (d.target_source === "weak_supervision") setExpanded(true);
      }
    })();
  }, [projectId]);

  const runPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await supabase.functions.invoke("tde-generate-weak-label", {
        body: { project_id: projectId },
      });
      if (response.error) throw new Error(response.error.message);
      const data = response.data as any;
      if (data.success) {
        setResult(data.result);
        setLfDefs(data.lf_definitions || []);
        toast({ title: "Preview gerado", description: `${data.result.labeled_rows} linhas rotuladas com ${(data.lf_definitions || []).length} regras.` });
      } else {
        setError(data.error || "Erro desconhecido");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao gerar preview");
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  const activateWeakSupervision = useCallback(async () => {
    if (!result) return;
    setActivating(true);
    try {
      await supabase
        .from("project_settings")
        .update({
          target_source: "weak_supervision",
          target_column: "label",
          selected_template_id: "weak_supervision_assisted",
        } as any)
        .eq("project_id", projectId);

      toast({ title: "Target assistido ativado", description: "O target será gerado combinando múltiplas regras." });
      onActivated?.();
    } catch (err) {
      toast({ title: "Erro", description: "Não foi possível ativar o modo assistido.", variant: "destructive" });
    } finally {
      setActivating(false);
    }
  }, [projectId, result, toast, onActivated]);

  const toggleLF = (lfId: string) => {
    setLfDefs(prev => prev.map(lf =>
      lf.lf_id === lfId ? { ...lf, enabled: !lf.enabled } : lf
    ));
    setResult(null); // Invalidate preview
  };

  const hasBlock = result && (result.coverage < 0.2 || result.prevalence < 0.01 || result.prevalence > 0.99 || result.conflict_rate > 0.6);

  return (
    <Card className="border border-secondary/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-secondary" />
          <span className="text-sm font-semibold">Modo Assistido (dados incompletos)</span>
          {result && !hasBlock && (
            <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
              <CheckCircle className="w-3 h-3 mr-1" />
              PRONTO
            </Badge>
          )}
          {hasBlock && (
            <Badge variant="destructive" className="text-[10px]">
              <XCircle className="w-3 h-3 mr-1" />
              BLOQUEADO
            </Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Info */}
          <div className="flex items-start gap-2 p-3 bg-secondary/10 border border-secondary/20 rounded-lg">
            <Sparkles className="w-4 h-4 text-secondary mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted-foreground">
              Para datasets sem coluna de resultado clara, o <strong>Modo Assistido</strong> combina múltiplas
              regras fracas (sinais de inatividade, status, valores, texto) para gerar um target confiável.
              Ideal para dados transacionais ou incompletos.
            </p>
          </div>

          {/* LF toggle list */}
          {lfDefs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">Regras ativas:</p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {lfDefs.map(lf => (
                  <div key={lf.lf_id} className="flex items-center justify-between p-2 rounded border border-border/50 bg-background">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Switch
                        checked={lf.enabled}
                        onCheckedChange={() => toggleLF(lf.lf_id)}
                        className="flex-shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{lf.lf_name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{lf.description}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[9px] ml-2 flex-shrink-0">
                      peso: {lf.weight.toFixed(1)}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Threshold */}
          <div className="flex items-center gap-3">
            <Label className="text-xs whitespace-nowrap">Limiar de decisão:</Label>
            <Input
              type="number"
              step={0.05}
              min={0.3}
              max={0.9}
              value={threshold}
              onChange={e => { setThreshold(parseFloat(e.target.value) || 0.6); setResult(null); }}
              className="h-7 w-20 text-xs"
            />
          </div>

          {/* Preview button */}
          <Button onClick={runPreview} disabled={loading} className="w-full bg-gradient-to-r from-secondary to-primary">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
            Preview Assistido
          </Button>

          {error && (
            <Alert className="bg-destructive/5 border-destructive/20">
              <XCircle className="w-4 h-4 text-destructive" />
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          {/* Result display */}
          {result && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: "Cobertura", value: `${(result.coverage * 100).toFixed(0)}%`, score: result.coverage, good: "high" as const },
                  { label: "Prevalência", value: `${(result.prevalence * 100).toFixed(1)}%`, score: result.prevalence > 0.05 && result.prevalence < 0.95 ? 0.8 : 0.2, good: "high" as const },
                  { label: "Concordância", value: `${(result.agreement_rate * 100).toFixed(0)}%`, score: result.agreement_rate, good: "high" as const },
                  { label: "Conflitos", value: `${(result.conflict_rate * 100).toFixed(0)}%`, score: result.conflict_rate, good: "low" as const },
                ].map(m => (
                  <div key={m.label} className={`flex flex-col items-center p-2 rounded-md border ${scoreBg(m.score, m.good)}`}>
                    <span className="text-lg font-bold">{m.value}</span>
                    <span className="text-[10px]">{m.label}</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>{result.labeled_rows.toLocaleString()} linhas rotuladas</span>
                <span>•</span>
                <span>{result.positive_count.toLocaleString()} positivos</span>
                <span>•</span>
                <span>Confiança média: {(result.avg_confidence * 100).toFixed(0)}%</span>
              </div>

              {/* Top rules */}
              {result.top_rules.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground">Regras mais impactantes:</p>
                  {result.top_rules.slice(0, 3).map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <BarChart3 className="w-3 h-3 text-primary flex-shrink-0" />
                      <span className="font-medium">{r.lf_name}</span>
                      <Badge variant="outline" className="text-[9px]">
                        dispara {(r.fire_rate * 100).toFixed(0)}%
                      </Badge>
                      <Badge variant="outline" className="text-[9px]">
                        {(r.positive_rate * 100).toFixed(0)}% positivo
                      </Badge>
                    </div>
                  ))}
                </div>
              )}

              {/* Anti-leak columns */}
              {result.leakage_source_columns.length > 0 && (
                <div className="flex items-start gap-2 text-xs p-2 bg-amber-500/10 border border-amber-500/20 rounded">
                  <Shield className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                  <span>
                    <strong>Anti-leak:</strong> {result.leakage_source_columns.length} coluna(s) serão excluídas das features: {result.leakage_source_columns.slice(0, 5).join(", ")}
                  </span>
                </div>
              )}

              {/* Warnings */}
              {hasBlock && (
                <Alert className="bg-destructive/5 border-destructive/20">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                  <AlertDescription className="text-xs">
                    {result.coverage < 0.2 && "Cobertura muito baixa (<20%). Adicione mais dados ou ajuste as regras. "}
                    {(result.prevalence < 0.01 || result.prevalence > 0.99) && "Prevalência extrema — quase todos positivos ou negativos. Ajuste o limiar. "}
                    {result.conflict_rate > 0.6 && "Conflito alto entre regras (>60%). Desative regras conflitantes. "}
                  </AlertDescription>
                </Alert>
              )}

              {/* Activate */}
              {!hasBlock && (
                <Button
                  onClick={activateWeakSupervision}
                  disabled={activating}
                  className="w-full"
                  variant="default"
                >
                  {activating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle className="w-4 h-4 mr-2" />}
                  Ativar Target Assistido
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
