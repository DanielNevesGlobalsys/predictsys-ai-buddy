// ═══════════════════════════════════════════════════════════════════
// Catálogo de Estratégias Universais de Target — Linguagem de Negócio
// ═══════════════════════════════════════════════════════════════════

export interface TargetStrategy {
  strategy_id: string;
  label: string;
  description: string;
  when_to_use: string;
  required_signals: ("entity" | "time" | "value" | "status" | "text")[];
  default_params: Record<string, unknown>;
  supported_problem_types: ("classification" | "regression")[];
  mapped_template_ids: string[];
  icon_emoji: string;
  health_disclaimer?: string;
}

export const TARGET_STRATEGIES: Record<string, TargetStrategy> = {
  inactivity_risk: {
    strategy_id: "inactivity_risk",
    label: "Risco por inatividade",
    description:
      "Detecta quem parou de interagir, comprar ou retornar. " +
      "O sistema marca como positivo (1) entidades sem atividade nos últimos N dias.",
    when_to_use:
      "Quando você quer identificar clientes, pacientes ou usuários que pararam de interagir.",
    required_signals: ["entity", "time"],
    default_params: { window_days: 90 },
    supported_problem_types: ["classification"],
    mapped_template_ids: [
      "churn_retail",
      "churn_generic",
      "generic_event_no_activity",
      "adesao_tratamento_health",
    ],
    icon_emoji: "⏳",
  },

  future_event: {
    strategy_id: "future_event",
    label: "Evento futuro na janela",
    description:
      "Prevê se algo vai acontecer nos próximos N dias (ex: compra, falta, cancelamento). " +
      "Precisa de uma coluna de data e de uma coluna que indique o evento.",
    when_to_use:
      "Quando você quer prever se um evento ocorrerá ou não em um período futuro.",
    required_signals: ["entity", "time"],
    default_params: { window_days: 30 },
    supported_problem_types: ["classification"],
    mapped_template_ids: [
      "no_show_health",
      "generic_threshold_binary",
    ],
    icon_emoji: "🔮",
  },

  behavior_change: {
    strategy_id: "behavior_change",
    label: "Mudança de comportamento",
    description:
      "Compara um período recente com um período anterior para detectar mudanças significativas " +
      "(ex: queda nas compras, aumento de reclamações).",
    when_to_use:
      "Quando você quer detectar quem mudou de padrão em relação ao histórico.",
    required_signals: ["entity", "time", "value"],
    default_params: { window_days: 90, baseline_days: 180 },
    supported_problem_types: ["classification"],
    mapped_template_ids: [
      "generic_event_no_activity",
      "churn_generic",
    ],
    icon_emoji: "📉",
  },

  current_status: {
    strategy_id: "current_status",
    label: "Status atual como alvo",
    description:
      "Usa uma coluna existente (flag, status, categoria) como target direto. " +
      "Ideal quando o dataset já tem uma coluna que indica o resultado.",
    when_to_use:
      "Quando seus dados já possuem uma coluna de status, flag ou resultado binário.",
    required_signals: ["status"],
    default_params: {},
    supported_problem_types: ["classification"],
    mapped_template_ids: [
      "generic_threshold_binary",
      "inadimplencia_por_status",
      "no_show_health",
    ],
    icon_emoji: "🏷️",
  },

  future_value: {
    strategy_id: "future_value",
    label: "Valor futuro (previsão)",
    description:
      "Calcula a soma ou média de um valor numérico nos próximos N dias para prever receita, " +
      "volume, gastos ou qualquer métrica contínua.",
    when_to_use:
      "Quando você quer prever um número (receita, ticket médio, volume de vendas).",
    required_signals: ["entity", "time", "value"],
    default_params: { window_days: 90 },
    supported_problem_types: ["regression"],
    mapped_template_ids: [
      "generic_future_sum_regression",
    ],
    icon_emoji: "💰",
  },

  assisted_mode: {
    strategy_id: "assisted_mode",
    label: "Modo assistido",
    description:
      "Quando os dados não têm sinais claros para definir automaticamente o alvo, " +
      "o sistema combina múltiplas regras fracas ou permite que um especialista rotule exemplos.",
    when_to_use:
      "Quando nenhuma das outras estratégias se encaixa ou os sinais do dataset são fracos.",
    required_signals: [],
    default_params: { threshold: 0.6 },
    supported_problem_types: ["classification"],
    mapped_template_ids: [
      "weak_supervision_assisted",
      "human_labeling_assisted",
    ],
    icon_emoji: "🧑‍🏫",
    health_disclaimer:
      "Atenção: Em contextos de saúde, os resultados são para suporte operacional, não para diagnóstico clínico.",
  },
};

export const STRATEGY_LIST = Object.values(TARGET_STRATEGIES);

/**
 * Resolve the best strategy based on available signals.
 * Pure/deterministic — no API calls.
 */
export function resolveStrategyFromSignals(signals: {
  entity_ok: boolean;
  time_ok: boolean;
  value_ok: boolean;
  status_ok: boolean;
  shape: string;
}): TargetStrategy {
  // Priority order based on signal availability
  if (signals.entity_ok && signals.time_ok && signals.value_ok) {
    // Strong signals → behavior change or future value
    return TARGET_STRATEGIES.future_value;
  }
  if (signals.entity_ok && signals.time_ok) {
    return TARGET_STRATEGIES.inactivity_risk;
  }
  if (signals.status_ok) {
    return TARGET_STRATEGIES.current_status;
  }
  if (signals.entity_ok && signals.value_ok) {
    return TARGET_STRATEGIES.future_value;
  }
  if (signals.time_ok) {
    return TARGET_STRATEGIES.future_event;
  }
  return TARGET_STRATEGIES.assisted_mode;
}
