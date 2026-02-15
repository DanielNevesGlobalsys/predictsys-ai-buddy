import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ═══ Types ═════════════════════════════════════════════════════

interface ColumnRow {
  column_name: string;
  inferred_type: string;
}

interface NumericStat {
  column_name: string;
  null_count: number | null;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
}

interface CategoricalStat {
  column_name: string;
  distinct_count: number | null;
  top_categories: { category: string; count: number }[] | null;
}

interface ScoredColumn {
  column: string;
  score: number;
  reasons: string[];
}

interface SuggestionResult {
  column: string | null;
  confidence: number;
  reasons: string[];
}

interface MultiSuggestionResult {
  columns: string[];
  confidence: number;
  reasons: string[];
}

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
}

// ═══ Default adapter (fallback) ════════════════════════════════

const GENERIC_ADAPTER = {
  entity_candidates: ["id", "customer_id", "user_id", "entity_id"],
  time_candidates: ["created_at", "date", "timestamp", "dt_evento"],
  event_candidates: ["target", "label", "outcome", "event"],
  value_candidates: ["value", "amount", "score", "total"],
  leakage_watchlist: ["result", "final_status", "outcome_date"],
};

// ═══ Scoring Heuristics ════════════════════════════════════════

function scoreEntityKey(
  col: ColumnRow,
  adapterCandidates: string[],
  catStat: CategoricalStat | null,
  totalRows: number,
  allColumns: ColumnRow[],
): ScoredColumn {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  // +5 exact match with adapter candidates
  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push(`Nome exato no adaptador de indústria`);
  }

  // +3 contains common entity keywords
  const entityKeywords = ["id", "customer", "cliente", "patient", "paciente", "prontuario", "cpf", "cnpj", "matricula", "aluno", "account", "conta", "user"];
  if (entityKeywords.some(kw => name.includes(kw))) {
    score += 3;
    reasons.push(`Contém termo de entidade: "${name}"`);
  }

  // +2 high distinct_count (>90% of rows)
  if (catStat && catStat.distinct_count && totalRows > 0) {
    const distinctRatio = catStat.distinct_count / totalRows;
    if (distinctRatio > 0.9) {
      score += 2;
      reasons.push(`Alta cardinalidade (${(distinctRatio * 100).toFixed(0)}% distintos)`);
    }
  }

  // -5 if it's a technical PK (row_id, index, uuid of event) and there's a better candidate
  const technicalPKs = ["row_id", "index", "idx", "unnamed", "unnamed:_0", "id"];
  if (technicalPKs.includes(name) && allColumns.some(c => {
    const n = c.column_name.toLowerCase();
    return n !== name && (n.includes("customer") || n.includes("client") || n.includes("patient") || n.includes("user_id") || n.includes("cpf"));
  })) {
    score -= 5;
    reasons.push(`PK técnica com candidato melhor disponível`);
  }

  // -2 if numeric type and name is just "id" (could be row index)
  if (name === "id" && col.inferred_type === "numérico") {
    score -= 2;
    reasons.push(`ID numérico genérico (possível índice)`);
  }

  return { column: col.column_name, score, reasons };
}

function scoreTimeAnchor(
  col: ColumnRow,
  adapterCandidates: string[],
  numStat: NumericStat | null,
  totalRows: number,
): ScoredColumn {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  // +5 if inferred_type is date/datetime
  const dateTypes = ["data", "date", "datetime", "timestamp"];
  if (dateTypes.some(dt => col.inferred_type.toLowerCase().includes(dt))) {
    score += 5;
    reasons.push(`Tipo inferido como data`);
  }

  // +5 exact match with adapter candidates
  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push(`Nome exato no adaptador de indústria`);
  }

  // +3 contains common date keywords
  const dateKeywords = ["dt", "date", "data", "created_at", "appointment", "visit", "consulta", "compra", "pedido", "purchase", "order", "vencimento", "matricula", "ship", "delivery", "entrega"];
  if (dateKeywords.some(kw => name.includes(kw))) {
    score += 3;
    reasons.push(`Contém termo temporal: "${name}"`);
  }

  // -3 if it's "updated_at" (usually not the anchor)
  if (name === "updated_at" || name === "dt_atualizacao") {
    score -= 3;
    reasons.push(`"updated_at" geralmente não é âncora temporal`);
  }

  // +2 if low null count (covers most of the dataset)
  if (numStat && numStat.null_count !== null && totalRows > 0) {
    const nullPct = numStat.null_count / totalRows;
    if (nullPct < 0.05) {
      score += 2;
      reasons.push(`Poucos nulos (${(nullPct * 100).toFixed(1)}%)`);
    }
  }

  return { column: col.column_name, score, reasons };
}

function scoreEventCandidates(
  col: ColumnRow,
  adapterCandidates: string[],
  catStat: CategoricalStat | null,
  numStat: NumericStat | null,
): ScoredColumn {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  // +5 exact match with adapter event candidates
  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push(`Nome exato no adaptador de eventos`);
  }

  // +3 contains event-related keywords
  const eventKeywords = ["churn", "cancel", "no_show", "falta", "dropout", "evasao", "default", "inadimpl", "fraud", "convert", "active", "inactive", "status", "target", "label", "outcome", "returned", "delayed", "atras"];
  if (eventKeywords.some(kw => name.includes(kw))) {
    score += 3;
    reasons.push(`Contém termo de evento: "${name}"`);
  }

  // +3 if boolean-like (2 distinct values)
  if (catStat && catStat.distinct_count !== null && catStat.distinct_count <= 3 && catStat.distinct_count >= 2) {
    score += 3;
    reasons.push(`Binário/ternário (${catStat.distinct_count} valores distintos)`);
  }

  // +2 if numeric and binary (min=0, max=1)
  if (numStat && numStat.min_value === 0 && numStat.max_value === 1) {
    score += 2;
    reasons.push(`Numérico binário (0/1)`);
  }

  // +1 if low cardinality (<10)
  if (catStat && catStat.distinct_count !== null && catStat.distinct_count <= 10 && catStat.distinct_count > 1) {
    score += 1;
    reasons.push(`Baixa cardinalidade (${catStat.distinct_count} valores)`);
  }

  return { column: col.column_name, score, reasons };
}

function scoreValueCandidates(
  col: ColumnRow,
  adapterCandidates: string[],
  numStat: NumericStat | null,
): ScoredColumn {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  // Only consider numeric columns
  if (col.inferred_type !== "numérico") {
    return { column: col.column_name, score: -10, reasons: ["Não é numérico"] };
  }

  // +5 exact match with adapter value candidates
  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push(`Nome exato no adaptador de valor`);
  }

  // +3 contains value-related keywords
  const valueKeywords = ["value", "valor", "amount", "revenue", "receita", "ticket", "price", "preco", "cost", "custo", "total", "balance", "saldo", "ltv", "lifetime", "gpa", "nota", "score"];
  if (valueKeywords.some(kw => name.includes(kw))) {
    score += 3;
    reasons.push(`Contém termo de valor: "${name}"`);
  }

  // -5 if it looks like an ID (high cardinality + "id" in name)
  if (name.includes("id") || name === "index" || name === "row_id") {
    score -= 5;
    reasons.push(`Provável identificador, não valor`);
  }

  // +2 if has realistic distribution (not all same value)
  if (numStat && numStat.min_value !== null && numStat.max_value !== null && numStat.min_value !== numStat.max_value) {
    score += 1;
    reasons.push(`Distribuição variada (min=${numStat.min_value?.toFixed(1)}, max=${numStat.max_value?.toFixed(1)})`);
  }

  return { column: col.column_name, score, reasons };
}

// ═══ Main ══════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[infer-entity-and-time] Starting for project=${project_id}`);

    // ─── Load data in parallel ───────────────────────────────

    const [columnsRes, numStatsRes, catStatsRes, aiContextRes, dsStateRes] = await Promise.all([
      supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id).order("column_index"),
      supabase.from("project_numeric_stats").select("column_name, null_count, min_value, max_value, mean_value").eq("project_id", project_id),
      supabase.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", project_id),
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count").eq("project_id", project_id).maybeSingle(),
    ]);

    const columns: ColumnRow[] = columnsRes.data || [];
    const numStats: NumericStat[] = numStatsRes.data || [];
    const catStats: CategoricalStat[] = catStatsRes.data || [];

    if (columns.length === 0) {
      return new Response(
        JSON.stringify({ error: "Nenhuma coluna encontrada. Execute a importação primeiro." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const totalRows = dsStateRes.data?.row_count || 0;

    // Build lookup maps
    const numStatMap = new Map<string, NumericStat>();
    for (const ns of numStats) numStatMap.set(ns.column_name, ns);

    const catStatMap = new Map<string, CategoricalStat>();
    for (const cs of catStats) catStatMap.set(cs.column_name, cs);

    // ─── Resolve adapter from intent contract ────────────────

    const aiContext = aiContextRes.data?.context as Record<string, any> || {};
    const intentContract = aiContext.intent_contract || aiContext.intent || null;

    let adapter = GENERIC_ADAPTER;
    if (intentContract) {
      // v2 format
      if (intentContract.domain_adapter) {
        const da = intentContract.domain_adapter;
        adapter = {
          entity_candidates: da.entity_candidates || GENERIC_ADAPTER.entity_candidates,
          time_candidates: da.time_candidates || GENERIC_ADAPTER.time_candidates,
          event_candidates: da.event_candidates || GENERIC_ADAPTER.event_candidates,
          value_candidates: da.value_candidates || GENERIC_ADAPTER.value_candidates,
          leakage_watchlist: da.leakage_watchlist || GENERIC_ADAPTER.leakage_watchlist,
        };
      }
    }

    const requiresTime = intentContract?.intent_base?.requires_time_column
      ?? intentContract?.requires_time_column
      ?? true;

    const problemType = intentContract?.intent_base?.problem_type
      ?? intentContract?.problem_type
      ?? "classification";

    const targetExpected = intentContract?.intent_base?.target_expected
      ?? intentContract?.target_expected
      ?? "event";

    console.log(`[infer-entity-and-time] Adapter loaded: entity_candidates=${adapter.entity_candidates.length}, time_candidates=${adapter.time_candidates.length}, problemType=${problemType}, targetExpected=${targetExpected}`);

    // ─── Score entity_key ────────────────────────────────────

    const entityScores: ScoredColumn[] = columns.map(col =>
      scoreEntityKey(col, adapter.entity_candidates, catStatMap.get(col.column_name) || null, totalRows, columns)
    );
    entityScores.sort((a, b) => b.score - a.score);

    const bestEntity = entityScores[0];
    const entitySuggestion: SuggestionResult = bestEntity && bestEntity.score >= 3
      ? { column: bestEntity.column, confidence: Math.min(bestEntity.score / 10, 1), reasons: bestEntity.reasons }
      : { column: null, confidence: 0, reasons: ["Nenhuma coluna com pontuação suficiente para entity_key"] };

    // ─── Score time_anchor ───────────────────────────────────

    const timeScores: ScoredColumn[] = columns.map(col =>
      scoreTimeAnchor(col, adapter.time_candidates, numStatMap.get(col.column_name) || null, totalRows)
    );
    timeScores.sort((a, b) => b.score - a.score);

    const bestTime = timeScores[0];
    const timeSuggestion: SuggestionResult = bestTime && bestTime.score >= 3
      ? { column: bestTime.column, confidence: Math.min(bestTime.score / 10, 1), reasons: bestTime.reasons }
      : { column: null, confidence: 0, reasons: ["Nenhuma coluna temporal encontrada com confiança suficiente"] };

    // ─── Score event candidates ──────────────────────────────

    const eventScores: ScoredColumn[] = columns.map(col =>
      scoreEventCandidates(col, adapter.event_candidates, catStatMap.get(col.column_name) || null, numStatMap.get(col.column_name) || null)
    );
    eventScores.sort((a, b) => b.score - a.score);

    const topEvents = eventScores.filter(e => e.score >= 3).slice(0, 5);
    const eventSuggestion: MultiSuggestionResult = topEvents.length > 0
      ? {
          columns: topEvents.map(e => e.column),
          confidence: Math.min(topEvents[0].score / 10, 1),
          reasons: topEvents.flatMap(e => e.reasons.map(r => `${e.column}: ${r}`)).slice(0, 8),
        }
      : { columns: [], confidence: 0, reasons: ["Nenhuma coluna de evento identificada"] };

    // ─── Score value candidates ──────────────────────────────

    const valueScores: ScoredColumn[] = columns.map(col =>
      scoreValueCandidates(col, adapter.value_candidates, numStatMap.get(col.column_name) || null)
    );
    valueScores.sort((a, b) => b.score - a.score);

    const topValues = valueScores.filter(v => v.score >= 3).slice(0, 5);
    const valueSuggestion: MultiSuggestionResult = topValues.length > 0
      ? {
          columns: topValues.map(v => v.column),
          confidence: Math.min(topValues[0].score / 10, 1),
          reasons: topValues.flatMap(v => v.reasons.map(r => `${v.column}: ${r}`)).slice(0, 8),
        }
      : { columns: [], confidence: 0, reasons: ["Nenhuma coluna de valor numérico identificada"] };

    // ─── Gates ───────────────────────────────────────────────

    const gates: GateResult[] = [];

    // Entity key gate
    if (!entitySuggestion.column) {
      gates.push({
        gate: "entity_key",
        status: problemType === "segmentation" ? "WARN" : "WARN",
        message: "Nenhuma coluna de entidade (ID) detectada automaticamente. Você pode selecionar manualmente no Step 4.",
      });
    } else {
      gates.push({
        gate: "entity_key",
        status: entitySuggestion.confidence >= 0.5 ? "PASS" : "WARN",
        message: entitySuggestion.confidence >= 0.5
          ? `Entidade detectada: "${entitySuggestion.column}" (confiança ${(entitySuggestion.confidence * 100).toFixed(0)}%)`
          : `Possível entidade: "${entitySuggestion.column}" (confiança baixa — verifique manualmente)`,
      });
    }

    // Time anchor gate
    if (requiresTime && !timeSuggestion.column) {
      gates.push({
        gate: "time_anchor",
        status: "WARN",
        message: "O objetivo requer coluna temporal, mas nenhuma foi detectada automaticamente. Selecione manualmente ou revise os dados.",
      });
    } else if (!timeSuggestion.column) {
      gates.push({
        gate: "time_anchor",
        status: "PASS",
        message: "Coluna temporal não necessária para este tipo de problema.",
      });
    } else {
      gates.push({
        gate: "time_anchor",
        status: timeSuggestion.confidence >= 0.5 ? "PASS" : "WARN",
        message: timeSuggestion.confidence >= 0.5
          ? `Âncora temporal detectada: "${timeSuggestion.column}" (confiança ${(timeSuggestion.confidence * 100).toFixed(0)}%)`
          : `Possível âncora temporal: "${timeSuggestion.column}" (confiança baixa — verifique manualmente)`,
      });
    }

    // ─── Persist hints to project_ai_context ─────────────────

    const contractHints = {
      entity_key: entitySuggestion.column,
      time_anchor_column: timeSuggestion.column,
      event_candidates: eventSuggestion.columns,
      value_candidates: valueSuggestion.columns,
      inferred_at: new Date().toISOString(),
      confidence: {
        entity_key: entitySuggestion.confidence,
        time_anchor: timeSuggestion.confidence,
        events: eventSuggestion.confidence,
        values: valueSuggestion.confidence,
      },
    };

    if (aiContextRes.data) {
      const currentCtx = aiContextRes.data.context as Record<string, any> || {};
      await supabase.from("project_ai_context").update({
        context: { ...currentCtx, contract_hints: contractHints },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiContextRes.data.id);
      console.log(`[infer-entity-and-time] Hints persisted to project_ai_context`);
    } else {
      console.warn(`[infer-entity-and-time] No AI context found for project — hints not persisted (will be created on next intent contract generation)`);
    }

    // ─── Response ────────────────────────────────────────────

    const response = {
      success: true,
      suggestions: {
        entity_key: entitySuggestion,
        time_anchor: timeSuggestion,
        event_candidates: eventSuggestion,
        value_candidates: valueSuggestion,
      },
      gates,
    };

    console.log(`[infer-entity-and-time] Done: entity=${entitySuggestion.column} time=${timeSuggestion.column} events=${eventSuggestion.columns.length} values=${valueSuggestion.columns.length}`);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[infer-entity-and-time] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
