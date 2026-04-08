// ═══════════════════════════════════════════════════════════════
// Hardcoded Industry × Objective Business Engine (MVP)
// No DB tables — rules live here, contract persisted as JSON
// ═══════════════════════════════════════════════════════════════

export type IndustryKey = 'retail' | 'health' | 'finance' | 'education' | 'logistics' | 'agro' | 'generic';

export type ObjectiveKey =
  | 'churn'
  | 'propensity'
  | 'segmentation'
  | 'demand_forecast'
  | 'anomaly'
  | 'price_optimization'
  | 'generic_prediction';

export type ProblemTypeDefault = 'classification' | 'regression' | 'clustering';

export type TargetMode = 'choose_existing' | 'assisted_build' | 'quick_label' | 'manual';

export interface BusinessIntentContract {
  industry: IndustryKey;
  objective: ObjectiveKey;
  problem_type_default: ProblemTypeDefault;
  target_modes_allowed: TargetMode[];
  target_recommendations: {
    language: 'pt-BR';
    do: string[];
    avoid: string[];
    examples: Array<{ title: string; rule: string }>;
  };
  entity_key_policy: {
    required: boolean;
    recommended_patterns: string[];
    forbid_patterns: string[];
  };
  guardrails: {
    require_min_rows?: number;
    require_min_positive_rate?: number;
    forbid_leakage_patterns?: string[];
  };
  // ── PROMPT 11: new guided UX patterns ──
  recommended_target_patterns: string[];
  blocked_target_patterns: string[];
  state_to_event_candidates: string[];
  time_anchor_candidates: string[];
  entity_key_hint_patterns: string[];
}

interface ObjectiveOption {
  key: ObjectiveKey;
  label_pt: string;
  description_pt: string;
  default_problem_type: ProblemTypeDefault;
}

interface IndustryEntry {
  objectives: ObjectiveOption[];
}

// ─── Matrix ──────────────────────────────────────────────────

export const INDUSTRY_OBJECTIVE_MATRIX: Record<IndustryKey, IndustryEntry> = {
  retail: {
    objectives: [
      { key: 'churn', label_pt: 'Churn / Cancelamento', description_pt: 'Prever quais clientes vão deixar de comprar', default_problem_type: 'classification' },
      { key: 'propensity', label_pt: 'Propensão de compra', description_pt: 'Identificar clientes propensos a comprar um produto', default_problem_type: 'classification' },
      { key: 'demand_forecast', label_pt: 'Previsão de demanda', description_pt: 'Prever volume de vendas futuras', default_problem_type: 'regression' },
      { key: 'segmentation', label_pt: 'Segmentação de clientes', description_pt: 'Agrupar clientes por perfil de comportamento', default_problem_type: 'clustering' },
      { key: 'price_optimization', label_pt: 'Otimização de preço', description_pt: 'Prever preço ideal para maximizar receita', default_problem_type: 'regression' },
      { key: 'generic_prediction', label_pt: 'Outro objetivo', description_pt: 'Objetivo personalizado para o varejo', default_problem_type: 'classification' },
    ],
  },
  health: {
    objectives: [
      { key: 'churn', label_pt: 'Evasão de pacientes', description_pt: 'Prever quais pacientes abandonarão tratamento', default_problem_type: 'classification' },
      { key: 'propensity', label_pt: 'Risco de diagnóstico', description_pt: 'Prever probabilidade de diagnóstico positivo', default_problem_type: 'classification' },
      { key: 'anomaly', label_pt: 'Detecção de anomalias', description_pt: 'Identificar casos atípicos em exames/sinistros', default_problem_type: 'classification' },
      { key: 'demand_forecast', label_pt: 'Previsão de demanda', description_pt: 'Prever volume de atendimentos/internações', default_problem_type: 'regression' },
      { key: 'generic_prediction', label_pt: 'Outro objetivo', description_pt: 'Objetivo personalizado para saúde', default_problem_type: 'classification' },
    ],
  },
  finance: {
    objectives: [
      { key: 'churn', label_pt: 'Churn / Cancelamento', description_pt: 'Prever quais clientes encerrarão conta', default_problem_type: 'classification' },
      { key: 'propensity', label_pt: 'Inadimplência / Default', description_pt: 'Prever probabilidade de inadimplência', default_problem_type: 'classification' },
      { key: 'anomaly', label_pt: 'Detecção de fraude', description_pt: 'Identificar transações suspeitas', default_problem_type: 'classification' },
      { key: 'demand_forecast', label_pt: 'Previsão de receita', description_pt: 'Prever faturamento ou fluxo de caixa', default_problem_type: 'regression' },
      { key: 'segmentation', label_pt: 'Segmentação de clientes', description_pt: 'Agrupar clientes por perfil de risco/valor', default_problem_type: 'clustering' },
      { key: 'generic_prediction', label_pt: 'Outro objetivo', description_pt: 'Objetivo personalizado para finanças', default_problem_type: 'classification' },
    ],
  },
  education: {
    objectives: [
      { key: 'churn', label_pt: 'Evasão escolar', description_pt: 'Prever quais alunos abandonarão o curso', default_problem_type: 'classification' },
      { key: 'propensity', label_pt: 'Propensão de matrícula', description_pt: 'Prever quais leads se matricularão', default_problem_type: 'classification' },
      { key: 'demand_forecast', label_pt: 'Previsão de matrículas', description_pt: 'Prever volume de matrículas futuras', default_problem_type: 'regression' },
      { key: 'segmentation', label_pt: 'Segmentação de alunos', description_pt: 'Agrupar alunos por perfil de engajamento', default_problem_type: 'clustering' },
      { key: 'generic_prediction', label_pt: 'Outro objetivo', description_pt: 'Objetivo personalizado para educação', default_problem_type: 'classification' },
    ],
  },
  logistics: {
    objectives: [
      { key: 'demand_forecast', label_pt: 'Previsão de demanda', description_pt: 'Prever volume de pedidos/entregas', default_problem_type: 'regression' },
      { key: 'anomaly', label_pt: 'Detecção de anomalias', description_pt: 'Identificar atrasos ou falhas atípicas', default_problem_type: 'classification' },
      { key: 'propensity', label_pt: 'Propensão de atraso', description_pt: 'Prever probabilidade de atraso na entrega', default_problem_type: 'classification' },
      { key: 'price_optimization', label_pt: 'Otimização de frete', description_pt: 'Prever custo ideal de frete', default_problem_type: 'regression' },
      { key: 'generic_prediction', label_pt: 'Outro objetivo', description_pt: 'Objetivo personalizado para logística', default_problem_type: 'classification' },
    ],
  },
  agro: {
    objectives: [
      { key: 'demand_forecast', label_pt: 'Previsão de Produção/Captação', description_pt: 'Prever volume de produção, captação ou recebimento futuro', default_problem_type: 'regression' },
      { key: 'propensity', label_pt: 'Risco de Não-Entrega', description_pt: 'Prever quais produtores/lotes têm risco de não cumprir entrega', default_problem_type: 'classification' },
      { key: 'churn', label_pt: 'Evasão de Cooperado', description_pt: 'Prever quais cooperados podem deixar a cooperativa', default_problem_type: 'classification' },
      { key: 'anomaly', label_pt: 'Detecção de Anomalias', description_pt: 'Identificar padrões atípicos em pesagem, qualidade ou movimentação', default_problem_type: 'classification' },
      { key: 'generic_prediction', label_pt: 'Outro objetivo agro', description_pt: 'Objetivo personalizado para o agronegócio', default_problem_type: 'regression' },
    ],
  },
  generic: {
    objectives: [
      { key: 'churn', label_pt: 'Churn / Cancelamento', description_pt: 'Prever quais entidades deixarão de estar ativas', default_problem_type: 'classification' },
      { key: 'propensity', label_pt: 'Propensão / Probabilidade', description_pt: 'Prever probabilidade de um evento', default_problem_type: 'classification' },
      { key: 'demand_forecast', label_pt: 'Previsão numérica', description_pt: 'Prever um valor numérico futuro', default_problem_type: 'regression' },
      { key: 'segmentation', label_pt: 'Segmentação', description_pt: 'Agrupar entidades por similaridade', default_problem_type: 'clustering' },
      { key: 'anomaly', label_pt: 'Detecção de anomalias', description_pt: 'Identificar casos atípicos', default_problem_type: 'classification' },
      { key: 'generic_prediction', label_pt: 'Previsão personalizada', description_pt: 'Configuração livre do objetivo', default_problem_type: 'classification' },
    ],
  },
};

// ─── Target Recommendations per Objective ────────────────────

const TARGET_RECS: Record<ObjectiveKey, BusinessIntentContract['target_recommendations']> = {
  churn: {
    language: 'pt-BR',
    do: [
      'Use uma coluna binária (0/1) indicando se o cliente cancelou',
      'Defina um período claro (ex: cancelou nos últimos 90 dias)',
      'Considere churn por inatividade se não houver flag explícita',
    ],
    avoid: [
      'Não use colunas com status futuro como feature (leakage)',
      'Não misture diferentes definições de churn no mesmo modelo',
    ],
    examples: [
      { title: 'Flag direta', rule: 'coluna "cancelou" = 1 se cancelou, 0 se ativo' },
      { title: 'Por inatividade', rule: 'se última compra > 90 dias → churn = 1' },
    ],
  },
  propensity: {
    language: 'pt-BR',
    do: [
      'Use uma coluna binária indicando se o evento ocorreu',
      'Defina janela temporal clara (ex: comprou nos próximos 30 dias)',
    ],
    avoid: [
      'Não inclua colunas que só existem após o evento (leakage)',
    ],
    examples: [
      { title: 'Conversão', rule: 'coluna "converteu" = 1 se comprou, 0 se não' },
    ],
  },
  segmentation: {
    language: 'pt-BR',
    do: [
      'Selecione features comportamentais (recência, frequência, valor)',
      'Não é necessário target — o modelo agrupará automaticamente',
    ],
    avoid: [
      'Não use colunas de identificação como features (nome, email)',
    ],
    examples: [
      { title: 'RFM', rule: 'Use recência, frequência e valor monetário para segmentar' },
    ],
  },
  demand_forecast: {
    language: 'pt-BR',
    do: [
      'Use uma coluna numérica com o valor a prever (vendas, volume)',
      'Inclua coluna de data para capturar sazonalidade',
    ],
    avoid: [
      'Não inclua dados do período futuro como features',
    ],
    examples: [
      { title: 'Vendas mensais', rule: 'coluna "vendas" com total de vendas por período' },
    ],
  },
  anomaly: {
    language: 'pt-BR',
    do: [
      'Use target binário: 1 = anomalia, 0 = normal',
      'Se não houver labels, use quick_label para gerar',
    ],
    avoid: [
      'Não force rótulos sem revisão — anomalias raras precisam de cuidado',
    ],
    examples: [
      { title: 'Fraude', rule: 'coluna "fraude" = 1 se transação fraudulenta' },
    ],
  },
  price_optimization: {
    language: 'pt-BR',
    do: [
      'Use preço praticado ou receita como target de regressão',
      'Inclua features de custo, demanda e concorrência',
    ],
    avoid: [
      'Não use margem como target se ela depende do preço (circular)',
    ],
    examples: [
      { title: 'Preço ideal', rule: 'coluna "preco_praticado" como target de regressão' },
    ],
  },
  generic_prediction: {
    language: 'pt-BR',
    do: [
      'Escolha a coluna que representa o resultado que deseja prever',
      'Verifique se o tipo de problema (classificação/regressão) está correto',
    ],
    avoid: [
      'Não inclua informações do futuro como features',
    ],
    examples: [
      { title: 'Livre', rule: 'Qualquer coluna pode ser target, dependendo do objetivo' },
    ],
  },
};

// ─── Entity Key Policy per Industry ──────────────────────────

const ENTITY_KEY_POLICIES: Record<IndustryKey, BusinessIntentContract['entity_key_policy']> = {
  retail: { required: true, recommended_patterns: ['id', 'customer_id', 'cpf', 'cnpj', 'client_id'], forbid_patterns: ['name', 'email', 'phone', 'nome', 'telefone'] },
  health: { required: true, recommended_patterns: ['id', 'patient_id', 'cpf', 'matricula', 'prontuario'], forbid_patterns: ['name', 'nome', 'email'] },
  finance: { required: true, recommended_patterns: ['id', 'account_id', 'cpf', 'cnpj', 'contract_id'], forbid_patterns: ['name', 'nome', 'email', 'phone'] },
  education: { required: true, recommended_patterns: ['id', 'student_id', 'matricula', 'ra', 'cpf'], forbid_patterns: ['name', 'nome', 'email'] },
  logistics: { required: true, recommended_patterns: ['id', 'order_id', 'shipment_id', 'tracking'], forbid_patterns: ['name', 'nome', 'address'] },
  agro: { required: true, recommended_patterns: ['produtor', 'cooperado', 'codlot', 'codpes', 'fazenda', 'lote', 'filial', 'codemp'], forbid_patterns: ['nome', 'name', 'email', 'telefone'] },
  generic: { required: true, recommended_patterns: ['id', 'entity_id', 'key', 'cpf', 'cnpj'], forbid_patterns: ['name', 'nome', 'email', 'phone'] },
};

// ─── Guardrails per Objective ────────────────────────────────

const GUARDRAILS: Record<ObjectiveKey, BusinessIntentContract['guardrails']> = {
  churn: { require_min_rows: 200, require_min_positive_rate: 0.01, forbid_leakage_patterns: ['target', 'label', 'status_final', 'resultado', 'cancelou', 'churn_flag'] },
  propensity: { require_min_rows: 200, require_min_positive_rate: 0.01, forbid_leakage_patterns: ['target', 'label', 'converteu', 'resultado'] },
  segmentation: { require_min_rows: 100, forbid_leakage_patterns: ['target', 'label', 'cluster'] },
  demand_forecast: { require_min_rows: 50, forbid_leakage_patterns: ['target', 'label', 'resultado', 'vendas_futuras'] },
  anomaly: { require_min_rows: 100, require_min_positive_rate: 0.001, forbid_leakage_patterns: ['target', 'label', 'fraude', 'anomalia'] },
  price_optimization: { require_min_rows: 100, forbid_leakage_patterns: ['target', 'label', 'margem', 'lucro'] },
  generic_prediction: { require_min_rows: 50, forbid_leakage_patterns: ['target', 'label', 'resultado', 'status_final'] },
};

// ─── Contract Builder ────────────────────────────────────────

export function buildBusinessIntentContract(
  industry: IndustryKey,
  objective: ObjectiveKey
): BusinessIntentContract {
  const entry = INDUSTRY_OBJECTIVE_MATRIX[industry];
  const objDef = entry.objectives.find((o) => o.key === objective);
  const problemType = objDef?.default_problem_type ?? 'classification';

  // Target modes depend on objective
  let targetModes: TargetMode[];
  switch (objective) {
    case 'churn':
    case 'propensity':
    case 'anomaly':
      targetModes = ['choose_existing', 'assisted_build', 'quick_label'];
      break;
    case 'segmentation':
      targetModes = ['choose_existing']; // No target needed for clustering
      break;
    case 'demand_forecast':
    case 'price_optimization':
      targetModes = ['choose_existing', 'assisted_build'];
      break;
    default:
      targetModes = ['choose_existing', 'assisted_build', 'quick_label', 'manual'];
  }

  // ── New guided patterns (PROMPT 11) ──
  const recommended_target_patterns = RECOMMENDED_TARGET_PATTERNS[objective] ?? [];
  const blocked_target_patterns = BLOCKED_TARGET_PATTERNS_MAP[industry] ?? BLOCKED_TARGET_PATTERNS_MAP.generic;
  const state_to_event_candidates = STATE_TO_EVENT_CANDIDATES[objective] ?? [];
  const time_anchor_candidates = TIME_ANCHOR_CANDIDATES[industry] ?? TIME_ANCHOR_CANDIDATES.generic;
  const entity_key_hint_patterns = ENTITY_KEY_HINT_PATTERNS[industry] ?? ENTITY_KEY_HINT_PATTERNS.generic;

  return {
    industry,
    objective,
    problem_type_default: problemType,
    target_modes_allowed: targetModes,
    target_recommendations: TARGET_RECS[objective],
    entity_key_policy: ENTITY_KEY_POLICIES[industry],
    guardrails: GUARDRAILS[objective],
    recommended_target_patterns,
    blocked_target_patterns,
    state_to_event_candidates,
    time_anchor_candidates,
    entity_key_hint_patterns,
  };
}

// ─── Recommended Target Patterns per Objective ───────────────

const RECOMMENDED_TARGET_PATTERNS: Record<ObjectiveKey, string[]> = {
  churn: ['churn', 'cancel', 'evasao', 'inativ', 'abandono'],
  propensity: ['inadimpl', 'default', 'conver', 'comprou', 'pagou'],
  segmentation: [],
  demand_forecast: ['vendas', 'receita', 'volume', 'demanda', 'faturamento'],
  anomaly: ['fraude', 'anomalia', 'suspeita', 'atipic'],
  price_optimization: ['preco', 'price', 'valor_venda', 'ticket'],
  generic_prediction: [],
};

// ─── Blocked Target Patterns (IDs) per Industry ─────────────

const BLOCKED_TARGET_PATTERNS_MAP: Record<IndustryKey, string[]> = {
  retail: ['id', 'uuid', 'hash', 'token', 'codigo', 'contratoid', 'id_contrato', 'id_pedido', 'id_transacao'],
  health: ['id', 'uuid', 'hash', 'token', 'prontuario', 'matricula_id', 'id_paciente'],
  finance: ['id', 'uuid', 'hash', 'token', 'id_conta', 'id_contrato', 'numero_contrato'],
  education: ['id', 'uuid', 'hash', 'token', 'ra', 'matricula_id', 'id_aluno'],
  logistics: ['id', 'uuid', 'hash', 'token', 'tracking', 'id_pedido', 'id_remessa'],
  generic: ['id', 'uuid', 'hash', 'token', 'codigo', 'key', 'index', '_id'],
};

// ─── State-to-Event Candidates per Objective ─────────────────

const STATE_TO_EVENT_CANDIDATES: Record<ObjectiveKey, string[]> = {
  churn: ['status_contrato', 'status', 'situacao', 'fase', 'estado', 'status_cliente'],
  propensity: ['status', 'situacao', 'fase', 'estado_pagamento', 'status_pagamento'],
  segmentation: [],
  demand_forecast: [],
  anomaly: ['status', 'situacao'],
  price_optimization: [],
  generic_prediction: ['status', 'situacao', 'fase', 'estado'],
};

// ─── Time Anchor Candidates per Industry ─────────────────────

const TIME_ANCHOR_CANDIDATES: Record<IndustryKey, string[]> = {
  retail: ['data_cadastro', 'created_at', 'dt_ref', 'data_movimento', 'data_compra', 'data_pedido'],
  health: ['data_cadastro', 'created_at', 'dt_ref', 'data_atendimento', 'data_internacao'],
  finance: ['data_cadastro', 'created_at', 'dt_ref', 'data_abertura', 'data_contrato'],
  education: ['data_matricula', 'created_at', 'dt_ref', 'data_ingresso'],
  logistics: ['data_pedido', 'created_at', 'dt_ref', 'data_embarque', 'data_entrega'],
  generic: ['data_cadastro', 'created_at', 'dt_ref', 'data_movimento', 'date', 'timestamp'],
};

// ─── Entity Key Hint Patterns per Industry ───────────────────

const ENTITY_KEY_HINT_PATTERNS: Record<IndustryKey, string[]> = {
  retail: ['id_cliente', 'cpf', 'cnpj', 'customer_id', 'client_id', 'account_id'],
  health: ['id_paciente', 'cpf', 'prontuario', 'patient_id', 'matricula'],
  finance: ['id_cliente', 'cpf', 'cnpj', 'account_id', 'contract_id', 'contrato'],
  education: ['id_aluno', 'ra', 'cpf', 'matricula', 'student_id'],
  logistics: ['id_pedido', 'order_id', 'shipment_id', 'tracking_id'],
  generic: ['id_cliente', 'cpf', 'cnpj', 'contrato', 'account', 'customer_id', 'entity_id'],
};

// ─── Helpers ─────────────────────────────────────────────────

export function getObjectivesForIndustry(industry: IndustryKey): ObjectiveOption[] {
  return INDUSTRY_OBJECTIVE_MATRIX[industry]?.objectives ?? INDUSTRY_OBJECTIVE_MATRIX.generic.objectives;
}

export function mapDeclaredObjectiveToKey(declared: string): ObjectiveKey {
  const map: Record<string, ObjectiveKey> = {
    churn: 'churn',
    inadimplencia: 'propensity',
    conversao: 'propensity',
    receita: 'demand_forecast',
    logistica: 'demand_forecast',
    saude: 'propensity',
    educacao: 'churn',
    segmentacao: 'segmentation',
    outro: 'generic_prediction',
  };
  return map[declared] ?? 'generic_prediction';
}
