// ═══════════════════════════════════════════════════════════════════
// Industry-Contextual Options Catalog
// Provides dynamic options for V3 wizard fields based on industry
// ═══════════════════════════════════════════════════════════════════

import type { IndustryKeyV3 } from "@/types/intentContractV3";

export interface ContextualOption {
  value: string;
  label_pt: string;
  description_pt?: string;
  /** Hint for problem_type resolution */
  problem_type_hint?: "classification" | "regression";
  /** Hint for prediction_nature */
  nature_hint?: "will_it_happen" | "how_much" | "when" | "who_is_similar";
}

// ─── OBJECTIVE OPTIONS BY INDUSTRY ──────────────────────────────

const AGRO_OBJECTIVES: ContextualOption[] = [
  { value: "demand_forecast", label_pt: "Previsão de produção", description_pt: "Quanto será produzido em sacas, toneladas ou volume", problem_type_hint: "regression", nature_hint: "how_much" },
  { value: "agro_captacao", label_pt: "Previsão de captação", description_pt: "Volume a ser captado/recebido de produtores", problem_type_hint: "regression", nature_hint: "how_much" },
  { value: "agro_produtividade", label_pt: "Previsão de produtividade", description_pt: "Rendimento por área, talhão ou lote", problem_type_hint: "regression", nature_hint: "how_much" },
  { value: "agro_rendimento", label_pt: "Previsão de rendimento por área", description_pt: "Produção esperada por hectare ou talhão", problem_type_hint: "regression", nature_hint: "how_much" },
  { value: "agro_volume", label_pt: "Previsão de volume recebido", description_pt: "Quantidade total esperada em unidade/filial", problem_type_hint: "regression", nature_hint: "how_much" },
  { value: "agro_entrega", label_pt: "Previsão de entrega futura", description_pt: "Quando e quanto cada produtor vai entregar", problem_type_hint: "regression", nature_hint: "how_much" },
  { value: "agro_qualidade", label_pt: "Classificação de qualidade do lote", description_pt: "Prever a classe de qualidade do produto recebido", problem_type_hint: "classification", nature_hint: "will_it_happen" },
  { value: "risk_scoring", label_pt: "Risco de quebra de safra", description_pt: "Probabilidade de queda significativa na produção", problem_type_hint: "classification", nature_hint: "will_it_happen" },
  { value: "default_risk", label_pt: "Risco de inadimplência do produtor", description_pt: "Probabilidade de não pagamento ou não entrega", problem_type_hint: "classification", nature_hint: "will_it_happen" },
  { value: "propensity", label_pt: "Propensão de adesão/entrega", description_pt: "Probabilidade de aderir a programa ou realizar entrega", problem_type_hint: "classification", nature_hint: "will_it_happen" },
  { value: "custom", label_pt: "Outro objetivo agro", description_pt: "Objetivo personalizado para o agronegócio" },
];

const DEFAULT_OBJECTIVES: ContextualOption[] = [
  { value: "churn", label_pt: "Cancelamento / Evasão", description_pt: "Quem vai parar de comprar, usar ou frequentar" },
  { value: "propensity", label_pt: "Propensão / Conversão", description_pt: "Quem vai comprar, converter ou aderir" },
  { value: "default_risk", label_pt: "Inadimplência / Default", description_pt: "Quem vai atrasar ou não pagar" },
  { value: "demand_forecast", label_pt: "Previsão de demanda", description_pt: "Quanto será vendido, produzido ou consumido" },
  { value: "anomaly_detection", label_pt: "Detecção de anomalias", description_pt: "Identificar fraudes, outliers ou eventos atípicos" },
  { value: "segmentation", label_pt: "Segmentação", description_pt: "Agrupar entidades por similaridade" },
  { value: "lifetime_value", label_pt: "Valor do cliente (LTV)", description_pt: "Prever quanto um cliente gerará de receita" },
  { value: "turnover", label_pt: "Turnover / Rotatividade", description_pt: "Prever saída de colaboradores" },
  { value: "risk_scoring", label_pt: "Score de risco", description_pt: "Classificar entidades por nível de risco" },
  { value: "custom", label_pt: "Outro objetivo", description_pt: "Objetivo personalizado" },
];

const INDUSTRY_OBJECTIVES: Partial<Record<IndustryKeyV3, ContextualOption[]>> = {
  agro: AGRO_OBJECTIVES,
};

// ─── ENTITY OPTIONS BY INDUSTRY ─────────────────────────────────

const AGRO_ENTITIES: ContextualOption[] = [
  { value: "produtor", label_pt: "Produtor", description_pt: "Produtor rural individual" },
  { value: "cooperado", label_pt: "Cooperado", description_pt: "Membro de cooperativa" },
  { value: "fazenda", label_pt: "Fazenda", description_pt: "Propriedade rural" },
  { value: "propriedade", label_pt: "Propriedade", description_pt: "Unidade produtiva" },
  { value: "talhao", label_pt: "Talhão", description_pt: "Área específica de cultivo" },
  { value: "lote", label_pt: "Lote", description_pt: "Lote de produto ou área" },
  { value: "unidade", label_pt: "Unidade / Filial", description_pt: "Unidade de recebimento ou filial" },
  { value: "regiao", label_pt: "Região", description_pt: "Área geográfica de produção" },
  { value: "cultura", label_pt: "Cultura", description_pt: "Tipo de cultivo (café, soja, milho...)" },
  { value: "safra", label_pt: "Safra", description_pt: "Ciclo de produção" },
  { value: "other", label_pt: "Outro", description_pt: "Entidade não listada" },
];

const DEFAULT_ENTITIES: ContextualOption[] = [
  { value: "customer", label_pt: "Cliente" },
  { value: "patient", label_pt: "Paciente" },
  { value: "student", label_pt: "Aluno" },
  { value: "employee", label_pt: "Colaborador" },
  { value: "contract", label_pt: "Contrato" },
  { value: "transaction", label_pt: "Transação" },
  { value: "product", label_pt: "Produto" },
  { value: "account", label_pt: "Conta" },
  { value: "household", label_pt: "Domicílio" },
  { value: "other", label_pt: "Outro" },
];

const INDUSTRY_ENTITIES: Partial<Record<IndustryKeyV3, ContextualOption[]>> = {
  agro: AGRO_ENTITIES,
};

// ─── DECISION HINTS BY INDUSTRY ─────────────────────────────────

const AGRO_DECISION_HINTS = [
  "Planejar compra/captação com antecedência",
  "Priorizar produtores/regiões com maior potencial de entrega",
  "Planejar estoque e logística de recebimento",
  "Antecipar quebra de safra ou baixa produtividade",
  "Direcionar atuação comercial/técnica por produtor ou região",
  "Melhorar planejamento de cooperativa/unidade",
];

const DEFAULT_DECISION_HINTS = [
  "Quem devo priorizar?",
  "Onde alocar recursos?",
  "Qual ação tomar para cada grupo?",
];

const INDUSTRY_DECISION_HINTS: Partial<Record<IndustryKeyV3, string[]>> = {
  agro: AGRO_DECISION_HINTS,
};

// ─── PROCESS OPTIONS BY INDUSTRY ────────────────────────────────

const AGRO_PROCESS_OPTIONS: ContextualOption[] = [
  { value: "manual", label_pt: "Experiência de campo", description_pt: "Baseado na experiência da equipe de campo" },
  { value: "rule_based", label_pt: "Histórico de safras", description_pt: "Baseado em dados de safras anteriores" },
  { value: "existing_model", label_pt: "Modelo/processo existente", description_pt: "Já uso planilhas ou modelo preditivo" },
  { value: "none", label_pt: "Sem processo definido", description_pt: "Decisões ad-hoc ou por feeling" },
];

const INDUSTRY_PROCESS_OPTIONS: Partial<Record<IndustryKeyV3, ContextualOption[]>> = {
  agro: AGRO_PROCESS_OPTIONS,
};

// ─── PREDICTION QUESTION HINTS ──────────────────────────────────

const AGRO_QUESTION_HINTS = [
  "Quantas sacas de café cada produtor vai entregar nos próximos 90 dias?",
  "Qual o volume total de captação esperado por região/mês?",
  "Qual a probabilidade de quebra de safra por talhão?",
  "Qual a produtividade esperada por hectare nesta safra?",
];

const DEFAULT_QUESTION_HINTS = [
  "Qual a probabilidade de...?",
  "Quanto será...?",
  "Quem vai...?",
];

const INDUSTRY_QUESTION_HINTS: Partial<Record<IndustryKeyV3, string[]>> = {
  agro: AGRO_QUESTION_HINTS,
};

// ─── PUBLIC API ─────────────────────────────────────────────────

export function getObjectiveOptions(industry: IndustryKeyV3): ContextualOption[] {
  return INDUSTRY_OBJECTIVES[industry] || DEFAULT_OBJECTIVES;
}

export function getEntityOptions(industry: IndustryKeyV3): ContextualOption[] {
  return INDUSTRY_ENTITIES[industry] || DEFAULT_ENTITIES;
}

export function getProcessOptions(industry: IndustryKeyV3): ContextualOption[] {
  return INDUSTRY_PROCESS_OPTIONS[industry] || [
    { value: "manual", label_pt: "Manualmente", description_pt: "Baseado em intuição ou experiência" },
    { value: "rule_based", label_pt: "Regras fixas", description_pt: "Critérios pré-definidos (ex: >30 dias)" },
    { value: "existing_model", label_pt: "Modelo existente", description_pt: "Já uso um modelo preditivo" },
    { value: "none", label_pt: "Não existe", description_pt: "Não tenho processo definido" },
  ];
}

export function getDecisionHints(industry: IndustryKeyV3): string[] {
  return INDUSTRY_DECISION_HINTS[industry] || DEFAULT_DECISION_HINTS;
}

export function getQuestionHints(industry: IndustryKeyV3): string[] {
  return INDUSTRY_QUESTION_HINTS[industry] || DEFAULT_QUESTION_HINTS;
}

/** Check if a selected value is still valid for the new options list */
export function isValueCompatible(value: string | undefined, options: ContextualOption[]): boolean {
  if (!value) return true;
  return options.some(o => o.value === value);
}

/** Get the nature hint for an objective in a given industry */
export function getObjectiveNatureHint(industry: IndustryKeyV3, objective: string): "will_it_happen" | "how_much" | "when" | "who_is_similar" | null {
  const opts = getObjectiveOptions(industry);
  const found = opts.find(o => o.value === objective);
  return found?.nature_hint || null;
}

/** Get default entity for an industry */
export function getDefaultEntity(industry: IndustryKeyV3): string {
  const map: Partial<Record<IndustryKeyV3, string>> = {
    retail: "customer",
    health: "patient",
    education: "student",
    hr: "employee",
    finance: "account",
    agro: "produtor",
    logistics: "transaction",
  };
  return map[industry] || "customer";
}
