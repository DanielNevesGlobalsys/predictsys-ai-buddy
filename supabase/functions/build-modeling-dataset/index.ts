import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ==================== TYPES ====================

interface LabelPlan {
  strategy: string;
  source_columns: string[];
  window_days: number | null;
  condition: string;
  output_column: string;
  output_type: "binary" | "multiclass" | "regression";
}

interface IntentContract {
  objective?: string;
  problem_type?: string;
  industry_hint?: string;
  target_behavior?: string;
  guardrails?: Record<string, any>;
  time_horizon_days?: number;
  recommended_metrics?: string[];
}

interface EnrichedColumn {
  name: string;
  type: string;
  distinct_count?: number;
  null_pct?: number;
  mean?: number;
  std?: number;
  null_count?: number;
}

interface GeneratedFeature {
  name: string;
  type: string; // count, recency, frequency, aggregation, one_hot, frequency_encoding, temporal, missing_flag
  source_columns: string[];
  description: string;
}

interface RemovedFeature {
  col: string;
  reason: string;
}

interface FeatureReport {
  features_final: string[];
  features_generated: GeneratedFeature[];
  features_removed: RemovedFeature[];
  features_blocked: { name: string; reason: string }[];
  temporal_features_created: string[];
  aggregation_features_created: string[];
  missing_flags_created: string[];
  imputation_applied: { numeric: string; categorical: string };
  overfit_risk_score: number;
  overfit_warning: string | null;
  leakage_detected: boolean;
  leakage_columns: { column: string; reason: string }[];
}

// ==================== COLUMN ANALYSIS HELPERS ====================

function normalizeColName(name: string): string {
  return name.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]/g, "_");
}

const ID_PATTERNS = /^(id|_id|codigo|cod_|numero|num_|chave|key|uuid|pk|fk|idx|index)/i;
const ID_SUFFIX = /(_id|_key|_code|_cod|_numero|_num|_uuid)$/i;
const TIME_PATTERNS = /^(data|dt_|date|timestamp|created|updated|dataneg|data_neg|dt$|_date$|_dt$|_data$)/i;
const EVENT_PATTERNS = /^(status|situacao|ativo|inativo|cancelado|churn|inadimplente|convertido|comprou|pagou|evento|flag_|ind_)/i;

function isIdColumn(name: string, uniqueRatio: number): boolean {
  const norm = normalizeColName(name);
  return (ID_PATTERNS.test(norm) || ID_SUFFIX.test(norm)) && uniqueRatio > 0.5;
}

function isTimeColumn(name: string): boolean {
  return TIME_PATTERNS.test(normalizeColName(name));
}

function isEventColumn(name: string): boolean {
  return EVENT_PATTERNS.test(normalizeColName(name));
}

function isNumericType(type: string): boolean {
  return /^(num|numeric|number|inteiro|integer|float|double|decimal)/i.test(type);
}

function isTextType(type: string): boolean {
  return /^(text|texto|categ|string|varchar)/i.test(type);
}

// ==================== INTENT-BASED LABEL DETECTION ====================

function detectLabelStrategy(
  intent: IntentContract,
  columns: EnrichedColumn[],
  timeCols: string[],
  eventCols: string[],
): { plan: LabelPlan | null; blockedReasons: string[] } {
  const objective = (intent.objective || "").toLowerCase();
  const blockedReasons: string[] = [];

  // 1. Direct target: event column matching intent
  for (const ec of eventCols) {
    const col = columns.find(c => c.name === ec);
    if (!col) continue;
    const dc = col.distinct_count || 0;
    if (dc >= 2 && dc <= 20) {
      return {
        plan: {
          strategy: "direct",
          source_columns: [ec],
          window_days: null,
          condition: `Usar coluna "${ec}" diretamente como target (${dc} classes)`,
          output_column: ec,
          output_type: dc === 2 ? "binary" : "multiclass",
        },
        blockedReasons: [],
      };
    }
  }

  // 2. Churn/inadimplência/conversão need time window
  const needsTimeWindow = /churn|inadimpl|convers|atrit|evas|cancel|retenc|reten/.test(objective);
  if (needsTimeWindow) {
    if (timeCols.length === 0) {
      blockedReasons.push("Objetivo requer janela temporal, mas nenhuma coluna de data foi detectada. Adicione uma coluna de data ao dataset.");
      return { plan: null, blockedReasons };
    }
    const anchorTime = timeCols[0];
    const windowDays = intent.time_horizon_days || (/inadimpl/.test(objective) ? 30 : /churn|atrit|evas|cancel/.test(objective) ? 90 : 30);

    if (eventCols.length > 0) {
      return {
        plan: {
          strategy: "event_window",
          source_columns: [anchorTime, eventCols[0]],
          window_days: windowDays,
          condition: `Evento "${eventCols[0]}" ocorreu dentro de ${windowDays} dias após "${anchorTime}"`,
          output_column: `label_${normalizeColName(objective.split(" ")[0] || "target")}_${windowDays}d`,
          output_type: "binary",
        },
        blockedReasons: [],
      };
    }

    return {
      plan: {
        strategy: "state_change",
        source_columns: [anchorTime],
        window_days: windowDays,
        condition: `Sem atividade nos últimos ${windowDays} dias (baseado em "${anchorTime}")`,
        output_column: `label_inativo_${windowDays}d`,
        output_type: "binary",
      },
      blockedReasons: [],
    };
  }

  // 3. Regression
  if (intent.problem_type === "regression") {
    const numericCols = columns.filter(c =>
      isNumericType(c.type) && !isIdColumn(c.name, (c.distinct_count || 0) / 100) && !isTimeColumn(c.name)
    );
    if (numericCols.length > 0) {
      const best = numericCols.sort((a, b) => (b.distinct_count || 0) - (a.distinct_count || 0))[0];
      return {
        plan: {
          strategy: "direct",
          source_columns: [best.name],
          window_days: null,
          condition: `Usar coluna numérica "${best.name}" como target de regressão`,
          output_column: best.name,
          output_type: "regression",
        },
        blockedReasons: [],
      };
    }
  }

  if (columns.length > 0) {
    blockedReasons.push("Não foi possível gerar automaticamente um target/label. Selecione manualmente a coluna alvo na interface.");
  }
  return { plan: null, blockedReasons };
}

// ==================== ENTITY KEY DETECTION ====================

function detectEntityKey(columns: EnrichedColumn[], totalRows: number): string | null {
  const entityPatterns = /^(cliente|cnpj|cpf|codparc|cod_parc|entity|customer|client|account|empresa|company|numerounico|numero_unico|id_cliente|customer_id|client_id|account_id|user_id|usuario)/i;
  for (const col of columns) {
    if (entityPatterns.test(normalizeColName(col.name))) {
      const uniqueRatio = totalRows > 0 ? (col.distinct_count || 0) / totalRows : 0;
      if (uniqueRatio >= 0.05 && uniqueRatio <= 0.95) return col.name;
    }
  }
  return null;
}

// ==================== FEATURE BUILDER V2 ====================

function buildFeatureReport(
  columns: EnrichedColumn[],
  targetCol: string,
  entityKey: string | null,
  anchorTimeCol: string | null,
  leakageCols: string[],
  totalRows: number,
  intent: IntentContract,
): FeatureReport {
  const features_final: string[] = [];
  const features_generated: GeneratedFeature[] = [];
  const features_removed: RemovedFeature[] = [];
  const features_blocked: { name: string; reason: string }[] = [];
  const leakage_report: { column: string; reason: string }[] = [];
  const temporal_features_created: string[] = [];
  const aggregation_features_created: string[] = [];
  const missing_flags_created: string[] = [];

  const blockedSet = new Set<string>();

  // ── 2.1 Hard-Block Removals ──
  for (const col of columns) {
    if (col.name === targetCol) continue;

    const uniqueRatio = totalRows > 0 ? (col.distinct_count || 0) / totalRows : 0;

    // ID_TECNICO
    if (isIdColumn(col.name, uniqueRatio > 0.5 ? uniqueRatio : 0)) {
      features_removed.push({ col: col.name, reason: "ID_TECNICO: Identificador técnico removido automaticamente" });
      blockedSet.add(col.name);
      continue;
    }

    // Variância zero (std ≈ 0 for numerics)
    if (isNumericType(col.type) && col.std !== undefined && col.std < 1e-10) {
      features_removed.push({ col: col.name, reason: "VARIANCIA_ZERO: Coluna sem variabilidade" });
      blockedSet.add(col.name);
      continue;
    }

    // unique_ratio > 0.95 (near-unique text columns)
    if (isTextType(col.type) && uniqueRatio > 0.95) {
      features_removed.push({ col: col.name, reason: `UNIQUE_RATIO_ALTO: ${Math.round(uniqueRatio * 100)}% valores únicos` });
      blockedSet.add(col.name);
      continue;
    }

    // Leakage from contract
    if (leakageCols.includes(col.name)) {
      features_removed.push({ col: col.name, reason: "DERIVADA_LEAKAGE: Marcada como leakage pelo contrato" });
      leakage_report.push({ column: col.name, reason: "Marcada como leakage pelo contrato de modelagem" });
      blockedSet.add(col.name);
      continue;
    }

    // High-cardinality text (> 100 unique values, not encodable)
    if (isTextType(col.type) && (col.distinct_count || 0) > 100) {
      features_blocked.push({ name: col.name, reason: `Texto com alta cardinalidade (${col.distinct_count} valores únicos)` });
      blockedSet.add(col.name);
      continue;
    }

    // ── 2.2 Temporal leakage: post-event columns ──
    if (anchorTimeCol && isTimeColumn(col.name) && col.name !== anchorTimeCol) {
      // Heuristic: columns with "updated", "modified", "resultado", "saida" patterns likely post-event
      const postEventPatterns = /^(updated|modified|resultado|saida|output|resposta|dt_saida|dt_resultado|data_fim|end_date|finished|completed|closed)/i;
      if (postEventPatterns.test(normalizeColName(col.name))) {
        features_removed.push({ col: col.name, reason: "LEAKAGE_TEMPORAL: Coluna temporal pós-evento detectada" });
        leakage_report.push({ column: col.name, reason: "Timestamp posterior a anchor_time (pós-evento)" });
        blockedSet.add(col.name);
        continue;
      }
    }

    features_final.push(col.name);
  }

  // ── 3.1 Temporal Features ──
  if (anchorTimeCol) {
    const temporalFeatures: GeneratedFeature[] = [
      { name: "feat_mes", type: "temporal", source_columns: [anchorTimeCol], description: "Mês extraído de " + anchorTimeCol },
      { name: "feat_dia_semana", type: "temporal", source_columns: [anchorTimeCol], description: "Dia da semana de " + anchorTimeCol },
      { name: "feat_trimestre", type: "temporal", source_columns: [anchorTimeCol], description: "Trimestre de " + anchorTimeCol },
      { name: "feat_fim_de_mes", type: "temporal", source_columns: [anchorTimeCol], description: "Indicador fim-de-mês (dia >= 25)" },
    ];

    // Look for creation date to compute age
    const creationCols = columns.filter(c => /^(created|data_cri|dt_cri|data_cadastro|data_registro)/i.test(normalizeColName(c.name)));
    if (creationCols.length > 0) {
      temporalFeatures.push({
        name: `feat_idade_registro_dias`,
        type: "temporal",
        source_columns: [anchorTimeCol, creationCols[0].name],
        description: `Dias entre ${creationCols[0].name} e ${anchorTimeCol}`,
      });
    }

    // Recency features if entity key exists
    if (entityKey) {
      temporalFeatures.push(
        { name: `feat_recency_days_${normalizeColName(anchorTimeCol)}`, type: "recency", source_columns: [anchorTimeCol, entityKey], description: `Dias desde último registro por ${entityKey}` },
        { name: `feat_frequency_30d`, type: "frequency", source_columns: [anchorTimeCol, entityKey], description: `Frequência de eventos nos últimos 30 dias por ${entityKey}` },
      );

      // Rolling aggregations (count, sum, avg over 30d window)
      const windowDays = intent.time_horizon_days || 30;
      temporalFeatures.push(
        { name: `feat_rolling_count_${windowDays}d`, type: "temporal", source_columns: [anchorTimeCol, entityKey], description: `Contagem rolling ${windowDays}d por ${entityKey}` },
      );

      // Rolling aggregations on numerics
      const numericForRolling = columns.filter(c =>
        isNumericType(c.type) && c.name !== targetCol && !blockedSet.has(c.name) && !isIdColumn(c.name, 0)
      ).slice(0, 3);
      for (const nc of numericForRolling) {
        temporalFeatures.push(
          { name: `feat_rolling_avg_${normalizeColName(nc.name)}_${windowDays}d`, type: "temporal", source_columns: [nc.name, anchorTimeCol, entityKey], description: `Média rolling ${windowDays}d de ${nc.name} por ${entityKey}` },
          { name: `feat_rolling_sum_${normalizeColName(nc.name)}_${windowDays}d`, type: "temporal", source_columns: [nc.name, anchorTimeCol, entityKey], description: `Soma rolling ${windowDays}d de ${nc.name} por ${entityKey}` },
        );
      }
    }

    for (const f of temporalFeatures) {
      features_generated.push(f);
      temporal_features_created.push(f.name);
    }
  }

  // ── 3.2 Entity Aggregations ──
  if (entityKey) {
    const aggFeatures: GeneratedFeature[] = [];

    aggFeatures.push({
      name: `feat_count_by_${normalizeColName(entityKey)}`,
      type: "count",
      source_columns: [entityKey],
      description: `Contagem de registros por ${entityKey}`,
    });

    const numericCols = columns.filter(c =>
      isNumericType(c.type) && c.name !== targetCol && !blockedSet.has(c.name) && !isIdColumn(c.name, 0)
    ).slice(0, 5);

    for (const nc of numericCols) {
      for (const agg of ["mean", "sum", "max", "min", "std"] as const) {
        aggFeatures.push({
          name: `feat_${agg}_${normalizeColName(nc.name)}_by_${normalizeColName(entityKey)}`,
          type: "aggregation",
          source_columns: [nc.name, entityKey],
          description: `${agg} de ${nc.name} por ${entityKey}`,
        });
      }
    }

    for (const f of aggFeatures) {
      features_generated.push(f);
      aggregation_features_created.push(f.name);
    }
  }

  // ── 3.3 Missing handling ──
  // Create is_missing flags for columns with significant nulls
  for (const col of columns) {
    if (col.name === targetCol || blockedSet.has(col.name)) continue;
    const nullPct = col.null_pct || 0;
    if (nullPct >= 5 && nullPct < 95) {
      const flagName = `feat_${normalizeColName(col.name)}_is_missing`;
      features_generated.push({
        name: flagName,
        type: "missing_flag",
        source_columns: [col.name],
        description: `Flag de missing para ${col.name} (${nullPct}% nulos)`,
      });
      missing_flags_created.push(flagName);
    }
  }

  // ── 3.4 Encoding ──
  const catCols = columns.filter(c =>
    isTextType(c.type) && c.name !== targetCol && !blockedSet.has(c.name) && (c.distinct_count || 0) > 1
  );

  for (const cc of catCols) {
    const dc = cc.distinct_count || 0;
    if (dc <= 10) {
      // Low cardinality → one-hot
      features_generated.push({
        name: `feat_onehot_${normalizeColName(cc.name)}`,
        type: "one_hot",
        source_columns: [cc.name],
        description: `One-hot encoding de ${cc.name} (${dc} categorias)`,
      });
    } else if (dc <= 50) {
      // Medium cardinality → frequency encoding
      features_generated.push({
        name: `feat_freq_${normalizeColName(cc.name)}`,
        type: "frequency_encoding",
        source_columns: [cc.name],
        description: `Frequency encoding de ${cc.name} (${dc} categorias → top 50 + other)`,
      });
    }
    // >50 already blocked above (>100) or let pass as medium (50-100)
    if (dc > 50 && dc <= 100) {
      features_generated.push({
        name: `feat_freq_${normalizeColName(cc.name)}`,
        type: "frequency_encoding",
        source_columns: [cc.name],
        description: `Frequency encoding de ${cc.name} (${dc} categorias, top 50 + other)`,
      });
    }
  }

  // ── 4. Overfit Risk ──
  const totalFeatures = features_final.length + features_generated.length;
  const featureToRowRatio = totalRows > 0 ? totalFeatures / totalRows : 0;
  let overfit_risk_score = 0;
  let overfit_warning: string | null = null;

  if (totalFeatures > 500) {
    overfit_risk_score = 0.9;
    overfit_warning = `WARNING_OVERFEATURE: ${totalFeatures} features é excessivo. Considere reduzir features ou aumentar dados.`;
  } else if (totalFeatures > totalRows / 5) {
    overfit_risk_score = 0.7;
    overfit_warning = `WARNING_OVERFEATURE: Razão features/linhas alta (${totalFeatures}/${totalRows}). Risco de overfitting.`;
  } else if (featureToRowRatio > 0.1) {
    overfit_risk_score = 0.4;
    overfit_warning = `Razão features/linhas moderada (${Math.round(featureToRowRatio * 100)}%). Monitorar overfitting.`;
  }

  return {
    features_final,
    features_generated,
    features_removed,
    features_blocked,
    temporal_features_created,
    aggregation_features_created,
    missing_flags_created,
    imputation_applied: { numeric: "median", categorical: "missing (top 50 + other)" },
    overfit_risk_score,
    overfit_warning,
    leakage_detected: leakage_report.length > 0,
    leakage_columns: leakage_report,
  };
}

// ==================== MAIN HANDLER ====================

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: project, error: projErr } = await supabase
      .from("projects").select("id, organization_id, user_id").eq("id", project_id).single();
    if (projErr || !project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[build-modeling-dataset] Starting for project ${project_id}`);

    // Fetch all context in parallel
    const [aiCtxRes, manifestRes, columnsRes, catStatsRes, numStatsRes, settingsRes, inferenceRes, contractRes] = await Promise.all([
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("import_manifests").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id).order("column_index"),
      supabase.from("project_categorical_stats").select("column_name, distinct_count").eq("project_id", project_id),
      supabase.from("project_numeric_stats").select("column_name, null_count, mean_value, std_value").eq("project_id", project_id),
      supabase.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_problem_inference").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const manifest = manifestRes.data;
    const projectColumns = columnsRes.data || [];
    const catStats = catStatsRes.data || [];
    const numStats = numStatsRes.data || [];
    const settings = settingsRes.data;
    const inference = inferenceRes.data;
    const existingContract = contractRes.data;

    if (!manifest) {
      return new Response(JSON.stringify({
        status: "BLOCKED_FEATURE_BUILDER",
        blocked_reasons: ["Nenhum manifesto de importação encontrado. Faça o upload dos dados primeiro."],
        modeling_dataset_ready: false,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (manifest.rows_consolidated === 0) {
      return new Response(JSON.stringify({
        status: "BLOCKED_FEATURE_BUILDER",
        blocked_reasons: ["Nenhuma linha consolidada no dataset. Reimporte os dados."],
        modeling_dataset_ready: false,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Build enriched column list
    const catMap = new Map(catStats.map((c: any) => [c.column_name, c.distinct_count as number]));
    const numMap = new Map(numStats.map((n: any) => [n.column_name, { null_count: n.null_count, mean: n.mean_value, std: n.std_value }]));
    const totalRows = manifest.rows_consolidated;

    const enrichedColumns: EnrichedColumn[] = projectColumns.map((col: any) => {
      const numInfo = numMap.get(col.column_name);
      return {
        name: col.column_name,
        type: col.inferred_type,
        distinct_count: catMap.get(col.column_name) || undefined,
        null_pct: numInfo?.null_count ? Math.round((numInfo.null_count / totalRows) * 100) : undefined,
        mean: numInfo?.mean ?? undefined,
        std: numInfo?.std ?? undefined,
        null_count: numInfo?.null_count ?? undefined,
      };
    });

    const timeCols = enrichedColumns.filter(c => isTimeColumn(c.name)).map(c => c.name);
    const eventCols = enrichedColumns.filter(c => isEventColumn(c.name)).map(c => c.name);

    const intent: IntentContract = {
      objective: aiCtx?.intent?.objective || inference?.problem_type || "",
      problem_type: settings?.problem_type || inference?.problem_type || "classification",
      industry_hint: aiCtx?.intent?.industry_hint || "",
      target_behavior: aiCtx?.intent?.target_behavior || "",
      time_horizon_days: aiCtx?.intent?.time_horizon_days || 30,
      recommended_metrics: aiCtx?.intent?.recommended_metrics || [],
    };

    console.log(`[build-modeling-dataset] Intent: ${JSON.stringify(intent)}`);

    // ==================== DETERMINE TARGET ====================
    let targetColumn = settings?.target_column || null;
    let targetType: "binary" | "multiclass" | "regression" = "binary";
    let targetSource: "direct" | "label_builder" = "direct";
    let labelPlan: LabelPlan | null = null;
    let windowDays: number | null = null;
    const allBlockedReasons: string[] = [];

    if (targetColumn) {
      const col = enrichedColumns.find(c => c.name === targetColumn);
      if (!col) {
        allBlockedReasons.push(`Coluna target "${targetColumn}" não encontrada no dataset.`);
        targetColumn = null;
      } else if (isTextType(col.type) && (col.distinct_count || 0) > 50) {
        allBlockedReasons.push(`Target "${targetColumn}" é texto com alta cardinalidade (${col.distinct_count} valores). Selecione outra coluna.`);
        targetColumn = null;
      } else {
        if (isNumericType(col.type)) {
          if ((col.distinct_count || 0) <= 10) {
            targetType = (col.distinct_count || 0) === 2 ? "binary" : "multiclass";
          } else {
            targetType = intent.problem_type === "regression" ? "regression" : "binary";
          }
        } else {
          targetType = (col.distinct_count || 0) === 2 ? "binary" : "multiclass";
        }
      }
    }

    if (!targetColumn) {
      const { plan, blockedReasons } = detectLabelStrategy(intent, enrichedColumns, timeCols, eventCols);
      if (plan) {
        labelPlan = plan;
        targetColumn = plan.output_column;
        targetType = plan.output_type;
        targetSource = plan.strategy === "direct" ? "direct" : "label_builder";
        windowDays = plan.window_days;
      }
      allBlockedReasons.push(...blockedReasons);
    }

    // ── 6. GATING: BLOCKED if no target ──
    if (!targetColumn) {
      if (allBlockedReasons.length === 0) {
        allBlockedReasons.push("Nenhum target/label pôde ser identificado automaticamente. Selecione manualmente.");
      }

      await supabase.from("project_modeling_datasets").delete().eq("project_id", project_id);
      await supabase.from("project_modeling_datasets").insert({
        project_id,
        organization_id: project.organization_id,
        target_column: "__none__",
        target_type: "binary",
        target_source: "direct",
        status: "blocked",
        blocked_reasons: allBlockedReasons,
        build_log: { intent, timeCols, eventCols, enrichedColumnsCount: enrichedColumns.length },
      });

      return new Response(JSON.stringify({
        status: "BLOCKED_FEATURE_BUILDER",
        blocked_reasons: allBlockedReasons,
        modeling_dataset_ready: false,
        suggestions: {
          needs_time_col: timeCols.length === 0 && /churn|inadimpl|convers/.test(intent.objective || ""),
          needs_event_col: eventCols.length === 0,
          available_columns: enrichedColumns.slice(0, 20).map(c => ({ name: c.name, type: c.type, distinct: c.distinct_count })),
        },
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ==================== ENTITY KEY & ANCHOR TIME ====================
    const entityKey = existingContract?.entity_key
      ? (typeof existingContract.entity_key === "string" ? existingContract.entity_key : (existingContract.entity_key as any)?.column || detectEntityKey(enrichedColumns, totalRows))
      : detectEntityKey(enrichedColumns, totalRows);
    const anchorTimeCol = existingContract?.anchor_time_col || (timeCols.length > 0 ? timeCols[0] : null);

    console.log(`[build-modeling-dataset] Entity: ${entityKey}, Anchor: ${anchorTimeCol}`);

    // ==================== LEAKAGE COLS FROM CONTRACT ====================
    const leakageCols: string[] = [];
    if (existingContract?.leakage_flags && Array.isArray(existingContract.leakage_flags)) {
      for (const lf of existingContract.leakage_flags as any[]) {
        if (typeof lf === "string") leakageCols.push(lf);
        else if (lf?.column) leakageCols.push(lf.column);
      }
    }

    // ==================== BUILD FEATURE REPORT ====================
    const report = buildFeatureReport(enrichedColumns, targetColumn, entityKey, anchorTimeCol, leakageCols, totalRows, intent);

    console.log(`[build-modeling-dataset] Features: ${report.features_final.length} direct, ${report.features_generated.length} generated, ${report.features_removed.length} removed, ${report.features_blocked.length} blocked`);

    // ── 6. GATING: structural leakage or empty features ──
    if (report.leakage_detected && report.leakage_columns.length > totalRows * 0.01) {
      // Only block for massive leakage
    }

    if (report.features_final.length === 0 && report.features_generated.length === 0) {
      allBlockedReasons.push("Nenhuma feature válida após remoções. Dataset sem variabilidade suficiente.");
    }

    if (report.features_final.length < 2 && report.features_generated.length === 0) {
      allBlockedReasons.push("Menos de 2 features válidas disponíveis. Adicione mais colunas ao dataset.");
    }

    // ==================== SPLIT STRATEGY ====================
    let splitStrategy = existingContract?.split_strategy || "stratified";
    if (!existingContract?.split_strategy) {
      if (anchorTimeCol) splitStrategy = "temporal";
      else if (entityKey) splitStrategy = "group";
    }

    // ==================== STATUS ====================
    const totalFeaturesFinal = report.features_final.length + report.features_generated.length;
    const coveragePct = enrichedColumns.length > 0 ? Math.round((report.features_final.length / enrichedColumns.length) * 100) : 0;

    let status: string;
    if (allBlockedReasons.length > 0) {
      status = "blocked";
    } else if (report.overfit_warning) {
      status = "warning";
    } else {
      status = "ready";
    }

    const modelingDatasetReady = status === "ready" || status === "warning";

    // ==================== PERSIST ====================
    await supabase.from("project_modeling_datasets").delete().eq("project_id", project_id);

    const { data: saved, error: saveErr } = await supabase
      .from("project_modeling_datasets")
      .insert({
        project_id,
        organization_id: project.organization_id,
        dataset_id: manifest.dataset_id,
        intent_version: aiCtx?.intent?.version || "v1",
        manifest_version: manifest.id,
        entity_key: entityKey,
        anchor_time_col: anchorTimeCol,
        target_column: targetColumn,
        target_type: targetType,
        target_source: targetSource,
        label_plan: labelPlan || {},
        window_days: windowDays,
        features_final: report.features_final,
        features_generated: report.features_generated,
        features_blocked: report.features_blocked,
        row_count: totalRows,
        column_count: totalFeaturesFinal + 1,
        coverage_pct: coveragePct,
        leakage_report: report.leakage_columns,
        split_strategy: splitStrategy,
        status,
        blocked_reasons: allBlockedReasons,
        build_log: {
          intent,
          timeCols,
          eventCols,
          entityKey,
          anchorTimeCol,
          targetColumn,
          targetType,
          targetSource,
          labelPlan,
          splitStrategy,
          feature_report: {
            features_removed: report.features_removed,
            temporal_features_created: report.temporal_features_created,
            aggregation_features_created: report.aggregation_features_created,
            missing_flags_created: report.missing_flags_created,
            imputation_applied: report.imputation_applied,
            overfit_risk_score: report.overfit_risk_score,
            overfit_warning: report.overfit_warning,
          },
          timestamp: new Date().toISOString(),
        },
      })
      .select()
      .single();

    if (saveErr) {
      console.error("[build-modeling-dataset] Save error:", saveErr);
      return new Response(JSON.stringify({ error: "Erro ao salvar dataset modelável", details: saveErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[build-modeling-dataset] Complete. Status: ${status}, modeling_dataset_ready: ${modelingDatasetReady}`);

    return new Response(JSON.stringify({
      status: status.toUpperCase(),
      modeling_dataset_id: saved.id,
      modeling_dataset_ready: modelingDatasetReady,
      target: {
        column: targetColumn,
        type: targetType,
        source: targetSource,
        label_plan: labelPlan,
        window_days: windowDays,
      },
      entity_key: entityKey,
      anchor_time_col: anchorTimeCol,
      split_strategy: splitStrategy,
      features: {
        final_count: report.features_final.length,
        generated_count: report.features_generated.length,
        blocked_count: report.features_blocked.length,
        removed_count: report.features_removed.length,
        final: report.features_final,
        generated: report.features_generated,
        blocked: report.features_blocked,
        removed: report.features_removed,
      },
      feature_report: {
        temporal_features_created: report.temporal_features_created,
        aggregation_features_created: report.aggregation_features_created,
        missing_flags_created: report.missing_flags_created,
        imputation_applied: report.imputation_applied,
        overfit_risk_score: report.overfit_risk_score,
        overfit_warning: report.overfit_warning,
      },
      leakage_check: {
        leakage_detected: report.leakage_detected,
        leakage_columns: report.leakage_columns,
      },
      dataset_stats: {
        total_linhas: totalRows,
        total_features_final: totalFeaturesFinal,
        features_geradas_auto: report.features_generated.length,
        features_removidas: report.features_removed.length,
        flags_missing_criadas: report.missing_flags_created.length,
        features_temporais_criadas: report.temporal_features_created.length,
        agregacoes_criadas: report.aggregation_features_created.length,
        column_count: totalFeaturesFinal + 1,
        coverage_pct: coveragePct,
      },
      blocked_reasons: allBlockedReasons,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[build-modeling-dataset] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
      modeling_dataset_ready: false,
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
