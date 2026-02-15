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

interface PreviewStats {
  total_rows_sampled: number;
  entity_count: number;
  positive_rate: number;
  distinct_target_values: number;
  top_class_pct: number;
  per_period_distribution: { period: string; positives: number; total: number; positive_rate: number }[];
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
};

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

  // Get entity cardinality
  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || 0;

  // For simulation, we estimate churn rate based on heuristics
  // In a real implementation, this would query the actual data
  // For now, estimate: ~20-30% churn rate at 90 days is typical retail
  const estimatedChurnRate = windowDays <= 30 ? 0.10 : windowDays <= 60 ? 0.20 : windowDays <= 90 ? 0.25 : 0.35;

  notes.push(`Simulação baseada em heurística para janela de ${windowDays} dias.`);
  notes.push(`Entidades únicas: ${entityCount || "desconhecido"}`);
  if (!entityKey) notes.push("⚠️ Sem entity_key — contagem por linha, não por cliente.");
  if (!timeAnchor) notes.push("⚠️ Sem âncora temporal — churn não pode ser calculado com precisão.");

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: entityCount || totalRows,
      positive_rate: estimatedChurnRate,
      distinct_target_values: 2,
      top_class_pct: 1 - estimatedChurnRate,
      per_period_distribution: [],
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
  eventCandidates: string[],
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[]; statusColumn: string | null } {
  const notes: string[] = [];
  const positiveValues: string[] = params.positive_values || ["no_show", "missed", "faltou", "No-Show", "ausente"];
  let statusColumn = params.status_column || null;

  // Find status column from event candidates
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

  // Estimate positive rate from top_categories if available
  let positiveRate = 0.15; // Default estimate
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
    statusColumn,
  };
}

function simulateAdesaoHealth(
  catStats: CategoricalStat[],
  _numStats: NumericStat[],
  totalRows: number,
  entityKey: string | null,
  _timeAnchor: string | null,
  params: Record<string, any>,
): { preview: PreviewStats; notes: string[] } {
  const notes: string[] = [];
  const windowDays = params.window_days || 60;

  const entityStat = entityKey ? catStats.find(c => c.column_name === entityKey) : null;
  const entityCount = entityStat?.distinct_count || 0;

  // Estimate dropout rate
  const estimatedDropoutRate = windowDays <= 30 ? 0.08 : windowDays <= 60 ? 0.15 : 0.22;

  notes.push(`Simulação de abandono com gap > ${windowDays} dias.`);
  notes.push(`Pacientes únicos: ${entityCount || "desconhecido"}`);

  return {
    preview: {
      total_rows_sampled: Math.min(totalRows, 50000),
      entity_count: entityCount || totalRows,
      positive_rate: estimatedDropoutRate,
      distinct_target_values: 2,
      top_class_pct: 1 - estimatedDropoutRate,
      per_period_distribution: [],
      notes,
    },
    notes,
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

    const [catStatsRes, numStatsRes, aiContextRes, dsStateRes, selectionRes] = await Promise.all([
      supabase.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", project_id),
      supabase.from("project_numeric_stats").select("column_name, null_count, min_value, max_value, mean_value").eq("project_id", project_id),
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count, active_dataset_ref, manifest_id").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle(),
    ]);

    const catStats: CategoricalStat[] = (catStatsRes.data || []) as CategoricalStat[];
    const numStats: NumericStat[] = (numStatsRes.data || []) as NumericStat[];
    const totalRows = dsStateRes.data?.row_count || 0;
    const currentSelectionVersion = selection_version || (selectionRes.data as any)?.selection_version || 1;

    if (totalRows === 0) {
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

    // Apply default window_days from intent if not provided
    const effectiveParams = {
      ...params,
      window_days: params.window_days || defaultWindowDays,
    };

    console.log(`[preview-target-template] entityKey=${entityKey}, timeAnchor=${timeAnchor}, events=${eventCandidates.length}`);

    // ─── Pre-flight gates ────────────────────────────────────

    const gates: GateResult[] = [];

    // Entity key gate
    if (templateConfig.requires_entity_key && !entityKey) {
      gates.push({
        gate: "ENTITY_KEY_REQUIRED",
        status: "BLOCK",
        message: "Precisamos da coluna que identifica o cliente/paciente (ID).",
        details: "Selecione a coluna de entidade no Step 3 (EDA) ou configure manualmente.",
      });
    }

    // Time anchor gate
    if (templateConfig.requires_time_anchor && !timeAnchor) {
      gates.push({
        gate: "TIME_ANCHOR_REQUIRED",
        status: "BLOCK",
        message: "Precisamos de uma coluna de data para calcular o target na janela temporal.",
        details: "Selecione a coluna de data no Step 3 (EDA) ou configure manualmente.",
      });
    }

    // Event column gate
    if (templateConfig.requires_event_column && eventCandidates.length === 0) {
      gates.push({
        gate: "EVENT_COLUMN_REQUIRED",
        status: "BLOCK",
        message: "Nenhuma coluna de evento/status encontrada no dataset.",
        details: "O template requer uma coluna com valores de status (ex: no_show, missed). Verifique seus dados.",
      });
    }

    // If any BLOCK gate, return early
    const hasBlock = gates.some(g => g.status === "BLOCK");
    if (hasBlock) {
      // Still persist as 'blocked'
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
      case "churn_retail": {
        const result = simulateChurnRetail(catStats, numStats, totalRows, entityKey, timeAnchor, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        break;
      }
      case "no_show_health": {
        const result = simulateNoShowHealth(catStats, numStats, totalRows, entityKey, eventCandidates, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
        // Auto-fill status_column if found
        if (result.statusColumn && !params.status_column) {
          effectiveParams.status_column = result.statusColumn;
        }
        break;
      }
      case "adesao_tratamento_health": {
        const result = simulateAdesaoHealth(catStats, numStats, totalRows, entityKey, timeAnchor, effectiveParams);
        preview = result.preview;
        extraNotes = result.notes;
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

    console.log(`[preview-target-template] Done: status=${builderStatus}, positive_rate=${preview.positive_rate}, entities=${preview.entity_count}`);

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
    // Check if exists
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
