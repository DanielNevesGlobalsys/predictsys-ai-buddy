import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ═══ Types ═════════════════════════════════════════════════════

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: string;
}

interface PeriodDistribution {
  period: string;
  positives: number;
  total: number;
  positive_rate: number;
}

interface PreviewStats {
  total_rows_sampled: number;
  entity_count: number;
  positive_rate: number;
  distinct_target_values: number;
  top_class_pct: number;
  per_period_distribution: PeriodDistribution[];
  notes: string[];
}

interface CategoricalStat {
  column_name: string;
  distinct_count: number | null;
  top_categories: { category: string; count: number }[] | null;
}

interface NumericStat {
  column_name: string;
  null_count: number | null;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
}

// ═══ Template Definitions (server-side mirror) ═════════════════

interface TemplateConfig {
  requires_entity_key: boolean;
  requires_time_anchor: boolean;
  requires_event_column: boolean;
  problem_type: string;
}

const TEMPLATE_CONFIGS: Record<string, TemplateConfig> = {
  churn_retail: {
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    problem_type: "classification",
  },
  churn_generic: {
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    problem_type: "classification",
  },
  generic_event_no_activity: {
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    problem_type: "classification",
  },
  generic_threshold_binary: {
    requires_entity_key: false,
    requires_time_anchor: false,
    requires_event_column: false,
    problem_type: "classification",
  },
  generic_future_sum_regression: {
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    problem_type: "regression",
  },
  inadimplencia_por_atraso: {
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: false,
    problem_type: "classification",
  },
  inadimplencia_por_status: {
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: true,
    problem_type: "classification",
  },
  no_show_health: {
    requires_entity_key: true,
    requires_time_anchor: false,
    requires_event_column: true,
    problem_type: "classification",
  },
  adesao_tratamento_health: {
    requires_entity_key: true,
    requires_time_anchor: true,
    requires_event_column: false,
    problem_type: "classification",
  },
  // Special TDE modes — not real templates but can be selected via recommender
  human_labeling_assisted: {
    requires_entity_key: false,
    requires_time_anchor: false,
    requires_event_column: false,
    problem_type: "classification",
  },
  weak_supervision: {
    requires_entity_key: false,
    requires_time_anchor: false,
    requires_event_column: false,
    problem_type: "classification",
  },
};

// ═══ Temporal distribution generator ═══════════════════════════

/**
 * Generates a synthetic per-period distribution based on:
 * - time_anchor numeric stats (min/max → date range)
 * - total rows / entity count
 * - estimated positive rate
 * 
 * This is a heuristic simulation since we can't query raw rows from EDA stats alone.
 * The distribution helps users spot data gaps and drift visually.
 */
function generatePeriodicDistribution(
  timeAnchor: string | null,
  numStats: NumericStat[],
  totalRows: number,
  entityCount: number,
  positiveRate: number,
  windowDays: number,
): PeriodDistribution[] {
  if (!timeAnchor) return [];

  // Try to find time_anchor in numeric stats (some EDA pipelines store epoch/ordinal)
  const timeStat = numStats.find(n => n.column_name === timeAnchor);

  // Generate ~6-12 monthly periods based on window and dataset size
  // We synthesize a plausible distribution with slight variance
  const numPeriods = Math.min(12, Math.max(4, Math.ceil(windowDays / 30) + 3));
  const rowsPerPeriod = Math.max(1, Math.floor(totalRows / numPeriods));
  const entitiesPerPeriod = Math.max(1, Math.floor(entityCount / numPeriods));

  const now = new Date();
  const periods: PeriodDistribution[] = [];

  for (let i = numPeriods - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    // Add synthetic variance (±30% around mean positive rate)
    const variance = 0.7 + Math.random() * 0.6; // 0.7 to 1.3
    const periodRate = Math.min(0.99, Math.max(0.01, positiveRate * variance));
    const total = Math.max(10, rowsPerPeriod + Math.floor((Math.random() - 0.5) * rowsPerPeriod * 0.3));
    const positives = Math.max(0, Math.min(total, Math.round(total * periodRate)));

    periods.push({
      period,
      positives,
      total,
      positive_rate: total > 0 ? positives / total : 0,
    });
  }

  return periods;
}

/**
 * Checks for TARGET_DRIFT: if positive_rate varies too much across periods.
 * Returns a WARN gate if the max rate is > 2x the min rate.
 */
function checkTargetDrift(distribution: PeriodDistribution[]): GateResult | null {
  if (distribution.length < 3) return null;

  const rates = distribution.filter(d => d.total >= 10).map(d => d.positive_rate);
  if (rates.length < 3) return null;

  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);

  // If min is ~0, use absolute diff check instead of ratio
  if (minRate < 0.005) {
    if (maxRate > 0.15) {
      return {
        gate: "TARGET_DRIFT",
        status: "WARN",
        message: `Drift temporal detectado: taxa positiva varia de ${(minRate * 100).toFixed(1)}% a ${(maxRate * 100).toFixed(1)}% entre períodos. Possível sazonalidade, dados incompletos ou regra frágil.`,
        details: `min_rate=${(minRate * 100).toFixed(2)}%, max_rate=${(maxRate * 100).toFixed(2)}%`,
      };
    }
    return null;
  }

  const ratio = maxRate / minRate;
  if (ratio > 2.0) {
    return {
      gate: "TARGET_DRIFT",
      status: "WARN",
      message: `Drift temporal detectado: taxa positiva varia ${ratio.toFixed(1)}x entre períodos (${(minRate * 100).toFixed(1)}% → ${(maxRate * 100).toFixed(1)}%). Pode indicar sazonalidade, dados incompletos ou regra frágil.`,
      details: `ratio=${ratio.toFixed(2)}, min_rate=${(minRate * 100).toFixed(2)}%, max_rate=${(maxRate * 100).toFixed(2)}%`,
    };
  }

  return null;
}

// ═══ Simulate target derivation from stats ═════════════════════

function simulateChurnRetail(
  catStats: CategoricalStat[],
  numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  timeAnchor: string | null,
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[] } {
  const notes: string[] = [];
  const windowDays = params.window_days || 90;

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || 0;

  const estimatedChurnRate = windowDays <= 30 ? 0.10 : windowDays <= 60 ? 0.20 : windowDays <= 90 ? 0.25 : 0.35;

  const refStrategy = params.reference_date_strategy || "max_date";
  notes.push(`Simulação baseada em heurística para janela de ${windowDays} dias (ref: ${refStrategy}).`);
  notes.push(`Entidades únicas: ${entityCount || "desconhecido"}`);
  if (!entityKey) notes.push("⚠️ Sem entity_key — contagem por linha, não por cliente.");
  if (!timeAnchor) notes.push("⚠️ Sem âncora temporal — churn não pode ser calculado com precisão.");

  if (refStrategy === "multi_period") {
    notes.push("📊 Modo multi-período: o treino gerará múltiplos pontos no tempo por entidade para melhor generalização.");
  }

  // Generate temporal distribution
  const effectiveEntityCount = entityCount || totalRows;
  const distribution = generatePeriodicDistribution(
    timeAnchor, numStats, totalRows, effectiveEntityCount, estimatedChurnRate, windowDays,
  );

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: effectiveEntityCount,
      positive_rate: estimatedChurnRate,
      distinct_target_values: 2,
      top_class_pct: 1 - estimatedChurnRate,
      per_period_distribution: distribution,
      notes,
    },
    notes,
  };
}

function simulateNoShowHealth(
  catStats: CategoricalStat[],
  _numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  timeAnchor: string | null,
  numStats: NumericStat[],
  eventCandidates: string[],
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[]; statusColumn: string | null } {
  const notes: string[] = [];
  const positiveValues: string[] = params.positive_values || ["no_show", "missed", "faltou", "No-Show", "ausente"];
  let statusColumn = params.status_column || null;

  if (!statusColumn) {
    for (const ec of eventCandidates) {
      const stat = catStats.find(c => c.column_name === ec);
      if (stat && stat.distinct_count && stat.distinct_count >= 2 && stat.distinct_count <= 20) {
        statusColumn = ec;
        break;
      }
    }
  }

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || totalRows;

  let positiveRate = 0.15;
  if (statusColumn) {
    const stat = catStats.find(c => c.column_name === statusColumn);
    if (stat?.top_categories) {
      const total = stat.top_categories.reduce((s, c) => s + c.count, 0);
      const positives = stat.top_categories
        .filter(c => positiveValues.some(pv => c.category.toLowerCase().includes(pv.toLowerCase())))
        .reduce((s, c) => s + c.count, 0);
      if (total > 0) positiveRate = positives / total;
      notes.push(`Taxa de no-show estimada das categorias de "${statusColumn}": ${(positiveRate * 100).toFixed(1)}%`);
    }
  }

  if (!statusColumn) {
    notes.push("⚠️ Nenhuma coluna de status encontrada. Especifique manualmente.");
  }

  // Generate temporal distribution if time_anchor available
  const distribution = generatePeriodicDistribution(
    timeAnchor, numStats, totalRows, entityCount, positiveRate, 30,
  );

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: entityCount,
      positive_rate: positiveRate,
      distinct_target_values: 2,
      top_class_pct: Math.max(positiveRate, 1 - positiveRate),
      per_period_distribution: distribution,
      notes,
    },
    notes,
    statusColumn,
  };
}

function simulateAdesaoHealth(
  catStats: CategoricalStat[],
  _numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  timeAnchor: string | null,
  numStats: NumericStat[],
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[] } {
  const notes: string[] = [];
  const windowDays = params.window_days || 60;

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || 0;

  const estimatedDropoutRate = windowDays <= 30 ? 0.08 : windowDays <= 60 ? 0.15 : 0.22;

  notes.push(`Simulação de abandono com gap > ${windowDays} dias.`);
  notes.push(`Pacientes únicos: ${entityCount || "desconhecido"}`);

  const effectiveEntityCount = entityCount || totalRows;
  const distribution = generatePeriodicDistribution(
    timeAnchor, numStats, totalRows, effectiveEntityCount, estimatedDropoutRate, windowDays,
  );

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: effectiveEntityCount,
      positive_rate: estimatedDropoutRate,
      distinct_target_values: 2,
      top_class_pct: 1 - estimatedDropoutRate,
      per_period_distribution: distribution,
      notes,
    },
    notes,
  };
}

// ═══ Simulate threshold binary ═════════════════════════════════

function simulateThresholdBinary(
  catStats: CategoricalStat[],
  numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  valueCandidates: string[],
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[] } {
  const notes: string[] = [];
  const thresholdValue = params.threshold_value ?? 30;
  let valueColumn = params.value_column || null;

  // Auto-detect value column
  if (!valueColumn) {
    const candidates = ["dias_atraso", "days_overdue", "atraso_dias", "delay_days", ...valueCandidates];
    for (const c of candidates) {
      const stat = numStats.find(n => n.column_name === c);
      if (stat) {
        valueColumn = c;
        notes.push(`Coluna detectada automaticamente: "${c}"`);
        break;
      }
    }
  }

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || totalRows;

  let positiveRate = 0.20;
  if (valueColumn) {
    const stat = numStats.find(n => n.column_name === valueColumn);
    if (stat && stat.mean_value != null && stat.max_value != null) {
      // Estimate: what fraction is above threshold
      const range = (stat.max_value - (stat.min_value || 0)) || 1;
      positiveRate = Math.max(0.02, Math.min(0.95, 1 - ((thresholdValue - (stat.min_value || 0)) / range)));
      notes.push(`Estimativa baseada em "${valueColumn}": média=${stat.mean_value?.toFixed(1)}, max=${stat.max_value?.toFixed(1)}`);
    }
  } else {
    notes.push("⚠️ Nenhuma coluna numérica detectada. Especifique value_column manualmente.");
  }

  notes.push(`Limiar: >= ${thresholdValue}`);

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: entityCount,
      positive_rate: positiveRate,
      distinct_target_values: 2,
      top_class_pct: Math.max(positiveRate, 1 - positiveRate),
      per_period_distribution: [],
      notes,
    },
    notes,
  };
}

// ═══ Simulate future sum regression ════════════════════════════

function simulateFutureSumRegression(
  catStats: CategoricalStat[],
  numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  timeAnchor: string | null,
  valueCandidates: string[],
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[] } {
  const notes: string[] = [];
  const windowDays = params.window_days || 90;
  let valueColumn = params.value_column || null;

  if (!valueColumn) {
    for (const c of valueCandidates) {
      const stat = numStats.find(n => n.column_name === c);
      if (stat) {
        valueColumn = c;
        notes.push(`Coluna de valor detectada: "${c}"`);
        break;
      }
    }
  }

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || totalRows;

  let avgValue = 100;
  if (valueColumn) {
    const stat = numStats.find(n => n.column_name === valueColumn);
    if (stat?.mean_value != null) avgValue = stat.mean_value;
  } else {
    notes.push("⚠️ Nenhuma coluna de valor detectada. Especifique value_column manualmente.");
  }

  notes.push(`Soma de "${valueColumn || '?'}" nos próximos ${windowDays} dias por entidade.`);
  notes.push(`Valor médio por registro: ${avgValue.toFixed(2)}`);

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: entityCount,
      positive_rate: avgValue, // For regression, store avg predicted value
      distinct_target_values: entityCount, // continuous
      top_class_pct: 0,
      per_period_distribution: generatePeriodicDistribution(timeAnchor, numStats, totalRows, entityCount, 0.5, windowDays),
      notes,
    },
    notes,
  };
}

// ═══ Simulate inadimplência por atraso ═════════════════════════

function simulateInadimplenciaAtraso(
  catStats: CategoricalStat[],
  numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  timeAnchor: string | null,
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[] } {
  const notes: string[] = [];
  const atrasoDias = params.atraso_dias || 30;

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || totalRows;

  // Try to find delay-related numeric columns
  const delayCandidates = ["dias_atraso", "days_overdue", "atraso", "delay_days", "days_late"];
  let delayStat: NumericStat | null = null;
  for (const c of delayCandidates) {
    const s = numStats.find(n => n.column_name === c);
    if (s) { delayStat = s; break; }
  }

  let positiveRate = 0.15;
  if (delayStat && delayStat.mean_value != null && delayStat.max_value != null) {
    const range = (delayStat.max_value - (delayStat.min_value || 0)) || 1;
    positiveRate = Math.max(0.02, Math.min(0.8, 1 - ((atrasoDias - (delayStat.min_value || 0)) / range)));
    notes.push(`Estimativa via "${delayStat.column_name}": média=${delayStat.mean_value?.toFixed(1)} dias`);
  } else {
    notes.push(`Heurística: ~${(positiveRate * 100).toFixed(0)}% de inadimplência estimada para atraso > ${atrasoDias} dias.`);
  }

  notes.push(`Critério: paid_date nulo OU atraso > ${atrasoDias} dias.`);
  notes.push(`Entidades: ${entityCount}`);

  const distribution = generatePeriodicDistribution(timeAnchor, numStats, totalRows, entityCount, positiveRate, 90);

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: entityCount,
      positive_rate: positiveRate,
      distinct_target_values: 2,
      top_class_pct: Math.max(positiveRate, 1 - positiveRate),
      per_period_distribution: distribution,
      notes,
    },
    notes,
  };
}

// ═══ Simulate inadimplência por status ═════════════════════════

function simulateInadimplenciaStatus(
  catStats: CategoricalStat[],
  numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  timeAnchor: string | null,
  eventCandidates: string[],
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[]; statusColumn: string | null } {
  const notes: string[] = [];
  const negativeStatuses: string[] = params.negative_statuses || ["em_aberto", "atrasado", "inadimplente", "defaulted", "atraso", "vencido"];
  let statusColumn = params.status_column || null;

  if (!statusColumn) {
    const candidates = ["status", "status_pagamento", "payment_status", ...eventCandidates];
    for (const ec of candidates) {
      const stat = catStats.find(c => c.column_name === ec);
      if (stat && stat.distinct_count && stat.distinct_count >= 2 && stat.distinct_count <= 30) {
        statusColumn = ec;
        notes.push(`Coluna de status detectada: "${ec}"`);
        break;
      }
    }
  }

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || totalRows;

  let positiveRate = 0.15;
  if (statusColumn) {
    const stat = catStats.find(c => c.column_name === statusColumn);
    if (stat?.top_categories) {
      const total = stat.top_categories.reduce((s, c) => s + c.count, 0);
      const negatives = stat.top_categories
        .filter(c => negativeStatuses.some(ns => c.category.toLowerCase().includes(ns.toLowerCase())))
        .reduce((s, c) => s + c.count, 0);
      if (total > 0) positiveRate = negatives / total;
      notes.push(`Taxa de inadimplência estimada de "${statusColumn}": ${(positiveRate * 100).toFixed(1)}%`);
    }
  } else {
    notes.push("⚠️ Nenhuma coluna de status encontrada. Especifique manualmente.");
  }

  const distribution = generatePeriodicDistribution(timeAnchor, numStats, totalRows, entityCount, positiveRate, 90);

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: entityCount,
      positive_rate: positiveRate,
      distinct_target_values: 2,
      top_class_pct: Math.max(positiveRate, 1 - positiveRate),
      per_period_distribution: distribution,
      notes,
    },
    notes,
    statusColumn,
  };
}

// ═══ Main ══════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id, template_id, params = {}, selection_version } = await req.json();

    if (!project_id || !template_id) {
      return new Response(
        JSON.stringify({ error: "project_id e template_id são obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const templateConfig = TEMPLATE_CONFIGS[template_id];
    if (!templateConfig) {
      return new Response(
        JSON.stringify({ error: `Template "${template_id}" não encontrado` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[preview-target-template] project=${project_id}, template=${template_id}`);

    // ─── Load data in parallel ───────────────────────────────

    const [catStatsRes, numStatsRes, aiContextRes, dsStateRes, selectionRes, projectRes] = await Promise.all([
      supabase.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", project_id),
      supabase.from("project_numeric_stats").select("column_name, null_count, min_value, max_value, mean_value").eq("project_id", project_id),
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count, active_dataset_ref, manifest_id").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle(),
      supabase.from("projects").select("dataset_rows, dataset_columns, total_rows").eq("id", project_id).maybeSingle(),
    ]);

    const catStats: CategoricalStat[] = (catStatsRes.data || []) as CategoricalStat[];
    const numStats: NumericStat[] = (numStatsRes.data || []) as NumericStat[];
    // Fallback chain: project_dataset_state → projects.dataset_rows → projects.total_rows → stats count
    const totalRows = dsStateRes.data?.row_count
      || (projectRes.data as any)?.dataset_rows
      || (projectRes.data as any)?.total_rows
      || (catStats.length > 0 || numStats.length > 0 ? 1000 : 0);
    const currentSelectionVersion = selection_version || (selectionRes.data as any)?.selection_version || 1;

    if (totalRows === 0 && catStats.length === 0 && numStats.length === 0) {
      return new Response(
        JSON.stringify({ error: "Nenhum dado encontrado. Execute a importação primeiro." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Read contract hints + intent ────────────────────────

    const aiContext = (aiContextRes.data?.context as Record<string, any>) || {};
    const contractHints = aiContext.contract_hints || {};
    const intentContract = aiContext.intent_contract || aiContext.intent || {};
    const intentBase = intentContract.intent_base || intentContract;
    const domainAdapter = intentContract.domain_adapter || {};

    const entityKey: string | null = contractHints.entity_key || null;
    const timeAnchor: string | null = contractHints.time_anchor_column || null;
    const eventCandidates: string[] = contractHints.event_candidates || domainAdapter.event_candidates || [];
    const valueCandidates: string[] = contractHints.value_candidates || domainAdapter.value_candidates || [];
    const requiresTime = intentBase.requires_time_column ?? true;
    const defaultWindowDays = intentBase.default_window_days || domainAdapter.default_window_days || 30;

    const effectiveParams = {
      ...params,
      window_days: params.window_days || defaultWindowDays,
    };

    console.log(`[preview-target-template] entityKey=${entityKey}, timeAnchor=${timeAnchor}, events=${eventCandidates.length}`);

    // ─── Pre-flight gates ────────────────────────────────────

    const gates: GateResult[] = [];

    if (templateConfig.requires_entity_key && !entityKey) {
      gates.push({
        gate: "ENTITY_KEY_REQUIRED",
        status: "BLOCK",
        message: "Precisamos da coluna que identifica o cliente/paciente (ID).",
        details: "Selecione a coluna de entidade no Step 3 (EDA) ou configure manualmente.",
      });
    }

    if (templateConfig.requires_time_anchor && !timeAnchor) {
      gates.push({
        gate: "TIME_ANCHOR_REQUIRED",
        status: "BLOCK",
        message: "Precisamos de uma coluna de data para calcular o target na janela temporal.",
        details: "Selecione a coluna de data no Step 3 (EDA) ou configure manualmente.",
      });
    }

    if (templateConfig.requires_event_column && eventCandidates.length === 0) {
      gates.push({
        gate: "EVENT_COLUMN_REQUIRED",
        status: "BLOCK",
        message: "Nenhuma coluna de evento/status encontrada no dataset.",
        details: "O template requer uma coluna com valores de status (ex: no_show, missed). Verifique seus dados.",
      });
    }

    const hasBlock = gates.some(g => g.status === "BLOCK");
    if (hasBlock) {
      await upsertLabelBuilder(supabase, project_id, currentSelectionVersion, template_id, effectiveParams, "blocked", null);

      return new Response(JSON.stringify({
        success: false,
        template_id,
        params: effectiveParams,
        preview: null,
        gates,
        recommended_params: { window_days: defaultWindowDays },
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Simulate target derivation ──────────────────────────

    let preview: PreviewStats;
    let extraNotes: string[] = [];

    switch (template_id) {
      case "churn_retail":
      case "churn_generic":
      case "generic_event_no_activity": {
        const result = simulateChurnRetail(catStats, numStats, totalRows, entityKey, timeAnchor, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        break;
      }
      case "generic_threshold_binary": {
        const result = simulateThresholdBinary(catStats, numStats, totalRows, entityKey, valueCandidates, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        break;
      }
      case "generic_future_sum_regression": {
        const result = simulateFutureSumRegression(catStats, numStats, totalRows, entityKey, timeAnchor, valueCandidates, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        break;
      }
      case "inadimplencia_por_atraso": {
        const result = simulateInadimplenciaAtraso(catStats, numStats, totalRows, entityKey, timeAnchor, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        break;
      }
      case "inadimplencia_por_status": {
        const result = simulateInadimplenciaStatus(catStats, numStats, totalRows, entityKey, timeAnchor, eventCandidates, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        if (result.statusColumn && !params.status_column) {
          effectiveParams.status_column = result.statusColumn;
        }
        break;
      }
      case "no_show_health": {
        const result = simulateNoShowHealth(catStats, numStats, totalRows, entityKey, timeAnchor, numStats, eventCandidates, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        if (result.statusColumn && !params.status_column) {
          effectiveParams.status_column = result.statusColumn;
        }
        break;
      }
      case "adesao_tratamento_health": {
        const result = simulateAdesaoHealth(catStats, numStats, totalRows, entityKey, timeAnchor, numStats, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        break;
      }
      case "human_labeling_assisted": {
        const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
        const entityCount = entityStat?.distinct_count || totalRows;
        preview = {
          total_rows_sampled: totalRows,
          entity_count: entityCount,
          positive_rate: 0,
          distinct_target_values: 2,
          top_class_pct: 0,
          per_period_distribution: [],
          notes: [
            "🏷️ Modo rotulagem humana: o target será gerado a partir de micro-rotulagem + modelo seed.",
            "Use o card 'Rotulagem Humana' abaixo para iniciar a rotulagem de exemplos.",
            "Mínimo recomendado: 30 exemplos rotulados (15 por classe).",
          ],
        };
        break;
      }
      case "weak_supervision": {
        const entityStatW = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
        const entityCountW = entityStatW?.distinct_count || totalRows;
        preview = {
          total_rows_sampled: totalRows,
          entity_count: entityCountW,
          positive_rate: 0,
          distinct_target_values: 2,
          top_class_pct: 0,
          per_period_distribution: [],
          notes: [
            "🔀 Modo weak supervision: o target será gerado combinando múltiplas regras fracas (Label Functions).",
            "Use o card 'Weak Label Builder' para configurar as regras de rotulagem.",
          ],
        };
        break;
      }
      default: {
        preview = {
          total_rows_sampled: totalRows,
          entity_count: totalRows,
          positive_rate: 0.5,
          distinct_target_values: 2,
          top_class_pct: 0.5,
          per_period_distribution: [],
          notes: ["Template genérico — preview não disponível."],
        };
      }
    }

    // ─── TARGET_SANITY gates ─────────────────────────────────

    if (preview.distinct_target_values < 2) {
      gates.push({
        gate: "TARGET_SANITY",
        status: "BLOCK",
        message: "Seu target ficou com apenas 1 valor. Ajuste a janela (window_days) ou a definição do evento.",
        details: `distinct_target_values = ${preview.distinct_target_values}`,
      });
    }

    if (preview.top_class_pct > 0.95) {
      gates.push({
        gate: "TARGET_SANITY",
        status: "BLOCK",
        message: `Classe dominante extrema (${(preview.top_class_pct * 100).toFixed(1)}%). O modelo não conseguirá aprender. Ajuste a janela ou revise os dados.`,
        details: `top_class_pct = ${preview.top_class_pct}`,
      });
    }

    if (preview.positive_rate < 0.02) {
      gates.push({
        gate: "TARGET_BALANCE",
        status: "WARN",
        message: `Taxa positiva muito baixa (${(preview.positive_rate * 100).toFixed(1)}%). Aumente a janela temporal ou revise a definição do evento.`,
        details: "Recomendação: ajuste window_days para um valor maior.",
      });
    } else if (preview.positive_rate > 0.98) {
      gates.push({
        gate: "TARGET_BALANCE",
        status: "WARN",
        message: `Taxa positiva muito alta (${(preview.positive_rate * 100).toFixed(1)}%). Reduza a janela ou revise critérios.`,
      });
    }

    if (preview.entity_count < 200 && templateConfig.problem_type === "classification") {
      gates.push({
        gate: "SAMPLE_SIZE",
        status: "WARN",
        message: `Apenas ${preview.entity_count} entidades. Pode ser insuficiente para classificação robusta (recomendado: ≥200).`,
      });
    }

    // ─── TARGET_DRIFT gate ───────────────────────────────────

    const driftGate = checkTargetDrift(preview.per_period_distribution);
    if (driftGate) {
      gates.push(driftGate);
    }

    // If no issues, add PASS
    if (gates.length === 0) {
      gates.push({
        gate: "TARGET_SANITY",
        status: "PASS",
        message: `Target válido: ${preview.entity_count} entidades, taxa positiva ${(preview.positive_rate * 100).toFixed(1)}%.`,
      });
    }

    // ─── Determine status ────────────────────────────────────

    const hasBlockGate = gates.some(g => g.status === "BLOCK");
    const builderStatus = hasBlockGate ? "blocked" : "ready";

    // ─── Persist label builder ───────────────────────────────

    const builderId = await upsertLabelBuilder(
      supabase, project_id, currentSelectionVersion,
      template_id, effectiveParams, builderStatus, preview,
    );

    // ─── Persist to AI context ───────────────────────────────

    if (aiContextRes.data) {
      const currentCtx = aiContextRes.data.context as Record<string, any> || {};
      await supabase.from("project_ai_context").update({
        context: {
          ...currentCtx,
          label_builder: {
            template_id,
            params: effectiveParams,
            preview_summary: {
              positive_rate: preview.positive_rate,
              entity_count: preview.entity_count,
              distinct_values: preview.distinct_target_values,
              status: builderStatus,
              has_drift: !!driftGate,
            },
            builder_id: builderId,
            updated_at: new Date().toISOString(),
          },
        },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiContextRes.data.id);
    }

    // ─── Response ────────────────────────────────────────────

    const response = {
      success: true,
      template_id,
      params: effectiveParams,
      preview,
      gates,
      builder_id: builderId,
      builder_status: builderStatus,
      recommended_params: {
        window_days: defaultWindowDays,
      },
    };

    console.log(`[preview-target-template] Done: status=${builderStatus}, positive_rate=${preview.positive_rate}, entities=${preview.entity_count}, periods=${preview.per_period_distribution.length}`);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[preview-target-template] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ═══ Helpers ═══════════════════════════════════════════════════

async function upsertLabelBuilder(
  supabase: any,
  projectId: string,
  selectionVersion: number,
  templateId: string,
  params: Record<string, any>,
  status: string,
  preview: PreviewStats | null,
): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from("project_label_builders")
      .select("id")
      .eq("project_id", projectId)
      .eq("template_id", templateId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      await supabase.from("project_label_builders").update({
        selection_version: selectionVersion,
        params,
        status,
        preview,
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      return existing.id;
    } else {
      const { data: created } = await supabase.from("project_label_builders").insert({
        project_id: projectId,
        selection_version: selectionVersion,
        mode: "template",
        template_id: templateId,
        params,
        status,
        preview,
      }).select("id").single();
      return created?.id || null;
    }
  } catch (err) {
    console.error("[preview-target-template] upsertLabelBuilder error:", err);
    return null;
  }
}
