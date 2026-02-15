import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Target, Clock, Shield, BarChart3, Brain, 
  Layers, CheckCircle2, AlertTriangle, Loader2 
} from "lucide-react";
import type { AIContextIntent } from "@/hooks/useProjectAIContext";
import type { IntentContractV2 } from "@/types/intentContract";
import { normalizeIntentContract, INDUSTRY_DISPLAY_NAMES } from "@/types/intentContract";
import DomainAdapterBadge from "./DomainAdapterBadge";

interface IntentContractSummaryProps {
  contract: AIContextIntent;
  contractV2?: IntentContractV2 | null;
  loading?: boolean;
}

const PROBLEM_LABELS: Record<string, string> = {
  classification: "Classificação",
  regression: "Regressão",
  timeseries: "Séries Temporais",
  segmentation: "Segmentação",
};

const TARGET_LABELS: Record<string, string> = {
  event: "Evento (sim/não)",
  value: "Valor numérico",
  state_to_event: "Transição de estado",
};

const IntentContractSummary = ({ contract, contractV2, loading }: IntentContractSummaryProps) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <Card className="bg-gradient-card shadow-card p-6 mt-6">
        <div className="flex items-center gap-3 justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <span className="text-muted-foreground">Analisando objetivo e gerando contrato de intenção...</span>
        </div>
      </Card>
    );
  }

  // Normalize: try v2, fall back to legacy
  const normalized = contractV2 || normalizeIntentContract(contract);
  if (!normalized) return null;

  const { intent_base, domain_adapter, contract_version } = normalized;
  if (!intent_base.declared_objective) return null;

  return (
    <Card className="bg-gradient-card shadow-card p-6 mt-6 border-primary/20">
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
            <Brain className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-base">O que entendemos do seu objetivo</h3>
            <p className="text-xs text-muted-foreground">Contrato de Intenção v{contract_version}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <DomainAdapterBadge adapter={domain_adapter} />
            <Badge variant="outline" className="text-xs">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Gerado
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Objetivo */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Target className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-medium text-muted-foreground">Objetivo</span>
            </div>
            <p className="text-sm font-medium capitalize">{intent_base.declared_objective}</p>
          </div>

          {/* Tipo de Problema */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 className="w-3.5 h-3.5 text-secondary" />
              <span className="text-xs font-medium text-muted-foreground">Tipo de Problema</span>
            </div>
            <p className="text-sm font-medium">{PROBLEM_LABELS[intent_base.problem_type] || intent_base.problem_type}</p>
          </div>

          {/* Indústria / Adapter */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Layers className="w-3.5 h-3.5 text-accent-foreground" />
              <span className="text-xs font-medium text-muted-foreground">Segmento</span>
            </div>
            <p className="text-sm font-medium">
              {INDUSTRY_DISPLAY_NAMES[domain_adapter.industry as keyof typeof INDUSTRY_DISPLAY_NAMES] || domain_adapter.display_name}
            </p>
          </div>

          {/* O que será previsto */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Target className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-medium text-muted-foreground">Tipo de Target</span>
            </div>
            <p className="text-sm font-medium">{TARGET_LABELS[intent_base.target_expected] || intent_base.target_expected}</p>
          </div>

          {/* Janela Temporal */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-3.5 h-3.5 text-secondary" />
              <span className="text-xs font-medium text-muted-foreground">Janela Padrão</span>
            </div>
            <p className="text-sm font-medium">
              {intent_base.default_window_days} dias
              {intent_base.requires_time_column && (
                <span className="text-xs text-muted-foreground ml-1">(requer coluna temporal)</span>
              )}
            </p>
          </div>

          {/* Guardrails */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Shield className="w-3.5 h-3.5 text-green-500" />
              <span className="text-xs font-medium text-muted-foreground">Guardrails</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {intent_base.guardrails.block_id_targets && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Anti-ID</Badge>}
              {intent_base.guardrails.block_leakage && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Anti-Leak</Badge>}
              {intent_base.guardrails.block_constant_target && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Anti-Const</Badge>}
            </div>
          </div>
        </div>

        {/* Métricas recomendadas */}
        {intent_base.recommended_metrics.length > 0 && (
          <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
            <span className="text-xs font-medium text-muted-foreground">Métricas recomendadas: </span>
            <span className="text-sm">
              {intent_base.recommended_metrics.map(m => m.toUpperCase()).join(", ")}
            </span>
          </div>
        )}

        {/* Templates recomendados do adapter */}
        {domain_adapter.recommended_templates.length > 0 && (
          <div className="p-3 rounded-lg bg-accent/5 border border-accent/10">
            <span className="text-xs font-medium text-muted-foreground block mb-1.5">Templates recomendados ({domain_adapter.display_name}):</span>
            <div className="flex flex-wrap gap-1.5">
              {domain_adapter.recommended_templates.map(tmpl => (
                <Badge key={tmpl.template_id} variant="outline" className="text-xs">
                  {tmpl.display_name}
                  <span className="ml-1 text-muted-foreground">({PROBLEM_LABELS[tmpl.problem_type] || tmpl.problem_type})</span>
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Leakage watchlist */}
        {domain_adapter.leakage_watchlist.length > 0 && (
          <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
            <span className="text-xs font-medium text-muted-foreground">Colunas de leakage monitoradas: </span>
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {domain_adapter.leakage_watchlist.join(", ")}
            </span>
          </div>
        )}

        {intent_base.label_builder_required && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Este objetivo requer construção do label (variável alvo) a partir dos dados. O sistema irá guiar esse processo nas próximas etapas.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
};

export default IntentContractSummary;
