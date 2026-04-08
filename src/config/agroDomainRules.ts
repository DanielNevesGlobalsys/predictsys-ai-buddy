// ═══════════════════════════════════════════════════════════════════
// Agro Domain Rules — Column classification, target scoring, blockers
// ═══════════════════════════════════════════════════════════════════

/** Agro sub-domains */
export type AgroSubdomain =
  | "cafe" | "soja" | "milho" | "cana" | "pecuaria"
  | "cooperativa" | "leite" | "outro";

export type AgroBusinessCycle =
  | "safra" | "entressafra" | "captacao_continua" | "recebimento"
  | "industrializacao" | "distribuicao";

export type AgroForecastUnit =
  | "sacas" | "kg" | "toneladas" | "litros" | "volume" | "valor" | "outro";

export type AgroProductionEntity =
  | "produtor" | "lote" | "fazenda" | "talhao" | "cooperado"
  | "filial" | "unidade_recebimento" | "regiao" | "outro";

export type AgroBusinessEvent =
  | "captacao" | "producao" | "entrega" | "recebimento" | "pesagem"
  | "movimentacao" | "classificacao" | "liquidacao";

export type AgroSeasonalityGrain = "dia" | "semana" | "mes" | "safra" | "trimestre";

export interface AgroContext {
  agro_subdomain: AgroSubdomain;
  business_cycle: AgroBusinessCycle;
  forecast_unit: AgroForecastUnit;
  production_entity: AgroProductionEntity;
  has_seasonality: boolean;
  seasonality_grain: AgroSeasonalityGrain;
  business_event_of_interest: AgroBusinessEvent;
}

export function emptyAgroContext(): AgroContext {
  return {
    agro_subdomain: "outro",
    business_cycle: "captacao_continua",
    forecast_unit: "volume",
    production_entity: "produtor",
    has_seasonality: true,
    seasonality_grain: "mes",
    business_event_of_interest: "captacao",
  };
}

// ─── Column Pattern Categories ───────────────────────────────────

/** Strong target candidates for agro (quantitative production/volume columns) */
export const AGRO_TARGET_PATTERNS: RegExp[] = [
  /qtd/i, /qtdsac/i, /qtdpes/i, /sacas/i,
  /peso/i, /peso_liquido/i, /peso_bruto/i,
  /volume/i, /vol\b/i,
  /producao/i, /captacao/i, /recebimento/i,
  /tonelad/i, /\bton\b/i, /\bkg\b/i,
  /rendimento/i, /produtividade/i,
  /valor_recebido/i, /valor_total/i,
  /litros/i, /arrobas/i,
];

/** Temporal columns — NEVER target in agro */
export const AGRO_TEMPORAL_PATTERNS: RegExp[] = [
  /^data$/i, /^dt$/i, /^dt_/i, /datmov/i,
  /data_movimento/i, /data_recebimento/i, /data_entrega/i,
  /data_colheita/i, /data_plantio/i, /data_pesagem/i,
  /sk_data/i, /sk_filial/i,
  /calendario\./i, /^mes$/i, /^ano$/i, /^semana$/i,
  /^trimestre$/i, /^safra$/i, /competencia/i,
  /data_ref/i, /dt_ref/i,
];

/** Entity candidates in agro */
export const AGRO_ENTITY_PATTERNS: RegExp[] = [
  /produtor/i, /cooperado/i, /cooperativa/i,
  /fazenda/i, /talhao/i, /\blote\b/i, /codlot/i,
  /filial/i, /unidade/i, /regiao/i,
  /propriedade/i, /fornecedor/i,
  /cod_produtor/i, /id_produtor/i,
  /codpes/i, /codgre/i, /codemp/i,
  /sk_pessoa/i, /sk_empresa/i, /sk_representante/i,
  /sk_lotecaf/i,
];

/** Columns absolutely blocked as target in agro */
export const AGRO_BLOCKED_TARGET_PATTERNS: RegExp[] = [
  // Temporal
  ...AGRO_TEMPORAL_PATTERNS,
  // Technical keys
  /^id$/i, /^sk_/i, /uuid/i, /hash/i, /token/i,
  /^cod/i, /^codigo/i, /^index/i, /^_id$/i,
  // Entity columns (not predictable)
  ...AGRO_ENTITY_PATTERNS,
  // Calendar-derived
  /nome_mes/i, /nome_semana/i, /dia_semana/i, /dia_util/i,
  /feriado/i, /quarter/i,
  // Movement type (categorical, not target for production forecast)
  /tipo.*movimento/i, /origem.*movimenta/i,
];

/** Agro regression objectives — these should ALWAYS produce regression */
export const AGRO_REGRESSION_OBJECTIVES: string[] = [
  "producao", "captacao", "safra", "volume", "peso", "sacas",
  "toneladas", "recebimento", "produtividade", "demanda",
  "previsao_producao", "previsao_captacao", "previsao_safra",
  "previsao_volume", "previsao_peso", "previsao_sacas",
  "previsao_toneladas", "previsao_recebimento",
  "oferta_agricola", "entrega_futura",
  "demand_forecast", "production_forecast",
];

/** Agro classification objectives */
export const AGRO_CLASSIFICATION_OBJECTIVES: string[] = [
  "risco_quebra_safra", "risco_queda_entrega", "risco_inadimplencia_produtor",
  "risco_desvio_padrao", "risco_cancelamento_contrato", "risco_nao_entrega",
  "quebra_safra", "nao_entrega", "inadimplencia",
];

// ─── Scoring Engine ──────────────────────────────────────────────

export interface AgroColumnScore {
  column: string;
  target_score: number;
  time_score: number;
  entity_score: number;
  blocked_as_target: boolean;
  block_reason: string | null;
  signals: string[];
}

export function scoreAgroColumn(
  columnName: string,
  inferredType: string,
  objective: string,
): AgroColumnScore {
  const name = columnName.toLowerCase();
  const type = (inferredType || "").toLowerCase();
  const obj = (objective || "").toLowerCase();
  const signals: string[] = [];
  let targetScore = 0;
  let timeScore = 0;
  let entityScore = 0;
  let blockedAsTarget = false;
  let blockReason: string | null = null;

  // 1. Numeric signal
  const isNumeric = ["numeric", "integer", "float", "number", "decimal", "double"].some(t => type.includes(t));
  if (isNumeric) {
    targetScore += 0.2;
    signals.push("numeric_type");
  }

  // 2. Agro quantity signal
  if (AGRO_TARGET_PATTERNS.some(p => p.test(name))) {
    targetScore += 0.4;
    signals.push("agro_quantity_match");
  }

  // 3. Agro semantic signal — boost if objective matches
  const isProductionObjective = AGRO_REGRESSION_OBJECTIVES.some(o => obj.includes(o));
  if (isProductionObjective && AGRO_TARGET_PATTERNS.some(p => p.test(name))) {
    targetScore += 0.2;
    signals.push("objective_quantity_alignment");
  }

  // 4. Temporal column penalty
  if (AGRO_TEMPORAL_PATTERNS.some(p => p.test(name))) {
    targetScore -= 0.8;
    timeScore += 0.8;
    signals.push("temporal_column_penalty");
  }

  // 5. Date type penalty
  const isDateType = ["date", "datetime", "timestamp", "temporal", "data"].some(t => type.includes(t));
  if (isDateType) {
    targetScore -= 0.6;
    timeScore += 0.6;
    signals.push("date_type_penalty");
  }

  // 6. Entity signal
  if (AGRO_ENTITY_PATTERNS.some(p => p.test(name))) {
    entityScore += 0.7;
    targetScore -= 0.3;
    signals.push("entity_column");
  }

  // 7. ID/SK penalty
  if (/^(id|sk_|uuid|hash|token|codigo|cod_)/i.test(name)) {
    targetScore -= 0.5;
    signals.push("id_penalty");
  }

  // 8. Calendar penalty
  if (/calendario\.|nome_mes|nome_semana|dia_semana/i.test(name)) {
    targetScore -= 0.7;
    signals.push("calendar_penalty");
  }

  // Blocked check
  if (AGRO_BLOCKED_TARGET_PATTERNS.some(p => p.test(name))) {
    blockedAsTarget = true;
    if (AGRO_TEMPORAL_PATTERNS.some(p => p.test(name)) || isDateType) {
      blockReason = "Coluna temporal — não pode ser target em projetos agro.";
    } else if (AGRO_ENTITY_PATTERNS.some(p => p.test(name))) {
      blockReason = "Coluna de entidade — não é previsível como target.";
    } else {
      blockReason = "Coluna bloqueada como target (chave técnica ou calendário).";
    }
  }

  return {
    column: columnName,
    target_score: Math.max(0, Math.min(1, targetScore)),
    time_score: Math.max(0, Math.min(1, timeScore)),
    entity_score: Math.max(0, Math.min(1, entityScore)),
    blocked_as_target: blockedAsTarget,
    block_reason: blockReason,
    signals,
  };
}

/** Score all columns and rank targets for agro */
export function rankAgroTargets(
  columns: Array<{ column_name: string; inferred_type: string }>,
  objective: string,
): {
  ranked: AgroColumnScore[];
  best_target: AgroColumnScore | null;
  best_time: AgroColumnScore | null;
  best_entity: AgroColumnScore | null;
  blocked: AgroColumnScore[];
} {
  const scored = columns.map(c => scoreAgroColumn(c.column_name, c.inferred_type, objective));

  const validTargets = scored
    .filter(s => !s.blocked_as_target && s.target_score > 0.1)
    .sort((a, b) => b.target_score - a.target_score);

  const timeColumns = scored
    .filter(s => s.time_score > 0.3)
    .sort((a, b) => b.time_score - a.time_score);

  const entityColumns = scored
    .filter(s => s.entity_score > 0.3)
    .sort((a, b) => b.entity_score - a.entity_score);

  const blocked = scored.filter(s => s.blocked_as_target);

  return {
    ranked: validTargets,
    best_target: validTargets[0] || null,
    best_time: timeColumns[0] || null,
    best_entity: entityColumns[0] || null,
    blocked,
  };
}

// ─── Problem Type Resolution for Agro ────────────────────────────

export function resolveAgroProblemType(objective: string): "classification" | "regression" | null {
  const obj = (objective || "").toLowerCase();
  if (AGRO_REGRESSION_OBJECTIVES.some(o => obj.includes(o))) return "regression";
  if (AGRO_CLASSIFICATION_OBJECTIVES.some(o => obj.includes(o))) return "classification";
  return null;
}

// ─── Agro Governance Checks ──────────────────────────────────────

export interface AgroGovernanceCheck {
  check_id: string;
  severity: "block" | "warning";
  message: string;
  details?: string;
}

export function runAgroGovernanceChecks(params: {
  industry: string;
  objective: string;
  targetColumn: string | null;
  timeColumn: string | null;
  entityKey: string | null;
  problemType: string;
  grain: string;
  splitStrategy: string;
  columns: Array<{ column_name: string; inferred_type: string }>;
}): AgroGovernanceCheck[] {
  const checks: AgroGovernanceCheck[] = [];
  const { targetColumn, timeColumn, entityKey, problemType, grain, splitStrategy, objective, columns } = params;
  const obj = (objective || "").toLowerCase();
  const target = (targetColumn || "").toLowerCase();

  // Check 1: target is temporal
  if (targetColumn && AGRO_TEMPORAL_PATTERNS.some(p => p.test(target))) {
    checks.push({
      check_id: "agro_target_temporal_conflict",
      severity: "block",
      message: `Target "${targetColumn}" é uma coluna temporal — não pode ser variável-alvo em projetos agro.`,
      details: "Colunas temporais como datas, meses e períodos devem ser usadas como âncora de tempo, não como target.",
    });
  }

  // Check 2: target is entity
  if (targetColumn && AGRO_ENTITY_PATTERNS.some(p => p.test(target))) {
    checks.push({
      check_id: "agro_target_entity_conflict",
      severity: "block",
      message: `Target "${targetColumn}" é uma coluna de entidade — não é previsível como variável-alvo.`,
    });
  }

  // Check 3: target is date type
  if (targetColumn) {
    const col = columns.find(c => c.column_name === targetColumn);
    if (col && ["date", "datetime", "timestamp", "temporal"].some(t => (col.inferred_type || "").toLowerCase().includes(t))) {
      checks.push({
        check_id: "agro_target_date_type",
        severity: "block",
        message: `Target "${targetColumn}" tem tipo temporal (${col.inferred_type}) — inválido como variável-alvo.`,
      });
    }
  }

  // Check 4: production objective + non-quantitative target
  const isProductionObj = AGRO_REGRESSION_OBJECTIVES.some(o => obj.includes(o));
  if (isProductionObj && targetColumn) {
    const col = columns.find(c => c.column_name === targetColumn);
    const isNumeric = col && ["numeric", "integer", "float", "number", "decimal", "double"]
      .some(t => (col.inferred_type || "").toLowerCase().includes(t));
    if (!isNumeric) {
      checks.push({
        check_id: "agro_problem_target_mismatch",
        severity: "block",
        message: `Objetivo agro de produção/captação requer target numérico, mas "${targetColumn}" não é quantitativo.`,
      });
    }
  }

  // Check 5: production objective + classification
  if (isProductionObj && problemType === "classification") {
    checks.push({
      check_id: "agro_problem_type_mismatch",
      severity: "warning",
      message: "Objetivo de produção/captação normalmente requer regressão, não classificação. Verifique se o tipo está correto.",
    });
  }

  // Check 6: split not temporal when time available
  const hasValidTime = !!timeColumn || columns.some(c =>
    AGRO_TEMPORAL_PATTERNS.some(p => p.test(c.column_name.toLowerCase())) &&
    ["date", "datetime", "timestamp"].some(t => (c.inferred_type || "").toLowerCase().includes(t))
  );
  if (hasValidTime && splitStrategy !== "temporal" && splitStrategy !== "blocked_temporal") {
    checks.push({
      check_id: "agro_split_conflict",
      severity: "warning",
      message: "Coluna temporal válida disponível mas split não é temporal. Split temporal é fortemente recomendado para agro.",
    });
  }

  // Check 7: grain not entity_time for production forecasts
  if (isProductionObj && entityKey && timeColumn && grain !== "entity_time" && grain !== "entity_product_time") {
    checks.push({
      check_id: "agro_grain_conflict",
      severity: "warning",
      message: "Objetivo de produção/captação com entidade e tempo requer grain entity_time ou entity_product_time.",
    });
  }

  // Check 8: no entity when production requires it
  if (isProductionObj && !entityKey) {
    checks.push({
      check_id: "agro_entity_missing",
      severity: "warning",
      message: "Previsão de produção/captação normalmente requer uma entidade (produtor, lote, região). Nenhuma entidade detectada.",
    });
  }

  // Check 9: calendar column as target
  if (targetColumn && /calendario\./i.test(target)) {
    checks.push({
      check_id: "agro_target_calendar_conflict",
      severity: "block",
      message: `Target "${targetColumn}" vem de uma tabela de calendário — calendário é apoio temporal, não alvo.`,
    });
  }

  return checks;
}

// ─── Multi-table Classification for Agro ─────────────────────────

export interface AgroTableRole {
  table_name: string;
  role: "event_fact" | "transaction_fact" | "dimension_lookup_temporal" | "dimension_entity" | "unknown";
  has_quantity_columns: boolean;
  has_temporal_columns: boolean;
  has_entity_columns: boolean;
  reasoning: string;
}

export function classifyAgroTable(
  tableName: string,
  columns: Array<{ column_name: string; inferred_type: string }>,
): AgroTableRole {
  const name = tableName.toLowerCase();
  const hasQty = columns.some(c => AGRO_TARGET_PATTERNS.some(p => p.test(c.column_name)));
  const hasTime = columns.some(c => AGRO_TEMPORAL_PATTERNS.some(p => p.test(c.column_name)));
  const hasEntity = columns.some(c => AGRO_ENTITY_PATTERNS.some(p => p.test(c.column_name)));

  // Calendar tables
  if (/calend[aá]rio|calendar|dim_data|dim_tempo|dim_time/i.test(name)) {
    return {
      table_name: tableName, role: "dimension_lookup_temporal",
      has_quantity_columns: hasQty, has_temporal_columns: true, has_entity_columns: hasEntity,
      reasoning: "Tabela de calendário detectada — apoio temporal, não fonte de target.",
    };
  }

  // Movement/transaction tables
  if (/movimenta|transacao|fato_|fact_|detalhe|movimento|recebimento|pesagem|entrega/i.test(name)) {
    return {
      table_name: tableName, role: hasQty ? "event_fact" : "transaction_fact",
      has_quantity_columns: hasQty, has_temporal_columns: hasTime, has_entity_columns: hasEntity,
      reasoning: hasQty
        ? "Tabela de movimentação/fato com colunas quantitativas — fonte primária de target."
        : "Tabela de movimentação/transação sem colunas quantitativas claras.",
    };
  }

  // Entity dimension
  if (/dim_|cadastro|produtor|cooperado|fazenda|filial|unidade/i.test(name)) {
    return {
      table_name: tableName, role: "dimension_entity",
      has_quantity_columns: hasQty, has_temporal_columns: hasTime, has_entity_columns: true,
      reasoning: "Tabela de dimensão/cadastro — fonte de entidade.",
    };
  }

  return {
    table_name: tableName, role: "unknown",
    has_quantity_columns: hasQty, has_temporal_columns: hasTime, has_entity_columns: hasEntity,
    reasoning: "Tabela não classificada automaticamente.",
  };
}

// ─── Detect if industry is Agro ──────────────────────────────────

export function isAgroIndustry(industry: string | undefined): boolean {
  return (industry || "").toLowerCase() === "agro";
}
