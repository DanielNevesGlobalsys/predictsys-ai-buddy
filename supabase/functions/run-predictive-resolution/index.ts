import { createClient } from "https://esm.sh/@supabase/supabase-js@2.86.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ═══ Agro domain helpers ══════════════════════════════════════

const AGRO_REGRESSION_SIGNALS = [
  "captacao", "captação", "producao", "produção", "safra", "volume",
  "rendimento", "produtividade", "colheita", "recebimento", "sacas",
  "toneladas", "peso", "quantidade", "harvest", "yield", "production",
  "forecast", "previsao", "previsão", "demand",
];

const AGRO_NUMERIC_TARGET_TOKENS = [
  "qtd", "sacas", "peso", "volume", "producao", "produção",
  "captacao", "captação", "recebimento", "rendimento",
  "produtividade", "quantidade", "tonelada", "kg", "litro",
  "qtdpes", "qtdsac",
];

const DATE_COLUMN_PATTERNS = [
  "datmov", "dt_mov", "data_mov", "date_", "dt_", "_date", "_data",
  "created_at", "updated_at", "sk_data", "data_ref", "dt_ref",
  "calendario", "calendar",
];

const CALENDAR_TABLE_PATTERN = /^(calend[aá]rio|calendar|dimdate|dimcalendar)\./i;

function isDateColumn(colName: string, inferredType: string): boolean {
  const lo = colName.toLowerCase();
  const ty = (inferredType || "").toLowerCase();
  if (["date", "datetime", "timestamp", "data", "temporal"].some(d => ty.includes(d))) return true;
  if (DATE_COLUMN_PATTERNS.some(p => lo.includes(p))) return true;
  if (CALENDAR_TABLE_PATTERN.test(colName)) return true;
  return false;
}

function isCalendarColumn(colName: string): boolean {
  return CALENDAR_TABLE_PATTERN.test(colName) || colName.toLowerCase().includes("calendario") || colName.toLowerCase().includes("calendar");
}

function isAgroProject(settings: Record<string, any>): boolean {
  const industry = (settings?.industry || settings?.intent_contract_v3?.business_context?.industry || "").toLowerCase();
  return ["agro", "agronegocio", "agronegócio", "agriculture", "farming", "cafe", "café", "soja", "milho"].some(k => industry.includes(k));
}

function isAgroRegressionObjective(objective: string): boolean {
  const lo = (objective || "").toLowerCase();
  return AGRO_REGRESSION_SIGNALS.some(s => lo.includes(s));
}

const AGRO_ROW_LEVEL_DEGENERATE_TOKENS = [
  "qtdpes", "qtd_pes", "qtdsac", "qtd_sac", "qtde_sacas", "sacas", "peso",
];

const AGRO_AGGREGATED_TARGET_NAME = "agg_sacas_mes";

function normalizeText(value: string): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildNumericSampleStats(rows: Array<Record<string, unknown>>, columnName: string | null): {
  sample_count: number;
  unique_count: number;
  dominant_ratio: number;
  mean: number;
  std: number;
} | null {
  if (!columnName || rows.length === 0) return null;
  const values = rows
    .map((row) => toNumeric(row[columnName]))
    .filter((value): value is number => value !== null);

  if (values.length === 0) return null;

  const frequencies = new Map<string, number>();
  for (const value of values) {
    const key = value.toFixed(6);
    frequencies.set(key, (frequencies.get(key) || 0) + 1);
  }

  const dominant = Math.max(...Array.from(frequencies.values()));
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;

  return {
    sample_count: values.length,
    unique_count: frequencies.size,
    dominant_ratio: dominant / values.length,
    mean,
    std: Math.sqrt(variance),
  };
}

function isLikelyAgroRowLevelValueColumn(columnName: string | null): boolean {
  const lower = normalizeText(columnName || "");
  return AGRO_ROW_LEVEL_DEGENERATE_TOKENS.some((token) => lower.includes(token));
}

function isAllowedCalendarDimension(columnName: string): boolean {
  const lower = normalizeText(columnName);
  const fromCalendarTable = lower.includes("calendario.") || lower.includes("calendar.");
  const isCalendarDimension = ["ano", "mes", "month", "trimestre", "quarter"].some((token) => lower.includes(token));
  return fromCalendarTable && isCalendarDimension;
}

function pickAgroAggregationSourceColumn(
  columns: Array<{ column_name: string }>,
  currentTarget: string | null,
): string | null {
  const names = columns.map((column) => column.column_name);
  return names.find((name) => /qtdsac|sacas/i.test(name))
    || currentTarget
    || names.find((name) => /qtdpes|peso/i.test(name))
    || null;
}

function hasAgroNumericSignal(columnName: string | null | undefined): boolean {
  const lower = normalizeText(columnName || "");
  return AGRO_NUMERIC_TARGET_TOKENS.some((token) => lower.includes(normalizeText(token)));
}

function detectAgroAggregatedTargetPromotion(args: {
  isAgroRegression: boolean;
  entityKey: string | null;
  timeAnchor: string | null;
  grain: string;
  currentTarget: string | null;
  columns: Array<{ column_name: string }>;
  sampleRows: Array<Record<string, unknown>>;
}) {
  const { isAgroRegression, entityKey, timeAnchor, grain, currentTarget, columns, sampleRows } = args;
  if (!isAgroRegression || !entityKey || !timeAnchor) return null;
  if (!["entity_time", "entity_product_time"].includes(grain)) return null;
  if (currentTarget === AGRO_AGGREGATED_TARGET_NAME) return null;

  const sourceColumn = pickAgroAggregationSourceColumn(columns, currentTarget);
  const targetStats = buildNumericSampleStats(sampleRows, currentTarget);
  const sourceStats = buildNumericSampleStats(sampleRows, sourceColumn);
  const stats = targetStats || sourceStats;

  const tokenSuggestsRowLevel = isLikelyAgroRowLevelValueColumn(currentTarget) || isLikelyAgroRowLevelValueColumn(sourceColumn);
  const statsSuggestDegenerate = !!stats && (
    stats.unique_count <= 2 ||
    stats.dominant_ratio >= 0.9 ||
    stats.std <= 1e-9
  );

  if (!tokenSuggestsRowLevel && !statsSuggestDegenerate) return null;

  const baseColumn = sourceColumn || currentTarget;
  const aggregationFormula = baseColumn && /qtdsac|sacas/i.test(baseColumn)
    ? `SUM(${baseColumn}) GROUP BY ${entityKey}, month(${timeAnchor})`
    : `COUNT(*) GROUP BY ${entityKey}, month(${timeAnchor})`;

  return {
    target_name: AGRO_AGGREGATED_TARGET_NAME,
    source_column: currentTarget,
    aggregation_base_column: baseColumn,
    grain: "entity_time",
    dataset_build_mode: "temporal_aggregated",
    split_strategy: "temporal",
    aggregation_formula: aggregationFormula,
    evidence: {
      token_suggests_row_level: tokenSuggestsRowLevel,
      sample_stats: stats,
    },
    reason: baseColumn && /qtdsac|sacas/i.test(baseColumn)
      ? `Caso agro transacional com medida row-level degenerada. O target oficial deve ser ${AGRO_AGGREGATED_TARGET_NAME} = SUM(${baseColumn}) por ${entityKey} × mês.`
      : `Caso agro transacional com medida row-level degenerada. O target oficial deve ser ${AGRO_AGGREGATED_TARGET_NAME} por ${entityKey} × mês, com builder temporal agregado.`,
  };
}

function getAgroAggregatedFeatureBlockReason(
  columnName: string,
  inferredType: string,
  entityKey: string | null,
  timeAnchor: string | null,
  aggregationBaseColumn: string | null,
): string | null {
  const lower = normalizeText(columnName);
  const blockedStructural = new Set(
    [entityKey, timeAnchor, aggregationBaseColumn, AGRO_AGGREGATED_TARGET_NAME]
      .filter(Boolean)
      .map((value) => normalizeText(String(value))),
  );

  if (blockedStructural.has(lower)) return "coluna estrutural do caso agregado";
  if (isAllowedCalendarDimension(columnName)) return null;
  if (lower.startsWith("sk_") || lower.startsWith("__")) return "chave substituta";
  if (lower.includes("codlot")) return "identificador da entidade";
  if (isDateColumn(columnName, inferredType || "")) return "coluna temporal operacional";
  if (["qtdpes", "qtdsac", "sacas", "peso", "volume", "quantidade"].some((token) => lower.includes(token))) {
    return "medida operacional row-level/proxy do target";
  }
  return null;
}

// ═══ Main ══════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const { project_id, organization_id, mode = "assisted" } = body;

    if (!project_id || !organization_id) {
      return new Response(JSON.stringify({ error: "project_id e organization_id obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[PRE] Starting resolution for project=${project_id} mode=${mode}`);

    // ── Gather all inputs in parallel ──────────────────────────
    const [
      settingsRes, columnsRes, selectionRes, datasetStateRes, sampleRes,
    ] = await Promise.all([
      sb.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      sb.from("project_columns").select("column_name, inferred_type, is_target, is_entity_key, is_time_anchor, distinct_count, null_percent, sample_values").eq("project_id", project_id),
      sb.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      sb.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      sb.from("project_dataset_sample").select("sample_json").eq("project_id", project_id).maybeSingle(),
    ]);

    const settings = settingsRes.data as Record<string, any> | null;
    const columns = (columnsRes.data || []) as Array<{ column_name: string; inferred_type: string; [k: string]: any }>;
    const modelSelection = selectionRes.data as Record<string, any> | null;
    const datasetState = datasetStateRes.data as Record<string, any> | null;
    const sampleJson = (sampleRes.data as Record<string, any> | null)?.sample_json as Record<string, any> | null;
    const sampleRows = Array.isArray(sampleJson?.rows)
      ? (sampleJson.rows as Array<Record<string, unknown>>).slice(0, 1000)
      : [];

    const intentContractV3 = settings?.intent_contract_v3 || null;
    const edaProfile = settings?.eda_profile_json || null;
    // ── CRITICAL FIX: Read tde_profile_result FIRST, fallback to tde_profile ──
    const tdeProfile = settings?.tde_profile_result || settings?.tde_profile || null;
    const businessIntent = settings?.business_intent_contract || null;
    const targetIntentResolution = settings?.target_intent_resolution || null;

    // ── Detect Agro domain ──────────────────────────────────
    const isAgro = isAgroProject(settings || {});
    const objective = intentContractV3?.prediction_request?.objective
      || businessIntent?.objective || "generic_prediction";
    const objLower = (objective || "").toLowerCase();
    const tdeValueCandidates = [
      ...((tdeProfile?.candidates?.value_candidates || []) as any[]),
      ...((tdeProfile?.target_candidates || []) as any[]),
    ].map((candidate) => typeof candidate === "string" ? candidate : candidate?.column || candidate?.name || "");
    const hasAgroValueSignal = tdeValueCandidates.some((columnName) => hasAgroNumericSignal(columnName))
      || columns.some((column) => hasAgroNumericSignal(column.column_name));
    const isAgroRegression = isAgro && (isAgroRegressionObjective(objective) || (!objective || objective === "generic_prediction") && hasAgroValueSignal);

    console.log(`[PRE] Domain: isAgro=${isAgro}, isAgroRegression=${isAgroRegression}, objective=${objective}`);

    // ── Resolve problem type ───────────────────────────────────
    const CLASSIFICATION_OBJ = ["churn", "turnover", "no_show", "default_risk", "inadimplencia", "propensity", "anomaly", "risk_scoring"];
    const REGRESSION_OBJ = ["demand_forecast", "revenue", "ticket", "value_forecast", "lifetime_value", "price_optimization"];

    let problemType: string;
    if (isAgroRegression) {
      // AGRO RULE: regression is the strong default for production/captation objectives
      problemType = "regression";
      console.log(`[PRE] AGRO_OVERRIDE: forcing regression for objective="${objective}"`);
    } else {
      problemType = REGRESSION_OBJ.some((r: string) => objLower.includes(r)) ? "regression" : "classification";
    }

    // ── Resolve entity key ─────────────────────────────────────
    const ENTITY_PATTERNS = ["id_cliente", "customer_id", "client_id", "cpf", "cnpj", "patient_id", "id_paciente", "student_id", "employee_id", "matricula", "account_id", "user_id", "id_conta", "contract_id"];
    const AGRO_ENTITY_PATTERNS = ["codlot", "codpes", "sk_pessoa", "sk_lotecaf", "codgre", "cod_produtor", "cod_cooperado", "cod_fazenda", "cod_talhao", "id_safra", "cod_propriedade", "sk_filial"];
    const BLOCKED_ENTITY = ["nome", "name", "email", "telefone", "phone", "endereco", "address", "descricao"];

    const entityPatterns = isAgro ? [...AGRO_ENTITY_PATTERNS, ...ENTITY_PATTERNS] : ENTITY_PATTERNS;

    let entityKey: string | null = null;
    let entityConfidence = 0;
    let entityReasoning = "Não detectado.";

    if (modelSelection?.entity_key) {
      entityKey = modelSelection.entity_key;
      entityConfidence = 0.9;
      entityReasoning = "Herdado da seleção existente.";
    } else if (tdeProfile?.candidates?.entity_candidates?.length) {
      const top = tdeProfile.candidates.entity_candidates[0];
      entityKey = typeof top === "string" ? top : top?.column;
      entityConfidence = 0.8;
      entityReasoning = "Sugerido pelo TDE.";
    } else if (tdeProfile?.entity_key_candidates?.length) {
      const top = tdeProfile.entity_key_candidates[0];
      entityKey = typeof top === "string" ? top : top?.column;
      entityConfidence = 0.8;
      entityReasoning = "Sugerido pelo TDE (legacy).";
    } else {
      for (const pattern of entityPatterns) {
        const match = columns.find((c: any) => c.column_name.toLowerCase().includes(pattern));
        if (match && !BLOCKED_ENTITY.some(b => match.column_name.toLowerCase().includes(b))) {
          entityKey = match.column_name;
          entityConfidence = 0.7;
          entityReasoning = `Padrão detectado: ${pattern}.`;
          break;
        }
      }
    }

    // ── Resolve time anchor ────────────────────────────────────
    const TIME_PATTERNS = ["data_ref", "dt_ref", "reference_date", "created_at", "data_criacao", "order_date", "data_compra", "data_pedido", "data_internacao", "admission_date", "hire_date"];
    const AGRO_TIME_PATTERNS = ["datmov", "dt_mov", "data_movimentacao", "data_operacional", "data_entrada", "data_recebimento"];
    const BLOCKED_TIME = ["data_cancelamento", "cancellation_date", "data_obito", "data_encerramento", "close_date", "data_saida"];

    const timePatterns = isAgro ? [...AGRO_TIME_PATTERNS, ...TIME_PATTERNS] : TIME_PATTERNS;

    let timeAnchor: string | null = null;
    let timeConfidence = 0;
    let timeReasoning = "Não detectado.";

    // For Agro: prefer operational date from movement table over calendar SK_DATA
    if (tdeProfile?.candidates?.time_candidates?.length) {
      const timeCandidates = tdeProfile.candidates.time_candidates;
      // Filter out calendar columns for agro — prefer operational dates
      const filtered = isAgro
        ? timeCandidates.filter((t: any) => !isCalendarColumn(typeof t === "string" ? t : t?.column || ""))
        : timeCandidates;
      const top = filtered[0] || timeCandidates[0];
      timeAnchor = typeof top === "string" ? top : top?.column;
      timeConfidence = 0.8;
      timeReasoning = isAgro && filtered[0] ? "Data operacional da movimentação (preferida sobre calendário)." : "Sugerido pelo TDE.";
    } else if (tdeProfile?.time_anchor_candidates?.length) {
      const top = tdeProfile.time_anchor_candidates[0];
      timeAnchor = typeof top === "string" ? top : top?.column;
      timeConfidence = 0.8;
      timeReasoning = "Sugerido pelo TDE (legacy).";
    } else {
      const dateCols = columns.filter((c: any) => isDateColumn(c.column_name, c.inferred_type || ""));
      for (const pattern of timePatterns) {
        const match = dateCols.find((c: any) => c.column_name.toLowerCase().includes(pattern));
        if (match && !BLOCKED_TIME.some((b: string) => match.column_name.toLowerCase().includes(b))) {
          timeAnchor = match.column_name;
          timeConfidence = 0.7;
          timeReasoning = `Padrão detectado: ${pattern}.`;
          break;
        }
      }
      if (!timeAnchor && dateCols.length > 0) {
        // For agro: prefer non-calendar date columns
        const safeCols = isAgro
          ? dateCols.filter((c: any) => !isCalendarColumn(c.column_name) && !BLOCKED_TIME.some((b: string) => c.column_name.toLowerCase().includes(b)))
          : dateCols.filter((c: any) => !BLOCKED_TIME.some((b: string) => c.column_name.toLowerCase().includes(b)));
        const safe = safeCols[0] || dateCols.find((c: any) => !BLOCKED_TIME.some((b: string) => c.column_name.toLowerCase().includes(b)));
        if (safe) {
          timeAnchor = safe.column_name;
          timeConfidence = 0.5;
          timeReasoning = `Primeira coluna temporal válida: ${safe.column_name}.`;
        }
      }
    }

    // ── Resolve target ─────────────────────────────────────────
    const LEAKAGE_TOKENS = ["status_final", "resultado", "outcome", "target", "label", "churn", "churned", "cancelled", "cancelado", "inadimplente", "defaulted", "saiu", "obito"];

    interface TargetCandidate {
      column: string; score: number; mode: string; reasoning: string;
      business_fit: number; semantic_fit: number; temporal_fit: number; trainability_fit: number; leakage_penalty: number;
      domain_mismatch_penalty: number;
    }
    const candidates: TargetCandidate[] = [];

    // ── CRITICAL BLOCKER: Date columns can NEVER be target ──
    function isBlockedAsTarget(colName: string, colType: string): { blocked: boolean; reason: string } {
      if (isDateColumn(colName, colType)) {
        return { blocked: true, reason: "BLOCK_DATE_AS_TARGET: Colunas temporais não podem ser variável alvo." };
      }
      if (isCalendarColumn(colName)) {
        return { blocked: true, reason: "BLOCK_CALENDAR_AS_TARGET: Colunas de calendário não são variáveis alvo." };
      }
      // Block surrogate keys
      const lo = colName.toLowerCase();
      if (lo.startsWith("sk_") || lo.startsWith("__")) {
        return { blocked: true, reason: "BLOCK_SURROGATE_KEY: Chave surrogada não é variável alvo." };
      }
      return { blocked: false, reason: "" };
    }

    // From contract
    const dataExp = intentContractV3?.data_expectations;
    if (dataExp?.has_outcome_column === true && dataExp?.outcome_column_name) {
      const col = columns.find((c: any) => c.column_name.toLowerCase() === dataExp.outcome_column_name.toLowerCase());
      if (col) {
        const block = isBlockedAsTarget(col.column_name, col.inferred_type || "");
        if (!block.blocked) {
          candidates.push({ column: col.column_name, score: 0.95, mode: "explicit",
            reasoning: "Declarado no contrato.", business_fit: 1, semantic_fit: 0.9, temporal_fit: 0.9, trainability_fit: 0.9, leakage_penalty: 0, domain_mismatch_penalty: 0 });
        } else {
          console.log(`[PRE] Contract target BLOCKED: ${col.column_name} — ${block.reason}`);
        }
      }
    }

    // From model selection
    if (modelSelection?.target_column) {
      const col = columns.find((c: any) => c.column_name === modelSelection.target_column);
      if (col && !candidates.some((c: TargetCandidate) => c.column === col.column_name)) {
        const block = isBlockedAsTarget(col.column_name, col.inferred_type || "");
        if (!block.blocked) {
          candidates.push({ column: col.column_name, score: 0.9, mode: "explicit",
            reasoning: "Herdado da seleção.", business_fit: 0.8, semantic_fit: 0.9, temporal_fit: 0.8, trainability_fit: 0.9, leakage_penalty: 0, domain_mismatch_penalty: 0 });
        }
      }
    }

    // ── AGRO: Prioritize numeric volume columns from movement table ──
    if (isAgroRegression) {
      for (const col of columns) {
        if (candidates.some((c: TargetCandidate) => c.column === col.column_name)) continue;
        const block = isBlockedAsTarget(col.column_name, col.inferred_type || "");
        if (block.blocked) continue;

        const lo = col.column_name.toLowerCase();
        const isNumeric = ["numeric", "numérico", "integer", "inteiro", "float", "number"].includes((col.inferred_type || "").toLowerCase());
        if (!isNumeric) continue;

        const isAgroTarget = AGRO_NUMERIC_TARGET_TOKENS.some(t => lo.includes(t));
        if (isAgroTarget) {
          const isFromMovement = lo.includes("moviment") || lo.includes("detalhe") || !isCalendarColumn(col.column_name);
          const score = isFromMovement ? 0.92 : 0.75;
          candidates.push({
            column: col.column_name, score, mode: "agro_domain",
            reasoning: `Coluna numérica agro de volume/captação (${col.column_name}).`,
            business_fit: 0.95, semantic_fit: 0.9, temporal_fit: 0.7, trainability_fit: 0.85,
            leakage_penalty: 0, domain_mismatch_penalty: 0,
          });
          console.log(`[PRE] AGRO_TARGET_BOOST: ${col.column_name} score=${score}`);
        }
      }
    }

    // From TDE profile
    if (tdeProfile?.candidates?.value_candidates?.length && isAgroRegression) {
      // For agro regression, value candidates are strong target candidates
      for (const vc of tdeProfile.candidates.value_candidates.slice(0, 5)) {
        const colName = typeof vc === "string" ? vc : vc?.column;
        if (!colName || candidates.some((c: TargetCandidate) => c.column === colName)) continue;
        const col = columns.find((c: any) => c.column_name === colName);
        if (!col) continue;
        const block = isBlockedAsTarget(colName, col.inferred_type || "");
        if (block.blocked) continue;
        candidates.push({
          column: colName, score: 0.85, mode: "tde_value",
          reasoning: `TDE value candidate: ${colName} (agro regression context).`,
          business_fit: 0.8, semantic_fit: 0.7, temporal_fit: 0.6, trainability_fit: 0.8,
          leakage_penalty: 0, domain_mismatch_penalty: 0,
        });
      }
    }

    // From TDE target_candidates (legacy path)
    if (tdeProfile?.target_candidates?.length) {
      for (const tc of tdeProfile.target_candidates.slice(0, 5)) {
        const colName = typeof tc === "string" ? tc : tc?.column || tc?.name;
        if (!colName || candidates.some((c: TargetCandidate) => c.column === colName)) continue;
        const col = columns.find((c: any) => c.column_name === colName);
        if (!col) continue;
        const block = isBlockedAsTarget(colName, col.inferred_type || "");
        if (block.blocked) {
          console.log(`[PRE] TDE target BLOCKED: ${colName} — ${block.reason}`);
          continue;
        }
        const leak = LEAKAGE_TOKENS.some((t: string) => colName.toLowerCase().includes(t)) ? 0.3 : 0;
        // Agro domain mismatch: penalize status/event columns in regression context
        const domainMismatch = (isAgroRegression && (colName.toLowerCase().includes("status") || colName.toLowerCase().includes("tipo"))) ? 0.25 : 0;
        candidates.push({ column: colName, score: (tc?.score || 0.6) - leak - domainMismatch, mode: "explicit",
          reasoning: `TDE: ${tc?.reason || "candidato"}.`, business_fit: 0.6, semantic_fit: 0.6, temporal_fit: 0.5, trainability_fit: 0.6, leakage_penalty: leak, domain_mismatch_penalty: domainMismatch });
      }
    }

    // From TDE status_candidates
    if (tdeProfile?.candidates?.status_candidates?.length) {
      for (const sc of tdeProfile.candidates.status_candidates.slice(0, 3)) {
        const colName = typeof sc === "string" ? sc : sc?.column;
        if (!colName || candidates.some((c: TargetCandidate) => c.column === colName)) continue;
        const col = columns.find((c: any) => c.column_name === colName);
        if (!col) continue;
        const block = isBlockedAsTarget(colName, col.inferred_type || "");
        if (block.blocked) continue;
        // Heavy penalty for status in agro regression
        const domainMismatch = isAgroRegression ? 0.4 : 0;
        candidates.push({
          column: colName, score: 0.55 - domainMismatch, mode: "tde_status",
          reasoning: `TDE status candidate: ${colName}.`,
          business_fit: 0.5, semantic_fit: 0.5, temporal_fit: 0.3, trainability_fit: 0.6,
          leakage_penalty: 0, domain_mismatch_penalty: domainMismatch,
        });
      }
    }

    // Binary heuristic (only for classification, never for agro regression)
    if (problemType === "classification" && !isAgroRegression && candidates.length < 3) {
      for (const col of columns) {
        if (candidates.some((c: TargetCandidate) => c.column === col.column_name)) continue;
        const block = isBlockedAsTarget(col.column_name, col.inferred_type || "");
        if (block.blocked) continue;
        const n = col.column_name.toLowerCase();
        const t = (col.inferred_type || "").toLowerCase();
        if (t === "boolean" || n.includes("flag") || n.includes("is_")) {
          const leak = LEAKAGE_TOKENS.some((tk: string) => n.includes(tk)) ? 0.4 : 0;
          candidates.push({ column: col.column_name, score: 0.5 - leak, mode: "explicit",
            reasoning: "Coluna binária por heurística.", business_fit: 0.4, semantic_fit: 0.5, temporal_fit: 0.3, trainability_fit: 0.6, leakage_penalty: leak, domain_mismatch_penalty: 0 });
        }
      }
    }

    candidates.sort((a: TargetCandidate, b: TargetCandidate) => b.score - a.score);
    const best = candidates[0];
    const THRESHOLD = 0.6;

    let targetDef = (!best || best.score < THRESHOLD)
      ? { mode: "blocked", target_name: null, target_source_column: null, target_rule: null, target_kind: "unknown", target_confidence: 0,
          target_reasoning: "Nenhum target com confiança suficiente.", alternatives: candidates }
      : { mode: best.mode, target_name: best.column, target_source_column: best.column, target_rule: best.reasoning,
          target_kind: problemType === "regression" ? "continuous" : "binary", target_confidence: best.score,
          target_reasoning: best.reasoning, alternatives: candidates.slice(1) };

    // ── Grain ──────────────────────────────────────────────────
    let grain = "original_row";
    let grainReasoning = "Grain padrão.";

    if (isAgroRegression) {
      grain = entityKey ? "entity_product_time" : "entity_time";
      grainReasoning = "Agro produção: grain por entidade × tempo/safra.";
    } else if (["churn", "turnover", "no_show", "default_risk", "inadimplencia"].some((o: string) => objLower.includes(o))) {
      grain = "entity_time";
      grainReasoning = "Evento futuro por entidade.";
    } else if (["demand_forecast", "revenue", "value_forecast"].some((o: string) => objLower.includes(o))) {
      grain = entityKey ? "entity_product_time" : "entity_time";
      grainReasoning = "Forecast temporal.";
    }

    const aggregationPromotion = detectAgroAggregatedTargetPromotion({
      isAgroRegression,
      entityKey,
      timeAnchor,
      grain,
      currentTarget: targetDef.target_name,
      columns,
      sampleRows,
    });

    if (aggregationPromotion) {
      targetDef = {
        mode: "derived_aggregation",
        target_name: aggregationPromotion.target_name,
        target_source_column: aggregationPromotion.aggregation_base_column,
        target_rule: aggregationPromotion.aggregation_formula,
        target_kind: "continuous",
        target_confidence: Math.max(targetDef.target_confidence || 0, 0.92),
        target_reasoning: aggregationPromotion.reason,
        alternatives: [
          ...(targetDef.target_name
            ? [{
              column: targetDef.target_name,
              problem_type: problemType,
              strategy: targetDef.mode,
              confidence: targetDef.target_confidence || 0,
              reasoning: targetDef.target_reasoning,
            }]
            : []),
          ...candidates.slice(0, 4),
        ],
        aggregation_metadata: aggregationPromotion,
      };
      grain = aggregationPromotion.grain;
      grainReasoning = "Caso agro transacional com medida row-level degenerada — target promovido para agregação temporal por entidade × mês.";
    }

    const dataShape = intentContractV3?.data_expectations?.expected_data_shape || "unknown";

    // ── Dataset strategy ───────────────────────────────────────
    const needsAgg = !!aggregationPromotion || grain === "aggregated" || grain === "entity_product_time";
    const snapshotReq = grain === "entity_time" && !!timeAnchor && dataShape === "multiple_rows_per_entity";
    const targetBuildMode = aggregationPromotion
      ? "temporal_aggregated"
      : needsAgg && !!timeAnchor
        ? "temporal_aggregated"
        : snapshotReq
          ? "entity_time"
          : "row_level";

    // ── Universal Multi-Table Structural Resolution ───────────
    const hasMultiTable = columns.some((c: any) => c.column_name.includes("."));
    let primaryTable: string | null = null;
    let auxiliaryTables: string[] = [];

    // Universal fact/dimension tokens (core platform)
    const CORE_FACT_TOKENS = [
      "fato", "fact", "fact_", "transacao", "transaction", "moviment", "movimento",
      "detalhe", "detail", "evento", "event", "pedido", "order", "venda", "sale",
      "compra", "purchase", "lancamento", "entry", "operacao", "ticket", "sinistro",
      "claim", "atendimento", "visit", "internacao", "admission", "remessa", "shipment",
      "pagamento", "payment", "recebimento", "pesagem", "lote", "lotecaf",
    ];
    const CORE_DIMENSION_TOKENS = [
      "dim_", "cadastro", "master", "cliente", "customer", "produto", "product",
      "filial", "branch", "store", "loja", "fornecedor", "supplier",
      "funcionario", "employee", "medico", "doctor", "aluno", "student",
      "paciente", "patient", "cooperado", "regiao", "region", "categoria", "category",
      "calendario", "calendar", "dimdate", "dimcalendar", "lookup", "ref_",
      "origem", "origin", "representante", "safra", "fazenda", "farm",
      "produtor", "producer", "municipio", "grupo_economico", "segmento",
    ];
    // Universal admin ID blockers
    const UNIVERSAL_ADMIN_BLOCKED = [
      "celcpr", "cel_cpr", "celular", "telefone", "phone", "fone", "mobile",
      "matricula", "matric", "codemp", "cod_emp", "cpf", "cnpj", "rg",
      "email", "endereco", "cep", "razao_social", "fantasia", "nome", "name",
    ];

    function classifyTableRolePRE(tableName: string): "fact" | "dimension" | "unknown" {
      const lo = tableName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (CORE_FACT_TOKENS.some(t => lo.includes(t))) return "fact";
      if (CORE_DIMENSION_TOKENS.some(t => lo.includes(t))) return "dimension";
      return "unknown";
    }

    if (hasMultiTable) {
      const tableNames = [...new Set(columns.map((c: any) => c.column_name.split(".")[0]).filter(Boolean))];
      const tableRoles: Record<string, "fact" | "dimension" | "unknown"> = {};

      for (const t of tableNames) {
        tableRoles[t] = classifyTableRolePRE(t);
      }

      // Pick primary fact table
      const factTables = tableNames.filter(t => tableRoles[t] === "fact");
      if (factTables.length > 0) {
        // Prefer tables with operational keywords (movement/detail/lot)
        primaryTable = factTables.find(t => {
          const lo = t.toLowerCase();
          return ["movimenta", "detalhe", "lote", "pedido", "venda", "transacao", "atendimento"].some(k => lo.includes(k));
        }) || factTables[0];
      } else {
        primaryTable = tableNames.find(t => tableRoles[t] === "unknown") || tableNames[0];
      }

      auxiliaryTables = tableNames.filter(t => t !== primaryTable);
      console.log(`[PRE] MULTI_TABLE: primary="${primaryTable}" (${tableRoles[primaryTable!]}), aux=[${auxiliaryTables.map(t => `${t}(${tableRoles[t]})`).join(", ")}]`);

      // ── UNIVERSAL MULTI-TABLE ENTITY/TIME OVERRIDE ──
      // If entity/time came from a dimension table but a fact table exists, re-resolve
      if (primaryTable) {
        const entityTableName = entityKey && entityKey.includes(".") ? entityKey.split(".")[0] : null;
        const entityTableRole = entityTableName ? tableRoles[entityTableName] : null;

        if (entityTableRole === "dimension" && entityKey) {
          // Re-resolve entity from fact table columns
          const factCols = columns.filter((c: any) => c.column_name.startsWith(primaryTable + "."));
          // Try known entity patterns (universal)
          const entityPatterns = isAgro
            ? ["codlot", "cod_lote", "lote", "cod_talhao"]
            : ["id_cliente", "customer_id", "client_id", "patient_id", "id_paciente", "account_id", "order_id", "contract_id"];
          for (const pattern of entityPatterns) {
            const match = factCols.find((c: any) => c.column_name.toLowerCase().includes(pattern));
            if (match) {
              console.log(`[PRE] MULTI_TABLE_ENTITY_OVERRIDE: ${entityKey} → ${match.column_name} (dimension → fact table)`);
              entityKey = match.column_name;
              entityConfidence = 0.95;
              entityReasoning = `Re-resolved: entity from fact table "${primaryTable}" has priority over dimension.`;
              break;
            }
          }
          // Generic fallback: any non-SK ID from fact table
          if (entityKey && entityKey.includes(".") && tableRoles[entityKey.split(".")[0]] === "dimension") {
            const genericFactEntity = factCols.find((c: any) => {
              const cp = c.column_name.split(".").pop()!.toLowerCase();
              return ["cod", "id", "codigo", "key"].some(k => cp.includes(k)) && !/^(sk_|pk_|fk_|__)/i.test(cp);
            });
            if (genericFactEntity) {
              console.log(`[PRE] MULTI_TABLE_ENTITY_OVERRIDE_GENERIC: ${entityKey} → ${genericFactEntity.column_name}`);
              entityKey = genericFactEntity.column_name;
              entityConfidence = 0.85;
              entityReasoning = `Re-resolved: generic entity from fact table "${primaryTable}".`;
            }
          }
        }

        // Time: override if from dimension table (universal rule)
        const timeTableName = timeAnchor && timeAnchor.includes(".") ? timeAnchor.split(".")[0] : null;
        const timeTableRole = timeTableName ? tableRoles[timeTableName] : null;
        if (timeTableRole === "dimension" && timeAnchor) {
          const factCols = columns.filter((c: any) => c.column_name.startsWith(primaryTable + "."));
          // Universal operational date tokens
          const opDateTokens = [
            "datmov", "dt_mov", "data_mov", "data_movimento", "data_movimentacao",
            "data_compra", "purchase_date", "order_date", "data_pedido", "data_venda",
            "data_recebimento", "data_entrada", "data_pesagem", "data_transacao",
            "data_internacao", "data_consulta", "data_sinistro", "data_embarque",
          ];
          for (const pattern of opDateTokens) {
            const match = factCols.find((c: any) => c.column_name.toLowerCase().includes(pattern));
            if (match) {
              console.log(`[PRE] MULTI_TABLE_TIME_OVERRIDE: ${timeAnchor} → ${match.column_name} (dimension → fact table)`);
              timeAnchor = match.column_name;
              timeConfidence = 0.95;
              timeReasoning = `Re-resolved: operational date from fact table "${primaryTable}" has priority over dimension.`;
              break;
            }
          }
          // Fallback: any date column from fact table
          if (timeAnchor && timeAnchor.includes(".") && tableRoles[timeAnchor.split(".")[0]] === "dimension") {
            const factDate = factCols.find((c: any) => {
              const ty = ((c as any).inferred_type || "").toLowerCase();
              return ["date", "datetime", "timestamp", "data"].some(d => ty.includes(d));
            });
            if (factDate) {
              console.log(`[PRE] MULTI_TABLE_TIME_OVERRIDE_FALLBACK: ${timeAnchor} → ${factDate.column_name}`);
              timeAnchor = factDate.column_name;
              timeConfidence = 0.8;
              timeReasoning = `Re-resolved: date from fact table "${primaryTable}" as fallback.`;
            }
          }
        }
      }
    }
    const auxiliaryTable = auxiliaryTables[0] || null;

    const datasetStrategy = {
      needs_aggregation: needsAgg,
      aggregation_level: needsAgg ? "entity_time_month" : null,
      snapshot_required: snapshotReq,
      temporal_strategy: snapshotReq ? "multi_period" : (timeAnchor ? "snapshot" : "none"),
      multi_table_strategy: hasMultiTable ? { primary_table: primaryTable, auxiliary_tables: auxiliaryTables, dimension_tables: auxiliaryTables.filter(t => CORE_DIMENSION_TOKENS.some(tok => t.toLowerCase().includes(tok))), calendar_role: "temporal_enrichment" } : null,
      split_suggestion: timeAnchor ? "temporal" : "stratified",
      target_build_mode: targetBuildMode,
      aggregated_target_required: !!aggregationPromotion,
      aggregated_target_plan: aggregationPromotion,
    };

    // ── Feature plan ───────────────────────────────────────────
    const forbidden = new Set(intentContractV3?.business_rules?.forbidden_features || []);
    const knownLeak = new Set(intentContractV3?.business_rules?.known_leakage_columns || []);
    const includeFeatures: string[] = [];
    const excludeFeatures: string[] = [];
    const blockedFeatures: string[] = [];
    const leakageFlags: string[] = [];

    // Universal multi-table feature blocking (applies to ALL domains)
    for (const col of columns) {
      const nm = col.column_name;
      const lo = nm.toLowerCase();
      const colPart = lo.includes(".") ? lo.split(".").pop()! : lo;
      const tableName = lo.includes(".") ? lo.split(".")[0] : null;
      const tableRole = tableName ? classifyTableRolePRE(tableName) : null;
      const isFromDim = tableRole === "dimension";

      if (nm === (targetDef.target_name || "") || nm === entityKey || nm === timeAnchor) { excludeFeatures.push(nm); continue; }

      // ── UNIVERSAL: Block SK_*, PK_*, FK_*, __ prefixed from everywhere ──
      if (/^(sk_|pk_|fk_|__)/i.test(colPart)) {
        excludeFeatures.push(nm);
        continue;
      }

      // ── UNIVERSAL: Block admin IDs — from dimension tables AND everywhere ──
      if (UNIVERSAL_ADMIN_BLOCKED.some(t => colPart === t || colPart.includes(t))) {
        excludeFeatures.push(nm);
        continue;
      }

      // ── UNIVERSAL: Block raw FK entity codes from dimension tables ──
      if (hasMultiTable && isFromDim) {
        if (["codpes", "codlot", "codgre", "cod_produtor", "cod_cooperado", "cod_cliente", "customer_id", "patient_id"].some(t => colPart.includes(t))) {
          excludeFeatures.push(nm);
          continue;
        }
      }

      if (aggregationPromotion) {
        const blockReason = getAgroAggregatedFeatureBlockReason(
          nm,
          col.inferred_type || "",
          entityKey,
          timeAnchor,
          aggregationPromotion.aggregation_base_column,
        );
        if (blockReason) {
          excludeFeatures.push(nm);
          continue;
        }
      }
      if (forbidden.has(nm)) { blockedFeatures.push(nm); continue; }
      if (knownLeak.has(nm)) { leakageFlags.push(nm); blockedFeatures.push(nm); continue; }
      if (LEAKAGE_TOKENS.some((t: string) => lo.includes(t)) && nm !== targetDef.target_name) { leakageFlags.push(nm); excludeFeatures.push(nm); continue; }
      if (BLOCKED_ENTITY.some((p: string) => lo.includes(p))) { excludeFeatures.push(nm); continue; }
      includeFeatures.push(nm);
    }

    // ── Horizon ────────────────────────────────────────────────
    let horizonDays = 30;
    if (intentContractV3?.prediction_request?.horizon?.value) {
      const h = intentContractV3.prediction_request.horizon;
      horizonDays = h.unit === "weeks" ? h.value * 7 : h.unit === "months" ? h.value * 30 : h.value;
    }

    // ── Validation ─────────────────────────────────────────────
    const issues: Array<{ code: string; severity: string; message: string; suggestion?: string }> = [];
    const blocking: string[] = [];

    if (!entityKey) issues.push({ code: "NO_ENTITY_KEY", severity: "warn", message: "Sem entity_key detectado.", suggestion: "Selecione manualmente." });
    if (targetDef.mode === "blocked") { issues.push({ code: "NO_TARGET", severity: "block", message: "Sem target válido.", suggestion: "Defina manualmente." }); blocking.push("NO_TARGET"); }
    if (["entity_time", "entity_product_time"].includes(grain) && !timeAnchor) { issues.push({ code: "NO_TIME_ANCHOR", severity: "block", message: "Problema temporal sem âncora.", suggestion: "Selecione coluna temporal." }); blocking.push("NO_TIME_ANCHOR"); }

    // Agro governance: block if date column is target
    if (targetDef.target_name && isDateColumn(targetDef.target_name, "")) {
      issues.push({ code: "BLOCK_DATE_AS_TARGET", severity: "block", message: `Coluna temporal "${targetDef.target_name}" não pode ser variável alvo.`, suggestion: "Selecione uma coluna numérica de volume/captação." });
      blocking.push("BLOCK_DATE_AS_TARGET");
    }

    // ── Confidence ─────────────────────────────────────────────
    let problemFit = intentContractV3 ? 0.8 : 0.5;
    if (isAgroRegression) problemFit = 0.9; // High confidence for agro regression with matching objective
    const targetFit = targetDef.target_confidence || 0;
    let grainFit = (entityKey && timeAnchor) ? 0.9 : entityKey ? 0.7 : 0.5;
    let timeFit = timeAnchor ? 0.9 : 0.5;
    const overall = Math.round((problemFit * 0.2 + targetFit * 0.4 + grainFit * 0.2 + timeFit * 0.2) * 100) / 100;

    // ── Build resolution ───────────────────────────────────────
    const resolution = {
      version: 2,
      mode,
      domain: isAgro ? "agro" : "generic",
      problem_definition: {
        problem_type: problemType,
        business_mode: objective,
        entity: { entity_key: entityKey, grain, entity_label: intentContractV3?.prediction_request?.entity_label || "entidade" },
        dataset_shape_detected: dataShape,
        time_anchor: timeAnchor,
        horizon_days: horizonDays,
        multi_table: hasMultiTable ? { primary_table: primaryTable, auxiliary_table: auxiliaryTable } : null,
      },
      target_definition: targetDef,
      dataset_strategy: datasetStrategy,
      feature_plan: {
        include_features: includeFeatures,
        exclude_features: excludeFeatures,
        blocked_features: blockedFeatures,
        leakage_flags: leakageFlags,
        feature_reasoning: `${includeFeatures.length} incluídas, ${excludeFeatures.length} excluídas, ${blockedFeatures.length} bloqueadas.`,
      },
      validation: { training_ready: blocking.length === 0, issues_detected: issues, blocking_errors: blocking },
      explanation: {
        why_this_problem: isAgroRegression
          ? `Domínio Agro + objetivo "${objective}" = previsão de volume contínuo → regressão.`
          : problemType === "classification"
            ? `Objetivo "${objective}" = evento (sim/não) → classificação.`
            : `Objetivo "${objective}" = valor numérico → regressão.`,
        why_this_target: targetDef.target_reasoning,
        why_this_grain: grainReasoning,
        why_aggregate_target: aggregationPromotion?.reason,
        why_not_status: isAgroRegression ? "Colunas de status/evento foram penalizadas pois o objetivo é previsão contínua de volume agro." : undefined,
        why_not_date_target: "Colunas temporais são BLOQUEADAS como variável alvo — servem apenas como âncora temporal.",
        main_risks: [
          ...(targetDef.mode === "blocked" ? ["Sem target — bloqueado."] : []),
          ...(!timeAnchor ? ["Sem âncora temporal."] : []),
          ...(!entityKey ? ["Sem entity_key."] : []),
        ],
      },
      confidence: {
        overall,
        scores: { problem_fit: problemFit, target_fit: targetFit, grain_fit: grainFit, time_fit: timeFit },
      },
      inputs_used: [
        intentContractV3 && "intent_contract_v3",
        businessIntent && "business_intent_contract",
        edaProfile && "eda_profile_json",
        tdeProfile && "tde_profile_result",
        modelSelection && "model_selection",
        columns.length > 0 && "project_columns",
        isAgro && "agro_domain_rules",
      ].filter(Boolean),
      rules_triggered: [
        `PROBLEM_TYPE_${problemType.toUpperCase()}`,
        entityKey && "ENTITY_KEY_RESOLVED",
        timeAnchor && "TIME_ANCHOR_RESOLVED",
        `TARGET_MODE_${targetDef.mode.toUpperCase()}`,
        `GRAIN_${grain.toUpperCase()}`,
        isAgroRegression && "AGRO_REGRESSION_OVERRIDE",
        aggregationPromotion && "AGRO_AGGREGATED_TARGET_PROMOTION",
        hasMultiTable && "MULTI_TABLE_DETECTED",
      ].filter(Boolean),
      created_at: new Date().toISOString(),
    };

    // ── Persist ────────────────────────────────────────────────
    const selectionVersion = modelSelection?.selection_version || 0;

    // ── FINAL STRUCTURAL LOG: what PRE decided ──
    console.log(`[PRE] FINAL_DECISION: entity="${entityKey}", time="${timeAnchor}", target="${targetDef.target_name}", build_mode="${targetBuildMode}", grain="${grain}", reason="${targetDef.target_reasoning?.substring(0, 100)}"`);

    const { data: inserted, error: insertErr } = await sb
      .from("project_predictive_resolutions")
      .insert({
        project_id,
        organization_id,
        resolution_version: 2,
        intent_contract_version: 3,
        selection_version: selectionVersion,
        mode,
        resolution_json: resolution,
        overall_confidence: overall,
        status: "resolved",
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[PRE] Insert error:", insertErr);
      return new Response(JSON.stringify({ success: false, error: insertErr.message }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── STRUCTURAL SSOT SYNC: force fact-anchored values ──
    // This is the authoritative write — must not be overridden by UI fallbacks
    const ssotPayload: Record<string, any> = {
      predictive_resolution_state: "resolved",
      active_predictive_resolution_id: inserted.id,
      predictive_resolution_mode: mode,
      predictive_resolution_confidence: overall,
      recommended_target: targetDef.target_name,
      recommended_problem_type: problemType,
      recommended_target_reasoning: targetDef.target_reasoning,
      recommended_target_confidence: targetDef.target_confidence || overall,
      recommended_grain: grain,
      recommended_split_strategy: datasetStrategy.split_suggestion,
      recommended_time_column: timeAnchor,
      dataset_build_mode: targetBuildMode,
      // Write entity/time to the authoritative fields so UI/builder reads correct values
      entity_key: entityKey,
      time_anchor_column: timeAnchor,
      predictive_resolution_summary: {
        problem_type: problemType,
        target: targetDef.target_name,
        entity_key: entityKey,
        time_anchor: timeAnchor,
        grain,
        dataset_build_mode: targetBuildMode,
        confidence: overall,
        training_ready: blocking.length === 0,
        domain: isAgro ? "agro" : "generic",
        primary_table: primaryTable,
        auxiliary_table: auxiliaryTable,
        aggregated_target_required: !!aggregationPromotion,
      },
    };

    // If target is agg_*, force temporal_aggregated in SSOT
    if (/^agg_/i.test(targetDef.target_name || "")) {
      ssotPayload.dataset_build_mode = "temporal_aggregated";
      ssotPayload.target_column = targetDef.target_name;
      ssotPayload.active_target_column = targetDef.target_name;
      ssotPayload.official_target = targetDef.target_name;
      ssotPayload.official_problem_type = problemType;
      console.log(`[PRE] FORCE_AGG_SSOT: target="${targetDef.target_name}" → dataset_build_mode=temporal_aggregated`);
    }

    await sb.from("project_settings").update(ssotPayload).eq("project_id", project_id);

    console.log(`[PRE] Resolution created: id=${inserted.id} confidence=${overall} target=${targetDef.target_name} domain=${isAgro ? "agro" : "generic"}`);

    return new Response(JSON.stringify({
      success: true,
      resolution_id: inserted.id,
      resolution,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[PRE] Error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
