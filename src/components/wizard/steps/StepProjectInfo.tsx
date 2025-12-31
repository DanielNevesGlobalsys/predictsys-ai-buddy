import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, Target, Lightbulb } from "lucide-react";
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
    problem_type: projectData.problem_type,
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
      onNext(formData);
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

          {/* Tipo de problema */}
          <div className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              {t("stepInfo.problemType")} *
            </Label>
            <Select
              value={formData.problem_type}
              onValueChange={(value: "classification" | "regression") =>
                setFormData({ ...formData, problem_type: value })
              }
            >
              <SelectTrigger
                className={errors.problem_type ? "border-destructive" : ""}
              >
                <SelectValue placeholder={t("stepInfo.problemTypePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="classification">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">{t("project.classification")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("stepInfo.classificationDesc")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="regression">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">{t("project.regression")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("stepInfo.regressionDesc")}
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            {errors.problem_type && (
              <p className="text-sm text-destructive">{errors.problem_type}</p>
            )}

            {/* Dica explicativa */}
            <div className="mt-4 p-4 bg-muted/50 rounded-lg">
              <p className="text-sm text-muted-foreground">
                <strong>{t("project.classification")}:</strong> {t("stepInfo.classificationTip")}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                <strong>{t("project.regression")}:</strong> {t("stepInfo.regressionTip")}
              </p>
            </div>
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
