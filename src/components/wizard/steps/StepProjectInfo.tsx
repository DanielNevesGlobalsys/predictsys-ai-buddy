import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileText, Target, Lightbulb, Sparkles, AlertTriangle, Info } from "lucide-react";
import type { ProjectData } from "../WizardContainer";

interface StepProjectInfoProps {
  projectData: ProjectData;
  onNext: (data: Partial<ProjectData>) => void;
  onCancel: () => void;
  loading: boolean;
}

const StepProjectInfo = ({ projectData, onNext, onCancel, loading }: StepProjectInfoProps) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    name: projectData.name,
    description: projectData.description,
    business_objective: projectData.business_objective,
    problem_type: projectData.problem_type || "auto",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.name.trim()) {
      newErrors.name = t("stepInfo.errors.nameRequired");
    }
    if (!formData.problem_type) {
      newErrors.problem_type = t("stepInfo.errors.problemTypeRequired");
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      // If auto is selected, save as classification initially (will be detected later)
      const effectiveProblemType = formData.problem_type === "auto" 
        ? "classification" 
        : formData.problem_type as "classification" | "regression";
      
      onNext({
        ...formData,
        problem_type: effectiveProblemType,
      });
    }
  };

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FileText className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("stepInfo.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("stepInfo.subtitle")}
          </p>
        </div>

        <div className="space-y-5">
          {/* Nome do projeto */}
          <div className="space-y-2">
            <Label htmlFor="name" className="text-base font-medium">
              {t("stepInfo.projectName")} *
            </Label>
            <Input
              id="name"
              placeholder={t("stepInfo.projectNamePlaceholder")}
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              className={errors.name ? "border-destructive" : ""}
            />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name}</p>
            )}
            <p className="text-sm text-muted-foreground">
              {t("stepInfo.projectNameHint")}
            </p>
          </div>

          {/* Descrição */}
          <div className="space-y-2">
            <Label htmlFor="description" className="text-base font-medium">
              {t("stepInfo.description")}
            </Label>
            <Textarea
              id="description"
              placeholder={t("stepInfo.descriptionPlaceholder")}
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              rows={3}
            />
          </div>

          {/* Objetivo de negócio */}
          <div className="space-y-2">
            <Label
              htmlFor="business_objective"
              className="text-base font-medium flex items-center gap-2"
            >
              <Lightbulb className="w-4 h-4 text-secondary" />
              {t("stepInfo.businessObjective")}
            </Label>
            <Textarea
              id="business_objective"
              placeholder={t("stepInfo.businessObjectivePlaceholder")}
              value={formData.business_objective}
              onChange={(e) =>
                setFormData({ ...formData, business_objective: e.target.value })
              }
              rows={3}
            />
            <p className="text-sm text-muted-foreground">
              {t("stepInfo.businessObjectiveHint")}
            </p>
          </div>

          {/* Tipo de problema - Radio Group */}
          <div className="space-y-4">
            <Label className="text-base font-medium flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              {t("stepInfo.problemType")} *
            </Label>
            
            <RadioGroup
              value={formData.problem_type}
              onValueChange={(value) =>
                setFormData({ ...formData, problem_type: value })
              }
              className="space-y-3"
            >
              {/* Auto-detect option */}
              <div className={`flex items-start gap-4 p-4 rounded-lg border-2 transition-all cursor-pointer ${
                formData.problem_type === "auto" 
                  ? "border-primary bg-primary/5" 
                  : "border-border hover:border-primary/50"
              }`}>
                <RadioGroupItem value="auto" id="auto" className="mt-1" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="auto" className="font-semibold cursor-pointer">
                      {t("stepInfo.autoDetect")}
                    </Label>
                    <span className="px-2 py-0.5 bg-secondary/20 text-secondary text-xs rounded-full flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      {t("stepInfo.recommended")}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("stepInfo.autoDetectDesc")}
                  </p>
                </div>
              </div>

              {/* Classification option */}
              <div className={`flex items-start gap-4 p-4 rounded-lg border-2 transition-all cursor-pointer ${
                formData.problem_type === "classification" 
                  ? "border-primary bg-primary/5" 
                  : "border-border hover:border-primary/50"
              }`}>
                <RadioGroupItem value="classification" id="classification" className="mt-1" />
                <div className="flex-1">
                  <Label htmlFor="classification" className="font-semibold cursor-pointer">
                    {t("project.classification")}
                  </Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("stepInfo.classificationTip")}
                  </p>
                </div>
              </div>

              {/* Regression option */}
              <div className={`flex items-start gap-4 p-4 rounded-lg border-2 transition-all cursor-pointer ${
                formData.problem_type === "regression" 
                  ? "border-primary bg-primary/5" 
                  : "border-border hover:border-primary/50"
              }`}>
                <RadioGroupItem value="regression" id="regression" className="mt-1" />
                <div className="flex-1">
                  <Label htmlFor="regression" className="font-semibold cursor-pointer">
                    {t("project.regression")}
                  </Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("stepInfo.regressionTip")}
                  </p>
                </div>
              </div>
            </RadioGroup>

            {errors.problem_type && (
              <p className="text-sm text-destructive">{errors.problem_type}</p>
            )}

            {/* Info about auto-detection */}
            {formData.problem_type === "auto" && (
              <Alert className="bg-secondary/10 border-secondary/30">
                <Info className="w-4 h-4 text-secondary" />
                <AlertDescription className="text-secondary">
                  {t("stepInfo.autoDetectInfo")}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {loading ? t("common.loading") : t("stepInfo.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepProjectInfo;
