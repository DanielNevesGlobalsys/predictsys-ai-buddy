// ═══════════════════════════════════════════════════════════════════
// Label Templates Registry — Target derivation templates per industry
// ═══════════════════════════════════════════════════════════════════

export interface LabelTemplateParam {
  key: string;
  label: string;
  type: "number" | "string" | "string[]";
  default_value: any;
  description: string;
}

export interface LabelTemplate {
  template_id: string;
  display_name: string;
  problem_type: "classification" | "regression";
  industry: string;
  description: string;
  requires_entity_key: boolean;
  requires_time_anchor: boolean;
  requires_event_column: boolean;
  params: LabelTemplateParam[];
  /** Columns the template needs — checked at preview time */
  required_column_roles: ("entity_key" | "time_anchor" | "event_column" | "value_column")[];
  /** How to interpret the target derivation (for UI display) */
  derivation_summary: string;
}

// ═══ Template Registry ═════════════════════════════════════════

export const LABEL_TEMPLATES: Record<string, LabelTemplate> = {
  churn_retail: {
    template_id: "churn_retail",
    display_name: "Churn de Clientes (Varejo)",
    problem_type: "classification",
    industry: "retail",
    description:
      "Target = 1 se o cliente não realizou compra nos últimos N dias. " +
      "Para dados transacionais, agrupa por entity_key e verifica janela. " +
      "Para dados agregados, usa campos como last_purchase_date ou days_since_last_purchase se existirem.",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    params: [
      {
        key: "window_days",
        label: "Janela (dias)",
        type: "number",
        default_value: 90,
        description: "Clientes sem atividade há mais que N dias são marcados como churn.",
      },
      {
        key: "reference_date_strategy",
        label: "Data de referência",
        type: "string",
        default_value: "max_date",
        description:
          "'max_date' = última data do dataset; 'today' = data atual; " +
          "'multi_period' = gera múltiplos pontos no tempo por entidade (recomendado para treino robusto).",
      },
    ],
    required_column_roles: ["entity_key", "time_anchor"],
    derivation_summary:
      "target = 1 se a última atividade do cliente for anterior a (referência − window_days)",
  },

  no_show_health: {
    template_id: "no_show_health",
    display_name: "No-Show (Falta em Consulta)",
    problem_type: "classification",
    industry: "health",
    description:
      "Target = 1 se o status da consulta indicar falta/no-show. " +
      "Busca coluna de status nas event_candidates do adapter e filtra por valores positivos.",
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: true,
    params: [
      {
        key: "positive_values",
        label: "Valores positivos (no-show)",
        type: "string[]",
        default_value: ["no_show", "missed", "faltou", "No-Show", "ausente"],
        description: "Valores da coluna de status que indicam falta.",
      },
      {
        key: "status_column",
        label: "Coluna de status",
        type: "string",
        default_value: "",
        description: "Coluna que contém o status da consulta. Se vazio, será detectada automaticamente.",
      },
    ],
    required_column_roles: ["entity_key"],
    derivation_summary:
      "target = 1 se coluna de status contiver valor de no-show/falta",
  },

  adesao_tratamento_health: {
    template_id: "adesao_tratamento_health",
    display_name: "Adesão ao Tratamento (Saúde)",
    problem_type: "classification",
    industry: "health",
    description:
      "Target = 1 se o paciente tiver um gap maior que N dias sem consulta/retorno. " +
      "Proxy para abandono de tratamento.",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    params: [
      {
        key: "window_days",
        label: "Gap máximo (dias)",
        type: "number",
        default_value: 60,
        description: "Pacientes com gap de consultas > N dias são marcados como abandono.",
      },
    ],
    required_column_roles: ["entity_key", "time_anchor"],
    derivation_summary:
      "target = 1 se o paciente tiver gap > window_days entre consultas",
  },
};

export function getTemplatesForIndustry(industry: string): LabelTemplate[] {
  return Object.values(LABEL_TEMPLATES).filter(
    (t) => t.industry === industry || t.industry === "generic"
  );
}

export function getTemplate(templateId: string): LabelTemplate | null {
  return LABEL_TEMPLATES[templateId] || null;
}

export function getAllTemplates(): LabelTemplate[] {
  return Object.values(LABEL_TEMPLATES);
}
