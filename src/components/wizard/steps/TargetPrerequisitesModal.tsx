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

interface Candidate {
  column: string;
  score: number;
  reasons: string[];
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
  onSave: (config: Record<string, string>) => void;
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

// Confidence label when no numeric score is meaningful
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
        const pct = normalizeConfidenceScore(fieldCandidates[0].score);
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

      const { error } = await supabase
        .from("project_settings")
        .update(updatePayload as any)
        .eq("project_id", projectId);

      if (error) throw error;

      onSave(values);
      // onSave will handle closing the modal and continuing
      toast({ title: "Configuração salva", description: "Pré-requisitos configurados com sucesso." });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: String(err), variant: "destructive" });
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
                        const pct = normalizeConfidenceScore(c.score);
                        const label = confidenceLabel(pct);
                        return (
                          <SelectItem key={c.column} value={c.column}>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm">{c.column}</span>
                              {pct !== null && pct > 0 && pct < 100 ? (
                                <Badge variant="outline" className="text-[9px]">
                                  {pct}%
                                </Badge>
                              ) : label ? (
                                <Badge variant="outline" className={`text-[9px] ${label.className}`}>
                                  {label.text}
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
