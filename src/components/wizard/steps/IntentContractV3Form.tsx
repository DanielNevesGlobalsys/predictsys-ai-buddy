import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Briefcase,
  Target,
  ShieldAlert,
  Database,
  Gavel,
  UserCheck,
  HelpCircle,
  ChevronDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  IntentContractV3,
  UIFieldSpec,
} from "@/types/intentContractV3";
import { UI_FIELD_SPECS, createEmptyContractV3 } from "@/types/intentContractV3";

// ─── Block metadata ────────────────────────────────────────────
const BLOCKS = [
  {
    key: "business_context",
    label: "Contexto do Negócio",
    icon: Briefcase,
    description: "Setor, decisão e processo atual",
    defaultOpen: true,
  },
  {
    key: "prediction_request",
    label: "Solicitação Preditiva",
    icon: Target,
    description: "O que, quem, quando e como prever",
    defaultOpen: true,
  },
  {
    key: "risk_preferences",
    label: "Preferências de Risco",
    icon: ShieldAlert,
    description: "Erros toleráveis e métricas prioritárias",
    defaultOpen: false,
  },
  {
    key: "data_expectations",
    label: "Expectativas sobre os Dados",
    icon: Database,
    description: "Formato, identificadores e volume",
    defaultOpen: false,
  },
  {
    key: "business_rules",
    label: "Regras de Negócio",
    icon: Gavel,
    description: "Restrições e colunas proibidas",
    defaultOpen: false,
  },
  {
    key: "user_confidence",
    label: "Perfil do Usuário",
    icon: UserCheck,
    description: "Experiência e nível de automação",
    defaultOpen: false,
  },
] as const;

// ─── Props ─────────────────────────────────────────────────────
interface IntentContractV3FormProps {
  contract: IntentContractV3;
  onChange: (updated: IntentContractV3) => void;
  disabled?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────

/** Get a nested value from the contract by dot-path */
function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

/** Set a nested value in the contract by dot-path, returning a new object */
function setNestedValue(obj: any, path: string, value: any): any {
  const keys = path.split(".");
  const clone = structuredClone(obj);
  let current = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
  return clone;
}

/** Check if a field's dependency is satisfied */
function isDependencySatisfied(contract: IntentContractV3, spec: UIFieldSpec): boolean {
  if (!spec.depends_on) return true;
  const [depPath, depValue] = spec.depends_on.split("=");
  const currentValue = getNestedValue(contract, depPath);
  return String(currentValue) === depValue;
}

// ─── Field Renderer ────────────────────────────────────────────

function FieldRenderer({
  spec,
  value,
  onChange,
  disabled,
}: {
  spec: UIFieldSpec;
  value: any;
  onChange: (val: any) => void;
  disabled?: boolean;
}) {
  const fieldId = spec.field_path.replace(/\./g, "-");

  const labelEl = (
    <div className="flex items-center gap-2 mb-1.5">
      <Label htmlFor={fieldId} className="text-sm font-medium">
        {spec.label_pt}
        {spec.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {spec.description_pt && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px] text-xs">
              {spec.description_pt}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );

  switch (spec.ui_type) {
    case "dropdown":
      return (
        <div className="space-y-1">
          {labelEl}
          <Select
            value={String(value ?? spec.default_value ?? "")}
            onValueChange={onChange}
            disabled={disabled}
          >
            <SelectTrigger id={fieldId} className="w-full">
              <SelectValue placeholder="Selecione..." />
            </SelectTrigger>
            <SelectContent>
              {spec.options?.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span>{opt.label_pt}</span>
                  {opt.description_pt && (
                    <span className="text-muted-foreground text-xs ml-1.5">
                      — {opt.description_pt}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );

    case "radio":
      return (
        <div className="space-y-1">
          {labelEl}
          <RadioGroup
            value={String(value ?? spec.default_value ?? "")}
            onValueChange={onChange}
            disabled={disabled}
            className="grid gap-2"
          >
            {spec.options?.map((opt) => (
              <div
                key={opt.value}
                className={`flex items-start gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                  String(value) === opt.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <RadioGroupItem value={opt.value} id={`${fieldId}-${opt.value}`} className="mt-0.5" />
                <div className="flex-1">
                  <Label htmlFor={`${fieldId}-${opt.value}`} className="text-sm font-medium cursor-pointer">
                    {opt.label_pt}
                  </Label>
                  {opt.description_pt && (
                    <p className="text-xs text-muted-foreground mt-0.5">{opt.description_pt}</p>
                  )}
                </div>
              </div>
            ))}
          </RadioGroup>
        </div>
      );

    case "textarea":
      return (
        <div className="space-y-1">
          {labelEl}
          <Textarea
            id={fieldId}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            rows={2}
            disabled={disabled}
            placeholder={spec.description_pt}
            className="resize-none"
          />
        </div>
      );

    case "text":
      return (
        <div className="space-y-1">
          {labelEl}
          <Input
            id={fieldId}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={spec.description_pt}
          />
        </div>
      );

    case "number":
      return (
        <div className="space-y-1">
          {labelEl}
          <Input
            id={fieldId}
            type="number"
            min={1}
            value={value ?? spec.default_value ?? 30}
            onChange={(e) => onChange(Number(e.target.value) || spec.default_value || 30)}
            disabled={disabled}
          />
        </div>
      );

    case "toggle":
      return (
        <div className="flex items-center justify-between gap-3 py-2">
          <div>
            <Label htmlFor={fieldId} className="text-sm font-medium cursor-pointer">
              {spec.label_pt}
            </Label>
            {spec.description_pt && (
              <p className="text-xs text-muted-foreground mt-0.5">{spec.description_pt}</p>
            )}
          </div>
          <Switch
            id={fieldId}
            checked={value ?? spec.default_value ?? false}
            onCheckedChange={onChange}
            disabled={disabled}
          />
        </div>
      );

    case "multi_select":
      // Render as textarea with comma-separated for now (columns not yet known)
      return (
        <div className="space-y-1">
          {labelEl}
          <Textarea
            id={fieldId}
            value={Array.isArray(value) ? value.join(", ") : value ?? ""}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            }
            rows={2}
            disabled={disabled}
            placeholder="Separe com vírgulas (ex: coluna1, coluna2)"
            className="resize-none"
          />
        </div>
      );

    default:
      return null;
  }
}

// ─── Main Form ─────────────────────────────────────────────────

export default function IntentContractV3Form({
  contract,
  onChange,
  disabled,
}: IntentContractV3FormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fieldsByGroup = useMemo(() => {
    const map: Record<string, UIFieldSpec[]> = {};
    for (const spec of UI_FIELD_SPECS) {
      if (!map[spec.group]) map[spec.group] = [];
      map[spec.group].push(spec);
    }
    return map;
  }, []);

  const handleFieldChange = useCallback(
    (fieldPath: string, value: any) => {
      const updated = setNestedValue(contract, fieldPath, value);
      updated.updated_at = new Date().toISOString();
      onChange(updated);
    },
    [contract, onChange]
  );

  // Default open sections
  const defaultOpen = BLOCKS.filter((b) => b.defaultOpen).map((b) => b.key);

  return (
    <div className="space-y-4">
      {/* Toggle for advanced sections */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Preencha o contrato de intenção para guiar o pipeline preditivo
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor="show-advanced" className="text-xs text-muted-foreground cursor-pointer">
            Mostrar campos avançados
          </Label>
          <Switch
            id="show-advanced"
            checked={showAdvanced}
            onCheckedChange={setShowAdvanced}
          />
        </div>
      </div>

      <Accordion type="multiple" defaultValue={defaultOpen} className="space-y-3">
        {BLOCKS.map((block) => {
          const fields = fieldsByGroup[block.key] || [];
          const visibleFields = fields.filter((f) => {
            if (!isDependencySatisfied(contract, f)) return false;
            if (!showAdvanced && !f.visible_by_default) return false;
            return true;
          });

          if (visibleFields.length === 0 && !showAdvanced) return null;

          const Icon = block.icon;
          const filledCount = visibleFields.filter((f) => {
            const v = getNestedValue(contract, f.field_path);
            return v !== undefined && v !== "" && v !== null;
          }).length;

          return (
            <AccordionItem
              key={block.key}
              value={block.key}
              className="border rounded-lg px-4 bg-card"
            >
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-3 text-left">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <span className="text-sm font-semibold">{block.label}</span>
                    <p className="text-xs text-muted-foreground">{block.description}</p>
                  </div>
                  <Badge variant="secondary" className="ml-auto mr-2 text-[10px]">
                    {filledCount}/{visibleFields.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="grid gap-4 pt-2">
                  {visibleFields.map((spec) => (
                    <FieldRenderer
                      key={spec.field_path}
                      spec={spec}
                      value={getNestedValue(contract, spec.field_path)}
                      onChange={(val) => handleFieldChange(spec.field_path, val)}
                      disabled={disabled}
                    />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
