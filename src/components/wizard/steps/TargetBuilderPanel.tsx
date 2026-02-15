import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sparkles, Loader2, CheckCircle, AlertTriangle, XCircle,
  ChevronDown, ChevronUp, Eye, Save, Wand2, Info,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { LABEL_TEMPLATES, type LabelTemplate } from "@/config/labelTemplates";

// ═══ Types ═════════════════════════════════════════════════════

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: string;
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
  recommended_params?: Record<string, any>;
}

interface TargetBuilderPanelProps {
  projectId: string;
  labelBuilderRequired: boolean;
  recommendedTemplates?: { template_id: string; display_name: string; problem_type: string }[];
  industry?: string;
  onBuilderReady?: (builderId: string, templateId: string) => void;
}

// ═══ Gate Icon ═════════════════════════════════════════════════

function GateIcon({ status }: { status: "PASS" | "WARN" | "BLOCK" }) {
  if (status === "PASS") return <CheckCircle className="w-3.5 h-3.5 text-accent" />;
  if (status === "WARN") return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
  return <XCircle className="w-3.5 h-3.5 text-destructive" />;
}

// ═══ Component ═════════════════════════════════════════════════

export default function TargetBuilderPanel({
  projectId,
  labelBuilderRequired,
  recommendedTemplates,
  industry,
  onBuilderReady,
}: TargetBuilderPanelProps) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(labelBuilderRequired);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [params, setParams] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);

  // Available templates for this industry
  const availableTemplates: LabelTemplate[] = [];
  if (recommendedTemplates) {
    for (const rt of recommendedTemplates) {
      const t = LABEL_TEMPLATES[rt.template_id];
      if (t) availableTemplates.push(t);
    }
  }
  // Also add any templates from the industry
  if (industry) {
    for (const t of Object.values(LABEL_TEMPLATES)) {
      if (t.industry === industry && !availableTemplates.find(a => a.template_id === t.template_id)) {
        availableTemplates.push(t);
      }
    }
  }

  // Initialize params when template changes
  useEffect(() => {
    if (!selectedTemplate) return;
    const template = LABEL_TEMPLATES[selectedTemplate];
    if (!template) return;
    const defaults: Record<string, any> = {};
    for (const p of template.params) {
      defaults[p.key] = p.default_value;
    }
    setParams(defaults);
    setResult(null);
  }, [selectedTemplate]);

  const runPreview = useCallback(async () => {
    if (!selectedTemplate) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("preview-target-template", {
        body: {
          project_id: projectId,
          template_id: selectedTemplate,
          params,
        },
      });
      if (error) throw error;
      setResult(data as PreviewResult);

      if (data?.builder_status === "ready" && data?.builder_id) {
        onBuilderReady?.(data.builder_id, selectedTemplate);
      }
    } catch (err) {
      console.error("[TargetBuilderPanel] Preview error:", err);
      toast({
        title: "Erro no preview",
        description: err instanceof Error ? err.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedTemplate, params, onBuilderReady, toast]);

  const updateParam = (key: string, value: any) => {
    setParams(prev => ({ ...prev, [key]: value }));
    setResult(null); // Invalidate preview when params change
  };

  const template = selectedTemplate ? LABEL_TEMPLATES[selectedTemplate] : null;
  const hasBlock = result?.gates?.some(g => g.status === "BLOCK");
  const isReady = result?.builder_status === "ready";

  if (availableTemplates.length === 0 && !labelBuilderRequired) {
    return null; // Nothing to show
  }

  return (
    <Card className={`border overflow-hidden ${
      labelBuilderRequired
        ? "border-primary/30 bg-primary/5"
        : "border-border"
    }`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">
            {labelBuilderRequired
              ? "Gerar Target automaticamente (recomendado)"
              : "Target Builder (opcional)"}
          </span>
          {isReady && (
            <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
              <CheckCircle className="w-3 h-3 mr-1" />
              READY
            </Badge>
          )}
          {hasBlock && (
            <Badge variant="destructive" className="text-[10px]">
              <XCircle className="w-3 h-3 mr-1" />
              BLOCKED
            </Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Info block */}
          {labelBuilderRequired && (
            <div className="flex items-start gap-2 p-3 bg-primary/10 border border-primary/20 rounded-lg">
              <Info className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
              <p className="text-xs text-muted-foreground">
                O objetivo deste projeto requer que o target seja <strong>derivado</strong> dos dados
                (ex: churn = sem compra em N dias). Use um dos templates abaixo para gerar automaticamente.
              </p>
            </div>
          )}

          {/* Template selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Template de Target</Label>
            <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
              <SelectTrigger className="bg-background">
                <SelectValue placeholder="Selecione um template..." />
              </SelectTrigger>
              <SelectContent className="bg-popover border border-border shadow-lg z-50">
                {availableTemplates.map((t) => (
                  <SelectItem key={t.template_id} value={t.template_id}>
                    <div className="flex items-center gap-2">
                      <span>{t.display_name}</span>
                      <Badge variant="outline" className="text-[10px]">{t.problem_type}</Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {template && (
              <p className="text-xs text-muted-foreground">{template.description}</p>
            )}
          </div>

          {/* Param editor */}
          {template && (
            <div className="space-y-3 p-3 bg-muted/30 rounded-lg">
              <p className="text-xs font-medium text-muted-foreground">Parâmetros</p>
              {template.params.map((paramDef) => (
                <div key={paramDef.key} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">{paramDef.label}</Label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="w-3 h-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <p className="text-xs">{paramDef.description}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  {paramDef.type === "number" ? (
                    <Input
                      type="number"
                      value={params[paramDef.key] ?? paramDef.default_value}
                      onChange={(e) => updateParam(paramDef.key, parseInt(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                  ) : paramDef.type === "string" ? (
                    <Input
                      value={params[paramDef.key] ?? paramDef.default_value}
                      onChange={(e) => updateParam(paramDef.key, e.target.value)}
                      className="h-8 text-sm"
                    />
                  ) : (
                    <Input
                      value={Array.isArray(params[paramDef.key]) ? params[paramDef.key].join(", ") : ""}
                      onChange={(e) => updateParam(paramDef.key, e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
                      placeholder="valor1, valor2, ..."
                      className="h-8 text-sm"
                    />
                  )}
                </div>
              ))}

              {/* Derivation summary */}
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-background/50 p-2 rounded">
                <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary" />
                <span>{template.derivation_summary}</span>
              </div>
            </div>
          )}

          {/* Preview button */}
          {selectedTemplate && (
            <Button
              onClick={runPreview}
              disabled={loading}
              className="w-full bg-gradient-primary"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Eye className="w-4 h-4 mr-2" />
              )}
              Preview Target
            </Button>
          )}

          {/* Preview results */}
          {result?.preview && (
            <div className="space-y-3">
              <p className="text-sm font-semibold flex items-center gap-2">
                <Eye className="w-4 h-4 text-primary" />
                Resultado do Preview
              </p>

              {/* Stats cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{(result.preview.positive_rate * 100).toFixed(1)}%</p>
                  <p className="text-[10px] text-muted-foreground">Taxa Positiva</p>
                </div>
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{result.preview.distinct_target_values}</p>
                  <p className="text-[10px] text-muted-foreground">Classes</p>
                </div>
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{(result.preview.top_class_pct * 100).toFixed(1)}%</p>
                  <p className="text-[10px] text-muted-foreground">Classe Dominante</p>
                </div>
                <div className="p-2 bg-background/60 rounded border border-border/50 text-center">
                  <p className="text-lg font-bold">{result.preview.entity_count.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">Entidades</p>
                </div>
              </div>

              {/* Notes */}
              {result.preview.notes.length > 0 && (
                <div className="text-xs space-y-1 p-2 bg-muted/30 rounded">
                  {result.preview.notes.map((note, i) => (
                    <p key={i} className="text-muted-foreground">• {note}</p>
                  ))}
                </div>
              )}

              {/* Period distribution */}
              {result.preview.per_period_distribution.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1 px-2">Período</th>
                        <th className="text-right py-1 px-2">Positivos</th>
                        <th className="text-right py-1 px-2">Total</th>
                        <th className="text-right py-1 px-2">Taxa</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.preview.per_period_distribution.map((pd, i) => (
                        <tr key={i} className="border-b border-border/30">
                          <td className="py-1 px-2">{pd.period}</td>
                          <td className="text-right py-1 px-2">{pd.positives}</td>
                          <td className="text-right py-1 px-2">{pd.total}</td>
                          <td className="text-right py-1 px-2">{(pd.positive_rate * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Gates */}
          {result?.gates && result.gates.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Gates de Qualidade</p>
              {result.gates.map((gate, i) => (
                <div key={i} className={`flex items-start gap-2 text-xs p-2 rounded ${
                  gate.status === "BLOCK" ? "bg-destructive/10 border border-destructive/20" :
                  gate.status === "WARN" ? "bg-amber-500/10 border border-amber-500/20" :
                  "bg-accent/10 border border-accent/20"
                }`}>
                  <GateIcon status={gate.status} />
                  <div>
                    <p className={
                      gate.status === "BLOCK" ? "text-destructive" :
                      gate.status === "WARN" ? "text-amber-600" :
                      "text-muted-foreground"
                    }>{gate.message}</p>
                    {gate.details && (
                      <p className="text-muted-foreground mt-0.5">{gate.details}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Ready confirmation */}
          {isReady && (
            <div className="flex items-center gap-2 p-3 bg-accent/10 border border-accent/20 rounded-lg">
              <CheckCircle className="w-4 h-4 text-accent" />
              <p className="text-sm font-medium">
                Target builder pronto! O target será gerado automaticamente ao construir o dataset modelável.
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
