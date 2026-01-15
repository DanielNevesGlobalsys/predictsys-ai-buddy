import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertCircle, Package, ChevronRight, ArrowLeft, CheckCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { 
  ProjectFeature, 
  FEATURE_PACKAGES, 
  FeaturePackage,
  FeatureExpression
} from "@/lib/featureEngineering";

interface FeaturePackageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  columns: { column_name: string; inferred_type: string }[];
  existingFeatureNames: string[];
  onPackageApplied: (features: ProjectFeature[]) => void;
}

export default function FeaturePackageModal({
  open,
  onOpenChange,
  projectId,
  columns,
  existingFeatureNames,
  onPackageApplied,
}: FeaturePackageModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"select" | "configure">("select");
  const [selectedPackage, setSelectedPackage] = useState<FeaturePackage | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columnOptions = columns.map((c) => c.column_name);

  const handleSelectPackage = (pkg: FeaturePackage) => {
    setSelectedPackage(pkg);
    setColumnMapping({});
    setError(null);
    setStep("configure");
  };

  const handleBack = () => {
    setStep("select");
    setSelectedPackage(null);
    setColumnMapping({});
    setError(null);
  };

  const handleApply = async () => {
    if (!selectedPackage) return;

    // Validate all required columns are mapped
    for (const col of selectedPackage.requiredColumns) {
      if (!columnMapping[col.key]) {
        setError(`Selecione a coluna para "${col.label}"`);
        return;
      }
    }

    // Generate features from package
    const newFeatures = selectedPackage.generateFeatures(columnMapping);

    // Filter out features that already exist
    const uniqueFeatures = newFeatures.filter(
      (f) => !existingFeatureNames.includes(f.name)
    );

    if (uniqueFeatures.length === 0) {
      setError("Todas as features deste pacote já existem no projeto");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const featuresToInsert = uniqueFeatures.map((f) => ({
        project_id: projectId,
        name: f.name,
        label: f.label,
        description: f.description,
        expression: f.expression,
        enabled: f.enabled,
      }));

      const { data, error: insertError } = await supabase
        .from("project_features")
        .insert(featuresToInsert)
        .select();

      if (insertError) throw insertError;

      const createdFeatures: ProjectFeature[] = (data || []).map((d) => ({
        ...d,
        expression: d.expression as FeatureExpression,
      }));

      toast.success(
        `Pacote "${selectedPackage.name}" aplicado com sucesso — ${createdFeatures.length} novas features criadas`
      );

      onPackageApplied(createdFeatures);
    } catch (err) {
      console.error("Error applying package:", err);
      setError("Erro ao aplicar pacote. Tente novamente.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            {step === "select"
              ? "Pacotes de Features Pré-definidos"
              : selectedPackage?.name}
          </DialogTitle>
          <DialogDescription>
            {step === "select"
              ? "Escolha um pacote para criar automaticamente features otimizadas para churn e positivação"
              : "Mapeie as colunas do seu dataset para as variáveis do pacote"}
          </DialogDescription>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-4 py-4">
            {FEATURE_PACKAGES.map((pkg) => (
              <Card
                key={pkg.id}
                className="cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => handleSelectPackage(pkg)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{pkg.name}</CardTitle>
                    <ChevronRight className="w-5 h-5 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-sm">
                    {pkg.description}
                  </CardDescription>
                  <div className="flex flex-wrap gap-1 mt-3">
                    {pkg.requiredColumns.map((col) => (
                      <Badge key={col.key} variant="outline" className="text-xs">
                        {col.label}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {step === "configure" && selectedPackage && (
          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="p-4 bg-muted/50 rounded-lg">
              <p className="text-sm text-muted-foreground">
                {selectedPackage.description}
              </p>
            </div>

            <div className="space-y-4">
              {selectedPackage.requiredColumns.map((reqCol) => (
                <div key={reqCol.key} className="space-y-2">
                  <Label>{reqCol.label}</Label>
                  <Select
                    value={columnMapping[reqCol.key] || ""}
                    onValueChange={(val) =>
                      setColumnMapping((prev) => ({ ...prev, [reqCol.key]: val }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a coluna" />
                    </SelectTrigger>
                    <SelectContent>
                      {columnOptions.map((col) => (
                        <SelectItem key={col} value={col}>
                          {col}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {reqCol.description}
                  </p>
                </div>
              ))}
            </div>

            {/* Preview of features that will be created */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">Features que serão criadas:</Label>
              <div className="flex flex-wrap gap-2">
                {Object.keys(columnMapping).length ===
                  selectedPackage.requiredColumns.length &&
                  selectedPackage
                    .generateFeatures(columnMapping)
                    .map((f) => (
                      <Badge
                        key={f.name}
                        variant={
                          existingFeatureNames.includes(f.name)
                            ? "secondary"
                            : "default"
                        }
                        className="text-xs"
                      >
                        {existingFeatureNames.includes(f.name) ? (
                          <span className="line-through opacity-50">{f.label}</span>
                        ) : (
                          <>
                            <CheckCircle className="w-3 h-3 mr-1" />
                            {f.label}
                          </>
                        )}
                      </Badge>
                    ))}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "configure" && (
            <Button variant="ghost" onClick={handleBack} className="mr-auto">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Voltar
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          {step === "configure" && (
            <Button onClick={handleApply} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Aplicar Pacote
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
