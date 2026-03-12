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
  stddev_value?: number | null;
}

interface CategoricalStat {
  column_name: string;
  distinct_count: number | null;
  top_categories: { category: string; count: number }[] | null;
}

interface ColumnInference {
  column_name: string;
  inferred_type: string;
  semantic_role: string;
  temporal_role: string;
  can_be_target: boolean;
  can_be_feature: boolean;
}

interface ScoredCandidate {
  column: string;
  score: number;
  reasons: string[];
}

type DatasetShape = "transactional" | "snapshot" | "events" | "timeseries";

// ═══ Helpers ═══════════════════════════════════════════════════

/** Convert a raw 0-10 score to a 0-95 integer percentage */
function normalizeScore(raw: number): number {
  return Math.min(Math.round(Math.max(raw, 0) * 10), 95);
}

// ═══ Generic adapter fallback ══════════════════════════════════

const GENERIC_ADAPTER = {
  entity_candidates: ["id", "customer_id", "user_id", "entity_id"],
  time_candidates: ["created_at", "date", "timestamp", "dt_evento"],
  event_candidates: ["target", "label", "outcome", "event"],
  value_candidates: ["value", "amount", "score", "total"],
  leakage_watchlist: ["result", "final_status", "outcome_date"],
  column_dictionary: {} as Record<string, string>,
};

// ═══ Scoring heuristics ════════════════════════════════════════

// ── Technical column filters ──────────────────────────────────

/** Returns true if the column is a technical/measure/aggregate column that should be deprioritized */
function isTechnicalOrMeasureColumn(name: string): boolean {
  const lower = name.toLowerCase();
  // __ prefixed columns (Power BI internal measures)
  if (name.startsWith("__")) return true;
  // Aggregate measure patterns
  if (/^(count|sum|avg|average|total|measure|medida|qtd|quantidade)[\s_]?/i.test(lower)) return true;
  if (/[\s_](count|sum|avg|average|total|measure)$/i.test(lower)) return true;
  return false;
}

function scoreEntity(
  col: ColumnRow,
  adapterCandidates: string[],
  catStat: CategoricalStat | null,
  totalRows: number,
  allColumns: ColumnRow[],
): ScoredCandidate {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  // Block technical/measure columns
  if (isTechnicalOrMeasureColumn(col.column_name)) {
    return { column: col.column_name, score: -10, reasons: ["Coluna técnica/measure rejeitada"] };
  }

  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push("Match exato no adaptador de indústria");
  }

  const kw = ["id", "customer", "cliente", "patient", "paciente", "cpf", "cnpj", "matricula", "aluno", "account", "conta", "user", "prontuario"];
  if (kw.some(k => name.includes(k))) {
    score += 3;
    reasons.push(`Token de entidade: "${name}"`);
  }

  if (catStat?.distinct_count && totalRows > 0) {
    const ratio = catStat.distinct_count / totalRows;
    if (ratio > 0.9) { score += 2; reasons.push(`Alta cardinalidade (${(ratio * 100).toFixed(0)}%)`); }
  }

  const techPKs = ["row_id", "index", "idx", "unnamed", "unnamed:_0"];
  if (techPKs.includes(name)) { score -= 5; reasons.push("PK técnica"); }

  if (name === "id" && col.inferred_type === "numérico" &&
      allColumns.some(c => { const n = c.column_name.toLowerCase(); return n !== name && (n.includes("customer") || n.includes("client") || n.includes("user_id") || n.includes("cpf")); })) {
    score -= 3;
    reasons.push("ID numérico genérico com candidato melhor");
  }

  return { column: col.column_name, score, reasons };
}

function scoreTime(
  col: ColumnRow,
  adapterCandidates: string[],
  numStat: NumericStat | null,
  totalRows: number,
): ScoredCandidate {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  const dateTypes = ["data", "date", "datetime", "timestamp"];
  if (dateTypes.some(dt => col.inferred_type.toLowerCase().includes(dt))) {
    score += 5;
    reasons.push("Tipo inferido como data");
  }

  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push("Match exato no adaptador");
  }

  const dateKw = ["dt", "date", "data", "created_at", "appointment", "visit", "consulta", "compra", "pedido", "purchase", "order", "vencimento", "ship", "delivery", "entrega"];
  if (dateKw.some(k => name.includes(k))) {
    score += 3;
    reasons.push(`Token temporal: "${name}"`);
  }

  if (name === "updated_at" || name === "dt_atualizacao") {
    score -= 3;
    reasons.push("updated_at não é âncora");
  }

  if (numStat && numStat.null_count !== null && totalRows > 0) {
    const nullPct = numStat.null_count / totalRows;
    if (nullPct < 0.05) { score += 2; reasons.push(`Poucos nulos (${(nullPct * 100).toFixed(1)}%)`); }
  }

  return { column: col.column_name, score, reasons };
}

function scoreValue(
  col: ColumnRow,
  adapterCandidates: string[],
  numStat: NumericStat | null,
): ScoredCandidate {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (col.inferred_type !== "numérico") return { column: col.column_name, score: -10, reasons: ["Não é numérico"] };

  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push("Match no adaptador de valor");
  }

  const valKw = ["value", "valor", "amount", "revenue", "receita", "ticket", "price", "preco", "cost", "custo", "total", "balance", "saldo", "ltv", "lifetime", "gpa", "nota", "score"];
  if (valKw.some(k => name.includes(k))) {
    score += 3;
    reasons.push(`Token de valor: "${name}"`);
  }

  if (name.includes("id") || name === "index" || name === "row_id") {
    score -= 5;
    reasons.push("Provável identificador");
  }

  if (numStat && numStat.min_value !== null && numStat.max_value !== null && numStat.min_value !== numStat.max_value) {
    score += 1;
    reasons.push("Distribuição variada");
  }

  return { column: col.column_name, score, reasons };
}

function scoreStatus(
  col: ColumnRow,
  adapterCandidates: string[],
  catStat: CategoricalStat | null,
  numStat: NumericStat | null,
): ScoredCandidate {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (adapterCandidates.some(c => c.toLowerCase() === name)) {
    score += 5;
    reasons.push("Match no adaptador de eventos/status");
  }

  const statusKw = ["status", "state", "situacao", "situação", "ativo", "active", "inactive", "cancel", "churn", "no_show", "falta", "dropout", "evasao", "default", "inadimpl", "fraud", "convert", "returned", "delayed", "atras", "target", "label", "outcome"];
  if (statusKw.some(k => name.includes(k))) {
    score += 3;
    reasons.push(`Token de status: "${name}"`);
  }

  if (catStat?.distinct_count !== null && catStat?.distinct_count !== undefined && catStat.distinct_count >= 2 && catStat.distinct_count <= 20) {
    score += 3;
    reasons.push(`Cardinalidade baixa (${catStat.distinct_count} valores)`);
  }

  if (numStat && numStat.min_value === 0 && numStat.max_value === 1) {
    score += 2;
    reasons.push("Binário (0/1)");
  }

  if (catStat?.distinct_count !== null && catStat?.distinct_count !== undefined && catStat.distinct_count > 20) {
    score -= 2;
    reasons.push("Cardinalidade alta demais para status");
  }

  return { column: col.column_name, score, reasons };
}

function scoreText(
  col: ColumnRow,
  catStat: CategoricalStat | null,
  inference: ColumnInference | null,
): ScoredCandidate {
  const name = col.column_name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  const textTypes = ["texto", "text", "object", "string", "categórico"];
  if (textTypes.some(t => col.inferred_type.toLowerCase().includes(t))) {
    score += 2;
    reasons.push("Tipo texto/object");
  }

  const textKw = ["desc", "description", "observacao", "obs", "comment", "comentario", "note", "nota", "motivo", "reason", "msg", "message", "email", "nome", "name", "endereco", "address"];
  if (textKw.some(k => name.includes(k))) {
    score += 3;
    reasons.push(`Token de texto: "${name}"`);
  }

  // High cardinality for text = good signal
  if (catStat?.distinct_count && catStat.distinct_count > 50) {
    score += 2;
    reasons.push(`Alta variedade (${catStat.distinct_count} valores)`);
  }

  // Semantic role from inference
  if (inference?.semantic_role === "text" || inference?.semantic_role === "description") {
    score += 3;
    reasons.push("Classificação semântica: texto");
  }

  return { column: col.column_name, score, reasons };
}

// ═══ Dataset shape inference ═══════════════════════════════════

function inferDatasetShape(
  totalRows: number,
  bestEntity: ScoredCandidate | null,
  bestTime: ScoredCandidate | null,
  topStatus: ScoredCandidate[],
  topValues: ScoredCandidate[],
  catStatMap: Map<string, CategoricalStat>,
  columns: ColumnRow[],
): DatasetShape {
  const entityCard = bestEntity ? catStatMap.get(bestEntity.column)?.distinct_count || 0 : 0;
  const hasTime = bestTime !== null && bestTime.score >= 3;
  const hasValue = topValues.length > 0;

  // events: has event/type/action column + timestamp + many rows
  const hasEventCol = columns.some(c => {
    const n = c.column_name.toLowerCase();
    return n.includes("event") || n.includes("type") || n.includes("action") || n.includes("tipo");
  });
  if (hasEventCol && hasTime && totalRows > 100) {
    return "events";
  }

  // timeseries: dominant time + numeric measures + low entity diversity
  if (hasTime && hasValue && entityCard > 0 && entityCard < 20 && totalRows > entityCard * 5) {
    return "timeseries";
  }

  // transactional: many rows per entity
  if (entityCard > 0 && totalRows > entityCard * 2) {
    return "transactional";
  }

  // snapshot: ~1:1 entity:row
  if (entityCard > 0 && totalRows > 0) {
    const ratio = entityCard / totalRows;
    if (ratio > 0.7) return "snapshot";
  }

  // Default heuristic: if has time, transactional; else snapshot
  return hasTime ? "transactional" : "snapshot";
}

const SHAPE_LABELS: Record<DatasetShape, string> = {
  transactional: "Transacional",
  snapshot: "Snapshot (foto do estado)",
  events: "Eventos",
  timeseries: "Série Temporal",
};

const VIRTUAL_PROFILE_NOTES = [
  "Dataset proveniente de conexão assistida Power BI.",
  "Profiling estatístico completo não disponível nesta etapa.",
];

function isVirtualSourceType(sourceType: string | null | undefined): boolean {
  const normalized = String(sourceType || "").toLowerCase();
  return ["powerbi", "external", "virtual"].includes(normalized);
}

function buildVirtualTdePayload(params: {
  sourceType: string | null;
  rowCount: number | null;
  columnCount: number | null;
  datasetName?: string | null;
}) {
  const nowIso = new Date().toISOString();
  const simplifiedMessage = "Este dataset veio de conexão externa assistida. A detecção automática completa de colunas pode ser limitada nesta etapa.";

  const tdeProfile = {
    dataset_shape: "snapshot",
    dataset_shape_label: "Dataset externo / virtual",
    dataset_profile_type: "external_virtual",
    is_virtual_dataset: true,
    candidates: {
      entity_candidates: [],
      time_candidates: [],
      value_candidates: [],
      status_candidates: [],
      text_candidates: [],
    },
    summary: [simplifiedMessage],
    gates: [{ gate: "virtual_dataset_simplified", status: "WARN", message: simplifiedMessage }],
    profiled_at: nowIso,
    total_rows: params.rowCount ?? 0,
    total_cols: params.columnCount ?? 0,
    notes: VIRTUAL_PROFILE_NOTES,
    source_type: params.sourceType,
    dataset_name: params.datasetName ?? null,
  };

  return {
    success: true,
    is_virtual_dataset: true,
    virtual_dataset: true,
    eda_ready: true,
    dataset_shape_label: "Dataset externo / virtual",
    dataset_profile_type: "external_virtual",
    row_count: params.rowCount ?? null,
    column_count: params.columnCount ?? null,
    columns: [],
    numeric_summary: [],
    categorical_summary: [],
    missing_summary: [],
    target_candidates: [],
    entity_candidates: [],
    time_candidates: [],
    notes: VIRTUAL_PROFILE_NOTES,
    source_type: params.sourceType,
    dataset_name: params.datasetName ?? null,
    tde_profile: tdeProfile,
  };
}

async function persistVirtualTdeProfile(
  supabase: any,
  projectId: string,
  payload: ReturnType<typeof buildVirtualTdePayload>,
  aiContextRow: any,
  datasetRef: string | null,
  manifestId: string | null,
) {
  const currentCtx = (aiContextRow?.context as Record<string, any>) || {};
  const prevProfiles: any[] = Array.isArray(currentCtx.tde_profile_history) ? currentCtx.tde_profile_history : [];
  const prevProfile = currentCtx.tde_profile;
  const newHistory = prevProfile
    ? [{ ...prevProfile, _saved_at: new Date().toISOString() }, ...prevProfiles].slice(0, 5)
    : prevProfiles;

  const existingHints = currentCtx.contract_hints || {};

  const tdeSlim = {
    dataset_shape: payload.tde_profile.dataset_shape,
    entity: null,
    time: null,
    value: null,
    status: null,
    profiled_at: payload.tde_profile.profiled_at,
    dataset_ref: datasetRef,
    manifest_id: manifestId,
    is_virtual_dataset: true,
  };

  const contextPayload = {
    ...currentCtx,
    tde_profile: payload.tde_profile,
    tde_profile_history: newHistory,
    contract_hints: { ...existingHints, tde: tdeSlim },
  };

  if (aiContextRow?.id) {
    await supabase.from("project_ai_context").update({
      context: contextPayload,
      last_updated_at: new Date().toISOString(),
    }).eq("id", aiContextRow.id);
  } else {
    await supabase.from("project_ai_context").insert({
      project_id: projectId,
      context: contextPayload,
      status: "active",
      last_updated_at: new Date().toISOString(),
    } as any);
  }

  await supabase.from("project_settings").update({
    tde_profile_result: payload.tde_profile,
    updated_at: new Date().toISOString(),
  } as any).eq("project_id", projectId);
}

async function logVirtualTdeEvents(supabase: any, projectId: string, metadata: Record<string, unknown>) {
  try {
    await supabase.from("platform_events").insert([
      {
        event_type: "powerbi_virtual_profile_fallback_used",
        project_id: projectId,
        status: "success",
        source: "edge",
        metadata,
      },
      {
        event_type: "powerbi_virtual_target_discovery_simplified",
        project_id: projectId,
        status: "success",
        source: "edge",
        metadata,
      },
    ]);
  } catch (err) {
    console.warn("[tde-profile-dataset] Non-blocking telemetry error:", err);
  }
}

// ═══ Main ══════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id, dataset_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // ── Ingestion gate ──────────────────────────────────
    const { data: settingsGate } = await supabase
      .from("project_settings")
      .select("ingestion_state, ingestion_manifest_id, ingestion_dataset_id, ingestion_source_type, ingestion_rows_detected, ingestion_cols_detected")
      .eq("project_id", project_id)
      .maybeSingle();

    if (settingsGate && settingsGate.ingestion_state !== "done") {
      console.log(`[tde-profile-dataset] Blocked: ingestion_state=${settingsGate.ingestion_state}`);
      return new Response(JSON.stringify({
        success: false,
        error_code: "INGESTION_NOT_READY",
        error_friendly: "A ingestão de dados ainda não foi concluída. Finalize a importação antes de executar o profiling.",
        ingestion_state: settingsGate.ingestion_state,
        ctas: [
          { label: "Voltar para Upload", action: "goto_step", step: 2 },
          { label: "Atualizar status", action: "refresh" },
        ],
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // If manifest/dataset IDs are missing, check if columns exist as fallback
    if (settingsGate && !settingsGate.ingestion_manifest_id && !settingsGate.ingestion_dataset_id) {
      const { count: colCount } = await supabase
        .from("project_columns")
        .select("id", { count: "exact", head: true })
        .eq("project_id", project_id);

      if (!colCount || colCount === 0) {
        console.log(`[tde-profile-dataset] Blocked: manifest/dataset missing and no columns`);
        return new Response(JSON.stringify({
          success: false,
          error_code: "MANIFEST_MISSING",
          error_friendly: "O manifest de ingestão está ausente. Reimporte os dados para gerar o manifest.",
          ctas: [
            { label: "Voltar para Upload", action: "goto_step", step: 2 },
            { label: "Atualizar status", action: "refresh" },
          ],
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      console.log(`[tde-profile-dataset] Manifest missing but ${colCount} columns found — proceeding with fallback`);
    }

    console.log(`[tde-profile-dataset] Starting for project=${project_id}`);

    // ─── Load data in parallel ──────────────────────────────

    const [columnsRes, numStatsRes, catStatsRes, inferenceRes, aiContextRes, dsStateRes] = await Promise.all([
      supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id).order("column_index"),
      supabase.from("project_numeric_stats").select("column_name, null_count, min_value, max_value, mean_value").eq("project_id", project_id),
      supabase.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", project_id),
      supabase.from("project_column_inference").select("column_name, inferred_type, semantic_role, temporal_role, can_be_target, can_be_feature").eq("project_id", project_id),
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count, active_dataset_ref, manifest_id").eq("project_id", project_id).maybeSingle(),
    ]);

    const columns: ColumnRow[] = columnsRes.data || [];
    const numStats: NumericStat[] = numStatsRes.data || [];
    const catStats: CategoricalStat[] = catStatsRes.data || [];
    const inferences: ColumnInference[] = (inferenceRes.data as ColumnInference[]) || [];

    if (columns.length === 0) {
      // Check if this is a virtual/external dataset (Power BI assisted, etc.)
      const { data: settingsVirtual } = await supabase
        .from("project_settings")
        .select("ingestion_state, ingestion_source_type, ingestion_rows_detected, ingestion_cols_detected")
        .eq("project_id", project_id)
        .single();

      const isVirtualDs = settingsVirtual?.ingestion_state === "done" &&
        isVirtualSourceType(settingsVirtual?.ingestion_source_type);

      if (!isVirtualDs) {
        // Also check project_datasets source_type
        const { data: dsCheck } = await supabase
          .from("project_datasets")
          .select("source_type")
          .eq("project_id", project_id)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        if (dsCheck?.source_type && isVirtualSourceType(dsCheck.source_type)) {
          // Fall through to virtual handling below
        } else {
          return new Response(
            JSON.stringify({ error: "Nenhuma coluna encontrada. Execute a importação primeiro." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Virtual dataset — use normalized payload with tde_profile key
      const virtualPayload = buildVirtualTdePayload({
        sourceType: settingsVirtual?.ingestion_source_type || "external",
        rowCount: settingsVirtual?.ingestion_rows_detected ?? null,
        columnCount: settingsVirtual?.ingestion_cols_detected ?? null,
      });

      // Persist to AI context so TDEProfileCard can read it from cache
      await persistVirtualTdeProfile(
        supabase, project_id, virtualPayload,
        aiContextRes.data, dsStateRes.data?.active_dataset_ref ?? null, dsStateRes.data?.manifest_id ?? null,
      );

      await logVirtualTdeEvents(supabase, project_id, {
        source_type: settingsVirtual?.ingestion_source_type,
        row_count: settingsVirtual?.ingestion_rows_detected,
        col_count: settingsVirtual?.ingestion_cols_detected,
      });

      console.log(`[tde-profile-dataset] Virtual dataset — returning normalized tde_profile`);
      return new Response(
        JSON.stringify({ success: true, tde_profile: virtualPayload.tde_profile }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const totalRows = dsStateRes.data?.row_count || 0;
    const datasetRef = dsStateRes.data?.active_dataset_ref ?? null;
    const manifestId = dsStateRes.data?.manifest_id ?? null;

    // Build maps
    const numStatMap = new Map<string, NumericStat>();
    for (const ns of numStats) numStatMap.set(ns.column_name, ns);
    const catStatMap = new Map<string, CategoricalStat>();
    for (const cs of catStats) catStatMap.set(cs.column_name, cs);
    const inferenceMap = new Map<string, ColumnInference>();
    for (const inf of inferences) inferenceMap.set(inf.column_name, inf);

    // ─── Resolve adapter ────────────────────────────────────

    const aiContext = aiContextRes.data?.context as Record<string, any> || {};
    const intentContract = aiContext.intent_contract || aiContext.intent || null;

    let adapter = GENERIC_ADAPTER;
    if (intentContract?.domain_adapter) {
      const da = intentContract.domain_adapter;
      adapter = {
        entity_candidates: da.entity_candidates || GENERIC_ADAPTER.entity_candidates,
        time_candidates: da.time_candidates || GENERIC_ADAPTER.time_candidates,
        event_candidates: da.event_candidates || GENERIC_ADAPTER.event_candidates,
        value_candidates: da.value_candidates || GENERIC_ADAPTER.value_candidates,
        leakage_watchlist: da.leakage_watchlist || GENERIC_ADAPTER.leakage_watchlist,
        column_dictionary: da.column_dictionary || {},
      };
    }

    const requiresTime = intentContract?.intent_base?.requires_time_column ?? intentContract?.requires_time_column ?? true;

    // ─── Score all categories ───────────────────────────────

    const entityScores = columns.map(c => scoreEntity(c, adapter.entity_candidates, catStatMap.get(c.column_name) || null, totalRows, columns))
      .sort((a, b) => b.score - a.score);
    const timeScores = columns.map(c => scoreTime(c, adapter.time_candidates, numStatMap.get(c.column_name) || null, totalRows))
      .sort((a, b) => b.score - a.score);
    const valueScores = columns.map(c => scoreValue(c, adapter.value_candidates, numStatMap.get(c.column_name) || null))
      .sort((a, b) => b.score - a.score);
    const statusScores = columns.map(c => scoreStatus(c, adapter.event_candidates, catStatMap.get(c.column_name) || null, numStatMap.get(c.column_name) || null))
      .sort((a, b) => b.score - a.score);
    const textScores = columns.map(c => scoreText(c, catStatMap.get(c.column_name) || null, inferenceMap.get(c.column_name) || null))
      .sort((a, b) => b.score - a.score);

    // Top candidates (score >= 3)
    const topEntities = entityScores.filter(e => e.score >= 3).slice(0, 5);
    const topTimes = timeScores.filter(t => t.score >= 3).slice(0, 5);
    const topValues = valueScores.filter(v => v.score >= 3).slice(0, 5);
    const topStatus = statusScores.filter(s => s.score >= 3).slice(0, 5);
    const topTexts = textScores.filter(t => t.score >= 3).slice(0, 5);

    const bestEntity = topEntities[0] || null;
    const bestTime = topTimes[0] || null;

    // ─── Dataset shape ──────────────────────────────────────

    const datasetShape = inferDatasetShape(
      totalRows, bestEntity, bestTime, topStatus, topValues, catStatMap, columns,
    );

    // ─── Gates (WARN only) ──────────────────────────────────

    const gates: { gate: string; status: "WARN"; message: string }[] = [];

    if (requiresTime && (!bestTime || bestTime.score < 6)) {
      gates.push({
        gate: "time_candidate_weak",
        status: "WARN",
        message: "O contrato requer coluna temporal, mas nenhuma foi detectada com alta confiança. Revise manualmente.",
      });
    }

    if (!bestEntity || bestEntity.score < 6) {
      gates.push({
        gate: "entity_candidate_weak",
        status: "WARN",
        message: "Nenhuma coluna de entidade detectada com confiança >= 60%. Revise manualmente.",
      });
    }

    const allLow = [
      bestEntity?.score ?? 0,
      bestTime?.score ?? 0,
      topValues[0]?.score ?? 0,
      topStatus[0]?.score ?? 0,
    ].every(s => s < 5);

    if (allLow) {
      gates.push({
        gate: "dataset_generic",
        status: "WARN",
        message: "Dataset muito genérico; recomendação automática de target pode exigir revisão manual.",
      });
    }

    // ─── Summary bullets ────────────────────────────────────

    const summary: string[] = [];
    summary.push(`Dataset classificado como **${SHAPE_LABELS[datasetShape]}** (${totalRows.toLocaleString()} linhas, ${columns.length} colunas).`);

    if (bestEntity) {
      summary.push(`Provável entidade: **${bestEntity.column}** (confiança ${normalizeScore(bestEntity.score)}%).`);
    } else {
      summary.push("Nenhuma coluna de entidade detectada automaticamente.");
    }

    if (bestTime) {
      summary.push(`Provável âncora temporal: **${bestTime.column}** (confiança ${normalizeScore(bestTime.score)}%).`);
    } else {
      summary.push("Nenhuma coluna temporal detectada automaticamente.");
    }

    // ─── Compute column_stats ───────────────────────────────

    const columnStats: Record<string, any> = {};
    for (const col of columns) {
      const ns = numStatMap.get(col.column_name);
      const cs = catStatMap.get(col.column_name);
      const missingRate = (ns?.null_count != null && totalRows > 0) ? ns.null_count / totalRows : null;
      const nunique = cs?.distinct_count ?? null;
      const cardRatio = (nunique != null && totalRows > 0) ? nunique / totalRows : null;
      let entropyApprox: number | null = null;
      if (cs?.top_categories && Array.isArray(cs.top_categories) && cs.top_categories.length > 0) {
        const totalCat = cs.top_categories.reduce((s: number, c: any) => s + (c.count || 0), 0);
        if (totalCat > 0) {
          entropyApprox = 0;
          for (const cat of cs.top_categories) {
            const p = (cat.count || 0) / totalCat;
            if (p > 0) entropyApprox -= p * Math.log2(p);
          }
          entropyApprox = Math.round(entropyApprox * 100) / 100;
        }
      }
      const isDateType = ["data", "date", "datetime", "timestamp"].some(dt => col.inferred_type.toLowerCase().includes(dt));
      columnStats[col.column_name] = {
        dtype_inferred: col.inferred_type,
        missing_rate: missingRate != null ? Math.round(missingRate * 10000) / 10000 : null,
        nunique,
        card_ratio: cardRatio != null ? Math.round(cardRatio * 10000) / 10000 : null,
        entropy_approx: entropyApprox,
        date_parse_rate: isDateType ? 1.0 : null,
        sample_top_values: cs?.top_categories?.slice(0, 5).map((c: any) => c.category) ?? null,
      };
    }

    // ─── Normalize candidate scores (0-95 continuous) ───────

    const normalizeCandidates = (arr: ScoredCandidate[]) =>
      arr.map(c => {
        const stats = columnStats[c.column];
        const enrichedReasons = [...c.reasons];
        if (stats) {
          if (stats.nunique != null) enrichedReasons.push(`Cardinalidade: ${stats.nunique} valores`);
          if (stats.missing_rate != null && stats.missing_rate > 0.01) enrichedReasons.push(`Missing: ${(stats.missing_rate * 100).toFixed(1)}%`);
          if (stats.entropy_approx != null) enrichedReasons.push(`Entropia: ${stats.entropy_approx.toFixed(2)}`);
          if (stats.date_parse_rate != null) enrichedReasons.push(`Date parse: ${(stats.date_parse_rate * 100).toFixed(0)}%`);
        }
        return { ...c, score: normalizeScore(c.score), reasons: enrichedReasons };
      });

    // ─── Build tde_profile ──────────────────────────────────

    const tdeProfile = {
      dataset_shape: datasetShape,
      dataset_shape_label: SHAPE_LABELS[datasetShape],
      candidates: {
        entity_candidates: normalizeCandidates(topEntities),
        time_candidates: normalizeCandidates(topTimes),
        value_candidates: normalizeCandidates(topValues),
        status_candidates: normalizeCandidates(topStatus),
        text_candidates: normalizeCandidates(topTexts),
      },
      column_stats: columnStats,
      summary,
      gates,
      dataset_ref: datasetRef,
      manifest_id: manifestId,
      profiled_at: new Date().toISOString(),
      total_rows: totalRows,
      total_cols: columns.length,
    };

    // ─── Persist to project_ai_context ──────────────────────

    if (aiContextRes.data) {
      const currentCtx = aiContextRes.data.context as Record<string, any> || {};

      // History: keep last 5 tde_profile executions
      const prevProfiles: any[] = Array.isArray(currentCtx.tde_profile_history) ? currentCtx.tde_profile_history : [];
      const prevProfile = currentCtx.tde_profile;
      const newHistory = prevProfile
        ? [{ ...prevProfile, _saved_at: new Date().toISOString() }, ...prevProfiles].slice(0, 5)
        : prevProfiles;

      // Slim version for contract_hints.tde
      const tdeSlim = {
        dataset_shape: datasetShape,
        entity: bestEntity ? { column: bestEntity.column, score: normalizeScore(bestEntity.score) } : null,
        time: bestTime ? { column: bestTime.column, score: normalizeScore(bestTime.score) } : null,
        value: topValues[0] ? { column: topValues[0].column, score: normalizeScore(topValues[0].score) } : null,
        status: topStatus[0] ? { column: topStatus[0].column, score: normalizeScore(topStatus[0].score) } : null,
        profiled_at: tdeProfile.profiled_at,
      };

      const existingHints = currentCtx.contract_hints || {};

      await supabase.from("project_ai_context").update({
        context: {
          ...currentCtx,
          tde_profile: tdeProfile,
          tde_profile_history: newHistory,
          contract_hints: { ...existingHints, tde: tdeSlim },
        },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiContextRes.data.id);

      console.log(`[tde-profile-dataset] Profile persisted (shape=${datasetShape})`);
    } else {
      console.warn(`[tde-profile-dataset] No AI context found — profile not persisted`);
    }

    // ─── Response ───────────────────────────────────────────

    console.log(`[tde-profile-dataset] Done: shape=${datasetShape}, entities=${topEntities.length}, times=${topTimes.length}, values=${topValues.length}, status=${topStatus.length}, texts=${topTexts.length}`);

    return new Response(
      JSON.stringify({ success: true, tde_profile: tdeProfile }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[tde-profile-dataset] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
