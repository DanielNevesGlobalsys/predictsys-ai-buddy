import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callOpenAI } from "../_shared/openai-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ══════════════════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════════════════

type ColumnRole =
  | "ID_TECNICO"
  | "TEMPO"
  | "DIMENSAO_NEGOCIO"
  | "MEDIDA_NUMERICA"
  | "CATEGORICA"
  | "TEXTO"
  | "TARGET_CANDIDATO_EVENTO"
  | "TARGET_CANDIDATO_ESTADO"
  | "DERIVADA_LEAKAGE"
  | "DESCONHECIDO";

interface ColumnClassification {
  column: string;
  role: ColumnRole;
  inferred_type: string;
  reasons: string[];
}

type IndustryLabel =
  | "education"
  | "retail_shopping"
  | "healthcare"
  | "logistics"
  | "financial"
  | "generic";

interface IndustryInference {
  label: IndustryLabel;
  display_name: string;
  confidence: number;
  evidence: string[];
}

interface TargetDefinition {
  type: "event" | "state_to_event";
  base_column: string;
  derived_target: string;
  window_days: number | null;
  problem_type: "binary" | "class" | "regression";
  confidence: number;
  business_summary: string;
  why_this_target: string;
  caveats: string[];
  notes: string;
}

interface BlockedFeature {
  col: string;
  reason: string;
}

interface LeakageFlag {
  col: string;
  reason: string;
}

interface ModelingContract {
  anchor_time_col: string | null;
  entity_key: string[] | null;
  target_definition: TargetDefinition;
  split_strategy: "temporal" | "stratified" | "random";
  features_final: string[];
  features_blocked: BlockedFeature[];
  leakage_flags: LeakageFlag[];
  column_roles: Record<string, ColumnRole>;
  dashboard_gold_schema: string[];
}

interface InferenceResult {
  status: "APPROVED" | "BLOCKED";
  justification: string[];
  modeling_contract: ModelingContract | null;
  removed_and_why: BlockedFeature[];
  next_step: string | null;
  // Legacy compatibility fields
  problem_type: string;
  suggested_problem_labels: Array<{ label: string; relevance: number }>;
  suggested_targets: Array<{
    column: string;
    type: "binary" | "class" | "regression";
    confidence: number;
    business_summary: string;
    why_this_target: string;
    caveats: string[];
  }>;
  suggested_predictors: Array<{ column: string; score: number; reason: string }>;
  narrative: string;
  confidence: number;
  industry: IndustryInference;
}

// ══════════════════════════════════════════════════════════════════════
//  INDUSTRY DETECTION (preserved from v2)
// ══════════════════════════════════════════════════════════════════════

const INDUSTRY_KEYWORDS: Record<IndustryLabel, string[]> = {
  education: [
    "aluno", "alunos", "matricula", "matrícula", "rematricula", "rematrícula",
    "curso", "disciplina", "professor", "turma", "semestre", "nota", "notas",
    "cr", "coeficiente", "evasao", "evasão", "formatura", "campus",
    "faculdade", "escola", "universidade", "bolsa", "bolsista", "frequencia",
    "frequência", "aprovado", "reprovado", "trancamento", "diploma",
    "student", "enrollment", "grade", "gpa", "dropout", "semester",
  ],
  retail_shopping: [
    "loja", "lojista", "shopping", "venda", "vendas", "compra", "compras",
    "produto", "categoria", "sku", "pdv", "checkout", "carrinho", "cart",
    "cupom", "desconto", "promocao", "promoção", "faturamento", "ticket",
    "receita", "estoque", "store", "retail", "order", "purchase", "price",
    "revenue", "customer", "buyer", "mall", "contrato", "aluguel",
  ],
  healthcare: [
    "paciente", "hospital", "clinica", "clínica", "medico", "médico",
    "consulta", "internacao", "internação", "readmissao", "readmissão",
    "diagnostico", "diagnóstico", "cid", "procedimento", "leito",
    "prontuario", "prontuário", "alta", "obito", "óbito", "uti",
    "patient", "hospital", "clinic", "diagnosis", "readmission",
    "treatment", "prescription", "no_show", "noshow",
  ],
  logistics: [
    "entrega", "frete", "transportadora", "rastreio", "tracking",
    "lead_time", "leadtime", "rota", "destino", "origem", "cep",
    "endereco", "endereço", "devolucao", "devolução", "ruptura",
    "estoque", "armazem", "armazém", "shipping", "delivery",
    "warehouse", "inventory", "supply", "fleet", "driver",
  ],
  financial: [
    "credito", "crédito", "emprestimo", "empréstimo", "parcela",
    "juros", "spread", "inadimplencia", "inadimplência", "score",
    "rating", "pdd", "provisao", "provisão", "carteira", "portfolio",
    "titulo", "título", "cobranca", "cobrança", "boleto", "pagamento",
    "credit", "loan", "default", "delinquency", "interest",
  ],
  generic: [],
};

const INDUSTRY_DISPLAY: Record<IndustryLabel, string> = {
  education: "Educação",
  retail_shopping: "Varejo / Shopping",
  healthcare: "Saúde",
  logistics: "Logística",
  financial: "Financeiro / Crédito",
  generic: "Genérico",
};

function detectIndustry(columns: any[], catStats: Map<string, any>): IndustryInference {
  const scores: Record<IndustryLabel, { score: number; evidence: string[] }> = {
    education: { score: 0, evidence: [] },
    retail_shopping: { score: 0, evidence: [] },
    healthcare: { score: 0, evidence: [] },
    logistics: { score: 0, evidence: [] },
    financial: { score: 0, evidence: [] },
    generic: { score: 0, evidence: [] },
  };

  for (const col of columns) {
    const lower = col.column_name.toLowerCase();
    for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
      if (industry === "generic") continue;
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          scores[industry as IndustryLabel].score += 1;
          if (!scores[industry as IndustryLabel].evidence.includes(col.column_name)) {
            scores[industry as IndustryLabel].evidence.push(col.column_name);
          }
        }
      }
    }
  }

  for (const [colName, stat] of catStats) {
    if (!stat.top_categories) continue;
    const cats = stat.top_categories as Array<{ category: string }>;
    for (const cat of cats) {
      if (!cat.category) continue;
      const lower = cat.category.toLowerCase();
      for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
        if (industry === "generic") continue;
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            scores[industry as IndustryLabel].score += 0.5;
            if (!scores[industry as IndustryLabel].evidence.includes(colName)) {
              scores[industry as IndustryLabel].evidence.push(colName);
            }
          }
        }
      }
    }
  }

  let bestLabel: IndustryLabel = "generic";
  let bestScore = 0;
  for (const [label, data] of Object.entries(scores)) {
    if (label === "generic") continue;
    if (data.score > bestScore) {
      bestScore = data.score;
      bestLabel = label as IndustryLabel;
    }
  }

  const evidenceCount = scores[bestLabel].evidence.length;
  let confidence = Math.min(1, bestScore / 8);
  if (evidenceCount >= 5) confidence = Math.max(confidence, 0.8);
  else if (evidenceCount >= 3) confidence = Math.max(confidence, 0.6);

  if (confidence < 0.4) {
    return { label: "generic", display_name: INDUSTRY_DISPLAY.generic, confidence: 0.3, evidence: [] };
  }

  return {
    label: bestLabel,
    display_name: INDUSTRY_DISPLAY[bestLabel],
    confidence: Math.round(confidence * 100) / 100,
    evidence: scores[bestLabel].evidence.slice(0, 8),
  };
}

// ══════════════════════════════════════════════════════════════════════
//  PATTERN DICTIONARIES
// ══════════════════════════════════════════════════════════════════════

const ID_PATTERNS = [
  "id", "uuid", "row_id", "index", "cpf", "cnpj", "codigo", "código",
  "hash", "token", "key", "chave", "guid",
];

const TIME_PATTERNS = [
  "dt_", "date", "created_at", "last_purchase", "data_compra",
  "data_", "timestamp", "updated_at", "first_", "last_", "ultima_",
  "dt_nascimento", "data_matricula", "data_internacao", "data_entrega",
  "ref_date", "reference_date", "periodo", "período",
];

const LEAKAGE_PATTERNS = [
  "target", "label", "status_final", "resultado", "aprovado",
  "cancelado", "flag_", "y_true", "y_pred", "output",
  "resultado_final", "decisao", "decisão",
];

const EVENT_PATTERNS = [
  "churn", "cancel", "cancelado", "cancelamento", "evasao", "evasão",
  "dropout", "quit", "inactive", "inativo", "desligado", "saida", "saída",
  "churned", "trancamento", "desistencia", "desistência",
  "compra", "purchase", "convert", "conversao", "conversão", "lead",
  "signup", "matricula", "matrícula", "captacao", "captação", "propensao",
  "opt_in", "aceite", "contratou", "rematricula", "rematrícula",
  "no_show", "noshow", "falta", "readmissao", "readmissão",
  "inadimplencia", "inadimplência", "default", "atraso", "fraude", "fraud",
  "devolucao", "devolução",
];

const STATE_PATTERNS = [
  "status", "estado", "situacao", "situação", "ativo", "fase",
  "etapa", "stage", "classificacao", "classificação",
];

const REVENUE_PATTERNS = [
  "revenue", "receita", "faturamento", "valor", "ticket", "ltv",
  "valor_compra", "sales", "vendas", "montante", "total_compras",
  "valor_total", "amount", "price", "preco", "preço", "aluguel",
  "mensalidade",
];

const DEMAND_PATTERNS = [
  "demanda", "demand", "quantidade", "quantity", "volume", "ocupacao",
  "ocupação", "estoque", "stock", "pedidos", "orders", "fluxo",
];

const ENTITY_KEY_PATTERNS = [
  "cliente", "customer", "client", "cpf", "cnpj", "codparc",
  "id_cliente", "customer_id", "client_id", "aluno", "student",
  "paciente", "patient", "lojista", "tenant", "user_id",
  "entity_id", "cod_cliente", "matricula",
];

// ══════════════════════════════════════════════════════════════════════
//  VERTICAL PROBLEM TEMPLATES
// ══════════════════════════════════════════════════════════════════════

interface VerticalProblem {
  label: string;
  patterns: string[];
  type: "binary" | "class" | "regression";
  summary: string;
}

const VERTICAL_PROBLEMS: Record<IndustryLabel, VerticalProblem[]> = {
  education: [
    { label: "Evasão de Alunos", patterns: ["evasao", "evasão", "dropout", "trancamento", "desistencia", "desistência", "cancelado"], type: "binary", summary: "Prever quais alunos têm maior risco de abandonar o curso." },
    { label: "Rematrícula", patterns: ["rematricula", "rematrícula", "renovacao", "renovação", "matricula"], type: "binary", summary: "Prever a probabilidade de renovação de matrícula." },
    { label: "Inadimplência Acadêmica", patterns: ["inadimplencia", "inadimplência", "default", "atraso", "pagamento"], type: "binary", summary: "Identificar alunos com risco de inadimplência." },
    { label: "Performance Acadêmica", patterns: ["nota", "notas", "cr", "coeficiente", "media", "média", "gpa"], type: "regression", summary: "Estimar o desempenho acadêmico do aluno." },
  ],
  retail_shopping: [
    { label: "Churn de Lojistas", patterns: ["churn", "cancel", "saida", "saída", "desligado", "inativo"], type: "binary", summary: "Prever quais lojistas têm risco de encerrar contrato." },
    { label: "Inadimplência de Lojistas", patterns: ["inadimplencia", "inadimplência", "atraso", "default"], type: "binary", summary: "Identificar lojistas com risco de atraso no aluguel." },
    { label: "Previsão de Faturamento", patterns: ["faturamento", "receita", "vendas", "revenue", "ticket"], type: "regression", summary: "Estimar receita futura para planejamento financeiro." },
    { label: "Propensão à Compra", patterns: ["compra", "purchase", "conversao", "conversão", "lead"], type: "binary", summary: "Prever quais clientes têm maior propensão à compra." },
  ],
  healthcare: [
    { label: "Readmissão Hospitalar", patterns: ["readmissao", "readmissão", "readmission", "reinternacao", "reinternação"], type: "binary", summary: "Prever pacientes com risco de retorno não planejado." },
    { label: "No-show em Consultas", patterns: ["no_show", "noshow", "falta", "ausencia", "ausência"], type: "binary", summary: "Identificar pacientes com risco de não comparecer." },
    { label: "Tempo de Internação", patterns: ["internacao", "internação", "permanencia", "permanência", "leito", "dias"], type: "regression", summary: "Estimar a duração da internação." },
    { label: "Custo por Paciente", patterns: ["custo", "cost", "valor", "despesa", "gasto"], type: "regression", summary: "Prever o custo total do tratamento." },
  ],
  logistics: [
    { label: "Atraso de Entrega", patterns: ["atraso", "delay", "atrasado", "pontualidade", "sla"], type: "binary", summary: "Prever entregas com risco de atraso." },
    { label: "Lead Time", patterns: ["lead_time", "leadtime", "tempo_entrega", "prazo"], type: "regression", summary: "Estimar o tempo de entrega." },
    { label: "Devolução", patterns: ["devolucao", "devolução", "retorno", "return", "reversa"], type: "binary", summary: "Prever quais pedidos têm maior risco de devolução." },
    { label: "Demanda / Estoque", patterns: ["demanda", "demand", "estoque", "stock", "ruptura"], type: "regression", summary: "Prever volumes futuros para otimizar reposição." },
  ],
  financial: [
    { label: "Inadimplência / Default", patterns: ["inadimplencia", "inadimplência", "default", "atraso", "pdd"], type: "binary", summary: "Prever clientes com risco de não pagar." },
    { label: "Score de Crédito", patterns: ["score", "rating", "credito", "crédito", "risco"], type: "regression", summary: "Estimar o score de crédito." },
    { label: "Churn Financeiro", patterns: ["churn", "cancel", "encerramento", "saida", "saída"], type: "binary", summary: "Prever clientes que podem encerrar relacionamento." },
    { label: "LTV / Valor do Cliente", patterns: ["ltv", "lifetime", "valor_cliente", "receita", "revenue"], type: "regression", summary: "Estimar o valor futuro do cliente." },
  ],
  generic: [
    { label: "Churn / Evasão", patterns: ["churn", "cancel", "cancelado", "evasao", "evasão", "dropout", "inactive", "inativo", "desligado"], type: "binary", summary: "Prever risco de saída ou cancelamento." },
    { label: "Propensão / Conversão", patterns: ["compra", "purchase", "convert", "conversao", "conversão", "lead", "signup"], type: "binary", summary: "Prever probabilidade de conversão." },
    { label: "Previsão de Receita", patterns: ["revenue", "receita", "faturamento", "valor", "ticket", "ltv", "sales", "vendas"], type: "regression", summary: "Estimar valores futuros." },
    { label: "Risco / Inadimplência", patterns: ["inadimplencia", "inadimplência", "default", "atraso", "risco", "fraude", "fraud"], type: "binary", summary: "Identificar registros com maior risco." },
    { label: "Previsão de Demanda", patterns: ["demanda", "demand", "quantidade", "volume", "estoque", "stock"], type: "regression", summary: "Estimar volumes futuros." },
  ],
};

// ══════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════

function matchesPatterns(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function estimateDistinct(numStat: any, totalRows: number): number {
  if (!numStat || numStat.max_value === null || numStat.min_value === null) return 0;
  const range = numStat.max_value - numStat.min_value;
  if (range === 0) return 1;
  if (range === 1 && numStat.min_value === 0) return 2;
  return Math.min(totalRows, Math.max(20, Math.ceil(range)));
}

function isSequentialInteger(numStat: any, distinctCount: number, totalRows: number): boolean {
  if (!numStat || numStat.min_value === null || numStat.max_value === null) return false;
  const range = numStat.max_value - numStat.min_value;
  if (range > 0 && Math.abs(range - (totalRows - 1)) / totalRows < 0.15) return true;
  if (distinctCount >= totalRows * 0.8 && numStat.std_value && numStat.mean_value) {
    const isWholeNumbers = numStat.min_value === Math.floor(numStat.min_value) &&
      numStat.max_value === Math.floor(numStat.max_value);
    if (isWholeNumbers && range > 50) return true;
  }
  return false;
}

function isCodedCategorical(name: string, numStat: any, distinctCount: number): boolean {
  const lower = name.toLowerCase();
  const codedPatterns = ["cod", "codigo", "código", "tipo", "flag", "status", "classe", "grau", "nivel", "nível", "sexo", "genero", "gênero", "uf", "regiao", "região"];
  if (codedPatterns.some(p => lower.includes(p)) && distinctCount <= 20) return true;
  if (numStat && distinctCount <= 10 && numStat.min_value === Math.floor(numStat.min_value)) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 1: SEMANTIC COLUMN CLASSIFICATION
// ══════════════════════════════════════════════════════════════════════

function classifyColumns(
  columns: any[],
  numStats: Map<string, any>,
  catStats: Map<string, any>,
  totalRows: number
): ColumnClassification[] {
  const results: ColumnClassification[] = [];

  for (const col of columns) {
    const name = col.column_name;
    const type = col.inferred_type;
    const lower = name.toLowerCase();
    const numStat = numStats.get(name);
    const catStat = catStats.get(name);
    const distinctCount = catStat?.distinct_count || (numStat ? estimateDistinct(numStat, totalRows) : 0);
    const uniqueRatio = totalRows > 0 ? distinctCount / totalRows : 0;
    const reasons: string[] = [];

    // ── ID_TECNICO ──
    if (lower === "id" || lower.endsWith("_id") || lower.startsWith("id_")) {
      reasons.push(`nome padrão de ID: "${name}"`);
      results.push({ column: name, role: "ID_TECNICO", inferred_type: type, reasons });
      continue;
    }
    if (ID_PATTERNS.some(p => lower === p || lower.startsWith(p + "_"))) {
      reasons.push(`padrão de ID técnico detectado`);
      results.push({ column: name, role: "ID_TECNICO", inferred_type: type, reasons });
      continue;
    }
    if (uniqueRatio > 0.9 && totalRows > 10 && !matchesPatterns(name, [...REVENUE_PATTERNS, ...DEMAND_PATTERNS])) {
      reasons.push(`unique_ratio=${(uniqueRatio * 100).toFixed(0)}% (quase chave primária)`);
      results.push({ column: name, role: "ID_TECNICO", inferred_type: type, reasons });
      continue;
    }

    // ── TEMPO ──
    if (matchesPatterns(name, TIME_PATTERNS) || type === "datetime" || type === "date") {
      reasons.push(`padrão temporal detectado`);
      results.push({ column: name, role: "TEMPO", inferred_type: type, reasons });
      continue;
    }

    // ── DERIVADA_LEAKAGE ──
    if (matchesPatterns(name, LEAKAGE_PATTERNS)) {
      // Check if it's also a valid event candidate (not just any leakage pattern)
      const isAlsoEvent = matchesPatterns(name, EVENT_PATTERNS);
      if (!isAlsoEvent) {
        reasons.push(`padrão de variável pós-evento ou derivada: "${name}"`);
        results.push({ column: name, role: "DERIVADA_LEAKAGE", inferred_type: type, reasons });
        continue;
      }
    }

    // ── TARGET_CANDIDATO_EVENTO (binary events) ──
    if (distinctCount === 2 && matchesPatterns(name, EVENT_PATTERNS)) {
      reasons.push(`binário com padrão de evento: ${distinctCount} valores`);
      results.push({ column: name, role: "TARGET_CANDIDATO_EVENTO", inferred_type: type, reasons });
      continue;
    }

    // ── TARGET_CANDIDATO_ESTADO (status columns) ──
    if (matchesPatterns(name, STATE_PATTERNS) && distinctCount >= 2 && distinctCount <= 20) {
      reasons.push(`padrão de estado/status com ${distinctCount} classes`);
      results.push({ column: name, role: "TARGET_CANDIDATO_ESTADO", inferred_type: type, reasons });
      continue;
    }

    // ── Numeric with variance = 0 → constant, skip ──
    if (numStat && numStat.std_value !== null && numStat.std_value === 0) {
      reasons.push("variância zero (constante)");
      results.push({ column: name, role: "DESCONHECIDO", inferred_type: type, reasons });
      continue;
    }

    // ── DIMENSAO_NEGOCIO (categorical with reasonable cardinality) ──
    if ((type === "categórico" || type === "texto" || type === "categorical") && distinctCount >= 2 && distinctCount <= 50) {
      reasons.push(`categórica com ${distinctCount} valores distintos`);
      results.push({ column: name, role: "DIMENSAO_NEGOCIO", inferred_type: type, reasons });
      continue;
    }
    if (isCodedCategorical(name, numStat, distinctCount)) {
      reasons.push(`numérica codificada como categórica (${distinctCount} valores)`);
      results.push({ column: name, role: "CATEGORICA", inferred_type: type, reasons });
      continue;
    }

    // ── MEDIDA_NUMERICA ──
    if ((type === "numérico" || type === "numeric") && numStat && distinctCount > 20) {
      if (isSequentialInteger(numStat, distinctCount, totalRows)) {
        reasons.push("inteiro sequencial (padrão de auto-increment)");
        results.push({ column: name, role: "ID_TECNICO", inferred_type: type, reasons });
        continue;
      }
      reasons.push(`numérica contínua com ${distinctCount} valores distintos`);
      results.push({ column: name, role: "MEDIDA_NUMERICA", inferred_type: type, reasons });
      continue;
    }

    // ── CATEGORICA (texto com alta cardinalidade) ──
    if ((type === "categórico" || type === "texto" || type === "categorical") && distinctCount > 50) {
      if (uniqueRatio > 0.2) {
        reasons.push(`alta cardinalidade (unique_ratio=${(uniqueRatio * 100).toFixed(0)}%)`);
        results.push({ column: name, role: "TEXTO", inferred_type: type, reasons });
        continue;
      }
      reasons.push(`categórica com cardinalidade moderada-alta (${distinctCount})`);
      results.push({ column: name, role: "CATEGORICA", inferred_type: type, reasons });
      continue;
    }

    // ── Binary but not matching event patterns → could be target candidate ──
    if (distinctCount === 2) {
      reasons.push(`binário genérico com 2 valores`);
      results.push({ column: name, role: "TARGET_CANDIDATO_EVENTO", inferred_type: type, reasons });
      continue;
    }

    // ── Fallback ──
    reasons.push("classificação indefinida");
    results.push({ column: name, role: "DESCONHECIDO", inferred_type: type, reasons });
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 2: TEMPORAL ANALYSIS
// ══════════════════════════════════════════════════════════════════════

function findAnchorTimeCol(classifications: ColumnClassification[]): string | null {
  const timeCols = classifications.filter(c => c.role === "TEMPO");
  if (timeCols.length === 0) return null;

  // Prefer columns with specific anchor keywords
  const anchorKeywords = ["created", "data_", "dt_", "ref", "reference", "registro"];
  for (const tc of timeCols) {
    if (anchorKeywords.some(k => tc.column.toLowerCase().includes(k))) {
      return tc.column;
    }
  }
  return timeCols[0].column;
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 3: TARGET INFERENCE
// ══════════════════════════════════════════════════════════════════════

function inferTarget(
  classifications: ColumnClassification[],
  numStats: Map<string, any>,
  catStats: Map<string, any>,
  totalRows: number,
  anchorTimeCol: string | null,
  industry: IndustryInference
): { targets: TargetDefinition[]; labels: Array<{ label: string; relevance: number }> } {
  const targets: TargetDefinition[] = [];
  const labels: Array<{ label: string; relevance: number }> = [];
  const labelSet = new Set<string>();

  const verticalProblems = VERTICAL_PROBLEMS[industry.label] || VERTICAL_PROBLEMS.generic;

  function addLabelOnce(label: string, relevance: number) {
    if (!labelSet.has(label)) {
      labelSet.add(label);
      labels.push({ label, relevance });
    }
  }

  // Process EVENT candidates first (higher priority)
  const eventCandidates = classifications.filter(c => c.role === "TARGET_CANDIDATO_EVENTO");
  for (const candidate of eventCandidates) {
    const name = candidate.column;
    const catStat = catStats.get(name);
    const numStat = numStats.get(name);
    const distinctCount = catStat?.distinct_count || (numStat ? estimateDistinct(numStat, totalRows) : 0);

    // Validate: not constant
    if (distinctCount <= 1) continue;

    // Check imbalance
    const caveats: string[] = [];
    let dominantPct = 0;
    if (catStat?.top_categories) {
      const topCats = catStat.top_categories as Array<{ category: string; count: number }>;
      const totalCount = topCats.reduce((s: number, c: any) => s + (c.count || 0), 0);
      if (totalCount > 0) {
        dominantPct = Math.max(...topCats.map((c: any) => (c.count || 0) / totalCount));
        if (dominantPct > 0.95) {
          caveats.push(`Desbalanceamento severo: classe dominante com ${(dominantPct * 100).toFixed(0)}%. Recomendar PR-AUC e técnicas de desbalanceamento.`);
        } else if (dominantPct > 0.85) {
          caveats.push(`Desbalanceamento: classe majoritária com ${(dominantPct * 100).toFixed(0)}%.`);
        }
      }
    }
    if (dominantPct > 0.99) {
      caveats.push("⛔ Target quase constante (>99% uma classe). Risco de modelo degenerado.");
    }

    // Match against vertical problems
    let bestMatch: VerticalProblem | null = null;
    for (const vp of verticalProblems) {
      if (vp.type === "binary" && matchesPatterns(name, vp.patterns)) {
        bestMatch = vp;
        break;
      }
    }
    if (!bestMatch) {
      for (const gp of VERTICAL_PROBLEMS.generic) {
        if (gp.type === "binary" && matchesPatterns(name, gp.patterns)) {
          bestMatch = gp;
          break;
        }
      }
    }

    let confidence = 0.80;
    let summary = `Classificação Binária: Prever a probabilidade de cada registro pertencer a uma das duas classes de "${name}".`;
    let businessLabel = "Classificação Binária";

    if (bestMatch) {
      businessLabel = bestMatch.label;
      summary = `${bestMatch.label}: ${bestMatch.summary}`;
      confidence = 0.90;
      addLabelOnce(bestMatch.label, 0.95);
    }

    if (dominantPct > 0.95) confidence *= 0.8;

    const windowDays = anchorTimeCol ? 30 : null;
    const derivedTarget = anchorTimeCol
      ? `${name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_em_${windowDays}d`
      : name;

    targets.push({
      type: "event",
      base_column: name,
      derived_target: derivedTarget,
      window_days: windowDays,
      problem_type: "binary",
      confidence,
      business_summary: summary,
      why_this_target: `Coluna "${name}" é binária com padrão de evento ${bestMatch ? `(${businessLabel})` : ""}.`,
      caveats,
      notes: anchorTimeCol
        ? `Janela temporal de ${windowDays} dias usando "${anchorTimeCol}" como âncora.`
        : "Sem coluna temporal — usando a coluna diretamente como target.",
    });
  }

  // Process STATE candidates (convert to event)
  const stateCandidates = classifications.filter(c => c.role === "TARGET_CANDIDATO_ESTADO");
  for (const candidate of stateCandidates) {
    const name = candidate.column;
    const catStat = catStats.get(name);
    const distinctCount = catStat?.distinct_count || 0;

    if (distinctCount <= 1 || distinctCount > 20) continue;

    const caveats: string[] = [];
    caveats.push(`Coluna de estado com ${distinctCount} valores. Precisa ser convertida em evento binário.`);

    if (!anchorTimeCol) {
      caveats.push("⚠️ Sem coluna temporal para definir janela do evento.");
    }

    let bestMatch: VerticalProblem | null = null;
    for (const vp of verticalProblems) {
      if (matchesPatterns(name, vp.patterns)) {
        bestMatch = vp;
        break;
      }
    }

    const windowDays = anchorTimeCol ? 30 : null;
    const derivedTarget = `mudou_para_${name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}${windowDays ? `_em_${windowDays}d` : ""}`;

    targets.push({
      type: "state_to_event",
      base_column: name,
      derived_target: derivedTarget,
      window_days: windowDays,
      problem_type: distinctCount === 2 ? "binary" : "class",
      confidence: 0.65,
      business_summary: bestMatch
        ? `${bestMatch.label}: ${bestMatch.summary}`
        : `Converter "${name}" de estado para evento preditivo.`,
      why_this_target: `Coluna de estado "${name}" com ${distinctCount} classes pode ser convertida em evento temporal.`,
      caveats,
      notes: `Conversão state_to_event: monitorar transição de estado em "${name}".`,
    });

    if (bestMatch) addLabelOnce(bestMatch.label, 0.75);
  }

  // Process MEDIDA_NUMERICA as regression targets
  const numericCandidates = classifications.filter(c => c.role === "MEDIDA_NUMERICA");
  for (const candidate of numericCandidates) {
    const name = candidate.column;
    const numStat = numStats.get(name);
    if (!numStat) continue;

    const catStat = catStats.get(name);
    const distinctCount = catStat?.distinct_count || estimateDistinct(numStat, totalRows);

    // Must have meaningful variance
    if (numStat.std_value === 0 || numStat.std_value === null) continue;

    let bestMatch: VerticalProblem | null = null;
    for (const vp of verticalProblems) {
      if (vp.type === "regression" && matchesPatterns(name, vp.patterns)) {
        bestMatch = vp;
        break;
      }
    }
    if (!bestMatch) {
      for (const gp of VERTICAL_PROBLEMS.generic) {
        if (gp.type === "regression" && matchesPatterns(name, gp.patterns)) {
          bestMatch = gp;
          break;
        }
      }
    }

    // Only include regression targets that match known patterns
    if (!bestMatch) continue;

    const caveats: string[] = [];
    if (numStat.mean_value && numStat.mean_value !== 0) {
      const cv = Math.abs(numStat.std_value / numStat.mean_value);
      if (cv > 3) caveats.push("Alta variabilidade (CV > 3). Considere transformação log.");
    }
    const nullRate = numStat.null_count / Math.max(totalRows, 1);
    if (nullRate > 0.05) caveats.push(`${(nullRate * 100).toFixed(1)}% de valores nulos.`);

    targets.push({
      type: "event",
      base_column: name,
      derived_target: name,
      window_days: null,
      problem_type: "regression",
      confidence: 0.82,
      business_summary: `${bestMatch.label}: ${bestMatch.summary}`,
      why_this_target: `Coluna "${name}" apresenta padrão de ${bestMatch.label.toLowerCase()} com variação contínua.`,
      caveats,
      notes: "Regressão direta — valor observável.",
    });
    addLabelOnce(bestMatch.label, 0.90);
  }

  // Sort by confidence
  targets.sort((a, b) => b.confidence - a.confidence);

  return { targets, labels: labels.sort((a, b) => b.relevance - a.relevance).slice(0, 5) };
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 4: FEATURE SELECTION (hard rules)
// ══════════════════════════════════════════════════════════════════════

function selectFeatures(
  classifications: ColumnClassification[],
  numStats: Map<string, any>,
  catStats: Map<string, any>,
  totalRows: number,
  targetCol: string | null,
  anchorTimeCol: string | null
): {
  features_final: string[];
  features_blocked: BlockedFeature[];
  leakage_flags: LeakageFlag[];
  predictors: Array<{ column: string; score: number; reason: string }>;
} {
  const features_final: string[] = [];
  const features_blocked: BlockedFeature[] = [];
  const leakage_flags: LeakageFlag[] = [];
  const predictors: Array<{ column: string; score: number; reason: string }> = [];

  for (const cls of classifications) {
    const name = cls.column;
    if (name === targetCol) continue; // Never include target as feature

    const numStat = numStats.get(name);
    const catStat = catStats.get(name);
    const distinctCount = catStat?.distinct_count || (numStat ? estimateDistinct(numStat, totalRows) : 0);
    const uniqueRatio = totalRows > 0 ? distinctCount / totalRows : 0;
    const nullRate = numStat ? numStat.null_count / Math.max(totalRows, 1) : 0;

    // ── HARD BLOCKS ──

    // 1. ID_TECNICO — always remove
    if (cls.role === "ID_TECNICO") {
      features_blocked.push({ col: name, reason: "ID técnico (chave interna, sem valor preditivo)" });
      continue;
    }

    // 2. Variance zero (constants)
    if (numStat && numStat.std_value !== null && numStat.std_value === 0) {
      features_blocked.push({ col: name, reason: "Variância zero (coluna constante)" });
      continue;
    }

    // 3. DERIVADA_LEAKAGE
    if (cls.role === "DERIVADA_LEAKAGE") {
      leakage_flags.push({ col: name, reason: "Variável pós-evento ou derivada do target (leakage)" });
      features_blocked.push({ col: name, reason: "Leakage: variável pós-evento" });
      continue;
    }

    // 4. High cardinality (unique_ratio > 0.2) unless DIMENSAO_NEGOCIO
    if (uniqueRatio > 0.2 && cls.role !== "DIMENSAO_NEGOCIO") {
      features_blocked.push({ col: name, reason: `Alta cardinalidade (unique_ratio=${(uniqueRatio * 100).toFixed(0)}%)` });
      continue;
    }

    // 5. Skip other target candidates (avoid leakage from correlated targets)
    if (cls.role === "TARGET_CANDIDATO_EVENTO" || cls.role === "TARGET_CANDIDATO_ESTADO") {
      // If it's correlated with the target, flag as leakage
      leakage_flags.push({ col: name, reason: `Candidato a target — potencial correlação com o target selecionado` });
      features_blocked.push({ col: name, reason: "Candidato a target (potencial leakage)" });
      continue;
    }

    // ── SCORE FEATURES ──
    let score = 0.5;
    const reasons: string[] = [];

    // Penalize high nulls
    if (nullRate > 0.5) {
      score -= 0.3;
      reasons.push("alta taxa de nulos");
    } else if (nullRate < 0.01) {
      score += 0.1;
      reasons.push("dados completos");
    }

    // Date columns are valuable (recency/frequency signals)
    if (cls.role === "TEMPO") {
      score += 0.15;
      reasons.push("sinal temporal (recência/frequência)");
    }

    // Numeric with good variance
    if (numStat && numStat.std_value && numStat.std_value > 0) {
      score += 0.15;
      reasons.push("variância adequada");
    }

    // Revenue/financial variables are strong predictors
    if (matchesPatterns(name, REVENUE_PATTERNS)) {
      score += 0.2;
      reasons.push("variável financeira");
    }

    // Demand variables
    if (matchesPatterns(name, DEMAND_PATTERNS)) {
      score += 0.1;
      reasons.push("variável de volume/demanda");
    }

    // Categorical with reasonable cardinality
    if (cls.role === "DIMENSAO_NEGOCIO" || cls.role === "CATEGORICA") {
      if (distinctCount >= 2 && distinctCount <= 50) {
        score += 0.1;
        reasons.push(`cardinalidade adequada (${distinctCount})`);
      }
    }

    score = Math.max(0, Math.min(1, score));

    if (score > 0.2) {
      features_final.push(name);
      predictors.push({
        column: name,
        score,
        reason: reasons.join("; ") || "variável disponível",
      });
    } else {
      features_blocked.push({ col: name, reason: `Score muito baixo (${score.toFixed(2)})` });
    }
  }

  // Sort predictors by score
  predictors.sort((a, b) => b.score - a.score);

  return { features_final, features_blocked, leakage_flags, predictors };
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 5: CONTRACT GENERATION
// ══════════════════════════════════════════════════════════════════════

function findEntityKey(classifications: ColumnClassification[]): string[] | null {
  const candidates: string[] = [];
  for (const cls of classifications) {
    if (matchesPatterns(cls.column, ENTITY_KEY_PATTERNS)) {
      candidates.push(cls.column);
    }
  }
  if (candidates.length === 0) {
    // Fallback: look for ID_TECNICO columns that look like entity keys
    for (const cls of classifications) {
      if (cls.role === "ID_TECNICO" && matchesPatterns(cls.column, ["cliente", "customer", "aluno", "paciente", "lojista", "user"])) {
        candidates.push(cls.column);
      }
    }
  }
  return candidates.length > 0 ? candidates.slice(0, 2) : null;
}

function buildDashboardGoldSchema(
  entityKey: string[] | null,
  anchorTimeCol: string | null,
  targetCol: string,
  classifications: ColumnClassification[],
  predictors: Array<{ column: string; score: number }>
): string[] {
  const schema: string[] = [];

  if (entityKey && entityKey.length > 0) schema.push(entityKey[0]);
  if (anchorTimeCol) schema.push(anchorTimeCol);
  schema.push("score"); // prediction score placeholder
  schema.push(targetCol); // target_real

  // Add top 2-4 interpretable dimensions
  const dimensions = classifications
    .filter(c => c.role === "DIMENSAO_NEGOCIO" || c.role === "CATEGORICA")
    .slice(0, 4)
    .map(c => c.column);

  for (const d of dimensions) {
    if (!schema.includes(d)) schema.push(d);
    if (schema.length >= 8) break;
  }

  return schema;
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 6: GATING
// ══════════════════════════════════════════════════════════════════════

function checkGating(
  targets: TargetDefinition[],
  features_final: string[],
  anchorTimeCol: string | null,
  leakage_flags: LeakageFlag[]
): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // No valid target found
  if (targets.length === 0) {
    reasons.push("Nenhum target válido encontrado no dataset.");
  }

  // Best target requires temporal window but no time column exists
  if (targets.length > 0 && targets[0].type === "state_to_event" && !anchorTimeCol) {
    reasons.push("Target do tipo state_to_event requer coluna temporal, mas nenhuma foi encontrada.");
  }

  // Features empty
  if (features_final.length === 0) {
    reasons.push("Nenhuma feature válida após filtragem. Verifique as colunas do dataset.");
  }

  // Target is constant/almost constant
  if (targets.length > 0) {
    const bestTarget = targets[0];
    const hasConstantWarning = bestTarget.caveats.some(c => c.includes("quase constante") || c.includes(">99%"));
    if (hasConstantWarning) {
      reasons.push("Target quase constante (>99% uma classe). Modelo será degenerado.");
    }
  }

  // Strong leakage without alternative
  if (leakage_flags.length > 3 && features_final.length < 3) {
    reasons.push("Risco forte de leakage: muitas features suspeitas e poucas alternativas seguras.");
  }

  return { blocked: reasons.length > 0, reasons };
}

// ══════════════════════════════════════════════════════════════════════
//  NARRATIVE GENERATOR (v3)
// ══════════════════════════════════════════════════════════════════════

function generateNarrative(
  status: "APPROVED" | "BLOCKED",
  targets: TargetDefinition[],
  predictors: Array<{ column: string; score: number; reason: string }>,
  labels: Array<{ label: string; relevance: number }>,
  totalRows: number,
  totalCols: number,
  projectName: string,
  businessGoal: string,
  industry: IndustryInference,
  blockedReasons: string[],
  featuresBlocked: BlockedFeature[],
  leakageFlags: LeakageFlag[]
): string {
  const lines: string[] = [];

  lines.push(`## Análise do Dataset "${projectName}"`);
  lines.push("");

  if (status === "BLOCKED") {
    lines.push("### ⛔ Status: BLOQUEADO");
    lines.push("");
    lines.push("O contrato de modelagem **não pode ser aprovado** pelos seguintes motivos:");
    lines.push("");
    for (const r of blockedReasons) {
      lines.push(`- ${r}`);
    }
    lines.push("");
    lines.push("**Próximo passo:** Corrija os problemas acima e re-execute a inferência.");
    return lines.join("\n");
  }

  // Industry
  if (industry.label !== "generic") {
    lines.push(`**Segmento identificado:** ${industry.display_name} (confiança: ${(industry.confidence * 100).toFixed(0)}%)`);
    if (industry.evidence.length > 0) {
      lines.push(`Evidências: colunas ${industry.evidence.slice(0, 5).map(e => `\`${e}\``).join(", ")}`);
    }
    lines.push("");
  }

  if (businessGoal) {
    lines.push(`**Objetivo declarado:** ${businessGoal}`);
    lines.push("");
  }

  lines.push(`O dataset contém **${totalRows.toLocaleString("pt-BR")} registros** com **${totalCols} colunas**.`);
  lines.push("");

  // Labels
  if (labels.length > 0) {
    lines.push("### 🔍 O que parece ser previsível aqui");
    lines.push("");
    const topLabels = labels.slice(0, 3).map(l => `**${l.label}**`).join(", ");
    lines.push(`Com base nos padrões estatísticos, os dados sugerem problemas de ${topLabels}.`);
    lines.push("");
  }

  // Target suggestions
  if (targets.length > 0) {
    lines.push("### 🎯 Sugestões de variável alvo");
    lines.push("");
    for (const t of targets.slice(0, 3)) {
      const typeLabel = t.problem_type === "binary" ? "classificação binária" : t.problem_type === "class" ? "multiclasse" : "regressão";
      lines.push(`- **${t.base_column}** → \`${t.derived_target}\` (${typeLabel}, confiança: ${(t.confidence * 100).toFixed(0)}%)`);
      lines.push(`  ${t.business_summary}`);
      if (t.window_days) lines.push(`  📅 Janela: ${t.window_days} dias`);
      if (t.caveats.length > 0) lines.push(`  ⚠️ ${t.caveats[0]}`);
    }
    lines.push("");
  }

  // Predictors
  if (predictors.length > 0) {
    lines.push("### 📊 Features selecionadas");
    lines.push("");
    for (const p of predictors.slice(0, 8)) {
      lines.push(`- **${p.column}** — ${p.reason}`);
    }
    lines.push("");
  }

  // Removed & Why
  if (featuresBlocked.length > 0 || leakageFlags.length > 0) {
    lines.push("### 🚫 Removidas & Motivo");
    lines.push("");
    for (const fb of featuresBlocked.slice(0, 10)) {
      lines.push(`- \`${fb.col}\` — ${fb.reason}`);
    }
    lines.push("");
  }

  // Business value
  if (targets.length > 0) {
    lines.push("### 💡 Valor pro negócio");
    lines.push("");
    const best = targets[0];
    if (best.problem_type === "binary" || best.problem_type === "class") {
      lines.push("Com um modelo de classificação, é possível **antecipar eventos** e tomar ações preventivas — como campanhas de retenção, priorização de leads ou alertas de risco.");
    } else {
      lines.push("Com um modelo de regressão, é possível **estimar valores futuros** — permitindo planejamento financeiro, otimização de recursos e simulações.");
    }
    lines.push("");
    lines.push("⚠️ *Inferências baseadas em evidência estatística. Você pode revisar e ajustar qualquer sugestão.*");
  }

  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════════
//  LLM DISAMBIGUATION (Layer 1.5 — only when heuristic confidence is low)
// ══════════════════════════════════════════════════════════════════════

async function llmDisambiguate(
  ambiguousColumns: Array<{ column: string; role: ColumnRole; reasons: string[] }>,
  projectName: string,
  industry: IndustryInference,
  allColumnNames: string[]
): Promise<Record<string, ColumnRole>> {
  if (ambiguousColumns.length === 0) return {};

  const colList = ambiguousColumns.map(c => `- "${c.column}" (classificado heuristicamente como ${c.role}; motivos: ${c.reasons.join(", ")})`).join("\n");

  const prompt = `Você é um especialista em engenharia de features para ML.
Projeto: "${projectName}" | Setor: ${industry.display_name}
Todas as colunas: ${allColumnNames.join(", ")}

Colunas ambíguas:
${colList}

Para cada coluna ambígua, retorne o papel correto. Papéis possíveis:
ID_TECNICO, TEMPO, DIMENSAO_NEGOCIO, MEDIDA_NUMERICA, CATEGORICA, TEXTO, TARGET_CANDIDATO_EVENTO, TARGET_CANDIDATO_ESTADO, DERIVADA_LEAKAGE, DESCONHECIDO

Retorne APENAS um JSON: { "column_name": "ROLE", ... }`;

  try {
    const response = await callOpenAI({
      messages: [
        { role: "system", content: "Você classifica colunas de datasets para ML. Responda SOMENTE com JSON válido." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
    });

    if (!response.ok) {
      console.warn(`[infer-problem] LLM disambiguation failed: ${response.status}`);
      return {};
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]);
    const validRoles = new Set<string>([
      "ID_TECNICO", "TEMPO", "DIMENSAO_NEGOCIO", "MEDIDA_NUMERICA",
      "CATEGORICA", "TEXTO", "TARGET_CANDIDATO_EVENTO", "TARGET_CANDIDATO_ESTADO",
      "DERIVADA_LEAKAGE", "DESCONHECIDO",
    ]);

    const result: Record<string, ColumnRole> = {};
    for (const [col, role] of Object.entries(parsed)) {
      if (typeof role === "string" && validRoles.has(role)) {
        result[col] = role as ColumnRole;
      }
    }
    console.log(`[infer-problem] LLM disambiguated ${Object.keys(result).length} columns`);
    return result;
  } catch (err) {
    console.warn("[infer-problem] LLM disambiguation error:", err);
    return {};
  }
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN INFERENCE ENGINE (v3)
// ══════════════════════════════════════════════════════════════════════

async function runInferenceV3(
  columns: any[],
  numStats: Map<string, any>,
  catStats: Map<string, any>,
  totalRows: number,
  projectName: string,
  businessGoal: string
): Promise<InferenceResult> {
  // ── Layer 1: Semantic Column Classification ──
  let classifications = classifyColumns(columns, numStats, catStats, totalRows);

  // ── Industry Detection ──
  const industry = detectIndustry(columns, catStats);
  console.log(`[infer-problem] Industry: ${industry.label} (${industry.confidence})`);

  // ── Layer 1.5: LLM Disambiguation for ambiguous columns ──
  const ambiguous = classifications.filter(c =>
    c.role === "DESCONHECIDO" ||
    (c.role === "CATEGORICA" && c.reasons.some(r => r.includes("indefinida")))
  );

  if (ambiguous.length > 0 && ambiguous.length <= 15) {
    const llmOverrides = await llmDisambiguate(
      ambiguous,
      projectName,
      industry,
      columns.map(c => c.column_name)
    );

    if (Object.keys(llmOverrides).length > 0) {
      classifications = classifications.map(cls => {
        if (llmOverrides[cls.column]) {
          return {
            ...cls,
            role: llmOverrides[cls.column],
            reasons: [...cls.reasons, `LLM reclassificou de ${cls.role} para ${llmOverrides[cls.column]}`],
          };
        }
        return cls;
      });
    }
  }

  // ── Layer 2: Temporal Analysis ──
  const anchorTimeCol = findAnchorTimeCol(classifications);
  console.log(`[infer-problem] Anchor time: ${anchorTimeCol || "none"}`);

  // ── Layer 3: Target Inference ──
  const { targets, labels } = inferTarget(
    classifications, numStats, catStats, totalRows, anchorTimeCol, industry
  );
  console.log(`[infer-problem] Targets found: ${targets.length}`);

  // ── Layer 4: Feature Selection ──
  const bestTargetCol = targets.length > 0 ? targets[0].base_column : null;
  const { features_final, features_blocked, leakage_flags, predictors } = selectFeatures(
    classifications, numStats, catStats, totalRows, bestTargetCol, anchorTimeCol
  );
  console.log(`[infer-problem] Features: ${features_final.length} final, ${features_blocked.length} blocked, ${leakage_flags.length} leakage`);

  // ── Layer 6: Gating ──
  const gating = checkGating(targets, features_final, anchorTimeCol, leakage_flags);

  // ── Layer 5: Contract Generation ──
  const columnRoles: Record<string, ColumnRole> = {};
  for (const cls of classifications) {
    columnRoles[cls.column] = cls.role;
  }

  const entityKey = findEntityKey(classifications);
  let contract: ModelingContract | null = null;

  if (!gating.blocked && targets.length > 0) {
    const bestTarget = targets[0];
    const splitStrategy: "temporal" | "stratified" | "random" = anchorTimeCol
      ? "temporal"
      : bestTarget.problem_type === "regression" ? "random" : "stratified";

    const goldSchema = buildDashboardGoldSchema(
      entityKey, anchorTimeCol, bestTarget.derived_target, classifications, predictors
    );

    contract = {
      anchor_time_col: anchorTimeCol,
      entity_key: entityKey,
      target_definition: bestTarget,
      split_strategy: splitStrategy,
      features_final,
      features_blocked,
      leakage_flags,
      column_roles: columnRoles,
      dashboard_gold_schema: goldSchema,
    };
  }

  const status: "APPROVED" | "BLOCKED" = gating.blocked ? "BLOCKED" : "APPROVED";

  // Build justification bullets
  const justification: string[] = [];
  if (status === "APPROVED" && targets.length > 0) {
    const best = targets[0];
    justification.push(`Target: "${best.base_column}" → "${best.derived_target}" (${best.problem_type})`);
    justification.push(`${features_final.length} features selecionadas, ${features_blocked.length} removidas`);
    if (anchorTimeCol) justification.push(`Âncora temporal: "${anchorTimeCol}" com janela de ${best.window_days || 30} dias`);
    justification.push(`Split: ${contract?.split_strategy || "stratified"}`);
    if (leakage_flags.length > 0) justification.push(`${leakage_flags.length} flags de leakage detectados`);
    justification.push(`Indústria: ${industry.display_name} (${(industry.confidence * 100).toFixed(0)}%)`);
  } else {
    justification.push(...gating.reasons);
  }

  // Overall problem type (legacy compatibility)
  let problemType = "unknown";
  if (targets.length > 0) {
    const best = targets[0];
    if (best.problem_type === "binary") problemType = "classification_binary";
    else if (best.problem_type === "class") problemType = "classification_multiclass";
    else problemType = "regression";
  }

  // Narrative
  const narrative = generateNarrative(
    status, targets, predictors, labels, totalRows, columns.length,
    projectName, businessGoal, industry, gating.reasons,
    features_blocked, leakage_flags
  );

  return {
    status,
    justification,
    modeling_contract: contract,
    removed_and_why: features_blocked,
    next_step: gating.blocked
      ? "Corrija os problemas listados acima: " + gating.reasons.join("; ")
      : null,
    // Legacy compatibility
    problem_type: problemType,
    suggested_problem_labels: [
      ...labels,
      { label: `__industry:${industry.label}:${industry.display_name}:${industry.confidence}`, relevance: 0 },
    ],
    suggested_targets: targets.slice(0, 5).map(t => ({
      column: t.base_column,
      type: t.problem_type,
      confidence: t.confidence,
      business_summary: t.business_summary,
      why_this_target: t.why_this_target,
      caveats: t.caveats,
    })),
    suggested_predictors: predictors.slice(0, 15),
    narrative,
    confidence: targets.length > 0 ? targets[0].confidence : 0,
    industry,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN SERVE
// ══════════════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id, dataset_id, force_refresh = false } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[infer-problem] project=${project_id} force=${force_refresh}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check for existing inference (unless force_refresh)
    if (!force_refresh) {
      const { data: existing } = await supabase
        .from("project_problem_inference")
        .select("*")
        .eq("project_id", project_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        // Also check for existing contract
        const { data: existingContract } = await supabase
          .from("project_modeling_contracts")
          .select("*")
          .eq("project_id", project_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        console.log("[infer-problem] Returning cached inference");
        return new Response(
          JSON.stringify({
            inference: existing,
            modeling_contract: existingContract,
            cached: true,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Fetch all needed data in parallel ──
    const [colsRes, numRes, catRes, projRes, datasetRes] = await Promise.all([
      supabase.from("project_columns").select("column_name, inferred_type, column_index").eq("project_id", project_id).order("column_index"),
      supabase.from("project_numeric_stats").select("*").eq("project_id", project_id),
      supabase.from("project_categorical_stats").select("*").eq("project_id", project_id),
      supabase.from("projects").select("name, description, business_objective, dataset_rows, total_rows, organization_id").eq("id", project_id).single(),
      supabase.from("project_datasets").select("id").eq("project_id", project_id).eq("is_active", true).maybeSingle(),
    ]);

    if (!colsRes.data || colsRes.data.length === 0) {
      return new Response(
        JSON.stringify({ error: "Nenhuma coluna encontrada. Execute o EDA primeiro." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const totalRows = projRes.data?.total_rows || projRes.data?.dataset_rows || 0;
    const orgId = projRes.data?.organization_id;
    const projectName = projRes.data?.name || "Dataset";
    const businessGoal = projRes.data?.business_objective || projRes.data?.description || "";

    const numStatsMap = new Map((numRes.data || []).map((s: any) => [s.column_name, s]));
    const catStatsMap = new Map((catRes.data || []).map((s: any) => [s.column_name, s]));

    // ── Run v3 inference engine ──
    const result = await runInferenceV3(
      colsRes.data, numStatsMap, catStatsMap, totalRows, projectName, businessGoal
    );

    console.log(`[infer-problem] Status=${result.status}, Industry=${result.industry.label}, targets=${result.suggested_targets.length}, features=${result.modeling_contract?.features_final.length || 0}`);

    // ── Persist column inference matrix ──
    try {
      await supabase.from("project_column_inference").delete().eq("project_id", project_id);

      // Re-run classification to get per-column data (already computed inside runInferenceV3)
      const classifications = classifyColumns(colsRes.data, numStatsMap, catStatsMap, totalRows);
      const anchorTimeCol = findAnchorTimeCol(classifications);
      const bestTargetCol = result.suggested_targets?.[0]?.column || null;

      const columnInferenceRows = classifications.map((cls) => {
        const numStat = numStatsMap.get(cls.column);
        const catStat = catStatsMap.get(cls.column);
        const distinctCount = catStat?.distinct_count || (numStat ? estimateDistinct(numStat, totalRows) : 0);
        const uniqueRatio = totalRows > 0 ? distinctCount / totalRows : 0;

        // Determine temporal role
        let temporalRole = "DESCONHECIDO";
        if (cls.role === "TEMPO") {
          temporalRole = cls.column === anchorTimeCol ? "PRE_EVENTO" : "DESCONHECIDO";
        } else if (cls.role === "DERIVADA_LEAKAGE") {
          temporalRole = "POS_EVENTO";
        } else if (matchesPatterns(cls.column, LEAKAGE_PATTERNS)) {
          temporalRole = "POS_EVENTO";
        }

        // Determine eligibility
        const canBeTarget =
          cls.role === "TARGET_CANDIDATO_EVENTO" ||
          cls.role === "TARGET_CANDIDATO_ESTADO" ||
          (cls.role === "MEDIDA_NUMERICA" && numStat?.std_value > 0);

        const blockedAsFeature =
          cls.role === "ID_TECNICO" ||
          cls.role === "DERIVADA_LEAKAGE" ||
          (numStat?.std_value === 0) ||
          (uniqueRatio > 0.2 && cls.role !== "DIMENSAO_NEGOCIO");

        const canBeFeature = !blockedAsFeature && cls.column !== bestTargetCol;

        // Collect block reasons
        const blockReasons: string[] = [];
        if (cls.role === "ID_TECNICO") blockReasons.push("ID técnico");
        if (cls.role === "DERIVADA_LEAKAGE") blockReasons.push("Leakage temporal");
        if (numStat?.std_value === 0) blockReasons.push("Variância zero (constante)");
        if (uniqueRatio > 0.2 && cls.role !== "DIMENSAO_NEGOCIO" && cls.role !== "MEDIDA_NUMERICA")
          blockReasons.push("Alta cardinalidade");
        if (cls.role === "TARGET_CANDIDATO_ESTADO" && !anchorTimeCol)
          blockReasons.push("Estado sem janela temporal");
        if (temporalRole === "POS_EVENTO") blockReasons.push("Coluna pós-evento");

        // Confidence
        let confidence = 0.7;
        if (cls.reasons.some(r => r.includes("LLM"))) confidence = 0.85;
        if (cls.role === "TARGET_CANDIDATO_EVENTO") confidence = 0.85;
        if (cls.role === "ID_TECNICO") confidence = 0.95;
        if (cls.role === "TEMPO") confidence = 0.90;
        if (cls.role === "DESCONHECIDO") confidence = 0.3;

        // Map semantic role for UI
        let semanticRole = cls.role as string;
        if (semanticRole === "TARGET_CANDIDATO_EVENTO") semanticRole = "TARGET_CANDIDATO_EVENTO";
        if (semanticRole === "TARGET_CANDIDATO_ESTADO") semanticRole = "TARGET_CANDIDATO_ESTADO";

        return {
          project_id,
          column_name: cls.column,
          inferred_type: cls.inferred_type,
          semantic_role: semanticRole,
          temporal_role: temporalRole,
          can_be_target: canBeTarget,
          can_be_feature: canBeFeature,
          block_reasons: blockReasons,
          confidence_score: Math.round(confidence * 1000) / 1000,
          classification_reasons: cls.reasons,
        };
      });

      if (columnInferenceRows.length > 0) {
        const { error: colInfErr } = await supabase
          .from("project_column_inference")
          .insert(columnInferenceRows);
        if (colInfErr) console.error("[infer-problem] Column inference insert error:", colInfErr);
        else console.log(`[infer-problem] Persisted ${columnInferenceRows.length} column inferences`);
      }
    } catch (colInfError) {
      console.error("[infer-problem] Column inference persistence error:", colInfError);
    }

    // ── Persist to project_problem_inference (legacy) ──
    const inferenceRecord = {
      organization_id: orgId,
      project_id,
      dataset_id: dataset_id || datasetRes.data?.id || null,
      inference_version: "v3",
      problem_type: result.problem_type,
      suggested_problem_labels: result.suggested_problem_labels,
      suggested_targets: result.suggested_targets,
      suggested_predictors: result.suggested_predictors,
      narrative: result.narrative,
      confidence: result.confidence,
    };

    await supabase.from("project_problem_inference").delete().eq("project_id", project_id);

    const { data: inserted, error: insertErr } = await supabase
      .from("project_problem_inference")
      .insert(inferenceRecord)
      .select()
      .single();

    if (insertErr) console.error("[infer-problem] Insert error:", insertErr);

    // ── Persist ModelingContract ──
    if (result.modeling_contract && orgId) {
      await supabase.from("project_modeling_contracts").delete().eq("project_id", project_id);

      const contractRecord = {
        project_id,
        organization_id: orgId,
        dataset_id: dataset_id || datasetRes.data?.id || null,
        status: result.status.toLowerCase(),
        contract_version: "v3",
        anchor_time_col: result.modeling_contract.anchor_time_col,
        entity_key: result.modeling_contract.entity_key,
        target_definition: result.modeling_contract.target_definition,
        split_strategy: result.modeling_contract.split_strategy,
        features_final: result.modeling_contract.features_final,
        features_blocked: result.modeling_contract.features_blocked,
        leakage_flags: result.modeling_contract.leakage_flags,
        column_roles: result.modeling_contract.column_roles,
        dashboard_gold_schema: result.modeling_contract.dashboard_gold_schema,
        blocked_reasons: result.status === "BLOCKED" ? result.justification : null,
        justification: result.justification,
        full_contract: result.modeling_contract,
      };

      const { error: contractErr } = await supabase
        .from("project_modeling_contracts")
        .insert(contractRecord);

      if (contractErr) console.error("[infer-problem] Contract insert error:", contractErr);
    }

    // ── Update project_ai_memory (cumulative) ──
    if (orgId) {
      try {
        const { data: existingMemory } = await supabase
          .from("project_ai_memory")
          .select("id, memory_json")
          .eq("project_id", project_id)
          .maybeSingle();

        const memoryJson = (existingMemory?.memory_json as Record<string, any>) || {};

        const history = Array.isArray(memoryJson.history) ? memoryJson.history : [];
        history.unshift({
          timestamp: new Date().toISOString(),
          inference_version: "v3",
          status: result.status,
          problem_type: result.problem_type,
          industry: result.industry.label,
          top_target: result.suggested_targets[0]?.column || null,
          confidence: result.confidence,
          labels: result.suggested_problem_labels.filter(l => !l.label.startsWith("__")).map(l => l.label),
          features_count: result.modeling_contract?.features_final.length || 0,
          leakage_count: result.modeling_contract?.leakage_flags.length || 0,
        });

        const updatedMemory = {
          ...memoryJson,
          industry_inference: {
            label: result.industry.label,
            display_name: result.industry.display_name,
            confidence: result.industry.confidence,
            evidence: result.industry.evidence,
          },
          problem_inference: {
            status: result.status,
            problem_type: result.problem_type,
            labels: result.suggested_problem_labels.filter(l => !l.label.startsWith("__")),
            top_targets: result.suggested_targets.slice(0, 3).map(t => ({
              column: t.column, type: t.type, confidence: t.confidence,
            })),
            top_predictors: result.suggested_predictors.slice(0, 5).map(p => p.column),
            narrative_preview: result.narrative.substring(0, 500),
          },
          modeling_contract_summary: result.modeling_contract ? {
            status: result.status,
            target: result.modeling_contract.target_definition.derived_target,
            split: result.modeling_contract.split_strategy,
            features_count: result.modeling_contract.features_final.length,
            anchor_time: result.modeling_contract.anchor_time_col,
          } : null,
          history: history.slice(0, 10),
        };

        if (existingMemory) {
          await supabase.from("project_ai_memory").update({ memory_json: updatedMemory }).eq("id", existingMemory.id);
        } else {
          await supabase.from("project_ai_memory").insert({
            organization_id: orgId, project_id, memory_json: updatedMemory,
          });
        }
      } catch (memErr) {
        console.error("[infer-problem] Memory update error:", memErr);
      }
    }

    // ── Append to project_ai_context ──
    try {
      await fetch(`${supabaseUrl}/functions/v1/append-project-context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
          apikey: supabaseServiceKey,
        },
        body: JSON.stringify({
          project_id,
          organization_id: orgId,
          stage: "targeting",
          payload: {
            inferred_industry: result.industry.label,
            industry_confidence: result.industry.confidence,
            inferred_problem_type: result.problem_type,
            contract_status: result.status,
            suggested_problems: result.suggested_problem_labels.filter(l => !l.label.startsWith("__")).map(l => l.label),
            top_target_suggestion: result.suggested_targets[0]?.column || "",
            top_predictors_count: result.suggested_predictors.length,
            features_final_count: result.modeling_contract?.features_final.length || 0,
            split_strategy: result.modeling_contract?.split_strategy || "unknown",
          },
        }),
      });
    } catch (ctxErr) {
      console.error("[infer-problem] Context append error:", ctxErr);
    }

    // Also append business_segment to EDA context
    try {
      await fetch(`${supabaseUrl}/functions/v1/append-project-context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
          apikey: supabaseServiceKey,
        },
        body: JSON.stringify({
          project_id,
          organization_id: orgId,
          stage: "eda",
          payload: {
            business_segment: {
              segment: result.industry.display_name,
              label: result.industry.label,
              confidence: result.industry.confidence,
              evidence: result.industry.evidence,
            },
            insight_text: result.suggested_problem_labels.filter(l => !l.label.startsWith("__")).map(l => l.label).join(", "),
          },
        }),
      });
    } catch (ctxEda) {
      console.error("[infer-problem] EDA context append error:", ctxEda);
    }

    // Build response
    const responseData = {
      inference: inserted || inferenceRecord,
      modeling_contract: result.modeling_contract,
      contract_status: result.status,
      justification: result.justification,
      removed_and_why: result.removed_and_why,
      next_step: result.next_step,
      industry: result.industry,
      cached: false,
    };

    return new Response(
      JSON.stringify(responseData),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[infer-problem] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
