import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ==================== LABEL BUILDER STRATEGIES ====================

interface LabelPlan {
  strategy: string; // "event_window" | "threshold" | "state_change" | "direct"
  source_columns: string[];
  window_days: number | null;
  condition: string; // human-readable
  output_column: string;
  output_type: "binary" | "multiclass" | "regression";
}

interface IntentContract {
  objective?: string;
  problem_type?: string;
  industry_hint?: string;
  target_behavior?: string;
  guardrails?: Record<string, any>;
}

// ==================== COLUMN ANALYSIS HELPERS ====================

function normalizeColName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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

// ==================== INTENT-BASED LABEL DETECTION ====================

function detectLabelStrategy(
  intent: IntentContract,
  columns: { name: string; type: string; distinct_count?: number; null_pct?: number }[],
  timeCols: string[],
  eventCols: string[],
): { plan: LabelPlan | null; blockedReasons: string[] } {
  const objective = (intent.objective || "").toLowerCase();
  const blockedReasons: string[] = [];

  // 1. Direct target: if there's an event column that matches the intent
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

  // 2. Churn/inadimplência/conversão patterns need time window
  const needsTimeWindow = /churn|inadimpl|convers|atrit|evas|cancel|retenc|reten/.test(objective);
  
  if (needsTimeWindow) {
    if (timeCols.length === 0) {
      blockedReasons.push("Objetivo requer janela temporal, mas nenhuma coluna de data foi detectada. Adicione uma coluna de data ao dataset.");
      return { plan: null, blockedReasons };
    }

    const anchorTime = timeCols[0];
    const windowDays = /inadimpl/.test(objective) ? 30 : /churn|atrit|evas|cancel/.test(objective) ? 90 : 30;

    // Look for a status/event column to build label from
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

    // No event column — can we use recency?
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

  // 3. Regression targets
  if (intent.problem_type === "regression") {
    const numericCols = columns.filter(c => 
      (c.type === "numérico" || c.type === "numeric" || c.type === "number") &&
      !isIdColumn(c.name, (c.distinct_count || 0) / 100) &&
      !isTimeColumn(c.name)
    );
    if (numericCols.length > 0) {
      // Pick the most promising numeric column (highest variance proxy = most distinct values)
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

  // 4. No strategy found — return suggestion
  if (columns.length > 0) {
    blockedReasons.push("Não foi possível gerar automaticamente um target/label. Selecione manualmente a coluna alvo na interface.");
  }

  return { plan: null, blockedReasons };
}

// ==================== FEATURE BUILDER ====================

interface GeneratedFeature {
  name: string;
  type: string; // count, recency, frequency, aggregation, one_hot
  source_columns: string[];
  description: string;
}

function buildFeatureList(
  columns: { name: string; type: string; distinct_count?: number }[],
  targetCol: string,
  entityKey: string | null,
  anchorTimeCol: string | null,
  leakageCols: string[],
): { 
  features_final: string[];
  features_generated: GeneratedFeature[];
  features_blocked: { name: string; reason: string }[];
  leakage_report: { column: string; reason: string }[];
} {
  const features_final: string[] = [];
  const features_generated: GeneratedFeature[] = [];
  const features_blocked: { name: string; reason: string }[] = [];
  const leakage_report: { column: string; reason: string }[] = [];

  const blockedSet = new Set<string>();

  for (const col of columns) {
    const norm = normalizeColName(col.name);
    
    // Skip target
    if (col.name === targetCol) continue;

    // Block IDs
    const uniqueRatio = (col.distinct_count || 0) / Math.max(columns.length, 1);
    if (isIdColumn(col.name, uniqueRatio > 0.5 ? uniqueRatio : 0)) {
      features_blocked.push({ name: col.name, reason: "Identificador técnico (ID/key)" });
      blockedSet.add(col.name);
      continue;
    }

    // Block leakage columns
    if (leakageCols.includes(col.name)) {
      features_blocked.push({ name: col.name, reason: "Possível leakage (pós-evento)" });
      leakage_report.push({ column: col.name, reason: "Marcada como leakage pelo contrato" });
      blockedSet.add(col.name);
      continue;
    }

    // Block high-cardinality text
    if ((col.type === "texto" || col.type === "text") && (col.distinct_count || 0) > 100) {
      features_blocked.push({ name: col.name, reason: `Texto com alta cardinalidade (${col.distinct_count} valores únicos)` });
      blockedSet.add(col.name);
      continue;
    }

    // Include as feature
    features_final.push(col.name);
  }

  // Auto-generate features if entity key exists
  if (entityKey) {
    // Count by entity
    features_generated.push({
      name: `count_by_${normalizeColName(entityKey)}`,
      type: "count",
      source_columns: [entityKey],
      description: `Contagem de registros por ${entityKey}`,
    });

    // Recency if time column exists
    if (anchorTimeCol) {
      features_generated.push({
        name: `recency_days_${normalizeColName(anchorTimeCol)}`,
        type: "recency",
        source_columns: [anchorTimeCol, entityKey],
        description: `Dias desde o último registro (${anchorTimeCol}) por ${entityKey}`,
      });

      features_generated.push({
        name: `frequency_30d_${normalizeColName(entityKey)}`,
        type: "frequency",
        source_columns: [anchorTimeCol, entityKey],
        description: `Frequência de eventos nos últimos 30 dias por ${entityKey}`,
      });
    }

    // Numeric aggregations by entity
    const numericCols = columns.filter(c => 
      (c.type === "numérico" || c.type === "numeric" || c.type === "number") &&
      c.name !== targetCol &&
      !blockedSet.has(c.name) &&
      !isIdColumn(c.name, 0)
    );

    for (const nc of numericCols.slice(0, 5)) { // limit to top 5
      features_generated.push({
        name: `mean_${normalizeColName(nc.name)}_by_${normalizeColName(entityKey)}`,
        type: "aggregation",
        source_columns: [nc.name, entityKey],
        description: `Média de ${nc.name} por ${entityKey}`,
      });
    }
  }

  // One-hot for low-cardinality categoricals
  const catCols = columns.filter(c =>
    (c.type === "texto" || c.type === "text" || c.type === "categórico") &&
    c.name !== targetCol &&
    !blockedSet.has(c.name) &&
    (c.distinct_count || 0) > 1 &&
    (c.distinct_count || 0) <= 10
  );

  for (const cc of catCols.slice(0, 5)) {
    features_generated.push({
      name: `onehot_${normalizeColName(cc.name)}`,
      type: "one_hot",
      source_columns: [cc.name],
      description: `One-hot encoding de ${cc.name} (${cc.distinct_count} categorias)`,
    });
  }

  return { features_final, features_generated, features_blocked, leakage_report };
}

// ==================== ENTITY KEY DETECTION ====================

function detectEntityKey(
  columns: { name: string; type: string; distinct_count?: number }[],
  totalRows: number,
): string | null {
  const entityPatterns = /^(cliente|cnpj|cpf|codparc|cod_parc|entity|customer|client|account|empresa|company|numerounico|numero_unico|id_cliente|customer_id|client_id|account_id|user_id|usuario)/i;
  
  for (const col of columns) {
    if (entityPatterns.test(normalizeColName(col.name))) {
      const uniqueRatio = totalRows > 0 ? (col.distinct_count || 0) / totalRows : 0;
      if (uniqueRatio >= 0.05 && uniqueRatio <= 0.95) {
        return col.name;
      }
    }
  }
  return null;
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

    // Validate JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
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

    // Fetch project
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, organization_id, user_id")
      .eq("id", project_id)
      .single();

    if (projErr || !project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[build-modeling-dataset] Starting for project ${project_id}`);

    // Fetch all required context in parallel
    const [
      aiCtxRes, manifestRes, columnsRes, catStatsRes, numStatsRes, settingsRes, inferenceRes, contractRes
    ] = await Promise.all([
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
        status: "BLOCKED",
        blocked_reasons: ["Nenhum manifesto de importação encontrado. Faça o upload dos dados primeiro."],
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (manifest.rows_consolidated === 0) {
      return new Response(JSON.stringify({ 
        status: "BLOCKED",
        blocked_reasons: ["Nenhuma linha consolidada no dataset. Reimporte os dados."],
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build enriched column list
    const catMap = new Map(catStats.map((c: any) => [c.column_name, c.distinct_count as number]));
    const numMap = new Map(numStats.map((n: any) => [n.column_name, { null_count: n.null_count, mean: n.mean_value, std: n.std_value }]));

    const enrichedColumns = projectColumns.map((col: any) => ({
      name: col.column_name,
      type: col.inferred_type,
      distinct_count: catMap.get(col.column_name) || undefined,
      null_pct: numMap.get(col.column_name)?.null_count 
        ? Math.round((numMap.get(col.column_name)!.null_count / manifest.rows_consolidated) * 100)
        : undefined,
    }));

    // Detect time and event columns
    const timeCols = enrichedColumns.filter((c: any) => isTimeColumn(c.name)).map((c: any) => c.name);
    const eventCols = enrichedColumns.filter((c: any) => isEventColumn(c.name)).map((c: any) => c.name);

    // Extract intent
    const intent: IntentContract = {
      objective: aiCtx?.intent?.objective || inference?.problem_type || "",
      problem_type: settings?.problem_type || inference?.problem_type || "classification",
      industry_hint: aiCtx?.intent?.industry_hint || "",
      target_behavior: aiCtx?.intent?.target_behavior || "",
    };

    console.log(`[build-modeling-dataset] Intent: ${JSON.stringify(intent)}`);
    console.log(`[build-modeling-dataset] Time cols: ${timeCols.join(", ")}`);
    console.log(`[build-modeling-dataset] Event cols: ${eventCols.join(", ")}`);

    // ==================== DETERMINE TARGET ====================
    let targetColumn = settings?.target_column || null;
    let targetType: "binary" | "multiclass" | "regression" = "binary";
    let targetSource: "direct" | "label_builder" = "direct";
    let labelPlan: LabelPlan | null = null;
    let windowDays: number | null = null;
    const allBlockedReasons: string[] = [];

    // If user already selected a target, validate it
    if (targetColumn) {
      const col = enrichedColumns.find((c: any) => c.name === targetColumn);
      if (!col) {
        allBlockedReasons.push(`Coluna target "${targetColumn}" não encontrada no dataset.`);
        targetColumn = null;
      } else if ((col.type === "texto" || col.type === "text") && (col.distinct_count || 0) > 50) {
        allBlockedReasons.push(`Target "${targetColumn}" é texto com alta cardinalidade (${col.distinct_count} valores). Selecione outra coluna.`);
        targetColumn = null;
      } else {
        // Determine type
        if (col.type === "numérico" || col.type === "numeric" || col.type === "number") {
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

    // If no target, try label builder
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

    // Still no target? BLOCKED
    if (!targetColumn) {
      if (allBlockedReasons.length === 0) {
        allBlockedReasons.push("Nenhum target/label pôde ser identificado automaticamente. Selecione manualmente.");
      }

      // Persist blocked state
      await supabase.from("project_modeling_datasets").upsert({
        project_id,
        organization_id: project.organization_id,
        target_column: "__none__",
        target_type: "binary",
        target_source: "direct",
        status: "blocked",
        blocked_reasons: allBlockedReasons,
        build_log: { intent, timeCols, eventCols, enrichedColumnsCount: enrichedColumns.length },
      }, { onConflict: "project_id" }).select();

      return new Response(JSON.stringify({
        status: "BLOCKED",
        blocked_reasons: allBlockedReasons,
        suggestions: {
          needs_time_col: timeCols.length === 0 && /churn|inadimpl|convers/.test(intent.objective || ""),
          needs_event_col: eventCols.length === 0,
          available_columns: enrichedColumns.slice(0, 20).map((c: any) => ({ name: c.name, type: c.type, distinct: c.distinct_count })),
        },
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ==================== DETECT ENTITY KEY ====================
    const entityKey = detectEntityKey(enrichedColumns, manifest.rows_consolidated);
    console.log(`[build-modeling-dataset] Entity key: ${entityKey || "none"}`);

    // ==================== DETECT ANCHOR TIME ====================
    const anchorTimeCol = timeCols.length > 0 ? timeCols[0] : null;

    // ==================== BUILD FEATURES ====================
    // Get leakage columns from contract or inference
    const leakageCols: string[] = [];
    if (existingContract?.leakage_flags && Array.isArray(existingContract.leakage_flags)) {
      for (const lf of existingContract.leakage_flags as any[]) {
        if (typeof lf === "string") leakageCols.push(lf);
        else if (lf?.column) leakageCols.push(lf.column);
      }
    }

    const featureResult = buildFeatureList(
      enrichedColumns,
      targetColumn,
      entityKey,
      anchorTimeCol,
      leakageCols,
    );

    console.log(`[build-modeling-dataset] Features: ${featureResult.features_final.length} direct, ${featureResult.features_generated.length} generated, ${featureResult.features_blocked.length} blocked`);

    // ==================== DETERMINE SPLIT STRATEGY ====================
    let splitStrategy = "stratified";
    if (anchorTimeCol) splitStrategy = "temporal";
    else if (entityKey) splitStrategy = "group";

    // ==================== COMPUTE COVERAGE ====================
    const totalCols = featureResult.features_final.length + featureResult.features_generated.length + 1; // +1 for target
    const coveragePct = enrichedColumns.length > 0 
      ? Math.round((featureResult.features_final.length / enrichedColumns.length) * 100) 
      : 0;

    // ==================== DETERMINE STATUS ====================
    const status = allBlockedReasons.length > 0 ? "blocked" 
      : featureResult.features_final.length < 2 ? "blocked"
      : "ready";

    if (featureResult.features_final.length < 2 && !allBlockedReasons.some(r => r.includes("feature"))) {
      allBlockedReasons.push("Menos de 2 features válidas disponíveis. Adicione mais colunas ao dataset.");
    }

    // ==================== PERSIST ====================
    // Delete existing records for idempotency
    await supabase.from("project_modeling_datasets")
      .delete()
      .eq("project_id", project_id);

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
        features_final: featureResult.features_final,
        features_generated: featureResult.features_generated,
        features_blocked: featureResult.features_blocked,
        row_count: manifest.rows_consolidated,
        column_count: totalCols,
        coverage_pct: coveragePct,
        leakage_report: featureResult.leakage_report,
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

    console.log(`[build-modeling-dataset] Complete. Status: ${status}`);

    return new Response(JSON.stringify({
      status: status.toUpperCase(),
      modeling_dataset_id: saved.id,
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
        final_count: featureResult.features_final.length,
        generated_count: featureResult.features_generated.length,
        blocked_count: featureResult.features_blocked.length,
        final: featureResult.features_final,
        generated: featureResult.features_generated,
        blocked: featureResult.features_blocked,
      },
      leakage_report: featureResult.leakage_report,
      dataset_stats: {
        row_count: manifest.rows_consolidated,
        column_count: totalCols,
        coverage_pct: coveragePct,
      },
      blocked_reasons: allBlockedReasons,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[build-modeling-dataset] Error:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Erro desconhecido" 
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
