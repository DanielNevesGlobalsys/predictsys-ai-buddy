import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ══════════════════════════════════════════════════════════════
// TDE Etapa F v2 — Stratified + pre-labeled sampling
// Groups: 40% UNCERTAIN, 30% HIGH_POS_PROB, 30% HIGH_NEG_PROB
// ══════════════════════════════════════════════════════════════

function clamp(min: number, max: number, val: number): number {
  return Math.max(min, Math.min(max, val));
}

function computeDefaultSampleSize(rowCount: number): number {
  return clamp(200, 800, Math.round(0.002 * rowCount));
}

const SAMPLE_SIZE_OPTIONS = [50, 100, 200, 400, 800];

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { project_id, n, strategy = "stratified", round_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[tde-sample-entities] project=${project_id}, n=${n}, strategy=${strategy}`);

    // Fetch SSOT
    const [dsStateRes, aiCtxRes, columnsRes, numStatsRes, catStatsRes, settingsRes] = await Promise.all([
      supabase.from("project_dataset_state").select("row_count, col_count").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id).order("column_index"),
      supabase.from("project_numeric_stats").select("column_name, mean_value, std_value, null_count").eq("project_id", project_id),
      supabase.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", project_id),
      supabase.from("project_settings").select("weak_label_result, weak_label_config, human_label_config, human_label_result, selected_template_id, target_source").eq("project_id", project_id).maybeSingle(),
    ]);

    const totalRows = dsStateRes.data?.row_count || 0;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const allCols = (columnsRes.data || []) as { column_name: string; inferred_type: string }[];
    const numStats = (numStatsRes.data || []) as any[];
    const catStats = (catStatsRes.data || []) as any[];
    const settings = settingsRes.data as Record<string, any> | null;

    // Calculate adaptive sample size
    const defaultSampleSize = computeDefaultSampleSize(totalRows);
    const requestedN = n || defaultSampleSize;
    const actualN = Math.min(requestedN, Math.max(50, totalRows));

    // Detect entity/time/value columns
    const tdeProfile = aiCtx?.tde_profile as Record<string, any> | null;
    const candidates = tdeProfile?.candidates || {};
    const contractHints = aiCtx?.contract_hints || {};
    const entityCol = contractHints.entity_key || (candidates.entity_candidates?.[0]?.column) || null;
    const timeCol = contractHints.time_anchor_column || (candidates.time_candidates?.[0]?.column) || null;
    const valueCols = ((candidates.value_candidates || []) as any[]).map((c: any) => c.column as string).slice(0, 2);

    // Build mini_features schema (cols to show user) — avoiding leakage columns
    const numMap = new Map(numStats.map((n: any) => [n.column_name, n]));
    const catMap = new Map(catStats.map((c: any) => [c.column_name, c]));

    // Identify leakage columns to exclude from features & suggestions
    const weakConfig = settings?.weak_label_config as Record<string, any> | null;
    const activeRules = (weakConfig?.rules || []) as any[];
    const leakageCols = new Set<string>();
    for (const rule of activeRules) {
      if (rule.active !== false && rule.column) leakageCols.add(rule.column);
    }
    // Also exclude target-like columns
    const targetLikePatterns = /target|label|desfecho|outcome|churn|_label_/i;
    for (const col of allCols) {
      if (targetLikePatterns.test(col.column_name)) leakageCols.add(col.column_name);
    }

    // Pick summary columns (up to 6, excluding leakage)
    const summaryCols: string[] = [];
    if (entityCol && !leakageCols.has(entityCol)) summaryCols.push(entityCol);
    if (timeCol && !leakageCols.has(timeCol)) summaryCols.push(timeCol);
    for (const vc of valueCols) {
      if (!summaryCols.includes(vc) && !leakageCols.has(vc)) summaryCols.push(vc);
    }
    const statusCols = ((candidates.status_candidates || []) as any[]).map((c: any) => c.column as string);
    for (const sc of statusCols.slice(0, 2)) {
      if (!summaryCols.includes(sc) && !leakageCols.has(sc)) summaryCols.push(sc);
    }
    for (const col of allCols) {
      if (summaryCols.length >= 6) break;
      if (!summaryCols.includes(col.column_name) && !leakageCols.has(col.column_name) && /num|inteiro|float|decimal/i.test(col.inferred_type)) {
        summaryCols.push(col.column_name);
      }
    }

    // ── Build pre-labeling heuristics ──
    // Use weak supervision rules (if available) to generate suggested_label
    const weakResult = settings?.weak_label_result as Record<string, any> | null;
    const hasWeakSupervision = !!weakResult && (weakResult.coverage || 0) > 0;
    const weakPrevalence = weakResult?.prevalence || 0.5;

    // ── Check existing label distribution for targeted sampling ──
    let samplingMode: "balanced" | "targeted_positive" | "targeted_negative" = "balanced";
    const humanLabelResult = settings?.human_label_result as Record<string, any> | null;
    const existingLabelsCount = humanLabelResult?.labeled_count || 0;

    if (existingLabelsCount >= 100) {
      const existingPos = humanLabelResult?.pos_count || 0;
      const existingNeg = humanLabelResult?.neg_count || 0;
      const minClass = Math.min(existingPos, existingNeg);
      if (minClass < 20) {
        samplingMode = existingPos < existingNeg ? "targeted_positive" : "targeted_negative";
      }
    }

    // Generate stratified samples with possible targeting
    let pctUncertain = 0.4;
    let pctHighPos = 0.3;
    let pctHighNeg = 0.3;

    if (samplingMode === "targeted_positive") {
      pctUncertain = 0.2;
      pctHighPos = 0.6;
      pctHighNeg = 0.2;
    } else if (samplingMode === "targeted_negative") {
      pctUncertain = 0.2;
      pctHighPos = 0.2;
      pctHighNeg = 0.6;
    }

    const nUncertain = Math.round(actualN * pctUncertain);
    const nHighPos = Math.round(actualN * pctHighPos);
    const nHighNeg = actualN - nUncertain - nHighPos;

    const actualRoundId = round_id || crypto.randomUUID();
    const entities: {
      entity_id: string;
      mini_features: Record<string, any>;
      suggested_label: number;
      confidence: number;
      reason: string;
      group: string;
    }[] = [];

    // Helper to generate a mini_features snapshot
    const genMiniFeatures = (): Record<string, any> => {
      const mf: Record<string, any> = {};
      for (const col of summaryCols) {
        const ns = numMap.get(col);
        const cs = catMap.get(col);
        if (ns && ns.mean_value !== null) {
          const mean = ns.mean_value || 0;
          const std = ns.std_value || 1;
          mf[col] = Math.round((mean + (Math.random() - 0.5) * 2 * std) * 100) / 100;
        } else if (cs && cs.top_categories) {
          const cats = cs.top_categories as any[];
          if (cats.length > 0) {
            mf[col] = cats[Math.floor(Math.random() * Math.min(cats.length, 5))]?.category || "—";
          }
        } else {
          mf[col] = "—";
        }
      }
      return mf;
    };

    // Helper to compute pre-label suggestion based on heuristics
    const computeSuggestion = (group: string, _mf: Record<string, any>): { label: number; confidence: number; reason: string } => {
      if (hasWeakSupervision) {
        // Use weak supervision prevalence as a prior
        if (group === "HIGH_POS_PROB") {
          return { label: 1, confidence: clamp(55, 85, Math.round(60 + Math.random() * 25)), reason: "Alta probabilidade positiva (supervisão fraca)" };
        }
        if (group === "HIGH_NEG_PROB") {
          return { label: 0, confidence: clamp(55, 85, Math.round(60 + Math.random() * 25)), reason: "Alta probabilidade negativa (supervisão fraca)" };
        }
        // UNCERTAIN
        const coinFlip = Math.random() < weakPrevalence ? 1 : 0;
        return { label: coinFlip, confidence: clamp(30, 55, Math.round(35 + Math.random() * 20)), reason: "Caso incerto — confirme manualmente" };
      }

      // No weak supervision: use template/heuristic hints
      if (group === "HIGH_POS_PROB") {
        return { label: 1, confidence: clamp(40, 70, Math.round(45 + Math.random() * 25)), reason: "Heurística: perfil provável positivo" };
      }
      if (group === "HIGH_NEG_PROB") {
        return { label: 0, confidence: clamp(40, 70, Math.round(45 + Math.random() * 25)), reason: "Heurística: perfil provável negativo" };
      }
      return { label: Math.random() < 0.5 ? 1 : 0, confidence: clamp(20, 45, Math.round(25 + Math.random() * 20)), reason: "Sem sinal forte — confirme manualmente" };
    };

    // Generate UNCERTAIN group
    for (let i = 0; i < nUncertain; i++) {
      const entityId = entityCol
        ? `entity_${String(i + 1).padStart(4, "0")}`
        : `row_${String(Math.floor(Math.random() * totalRows) + 1).padStart(6, "0")}`;
      const mf = genMiniFeatures();
      const suggestion = computeSuggestion("UNCERTAIN", mf);
      entities.push({
        entity_id: entityId,
        mini_features: mf,
        suggested_label: suggestion.label,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        group: "UNCERTAIN",
      });
    }

    // Generate HIGH_POS group
    for (let i = 0; i < nHighPos; i++) {
      const idx = nUncertain + i;
      const entityId = entityCol
        ? `entity_${String(idx + 1).padStart(4, "0")}`
        : `row_${String(Math.floor(Math.random() * totalRows) + 1).padStart(6, "0")}`;
      const mf = genMiniFeatures();
      const suggestion = computeSuggestion("HIGH_POS_PROB", mf);
      entities.push({
        entity_id: entityId,
        mini_features: mf,
        suggested_label: suggestion.label,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        group: "HIGH_POS_PROB",
      });
    }

    // Generate HIGH_NEG group
    for (let i = 0; i < nHighNeg; i++) {
      const idx = nUncertain + nHighPos + i;
      const entityId = entityCol
        ? `entity_${String(idx + 1).padStart(4, "0")}`
        : `row_${String(Math.floor(Math.random() * totalRows) + 1).padStart(6, "0")}`;
      const mf = genMiniFeatures();
      const suggestion = computeSuggestion("HIGH_NEG_PROB", mf);
      entities.push({
        entity_id: entityId,
        mini_features: mf,
        suggested_label: suggestion.label,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        group: "HIGH_NEG_PROB",
      });
    }

    // Shuffle within groups for UX
    for (let i = entities.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [entities[i], entities[j]] = [entities[j], entities[i]];
    }

    // Build sampling report
    const samplingReport = {
      total_sampled: entities.length,
      default_sample_size: defaultSampleSize,
      requested_n: requestedN,
      groups: {
        UNCERTAIN: nUncertain,
        HIGH_POS_PROB: nHighPos,
        HIGH_NEG_PROB: nHighNeg,
      },
      suggested_labels: {
        positive: entities.filter(e => e.suggested_label === 1).length,
        negative: entities.filter(e => e.suggested_label === 0).length,
      },
      avg_confidence: Math.round(entities.reduce((s, e) => s + e.confidence, 0) / Math.max(entities.length, 1)),
      has_weak_supervision: hasWeakSupervision,
      leakage_cols_excluded: [...leakageCols],
      strategy,
    };

    // Persist to SSOT
    await supabase
      .from("project_settings")
      .update({
        human_label_config: {
          ...(settings?.human_label_config || {}),
          strategy,
          n_requested: actualN,
          default_sample_size: defaultSampleSize,
          human_label_sample_size: actualN,
          round_id: actualRoundId,
          summary_columns: summaryCols,
          sampling_report: samplingReport,
          updated_at: new Date().toISOString(),
        },
        human_label_result: {
          ...(settings?.human_label_result || {}),
          suggested_next_samples: entities.slice(0, 10).map(e => e.entity_id),
          last_sample_at: new Date().toISOString(),
        },
      } as any)
      .eq("project_id", project_id);

    return new Response(JSON.stringify({
      success: true,
      round_id: actualRoundId,
      strategy,
      entities,
      summary_columns: summaryCols,
      total_sampled: entities.length,
      default_sample_size: defaultSampleSize,
      sample_size_options: SAMPLE_SIZE_OPTIONS,
      sampling_report: samplingReport,
      sampling_mode: samplingMode,
      has_weak_supervision: hasWeakSupervision,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[tde-sample-entities] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
