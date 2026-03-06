import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface EDAColumn {
  name: string;
  dtype: string;
  null_pct: number;
  unique_count: number;
  sample_values?: unknown[];
  stats?: { min?: number; max?: number; mean?: number; std?: number };
  category_top?: { value: string; pct: number }[];
}

interface EDAJson {
  dataset: { name: string; rows: number; columns: number };
  columns: EDAColumn[];
  notes: {
    datetime_columns: string[];
    id_like_columns: string[];
    high_null_columns: string[];
  };
}

interface TargetSuggestion {
  id: string;
  target_column: string;
  problem_type: "classification" | "regression";
  confidence: number;
  reasoning: string;
  warnings: string[];
  recommended_features: string[];
  excluded_features: string[];
}

function runHeuristics(eda: EDAJson): TargetSuggestion[] {
  const suggestions: TargetSuggestion[] = [];
  const idLike = new Set(eda.notes.id_like_columns || []);
  const highNull = new Set(eda.notes.high_null_columns || []);
  const datetimeCols = new Set(eda.notes.datetime_columns || []);
  let sugIdx = 0;

  for (const col of eda.columns) {
    if (idLike.has(col.name) || highNull.has(col.name) || datetimeCols.has(col.name)) continue;
    if (col.null_pct > 0.8) continue;
    if (col.unique_count >= eda.dataset.rows * 0.9) continue;

    // Classification candidate (categorical)
    if ((col.dtype === "categorical" || col.dtype === "categórico" || col.dtype === "texto") && col.unique_count >= 2 && col.unique_count <= 20) {
      sugIdx++;
      const confidence = col.unique_count === 2 ? 0.9 : col.unique_count <= 5 ? 0.75 : 0.6;
      const warnings: string[] = [];
      if (col.category_top?.length) {
        const maxPct = Math.max(...col.category_top.map((c) => c.pct));
        if (maxPct > 0.95) warnings.push(`Classe dominante com ${(maxPct * 100).toFixed(0)}% — desbalanceamento severo.`);
        else if (maxPct > 0.85) warnings.push(`Classe majoritária com ${(maxPct * 100).toFixed(0)}% — avaliar balanceamento.`);
      }
      if (col.null_pct > 0.05) warnings.push(`${(col.null_pct * 100).toFixed(1)}% de valores nulos.`);
      const excluded = buildExcludedFeatures(eda, col.name);
      const recommended = buildRecommendedFeatures(eda, col.name, excluded);
      suggestions.push({ id: `sug_${sugIdx}`, target_column: col.name, problem_type: "classification", confidence, reasoning: col.unique_count === 2 ? `Coluna binária com ${col.unique_count} valores distintos e ${(col.null_pct * 100).toFixed(1)}% nulos.` : `Coluna categórica com ${col.unique_count} classes.`, warnings, recommended_features: recommended, excluded_features: excluded });
    }

    // Numeric binary classification (0/1)
    if ((col.dtype === "numeric" || col.dtype === "numérico") && col.unique_count === 2) {
      sugIdx++;
      const warnings: string[] = [];
      if (col.category_top?.length) {
        const maxPct = Math.max(...col.category_top.map((c) => c.pct));
        if (maxPct > 0.85) warnings.push(`Classe majoritária com ${(maxPct * 100).toFixed(0)}% — avaliar balanceamento.`);
      }
      const excluded = buildExcludedFeatures(eda, col.name);
      const recommended = buildRecommendedFeatures(eda, col.name, excluded);
      suggestions.push({ id: `sug_${sugIdx}`, target_column: col.name, problem_type: "classification", confidence: 0.85, reasoning: `Coluna numérica binária (0/1) com ${(col.null_pct * 100).toFixed(1)}% nulos. Ideal para classificação binária.`, warnings, recommended_features: recommended, excluded_features: excluded });
    }

    // Regression candidate
    if ((col.dtype === "numeric" || col.dtype === "numérico") && col.unique_count > 20 && col.stats) {
      sugIdx++;
      const warnings: string[] = [];
      if (col.stats.std !== undefined && col.stats.mean !== undefined && col.stats.mean !== 0) {
        const cv = Math.abs(col.stats.std / col.stats.mean);
        if (cv > 3) warnings.push("Alta variabilidade (CV > 3). Considere transformação log.");
      }
      if (col.null_pct > 0.05) warnings.push(`${(col.null_pct * 100).toFixed(1)}% de valores nulos.`);
      const excluded = buildExcludedFeatures(eda, col.name);
      const recommended = buildRecommendedFeatures(eda, col.name, excluded);
      suggestions.push({ id: `sug_${sugIdx}`, target_column: col.name, problem_type: "regression", confidence: col.unique_count > 100 ? 0.8 : 0.65, reasoning: `Coluna numérica contínua com ${col.unique_count} valores distintos. Range: ${col.stats.min?.toFixed(2)} a ${col.stats.max?.toFixed(2)}, média ${col.stats.mean?.toFixed(2)}.`, warnings, recommended_features: recommended, excluded_features: excluded });
    }
  }

  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions.slice(0, 6);
}

function buildExcludedFeatures(eda: EDAJson, targetName: string): string[] {
  const excluded: string[] = [];
  const idLike = new Set(eda.notes.id_like_columns || []);
  const highNull = new Set(eda.notes.high_null_columns || []);
  const datetimeCols = new Set(eda.notes.datetime_columns || []);
  for (const col of eda.columns) {
    if (col.name === targetName) continue;
    if (idLike.has(col.name) || highNull.has(col.name) || datetimeCols.has(col.name) || col.unique_count >= eda.dataset.rows * 0.9 || col.null_pct > 0.8) {
      excluded.push(col.name);
    }
  }
  return excluded;
}

function buildRecommendedFeatures(eda: EDAJson, targetName: string, excluded: string[]): string[] {
  const excludedSet = new Set(excluded);
  return eda.columns.filter((c) => c.name !== targetName && !excludedSet.has(c.name)).map((c) => c.name);
}

const LYS_SYSTEM_PROMPT = `Você é **Lys**, a IA especialista do PredictSys.
Seu papel é traduzir dados em decisões de negócio, combinando análise estatística, machine learning e entendimento de contexto empresarial.
Você atua de forma cumulativa, usando informações de etapas anteriores do projeto para enriquecer as próximas decisões.

## Objetivos
- Identificar problemas de negócio reais que podem ser resolvidos com o dataset
- Sugerir targets viáveis, explicando claramente: o que será previsto e para que isso serve no negócio
- Selecionar automaticamente as melhores features e explicar o impacto prático da predição
- Gerar subsídios diretos para o Dashboard de Negócio
- Persistir aprendizados para uso cumulativo nas próximas etapas

## Regras de comunicação
- Sempre em português brasileiro
- Linguagem de negócio, evitando jargões de ML quando possível
- Explicações concisas mas completas
- Foque em impacto prático e financeiro`;

function buildLysUserPrompt(eda: EDAJson, heuristicSuggestions: TargetSuggestion[], previousContext?: Record<string, any>): string {
  const columnsDesc = eda.columns.slice(0, 40).map((c) => {
    let desc = `- ${c.name} (${c.dtype}, ${c.unique_count} distintos, ${(c.null_pct * 100).toFixed(1)}% nulos`;
    if (c.stats) desc += `, min=${c.stats.min}, max=${c.stats.max}, mean=${c.stats.mean?.toFixed(2)}`;
    if (c.category_top?.length) desc += `, top: ${c.category_top.slice(0, 3).map((ct) => `${ct.value}(${(ct.pct * 100).toFixed(0)}%)`).join(", ")}`;
    desc += ")";
    return desc;
  }).join("\n");

  const heuristicsDesc = heuristicSuggestions.map((s) => `- "${s.target_column}" (${s.problem_type}, confiança: ${s.confidence.toFixed(2)}, warnings: ${s.warnings.join("; ") || "nenhum"})`).join("\n");

  let previousContextDesc = "";
  if (previousContext) {
    if (previousContext.eda?.summary) previousContextDesc += `\nContexto EDA anterior: ${previousContext.eda.summary}`;
    if (previousContext.targeting?.selected_target) previousContextDesc += `\nTarget anterior: ${previousContext.targeting.selected_target} (${previousContext.targeting.selected_problem})`;
    if (previousContext.storyline?.executive_summary) previousContextDesc += `\nÚltimo resumo executivo: ${previousContext.storyline.executive_summary.substring(0, 500)}`;
  }

  return `Analise este dataset e execute TODAS as 7 etapas da análise Lys.

== DATASET ==
Nome: ${eda.dataset.name}
Linhas: ${eda.dataset.rows}
Colunas: ${eda.dataset.columns}

== COLUNAS ==
${columnsDesc}

== NOTAS ==
- Colunas tipo ID: ${(eda.notes.id_like_columns || []).join(", ") || "nenhuma"}
- Colunas com muitos nulos: ${(eda.notes.high_null_columns || []).join(", ") || "nenhuma"}
- Colunas de data/hora: ${(eda.notes.datetime_columns || []).join(", ") || "nenhuma"}

== SUGESTÕES DA HEURÍSTICA ==
${heuristicsDesc || "Nenhuma sugestão heurística gerada."}
${previousContextDesc ? `\n== CONTEXTO CUMULATIVO ANTERIOR ==${previousContextDesc}` : ""}

Execute as 7 etapas e retorne a análise completa.`;
}

const LYS_ANALYSIS_TOOL = {
  type: "function",
  function: {
    name: "lys_full_analysis",
    description: "Retorna a análise completa da Lys com as 7 etapas: segmento de negócio, problemas predizíveis, sugestões de target, seleção de features, mapeamento de dashboard, insight resumido e aprendizado cumulativo.",
    parameters: {
      type: "object",
      properties: {
        business_segment: {
          type: "object",
          properties: {
            segment: { type: "string", description: "Nome do segmento de negócio identificado" },
            confidence: { type: "string", enum: ["alta", "media", "baixa"] },
            justification: { type: "string", description: "Justificativa curta da identificação do segmento" },
          },
          required: ["segment", "confidence", "justification"],
          additionalProperties: false,
        },
        business_problems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              problem_id: { type: "string" },
              problem_name: { type: "string" },
              problem_type: { type: "string", enum: ["classificacao", "regressao"] },
              business_value: { type: "string" },
            },
            required: ["problem_id", "problem_name", "problem_type", "business_value"],
            additionalProperties: false,
          },
        },
        target_suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              target_column: { type: "string" },
              problem_type: { type: "string", enum: ["classification", "regression"] },
              confidence: { type: "number" },
              reasoning: { type: "string", description: "Justificativa em linguagem de negócio, 1-2 frases" },
              what_it_predicts: { type: "string", description: "Explicação do que será previsto e para que serve" },
              warnings: { type: "array", items: { type: "string" } },
              recommended_features: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["column", "reason"],
                  additionalProperties: false,
                },
              },
              excluded_features: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["column", "reason"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "target_column", "problem_type", "confidence", "reasoning", "what_it_predicts", "warnings", "recommended_features", "excluded_features"],
            additionalProperties: false,
          },
        },
        dashboard_mapping: {
          type: "object",
          properties: {
            primary_kpis: { type: "array", items: { type: "string" } },
            recommended_charts: { type: "array", items: { type: "string" } },
            business_action: { type: "string" },
          },
          required: ["primary_kpis", "recommended_charts", "business_action"],
          additionalProperties: false,
        },
        insight_text: { type: "string", description: "Texto curto, claro e não técnico para o usuário final explicando o problema, solução e utilidade" },
        learning_notes: { type: "string", description: "Notas de aprendizado cumulativo para enriquecer próximas análises" },
        flow_validation: {
          type: "object",
          properties: {
            is_coherent: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["is_coherent", "reason"],
          additionalProperties: false,
        },
      },
      required: ["business_segment", "business_problems", "target_suggestions", "dashboard_mapping", "insight_text", "learning_notes", "flow_validation"],
      additionalProperties: false,
    },
  },
};

async function runLysAnalysis(
  eda: EDAJson,
  heuristicSuggestions: TargetSuggestion[],
  previousContext?: Record<string, any>
): Promise<{ analysis: any; enrichedSuggestions: TargetSuggestion[] }> {
  try {
    const userPrompt = buildLysUserPrompt(eda, heuristicSuggestions, previousContext);

    const response = await callOpenAI({
      messages: [
        { role: "system", content: LYS_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: [LYS_ANALYSIS_TOOL],
      tool_choice: { type: "function", function: { name: "lys_full_analysis" } },
      temperature: 0.3,
    });

    if (!response.ok) {
      console.error("[ai-suggest-targets] LLM error:", response.status);
      return { analysis: null, enrichedSuggestions: heuristicSuggestions };
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall?.function?.arguments) {
      // Fallback: try to parse content as JSON
      const content = data.choices?.[0]?.message?.content || "";
      console.warn("[ai-suggest-targets] No tool call, trying content parse...");
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const analysis = JSON.parse(jsonMatch[0]);
          return mergeAnalysisWithHeuristics(analysis, heuristicSuggestions);
        }
      } catch { /* ignore */ }
      return { analysis: null, enrichedSuggestions: heuristicSuggestions };
    }

    const analysis = JSON.parse(toolCall.function.arguments);
    return mergeAnalysisWithHeuristics(analysis, heuristicSuggestions);
  } catch (e) {
    console.error("[ai-suggest-targets] Lys analysis error:", e);
    return { analysis: null, enrichedSuggestions: heuristicSuggestions };
  }
}

function mergeAnalysisWithHeuristics(
  analysis: any,
  heuristicSuggestions: TargetSuggestion[]
): { analysis: any; enrichedSuggestions: TargetSuggestion[] } {
  const enriched = [...heuristicSuggestions];

  if (analysis.target_suggestions?.length) {
    for (const lysSug of analysis.target_suggestions) {
      const existing = enriched.find((s) => s.target_column === lysSug.target_column);
      if (existing) {
        // Enrich existing heuristic suggestion with Lys reasoning
        if (lysSug.reasoning) existing.reasoning = lysSug.reasoning;
        if (lysSug.warnings?.length) {
          const existingSet = new Set(existing.warnings);
          for (const w of lysSug.warnings) {
            if (!existingSet.has(w)) existing.warnings.push(w);
          }
        }
        if (lysSug.confidence && lysSug.confidence > 0) existing.confidence = lysSug.confidence;
        // Update features from Lys analysis
        if (lysSug.recommended_features?.length) {
          existing.recommended_features = lysSug.recommended_features.map((f: any) => typeof f === "string" ? f : f.column);
        }
        if (lysSug.excluded_features?.length) {
          existing.excluded_features = lysSug.excluded_features.map((f: any) => typeof f === "string" ? f : f.column);
        }
      } else {
        // New suggestion from Lys not in heuristics
        enriched.push({
          id: lysSug.id || `lys_${enriched.length + 1}`,
          target_column: lysSug.target_column,
          problem_type: lysSug.problem_type === "classificacao" ? "classification" : lysSug.problem_type === "regressao" ? "regression" : lysSug.problem_type,
          confidence: lysSug.confidence || 0.7,
          reasoning: lysSug.reasoning || "",
          warnings: lysSug.warnings || [],
          recommended_features: (lysSug.recommended_features || []).map((f: any) => typeof f === "string" ? f : f.column),
          excluded_features: (lysSug.excluded_features || []).map((f: any) => typeof f === "string" ? f : f.column),
        });
      }
    }
  }

  // Re-sort by confidence
  enriched.sort((a, b) => b.confidence - a.confidence);
  return { analysis, enrichedSuggestions: enriched.slice(0, 6) };
}

async function persistLysContext(
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string,
  projectId: string,
  analysis: any
) {
  if (!analysis) return;

  try {
    const payload: Record<string, any> = {
      suggested_problems: analysis.business_problems?.map((p: any) => p.problem_name) || [],
      business_segment: analysis.business_segment || null,
      dashboard_mapping: analysis.dashboard_mapping || null,
      insight_text: analysis.insight_text || "",
      learning_notes: analysis.learning_notes || "",
      flow_validation: analysis.flow_validation || null,
    };

    // Persist best target suggestion details
    if (analysis.target_suggestions?.length) {
      const best = analysis.target_suggestions[0];
      payload.top_suggestion = {
        target_column: best.target_column,
        problem_type: best.problem_type,
        what_it_predicts: best.what_it_predicts || "",
        confidence: best.confidence,
      };
    }

    const appendRes = await fetch(`${supabaseUrl}/functions/v1/append-project-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
        apikey: supabaseServiceKey,
      },
      body: JSON.stringify({
        project_id: projectId,
        stage: "targeting",
        payload,
      }),
    });

    console.log(`[ai-suggest-targets] Context persist status=${appendRes.status}`);
  } catch (e) {
    console.error("[ai-suggest-targets] Failed to persist context:", e);
  }
}

async function buildEDAFromDB(supabase: any, projectId: string): Promise<EDAJson | null> {
  const [colsRes, numRes, catRes, projRes] = await Promise.all([
    supabase.from("project_columns").select("column_name, inferred_type, column_index").eq("project_id", projectId).order("column_index"),
    supabase.from("project_numeric_stats").select("*").eq("project_id", projectId),
    supabase.from("project_categorical_stats").select("*").eq("project_id", projectId),
    supabase.from("projects").select("name, dataset_rows, dataset_columns, total_rows").eq("id", projectId).single(),
  ]);

  if (!colsRes.data || colsRes.data.length === 0) return null;

  const totalRows = projRes.data?.total_rows || projRes.data?.dataset_rows || 0;
  const numStatsMap = new Map((numRes.data || []).map((s: any) => [s.column_name, s]));
  const catStatsMap = new Map((catRes.data || []).map((s: any) => [s.column_name, s]));

  const edaColumns: EDAColumn[] = colsRes.data.map((col: any) => {
    const numStat = numStatsMap.get(col.column_name) as any;
    const catStat = catStatsMap.get(col.column_name) as any;
    const isNumeric = col.inferred_type === "numérico";
    const uniqueCount = catStat?.distinct_count || (numStat ? (numStat.max_value !== numStat.min_value ? Math.min(totalRows, 1000) : 1) : 0);

    const edaCol: EDAColumn = {
      name: col.column_name,
      dtype: isNumeric ? "numeric" : "categorical",
      null_pct: numStat ? numStat.null_count / Math.max(totalRows, 1) : 0,
      unique_count: uniqueCount,
    };

    if (numStat) {
      edaCol.stats = { min: numStat.min_value, max: numStat.max_value, mean: numStat.mean_value, std: numStat.std_value };
      if (!catStat && numStat.max_value !== null && numStat.min_value !== null) {
        const range = numStat.max_value - numStat.min_value;
        if (range === 0) edaCol.unique_count = 1;
        else if (range === 1 && numStat.min_value === 0) edaCol.unique_count = 2;
        else edaCol.unique_count = Math.min(totalRows, Math.max(20, Math.ceil(range)));
      }
    }

    if (catStat) {
      edaCol.unique_count = catStat.distinct_count;
      const topCats = (catStat.top_categories || []) as Array<{ category: string; count: number }>;
      const totalCatCount = topCats.reduce((s: number, c: any) => s + c.count, 0);
      edaCol.category_top = topCats.slice(0, 5).map((c: any) => ({ value: c.category, pct: totalCatCount > 0 ? c.count / totalCatCount : 0 }));
    }

    return edaCol;
  });

  const idLikeColumns = edaColumns.filter((c) => {
    const nameL = c.name.toLowerCase();
    return c.unique_count >= totalRows * 0.9 || nameL.includes("id_") || nameL.startsWith("id") || nameL === "id" || nameL.includes("cpf") || nameL.includes("cnpj") || nameL.includes("_id");
  }).map((c) => c.name);

  const highNullColumns = edaColumns.filter((c) => c.null_pct > 0.5).map((c) => c.name);
  const datetimeColumns = edaColumns.filter((c) => {
    const nameL = c.name.toLowerCase();
    return nameL.includes("data") || nameL.includes("date") || nameL.includes("timestamp") || nameL.includes("dt_") || nameL.includes("_dt");
  }).map((c) => c.name);

  return {
    dataset: { name: projRes.data?.name || "dataset", rows: totalRows, columns: colsRes.data.length },
    columns: edaColumns,
    notes: { datetime_columns: datetimeColumns, id_like_columns: idLikeColumns, high_null_columns: highNullColumns },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id, top_k = 5 } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[ai-suggest-targets] Generating Lys analysis for project: ${project_id}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch existing AI context for cumulative learning
    const { data: aiCtx } = await supabase
      .from("project_ai_context")
      .select("context")
      .eq("project_id", project_id)
      .maybeSingle();

    const previousContext = aiCtx?.context as Record<string, any> | undefined;

    // Fetch EDA snapshot or build from DB
    let edaJson: EDAJson | null = null;

    const { data: snapshot } = await supabase
      .from("project_eda_snapshots")
      .select("eda_json")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (snapshot) {
      edaJson = snapshot.eda_json as EDAJson;
    } else {
      console.log("[ai-suggest-targets] No EDA snapshot, building from DB stats...");
      edaJson = await buildEDAFromDB(supabase, project_id);

      if (edaJson) {
        await supabase.from("project_eda_snapshots").insert({ project_id, org_id: null, eda_json: edaJson });
      }
    }

    if (!edaJson) {
      return new Response(
        JSON.stringify({ error: "Nenhuma coluna encontrada. Execute o EDA primeiro." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 1: Run heuristics
    const heuristicSuggestions = runHeuristics(edaJson);

    // Step 2: Run Lys full 7-stage analysis (enriches heuristics + adds business context)
    const { analysis, enrichedSuggestions } = await runLysAnalysis(edaJson, heuristicSuggestions.slice(0, top_k), previousContext);

    // Step 3: Persist Lys analysis to cumulative context (non-blocking)
    persistLysContext(supabase, supabaseUrl, supabaseServiceKey, project_id, analysis).catch((e) =>
      console.error("[ai-suggest-targets] Background persist error:", e)
    );

    console.log(`[ai-suggest-targets] Generated ${enrichedSuggestions.length} suggestions ${analysis ? "with" : "without"} Lys analysis`);

    return new Response(
      JSON.stringify({
        suggestions: enrichedSuggestions,
        lys_analysis: analysis ? {
          business_segment: analysis.business_segment,
          business_problems: analysis.business_problems,
          dashboard_mapping: analysis.dashboard_mapping,
          insight_text: analysis.insight_text,
          learning_notes: analysis.learning_notes,
          flow_validation: analysis.flow_validation,
        } : null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[ai-suggest-targets] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
