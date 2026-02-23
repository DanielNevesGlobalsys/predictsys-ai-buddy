import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { CheckCircle, AlertTriangle, Settings2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { extractErrorMessage } from "@/lib/extractErrorMessage";

interface Candidate {
  column: string;
  score?: number | null;
  confidence?: number | null;
  reasons?: string[];
  source?: "ssot" | "tde_profile" | "contract_hints" | "heuristic";
  reason?: string;
}

interface TargetPrerequisitesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  requiredFields: string[];
  candidates: {
    entity_candidates: Candidate[];
    time_candidates: Candidate[];
    value_candidates: Candidate[];
    status_candidates: Candidate[];
  };
  onSave: (config: Record<string, string>) => void | Promise<void>;
}

const FIELD_META: Record<string, { label: string; description: string; candidateKey: string }> = {
  entity_key: {
    label: "Coluna de entidade (ID)",
    description: "A coluna que identifica cada cliente, paciente ou unidade.",
    candidateKey: "entity_candidates",
  },
  time_anchor: {
    label: "Coluna de data/tempo",
    description: "A coluna que contém a data ou timestamp dos eventos.",
    candidateKey: "time_candidates",
  },
  value_column: {
    label: "Coluna de valor numérico",
    description: "A coluna com o valor a ser previsto ou usado como referência.",
    candidateKey: "value_candidates",
  },
  status_column: {
    label: "Coluna de status/evento",
    description: "A coluna que contém o status ou flag do resultado.",
    candidateKey: "status_candidates",
  },
};

// ═══ Robust score normalizer ═══════════════════════════════════
// Accepts scores in 0-1, 0-10, or 0-100 scales.
// Returns a number 0-100 or null when invalid/absent.
function normalizeConfidenceScore(score: unknown): number | null {
  if (score === null || score === undefined) return null;
  const n = typeof score === "number" ? score : parseFloat(String(score));
  if (!Number.isFinite(n) || n < 0) return null;

  if (n <= 1) return Math.round(n * 100);   // 0-1 → 0-100
  if (n <= 10) return Math.round(n * 10);   // 0-10 → 0-100
  return Math.min(Math.round(n), 100);      // already 0-100
}

function getCandidateConfidence(candidate: Candidate): number | null {
  return normalizeConfidenceScore(candidate.confidence ?? candidate.score);
}

function confidenceLabel(pct: number | null): { text: string; className: string } | null {
  if (pct === null) return null;
  if (pct >= 70) return { text: "alta confiança", className: "bg-accent/20 text-accent border-accent/30" };
  if (pct >= 40) return { text: "média confiança", className: "bg-amber-500/20 text-amber-600 border-amber-500/30" };
  return { text: "baixa confiança", className: "border-muted-foreground/50 text-muted-foreground" };
}

export default function TargetPrerequisitesModal({
  open,
  onOpenChange,
  projectId,
  requiredFields,
  candidates,
  onSave,
}: TargetPrerequisitesModalProps) {
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Auto-fill high-confidence candidates
  useEffect(() => {
    if (!open) return;
    const auto: Record<string, string> = {};
    for (const field of requiredFields) {
      const meta = FIELD_META[field];
      if (!meta) continue;
      const fieldCandidates = (candidates as any)[meta.candidateKey] as Candidate[] | undefined;
      if (fieldCandidates && fieldCandidates.length > 0) {
        const pct = getCandidateConfidence(fieldCandidates[0]);
        if (pct !== null && pct >= 70) {
          auto[field] = fieldCandidates[0].column;
        }
      }
    }
    setValues(auto);
  }, [open, requiredFields, candidates]);

  const handleSave = async () => {
    if (saving) return; // anti-double-submit

    const missing = requiredFields.filter(f => !values[f]);
    if (missing.length > 0) {
      toast({
        title: "Campos obrigatórios",
        description: `Preencha: ${missing.map(m => FIELD_META[m]?.label || m).join(", ")}`,
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const updatePayload: Record<string, unknown> = {};
      if (values.entity_key) updatePayload.entity_key = values.entity_key;
      if (values.time_anchor) updatePayload.time_anchor_column = values.time_anchor;
      if (values.value_column) updatePayload.value_column = values.value_column;
      updatePayload.prerequisites_resolved_at = new Date().toISOString();
      updatePayload.prerequisites_source = "manual";

      const { data: savedSettings, error } = await supabase
        .from("project_settings")
        .update(updatePayload as any)
        .eq("project_id", projectId)
        .select("project_id, entity_key, time_anchor_column, value_column")
        .maybeSingle();

      if (error) throw error;
      if (!savedSettings) {
        throw new Error("Não foi possível localizar as configurações do projeto para salvar os pré-requisitos.");
      }

      await onSave(values);
      toast({ title: "Configuração salva", description: "Pré-requisitos configurados com sucesso." });
    } catch (err) {
      console.error("[TargetPrerequisitesModal] Save error:", err);
      toast({
        title: "Erro ao salvar",
        description: `Erro ao salvar: ${await extractErrorMessage(err)}`,
        variant: "destructive",
      });
      // Keep modal open on error — don't close
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            Configurar pré-requisitos
          </DialogTitle>
          <DialogDescription>
            A estratégia selecionada precisa de algumas colunas configuradas para funcionar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {requiredFields.map((field) => {
            const meta = FIELD_META[field];
            if (!meta) return null;
            const fieldCandidates = (candidates as any)[meta.candidateKey] as Candidate[] | undefined;
            const hasCandidates = fieldCandidates && fieldCandidates.length > 0;

            return (
              <div key={field} className="space-y-1.5">
                <Label className="text-sm font-medium flex items-center gap-2">
                  {meta.label}
                  {values[field] && hasCandidates && (
                    <Badge className="bg-accent/20 text-accent border-accent/30 text-[9px]">
                      <CheckCircle className="w-2.5 h-2.5 mr-0.5" />
                      auto
                    </Badge>
                  )}
                </Label>
                <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                <Select value={values[field] || ""} onValueChange={(v) => setValues(prev => ({ ...prev, [field]: v }))}>
                  <SelectTrigger className="bg-background">
                    <SelectValue placeholder="Selecione a coluna..." />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border border-border shadow-lg z-50">
                    {hasCandidates ? (
                      fieldCandidates.map((c) => {
                        const pct = getCandidateConfidence(c);
                        const label = confidenceLabel(pct);
                        const showPercent = pct !== null && c.source === "tde_profile" && pct < 100;
                        const showAutoLabel = !showPercent;
                        return (
                          <SelectItem key={c.column} value={c.column}>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm">{c.column}</span>
                              {showPercent ? (
                                <Badge variant="outline" className="text-[9px]">
                                  {pct}%
                                </Badge>
                              ) : showAutoLabel ? (
                                <Badge variant="outline" className={`text-[9px] ${label?.className ?? "border-muted-foreground/50 text-muted-foreground"}`}>
                                  {label?.text ?? "auto"}
                                </Badge>
                              ) : null}
                            </div>
                          </SelectItem>
                        );
                      })
                    ) : (
                      <SelectItem value="_none" disabled>
                        Nenhum candidato detectado
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {!hasCandidates && (
                  <div className="flex items-center gap-1 text-[10px] text-amber-600">
                    <AlertTriangle className="w-3 h-3" />
                    Nenhum candidato detectado. Verifique se o dataset possui esta informação.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Salvando...</>
            ) : (
              "Confirmar e aplicar"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
