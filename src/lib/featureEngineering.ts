/**
 * Feature Engineering Types and Utilities for Frontend
 * 
 * Mirrors the backend types for consistent usage across the app.
 */

export type FeatureExpression =
  | {
      type: "ratio";
      numerator: string;
      denominator: string;
      eps?: number;
    }
  | {
      type: "difference";
      minuend: string;
      subtrahend: string;
    }
  | {
      type: "sum";
      columns: string[];
    }
  | {
      type: "binary_flag";
      column: string;
      op: ">" | ">=" | "<" | "<=" | "==" | "!=";
      value: number;
    }
  | {
      type: "log1p";
      column: string;
    };

export interface ProjectFeature {
  id: string;
  project_id: string;
  name: string;
  label: string;
  description?: string;
  enabled: boolean;
  expression: FeatureExpression;
  created_at?: string;
  updated_at?: string;
}

export const FEATURE_TYPE_LABELS: Record<FeatureExpression["type"], string> = {
  ratio: "Razão",
  difference: "Diferença",
  sum: "Soma",
  binary_flag: "Flag binária",
  log1p: "Log(1+x)",
};

export const FEATURE_TYPE_DESCRIPTIONS: Record<FeatureExpression["type"], string> = {
  ratio: "Divide uma coluna por outra (numerador / denominador)",
  difference: "Subtrai uma coluna de outra (A - B)",
  sum: "Soma os valores de múltiplas colunas",
  binary_flag: "Cria flag 0/1 baseada em comparação (coluna > valor)",
  log1p: "Aplica logaritmo natural de (1 + x) para suavizar distribuições",
};

export const BINARY_FLAG_OPERATORS = [
  { value: ">", label: "maior que (>)" },
  { value: ">=", label: "maior ou igual (>=)" },
  { value: "<", label: "menor que (<)" },
  { value: "<=", label: "menor ou igual (<=)" },
  { value: "==", label: "igual a (==)" },
  { value: "!=", label: "diferente de (!=)" },
] as const;

/**
 * Generate a URL-safe slug from a column name
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Get columns involved in a feature expression
 */
export function getExpressionColumns(expr: FeatureExpression): string[] {
  switch (expr.type) {
    case "ratio":
      return [expr.numerator, expr.denominator];
    case "difference":
      return [expr.minuend, expr.subtrahend];
    case "sum":
      return expr.columns;
    case "binary_flag":
    case "log1p":
      return [expr.column];
    default:
      return [];
  }
}

/**
 * Format expression for display
 */
export function formatExpression(expr: FeatureExpression): string {
  switch (expr.type) {
    case "ratio":
      return `${expr.numerator} / ${expr.denominator}`;
    case "difference":
      return `${expr.minuend} - ${expr.subtrahend}`;
    case "sum":
      return expr.columns.join(" + ");
    case "binary_flag":
      return `${expr.column} ${expr.op} ${expr.value}`;
    case "log1p":
      return `log(1 + ${expr.column})`;
    default:
      return "Expressão inválida";
  }
}

/**
 * Validate a feature expression
 */
export function validateExpression(expr: Partial<FeatureExpression>): string | null {
  if (!expr.type) {
    return "Selecione o tipo de feature";
  }

  switch (expr.type) {
    case "ratio": {
      const r = expr as Partial<Extract<FeatureExpression, { type: "ratio" }>>;
      if (!r.numerator) return "Selecione a coluna do numerador";
      if (!r.denominator) return "Selecione a coluna do denominador";
      break;
    }
    case "difference": {
      const d = expr as Partial<Extract<FeatureExpression, { type: "difference" }>>;
      if (!d.minuend) return "Selecione a primeira coluna (minuendo)";
      if (!d.subtrahend) return "Selecione a segunda coluna (subtraendo)";
      break;
    }
    case "sum": {
      const s = expr as Partial<Extract<FeatureExpression, { type: "sum" }>>;
      if (!s.columns || s.columns.length < 2) return "Selecione pelo menos 2 colunas para somar";
      break;
    }
    case "binary_flag": {
      const b = expr as Partial<Extract<FeatureExpression, { type: "binary_flag" }>>;
      if (!b.column) return "Selecione a coluna";
      if (!b.op) return "Selecione o operador";
      if (b.value === undefined || b.value === null) return "Informe o valor de comparação";
      break;
    }
    case "log1p": {
      const l = expr as Partial<Extract<FeatureExpression, { type: "log1p" }>>;
      if (!l.column) return "Selecione a coluna";
      break;
    }
  }

  return null;
}

// ==================== Feature Packages ====================

export interface FeaturePackage {
  id: string;
  name: string;
  description: string;
  requiredColumns: {
    key: string;
    label: string;
    description: string;
  }[];
  generateFeatures: (columnMapping: Record<string, string>) => Omit<ProjectFeature, "id" | "project_id" | "created_at" | "updated_at">[];
}

export const FEATURE_PACKAGES: FeaturePackage[] = [
  {
    id: "rfm_basic",
    name: "Pacote RFM básico (Recência, Frequência, Monetário)",
    description: "Cria automaticamente versões logarítmicas de recência, frequência e valor monetário. Isso ajuda o modelo a diferenciar clientes inativos, regulares e muito engajados, melhorando predições de churn e recompra.",
    requiredColumns: [
      {
        key: "recency",
        label: "Coluna de Recência",
        description: "Dias desde último evento (ex: dias_desde_ultima_compra)",
      },
      {
        key: "frequency",
        label: "Coluna de Frequência",
        description: "Quantidade de eventos (ex: qtd_compras_12m)",
      },
      {
        key: "monetary",
        label: "Coluna Monetária",
        description: "Valor total (ex: valor_total_12m)",
      },
    ],
    generateFeatures: (mapping) => [
      {
        name: `log_recencia_${slugify(mapping.recency)}`,
        label: `Log de recência (${mapping.recency})`,
        description: "Versão logarítmica da recência para suavizar distribuição",
        enabled: true,
        expression: { type: "log1p", column: mapping.recency },
      },
      {
        name: `log_freq_${slugify(mapping.frequency)}`,
        label: `Log de frequência (${mapping.frequency})`,
        description: "Versão logarítmica da frequência para suavizar distribuição",
        enabled: true,
        expression: { type: "log1p", column: mapping.frequency },
      },
      {
        name: `log_valor_${slugify(mapping.monetary)}`,
        label: `Log do valor (${mapping.monetary})`,
        description: "Versão logarítmica do valor monetário para suavizar distribuição",
        enabled: true,
        expression: { type: "log1p", column: mapping.monetary },
      },
    ],
  },
  {
    id: "engagement_trend",
    name: "Tendência de engajamento (30/60/90 dias)",
    description: "Compara o volume de eventos nas janelas de 30, 60 e 90 dias. Ajuda a identificar se o cliente está acelerando (engajamento em alta) ou desacelerando (risco de churn) ao longo do tempo.",
    requiredColumns: [
      {
        key: "col30",
        label: "Eventos nos últimos 30 dias",
        description: "Quantidade de eventos nos últimos 30 dias",
      },
      {
        key: "col60",
        label: "Eventos nos últimos 60 dias",
        description: "Quantidade de eventos nos últimos 60 dias",
      },
      {
        key: "col90",
        label: "Eventos nos últimos 90 dias",
        description: "Quantidade de eventos nos últimos 90 dias",
      },
    ],
    generateFeatures: (mapping) => [
      {
        name: "engajamento_trend_30_60",
        label: "Tendência 30/60 dias",
        description: "Razão entre eventos de 30 dias e 60 dias (>1 = acelerando)",
        enabled: true,
        expression: {
          type: "ratio",
          numerator: mapping.col30,
          denominator: mapping.col60,
          eps: 1e-6,
        },
      },
      {
        name: "engajamento_trend_60_90",
        label: "Tendência 60/90 dias",
        description: "Razão entre eventos de 60 dias e 90 dias (>1 = acelerando)",
        enabled: true,
        expression: {
          type: "ratio",
          numerator: mapping.col60,
          denominator: mapping.col90,
          eps: 1e-6,
        },
      },
    ],
  },
  {
    id: "recent_vs_historical",
    name: "Valor recente vs valor histórico",
    description: "Calcula qual fração do faturamento do cliente veio do período recente em relação ao histórico. Ajuda a destacar contas em crescimento (alto peso recente) e contas em possível queda (peso recente baixo).",
    requiredColumns: [
      {
        key: "recentValue",
        label: "Valor recente",
        description: "Valor do período recente (ex: valor_ultimos_30d)",
      },
      {
        key: "totalValue",
        label: "Valor total/histórico",
        description: "Valor total histórico (ex: valor_12m)",
      },
    ],
    generateFeatures: (mapping) => [
      {
        name: `share_valor_recente_${slugify(mapping.recentValue)}`,
        label: `Share valor recente (${mapping.recentValue})`,
        description: "Fração do valor recente sobre o valor total",
        enabled: true,
        expression: {
          type: "ratio",
          numerator: mapping.recentValue,
          denominator: mapping.totalValue,
          eps: 1e-6,
        },
      },
      {
        name: `log_valor_${slugify(mapping.totalValue)}`,
        label: `Log do valor total (${mapping.totalValue})`,
        description: "Versão logarítmica do valor histórico",
        enabled: true,
        expression: { type: "log1p", column: mapping.totalValue },
      },
    ],
  },
];
