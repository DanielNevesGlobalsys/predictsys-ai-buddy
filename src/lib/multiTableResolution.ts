// ═══════════════════════════════════════════════════════════════════
// Multi-Table Structural Resolution — Core Platform Capability
// Universal fact/dimension classification, ID blocking, temporal ranking
// Domain-agnostic: works for agro, retail, health, finance, etc.
// ═══════════════════════════════════════════════════════════════════

// ─── Types ─────────────────────────────────────────────────────

export type TableRole = "fact" | "dimension" | "bridge" | "lookup_temporal" | "ambiguous";

export interface TableClassification {
  table_name: string;
  role: TableRole;
  confidence: number;
  signals: TableSignal[];
  reasoning: string;
}

export interface TableSignal {
  signal: string;
  weight: number;
  direction: "fact" | "dimension" | "neutral";
}

export interface MultiTableResolution {
  primary_table: string | null;
  dimension_tables: string[];
  bridge_tables: string[];
  classifications: TableClassification[];
  reasoning: string[];
}

export type ColumnBlockRole = "feature" | "entity" | "target" | "time";

export interface ColumnBlockResult {
  blocked: boolean;
  reason: string;
  severity: "hard" | "soft";
}

export interface TemporalRankEntry {
  column: string;
  table: string | null;
  rank_score: number;
  category: TemporalCategory;
  reasons: string[];
}

export type TemporalCategory =
  | "operational_fact"
  | "event_date"
  | "transactional"
  | "calendar_auxiliary"
  | "cadastral"
  | "derived_secondary"
  | "blocked";

// ─── Domain Adapter Interface ──────────────────────────────────

export interface DomainAdapter {
  domain: string;
  /** Extra tokens that signal a fact table in this domain */
  factTableTokens: string[];
  /** Extra tokens that signal a dimension table in this domain */
  dimensionTableTokens: string[];
  /** Extra admin ID patterns to block */
  adminIdPatterns: string[];
  /** Extra operational date tokens */
  operationalDateTokens: string[];
  /** Semantic boosts for entity scoring */
  entityBoosts: Array<{ pattern: string; tier: 1 | 2 | 3 }>;
  /** Semantic boosts for value/target scoring */
  valueBoosts: string[];
}

// ─── Default (empty) adapter ───────────────────────────────────

const EMPTY_ADAPTER: DomainAdapter = {
  domain: "generic",
  factTableTokens: [],
  dimensionTableTokens: [],
  adminIdPatterns: [],
  operationalDateTokens: [],
  entityBoosts: [],
  valueBoosts: [],
};

// ═══════════════════════════════════════════════════════════════════
// PILAR 1 — Universal Fact vs Dimension Classification
// ═══════════════════════════════════════════════════════════════════

// Core tokens that universally signal fact tables (domain-agnostic)
const CORE_FACT_TOKENS = [
  "fato", "fact", "fact_", "f_",
  "transacao", "transacoes", "transaction", "transactions",
  "moviment", "movimento", "movements",
  "detalhe", "detail", "details",
  "evento", "event", "events",
  "pedido", "order", "orders",
  "venda", "vendas", "sale", "sales",
  "compra", "compras", "purchase", "purchases",
  "lancamento", "entry", "entries",
  "registro", "record", "records",
  "operacao", "operacoes", "operation", "operations",
  "linha", "line_item", "line_items",
  "ticket", "tickets",
  "sinistro", "claim", "claims",
  "atendimento", "attendance", "visit", "visits",
  "internacao", "admission", "admissions",
  "matricula", "enrollment", "enrollments",
  "remessa", "shipment", "shipments",
  "pagamento", "payment", "payments",
  "cobranca", "billing",
  "receita", "revenue",
];

// Core tokens that universally signal dimension tables
const CORE_DIMENSION_TOKENS = [
  "dim_", "d_", "dim",
  "cadastro", "registro_mestre", "master",
  "cliente", "customer", "customers",
  "produto", "product", "products",
  "filial", "branch", "store", "loja",
  "fornecedor", "supplier", "vendor",
  "funcionario", "employee", "employees",
  "medico", "doctor", "physician",
  "aluno", "student", "students",
  "paciente", "patient", "patients",
  "cooperado", "cooperator",
  "regiao", "region", "regions",
  "categoria", "category", "categories",
  "departamento", "department",
  "segmento", "segment",
  "tipo", "type_",
  "status_ref", "status_master",
  "calendario", "calendar", "dimdate", "dimcalendar", "dim_date",
  "lookup", "lkp_", "ref_",
  "origem", "origin", "source_ref",
  "representante", "representative", "agent",
  "safra", "crop", "season",
  "fazenda", "farm", "property",
  "produtor", "producer", "grower",
  "municipio", "city", "cities",
];

export interface TableMetrics {
  table_name: string;
  row_count?: number;
  column_count?: number;
  has_numeric_measures?: boolean;
  has_operational_dates?: boolean;
  has_foreign_keys?: boolean;
  columns?: Array<{ column_name: string; inferred_type: string }>;
}

/**
 * Classify a single table as fact, dimension, bridge, or ambiguous.
 * Uses a weighted signal scoring system.
 */
export function classifyTable(
  table: TableMetrics,
  allTables: TableMetrics[],
  adapter: DomainAdapter = EMPTY_ADAPTER,
): TableClassification {
  const name = normalize(table.table_name);
  const signals: TableSignal[] = [];
  let factScore = 0;
  let dimScore = 0;

  // Signal 1: Name tokens
  const allFactTokens = [...CORE_FACT_TOKENS, ...adapter.factTableTokens];
  const allDimTokens = [...CORE_DIMENSION_TOKENS, ...adapter.dimensionTableTokens];

  for (const token of allFactTokens) {
    if (name.includes(normalize(token))) {
      const w = 3;
      factScore += w;
      signals.push({ signal: `name_token:${token}`, weight: w, direction: "fact" });
      break; // one match is enough
    }
  }
  for (const token of allDimTokens) {
    if (name.includes(normalize(token))) {
      const w = 3;
      dimScore += w;
      signals.push({ signal: `name_token:${token}`, weight: w, direction: "dimension" });
      break;
    }
  }

  // Signal 2: Row count relative to other tables (if available)
  if (table.row_count != null && allTables.length > 1) {
    const maxRows = Math.max(...allTables.map(t => t.row_count || 0));
    if (maxRows > 0) {
      const ratio = (table.row_count || 0) / maxRows;
      if (ratio > 0.5) {
        const w = 2;
        factScore += w;
        signals.push({ signal: `high_row_count:${ratio.toFixed(2)}`, weight: w, direction: "fact" });
      } else if (ratio < 0.1) {
        const w = 2;
        dimScore += w;
        signals.push({ signal: `low_row_count:${ratio.toFixed(2)}`, weight: w, direction: "dimension" });
      }
    }
  }

  // Signal 3: Presence of numeric measure columns
  if (table.has_numeric_measures) {
    const w = 2;
    factScore += w;
    signals.push({ signal: "has_numeric_measures", weight: w, direction: "fact" });
  }

  // Signal 4: Presence of operational dates
  if (table.has_operational_dates) {
    const w = 2;
    factScore += w;
    signals.push({ signal: "has_operational_dates", weight: w, direction: "fact" });
  }

  // Signal 5: Column-level analysis (if columns provided)
  if (table.columns?.length) {
    const cols = table.columns;
    const numericCols = cols.filter(c => isNumericType(c.inferred_type));
    const dateCols = cols.filter(c => isDateType(c.inferred_type));
    const textCols = cols.filter(c => isTextType(c.inferred_type));

    // High ratio of descriptive text → dimension
    if (textCols.length > cols.length * 0.6) {
      const w = 1.5;
      dimScore += w;
      signals.push({ signal: "mostly_text_columns", weight: w, direction: "dimension" });
    }
    // Multiple numeric measures → fact
    if (numericCols.length >= 3) {
      const w = 1.5;
      factScore += w;
      signals.push({ signal: `many_numeric_cols:${numericCols.length}`, weight: w, direction: "fact" });
    }
    // Multiple dates → likely fact with events
    if (dateCols.length >= 2) {
      const w = 1;
      factScore += w;
      signals.push({ signal: `multiple_dates:${dateCols.length}`, weight: w, direction: "fact" });
    }
  }

  // Signal 6: Calendar/lookup detection
  if (isCalendarTable(name)) {
    const w = 5;
    dimScore += w;
    signals.push({ signal: "calendar_table_detected", weight: w, direction: "dimension" });
  }

  // Compute role
  const total = factScore + dimScore || 1;
  const factRatio = factScore / total;
  let role: TableRole;
  let confidence: number;

  if (factScore > dimScore && factRatio > 0.6) {
    role = "fact";
    confidence = Math.min(factRatio, 0.95);
  } else if (dimScore > factScore && (dimScore / total) > 0.6) {
    role = isCalendarTable(name) ? "lookup_temporal" : "dimension";
    confidence = Math.min(dimScore / total, 0.95);
  } else {
    role = "ambiguous";
    confidence = 0.4;
  }

  const reasoning = `${table.table_name}: fact_score=${factScore.toFixed(1)}, dim_score=${dimScore.toFixed(1)} → ${role} (${(confidence * 100).toFixed(0)}%)`;

  return { table_name: table.table_name, role, confidence, signals, reasoning };
}

/**
 * Resolve multi-table layout: identify primary fact, dimensions, bridges.
 */
export function resolveMultiTableLayout(
  tables: TableMetrics[],
  adapter: DomainAdapter = EMPTY_ADAPTER,
): MultiTableResolution {
  if (tables.length <= 1) {
    return {
      primary_table: tables[0]?.table_name || null,
      dimension_tables: [],
      bridge_tables: [],
      classifications: tables.map(t => classifyTable(t, tables, adapter)),
      reasoning: ["Single table — no multi-table resolution needed."],
    };
  }

  const classifications = tables.map(t => classifyTable(t, tables, adapter));
  const facts = classifications.filter(c => c.role === "fact").sort((a, b) => b.confidence - a.confidence);
  const dims = classifications.filter(c => c.role === "dimension" || c.role === "lookup_temporal");
  const bridges = classifications.filter(c => c.role === "bridge");
  const ambiguous = classifications.filter(c => c.role === "ambiguous");

  const reasoning: string[] = [];

  // Pick primary fact: highest confidence fact, or highest row-count ambiguous
  let primary: string | null = null;
  if (facts.length > 0) {
    primary = facts[0].table_name;
    reasoning.push(`Primary fact table: ${primary} (confidence=${(facts[0].confidence * 100).toFixed(0)}%)`);
  } else if (ambiguous.length > 0) {
    // Fallback: pick highest row-count ambiguous
    const sorted = [...ambiguous].sort((a, b) => {
      const ra = tables.find(t => t.table_name === a.table_name)?.row_count || 0;
      const rb = tables.find(t => t.table_name === b.table_name)?.row_count || 0;
      return rb - ra;
    });
    primary = sorted[0].table_name;
    reasoning.push(`No clear fact table found. Using highest-cardinality ambiguous: ${primary}`);
  }

  const dimensionTables = dims.map(d => d.table_name);
  const bridgeTables = bridges.map(b => b.table_name);

  // Remaining ambiguous tables treated as dimensions
  for (const a of ambiguous) {
    if (a.table_name !== primary) {
      dimensionTables.push(a.table_name);
      reasoning.push(`Ambiguous table ${a.table_name} treated as dimension (not primary).`);
    }
  }

  return { primary_table: primary, dimension_tables: dimensionTables, bridge_tables: bridgeTables, classifications, reasoning };
}

// ═══════════════════════════════════════════════════════════════════
// PILAR 2 — Universal Administrative ID Blocking
// ═══════════════════════════════════════════════════════════════════

// Universal patterns for administrative/surrogate/PII columns
const UNIVERSAL_ADMIN_ID_PATTERNS = [
  // Surrogate keys
  /^sk_/i,
  /^id_/i,
  /^pk_/i,
  /^fk_/i,
  // PII
  /^cpf$/i, /^cnpj$/i, /^rg$/i,
  /^email$/i, /^e_mail$/i, /^e-mail$/i,
  /^telefone$/i, /^phone$/i, /^celular$/i, /^mobile$/i, /^fone$/i,
  /^cel$/i, /^cel_/i, /^celcpr$/i,
  /^endereco$/i, /^address$/i, /^cep$/i, /^zip$/i, /^zipcode$/i,
  // Administrative codes
  /^matricula$/i, /^matric$/i, /^registration$/i,
  /^codemp$/i, /^cod_emp$/i, /^codigo_empresa$/i,
  /^razao_social$/i, /^fantasia$/i, /^trade_name$/i,
  /^nome$/i, /^name$/i, /^full_name$/i, /^first_name$/i, /^last_name$/i,
  // Technical row identifiers
  /^row_id$/i, /^row_number$/i, /^index$/i, /^unnamed/i, /^__/,
];

// Exact matches for common surrogate patterns
const SURROGATE_PREFIXES = ["sk_", "pk_", "fk_", "__"];

/**
 * Check if a column should be blocked for a given role.
 * Core platform rule — domain-agnostic.
 */
export function checkColumnBlock(
  columnName: string,
  role: ColumnBlockRole,
  tableRole: TableRole | null,
  adapter: DomainAdapter = EMPTY_ADAPTER,
): ColumnBlockResult {
  const colPart = extractColumnPart(columnName);
  const lo = colPart.toLowerCase();

  // ── TARGET: never allow admin IDs or surrogate keys ──
  if (role === "target") {
    if (isSurrogateKey(lo)) {
      return { blocked: true, reason: "BLOCK_SK_AS_TARGET: Surrogate key cannot be target.", severity: "hard" };
    }
    if (isAdminId(lo, adapter)) {
      return { blocked: true, reason: "BLOCK_ADMIN_ID_AS_TARGET: Administrative ID cannot be target.", severity: "hard" };
    }
    if (isDateType_byName(lo)) {
      return { blocked: true, reason: "BLOCK_DATE_AS_TARGET: Date columns cannot be target.", severity: "hard" };
    }
  }

  // ── FEATURE: block admin IDs and surrogate keys by default ──
  if (role === "feature") {
    if (isSurrogateKey(lo)) {
      return { blocked: true, reason: "BLOCK_SK_FEATURE: Surrogate key has no predictive value.", severity: "hard" };
    }
    if (isAdminId(lo, adapter)) {
      return { blocked: true, reason: "BLOCK_ADMIN_ID_FEATURE: Administrative ID blocked as feature.", severity: "soft" };
    }
    // Dimension table FK columns should be penalized
    if (tableRole === "dimension" && /^(cod|id|code|key|fk)/i.test(lo)) {
      return { blocked: true, reason: "BLOCK_DIM_FK_FEATURE: Dimension FK has no direct predictive value.", severity: "soft" };
    }
  }

  // ── ENTITY: only from fact table or with strong justification ──
  if (role === "entity") {
    if (isSurrogateKey(lo)) {
      return { blocked: true, reason: "BLOCK_SK_AS_ENTITY: Prefer business keys over surrogate keys.", severity: "soft" };
    }
    if (tableRole === "dimension") {
      return { blocked: false, reason: "WARN_DIM_ENTITY: Entity from dimension — verify fact table has no better candidate.", severity: "soft" };
    }
  }

  // ── TIME: block derived/cadastral dates from dimensions ──
  if (role === "time" && tableRole === "dimension") {
    const derivedTokens = ["ult", "ultimo", "última", "ultima", "cadastro", "nascimento", "admissao", "desligamento", "last_"];
    if (derivedTokens.some(t => lo.includes(t))) {
      return { blocked: true, reason: "BLOCK_DIM_DERIVED_TIME: Derived/cadastral date from dimension table.", severity: "soft" };
    }
  }

  return { blocked: false, reason: "", severity: "soft" };
}

function isSurrogateKey(lo: string): boolean {
  return SURROGATE_PREFIXES.some(p => lo.startsWith(p));
}

function isAdminId(lo: string, adapter: DomainAdapter): boolean {
  const allPatterns = [...UNIVERSAL_ADMIN_ID_PATTERNS, ...adapter.adminIdPatterns.map(p => new RegExp(p, "i"))];
  return allPatterns.some(rx => rx.test(lo));
}

function isDateType_byName(lo: string): boolean {
  const dateTokens = ["data_", "dt_", "date_", "datmov", "created_at", "updated_at", "timestamp"];
  return dateTokens.some(t => lo.includes(t));
}

// ═══════════════════════════════════════════════════════════════════
// PILAR 3 — Temporal Ranking: Operational > Cadastral
// ═══════════════════════════════════════════════════════════════════

// Universal operational date tokens (cross-domain)
const CORE_OPERATIONAL_DATE_TOKENS = [
  "datmov", "dt_mov", "data_movimento", "data_movimentacao",
  "data_operacional", "operational_date",
  "data_evento", "event_date", "dt_evento",
  "data_transacao", "transaction_date", "dt_transacao",
  "data_compra", "purchase_date", "order_date", "data_pedido",
  "data_internacao", "admission_date",
  "data_consulta", "visit_date", "appointment_date",
  "data_entrega", "delivery_date", "ship_date",
  "data_emissao", "issue_date",
  "data_pagamento", "payment_date",
  "data_matricula", "enrollment_date",
  "data_sinistro", "claim_date",
  "data_venda", "sale_date",
  "data_recebimento", "receipt_date",
  "data_pesagem", "weighing_date",
  "data_colheita", "harvest_date",
  "data_plantio", "planting_date",
];

// Cadastral/derived date tokens (universally deprioritized)
const CADASTRAL_DATE_TOKENS = [
  "data_cadastro", "registration_date", "signup_date",
  "data_nascimento", "birth_date", "birthdate",
  "data_admissao", "hire_date",
  "data_criacao", "created_at", "creation_date",
  "data_atualizacao", "updated_at", "last_updated",
  "data_ult", "last_", "ult_", "ultima_", "último_",
  "data_desligamento", "termination_date",
];

// Post-event dates (blocked as time anchors)
const POST_EVENT_DATE_TOKENS = [
  "data_cancelamento", "cancellation_date",
  "data_obito", "death_date",
  "data_encerramento", "close_date",
  "data_saida", "exit_date",
  "data_fim", "end_date",
  "data_resultado", "result_date",
];

/**
 * Rank temporal columns by operational relevance.
 * Returns sorted list, best first.
 */
export function rankTemporalColumns(
  columns: Array<{ column_name: string; inferred_type: string }>,
  tableClassifications: TableClassification[],
  adapter: DomainAdapter = EMPTY_ADAPTER,
): TemporalRankEntry[] {
  const dateCols = columns.filter(c =>
    isDateType(c.inferred_type) || isDateLikeName(c.column_name),
  );

  const allOpTokens = [...CORE_OPERATIONAL_DATE_TOKENS, ...adapter.operationalDateTokens];
  const entries: TemporalRankEntry[] = [];

  for (const col of dateCols) {
    const colPart = extractColumnPart(col.column_name).toLowerCase();
    const tableName = extractTableName(col.column_name);
    const tableClass = tableName
      ? tableClassifications.find(tc => normalize(tc.table_name) === normalize(tableName))
      : null;
    const tableRole = tableClass?.role || null;

    let score = 0;
    let category: TemporalCategory = "derived_secondary";
    const reasons: string[] = [];

    // Check if post-event (blocked)
    if (POST_EVENT_DATE_TOKENS.some(t => colPart.includes(t))) {
      entries.push({ column: col.column_name, table: tableName, rank_score: -100, category: "blocked", reasons: ["Post-event date — blocked as time anchor"] });
      continue;
    }

    // Tier 1: Operational date from fact table (+10)
    if (tableRole === "fact" && allOpTokens.some(t => colPart.includes(t))) {
      score += 10;
      category = "operational_fact";
      reasons.push("Operational date from fact table — highest priority");
    }
    // Tier 2: Operational date from unknown table (+7)
    else if (!tableRole && allOpTokens.some(t => colPart.includes(t))) {
      score += 7;
      category = "operational_fact";
      reasons.push("Operational date pattern — high priority");
    }
    // Tier 3: Any date from fact table (+6)
    else if (tableRole === "fact") {
      score += 6;
      category = "event_date";
      reasons.push("Date column from fact table");
    }
    // Tier 4: Calendar/lookup temporal (+2, auxiliary)
    else if (tableRole === "lookup_temporal" || isCalendarTable(normalize(tableName || ""))) {
      score += 2;
      category = "calendar_auxiliary";
      reasons.push("Calendar/lookup date — auxiliary, not primary anchor");
    }
    // Tier 5: Cadastral date (-2)
    else if (CADASTRAL_DATE_TOKENS.some(t => colPart.includes(t))) {
      score -= 2;
      category = "cadastral";
      reasons.push("Cadastral/registration date — low priority");
    }
    // Tier 6: Derived date from dimension (-3)
    else if (tableRole === "dimension") {
      score -= 3;
      category = "derived_secondary";
      reasons.push("Date from dimension table — not operational anchor");
      const derivedTokens = ["ult", "ultimo", "última", "ultima", "last_"];
      if (derivedTokens.some(t => colPart.includes(t))) {
        score -= 2;
        reasons.push("Derived 'last *' date — additional penalty");
      }
    }
    // Default: generic date (+3)
    else {
      score += 3;
      category = "transactional";
      reasons.push("Generic date column");
    }

    // Bonus: known transactional tokens
    const txTokens = ["compra", "purchase", "pedido", "order", "venda", "sale", "entrega", "delivery"];
    if (txTokens.some(t => colPart.includes(t))) {
      score += 2;
      if (category === "derived_secondary") category = "transactional";
      reasons.push("Transactional date token bonus");
    }

    // Penalty: SK_DATA or surrogate temporal keys
    if (colPart.startsWith("sk_") || colPart === "sk_data") {
      score -= 4;
      reasons.push("Surrogate temporal key — not operational");
    }

    // Penalty: updated_at
    if (colPart === "updated_at" || colPart === "dt_atualizacao") {
      score -= 5;
      reasons.push("updated_at is not an anchor");
    }

    entries.push({ column: col.column_name, table: tableName, rank_score: score, category, reasons });
  }

  return entries.sort((a, b) => b.rank_score - a.rank_score);
}

// ═══════════════════════════════════════════════════════════════════
// Governance Conflict Detection
// ═══════════════════════════════════════════════════════════════════

export interface GovernanceConflict {
  code: string;
  severity: "block" | "warn";
  message: string;
  suggestion: string;
}

/**
 * Detect structural conflicts in multi-table entity/time/feature resolution.
 */
export function detectGovernanceConflicts(
  entityColumn: string | null,
  timeColumn: string | null,
  features: string[],
  layout: MultiTableResolution,
  adapter: DomainAdapter = EMPTY_ADAPTER,
): GovernanceConflict[] {
  const conflicts: GovernanceConflict[] = [];
  const classMap = new Map(layout.classifications.map(c => [normalize(c.table_name), c]));

  // 1. Entity from dimension when fact exists
  if (entityColumn && layout.primary_table) {
    const entityTable = extractTableName(entityColumn);
    if (entityTable) {
      const entityClass = classMap.get(normalize(entityTable));
      if (entityClass && entityClass.role === "dimension") {
        conflicts.push({
          code: "DIMENSION_ENTITY_CONFLICT",
          severity: "warn",
          message: `Entity "${entityColumn}" comes from dimension table "${entityTable}", but fact table "${layout.primary_table}" exists.`,
          suggestion: `Consider using an entity column from the primary fact table "${layout.primary_table}".`,
        });
      }
    }
  }

  // 2. Time from dimension when fact has operational dates
  if (timeColumn && layout.primary_table) {
    const timeTable = extractTableName(timeColumn);
    if (timeTable) {
      const timeClass = classMap.get(normalize(timeTable));
      if (timeClass && (timeClass.role === "dimension" || timeClass.role === "lookup_temporal")) {
        conflicts.push({
          code: "DIMENSION_TIME_CONFLICT",
          severity: "warn",
          message: `Time anchor "${timeColumn}" comes from dimension/calendar table "${timeTable}".`,
          suggestion: `Prefer an operational date from the fact table "${layout.primary_table}".`,
        });
      }
    }
  }

  // 3. Admin ID features
  for (const feat of features) {
    const block = checkColumnBlock(feat, "feature", null, adapter);
    if (block.blocked && block.severity === "hard") {
      conflicts.push({
        code: "ADMIN_ID_FEATURE_BLOCK",
        severity: "block",
        message: `Feature "${feat}" is a blocked administrative ID: ${block.reason}`,
        suggestion: `Remove "${feat}" from feature set.`,
      });
    }
  }

  // 4. Calendar dominating over fact
  if (timeColumn && layout.primary_table) {
    const timeTable = extractTableName(timeColumn);
    if (timeTable && isCalendarTable(normalize(timeTable))) {
      // Check if fact table has date columns
      const factClass = layout.classifications.find(c => c.table_name === layout.primary_table);
      if (factClass && factClass.signals.some(s => s.signal.includes("date") || s.signal.includes("operational"))) {
        conflicts.push({
          code: "CALENDAR_OVERPRIMARY_CONFLICT",
          severity: "warn",
          message: `Calendar table "${timeTable}" is primary time source, but fact table "${layout.primary_table}" has operational dates.`,
          suggestion: `Use operational date from fact table instead of calendar dimension.`,
        });
      }
    }
  }

  return conflicts;
}

// ═══════════════════════════════════════════════════════════════════
// Scoring Integration Helpers (for TDE/PRE)
// ═══════════════════════════════════════════════════════════════════

/**
 * Get entity scoring adjustment based on multi-table position.
 */
export function getEntityTableAdjustment(
  columnName: string,
  layout: MultiTableResolution,
): { adjustment: number; reason: string } {
  const tableName = extractTableName(columnName);
  if (!tableName || !layout.primary_table) return { adjustment: 0, reason: "" };

  const classification = layout.classifications.find(c => normalize(c.table_name) === normalize(tableName));
  if (!classification) return { adjustment: 0, reason: "" };

  if (classification.role === "fact") {
    return { adjustment: +3, reason: "Entity from fact table — operational priority" };
  }
  if (classification.role === "dimension" || classification.role === "lookup_temporal") {
    return { adjustment: -4, reason: "Entity from dimension — should not be primary" };
  }
  return { adjustment: 0, reason: "" };
}

/**
 * Get time scoring adjustment based on multi-table position.
 */
export function getTimeTableAdjustment(
  columnName: string,
  layout: MultiTableResolution,
): { adjustment: number; reason: string } {
  const tableName = extractTableName(columnName);
  if (!tableName || !layout.primary_table) return { adjustment: 0, reason: "" };

  const classification = layout.classifications.find(c => normalize(c.table_name) === normalize(tableName));
  if (!classification) return { adjustment: 0, reason: "" };

  if (classification.role === "fact") {
    return { adjustment: +4, reason: "Date from fact table — operational anchor" };
  }
  if (classification.role === "dimension") {
    return { adjustment: -5, reason: "Date from dimension — not primary anchor" };
  }
  if (classification.role === "lookup_temporal") {
    return { adjustment: -3, reason: "Date from calendar — auxiliary only" };
  }
  return { adjustment: 0, reason: "" };
}

// ═══════════════════════════════════════════════════════════════════
// Utility functions
// ═══════════════════════════════════════════════════════════════════

export function normalize(text: string): string {
  return (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

export function extractTableName(columnName: string): string | null {
  return columnName.includes(".") ? columnName.split(".")[0] : null;
}

export function extractColumnPart(columnName: string): string {
  return columnName.includes(".") ? columnName.split(".").pop()! : columnName;
}

function isCalendarTable(name: string): boolean {
  const lo = normalize(name);
  return ["calendario", "calendar", "dimdate", "dimcalendar", "dim_date", "dim_calendar"].some(t => lo.includes(t));
}

function isNumericType(t: string): boolean {
  const lo = (t || "").toLowerCase();
  return ["numeric", "numérico", "integer", "inteiro", "float", "number", "decimal", "double"].some(k => lo.includes(k));
}

function isDateType(t: string): boolean {
  const lo = (t || "").toLowerCase();
  return ["date", "datetime", "timestamp", "temporal", "data"].some(k => lo.includes(k));
}

function isTextType(t: string): boolean {
  const lo = (t || "").toLowerCase();
  return ["text", "string", "varchar", "char", "categórico", "categorical", "texto"].some(k => lo.includes(k));
}

function isDateLikeName(name: string): boolean {
  const lo = normalize(name);
  return ["data_", "dt_", "date_", "datmov", "created_at", "updated_at"].some(t => lo.includes(t));
}
