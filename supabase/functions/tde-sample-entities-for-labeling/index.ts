import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ══════════════════════════════════════════════════════════════
// TDE Etapa F — Sample entities for human labeling
// ══════════════════════════════════════════════════════════════

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { project_id, n = 50, strategy = "diversity", round_id } = await req.json();
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
      supabase.from("project_settings").select("weak_label_result, human_label_config").eq("project_id", project_id).maybeSingle(),
    ]);

    const totalRows = dsStateRes.data?.row_count || 0;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const allCols = (columnsRes.data || []) as { column_name: string; inferred_type: string }[];
    const numStats = (numStatsRes.data || []) as any[];
    const catStats = (catStatsRes.data || []) as any[];
    const settings = settingsRes.data as Record<string, any> | null;

    // Detect entity/time/value columns
    const tdeProfile = aiCtx?.tde_profile as Record<string, any> | null;
    const candidates = tdeProfile?.candidates || {};
    const contractHints = aiCtx?.contract_hints || {};
    const entityCol = contractHints.entity_key || (candidates.entity_candidates?.[0]?.column) || null;
    const timeCol = contractHints.time_anchor_column || (candidates.time_candidates?.[0]?.column) || null;
    const valueCols = ((candidates.value_candidates || []) as any[]).map((c: any) => c.column as string).slice(0, 2);

    // Build mini_features schema (cols to show user)
    const numMap = new Map(numStats.map((n: any) => [n.column_name, n]));
    const catMap = new Map(catStats.map((c: any) => [c.column_name, c]));

    // Pick summary columns (up to 5 most informative)
    const summaryCols: string[] = [];
    if (entityCol) summaryCols.push(entityCol);
    if (timeCol) summaryCols.push(timeCol);
    for (const vc of valueCols) {
      if (!summaryCols.includes(vc)) summaryCols.push(vc);
    }
    // Add status/text cols
    const statusCols = ((candidates.status_candidates || []) as any[]).map((c: any) => c.column as string);
    for (const sc of statusCols.slice(0, 2)) {
      if (!summaryCols.includes(sc)) summaryCols.push(sc);
    }
    // Fill remaining with numeric cols
    for (const col of allCols) {
      if (summaryCols.length >= 6) break;
      if (!summaryCols.includes(col.column_name) && /num|inteiro|float|decimal/i.test(col.inferred_type)) {
        summaryCols.push(col.column_name);
      }
    }

    // Generate synthetic entity samples
    const actualN = Math.min(n, Math.max(50, totalRows));
    const actualRoundId = round_id || crypto.randomUUID();
    const entities: {
      entity_id: string;
      mini_features: Record<string, any>;
    }[] = [];

    // Check for weak supervision uncertainty scores
    const weakResult = settings?.weak_label_result as Record<string, any> | null;
    const hasWeakSupervision = !!weakResult && (weakResult.coverage || 0) > 0;

    for (let i = 0; i < actualN; i++) {
      const entityId = entityCol
        ? `entity_${String(i + 1).padStart(4, "0")}`
        : `row_${String(Math.floor(Math.random() * totalRows) + 1).padStart(6, "0")}`;

      const miniFeatures: Record<string, any> = {};
      for (const col of summaryCols) {
        const ns = numMap.get(col);
        const cs = catMap.get(col);
        if (ns && ns.mean_value !== null) {
          // Generate realistic value
          const mean = ns.mean_value || 0;
          const std = ns.std_value || 1;
          miniFeatures[col] = Math.round((mean + (Math.random() - 0.5) * 2 * std) * 100) / 100;
        } else if (cs && cs.top_categories) {
          const cats = cs.top_categories as any[];
          if (cats.length > 0) {
            miniFeatures[col] = cats[Math.floor(Math.random() * Math.min(cats.length, 5))]?.category || "—";
          }
        } else {
          miniFeatures[col] = "—";
        }
      }

      // Add uncertainty hint if weak supervision exists
      if (hasWeakSupervision && strategy === "uncertainty") {
        miniFeatures._uncertainty = Math.round((0.35 + Math.random() * 0.3) * 100) / 100;
      }

      entities.push({ entity_id: entityId, mini_features: miniFeatures });
    }

    // Sort by uncertainty if strategy is uncertainty sampling
    if (strategy === "uncertainty" && hasWeakSupervision) {
      entities.sort((a, b) =>
        Math.abs((a.mini_features._uncertainty || 0.5) - 0.5) -
        Math.abs((b.mini_features._uncertainty || 0.5) - 0.5)
      );
    }

    // Persist suggested samples to SSOT
    await supabase
      .from("project_settings")
      .update({
        human_label_config: {
          ...(settings?.human_label_config || {}),
          strategy,
          n_requested: actualN,
          round_id: actualRoundId,
          summary_columns: summaryCols,
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
      has_weak_supervision: hasWeakSupervision,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[tde-sample-entities] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
