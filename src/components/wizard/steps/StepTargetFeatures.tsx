import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [loadingColumns, setLoadingColumns] = useState(true);
  const [targetColumn, setTargetColumn] = useState(projectData.target_column || "");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);

  useEffect(() => {
    if (projectData.id) {
      loadColumns();
    }
  }, [projectData.id]);

  useEffect(() => {
    if (columns.length > 0 && selectedFeatures.length === 0) {
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
        console.error("Error loading columns:", error);
        return;
      }

      if (data && data.length > 0) {
        const cols = data.map((col) => ({
          name: col.column_name,
          type: col.inferred_type,
        }));
        setColumns(cols);

        if (projectData.target_column && cols.some((c) => c.name === projectData.target_column)) {
          setTargetColumn(projectData.target_column);
        }
      }
    } catch (err) {
      console.error("Error loading columns:", err);
    }
    setLoadingColumns(false);
  };

  const handleTargetChange = (value: string) => {
    setTargetColumn(value);
    setSelectedFeatures((prev) => {
      const newFeatures = prev.filter((f) => f !== value);
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
          <p className="text-muted-foreground">{t("stepVariables.loadingColumns")}</p>
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
          <h3 className="text-lg font-semibold mb-2">{t("stepVariables.noColumns")}</h3>
          <p className="text-muted-foreground mb-6">
            {t("stepVariables.noColumnsDesc")}
          </p>
          <Button variant="outline" onClick={onBack}>
            {t("stepVariables.backToData")}
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
            {t("stepVariables.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("stepVariables.subtitle")}
          </p>
        </div>

        {/* Target selection */}
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
            <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-primary mb-1">{t("stepVariables.whatIsTarget")}</p>
              <p className="text-muted-foreground">
                {t("stepVariables.whatIsTargetDesc")}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              {t("stepVariables.targetVariable")}
            </Label>
            <Select value={targetColumn} onValueChange={handleTargetChange}>
              <SelectTrigger className="bg-background">
                <SelectValue placeholder={t("stepVariables.selectTarget")} />
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
                ? t("stepVariables.classificationHint")
                : t("stepVariables.regressionHint")}
            </p>
          </div>
        </div>

        {/* Features selection */}
        <div className="space-y-4">
          <Label className="text-base font-medium flex items-center gap-2">
            <Layers className="w-4 h-4 text-secondary" />
            {t("stepVariables.features")}
          </Label>
          <p className="text-sm text-muted-foreground">
            {t("stepVariables.featuresDesc")}
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
                {t("stepVariables.selectTargetFirst")}
              </p>
            )}
          </div>

          {selectedFeatures.length > 0 && (
            <p className="text-sm text-accent">
              {t("stepVariables.selectedCount", { count: selectedFeatures.length })}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            {t("common.back")}
          </Button>
          <Button
            onClick={handleNext}
            disabled={loading || !targetColumn}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {loading ? t("common.loading") : t("common.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepTargetFeatures;
