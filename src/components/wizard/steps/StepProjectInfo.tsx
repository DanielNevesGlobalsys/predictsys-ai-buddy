import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileText, Sparkles, Info, AlertTriangle, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useProjectAIContext, type AIContextIntent } from "@/hooks/useProjectAIContext";
import { useToast } from "@/hooks/use-toast";
import IntentContractSummary from "./IntentContractSummary";
import IntentContractV3Form from "./IntentContractV3Form";
import type { ProjectData } from "../WizardContainer";
import type { IndustryKey, IntentContractV2 } from "@/types/intentContract";
import { normalizeIntentContract, validateIntentGates } from "@/types/intentContract";
import { hasAdapter } from "@/config/domainAdapters";
import {
  type ObjectiveKey,
  buildBusinessIntentContract,
  mapDeclaredObjectiveToKey,
} from "@/lib/industryRules";
import { trackEvent } from "@/lib/platformTracking";
import type { IntentContractV3, IndustryKeyV3, ObjectiveArchetype } from "@/types/intentContractV3";
import { createEmptyContractV3, normalizeToV3, contractToPREPayload } from "@/types/intentContractV3";

interface StepProjectInfoProps {
  projectData: ProjectData;
  onNext: (data: Partial<ProjectData>) => void;
  onCancel: () => void;
  loading: boolean;
}

// ─── Map V3 objective → legacy problem_type ──────────────────
function resolveV3ProblemType(contract: IntentContractV3): "classification" | "regression" {
  const nature = contract.prediction_request.prediction_nature;
  if (nature === "how_much" || nature === "when") return "regression";
  return "classification";
}

// ─── Map V3 industry → legacy IndustryKey ────────────────────
const V3_TO_LEGACY_INDUSTRY: Record<string, string> = {
  retail: "retail",
  health: "health",
  finance: "finance",
  education: "education",
  logistics: "logistics",
  agro: "agro",
  hr: "hr",
  insurance: "insurance",
  telecom: "telecom",
  generic: "generic",
};

const StepProjectInfo = ({ projectData, onNext, onCancel, loading }: StepProjectInfoProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { loadContext } = useProjectAIContext(projectData.id);

  // ─── Basic project fields ────────────────────────────────────
  const [projectName, setProjectName] = useState(projectData.name);
  const [projectDescription, setProjectDescription] = useState(projectData.description);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ─── V3 Contract state ───────────────────────────────────────
  const [contractV3, setContractV3] = useState<IntentContractV3>(
    createEmptyContractV3()
  );

  // ─── Legacy contract state (for summary display) ────────────
  const [intentContract, setIntentContract] = useState<AIContextIntent | null>(null);
  const [intentContractV2, setIntentContractV2] = useState<IntentContractV2 | null>(null);
  const [generatingContract, setGeneratingContract] = useState(false);
  const [contractMeta, setContractMeta] = useState<{ id: string | null; version: number; generatedAt: string | null }>({
    id: null, version: 0, generatedAt: null,
  });
  const [gateWarnings, setGateWarnings] = useState<{ status: string; code: string; message: string; cta?: string }[]>([]);

  // ─── Load existing state on mount ────────────────────────────
  useEffect(() => {
    if (!projectData.id) return;

    // Load from project_settings SSOT
    supabase
      .from("project_settings")
      .select("industry, industry_source, segment, objective, custom_objective_text, active_intent_contract_id, contract_version, contract_generated_at, intent_contract_v3")
      .eq("project_id", projectData.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        const ps = data as any;

        // Restore V3 contract if saved
        if (ps.intent_contract_v3) {
          const restored = normalizeToV3(ps.intent_contract_v3);
          if (restored) setContractV3(restored);
        } else if (ps.industry || ps.objective) {
          // Bootstrap V3 from legacy fields
          const ind = (ps.industry || "generic") as IndustryKeyV3;
          const obj = mapLegacyObjective(ps.objective);
          const fresh = createEmptyContractV3(ind, obj);
          if (ps.custom_objective_text) {
            fresh.prediction_request.custom_objective_text = ps.custom_objective_text;
            fresh.prediction_request.prediction_question = ps.custom_objective_text;
          }
          setContractV3(fresh);
        }

        if (ps.active_intent_contract_id || ps.contract_version) {
          setContractMeta({
            id: ps.active_intent_contract_id,
            version: ps.contract_version || 0,
            generatedAt: ps.contract_generated_at || null,
          });
        }
      });

    // Load AI context for legacy summary
    loadContext().then((ctx) => {
      if (!ctx) return;
      const anyCtx = ctx as any;
      if (anyCtx.intent_contract) {
        const normalized = normalizeIntentContract(anyCtx.intent_contract);
        if (normalized) {
          setIntentContractV2(normalized);
          // Also seed V3 from V2 if no V3 exists yet
          setContractV3((prev) => {
            if (prev.business_context.business_decision) return prev;
            const migrated = normalizeToV3(anyCtx.intent_contract);
            return migrated || prev;
          });
        }
      }
      if (anyCtx.intent?.declared_objective) {
        setIntentContract(anyCtx.intent);
      }
    });
  }, [projectData.id]);

  // ─── Validation ──────────────────────────────────────────────
  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!projectName.trim()) {
      newErrors.name = t("stepInfo.errors.nameRequired");
    }

    const c = contractV3;
    if (!c.prediction_request.objective || c.prediction_request.objective === "custom") {
      if (!c.prediction_request.custom_objective_text?.trim() && !c.prediction_request.prediction_question?.trim()) {
        newErrors.objective = "Selecione ou descreva o objetivo preditivo";
      }
    }

    // Gate validations
    const industry = c.business_context.industry;
    const objective = c.prediction_request.objective === "custom"
      ? c.prediction_request.custom_objective_text || ""
      : c.prediction_request.objective;

    const legacyIndustry = V3_TO_LEGACY_INDUSTRY[industry] as IndustryKey | undefined;
    const gates = validateIntentGates(
      legacyIndustry && legacyIndustry !== "generic" ? legacyIndustry : undefined,
      objective,
      legacyIndustry ? hasAdapter(legacyIndustry) : false
    );
    const blocks = gates.filter((g) => g.status === "BLOCK");
    if (blocks.length > 0) {
      blocks.forEach((b) => {
        if (b.code === "OBJECTIVE_EMPTY") newErrors.objective = b.message;
        if (b.code === "INDUSTRY_NOT_SELECTED") newErrors.industry = b.message;
      });
    }
    setGateWarnings(gates.filter((g) => g.status === "WARN"));
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // ─── Generate intent contract via edge function ──────────────
  const generateIntentContract = useCallback(async () => {
    if (!projectData.id) return;
    setGeneratingContract(true);
    try {
      const c = contractV3;
      const objective = c.prediction_request.objective === "custom"
        ? c.prediction_request.custom_objective_text || c.prediction_request.prediction_question
        : c.prediction_request.objective;

      const { data: result, error } = await supabase.functions.invoke("generate-intent-contract", {
        body: {
          project_id: projectData.id,
          project_name: projectName,
          project_description: projectDescription,
          declared_objective: objective,
          custom_objective_text: c.prediction_request.custom_objective_text,
          industry: c.business_context.industry !== "generic" ? c.business_context.industry : undefined,
        },
      });

      if (error) {
        console.error("[StepProjectInfo] Intent contract error:", error);
        return;
      }

      if (result?.intent_base && result?.domain_adapter) {
        setIntentContractV2({
          intent_base: result.intent_base,
          domain_adapter: result.domain_adapter,
          contract_version: result.contract_version,
          created_at: result.created_at,
        });
      }
      if (result?.contract_id || result?.contract_version) {
        setContractMeta({
          id: result.contract_id || null,
          version: result.contract_version || 0,
          generatedAt: result.created_at || new Date().toISOString(),
        });
      }
      if (result?.intent_contract) {
        setIntentContract(result.intent_contract);
      }
    } catch (err) {
      console.error("[StepProjectInfo] Intent contract exception:", err);
    } finally {
      setGeneratingContract(false);
    }
  }, [projectData.id, projectName, projectDescription, contractV3]);

  // ─── Submit ──────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!validate()) return;

    const c = contractV3;
    const industryKey = (V3_TO_LEGACY_INDUSTRY[c.business_context.industry] || "generic") as any;
    const rawObjectiveKey = c.prediction_request.objective === "custom"
      ? "outro"
      : mapDeclaredObjectiveToKey(c.prediction_request.objective);
    const objectiveKey = rawObjectiveKey as ObjectiveKey;
    const businessContract = buildBusinessIntentContract(industryKey, objectiveKey);
    const problemType = resolveV3ProblemType(c);

    const customText = c.prediction_request.objective === "custom"
      ? c.prediction_request.custom_objective_text?.trim() || c.prediction_request.prediction_question || null
      : null;

    // Persist V3 contract + legacy fields
    if (projectData.id) {
      try {
        const { error } = await supabase
          .from("project_settings")
          .upsert(
            {
              project_id: projectData.id,
              industry: industryKey !== "generic" ? industryKey : null,
              industry_source: "user",
              objective: objectiveKey,
              custom_objective_text: customText,
              business_intent_contract: businessContract as any,
              intent_contract_v3: c as any,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id" }
          );

        if (error) {
          console.error("[StepProjectInfo] save failed:", error);
          toast({
            title: "Erro ao salvar contrato",
            description: error.message,
            variant: "destructive",
          });
          return;
        }

        trackEvent({
          event_type: "project_created",
          project_id: projectData.id,
          metadata: {
            sub_event: "intent_contract_v3_saved",
            industry: industryKey,
            objective: objectiveKey,
            problem_type: problemType,
            contract_version: 3,
          },
        });
      } catch (err: any) {
        console.error("[StepProjectInfo] save error:", err);
        toast({
          title: "Erro inesperado",
          description: err?.message || "Erro ao salvar contrato",
          variant: "destructive",
        });
        return;
      }
    }

    const effectiveObjective = c.prediction_request.objective === "custom"
      ? customText || ""
      : c.prediction_request.objective;

    onNext({
      name: projectName,
      description: projectDescription,
      business_objective: effectiveObjective || "",
      problem_type: problemType,
    });
  };

  const canGenerate = !!(
    (contractV3.prediction_request.objective || contractV3.prediction_request.prediction_question) &&
    contractV3.business_context.industry &&
    projectData.id
  );

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FileText className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("stepInfo.title")}
          </h2>
          <p className="text-muted-foreground">
            Defina seu projeto e configure o contrato de intenção preditiva
          </p>
        </div>

        {/* ═══ Project basics ═══ */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-base font-medium">
              {t("stepInfo.projectName")} *
            </Label>
            <Input
              id="name"
              placeholder={t("stepInfo.projectNamePlaceholder")}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              className={errors.name ? "border-destructive" : ""}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
            <p className="text-sm text-muted-foreground">{t("stepInfo.projectNameHint")}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-base font-medium">
              {t("stepInfo.description")}
            </Label>
            <Textarea
              id="description"
              placeholder={t("stepInfo.descriptionPlaceholder")}
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        {/* ═══ V3 Intent Contract Form ═══ */}
        <div className="border-t border-border pt-6">
          <IntentContractV3Form
            contract={contractV3}
            onChange={setContractV3}
            disabled={loading}
          />
          {errors.objective && (
            <p className="text-sm text-destructive mt-2">{errors.objective}</p>
          )}
          {errors.industry && (
            <p className="text-sm text-destructive mt-1">{errors.industry}</p>
          )}
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

        {/* Contract status badge */}
        {contractMeta.id && contractMeta.generatedAt && (
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/20 text-accent-foreground border border-accent/30">
              <Sparkles className="w-3.5 h-3.5" />
              Contrato ativo v{contractMeta.version}
              <span className="text-muted-foreground ml-1">
                — {new Date(contractMeta.generatedAt).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </span>
            </span>
          </div>
        )}

        {/* Legacy contract summary */}
        <IntentContractSummary
          contract={intentContract!}
          contractV2={intentContractV2}
          loading={generatingContract}
        />

        {/* Generate / Regenerate contract */}
        {projectData.id && !generatingContract && (
          <Button
            variant={intentContractV2 || intentContract ? "outline" : "default"}
            onClick={generateIntentContract}
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

// ─── Helpers ───────────────────────────────────────────────────

function mapLegacyObjective(obj: string | null): ObjectiveArchetype {
  if (!obj) return "custom";
  const map: Record<string, ObjectiveArchetype> = {
    churn: "churn",
    inadimplencia: "default_risk",
    conversao: "propensity",
    receita: "lifetime_value",
    logistica: "demand_forecast",
    saude: "custom",
    educacao: "churn",
    segmentacao: "segmentation",
    outro: "custom",
  };
  return map[obj] || "custom";
}

export default StepProjectInfo;
