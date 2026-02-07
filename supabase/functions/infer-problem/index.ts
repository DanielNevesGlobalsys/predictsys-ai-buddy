import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ══════════════════════════════════════════════════════════════════════
//  INDUSTRY / VERTICAL DETECTION
// ══════════════════════════════════════════════════════════════════════

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

  // Scan column names
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

  // Scan categorical sample values
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

  // Find best industry
  let bestLabel: IndustryLabel = "generic";
  let bestScore = 0;
  for (const [label, data] of Object.entries(scores)) {
    if (label === "generic") continue;
    if (data.score > bestScore) {
      bestScore = data.score;
      bestLabel = label as IndustryLabel;
    }
  }

  // Confidence: normalize based on evidence count
  const evidenceCount = scores[bestLabel].evidence.length;
  let confidence = Math.min(1, bestScore / 8);
  if (evidenceCount >= 5) confidence = Math.max(confidence, 0.8);
  else if (evidenceCount >= 3) confidence = Math.max(confidence, 0.6);

  if (confidence < 0.4) {
    return {
      label: "generic",
      display_name: INDUSTRY_DISPLAY.generic,
      confidence: 0.3,
      evidence: [],
    };
  }

  return {
    label: bestLabel,
    display_name: INDUSTRY_DISPLAY[bestLabel],
    confidence: Math.round(confidence * 100) / 100,
    evidence: scores[bestLabel].evidence.slice(0, 8),
  };
}

// ══════════════════════════════════════════════════════════════════════
//  COLUMN PATTERN DICTIONARIES
// ══════════════════════════════════════════════════════════════════════

const CHURN_PATTERNS = [
  "churn", "cancel", "cancelado", "cancelamento", "evasao", "evasão",
  "dropout", "quit", "inactive", "inativo", "desligado", "saida", "saída",
  "status_ativo", "status_contrato", "ativo", "churned", "trancamento",
  "desistencia", "desistência",
];

const PROPENSITY_PATTERNS = [
  "compra", "purchase", "convert", "conversao", "conversão", "lead",
  "signup", "matricula", "matrícula", "captacao", "captação", "propensao",
  "opt_in", "aceite", "contratou", "rematricula", "rematrícula",
];

const REVENUE_PATTERNS = [
  "revenue", "receita", "faturamento", "valor", "ticket", "ltv",
  "valor_compra", "sales", "vendas", "montante", "total_compras",
  "valor_total", "amount", "price", "preco", "preço", "aluguel",
  "mensalidade",
];

const RISK_PATTERNS = [
  "delay", "atraso", "inadimplencia", "inadimplência", "default",
  "risco", "score", "fraude", "fraud", "irregularidade", "sinistro",
  "pdd", "provisao", "provisão", "delinquency",
];

const DEMAND_PATTERNS = [
  "demanda", "demand", "quantidade", "quantity", "volume", "ocupacao",
  "ocupação", "estoque", "stock", "pedidos", "orders", "fluxo",
];

const TIME_PATTERNS = [
  "dt_", "date", "created_at", "last_purchase", "data_compra",
  "data_", "timestamp", "updated_at", "first_", "last_", "ultima_",
  "dt_nascimento", "data_matricula", "data_internacao", "data_entrega",
];

const ID_PATTERNS = [
  "id", "uuid", "row_id", "index", "cpf", "cnpj", "codigo", "código",
  "hash", "token", "key", "chave",
];

// ══════════════════════════════════════════════════════════════════════
//  VERTICAL-SPECIFIC PROBLEM TEMPLATES
// ══════════════════════════════════════════════════════════════════════

interface VerticalProblem {
  label: string;
  patterns: string[];
  type: "binary" | "class" | "regression";
  summary: string;
}

const VERTICAL_PROBLEMS: Record<IndustryLabel, VerticalProblem[]> = {
  education: [
    { label: "Evasão de Alunos", patterns: ["evasao", "evasão", "dropout", "trancamento", "desistencia", "desistência", "cancelado"], type: "binary", summary: "Prever quais alunos têm maior risco de abandonar o curso, permitindo intervenções pedagógicas e financeiras preventivas." },
    { label: "Rematrícula", patterns: ["rematricula", "rematrícula", "renovacao", "renovação", "matricula"], type: "binary", summary: "Prever a probabilidade de renovação de matrícula para planejar captação e retenção." },
    { label: "Inadimplência Acadêmica", patterns: ["inadimplencia", "inadimplência", "default", "atraso", "pagamento"], type: "binary", summary: "Identificar alunos com risco de inadimplência para ações preventivas de cobrança." },
    { label: "Performance Acadêmica", patterns: ["nota", "notas", "cr", "coeficiente", "media", "média", "gpa"], type: "regression", summary: "Estimar o desempenho acadêmico do aluno para intervenções pedagógicas personalizadas." },
  ],
  retail_shopping: [
    { label: "Churn de Lojistas", patterns: ["churn", "cancel", "saida", "saída", "desligado", "inativo"], type: "binary", summary: "Prever quais lojistas têm risco de encerrar contrato, permitindo ações comerciais de retenção." },
    { label: "Inadimplência de Lojistas", patterns: ["inadimplencia", "inadimplência", "atraso", "default"], type: "binary", summary: "Identificar lojistas com risco de atraso no aluguel para negociação preventiva." },
    { label: "Previsão de Faturamento", patterns: ["faturamento", "receita", "vendas", "revenue", "ticket"], type: "regression", summary: "Estimar receita futura para planejamento financeiro e metas comerciais." },
    { label: "Propensão à Compra", patterns: ["compra", "purchase", "conversao", "conversão", "lead"], type: "binary", summary: "Prever quais clientes têm maior propensão à compra para campanhas direcionadas." },
  ],
  healthcare: [
    { label: "Readmissão Hospitalar", patterns: ["readmissao", "readmissão", "readmission", "reinternacao", "reinternação"], type: "binary", summary: "Prever quais pacientes têm risco de retorno não planejado ao hospital." },
    { label: "No-show em Consultas", patterns: ["no_show", "noshow", "falta", "ausencia", "ausência"], type: "binary", summary: "Identificar pacientes com risco de não comparecer à consulta para ações de confirmação." },
    { label: "Tempo de Internação", patterns: ["internacao", "internação", "permanencia", "permanência", "leito", "dias"], type: "regression", summary: "Estimar a duração da internação para otimização de leitos e recursos." },
    { label: "Custo por Paciente", patterns: ["custo", "cost", "valor", "despesa", "gasto"], type: "regression", summary: "Prever o custo total do tratamento para planejamento financeiro hospitalar." },
  ],
  logistics: [
    { label: "Atraso de Entrega", patterns: ["atraso", "delay", "atrasado", "pontualidade", "sla"], type: "binary", summary: "Prever entregas com risco de atraso para realocação de rotas e comunicação proativa." },
    { label: "Lead Time", patterns: ["lead_time", "leadtime", "tempo_entrega", "prazo"], type: "regression", summary: "Estimar o tempo de entrega para melhorar promessas ao cliente e planejamento logístico." },
    { label: "Devolução", patterns: ["devolucao", "devolução", "retorno", "return", "reversa"], type: "binary", summary: "Prever quais pedidos têm maior risco de devolução para otimização da cadeia reversa." },
    { label: "Demanda / Estoque", patterns: ["demanda", "demand", "estoque", "stock", "ruptura"], type: "regression", summary: "Prever volumes futuros para evitar ruptura de estoque e otimizar reposição." },
  ],
  financial: [
    { label: "Inadimplência / Default", patterns: ["inadimplencia", "inadimplência", "default", "atraso", "pdd"], type: "binary", summary: "Prever quais clientes têm maior risco de não pagar, permitindo ações de cobrança e provisionamento." },
    { label: "Score de Crédito", patterns: ["score", "rating", "credito", "crédito", "risco"], type: "regression", summary: "Estimar o score de crédito para decisões de aprovação e precificação de risco." },
    { label: "Churn Financeiro", patterns: ["churn", "cancel", "encerramento", "saida", "saída"], type: "binary", summary: "Prever quais clientes podem encerrar relacionamento bancário para ações de retenção." },
    { label: "LTV / Valor do Cliente", patterns: ["ltv", "lifetime", "valor_cliente", "receita", "revenue"], type: "regression", summary: "Estimar o valor futuro do cliente para estratégias de cross-sell e up-sell." },
  ],
  generic: [
    { label: "Churn / Evasão", patterns: CHURN_PATTERNS, type: "binary", summary: "Prever quais entidades têm maior risco de saída ou cancelamento." },
    { label: "Propensão / Conversão", patterns: PROPENSITY_PATTERNS, type: "binary", summary: "Prever a probabilidade de conversão ou adesão." },
    { label: "Previsão de Receita", patterns: REVENUE_PATTERNS, type: "regression", summary: "Estimar valores futuros para planejamento financeiro." },
    { label: "Risco / Inadimplência", patterns: RISK_PATTERNS, type: "binary", summary: "Identificar registros com maior risco." },
    { label: "Previsão de Demanda", patterns: DEMAND_PATTERNS, type: "regression", summary: "Estimar volumes futuros para otimização de recursos." },
  ],
};

// ══════════════════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════════════════

type ProblemType =
  | "classification_binary"
  | "classification_multiclass"
  | "regression"
  | "time_to_event"
  | "ranking_recommendation"
  | "unknown";

interface SuggestedTarget {
  column: string;
  type: "binary" | "class" | "regression";
  confidence: number;
  business_summary: string;
  why_this_target: string;
  caveats: string[];
}

interface SuggestedPredictor {
  column: string;
  score: number;
  reason: string;
}

interface ProblemLabel {
  label: string;
  relevance: number;
}

interface InferenceResult {
  problem_type: ProblemType;
  suggested_problem_labels: ProblemLabel[];
  suggested_targets: SuggestedTarget[];
  suggested_predictors: SuggestedPredictor[];
  narrative: string;
  confidence: number;
  industry: IndustryInference;
}

// ══════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════

function matchesPatterns(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function isIdColumn(name: string, uniqueCount: number, totalRows: number): boolean {
  const lower = name.toLowerCase();
  if (lower === "id" || lower.endsWith("_id") || lower.startsWith("id_")) return true;
  if (ID_PATTERNS.some((p) => lower === p || lower.startsWith(p + "_"))) return true;
  if (uniqueCount >= totalRows * 0.9 && totalRows > 10) return true;
  return false;
}

function isDateColumn(name: string): boolean {
  return matchesPatterns(name, TIME_PATTERNS);
}

function addLabel(labels: ProblemLabel[], set: Set<string>, label: string, relevance: number) {
  if (!set.has(label)) {
    set.add(label);
    labels.push({ label, relevance });
  }
}

function estimateDistinct(numStat: any, totalRows: number): number {
  if (!numStat || numStat.max_value === null || numStat.min_value === null) return 0;
  const range = numStat.max_value - numStat.min_value;
  if (range === 0) return 1;
  if (range === 1 && numStat.min_value === 0) return 2;
  return Math.min(totalRows, Math.max(20, Math.ceil(range)));
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN INFERENCE ENGINE
// ══════════════════════════════════════════════════════════════════════

function runInference(
  columns: any[],
  numStats: Map<string, any>,
  catStats: Map<string, any>,
  totalRows: number,
  projectName: string,
  businessGoal: string
): InferenceResult {
  // ── Step 1: Detect industry vertical ──────────────────────────────
  const industry = detectIndustry(columns, catStats);
  console.log(`[infer-problem] Industry: ${industry.label} (${industry.confidence}), evidence: ${industry.evidence.join(", ")}`);

  // Get vertical-specific problem templates
  const verticalProblems = VERTICAL_PROBLEMS[industry.label] || VERTICAL_PROBLEMS.generic;

  const targets: SuggestedTarget[] = [];
  const predictors: SuggestedPredictor[] = [];
  const labels: ProblemLabel[] = [];
  const labelSet = new Set<string>();

  // ── Step 2: Match columns against vertical problems ───────────────
  for (const col of columns) {
    const name = col.column_name;
    const type = col.inferred_type;
    const numStat = numStats.get(name);
    const catStat = catStats.get(name);

    const distinctCount = catStat?.distinct_count ||
      (numStat ? estimateDistinct(numStat, totalRows) : 0);

    if (isIdColumn(name, distinctCount, totalRows)) continue;
    if (isDateColumn(name)) continue;
    if (numStat && numStat.null_count / Math.max(totalRows, 1) > 0.8) continue;

    const nullRate = numStat
      ? numStat.null_count / Math.max(totalRows, 1)
      : 0;

    // ── Binary classification (2 distinct values) ───────────────────
    if (distinctCount === 2) {
      let bestMatch: VerticalProblem | null = null;
      let matchedGeneric = false;

      // First try vertical-specific patterns
      for (const vp of verticalProblems) {
        if (vp.type === "binary" && matchesPatterns(name, vp.patterns)) {
          bestMatch = vp;
          break;
        }
      }

      // Fallback to generic patterns
      if (!bestMatch) {
        for (const gp of VERTICAL_PROBLEMS.generic) {
          if (gp.type === "binary" && matchesPatterns(name, gp.patterns)) {
            bestMatch = gp;
            matchedGeneric = true;
            break;
          }
        }
      }

      let businessLabel = "Classificação Binária";
      let summary = `Prever a probabilidade de cada registro pertencer a uma das duas classes de "${name}".`;
      let why = `Coluna binária com apenas 2 valores distintos e ${(nullRate * 100).toFixed(1)}% de nulos.`;
      let confidence = 0.75;

      if (bestMatch) {
        businessLabel = bestMatch.label;
        summary = bestMatch.summary;
        why = `Coluna "${name}" apresenta padrão de ${bestMatch.label.toLowerCase()} com 2 valores distintos.`;
        confidence = matchedGeneric ? 0.82 : 0.90;
        addLabel(labels, labelSet, bestMatch.label, matchedGeneric ? 0.85 : 0.95);
      }

      // Check imbalance
      const caveats: string[] = [];
      if (catStat?.top_categories) {
        const topCats = catStat.top_categories as Array<{ category: string; count: number }>;
        const totalCount = topCats.reduce((s: number, c: any) => s + (c.count || 0), 0);
        if (totalCount > 0) {
          const maxPct = Math.max(...topCats.map((c: any) => (c.count || 0) / totalCount));
          if (maxPct > 0.95) {
            caveats.push(`Desbalanceamento severo: classe dominante com ${(maxPct * 100).toFixed(0)}%.`);
            confidence *= 0.8;
          } else if (maxPct > 0.85) {
            caveats.push(`Desbalanceamento: classe majoritária com ${(maxPct * 100).toFixed(0)}%.`);
          }
        }
      }
      if (nullRate > 0.05) caveats.push(`${(nullRate * 100).toFixed(1)}% de valores nulos.`);

      targets.push({
        column: name,
        type: "binary",
        confidence,
        business_summary: `${businessLabel}: ${summary}`,
        why_this_target: why,
        caveats,
      });
    }

    // ── Multiclass classification (3–20 classes) ────────────────────
    else if (
      (type === "categórico" || type === "texto" || type === "categorical") &&
      distinctCount >= 3 &&
      distinctCount <= 20
    ) {
      const confidence = distinctCount <= 5 ? 0.75 : distinctCount <= 10 ? 0.65 : 0.55;
      const caveats: string[] = [];
      if (nullRate > 0.05) caveats.push(`${(nullRate * 100).toFixed(1)}% de valores nulos.`);
      if (distinctCount > 10) caveats.push(`${distinctCount} classes podem reduzir a acurácia.`);

      targets.push({
        column: name,
        type: "class",
        confidence,
        business_summary: `Classificação Multiclasse: Segmentar registros em ${distinctCount} categorias de "${name}" para priorização e estratégias diferenciadas.`,
        why_this_target: `Coluna categórica com ${distinctCount} classes bem definidas.`,
        caveats,
      });
      addLabel(labels, labelSet, "Segmentação", 0.7);
    }

    // ── Regression (continuous numeric) ─────────────────────────────
    else if (
      (type === "numérico" || type === "numeric") &&
      distinctCount > 20 &&
      numStat
    ) {
      let bestMatch: VerticalProblem | null = null;
      let matchedGeneric = false;

      // Try vertical-specific regression patterns
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
            matchedGeneric = true;
            break;
          }
        }
      }

      let confidence = distinctCount > 100 ? 0.8 : 0.65;
      let summary = `Regressão: Prever o valor de "${name}" para planejamento e otimização.`;
      let why = `Coluna numérica contínua com ${distinctCount} valores distintos (range: ${numStat.min_value?.toFixed(2)} a ${numStat.max_value?.toFixed(2)}).`;

      if (bestMatch) {
        summary = `${bestMatch.label}: ${bestMatch.summary}`;
        why = `Coluna "${name}" apresenta padrão de ${bestMatch.label.toLowerCase()} com variação contínua.`;
        confidence = matchedGeneric ? 0.82 : 0.88;
        addLabel(labels, labelSet, bestMatch.label, matchedGeneric ? 0.85 : 0.92);
      }

      const caveats: string[] = [];
      if (numStat.std_value && numStat.mean_value && numStat.mean_value !== 0) {
        const cv = Math.abs(numStat.std_value / numStat.mean_value);
        if (cv > 3) caveats.push("Alta variabilidade (CV > 3). Considere transformação log.");
      }
      if (nullRate > 0.05) caveats.push(`${(nullRate * 100).toFixed(1)}% de valores nulos.`);

      targets.push({
        column: name,
        type: "regression",
        confidence,
        business_summary: summary,
        why_this_target: why,
        caveats,
      });
    }
  }

  // Sort targets by confidence
  targets.sort((a, b) => b.confidence - a.confidence);

  // ── Step 3: Score predictors ──────────────────────────────────────
  const targetNames = new Set(targets.map((t) => t.column));

  for (const col of columns) {
    const name = col.column_name;
    if (targetNames.has(name)) continue;

    const numStat = numStats.get(name);
    const catStat = catStats.get(name);
    const distinctCount = catStat?.distinct_count ||
      (numStat ? estimateDistinct(numStat, totalRows) : 0);

    if (isIdColumn(name, distinctCount, totalRows)) continue;

    const nullRate = numStat
      ? numStat.null_count / Math.max(totalRows, 1)
      : 0;

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

    // Date columns are valuable
    if (isDateColumn(name)) {
      score += 0.15;
      reasons.push("sinal temporal (recência/frequência)");
    }

    // Numeric with good variance
    if (numStat && numStat.std_value && numStat.std_value > 0) {
      score += 0.15;
      reasons.push("variância adequada");
    }

    // Categorical with reasonable cardinality
    if (catStat && catStat.distinct_count >= 2 && catStat.distinct_count <= 50) {
      score += 0.1;
      reasons.push(`cardinalidade adequada (${catStat.distinct_count})`);
    } else if (catStat && catStat.distinct_count > 50 && catStat.distinct_count < totalRows * 0.5) {
      score += 0.05;
      reasons.push("cardinalidade moderada");
    } else if (catStat && catStat.distinct_count > totalRows * 0.5) {
      score -= 0.2;
      reasons.push("cardinalidade muito alta");
    }

    // Revenue/ticket/frequency columns are strong predictors
    if (matchesPatterns(name, REVENUE_PATTERNS)) {
      score += 0.2;
      reasons.push("variável financeira");
    }

    // Demand columns
    if (matchesPatterns(name, DEMAND_PATTERNS)) {
      score += 0.1;
      reasons.push("variável de volume/demanda");
    }

    score = Math.max(0, Math.min(1, score));

    if (score > 0.2) {
      predictors.push({
        column: name,
        score,
        reason: reasons.join("; ") || "variável disponível",
      });
    }
  }

  // Sort and limit predictors
  predictors.sort((a, b) => b.score - a.score);
  const topPredictors = predictors.slice(0, 15);

  // ── Step 4: Determine overall problem type ────────────────────────
  let problemType: ProblemType = "unknown";
  let overallConfidence = 0;

  if (targets.length > 0) {
    const best = targets[0];
    overallConfidence = best.confidence;
    if (best.type === "binary") problemType = "classification_binary";
    else if (best.type === "class") problemType = "classification_multiclass";
    else if (best.type === "regression") problemType = "regression";
  }

  // ── Step 5: Generate narrative ────────────────────────────────────
  const narrative = generateNarrative(
    targets,
    topPredictors,
    labels,
    totalRows,
    columns.length,
    projectName,
    businessGoal,
    industry
  );

  return {
    problem_type: problemType,
    suggested_problem_labels: labels.sort((a, b) => b.relevance - a.relevance).slice(0, 5),
    suggested_targets: targets.slice(0, 5),
    suggested_predictors: topPredictors,
    narrative,
    confidence: overallConfidence,
    industry,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  NARRATIVE GENERATOR
// ══════════════════════════════════════════════════════════════════════

function generateNarrative(
  targets: SuggestedTarget[],
  predictors: SuggestedPredictor[],
  labels: ProblemLabel[],
  totalRows: number,
  totalCols: number,
  projectName: string,
  businessGoal: string,
  industry: IndustryInference
): string {
  const lines: string[] = [];

  lines.push(`## Análise do Dataset "${projectName}"`);
  lines.push("");

  // Industry detection
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

  // What seems predictable
  if (labels.length > 0) {
    lines.push("### 🔍 O que parece ser previsível aqui");
    lines.push("");
    const topLabels = labels.slice(0, 3).map((l) => `**${l.label}**`).join(", ");
    lines.push(`Com base nos padrões estatísticos do EDA, os dados sugerem problemas de ${topLabels}.`);

    // Industry-specific didactic text
    if (industry.label === "education") {
      lines.push("Este dataset apresenta características típicas do setor educacional, onde modelos preditivos podem antecipar evasão, melhorar captação e otimizar a gestão acadêmica.");
    } else if (industry.label === "retail_shopping") {
      lines.push("Os dados possuem perfil de varejo/shopping, onde predições podem impactar retenção de lojistas, otimização de mix comercial e planejamento de receita.");
    } else if (industry.label === "healthcare") {
      lines.push("O perfil dos dados é compatível com o setor de saúde, onde modelos preditivos ajudam a reduzir readmissões, otimizar leitos e antecipar custos.");
    } else if (industry.label === "logistics") {
      lines.push("Os dados têm perfil logístico, onde predições podem melhorar pontualidade de entregas, reduzir devoluções e otimizar estoques.");
    } else if (industry.label === "financial") {
      lines.push("O dataset apresenta perfil financeiro/crédito, onde modelos preditivos auxiliam na gestão de risco, aprovação de crédito e prevenção de inadimplência.");
    }
    lines.push("");
  }

  // Target suggestions
  if (targets.length > 0) {
    lines.push("### 🎯 Sugestões de variável alvo");
    lines.push("");
    for (const t of targets.slice(0, 3)) {
      const typeLabel = t.type === "binary" ? "classificação binária" : t.type === "class" ? "classificação multiclasse" : "regressão";
      lines.push(`- **${t.column}** (${typeLabel}, confiança: ${(t.confidence * 100).toFixed(0)}%)`);
      lines.push(`  ${t.business_summary}`);
      if (t.caveats.length > 0) {
        lines.push(`  ⚠️ ${t.caveats[0]}`);
      }
    }
    lines.push("");
  }

  // Predictors
  if (predictors.length > 0) {
    lines.push("### 📊 Principais colunas que ajudam na predição");
    lines.push("");
    for (const p of predictors.slice(0, 5)) {
      lines.push(`- **${p.column}** — ${p.reason}`);
    }
    lines.push("");
  }

  // Business value
  if (targets.length > 0) {
    lines.push("### 💡 Por que isso é útil pro negócio");
    lines.push("");
    const best = targets[0];
    if (best.type === "binary" || best.type === "class") {
      lines.push("Com um modelo de classificação, é possível **antecipar eventos** e tomar ações preventivas — como campanhas de retenção, priorização de leads ou alertas de risco — antes que o evento aconteça.");
    } else {
      lines.push("Com um modelo de regressão, é possível **estimar valores futuros** como receita, demanda ou volumes — permitindo planejamento financeiro, otimização de recursos e cenários de simulação.");
    }
    lines.push("");
    lines.push("⚠️ *Estas são inferências baseadas em evidência estatística, não verdades absolutas. Você pode revisar e ajustar qualquer sugestão.*");
  }

  return lines.join("\n");
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
        console.log("[infer-problem] Returning cached inference");
        return new Response(
          JSON.stringify({ inference: existing, cached: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Fetch all needed data in parallel ────────────────────────────
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

    // ── Run inference engine ────────────────────────────────────────
    const result = runInference(
      colsRes.data,
      numStatsMap,
      catStatsMap,
      totalRows,
      projectName,
      businessGoal
    );

    console.log(`[infer-problem] Industry=${result.industry.label} (${result.industry.confidence}), targets=${result.suggested_targets.length}, predictors=${result.suggested_predictors.length}, type=${result.problem_type}`);

    // ── Persist to project_problem_inference ─────────────────────────
    const inferenceRecord = {
      organization_id: orgId,
      project_id,
      dataset_id: dataset_id || datasetRes.data?.id || null,
      inference_version: "v2",
      problem_type: result.problem_type,
      suggested_problem_labels: [
        ...result.suggested_problem_labels,
        // Include industry info in labels for frontend
        { label: `__industry:${result.industry.label}:${result.industry.display_name}:${result.industry.confidence}`, relevance: 0 },
      ],
      suggested_targets: result.suggested_targets,
      suggested_predictors: result.suggested_predictors,
      narrative: result.narrative,
      confidence: result.confidence,
    };

    // Upsert: delete old inferences for this project, then insert
    await supabase
      .from("project_problem_inference")
      .delete()
      .eq("project_id", project_id);

    const { data: inserted, error: insertErr } = await supabase
      .from("project_problem_inference")
      .insert(inferenceRecord)
      .select()
      .single();

    if (insertErr) {
      console.error("[infer-problem] Insert error:", insertErr);
    }

    // ── Update project_ai_memory (cumulative) ───────────────────────
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
          inference_version: "v2",
          problem_type: result.problem_type,
          industry: result.industry.label,
          top_target: result.suggested_targets[0]?.column || null,
          confidence: result.confidence,
          labels: result.suggested_problem_labels.map((l) => l.label),
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
            problem_type: result.problem_type,
            labels: result.suggested_problem_labels,
            top_targets: result.suggested_targets.slice(0, 3).map((t) => ({
              column: t.column,
              type: t.type,
              confidence: t.confidence,
            })),
            top_predictors: result.suggested_predictors.slice(0, 5).map((p) => p.column),
            narrative_preview: result.narrative.substring(0, 500),
          },
          history: history.slice(0, 10),
        };

        if (existingMemory) {
          await supabase
            .from("project_ai_memory")
            .update({ memory_json: updatedMemory })
            .eq("id", existingMemory.id);
        } else {
          await supabase.from("project_ai_memory").insert({
            organization_id: orgId,
            project_id,
            memory_json: updatedMemory,
          });
        }
      } catch (memErr) {
        console.error("[infer-problem] Memory update error:", memErr);
      }
    }

    // ── Also append to project_ai_context for cumulative flow ───────
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
            suggested_problems: result.suggested_problem_labels.map((l) => l.label),
            top_target_suggestion: result.suggested_targets[0]?.column || "",
            top_predictors_count: result.suggested_predictors.length,
          },
        }),
      });
    } catch (ctxErr) {
      console.error("[infer-problem] Context append error:", ctxErr);
    }

    // Build response with industry info included at top level
    const responseData = {
      inference: inserted || inferenceRecord,
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
