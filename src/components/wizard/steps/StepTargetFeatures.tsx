import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Target, Layers, Info, Loader2, Sparkles, AlertCircle, Bot, Save } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../WizardContainer";
import type { FeatureExpression } from "@/lib/featureEngineering";
import LysSuggestionCards, { type TargetSuggestion } from "./LysSuggestionCards";
import ExcludedFeaturesList from "./ExcludedFeaturesList";
import { useProjectSettings } from "@/hooks/useProjectSettings";

interface StepTargetFeaturesProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onConfigChange?: () => void;
}

interface ColumnInfo {
  name: string;
  type: string;
  isFeature?: boolean;
  featureLabel?: string;
  featureHasError?: boolean;
}

const StepTargetFeatures = ({
  projectData,
  onNext,
  onBack,
  loading,
  saveProject,
  onConfigChange,
}: StepTargetFeaturesProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [loadingColumns, setLoadingColumns] = useState(true);
  const [targetColumn, setTargetColumn] = useState(projectData.target_column || "");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [excludedColumns, setExcludedColumns] = useState<string[]>([]);
  const initialTargetRef = useRef<string | null>(null);
  const hasChangedConfig = useRef(false);

  // Lys suggestions state
  const [suggestions, setSuggestions] = useState<TargetSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [appliedSuggestionId, setAppliedSuggestionId] = useState<string | null>(null);
  const [suggestionsGenerated, setSuggestionsGenerated] = useState(false);

  // Project settings persistence
  const { settings, loadSettings, saveSettings } = useProjectSettings(projectData.id);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    if (projectData.id) {
      loadColumns();
      loadSettings().then((loaded) => {
        if (loaded) {
          setSettingsLoaded(true);
        }
      });
    }
  }, [projectData.id]);

  // Restore from persisted settings
  useEffect(() => {
    if (settings && settingsLoaded && columns.length > 0) {
      if (settings.target_column && columns.some((c) => c.name === settings.target_column)) {
        setTargetColumn(settings.target_column);
      }
      if (settings.feature_columns && settings.feature_columns.length > 0) {
        setSelectedFeatures(settings.feature_columns);
      }
      if (settings.excluded_columns) {
        setExcludedColumns(settings.excluded_columns);
      }
      if (settings.target_suggestion_meta?.chosen_suggestion_id) {
        setAppliedSuggestionId(settings.target_suggestion_meta.chosen_suggestion_id as string);
      }
    }
  }, [settings, settingsLoaded, columns]);

  // Store initial target on mount
  useEffect(() => {
    if (projectData.target_column && initialTargetRef.current === null) {
      initialTargetRef.current = projectData.target_column;
    }
  }, [projectData.target_column]);

  useEffect(() => {
    if (columns.length > 0 && selectedFeatures.length === 0 && !settingsLoaded) {
      const features = columns
        .filter((c) => c.name !== targetColumn && !c.featureHasError)
        .map((c) => c.name);
      setSelectedFeatures(features);
    }
  }, [columns, targetColumn, settingsLoaded]);

  const loadColumns = async () => {
    setLoadingColumns(true);
    try {
      const { data: colData, error: colError } = await supabase
        .from("project_columns")
        .select("column_name, inferred_type")
        .eq("project_id", projectData.id)
        .order("column_index");

      if (colError) {
        console.error("Error loading columns:", colError);
        return;
      }

      const { data: featureData, error: featureError } = await supabase
        .from("project_features")
        .select("name, label, enabled, expression")
        .eq("project_id", projectData.id)
        .eq("enabled", true);

      if (featureError) {
        console.error("Error loading features:", featureError);
      }

      const cols: ColumnInfo[] = [];

      if (colData && colData.length > 0) {
        for (const col of colData) {
          cols.push({
            name: col.column_name,
            type: col.inferred_type,
            isFeature: false,
          });
        }
      }

      if (featureData && featureData.length > 0) {
        for (const feature of featureData) {
          const expr = feature.expression as FeatureExpression | null;
          const hasError = !expr || !expr.type;
          cols.push({
            name: feature.name,
            type: "numérico",
            isFeature: true,
            featureLabel: feature.label,
            featureHasError: hasError,
          });
        }
      }

      setColumns(cols);

      if (projectData.target_column && cols.some((c) => c.name === projectData.target_column)) {
        setTargetColumn(projectData.target_column);
      }
    } catch (err) {
      console.error("Error loading columns:", err);
    }
    setLoadingColumns(false);
  };

  const handleTargetChange = (value: string) => {
    if (initialTargetRef.current && value !== initialTargetRef.current && !hasChangedConfig.current) {
      hasChangedConfig.current = true;
      onConfigChange?.();
    }
    setTargetColumn(value);
    setSelectedFeatures((prev) => {
      const newFeatures = prev.filter((f) => f !== value);
      if (newFeatures.length === 0) {
        return columns.filter((c) => c.name !== value).map((c) => c.name);
      }
      return newFeatures;
    });
    setAppliedSuggestionId(null);
  };

  const toggleFeature = (columnName: string) => {
    setSelectedFeatures((prev) =>
      prev.includes(columnName)
        ? prev.filter((f) => f !== columnName)
        : [...prev, columnName]
    );
  };

  const handleGenerateSuggestions = async () => {
    if (!projectData.id) return;
    setLoadingSuggestions(true);
    setSuggestionsGenerated(false);
    try {
      const { data, error } = await supabase.functions.invoke("ai-suggest-targets", {
        body: { project_id: projectData.id },
      });

      if (error) throw error;

      const result = data as { suggestions: TargetSuggestion[] };
      setSuggestions(result.suggestions || []);
      setSuggestionsGenerated(true);

      if (result.suggestions.length === 0) {
        toast({
          title: t("lysSuggestions.noSuggestions", "Nenhuma sugestão"),
          description: t("lysSuggestions.noSuggestionsDesc", "A Lys não encontrou candidatos claros para target neste dataset."),
        });
      }
    } catch (err: any) {
      console.error("Error generating suggestions:", err);
      toast({
        title: t("common.error"),
        description: err.message || t("lysSuggestions.errorGenerating", "Erro ao gerar sugestões"),
        variant: "destructive",
      });
    }
    setLoadingSuggestions(false);
  };

  const handleApplySuggestion = (suggestion: TargetSuggestion) => {
    // Set target
    setTargetColumn(suggestion.target_column);
    setAppliedSuggestionId(suggestion.id);

    // Set features (recommended) and excluded
    setSelectedFeatures(suggestion.recommended_features);
    setExcludedColumns(suggestion.excluded_features);

    // Check if target changed from initial
    if (
      initialTargetRef.current &&
      suggestion.target_column !== initialTargetRef.current &&
      !hasChangedConfig.current
    ) {
      hasChangedConfig.current = true;
      onConfigChange?.();
    }

    toast({
      title: t("lysSuggestions.suggestionApplied", "Sugestão aplicada!"),
      description: t("lysSuggestions.suggestionAppliedDesc", "Target, tipo de problema e features foram configurados. Revise e ajuste se necessário."),
    });
  };

  const handleSaveSettings = async () => {
    if (!projectData.id || !targetColumn) return;

    // Validate: target cannot be in features
    const cleanFeatures = selectedFeatures.filter((f) => f !== targetColumn);
    if (cleanFeatures.length === 0) {
      toast({
        title: t("common.error"),
        description: t("lysSuggestions.needOneFeature", "Selecione ao menos 1 feature."),
        variant: "destructive",
      });
      return;
    }

    // Determine problem_type from suggestion or project data
    const appliedSug = suggestions.find((s) => s.id === appliedSuggestionId);
    const problemType = appliedSug?.problem_type || projectData.problem_type;

    // Warn if classification with high unique count
    const targetCol = columns.find((c) => c.name === targetColumn);
    if (problemType === "classification" && targetCol) {
      // We can't easily check unique_count from columns, but the suggestion warnings should cover it
    }

    const saved = await saveSettings({
      target_column: targetColumn,
      problem_type: problemType,
      feature_columns: cleanFeatures,
      excluded_columns: excludedColumns,
      suggestion: appliedSug || null,
    });

    if (saved) {
      toast({
        title: t("lysSuggestions.settingsSaved", "Configuração salva!"),
        description: t("lysSuggestions.settingsSavedDesc", "Target, features e configurações foram persistidos."),
      });
    }
  };

  const handleNext = async () => {
    if (targetColumn) {
      // Save settings before moving forward
      await handleSaveSettings();

      // Determine problem_type from applied suggestion
      const appliedSug = suggestions.find((s) => s.id === appliedSuggestionId);
      const updateData: Partial<ProjectData> = { target_column: targetColumn };
      if (appliedSug) {
        updateData.problem_type = appliedSug.problem_type;
      }

      await saveProject(updateData, 5);
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

        {/* Lys Suggestions Section */}
        <div className="space-y-4 p-5 border border-secondary/30 rounded-xl bg-secondary/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-secondary" />
              <h3 className="font-semibold text-sm">
                {t("lysSuggestions.title", "Sugestões da Lys")}
              </h3>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerateSuggestions}
              disabled={loadingSuggestions}
            >
              {loadingSuggestions ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  {t("lysSuggestions.generating", "Analisando...")}
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  {suggestionsGenerated
                    ? t("lysSuggestions.regenerate", "Regenerar")
                    : t("lysSuggestions.generate", "Gerar sugestões")}
                </>
              )}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            {t(
              "lysSuggestions.description",
              "A Lys sugere opções com base no EDA. Você sempre pode ajustar manualmente."
            )}
          </p>

          {suggestionsGenerated && (
            <LysSuggestionCards
              suggestions={suggestions}
              onApply={handleApplySuggestion}
              appliedId={appliedSuggestionId}
            />
          )}
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
              <>
                {/* Original columns first */}
                {availableFeatures.filter(col => !col.isFeature).map((col) => (
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
                ))}

                {/* Engineered features section */}
                {availableFeatures.filter(col => col.isFeature).length > 0 && (
                  <>
                    <div className="flex items-center gap-2 pt-2 pb-1 px-1">
                      <Sparkles className="w-4 h-4 text-secondary" />
                      <span className="text-sm font-medium text-secondary">
                        {t("stepVariables.engineeredFeatures", "Features criadas")}
                      </span>
                    </div>
                    {availableFeatures.filter(col => col.isFeature).map((col) => (
                      <div
                        key={col.name}
                        className={`flex items-center justify-between p-3 rounded-lg transition-colors ${
                          col.featureHasError
                            ? "bg-destructive/10 border border-destructive/30"
                            : "bg-secondary/5 border border-secondary/20 hover:bg-secondary/10"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <Checkbox
                            id={col.name}
                            checked={selectedFeatures.includes(col.name)}
                            onCheckedChange={() => toggleFeature(col.name)}
                            disabled={col.featureHasError}
                          />
                          <div className="flex flex-col">
                            <label
                              htmlFor={col.name}
                              className={`font-medium cursor-pointer ${col.featureHasError ? "text-muted-foreground" : ""}`}
                            >
                              {col.featureLabel || col.name}
                            </label>
                            <span className="text-xs text-muted-foreground font-mono">
                              {col.name}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {col.featureHasError ? (
                            <Badge variant="destructive" className="text-xs">
                              <AlertCircle className="w-3 h-3 mr-1" />
                              {t("stepVariables.featureError", "Erro")}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">
                              <Sparkles className="w-3 h-3 mr-1" />
                              {t("stepVariables.createdFeature", "Feature")}
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            ) : (
              <p className="text-center text-muted-foreground py-4">
                {t("stepVariables.selectTargetFirst")}
              </p>
            )}
          </div>

          {/* Excluded features collapsible */}
          {excludedColumns.length > 0 && (
            <ExcludedFeaturesList excludedColumns={excludedColumns} />
          )}

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
          <div className="flex gap-2">
            {targetColumn && (
              <Button
                variant="outline"
                onClick={handleSaveSettings}
                disabled={loading || !targetColumn}
              >
                <Save className="w-4 h-4 mr-1.5" />
                {t("common.save")}
              </Button>
            )}
            <Button
              onClick={handleNext}
              disabled={loading || !targetColumn}
              className="bg-gradient-primary hover:shadow-hover transition-all"
            >
              {loading ? t("common.loading") : t("common.next")}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default StepTargetFeatures;
