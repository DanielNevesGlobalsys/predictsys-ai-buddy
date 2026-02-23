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
import { CheckCircle, AlertTriangle, Settings2 } from "lucide-react";
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
  requiredFields: string[]; // e.g. ["entity_key", "time_anchor", "value_column"]
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
      if (fieldCandidates && fieldCandidates.length > 0 && fieldCandidates[0].score >= 8) {
        auto[field] = fieldCandidates[0].column;
      }
    }
    setValues(auto);
  }, [open, requiredFields, candidates]);

  const handleSave = async () => {
    // Check all required fields are filled
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
      // Persist to project_settings
      const updatePayload: Record<string, unknown> = {};
      if (values.entity_key) updatePayload.entity_key = values.entity_key;
      if (values.time_anchor) updatePayload.time_anchor_column = values.time_anchor;

      await supabase
        .from("project_settings")
        .update(updatePayload as any)
        .eq("project_id", projectId);

      onSave(values);
      onOpenChange(false);
      toast({ title: "Configuração salva", description: "Pré-requisitos configurados com sucesso." });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const allAutoFilled = requiredFields.every(f => {
    const meta = FIELD_META[f];
    if (!meta) return false;
    const fieldCandidates = (candidates as any)[meta.candidateKey] as Candidate[] | undefined;
    return fieldCandidates && fieldCandidates.length > 0 && fieldCandidates[0].score >= 8;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            Configurar pré-requisitos
          </DialogTitle>
          <DialogDescription>
            A estratégia selecionada precisa de algumas colunas configuradas para funcionar.
            {allAutoFilled && (
              <span className="block mt-1 text-accent font-medium">
                ✓ Todas as colunas foram detectadas automaticamente. Confirme abaixo.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {requiredFields.map((field) => {
            const meta = FIELD_META[field];
            if (!meta) return null;
            const fieldCandidates = (candidates as any)[meta.candidateKey] as Candidate[] | undefined;
            const isAutoFilled = fieldCandidates && fieldCandidates.length > 0 && fieldCandidates[0].score >= 8 && values[field] === fieldCandidates[0].column;

            return (
              <div key={field} className="space-y-1.5">
                <Label className="text-sm font-medium flex items-center gap-2">
                  {meta.label}
                  {isAutoFilled && (
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
                    {fieldCandidates && fieldCandidates.length > 0 ? (
                      fieldCandidates.map((c) => (
                        <SelectItem key={c.column} value={c.column}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm">{c.column}</span>
                            <Badge variant="outline" className="text-[9px]">
                              {Math.min(Math.round(c.score * 10), 100)}%
                            </Badge>
                          </div>
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="_none" disabled>
                        Nenhum candidato detectado
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {!fieldCandidates?.length && (
                  <div className="flex items-center gap-1 text-[10px] text-amber-600">
                    <AlertTriangle className="w-3 h-3" />
                    Nenhum candidato forte detectado. Verifique se o dataset possui esta informação.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Salvando..." : "Confirmar e aplicar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
