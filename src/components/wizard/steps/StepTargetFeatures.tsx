import { useState, useEffect } from "react";
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
import { Target, Layers, Info, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { ProjectData } from "../WizardContainer";

interface StepTargetFeaturesProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

interface ColumnInfo {
  name: string;
  type: string;
}

const StepTargetFeatures = ({
  projectData,
  onNext,
  onBack,
  loading,
  saveProject,
}: StepTargetFeaturesProps) => {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [loadingColumns, setLoadingColumns] = useState(true);
  const [targetColumn, setTargetColumn] = useState(projectData.target_column || "");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);

  // Load columns from database when component mounts or project changes
  useEffect(() => {
    if (projectData.id) {
      loadColumns();
    }
  }, [projectData.id]);

  // Update selected features when columns load or target changes
  useEffect(() => {
    if (columns.length > 0 && selectedFeatures.length === 0) {
      // Auto-select all features except target
      const features = columns
        .filter((c) => c.name !== targetColumn)
        .map((c) => c.name);
      setSelectedFeatures(features);
    }
  }, [columns, targetColumn]);

  const loadColumns = async () => {
    setLoadingColumns(true);
    try {
      const { data, error } = await supabase
        .from("project_columns")
        .select("column_name, inferred_type")
        .eq("project_id", projectData.id)
        .order("column_index");

      if (error) {
        console.error("Erro ao carregar colunas:", error);
        return;
      }

      if (data && data.length > 0) {
        const cols = data.map((col) => ({
          name: col.column_name,
          type: col.inferred_type,
        }));
        setColumns(cols);

        // If target was already selected and exists in columns, keep it
        if (projectData.target_column && cols.some((c) => c.name === projectData.target_column)) {
          setTargetColumn(projectData.target_column);
        } else if (cols.length > 0) {
          // Auto-select first column as target (user can change)
          // setTargetColumn(cols[0].name);
        }
      }
    } catch (err) {
      console.error("Erro ao carregar colunas:", err);
    }
    setLoadingColumns(false);
  };

  const handleTargetChange = (value: string) => {
    setTargetColumn(value);
    // Remove target from features and auto-select remaining
    setSelectedFeatures((prev) => {
      const newFeatures = prev.filter((f) => f !== value);
      // If no features selected, select all except new target
      if (newFeatures.length === 0) {
        return columns.filter((c) => c.name !== value).map((c) => c.name);
      }
      return newFeatures;
    });
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

  const availableFeatures = columns.filter((col) => col.name !== targetColumn);

  if (loadingColumns) {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="flex flex-col items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
          <p className="text-muted-foreground">Carregando colunas do dataset...</p>
        </div>
      </Card>
    );
  }

  if (columns.length === 0) {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="text-center py-8">
          <div className="w-16 h-16 bg-destructive/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Target className="w-8 h-8 text-destructive" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Nenhuma coluna encontrada</h3>
          <p className="text-muted-foreground mb-6">
            Faça upload de um arquivo CSV no passo anterior para continuar.
          </p>
          <Button variant="outline" onClick={onBack}>
            Voltar para Dados
          </Button>
        </div>
      </Card>
    );
  }

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
              <SelectTrigger className="bg-background">
                <SelectValue placeholder="Selecione a coluna que quer prever" />
              </SelectTrigger>
              <SelectContent className="bg-popover border border-border shadow-lg z-50">
                {columns.map((col) => (
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
                ? "Para classificação, escolha uma coluna categórica (ex: sim/não, tipo A/B/C) ou numérica binária (0/1)"
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
            disabled={loading || !targetColumn}
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
