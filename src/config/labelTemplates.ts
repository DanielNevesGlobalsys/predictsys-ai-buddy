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

  churn_generic: {
    template_id: "churn_generic",
    display_name: "Churn de Clientes (Genérico)",
    problem_type: "classification",
    industry: "generic",
    description:
      "Target = 1 se o cliente não realizou atividade nos últimos N dias. " +
      "Funciona com qualquer dataset que tenha identificador de entidade e coluna temporal. " +
      "Para dados já agregados, detecta colunas como last_activity_date ou days_since_last_purchase.",
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
          "'multi_period' = gera múltiplos pontos no tempo por entidade.",
      },
    ],
    required_column_roles: ["entity_key", "time_anchor"],
    derivation_summary:
      "target = 1 se a última atividade do cliente for anterior a (referência − window_days)",
  },

  // ═══ Universal Templates ═════════════════════════════════════

  generic_event_no_activity: {
    template_id: "generic_event_no_activity",
    display_name: "Inatividade (Universal)",
    problem_type: "classification",
    industry: "generic",
    description:
      "Target = 1 se a entidade não realizou nenhuma atividade nos últimos N dias. " +
      "Detecta automaticamente colunas como last_activity_date, last_purchase_date, last_event_date. " +
      "Para dados transacionais, usa max(time_anchor) por entidade.",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    params: [
      {
        key: "window_days",
        label: "Janela de inatividade (dias)",
        type: "number",
        default_value: 90,
        description: "Entidades sem atividade há mais que N dias são marcadas como inativas.",
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
      "target = 1 se última atividade da entidade < (referência − window_days)",
  },

  generic_threshold_binary: {
    template_id: "generic_threshold_binary",
    display_name: "Limiar Binário (Universal)",
    problem_type: "classification",
    industry: "generic",
    description:
      "Target = 1 se o valor de uma coluna numérica atingir o limiar definido. " +
      "Útil para inadimplência por atraso em dias, score acima de limiar, etc. " +
      "Usa contract_hints.value_candidates para sugerir a coluna.",
    requires_entity_key: false,
    requires_time_anchor: false,
    requires_event_column: false,
    params: [
      {
        key: "threshold_value",
        label: "Limiar",
        type: "number",
        default_value: 30,
        description: "Linhas com valor >= limiar são marcadas como positivas (1).",
      },
      {
        key: "value_column",
        label: "Coluna de valor",
        type: "string",
        default_value: "",
        description: "Coluna numérica para aplicar o limiar. Se vazio, será detectada automaticamente.",
      },
    ],
    required_column_roles: [],
    derivation_summary:
      "target = 1 se value_column >= threshold_value",
  },

  generic_future_sum_regression: {
    template_id: "generic_future_sum_regression",
    display_name: "Soma Futura (Regressão Universal)",
    problem_type: "regression",
    industry: "generic",
    description:
      "Target = soma da coluna de valor no intervalo (t, t + window_days]. " +
      "Ideal para prever receita futura, volume de vendas ou custo acumulado.",
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    params: [
      {
        key: "window_days",
        label: "Janela futura (dias)",
        type: "number",
        default_value: 90,
        description: "Soma do valor nos próximos N dias a partir do ponto de referência.",
      },
      {
        key: "value_column",
        label: "Coluna de valor",
        type: "string",
        default_value: "",
        description: "Coluna numérica a ser somada. Se vazio, será detectada via value_candidates.",
      },
    ],
    required_column_roles: ["entity_key", "time_anchor", "value_column"],
    derivation_summary:
      "target = soma(value_column) no intervalo (t, t + window_days]",
  },

  // ═══ Finance Templates ═══════════════════════════════════════

  inadimplencia_por_atraso: {
    template_id: "inadimplencia_por_atraso",
    display_name: "Inadimplência por Atraso (Finanças)",
    problem_type: "classification",
    industry: "finance",
    description:
      "Target = 1 se paid_date é nulo OU (paid_date - due_date) > N dias. " +
      "Detecta automaticamente colunas de vencimento e pagamento. " +
      "Se paid_date não existir, tenta detectar status textual como fallback.",
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: false,
    params: [
      {
        key: "atraso_dias",
        label: "Dias de atraso",
        type: "number",
        default_value: 30,
        description: "Parcelas com atraso > N dias (ou sem pagamento) são marcadas como inadimplentes.",
      },
    ],
    required_column_roles: ["entity_key"],
    derivation_summary:
      "target = 1 se paid_date é nulo OU (paid_date - due_date) > atraso_dias",
  },

  inadimplencia_por_status: {
    template_id: "inadimplencia_por_status",
    display_name: "Inadimplência por Status (Finanças)",
    problem_type: "classification",
    industry: "finance",
    description:
      "Target = 1 se a coluna de status indicar inadimplência. " +
      "Busca coluna de status nas event_candidates do adapter e filtra por valores negativos.",
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: true,
    params: [
      {
        key: "negative_statuses",
        label: "Status negativos (inadimplente)",
        type: "string[]",
        default_value: ["em_aberto", "atrasado", "inadimplente", "defaulted", "atraso", "vencido"],
        description: "Valores da coluna de status que indicam inadimplência.",
      },
      {
        key: "positive_statuses",
        label: "Status positivos (adimplente)",
        type: "string[]",
        default_value: ["pago", "quitado", "paid", "em_dia", "regular"],
        description: "Valores que indicam adimplência (para referência).",
      },
      {
        key: "status_column",
        label: "Coluna de status",
        type: "string",
        default_value: "",
        description: "Coluna que contém o status. Se vazio, será detectada automaticamente.",
      },
    ],
    required_column_roles: ["entity_key"],
    derivation_summary:
      "target = 1 se coluna de status contiver valor de inadimplência",
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
