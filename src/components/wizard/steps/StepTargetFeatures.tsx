import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Target, Layers, Info } from "lucide-react";
import type { ProjectData } from "../WizardContainer";

interface StepTargetFeaturesProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

// Placeholder columns - will be replaced with real data from CSV
const PLACEHOLDER_COLUMNS = [
  { name: "idade", type: "numérico" },
  { name: "salario", type: "numérico" },
  { name: "genero", type: "categórico" },
  { name: "cidade", type: "categórico" },
  { name: "comprou", type: "categórico" },
  { name: "valor_compra", type: "numérico" },
];

const StepTargetFeatures = ({
  projectData,
  onNext,
  onBack,
  loading,
  saveProject,
}: StepTargetFeaturesProps) => {
  const [targetColumn, setTargetColumn] = useState(projectData.target_column || "");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>(
    PLACEHOLDER_COLUMNS.filter((c) => c.name !== targetColumn).map((c) => c.name)
  );

  const handleTargetChange = (value: string) => {
    setTargetColumn(value);
    // Remove target from features
    setSelectedFeatures((prev) => prev.filter((f) => f !== value));
  };

  const toggleFeature = (columnName: string) => {
    setSelectedFeatures((prev) =>
      prev.includes(columnName)
        ? prev.filter((f) => f !== columnName)
        : [...prev, columnName]
    );
  };

  const handleNext = async () => {
    if (targetColumn) {
      await saveProject({ target_column: targetColumn }, 5);
    } else {
      onNext();
    }
  };

  const availableFeatures = PLACEHOLDER_COLUMNS.filter(
    (col) => col.name !== targetColumn
  );

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Target className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            Variável Alvo e Features
          </h2>
          <p className="text-muted-foreground">
            Escolha qual variável você quer prever e quais dados usar para a previsão
          </p>
        </div>

        {/* Target selection */}
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
            <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-primary mb-1">O que é a variável alvo?</p>
              <p className="text-muted-foreground">
                É a variável que você quer prever. Por exemplo: se o cliente vai cancelar (sim/não), 
                quanto vai gastar, qual produto vai comprar, etc.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              Variável Alvo (Target)
            </Label>
            <Select value={targetColumn} onValueChange={handleTargetChange}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione a coluna que quer prever" />
              </SelectTrigger>
              <SelectContent>
                {PLACEHOLDER_COLUMNS.map((col) => (
                  <SelectItem key={col.name} value={col.name}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{col.name}</span>
                      <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">
                        {col.type}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {projectData.problem_type === "classification"
                ? "Para classificação, escolha uma coluna categórica (ex: sim/não, tipo A/B/C)"
                : "Para regressão, escolha uma coluna numérica (ex: preço, quantidade)"}
            </p>
          </div>
        </div>

        {/* Features selection */}
        <div className="space-y-4">
          <Label className="text-base font-medium flex items-center gap-2">
            <Layers className="w-4 h-4 text-secondary" />
            Variáveis Preditoras (Features)
          </Label>
          <p className="text-sm text-muted-foreground">
            Selecione as colunas que serão usadas para fazer a previsão. 
            Geralmente, quanto mais relevantes, melhor o modelo.
          </p>

          <div className="bg-muted/30 rounded-xl p-4 space-y-3 max-h-64 overflow-y-auto">
            {availableFeatures.length > 0 ? (
              availableFeatures.map((col) => (
                <div
                  key={col.name}
                  className="flex items-center justify-between p-3 bg-background rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={col.name}
                      checked={selectedFeatures.includes(col.name)}
                      onCheckedChange={() => toggleFeature(col.name)}
                    />
                    <label
                      htmlFor={col.name}
                      className="font-medium cursor-pointer"
                    >
                      {col.name}
                    </label>
                  </div>
                  <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                    {col.type}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-center text-muted-foreground py-4">
                Selecione primeiro a variável alvo
              </p>
            )}
          </div>

          {selectedFeatures.length > 0 && (
            <p className="text-sm text-accent">
              {selectedFeatures.length} variável(is) selecionada(s)
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Voltar
          </Button>
          <Button
            onClick={handleNext}
            disabled={loading}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {loading ? "Salvando..." : "Próximo"}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepTargetFeatures;
