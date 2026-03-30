// ═══════════════════════════════════════════════════════════════════
// Intent Contract V3 — Real-world examples
// 4 scenarios: churn, turnover, demand, default_risk
// ═══════════════════════════════════════════════════════════════════

import type { IntentContractV3 } from "./intentContractV3";
import { contractToPREPayload } from "./intentContractV3";

// ─── 1. Churn Retail ───────────────────────────────────────────

export const EXAMPLE_CHURN_RETAIL: IntentContractV3 = {
  contract_version: 3,
  created_at: "2026-03-30T00:00:00Z",
  updated_at: "2026-03-30T00:00:00Z",
  business_context: {
    industry: "retail",
    company_description: "E-commerce de moda com 200k clientes ativos",
    department: "CRM / Retenção",
    business_decision: "Decidir quais clientes receberão campanha de retenção com cupom de desconto",
    cost_of_inaction: "Perda de receita recorrente e aumento de CAC para repor base",
    current_process: "rule_based",
  },
  prediction_request: {
    objective: "churn",
    prediction_nature: "will_it_happen",
    prediction_question: "Qual a probabilidade de cada cliente não realizar nenhuma compra nos próximos 90 dias?",
    entity_granularity: "customer",
    entity_label: "Cliente",
    horizon: { value: 90, unit: "days" },
    action_timing: "preventive",
    intended_action: "Enviar campanha de retenção com cupom personalizado",
  },
  risk_preferences: {
    worse_error: "miss_true_positive",
    false_alarm_tolerance: "aggressive",
    min_confidence_to_act: 0.6,
    optimize_for: "recall",
  },
  data_expectations: {
    expected_data_shape: "multiple_rows_per_entity",
    has_outcome_column: false,
    has_time_column: true,
    time_column_meaning: "Data de cada pedido realizado pelo cliente",
    has_entity_id: true,
    approximate_rows: "100k_1m",
  },
  business_rules: {
    forbidden_features: ["email", "nome", "telefone"],
    known_leakage_columns: ["data_cancelamento", "motivo_cancelamento"],
    min_positive_rate: 0.05,
    max_positive_rate: 0.50,
    custom_rules: ["Considerar apenas clientes com pelo menos 2 compras no histórico"],
  },
  user_confidence: {
    data_quality_confidence: "high",
    target_definition_confidence: "medium",
    ml_experience: "basic",
    prefer_auto_decisions: true,
  },
};

// ─── 2. Turnover (HR) ─────────────────────────────────────────

export const EXAMPLE_TURNOVER_HR: IntentContractV3 = {
  contract_version: 3,
  created_at: "2026-03-30T00:00:00Z",
  updated_at: "2026-03-30T00:00:00Z",
  business_context: {
    industry: "hr",
    company_description: "Empresa de tecnologia com 3.000 colaboradores",
    department: "People Analytics",
    business_decision: "Identificar colaboradores com risco de saída para ações de retenção (1:1, promoção, benefícios)",
    cost_of_inaction: "Custo de reposição de 6-12 meses de salário + perda de conhecimento",
    current_process: "manual",
  },
  prediction_request: {
    objective: "turnover",
    prediction_nature: "will_it_happen",
    prediction_question: "Qual a probabilidade de cada colaborador pedir demissão nos próximos 90 dias?",
    entity_granularity: "employee",
    entity_label: "Colaborador",
    horizon: { value: 90, unit: "days" },
    action_timing: "preventive",
    intended_action: "Reunião 1:1, plano de carreira, ajuste salarial ou benefícios",
  },
  risk_preferences: {
    worse_error: "miss_true_positive",
    false_alarm_tolerance: "balanced",
    min_confidence_to_act: 0.5,
    optimize_for: "recall",
  },
  data_expectations: {
    expected_data_shape: "one_row_per_entity",
    has_outcome_column: true,
    outcome_column_name: "desligado",
    has_time_column: true,
    time_column_meaning: "Data de admissão do colaborador",
    has_entity_id: true,
    approximate_rows: "1k_10k",
  },
  business_rules: {
    forbidden_features: ["nome", "cpf", "email_pessoal"],
    known_leakage_columns: ["data_demissao", "motivo_saida", "tipo_desligamento"],
    exclude_segments: ["estagiarios", "temporarios"],
    custom_rules: ["Excluir colaboradores com menos de 3 meses de empresa"],
  },
  user_confidence: {
    data_quality_confidence: "medium",
    target_definition_confidence: "high",
    ml_experience: "intermediate",
    prefer_auto_decisions: false,
    manual_overrides: ["target_column", "excluded_features"],
  },
};

// ─── 3. Demand Forecast ────────────────────────────────────────

export const EXAMPLE_DEMAND_FORECAST: IntentContractV3 = {
  contract_version: 3,
  created_at: "2026-03-30T00:00:00Z",
  updated_at: "2026-03-30T00:00:00Z",
  business_context: {
    industry: "retail",
    company_description: "Rede de supermercados com 50 lojas",
    department: "Supply Chain / Compras",
    business_decision: "Definir volume de compra para reposição de estoque nas próximas 4 semanas",
    cost_of_inaction: "Ruptura de estoque ou excesso de produtos perecíveis",
    current_process: "rule_based",
  },
  prediction_request: {
    objective: "demand_forecast",
    prediction_nature: "how_much",
    prediction_question: "Qual será o volume de vendas de cada produto por loja nas próximas 4 semanas?",
    entity_granularity: "product",
    entity_label: "Produto (SKU)",
    horizon: { value: 4, unit: "weeks" },
    action_timing: "preventive",
    intended_action: "Gerar pedido de compra automático baseado na previsão",
  },
  risk_preferences: {
    worse_error: "miss_true_positive",
    false_alarm_tolerance: "conservative",
    optimize_for: "cost_reduction",
  },
  data_expectations: {
    expected_data_shape: "time_series",
    has_outcome_column: true,
    outcome_column_name: "quantidade_vendida",
    has_time_column: true,
    time_column_meaning: "Data da venda",
    has_entity_id: true,
    approximate_rows: "over_1m",
  },
  business_rules: {
    forbidden_features: ["preco_custo", "margem"],
    date_range: { start: "2024-01-01" },
    custom_rules: [
      "Ignorar produtos descontinuados",
      "Considerar sazonalidade (Natal, Páscoa, Black Friday)",
    ],
  },
  user_confidence: {
    data_quality_confidence: "high",
    target_definition_confidence: "high",
    ml_experience: "intermediate",
    prefer_auto_decisions: true,
  },
};

// ─── 4. Default Risk (Inadimplência) ───────────────────────────

export const EXAMPLE_DEFAULT_RISK: IntentContractV3 = {
  contract_version: 3,
  created_at: "2026-03-30T00:00:00Z",
  updated_at: "2026-03-30T00:00:00Z",
  business_context: {
    industry: "finance",
    company_description: "Fintech de crédito pessoal com 500k contratos ativos",
    department: "Risco de Crédito",
    business_decision: "Definir limite de crédito e taxa de juros com base no risco individual",
    cost_of_inaction: "Concessão de crédito para inadimplentes ou perda de bons clientes por conservadorismo",
    current_process: "rule_based",
  },
  prediction_request: {
    objective: "default_risk",
    prediction_nature: "will_it_happen",
    prediction_question: "Qual a probabilidade de cada contrato apresentar atraso >30 dias nos próximos 6 meses?",
    entity_granularity: "contract",
    entity_label: "Contrato",
    horizon: { value: 6, unit: "months" },
    action_timing: "preventive",
    intended_action: "Ajustar limite de crédito e pricing baseado no score de risco",
  },
  risk_preferences: {
    worse_error: "miss_true_positive",
    false_alarm_tolerance: "conservative",
    min_confidence_to_act: 0.7,
    acceptable_miss_rate: 0.1,
    optimize_for: "precision",
  },
  data_expectations: {
    expected_data_shape: "one_row_per_entity",
    has_outcome_column: true,
    outcome_column_name: "inadimplente_30d",
    has_time_column: true,
    time_column_meaning: "Data de concessão do crédito",
    has_entity_id: true,
    approximate_rows: "100k_1m",
  },
  business_rules: {
    forbidden_features: ["cpf", "nome", "telefone", "endereco"],
    known_leakage_columns: ["data_default", "valor_recuperado", "status_cobranca"],
    min_positive_rate: 0.03,
    max_positive_rate: 0.30,
    custom_rules: [
      "Excluir contratos com menos de 1 parcela vencida",
      "Não considerar renegociações como evento positivo",
    ],
  },
  user_confidence: {
    data_quality_confidence: "high",
    target_definition_confidence: "high",
    ml_experience: "expert",
    prefer_auto_decisions: false,
    manual_overrides: ["target_column", "threshold", "excluded_features", "date_range"],
  },
};

// ─── PRE Payloads for each example ─────────────────────────────

export const PRE_PAYLOAD_CHURN = contractToPREPayload(EXAMPLE_CHURN_RETAIL);
export const PRE_PAYLOAD_TURNOVER = contractToPREPayload(EXAMPLE_TURNOVER_HR);
export const PRE_PAYLOAD_DEMAND = contractToPREPayload(EXAMPLE_DEMAND_FORECAST);
export const PRE_PAYLOAD_DEFAULT = contractToPREPayload(EXAMPLE_DEFAULT_RISK);
