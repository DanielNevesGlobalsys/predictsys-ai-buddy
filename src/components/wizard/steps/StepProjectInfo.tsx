import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Target, Lightbulb, Sparkles, Info, AlertTriangle, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useProjectAIContext, type AIContextIntent } from "@/hooks/useProjectAIContext";
import IntentContractSummary from "./IntentContractSummary";
import IndustrySelector from "./IndustrySelector";
import type { ProjectData } from "../WizardContainer";
import type { IndustryKey, IntentContractV2 } from "@/types/intentContract";
import { normalizeIntentContract, validateIntentGates } from "@/types/intentContract";
import { hasAdapter, getDomainAdapter } from "@/config/domainAdapters";

interface StepProjectInfoProps {
  projectData: ProjectData;
  onNext: (data: Partial<ProjectData>) => void;
  onCancel: () => void;
  loading: boolean;
}

const OBJECTIVE_OPTIONS = [
  { value: "churn", label: "Churn / Cancelamento" },
  { value: "inadimplencia", label: "Inadimplência / Default" },
  { value: "conversao", label: "Conversão / Vendas" },
  { value: "receita", label: "Receita / Faturamento" },
  { value: "logistica", label: "Logística / Entrega" },
  { value: "saude", label: "Saúde / Diagnóstico" },
  { value: "educacao", label: "Educação / Evasão" },
  { value: "segmentacao", label: "Segmentação de Clientes" },
  { value: "outro", label: "Outro (descrever abaixo)" },
];

const StepProjectInfo = ({ projectData, onNext, onCancel, loading }: StepProjectInfoProps) => {
  const { t } = useTranslation();
  const { loadContext } = useProjectAIContext(projectData.id);
  
  const [formData, setFormData] = useState({
    name: projectData.name,
    description: projectData.description,
    business_objective: projectData.business_objective,
    problem_type: projectData.problem_type || "auto",
    declared_objective: "",
  });
  const [selectedIndustry, setSelectedIndustry] = useState<IndustryKey | "">("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [intentContract, setIntentContract] = useState<AIContextIntent | null>(null);
  const [intentContractV2, setIntentContractV2] = useState<IntentContractV2 | null>(null);
  const [generatingContract, setGeneratingContract] = useState(false);
  const [gateWarnings, setGateWarnings] = useState<{ status: string; code: string; message: string; cta?: string }[]>([]);

  // Load existing contract on mount
  useEffect(() => {
    if (projectData.id) {
      loadContext().then((ctx) => {
        if (!ctx) return;
        const anyCtx = ctx as any;

        // Try v2 format first
        if (anyCtx.intent_contract) {
          const normalized = normalizeIntentContract(anyCtx.intent_contract);
          if (normalized) {
            setIntentContractV2(normalized);
            setSelectedIndustry(normalized.domain_adapter.industry as IndustryKey);
            setFormData(prev => ({
              ...prev,
              declared_objective: normalized.intent_base.declared_objective || prev.declared_objective,
            }));
          }
        }

        // Also load legacy for backward compat rendering
        if (anyCtx.intent?.declared_objective) {
          setIntentContract(anyCtx.intent);
          if (!intentContractV2) {
            setFormData(prev => ({
              ...prev,
              declared_objective: anyCtx.intent.declared_objective || prev.declared_objective,
            }));
            // Try to set industry from legacy
            if (anyCtx.intent.industry_hint && !selectedIndustry) {
              setSelectedIndustry(anyCtx.intent.industry_hint as IndustryKey);
            }
          }
        }
      });
    }
  }, [projectData.id]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.name.trim()) {
      newErrors.name = t("stepInfo.errors.nameRequired");
    }
    if (!formData.problem_type) {
      newErrors.problem_type = t("stepInfo.errors.problemTypeRequired");
    }
    if (!formData.declared_objective && !formData.business_objective.trim()) {
      newErrors.declared_objective = "Selecione ou descreva o objetivo do projeto";
    }

    // Gate validations
    const objective = formData.declared_objective === "outro"
      ? formData.business_objective
      : formData.declared_objective;
    const gates = validateIntentGates(
      selectedIndustry || undefined,
      objective,
      selectedIndustry ? hasAdapter(selectedIndustry) : false
    );
    
    const blocks = gates.filter(g => g.status === "BLOCK");
    if (blocks.length > 0) {
      blocks.forEach(b => {
        if (b.code === "OBJECTIVE_EMPTY") newErrors.declared_objective = b.message;
        if (b.code === "INDUSTRY_NOT_SELECTED") newErrors.industry = b.message;
      });
    }

    setGateWarnings(gates.filter(g => g.status === "WARN"));
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const generateIntentContract = useCallback(async (projectId: string, data: typeof formData) => {
    setGeneratingContract(true);
    try {
      const objective = data.declared_objective === "outro" 
        ? data.business_objective 
        : data.declared_objective || data.business_objective;

      const { data: result, error } = await supabase.functions.invoke("generate-intent-contract", {
        body: {
          project_id: projectId,
          project_name: data.name,
          project_description: data.description,
          declared_objective: objective,
          industry: selectedIndustry || undefined,
        },
      });

      if (error) {
        console.error("[StepProjectInfo] Intent contract error:", error);
        return;
      }

      // Handle v2 response
      if (result?.intent_base && result?.domain_adapter) {
        setIntentContractV2({
          intent_base: result.intent_base,
          domain_adapter: result.domain_adapter,
          contract_version: result.contract_version,
          created_at: result.created_at,
        });
        // Also set industry from response
        if (result.domain_adapter.industry) {
          setSelectedIndustry(result.domain_adapter.industry as IndustryKey);
        }
      }

      // Legacy compat
      if (result?.intent_contract) {
        setIntentContract(result.intent_contract);
      }
    } catch (err) {
      console.error("[StepProjectInfo] Intent contract exception:", err);
    } finally {
      setGeneratingContract(false);
    }
  }, [selectedIndustry]);

  const handleSubmit = () => {
    if (validate()) {
      const effectiveProblemType = formData.problem_type === "auto" 
        ? "classification" 
        : formData.problem_type as "classification" | "regression";
      
      onNext({
        name: formData.name,
        description: formData.description,
        business_objective: formData.declared_objective === "outro" 
          ? formData.business_objective 
          : formData.declared_objective || formData.business_objective,
        problem_type: effectiveProblemType,
      });
    }
  };

  const handleGenerateContract = () => {
    if (!projectData.id) return;
    const objective = formData.declared_objective === "outro" 
      ? formData.business_objective 
      : formData.declared_objective;
    if (!objective) return;
    generateIntentContract(projectData.id, formData);
  };

  const handleRegenerateContract = () => {
    handleGenerateContract();
  };

  const canGenerate = !!(
    (formData.declared_objective || formData.business_objective.trim()) &&
    selectedIndustry &&
    projectData.id
  );

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
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className={errors.name ? "border-destructive" : ""}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
            <p className="text-sm text-muted-foreground">{t("stepInfo.projectNameHint")}</p>
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
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              rows={3}
            />
          </div>

          {/* ═══ Industry Selector (NEW) ═══ */}
          <IndustrySelector
            value={selectedIndustry}
            onChange={setSelectedIndustry}
            error={errors.industry}
          />

          {/* Objetivo declarado (dropdown) */}
          <div className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              Objetivo Preditivo *
            </Label>
            <Select
              value={formData.declared_objective}
              onValueChange={(value) => setFormData({ ...formData, declared_objective: value })}
            >
              <SelectTrigger className={errors.declared_objective ? "border-destructive" : ""}>
                <SelectValue placeholder="Selecione o objetivo do projeto..." />
              </SelectTrigger>
              <SelectContent>
                {OBJECTIVE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.declared_objective && <p className="text-sm text-destructive">{errors.declared_objective}</p>}
          </div>

          {/* Objetivo de negócio (text) */}
          <div className="space-y-2">
            <Label htmlFor="business_objective" className="text-base font-medium flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-secondary" />
              {formData.declared_objective === "outro" 
                ? "Descreva o objetivo em detalhe *" 
                : t("stepInfo.businessObjective")}
            </Label>
            <Textarea
              id="business_objective"
              placeholder={t("stepInfo.businessObjectivePlaceholder")}
              value={formData.business_objective}
              onChange={(e) => setFormData({ ...formData, business_objective: e.target.value })}
              rows={3}
            />
            <p className="text-sm text-muted-foreground">{t("stepInfo.businessObjectiveHint")}</p>
          </div>

          {/* Tipo de problema - Radio Group */}
          <div className="space-y-4">
            <Label className="text-base font-medium flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              {t("stepInfo.problemType")} *
            </Label>
            
            <RadioGroup
              value={formData.problem_type}
              onValueChange={(value) => setFormData({ ...formData, problem_type: value })}
              className="space-y-3"
            >
              <div className={`flex items-start gap-4 p-4 rounded-lg border-2 transition-all cursor-pointer ${
                formData.problem_type === "auto" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
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
                  <p className="text-sm text-muted-foreground mt-1">{t("stepInfo.autoDetectDesc")}</p>
                </div>
              </div>

              <div className={`flex items-start gap-4 p-4 rounded-lg border-2 transition-all cursor-pointer ${
                formData.problem_type === "classification" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
              }`}>
                <RadioGroupItem value="classification" id="classification" className="mt-1" />
                <div className="flex-1">
                  <Label htmlFor="classification" className="font-semibold cursor-pointer">{t("project.classification")}</Label>
                  <p className="text-sm text-muted-foreground mt-1">{t("stepInfo.classificationTip")}</p>
                </div>
              </div>

              <div className={`flex items-start gap-4 p-4 rounded-lg border-2 transition-all cursor-pointer ${
                formData.problem_type === "regression" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
              }`}>
                <RadioGroupItem value="regression" id="regression" className="mt-1" />
                <div className="flex-1">
                  <Label htmlFor="regression" className="font-semibold cursor-pointer">{t("project.regression")}</Label>
                  <p className="text-sm text-muted-foreground mt-1">{t("stepInfo.regressionTip")}</p>
                </div>
              </div>
            </RadioGroup>

            {errors.problem_type && <p className="text-sm text-destructive">{errors.problem_type}</p>}

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

        {/* Gate warnings */}
        {gateWarnings.length > 0 && (
          <div className="space-y-2">
            {gateWarnings.map((w, i) => (
              <Alert key={i} className="bg-amber-500/10 border-amber-500/20">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <AlertDescription className="text-amber-700 dark:text-amber-400 text-sm">
                  {w.message}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        {/* Intent Contract Summary (supports v2 + legacy) */}
        <IntentContractSummary
          contract={intentContract!}
          contractV2={intentContractV2}
          loading={generatingContract}
        />

        {/* Generate / Regenerate contract button */}
        {projectData.id && !generatingContract && (
          <Button 
            variant={intentContractV2 || intentContract ? "outline" : "default"}
            onClick={handleRegenerateContract}
            disabled={!canGenerate}
            className={`w-full ${!(intentContractV2 || intentContract) ? "bg-gradient-primary hover:shadow-hover" : ""}`}
          >
            {intentContractV2 || intentContract ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Regenerar Contrato de Intenção
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Gerar Contrato de Intenção
              </>
            )}
          </Button>
        )}

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
            {loading ? t("common.loading") : t("common.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepProjectInfo;
