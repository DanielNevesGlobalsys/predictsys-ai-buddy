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
  type: string;
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

interface TrainingGateReport {
  can_train: boolean;
  status: "READY" | "WARNING" | "BLOCKED";
  blocked_reason_code: string | null;
  label_report: {
    target_col: string;
    problem_type: string;
    n_rows: number;
    n_classes: number | null;
    positive_rate: number | null;
    dominant_class_rate: number | null;
    unique_ratio: number | null;
    warnings: string[];
  };
  leakage_report: {
    leakage_detected: boolean;
    leakage_columns: { column: string; reason: string }[];
    notes: string[];
  };
  split_plan: {
    strategy: string;
    anchor_time_col: string | null;
    train_frac: number;
    val_frac: number;
    test_frac: number;
  };
  sanity_report: {
    min_rows_ok: boolean;
    min_features_ok: boolean;
    missing_global_pct: number;
    overfit_risk_score: number;
    warnings: string[];
  };
  dashboard_allowed_precheck: boolean;
  next_action: string;
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

    if (isIdColumn(col.name, uniqueRatio > 0.5 ? uniqueRatio : 0)) {
      features_removed.push({ col: col.name, reason: "ID_TECNICO: Identificador técnico removido automaticamente" });
      blockedSet.add(col.name);
      continue;
    }

    if (isNumericType(col.type) && col.std !== undefined && col.std < 1e-10) {
      features_removed.push({ col: col.name, reason: "VARIANCIA_ZERO: Coluna sem variabilidade" });
      blockedSet.add(col.name);
      continue;
    }

    if (isTextType(col.type) && uniqueRatio > 0.95) {
      features_removed.push({ col: col.name, reason: `UNIQUE_RATIO_ALTO: ${Math.round(uniqueRatio * 100)}% valores únicos` });
      blockedSet.add(col.name);
      continue;
    }

    if (leakageCols.includes(col.name)) {
      features_removed.push({ col: col.name, reason: "DERIVADA_LEAKAGE: Marcada como leakage pelo contrato" });
      leakage_report.push({ column: col.name, reason: "Marcada como leakage pelo contrato de modelagem" });
      blockedSet.add(col.name);
      continue;
    }

    if (isTextType(col.type) && (col.distinct_count || 0) > 100) {
      features_blocked.push({ name: col.name, reason: `Texto com alta cardinalidade (${col.distinct_count} valores únicos)` });
      blockedSet.add(col.name);
      continue;
    }

    // ── 2.2 Temporal leakage: post-event columns ──
    if (anchorTimeCol && isTimeColumn(col.name) && col.name !== anchorTimeCol) {
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

    const creationCols = columns.filter(c => /^(created|data_cri|dt_cri|data_cadastro|data_registro)/i.test(normalizeColName(c.name)));
    if (creationCols.length > 0) {
      temporalFeatures.push({
        name: `feat_idade_registro_dias`,
        type: "temporal",
        source_columns: [anchorTimeCol, creationCols[0].name],
        description: `Dias entre ${creationCols[0].name} e ${anchorTimeCol}`,
      });
    }

    if (entityKey) {
      temporalFeatures.push(
        { name: `feat_recency_days_${normalizeColName(anchorTimeCol)}`, type: "recency", source_columns: [anchorTimeCol, entityKey], description: `Dias desde último registro por ${entityKey}` },
        { name: `feat_frequency_30d`, type: "frequency", source_columns: [anchorTimeCol, entityKey], description: `Frequência de eventos nos últimos 30 dias por ${entityKey}` },
      );

      const windowDays = intent.time_horizon_days || 30;
      temporalFeatures.push(
        { name: `feat_rolling_count_${windowDays}d`, type: "temporal", source_columns: [anchorTimeCol, entityKey], description: `Contagem rolling ${windowDays}d por ${entityKey}` },
      );

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
      features_generated.push({
        name: `feat_onehot_${normalizeColName(cc.name)}`,
        type: "one_hot",
        source_columns: [cc.name],
        description: `One-hot encoding de ${cc.name} (${dc} categorias)`,
      });
    } else if (dc <= 50) {
      features_generated.push({
        name: `feat_freq_${normalizeColName(cc.name)}`,
        type: "frequency_encoding",
        source_columns: [cc.name],
        description: `Frequency encoding de ${cc.name} (${dc} categorias → top 50 + other)`,
      });
    }
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

// ==================== TRAINING GATE (4.3) ====================

function runTrainingGate(
  targetCol: string,
  targetType: "binary" | "multiclass" | "regression",
  enrichedColumns: EnrichedColumn[],
  report: FeatureReport,
  totalRows: number,
  anchorTimeCol: string | null,
  splitStrategy: string,
  intent: IntentContract,
): TrainingGateReport {
  const labelWarnings: string[] = [];
  const leakageNotes: string[] = [];
  const sanityWarnings: string[] = [];
  let blocked_reason_code: string | null = null;
  let can_train = true;

  const targetColData = enrichedColumns.find(c => c.name === targetCol);
  const problemType = intent.problem_type || "classification";

  // ========== LABEL GATE ==========

  // 2.1 Target existence
  if (!targetColData) {
    blocked_reason_code = "BLOCKED_LABEL_MISSING";
    can_train = false;
    labelWarnings.push(`Target "${targetCol}" não encontrado no dataset.`);
  }

  const nClasses = targetColData?.distinct_count || null;
  const uniqueRatio = targetColData && totalRows > 0
    ? (targetColData.distinct_count || 0) / totalRows
    : null;

  if (targetColData && can_train) {
    // 2.2 Type vs problem_type
    if (problemType === "classification" || problemType === "binary" || problemType === "multiclass") {
      if (isTextType(targetColData.type) && (nClasses || 0) > 50) {
        blocked_reason_code = "BLOCKED_TARGET_INVALID";
        can_train = false;
        labelWarnings.push(`Target é texto com alta cardinalidade (${nClasses} classes). Máximo permitido: 50.`);
      }
      if ((nClasses || 0) < 2) {
        blocked_reason_code = "BLOCKED_TARGET_NO_VARIATION";
        can_train = false;
        labelWarnings.push("Target possui menos de 2 classes distintas. Sem variação para classificação.");
      }
    }
    if (problemType === "regression") {
      if (isTextType(targetColData.type)) {
        blocked_reason_code = "BLOCKED_TARGET_INVALID";
        can_train = false;
        labelWarnings.push("Target é texto/categoria, mas o problema é regressão. Selecione coluna numérica.");
      }
    }

    // 2.3 Distribution checks
    if (can_train && (problemType === "classification" || problemType === "binary")) {
      if (nClasses === 2) {
        // Estimate positive rate heuristically: if we have mean for numeric binary (0/1), mean ≈ positive_rate
        const meanVal = targetColData.mean;
        if (meanVal !== undefined && meanVal !== null) {
          if (meanVal < 0.005) {
            labelWarnings.push(`WARNING_IMBALANCED: Taxa positiva estimada em ${(meanVal * 100).toFixed(2)}% (< 0.5%). Desbalanceamento severo.`);
          }
          if (meanVal > 0.995 || meanVal < 0.005) {
            // Check for degenerate
            if (meanVal > 0.995) {
              blocked_reason_code = "BLOCKED_TARGET_DEGENERATE";
              can_train = false;
              labelWarnings.push("Classe dominante > 99.5%. Target degenerado — sem contraste para treino.");
            }
          }
        }
      }
    }
    if (can_train && problemType === "regression") {
      if (targetColData.std !== undefined && targetColData.std < 1e-10) {
        blocked_reason_code = "BLOCKED_TARGET_DEGENERATE";
        can_train = false;
        labelWarnings.push("Target numérico com desvio padrão ≈ 0. Sem variação para regressão.");
      }
    }

    // 2.4 ID disfarçado
    if (can_train && isTextType(targetColData.type) && (uniqueRatio || 0) > 0.2) {
      blocked_reason_code = "BLOCKED_TARGET_LOOKS_LIKE_ID";
      can_train = false;
      labelWarnings.push(`Target parece um identificador (unique_ratio = ${Math.round((uniqueRatio || 0) * 100)}%). Selecione outro target.`);
    }
  }

  // Compute positive_rate and dominant_class_rate for report
  let positive_rate: number | null = null;
  let dominant_class_rate: number | null = null;
  if (targetColData && (problemType === "classification" || problemType === "binary") && nClasses === 2) {
    const meanVal = targetColData.mean;
    if (meanVal !== undefined && meanVal !== null) {
      positive_rate = meanVal;
      dominant_class_rate = Math.max(meanVal, 1 - meanVal);
    }
  }

  // ========== LEAKAGE GATE ==========

  // 3.1 From FeatureReport
  if (report.leakage_detected) {
    leakageNotes.push(`Leakage detectado pelo Feature Builder em ${report.leakage_columns.length} coluna(s).`);
    // Only block if critical
    if (report.leakage_columns.length >= 3) {
      blocked_reason_code = "BLOCKED_LEAKAGE";
      can_train = false;
      leakageNotes.push("BLOCKED: Leakage estrutural em múltiplas colunas.");
    }
  }

  // 3.2 Token-based leakage check on feature names
  const LEAKAGE_TOKENS = /\b(target|label|resultado|aprovado|cancelado|status_final|y_true|y_pred|output_final)\b/i;
  for (const feat of report.features_final) {
    if (LEAKAGE_TOKENS.test(normalizeColName(feat)) && feat !== targetCol) {
      leakageNotes.push(`Possível leakage: feature "${feat}" contém token suspeito.`);
      report.leakage_columns.push({ column: feat, reason: "Token suspeito de leakage no nome da feature" });
    }
  }

  // ========== SPLIT GATE ==========

  let splitPlan = {
    strategy: splitStrategy,
    anchor_time_col: anchorTimeCol,
    train_frac: 0.7,
    val_frac: 0.15,
    test_frac: 0.15,
  };

  if (anchorTimeCol) {
    if (splitStrategy !== "temporal") {
      splitPlan.strategy = "temporal";
      sanityWarnings.push("Split corrigido para temporal (anchor_time_col presente).");
    }
  } else {
    if (splitStrategy === "temporal") {
      // Temporal split requested but no time column
      if (can_train) {
        sanityWarnings.push("Split temporal solicitado mas sem coluna de tempo. Usando stratified.");
        splitPlan.strategy = problemType === "regression" ? "random" : "stratified";
      }
    }
  }

  // ========== SANITY GATE ==========

  const minRows = (intent.guardrails as any)?.min_rows || 500;
  const min_rows_ok = totalRows >= minRows;
  if (!min_rows_ok) {
    sanityWarnings.push(`Dataset com ${totalRows} linhas (mínimo: ${minRows}). Resultados podem ser pouco confiáveis.`);
    if (totalRows < 50) {
      blocked_reason_code = "BLOCKED_MIN_ROWS";
      can_train = false;
    }
  }

  const totalFeaturesCount = report.features_final.length + report.features_generated.length;
  const min_features_ok = totalFeaturesCount >= 3;
  if (!min_features_ok) {
    blocked_reason_code = "BLOCKED_MIN_FEATURES";
    can_train = false;
    sanityWarnings.push(`Apenas ${totalFeaturesCount} features disponíveis (mínimo: 3).`);
  }

  // Global missing %
  let totalNulls = 0;
  let totalCells = 0;
  for (const col of enrichedColumns) {
    totalCells += totalRows;
    totalNulls += col.null_count || 0;
  }
  const missing_global_pct = totalCells > 0 ? Math.round((totalNulls / totalCells) * 100) : 0;

  if (missing_global_pct >= 80) {
    blocked_reason_code = "BLOCKED_MISSING_EXTREME";
    can_train = false;
    sanityWarnings.push(`Missing global de ${missing_global_pct}% é excessivo (>= 80%).`);
  } else if (missing_global_pct >= 50) {
    sanityWarnings.push(`WARNING: Missing global de ${missing_global_pct}%. Qualidade dos dados comprometida.`);
  }

  // Overfit
  if (report.overfit_risk_score >= 0.7) {
    sanityWarnings.push("WARNING_OVERFIT_RISK: Risco alto de overfitting. Considere reduzir agregações ou limitar one-hot encoding.");
  }

  // ========== FINAL STATUS ==========
  const allWarnings = [...labelWarnings, ...leakageNotes.filter(n => !n.startsWith("BLOCKED")), ...sanityWarnings];
  const status: "READY" | "WARNING" | "BLOCKED" = !can_train
    ? "BLOCKED"
    : allWarnings.length > 0
    ? "WARNING"
    : "READY";

  const dashboard_allowed_precheck = can_train && missing_global_pct < 50 && min_rows_ok;

  const next_action = !can_train
    ? `Corrija: ${blocked_reason_code}`
    : "Proceed to training";

  return {
    can_train,
    status,
    blocked_reason_code,
    label_report: {
      target_col: targetCol,
      problem_type: problemType,
      n_rows: totalRows,
      n_classes: nClasses,
      positive_rate,
      dominant_class_rate,
      unique_ratio: uniqueRatio,
      warnings: labelWarnings,
    },
    leakage_report: {
      leakage_detected: report.leakage_detected || leakageNotes.length > 0,
      leakage_columns: report.leakage_columns,
      notes: leakageNotes,
    },
    split_plan: splitPlan,
    sanity_report: {
      min_rows_ok,
      min_features_ok,
      missing_global_pct,
      overfit_risk_score: report.overfit_risk_score,
      warnings: sanityWarnings,
    },
    dashboard_allowed_precheck,
    next_action,
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

    const body = await req.json();
    const { project_id } = body;
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SSOT RULE: Builder NEVER accepts target/features from payload
    if (body.target_column || body.selected_features) {
      console.warn(`[build-modeling-dataset] REJECTED: client sent target_column/selected_features in payload. Ignoring.`);
    }

    const { data: project, error: projErr } = await supabase
      .from("projects").select("id, organization_id, user_id").eq("id", project_id).single();
    if (projErr || !project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[build-modeling-dataset] Starting for project ${project_id}`);

    // ── FRESH READ: Always read target from project_settings (SSOT for target) ──
    // The builder NEVER accepts target from the client request body. It reads from the DB.
    const [aiCtxRes, datasetStateRes, manifestRes, columnsRes, catStatsRes, numStatsRes, settingsRes, inferenceRes, contractRes, selectionRes] = await Promise.all([
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("import_manifests").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id).order("column_index"),
      supabase.from("project_categorical_stats").select("column_name, distinct_count").eq("project_id", project_id),
      supabase.from("project_numeric_stats").select("column_name, null_count, mean_value, std_value").eq("project_id", project_id),
      supabase.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_problem_inference").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
    ]);

    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const datasetState = datasetStateRes.data;
    const manifest = manifestRes.data;
    const projectColumns = columnsRes.data || [];
    const catStats = catStatsRes.data || [];
    const numStats = numStatsRes.data || [];
    const settings = settingsRes.data;
    const inference = inferenceRes.data;
    const existingContract = contractRes.data;
    const modelSelection = selectionRes.data as { target_column: string | null; selection_version: number; selected_features: string[]; problem_type: string | null; target_hash: string | null } | null;

    // ── Determine row_count from SSOT (dataset_state > manifest > project) ──
    let totalRows = 0;
    let dataSourceType = "upload";
    let isVirtualManifest = false;

    if (datasetState && datasetState.row_count > 0) {
      totalRows = datasetState.row_count;
      dataSourceType = datasetState.source_type || "upload";
      isVirtualManifest = datasetState.virtual_manifest || false;
      console.log(`[build-modeling-dataset] SSOT: dataset_state found. rows=${totalRows}, source=${dataSourceType}`);
    } else if (manifest && manifest.rows_consolidated > 0) {
      totalRows = manifest.rows_consolidated;
      console.log(`[build-modeling-dataset] Fallback: manifest found. rows=${totalRows}`);
      // Auto-populate dataset_state from manifest for future consistency
      await supabase.from("project_dataset_state").upsert({
        project_id,
        organization_id: project.organization_id,
        source_type: "upload",
        active_dataset_ref: manifest.dataset_id || null,
        row_count: manifest.rows_consolidated,
        col_count: manifest.columns_final,
        eda_ready: manifest.eda_ready !== false,
        model_ready: manifest.model_ready !== false,
        manifest_id: manifest.id,
        virtual_manifest: false,
        last_success_at: new Date().toISOString(),
        active_schema_json: manifest.canonical_schema || [],
        diagnostics: { auto_populated_from: "manifest", manifest_id: manifest.id },
      }, { onConflict: "project_id" });
    } else {
      // No dataset state and no manifest — check if we have columns at all (db/lake source)
      if (projectColumns.length > 0) {
        // Try to get row count from project
        const { data: projData } = await supabase.from("projects").select("total_rows, dataset_rows").eq("id", project_id).single();
        totalRows = projData?.total_rows || projData?.dataset_rows || 0;
        if (totalRows > 0) {
          isVirtualManifest = true;
          dataSourceType = "db";
          console.log(`[build-modeling-dataset] Virtual manifest mode. rows=${totalRows}, cols=${projectColumns.length}`);
          // Create dataset_state for future
          await supabase.from("project_dataset_state").upsert({
            project_id,
            organization_id: project.organization_id,
            source_type: "db",
            row_count: totalRows,
            col_count: projectColumns.length,
            eda_ready: true,
            model_ready: true,
            virtual_manifest: true,
            last_success_at: new Date().toISOString(),
            diagnostics: { reason: "auto_created_from_columns", no_manifest: true },
          }, { onConflict: "project_id" });
        }
      }
    }

    if (totalRows === 0) {
      return new Response(JSON.stringify({
        status: "BLOCKED_FEATURE_BUILDER",
        blocked_reasons: ["NO_ACTIVE_DATASET: Nenhum dataset ativo encontrado. Importe dados ou conecte uma fonte."],
        modeling_dataset_ready: false,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (projectColumns.length === 0) {
      return new Response(JSON.stringify({
        status: "BLOCKED_FEATURE_BUILDER",
        blocked_reasons: ["Nenhuma coluna detectada no projeto. Execute o EDA primeiro."],
        modeling_dataset_ready: false,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Build enriched column list
    const catMap = new Map(catStats.map((c: any) => [c.column_name, c.distinct_count as number]));
    const numMap = new Map(numStats.map((n: any) => [n.column_name, { null_count: n.null_count, mean: n.mean_value, std: n.std_value }]));
    const warnings: string[] = isVirtualManifest ? ["VIRTUAL_MANIFEST_IN_USE: Pipeline operando sem manifesto de importação real."] : [];

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

    // ==================== DETERMINE TARGET (SSOT: project_model_selection > project_settings > contract > auto) ====================
    // Priority: model_selection.target_column (versioned) > settings.target_column > contract > auto-detect
    const selectionVersion = modelSelection?.selection_version || 0;
    let targetColumn = modelSelection?.target_column || settings?.target_column || null;
    let targetType: "binary" | "multiclass" | "regression" = "binary";
    let targetSource: "direct" | "label_builder" = "direct";
    let labelPlan: LabelPlan | null = null;
    let windowDays: number | null = null;
    const allBlockedReasons: string[] = [];

    // SSOT: If project_model_selection exists but has no target, BLOCK immediately
    if (modelSelection && !modelSelection.target_column) {
      return new Response(JSON.stringify({
        status: "BLOCKED_NO_TARGET",
        action: "select_target",
        blocked_reasons: ["Nenhum target selecionado na configuração do modelo. Volte à Etapa 3 e selecione um target."],
        modeling_dataset_ready: false,
        selection_version: selectionVersion,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[build-modeling-dataset] Target source: selection="${modelSelection?.target_column}" (v${selectionVersion}), settings="${settings?.target_column}", resolved="${targetColumn}"`);

    // If no target in selection or settings, try existing contract
    if (!targetColumn && existingContract) {
      const td = existingContract.target_definition as Record<string, any> | null;
      if (td?.base_column) targetColumn = td.base_column;
      else if (td?.derived_target) targetColumn = td.derived_target;
    }

    if (targetColumn) {
      const col = enrichedColumns.find(c => c.name === targetColumn);
      if (!col) {
        // Check if target is a derived feature that hasn't been materialized
        const { data: derivedFeature } = await supabase
          .from("project_features")
          .select("id, name")
          .eq("project_id", project_id)
          .eq("name", targetColumn)
          .eq("enabled", true)
          .maybeSingle();

        if (derivedFeature) {
          allBlockedReasons.push(
            `BLOCKED_TARGET_NOT_MATERIALIZED: A feature derivada "${targetColumn}" ainda não foi materializada no dataset. ` +
            `Execute a materialização de features antes de gerar o dataset modelável.`
          );
        } else {
          allBlockedReasons.push(`Coluna target "${targetColumn}" não encontrada no dataset.`);
        }
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

    // ── BLOCKED if no target ──
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

    // ── Feature-level blocked reasons ──
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

    // ==================== TRAINING GATE (4.3) ====================
    const trainingGate = runTrainingGate(
      targetColumn,
      targetType,
      enrichedColumns,
      report,
      totalRows,
      anchorTimeCol,
      splitStrategy,
      intent,
    );

    console.log(`[build-modeling-dataset] TrainingGate: ${trainingGate.status}, can_train: ${trainingGate.can_train}, code: ${trainingGate.blocked_reason_code}`);

    // Merge gate blocked reasons into allBlockedReasons
    if (!trainingGate.can_train && trainingGate.blocked_reason_code) {
      const gateReasons = [
        ...trainingGate.label_report.warnings,
        ...trainingGate.leakage_report.notes.filter(n => n.startsWith("BLOCKED")),
        ...trainingGate.sanity_report.warnings.filter(w => w.includes("mínimo") || w.includes("excessivo")),
      ];
      for (const r of gateReasons) {
        if (!allBlockedReasons.includes(r)) allBlockedReasons.push(r);
      }
    }

    // Use split from gate (may be corrected)
    splitStrategy = trainingGate.split_plan.strategy;

    // ==================== TARGET HASH (for staleness detection) ====================
    const contractVersion = existingContract?.contract_version || "v1";
    const targetHashInput = `${project_id}|${targetColumn}|${windowDays || ""}|${anchorTimeCol || ""}|${entityKey || ""}|${contractVersion}`;
    // Simple hash for staleness detection (not cryptographic)
    let targetHash = 0;
    for (let i = 0; i < targetHashInput.length; i++) {
      const ch = targetHashInput.charCodeAt(i);
      targetHash = ((targetHash << 5) - targetHash) + ch;
      targetHash |= 0;
    }
    const targetHashStr = `th_${Math.abs(targetHash).toString(36)}`;

    console.log(`[build-modeling-dataset] Target hash: ${targetHashStr}, contract_version: ${contractVersion}`);

    // ==================== STATUS ====================
    const totalFeaturesFinal = report.features_final.length + report.features_generated.length;
    const coveragePct = enrichedColumns.length > 0 ? Math.round((report.features_final.length / enrichedColumns.length) * 100) : 0;

    // Final status combines feature builder + training gate
    let status: string;
    if (allBlockedReasons.length > 0 || !trainingGate.can_train) {
      status = "blocked";
    } else if (report.overfit_warning || trainingGate.status === "WARNING") {
      status = "warning";
    } else {
      status = "ready";
    }

    const modelingDatasetReady = status === "ready" || status === "warning";

    // Mark old datasets as not current
    await supabase.from("project_modeling_datasets")
      .update({ is_current: false, stale_reason: "NEW_BUILD" })
      .eq("project_id", project_id)
      .eq("is_current", true);

    const { data: saved, error: saveErr } = await supabase
      .from("project_modeling_datasets")
      .insert({
        project_id,
        organization_id: project.organization_id,
        dataset_id: manifest?.dataset_id || datasetState?.active_dataset_ref || null,
        intent_version: aiCtx?.intent?.version || "v1",
        manifest_version: manifest?.id || null,
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
        selection_version_used: selectionVersion,
        is_current: true,
        stale_reason: null,
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
          target_hash: targetHashStr,
          contract_version: contractVersion,
          feature_report: {
            features_removed: report.features_removed,
            temporal_features_created: report.temporal_features_created,
            aggregation_features_created: report.aggregation_features_created,
            missing_flags_created: report.missing_flags_created,
            imputation_applied: report.imputation_applied,
            overfit_risk_score: report.overfit_risk_score,
            overfit_warning: report.overfit_warning,
          },
          training_gate: trainingGate,
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

    // ── POST-BUILD: Sync project_dataset_state SSOT with builder results ──
    const diagnosticsUpdate: Record<string, any> = {
      ...(datasetState?.diagnostics as Record<string, any> || {}),
      builder_dataset_id: saved.id,
      selection_version_used: selectionVersion,
      builder_status: status,
      builder_updated_at: new Date().toISOString(),
    };

    await supabase.from("project_dataset_state")
      .update({
        model_ready: modelingDatasetReady,
        row_count: totalRows,
        col_count: totalFeaturesFinal + 1,
        diagnostics: diagnosticsUpdate,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", project_id);

    console.log(`[build-modeling-dataset] Synced project_dataset_state: model_ready=${modelingDatasetReady}, builder_dataset_id=${saved.id}`);

    // ── POST-BUILD: Re-check selection_version for race condition ──
    if (selectionVersion > 0) {
      const { data: postCheck } = await supabase
        .from("project_model_selection")
        .select("selection_version")
        .eq("project_id", project_id)
        .maybeSingle();
      const postVersion = (postCheck as any)?.selection_version || 0;
      if (postVersion > selectionVersion) {
        console.warn(`[build-modeling-dataset] RACE CONDITION: selection changed during build (${selectionVersion} -> ${postVersion}). Marking as stale.`);
        await supabase.from("project_modeling_datasets")
          .update({ is_current: false, stale_reason: "SELECTION_CHANGED_DURING_BUILD" })
          .eq("id", saved.id);
        // Also revert dataset_state model_ready
        await supabase.from("project_dataset_state")
          .update({ model_ready: false, diagnostics: { ...diagnosticsUpdate, builder_status: "stale", stale_reason: "SELECTION_CHANGED_DURING_BUILD" } })
          .eq("project_id", project_id);
        return new Response(JSON.stringify({
          status: "SELECTION_CHANGED_RETRY",
          error: "Seleção mudou durante a construção do dataset. Atualize a página e gere o builder novamente.",
          action: "REFRESH_SELECTION",
          selection_version_started: selectionVersion,
          selection_version_current: postVersion,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
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
      target_hash: targetHashStr,
      contract_version: contractVersion,
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
      training_gate: trainingGate,
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
