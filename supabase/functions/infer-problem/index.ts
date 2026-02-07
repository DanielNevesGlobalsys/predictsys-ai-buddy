import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Column name pattern dictionaries ────────────────────────────────
const CHURN_PATTERNS = [
  "churn", "cancel", "cancelado", "cancelamento", "evasao", "evasão",
  "dropout", "quit", "inactive", "inativo", "desligado", "saida", "saída",
  "status_ativo", "status_contrato", "ativo", "churned",
];

const PROPENSITY_PATTERNS = [
  "compra", "purchase", "convert", "conversao", "conversão", "lead",
  "signup", "matricula", "matrícula", "captacao", "captação", "propensao",
  "opt_in", "aceite", "contratou",
];

const REVENUE_PATTERNS = [
  "revenue", "receita", "faturamento", "valor", "ticket", "ltv",
  "valor_compra", "sales", "vendas", "montante", "total_compras",
  "valor_total", "amount", "price", "preco", "preço",
];

const RISK_PATTERNS = [
  "delay", "atraso", "inadimplencia", "inadimplência", "default",
  "risco", "score", "fraude", "fraud", "irregularidade", "sinistro",
];

const DEMAND_PATTERNS = [
  "demanda", "demand", "quantidade", "quantity", "volume", "ocupacao",
  "ocupação", "estoque", "stock", "pedidos", "orders",
];

const TIME_PATTERNS = [
  "dt_", "date", "created_at", "last_purchase", "data_compra",
  "data_", "timestamp", "updated_at", "first_", "last_", "ultima_",
];

const ID_PATTERNS = [
  "id", "uuid", "row_id", "index", "cpf", "cnpj", "codigo", "código",
  "hash", "token", "key", "chave",
];

// ── Problem type enum ───────────────────────────────────────────────
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
}

// ── Helpers ─────────────────────────────────────────────────────────
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

// ── Main Inference Engine ───────────────────────────────────────────
function runInference(
  columns: any[],
  numStats: Map<string, any>,
  catStats: Map<string, any>,
  totalRows: number,
  projectName: string,
  businessGoal: string
): InferenceResult {
  const targets: SuggestedTarget[] = [];
  const predictors: SuggestedPredictor[] = [];
  const labels: ProblemLabel[] = [];
  const labelSet = new Set<string>();

  // ── Pass 1: Identify targets ──────────────────────────────────────
  for (const col of columns) {
    const name = col.column_name;
    const type = col.inferred_type;
    const numStat = numStats.get(name);
    const catStat = catStats.get(name);

    // Skip ID-like and date columns as targets
    const distinctCount = catStat?.distinct_count ||
      (numStat ? estimateDistinct(numStat, totalRows) : 0);

    if (isIdColumn(name, distinctCount, totalRows)) continue;
    if (isDateColumn(name)) continue;
    if (numStat && numStat.null_count / Math.max(totalRows, 1) > 0.8) continue;

    const nullRate = numStat
      ? numStat.null_count / Math.max(totalRows, 1)
      : 0;

    // ── Binary classification (0/1, yes/no, true/false, status) ───
    if (distinctCount === 2) {
      const isChurn = matchesPatterns(name, CHURN_PATTERNS);
      const isPropensity = matchesPatterns(name, PROPENSITY_PATTERNS);
      const isRisk = matchesPatterns(name, RISK_PATTERNS);

      let businessLabel = "Classificação Binária";
      let summary = `Prever a probabilidade de cada registro pertencer a uma das duas classes de "${name}".`;
      let why = `Coluna binária com apenas 2 valores e ${(nullRate * 100).toFixed(1)}% de nulos.`;
      let confidence = 0.8;

      if (isChurn) {
        businessLabel = "Churn / Evasão";
        summary = "Prever quais clientes/entidades têm maior risco de sair ou cancelar, permitindo ações preventivas de retenção.";
        why = `Coluna "${name}" apresenta padrão típico de churn com 2 valores distintos.`;
        confidence = 0.92;
        addLabel(labels, labelSet, "Churn", 0.95);
        addLabel(labels, labelSet, "Retenção", 0.8);
      } else if (isPropensity) {
        businessLabel = "Propensão";
        summary = "Prever a probabilidade de conversão ou adesão, permitindo priorizar leads ou campanhas.";
        why = `Coluna "${name}" indica evento de conversão com 2 valores distintos.`;
        confidence = 0.88;
        addLabel(labels, labelSet, "Propensão à Compra", 0.9);
        addLabel(labels, labelSet, "Conversão", 0.85);
      } else if (isRisk) {
        businessLabel = "Risco / Inadimplência";
        summary = "Identificar registros com maior risco de inadimplência, fraude ou irregularidade.";
        why = `Coluna "${name}" apresenta padrão de risco/fraude com 2 classes.`;
        confidence = 0.85;
        addLabel(labels, labelSet, "Risco", 0.9);
        addLabel(labels, labelSet, "Inadimplência", 0.8);
      }

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

    // ── Multiclass classification (3-20 classes) ────────────────
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

    // ── Regression (continuous numeric) ──────────────────────────
    else if (
      (type === "numérico" || type === "numeric") &&
      distinctCount > 20 &&
      numStat
    ) {
      const isRevenue = matchesPatterns(name, REVENUE_PATTERNS);
      const isDemand = matchesPatterns(name, DEMAND_PATTERNS);
      let confidence = distinctCount > 100 ? 0.8 : 0.65;
      let summary = `Regressão: Prever o valor de "${name}" para planejamento e otimização.`;
      let why = `Coluna numérica contínua com ${distinctCount} valores distintos (range: ${numStat.min_value?.toFixed(2)} a ${numStat.max_value?.toFixed(2)}).`;

      if (isRevenue) {
        summary = "Previsão de Receita/Valor: Estimar receita, ticket médio ou valor de transação para planejamento financeiro.";
        why = `Coluna "${name}" apresenta padrão de variável financeira contínua.`;
        confidence = 0.85;
        addLabel(labels, labelSet, "Previsão de Receita", 0.9);
        addLabel(labels, labelSet, "LTV", 0.7);
      } else if (isDemand) {
        summary = "Previsão de Demanda: Estimar volumes para otimização de estoque e capacidade.";
        why = `Coluna "${name}" representa volume/demanda com variação contínua.`;
        confidence = 0.82;
        addLabel(labels, labelSet, "Previsão de Demanda", 0.85);
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

  // ── Pass 2: Score predictors ──────────────────────────────────────
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

    // Date columns are valuable but need transformation
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

  // ── Determine overall problem type ────────────────────────────────
  let problemType: ProblemType = "unknown";
  let overallConfidence = 0;

  if (targets.length > 0) {
    const best = targets[0];
    overallConfidence = best.confidence;
    if (best.type === "binary") problemType = "classification_binary";
    else if (best.type === "class") problemType = "classification_multiclass";
    else if (best.type === "regression") problemType = "regression";
  }

  // ── Generate narrative ────────────────────────────────────────────
  const narrative = generateNarrative(
    targets,
    topPredictors,
    labels,
    totalRows,
    columns.length,
    projectName,
    businessGoal
  );

  return {
    problem_type: problemType,
    suggested_problem_labels: labels.sort((a, b) => b.relevance - a.relevance).slice(0, 5),
    suggested_targets: targets.slice(0, 5),
    suggested_predictors: topPredictors,
    narrative,
    confidence: overallConfidence,
  };
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

function generateNarrative(
  targets: SuggestedTarget[],
  predictors: SuggestedPredictor[],
  labels: ProblemLabel[],
  totalRows: number,
  totalCols: number,
  projectName: string,
  businessGoal: string
): string {
  const lines: string[] = [];

  lines.push(`## Análise do Dataset "${projectName}"`);
  lines.push("");

  if (businessGoal) {
    lines.push(`**Objetivo declarado:** ${businessGoal}`);
    lines.push("");
  }

  lines.push(`O dataset contém **${totalRows.toLocaleString("pt-BR")} registros** com **${totalCols} colunas**.`);
  lines.push("");

  // What seems predictable
  if (labels.length > 0) {
    lines.push("### O que parece ser previsível aqui");
    lines.push("");
    const topLabels = labels.slice(0, 3).map((l) => `**${l.label}**`).join(", ");
    lines.push(`Os padrões dos dados sugerem problemas de ${topLabels}.`);
    lines.push("");
  }

  // Target suggestions
  if (targets.length > 0) {
    lines.push("### Sugestões de variável alvo");
    lines.push("");
    for (const t of targets.slice(0, 3)) {
      lines.push(`- **${t.column}** (${t.type === "binary" ? "classificação binária" : t.type === "class" ? "classificação" : "regressão"}, confiança: ${(t.confidence * 100).toFixed(0)}%)`);
      lines.push(`  ${t.business_summary}`);
      if (t.caveats.length > 0) {
        lines.push(`  ⚠️ ${t.caveats[0]}`);
      }
    }
    lines.push("");
  }

  // Predictors
  if (predictors.length > 0) {
    lines.push("### Principais colunas que ajudam na predição");
    lines.push("");
    for (const p of predictors.slice(0, 5)) {
      lines.push(`- **${p.column}** — ${p.reason}`);
    }
    lines.push("");
  }

  // Business value
  if (targets.length > 0) {
    lines.push("### Por que isso é útil pro negócio");
    lines.push("");
    const best = targets[0];
    if (best.type === "binary" || best.type === "class") {
      lines.push("Com um modelo de classificação, é possível **antecipar eventos** e tomar ações preventivas — como campanhas de retenção, priorização de leads ou alertas de risco — antes que o evento aconteça.");
    } else {
      lines.push("Com um modelo de regressão, é possível **estimar valores futuros** como receita, demanda ou volumes — permitindo planejamento financeiro, otimização de recursos e cenários de simulação.");
    }
  }

  return lines.join("\n");
}

// ── Main serve ──────────────────────────────────────────────────────
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

    console.log(`[infer-problem] Found ${result.suggested_targets.length} targets, ${result.suggested_predictors.length} predictors, type=${result.problem_type}`);

    // ── Persist to project_problem_inference ─────────────────────────
    const inferenceRecord = {
      organization_id: orgId,
      project_id,
      dataset_id: dataset_id || datasetRes.data?.id || null,
      inference_version: "v1",
      problem_type: result.problem_type,
      suggested_problem_labels: result.suggested_problem_labels,
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

        // Append to history
        const history = Array.isArray(memoryJson.history) ? memoryJson.history : [];
        history.unshift({
          timestamp: new Date().toISOString(),
          inference_version: "v1",
          problem_type: result.problem_type,
          top_target: result.suggested_targets[0]?.column || null,
          confidence: result.confidence,
          labels: result.suggested_problem_labels.map((l) => l.label),
        });

        const updatedMemory = {
          ...memoryJson,
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
          stage: "targeting",
          payload: {
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

    return new Response(
      JSON.stringify({ inference: inserted || inferenceRecord, cached: false }),
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
