import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ══════════════════════════════════════════════════════════════
// TDE Etapa E — Weak Supervision / Multi-Rule Labeling Engine
// ══════════════════════════════════════════════════════════════

interface LFResult {
  lf_id: string;
  lf_name: string;
  vote: 0 | 1 | -1; // -1 = abstain
  strength: number;   // 0-1
  reason: string;
}

interface WeakLabelConfig {
  rules: { lf_id: string; enabled: boolean; weight: number; params: Record<string, any> }[];
  threshold: number;
  min_coverage: number;
  created_at: string;
}

interface WeakLabelResult {
  prevalence: number;
  coverage: number;
  agreement_rate: number;
  conflict_rate: number;
  abstain_rate: number;
  avg_confidence: number;
  top_rules: { lf_id: string; lf_name: string; fire_rate: number; positive_rate: number }[];
  sample_reasons: string[];
  total_rows: number;
  labeled_rows: number;
  positive_count: number;
  leakage_source_columns: string[];
  created_at: string;
}

// ── Label Functions ─────────────────────────────────────────

function normalizeCol(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function createLFs(
  signals: {
    hasEntity: boolean;
    hasTime: boolean;
    hasValue: boolean;
    hasStatus: boolean;
    entityCol: string | null;
    timeCol: string | null;
    valueCols: string[];
    statusCols: string[];
    textCols: string[];
    allColumns: { name: string; type: string; distinct_count?: number; mean?: number; std?: number; null_pct?: number }[];
  },
  config?: WeakLabelConfig,
): { lf_id: string; lf_name: string; description: string; requires: string[]; source_columns: string[]; weight: number; enabled: boolean }[] {
  const lfs: ReturnType<typeof createLFs> = [];
  const enabledMap = new Map<string, { enabled: boolean; weight: number }>();
  if (config?.rules) {
    for (const r of config.rules) enabledMap.set(r.lf_id, { enabled: r.enabled, weight: r.weight });
  }

  const addLF = (id: string, name: string, desc: string, requires: string[], sourceCols: string[], defaultWeight = 1.0) => {
    const cfg = enabledMap.get(id);
    lfs.push({
      lf_id: id,
      lf_name: name,
      description: desc,
      requires,
      source_columns: sourceCols,
      weight: cfg?.weight ?? defaultWeight,
      enabled: cfg?.enabled ?? true,
    });
  };

  // LF_inactivity: sem evento após t0 por window_days
  if (signals.hasEntity && signals.hasTime) {
    addLF("lf_inactivity", "Inatividade", "Sem evento recente no período de observação", ["entity", "time"], [signals.timeCol!, signals.entityCol!], 1.2);
  }

  // LF_drop_activity: queda > drop_pct vs baseline
  if (signals.hasEntity && signals.hasTime) {
    addLF("lf_drop_activity", "Queda de atividade", "Redução significativa na frequência de eventos", ["entity", "time"], [signals.timeCol!, signals.entityCol!], 1.0);
  }

  // LF_missingness_spike: aumento abrupto de missing em campos chave
  if (signals.hasEntity) {
    const highNullCols = signals.allColumns.filter(c => (c.null_pct || 0) > 20 && (c.null_pct || 0) < 80).slice(0, 3);
    if (highNullCols.length > 0) {
      addLF("lf_missingness_spike", "Spike de dados faltantes", "Aumento abrupto de campos vazios em variáveis-chave", ["entity"], highNullCols.map(c => c.name), 0.6);
    }
  }

  // LF_status_cancel: status contém tokens
  for (const sc of signals.statusCols) {
    addLF(`lf_status_cancel_${normalizeCol(sc)}`, `Status negativo (${sc})`, `Coluna "${sc}" contém indicadores de cancelamento/inatividade`, ["status"], [sc], 1.3);
  }

  // LF_text_cancel: texto contém tokens
  for (const tc of signals.textCols.slice(0, 2)) {
    addLF(`lf_text_cancel_${normalizeCol(tc)}`, `Texto negativo (${tc})`, `Coluna "${tc}" contém termos de cancelamento/fraude`, ["text"], [tc], 0.8);
  }

  // LF_overdue: atraso > N dias (financial signals)
  const overdueCols = signals.allColumns.filter(c => /atraso|overdue|dias_atraso|days_late|vencid/i.test(normalizeCol(c.name)));
  for (const oc of overdueCols.slice(0, 2)) {
    addLF(`lf_overdue_${normalizeCol(oc.name)}`, `Atraso (${oc.name})`, `Coluna "${oc.name}" indica atraso/inadimplência`, ["value"], [oc.name], 1.1);
  }

  // LF_chargeback
  const chargebackCols = signals.allColumns.filter(c => /chargeback|estorno|devol|refund/i.test(normalizeCol(c.name)));
  for (const cc of chargebackCols.slice(0, 1)) {
    addLF(`lf_chargeback_${normalizeCol(cc.name)}`, `Estorno/Chargeback (${cc.name})`, `Coluna "${cc.name}" indica estorno ou devolução`, ["value"], [cc.name], 1.0);
  }

  // LF_outlier_behavior: zscore alto
  if (signals.valueCols.length > 0) {
    const vc = signals.valueCols[0];
    addLF("lf_outlier_behavior", "Comportamento atípico", `Z-score alto em "${vc}" como sinal fraco`, ["value"], [vc], 0.5);
  }

  // LF_low_value: valor muito baixo
  if (signals.valueCols.length > 0) {
    const vc = signals.valueCols[0];
    const col = signals.allColumns.find(c => c.name === vc);
    if (col && col.mean !== undefined) {
      addLF("lf_low_value", "Valor baixo", `Valor em "${vc}" muito abaixo da média`, ["value"], [vc], 0.7);
    }
  }

  return lfs;
}

// ── Simulated LF execution (runs on stats, not raw data) ────

function simulateLFExecution(
  lfId: string,
  totalRows: number,
  _signals: Record<string, any>,
): { fireRate: number; positiveRate: number } {
  // Heuristic simulation based on LF type
  if (lfId.startsWith("lf_inactivity")) return { fireRate: 0.85, positiveRate: 0.25 };
  if (lfId.startsWith("lf_drop_activity")) return { fireRate: 0.60, positiveRate: 0.35 };
  if (lfId.startsWith("lf_missingness")) return { fireRate: 0.30, positiveRate: 0.40 };
  if (lfId.startsWith("lf_status_cancel")) return { fireRate: 0.70, positiveRate: 0.20 };
  if (lfId.startsWith("lf_text_cancel")) return { fireRate: 0.40, positiveRate: 0.30 };
  if (lfId.startsWith("lf_overdue")) return { fireRate: 0.50, positiveRate: 0.45 };
  if (lfId.startsWith("lf_chargeback")) return { fireRate: 0.15, positiveRate: 0.70 };
  if (lfId === "lf_outlier_behavior") return { fireRate: 0.10, positiveRate: 0.50 };
  if (lfId === "lf_low_value") return { fireRate: 0.25, positiveRate: 0.35 };
  return { fireRate: 0.50, positiveRate: 0.30 };
}

// ══════════════════════════════════════════════════════════════

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[tde-generate-weak-label] Starting for project=${project_id}`);

    // ── Fetch SSOT ───────────────────────────────────────────
    const [settingsRes, dsStateRes, aiCtxRes, columnsRes, numStatsRes, catStatsRes] = await Promise.all([
      supabase.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id),
      supabase.from("project_numeric_stats").select("column_name, null_count, mean_value, std_value").eq("project_id", project_id),
      supabase.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", project_id),
    ]);

    const settings = settingsRes.data as Record<string, any> | null;
    const dsState = dsStateRes.data as Record<string, any> | null;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const allCols = (columnsRes.data || []) as { column_name: string; inferred_type: string }[];
    const numStats = (numStatsRes.data || []) as any[];
    const catStats = (catStatsRes.data || []) as any[];
    const totalRows = dsState?.row_count || 0;

    // Build enriched columns
    const numMap = new Map(numStats.map((n: any) => [n.column_name, n]));
    const catMap = new Map(catStats.map((c: any) => [c.column_name, c]));
    const enriched = allCols.map(c => {
      const n = numMap.get(c.column_name);
      const cat = catMap.get(c.column_name);
      return {
        name: c.column_name,
        type: c.inferred_type,
        distinct_count: cat?.distinct_count || undefined,
        mean: n?.mean_value ?? undefined,
        std: n?.std_value ?? undefined,
        null_pct: n?.null_count && totalRows > 0 ? Math.round((n.null_count / totalRows) * 100) : undefined,
      };
    });

    // Extract TDE profile signals
    const tdeProfile = aiCtx?.tde_profile as Record<string, any> | null;
    const candidates = tdeProfile?.candidates || {};
    const contractHints = aiCtx?.contract_hints || {};

    const entityCol = contractHints.entity_key || (candidates.entity_candidates?.[0]?.column) || null;
    const timeCol = contractHints.time_anchor_column || contractHints.time_anchor || (candidates.time_candidates?.[0]?.column) || null;
    const valueCols = ((candidates.value_candidates || []) as any[]).map((c: any) => c.column as string).slice(0, 3);
    const statusCols = ((candidates.status_candidates || []) as any[]).map((c: any) => c.column as string).slice(0, 3);
    
    // Detect text columns
    const textCols = enriched
      .filter(c => /text|texto|string|varchar/i.test(c.type) && (c.distinct_count || 0) > 5)
      .map(c => c.name)
      .slice(0, 2);

    const signals = {
      hasEntity: !!entityCol,
      hasTime: !!timeCol,
      hasValue: valueCols.length > 0,
      hasStatus: statusCols.length > 0,
      entityCol,
      timeCol,
      valueCols,
      statusCols,
      textCols,
      allColumns: enriched,
    };

    // Load existing config if any
    const existingConfig = settings?.weak_label_config as WeakLabelConfig | null;

    // ── Create and execute LFs ──────────────────────────────
    const lfDefs = createLFs(signals, existingConfig || undefined);
    const activeLFs = lfDefs.filter(lf => lf.enabled);

    if (activeLFs.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "Nenhuma regra ativa encontrada. O dataset não possui sinais suficientes para supervisão fraca.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Simulate execution
    const lfStats = activeLFs.map(lf => {
      const sim = simulateLFExecution(lf.lf_id, totalRows, signals);
      return { ...lf, fireRate: sim.fireRate, positiveRate: sim.positiveRate };
    });

    // ── Weighted voting aggregation ─────────────────────────
    const threshold = existingConfig?.threshold ?? 0.6;
    let totalWeightedScore = 0;
    let totalWeight = 0;
    let fireCount = 0;
    let agreeCount = 0;
    let conflictCount = 0;
    const allSourceCols = new Set<string>();

    for (const lf of lfStats) {
      for (const sc of lf.source_columns) allSourceCols.add(sc);
      
      if (lf.fireRate > 0) {
        fireCount++;
        totalWeightedScore += lf.weight * lf.positiveRate;
        totalWeight += lf.weight;
      }
    }

    const avgScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
    const predictedLabel = avgScore >= threshold ? 1 : 0;
    const confidence = Math.abs(avgScore - 0.5) * 2;

    // Estimate agreement/conflict
    const positiveVoters = lfStats.filter(lf => lf.positiveRate >= 0.5).length;
    const negativeVoters = lfStats.filter(lf => lf.positiveRate < 0.5 && lf.fireRate > 0.1).length;
    const totalVoters = positiveVoters + negativeVoters;
    const agreementRate = totalVoters > 0 ? Math.max(positiveVoters, negativeVoters) / totalVoters : 1;
    const conflictRate = totalVoters > 1 ? Math.min(positiveVoters, negativeVoters) / totalVoters : 0;
    const abstainRate = lfStats.filter(lf => lf.fireRate < 0.05).length / Math.max(lfStats.length, 1);

    // Estimate prevalence
    const prevalence = avgScore;
    const coverage = 1 - abstainRate;

    // Top rules by impact
    const topRules = lfStats
      .sort((a, b) => (b.weight * b.fireRate) - (a.weight * a.fireRate))
      .slice(0, 5)
      .map(lf => ({
        lf_id: lf.lf_id,
        lf_name: lf.lf_name,
        fire_rate: Math.round(lf.fireRate * 100) / 100,
        positive_rate: Math.round(lf.positiveRate * 100) / 100,
      }));

    // Sample reasons
    const sampleReasons = lfStats
      .filter(lf => lf.fireRate > 0.1)
      .slice(0, 5)
      .map(lf => `${lf.lf_name}: ${lf.description} (${(lf.positiveRate * 100).toFixed(0)}% positivo)`);

    const leakageSourceColumns = Array.from(allSourceCols);

    const result: WeakLabelResult = {
      prevalence: Math.round(prevalence * 1000) / 1000,
      coverage: Math.round(coverage * 1000) / 1000,
      agreement_rate: Math.round(agreementRate * 1000) / 1000,
      conflict_rate: Math.round(conflictRate * 1000) / 1000,
      abstain_rate: Math.round(abstainRate * 1000) / 1000,
      avg_confidence: Math.round(confidence * 1000) / 1000,
      top_rules: topRules,
      sample_reasons: sampleReasons,
      total_rows: totalRows,
      labeled_rows: Math.round(totalRows * coverage),
      positive_count: Math.round(totalRows * coverage * prevalence),
      leakage_source_columns: leakageSourceColumns,
      created_at: new Date().toISOString(),
    };

    // Build default config if none exists
    const configToSave: WeakLabelConfig = existingConfig || {
      rules: lfDefs.map(lf => ({ lf_id: lf.lf_id, enabled: lf.enabled, weight: lf.weight, params: {} })),
      threshold,
      min_coverage: 0.2,
      created_at: new Date().toISOString(),
    };

    // ── Persist to SSOT ─────────────────────────────────────
    await supabase
      .from("project_settings")
      .update({
        weak_label_config: configToSave,
        weak_label_result: result,
      } as any)
      .eq("project_id", project_id);

    console.log(`[tde-generate-weak-label] Done. coverage=${result.coverage}, prevalence=${result.prevalence}, rules=${activeLFs.length}, confidence=${result.avg_confidence}`);

    return new Response(JSON.stringify({
      success: true,
      result,
      config: configToSave,
      lf_definitions: lfDefs.map(lf => ({
        lf_id: lf.lf_id,
        lf_name: lf.lf_name,
        description: lf.description,
        enabled: lf.enabled,
        weight: lf.weight,
        source_columns: lf.source_columns,
      })),
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[tde-generate-weak-label] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
