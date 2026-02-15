// ═══════════════════════════════════════════════════════════════════
// Leakage Guard v1 — Deterministic leakage detection policy
// ═══════════════════════════════════════════════════════════════════

export interface LeakageResult {
  allowed_features: string[];
  removed_features: { column: string; reason: string; source: string }[];
  reasons: string[];
}

// Keywords that indicate direct target leakage
const TARGET_LEAKAGE_KEYWORDS = [
  "target", "label", "churn", "cancel", "outcome", "death",
  "dt_obito", "discharge", "status_final", "final_status",
  "resultado", "y_true", "y_pred", "output_final", "aprovado",
  "cancelado", "obito", "alta", "saida",
];

// Temporal columns that are likely post-event (leakage)
const POST_EVENT_TEMPORAL_KEYWORDS = [
  "updated_at", "finished_at", "end_date", "closed_at",
  "completed_at", "dt_saida", "dt_resultado", "data_fim",
  "data_saida", "dt_alta", "dt_obito", "resolved_at",
  "modified_at", "dt_finalizacao",
];

// Technical ID patterns (high cardinality = no predictive value)
const ID_PATTERNS = /^(id|_id|codigo|cod_|numero|num_|chave|key|uuid|pk|fk|idx|index)/i;
const ID_SUFFIX = /(_id|_key|_code|_cod|_numero|_num|_uuid)$/i;

/**
 * Applies leakage guard policy to a list of features.
 * 
 * Sources:
 * 1. domain_adapter.leakage_watchlist
 * 2. Heuristic by name (target/leakage keywords)
 * 3. Temporal heuristic (post-event columns)
 * 4. High cardinality IDs (not entity_key)
 */
export function applyLeakagePolicy(
  featureNames: string[],
  options: {
    targetColumn: string;
    entityKeyColumn?: string | null;
    timeAnchorColumn?: string | null;
    adapterWatchlist?: string[];
    columnStats?: Map<string, { distinct_count?: number; total_rows?: number; type?: string }>;
  }
): LeakageResult {
  const {
    targetColumn,
    entityKeyColumn,
    timeAnchorColumn,
    adapterWatchlist = [],
    columnStats,
  } = options;

  const removed: LeakageResult["removed_features"] = [];
  const allowed: string[] = [];
  const reasons: string[] = [];

  const watchlistSet = new Set(adapterWatchlist.map(w => w.toLowerCase()));

  for (const col of featureNames) {
    // Never include the target itself
    if (col === targetColumn) continue;

    const colLower = col.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let isRemoved = false;

    // 1. Adapter watchlist
    if (watchlistSet.has(colLower)) {
      removed.push({ column: col, reason: `Coluna na watchlist do adaptador de domínio`, source: "adapter_watchlist" });
      isRemoved = true;
    }

    // 2. Target/leakage keyword heuristic
    if (!isRemoved) {
      for (const kw of TARGET_LEAKAGE_KEYWORDS) {
        if (colLower.includes(kw) && col !== targetColumn) {
          removed.push({ column: col, reason: `Nome contém "${kw}" — possível vazamento do target`, source: "keyword_heuristic" });
          isRemoved = true;
          break;
        }
      }
    }

    // 3. Post-event temporal columns
    if (!isRemoved && timeAnchorColumn) {
      for (const kw of POST_EVENT_TEMPORAL_KEYWORDS) {
        if (colLower === kw || colLower.endsWith(`_${kw}`) || colLower.startsWith(`${kw}_`)) {
          removed.push({ column: col, reason: `Coluna temporal pós-evento (suspeita de leakage)`, source: "temporal_heuristic" });
          isRemoved = true;
          break;
        }
      }
    }

    // 4. High cardinality IDs (not entity_key)
    if (!isRemoved && col !== entityKeyColumn && columnStats) {
      const stats = columnStats.get(col);
      if (stats && stats.total_rows && stats.distinct_count) {
        const uniqueRatio = stats.distinct_count / stats.total_rows;
        const isIdName = ID_PATTERNS.test(colLower) || ID_SUFFIX.test(colLower);
        if (isIdName && uniqueRatio > 0.5) {
          removed.push({ column: col, reason: `ID técnico com alta cardinalidade (${stats.distinct_count} únicos, ${(uniqueRatio * 100).toFixed(0)}%)`, source: "id_cardinality" });
          isRemoved = true;
        }
      }
    }

    if (!isRemoved) {
      allowed.push(col);
    }
  }

  if (removed.length > 0) {
    reasons.push(`Removidas ${removed.length} colunas por risco de vazamento de dados.`);
    const bySrc = removed.reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    for (const [src, count] of Object.entries(bySrc)) {
      reasons.push(`  • ${src}: ${count} coluna(s)`);
    }
  }

  return { allowed_features: allowed, removed_features: removed, reasons };
}
