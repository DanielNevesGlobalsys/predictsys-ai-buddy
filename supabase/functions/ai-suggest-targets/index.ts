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
    // Skip ID-like, high null, datetime columns
    if (idLike.has(col.name)) continue;
    if (highNull.has(col.name)) continue;
    if (datetimeCols.has(col.name)) continue;
    if (col.null_pct > 0.8) continue;

    // Skip columns with unique_count ~ rows (likely IDs)
    if (col.unique_count >= eda.dataset.rows * 0.9) continue;

    // Classification candidate
    if (col.dtype === "categorical" || col.dtype === "categórico" || col.dtype === "texto") {
      if (col.unique_count >= 2 && col.unique_count <= 20) {
        sugIdx++;
        const confidence = col.unique_count === 2 ? 0.9 : col.unique_count <= 5 ? 0.75 : 0.6;
        const warnings: string[] = [];

        // Check for imbalance
        if (col.category_top && col.category_top.length > 0) {
          const maxPct = Math.max(...col.category_top.map((c) => c.pct));
          if (maxPct > 0.95) {
            warnings.push(
              `Classe dominante com ${(maxPct * 100).toFixed(0)}% - desbalanceamento severo.`
            );
          } else if (maxPct > 0.85) {
            warnings.push(
              `Classe majoritária com ${(maxPct * 100).toFixed(0)}% - avaliar balanceamento.`
            );
          }
        }

        if (col.null_pct > 0.05) {
          warnings.push(`${(col.null_pct * 100).toFixed(1)}% de valores nulos.`);
        }

        const excluded = buildExcludedFeatures(eda, col.name);
        const recommended = buildRecommendedFeatures(eda, col.name, excluded);

        suggestions.push({
          id: `sug_${sugIdx}`,
          target_column: col.name,
          problem_type: "classification",
          confidence,
          reasoning: col.unique_count === 2
            ? `Coluna binária com ${col.unique_count} valores distintos e ${(col.null_pct * 100).toFixed(1)}% nulos. Forte candidato para classificação.`
            : `Coluna categórica com ${col.unique_count} classes. Pode ser usada como target de classificação multiclasse.`,
          warnings,
          recommended_features: recommended,
          excluded_features: excluded,
        });
      }
    }

    // Numeric binary classification candidate (0/1)
    if ((col.dtype === "numeric" || col.dtype === "numérico") && col.unique_count === 2) {
      sugIdx++;
      const warnings: string[] = [];
      if (col.category_top && col.category_top.length > 0) {
        const maxPct = Math.max(...col.category_top.map((c) => c.pct));
        if (maxPct > 0.85) {
          warnings.push(`Classe majoritária com ${(maxPct * 100).toFixed(0)}% - avaliar balanceamento.`);
        }
      }

      const excluded = buildExcludedFeatures(eda, col.name);
      const recommended = buildRecommendedFeatures(eda, col.name, excluded);

      suggestions.push({
        id: `sug_${sugIdx}`,
        target_column: col.name,
        problem_type: "classification",
        confidence: 0.85,
        reasoning: `Coluna numérica binária (0/1) com ${(col.null_pct * 100).toFixed(1)}% nulos. Ideal para classificação binária.`,
        warnings,
        recommended_features: recommended,
        excluded_features: excluded,
      });
    }

    // Regression candidate
    if (
      (col.dtype === "numeric" || col.dtype === "numérico") &&
      col.unique_count > 20 &&
      col.stats
    ) {
      sugIdx++;
      const warnings: string[] = [];

      if (col.stats.std !== undefined && col.stats.mean !== undefined && col.stats.mean !== 0) {
        const cv = Math.abs(col.stats.std / col.stats.mean);
        if (cv > 3) {
          warnings.push("Alta variabilidade (coeficiente de variação > 3). Considere transformação log.");
        }
      }

      if (col.null_pct > 0.05) {
        warnings.push(`${(col.null_pct * 100).toFixed(1)}% de valores nulos.`);
      }

      const excluded = buildExcludedFeatures(eda, col.name);
      const recommended = buildRecommendedFeatures(eda, col.name, excluded);

      const confidence = col.unique_count > 100 ? 0.8 : 0.65;

      suggestions.push({
        id: `sug_${sugIdx}`,
        target_column: col.name,
        problem_type: "regression",
        confidence,
        reasoning: `Coluna numérica contínua com ${col.unique_count} valores distintos. Range: ${col.stats.min?.toFixed(2)} a ${col.stats.max?.toFixed(2)}, média ${col.stats.mean?.toFixed(2)}.`,
        warnings,
        recommended_features: recommended,
        excluded_features: excluded,
      });
    }
  }

  // Sort by confidence descending, take top 6
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
    if (idLike.has(col.name)) {
      excluded.push(col.name);
      continue;
    }
    if (highNull.has(col.name)) {
      excluded.push(col.name);
      continue;
    }
    if (datetimeCols.has(col.name)) {
      excluded.push(col.name);
      continue;
    }
    // Columns with unique_count ~ rows are likely IDs
    if (col.unique_count >= eda.dataset.rows * 0.9) {
      excluded.push(col.name);
      continue;
    }
    // Columns with > 80% nulls
    if (col.null_pct > 0.8) {
      excluded.push(col.name);
    }
  }
  return excluded;
}

function buildRecommendedFeatures(
  eda: EDAJson,
  targetName: string,
  excluded: string[]
): string[] {
  const excludedSet = new Set(excluded);
  return eda.columns
    .filter((c) => c.name !== targetName && !excludedSet.has(c.name))
    .map((c) => c.name);
}

async function enrichWithLLM(
  suggestions: TargetSuggestion[],
  eda: EDAJson
): Promise<TargetSuggestion[]> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY || suggestions.length === 0) return suggestions;

  try {
    const columnsDesc = eda.columns
      .slice(0, 30) // Limit context size
      .map(
        (c) =>
          `- ${c.name} (${c.dtype}, ${c.unique_count} distintos, ${(c.null_pct * 100).toFixed(1)}% nulos${
            c.stats ? `, min=${c.stats.min}, max=${c.stats.max}, mean=${c.stats.mean}` : ""
          }${
            c.category_top
              ? `, top: ${c.category_top
                  .slice(0, 3)
                  .map((ct) => `${ct.value}(${(ct.pct * 100).toFixed(0)}%)`)
                  .join(", ")}`
              : ""
          })`
      )
      .join("\n");

    const suggestionsDesc = suggestions
      .map(
        (s) =>
          `Target: "${s.target_column}" (${s.problem_type}, confiança: ${s.confidence.toFixed(2)})`
      )
      .join("\n");

    const systemPrompt = `Você é a Lys, assistente de IA da PredictSys. Analise as sugestões de target para um dataset e melhore o reasoning de cada uma. Responda APENAS com um JSON array com objetos {"id": string, "reasoning": string, "warnings": string[]}. Mantenha o reasoning conciso (1-2 frases em português). Adicione warnings relevantes que a heurística possa ter perdido.`;

    const userPrompt = `Dataset: ${eda.dataset.rows} linhas, ${eda.dataset.columns} colunas.

Colunas:
${columnsDesc}

Notas:
- Colunas tipo ID: ${(eda.notes.id_like_columns || []).join(", ") || "nenhuma"}
- Colunas com muitos nulos: ${(eda.notes.high_null_columns || []).join(", ") || "nenhuma"}

Sugestões da heurística:
${suggestionsDesc}

Melhore o reasoning e warnings de cada sugestão.`;

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
        }),
      }
    );

    if (!response.ok) {
      console.error("[ai-suggest-targets] LLM error:", response.status);
      return suggestions;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";

    // Extract JSON from content
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn("[ai-suggest-targets] Could not parse LLM response as JSON");
      return suggestions;
    }

    const enrichments = JSON.parse(jsonMatch[0]) as Array<{
      id: string;
      reasoning: string;
      warnings: string[];
    }>;

    // Merge enrichments back into suggestions
    for (const enrichment of enrichments) {
      const sug = suggestions.find((s) => s.id === enrichment.id);
      if (sug) {
        if (enrichment.reasoning) sug.reasoning = enrichment.reasoning;
        if (enrichment.warnings && enrichment.warnings.length > 0) {
          // Merge unique warnings
          const existingSet = new Set(sug.warnings);
          for (const w of enrichment.warnings) {
            if (!existingSet.has(w)) sug.warnings.push(w);
          }
        }
      }
    }

    return suggestions;
  } catch (e) {
    console.error("[ai-suggest-targets] LLM enrichment error:", e);
    return suggestions;
  }
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

    console.log(`[ai-suggest-targets] Generating suggestions for project: ${project_id}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch latest EDA snapshot
    const { data: snapshot, error: snapError } = await supabase
      .from("project_eda_snapshots")
      .select("eda_json")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (snapError || !snapshot) {
      console.log("[ai-suggest-targets] No EDA snapshot found, building from DB stats...");

      // Fallback: build EDA JSON from existing project_columns + stats
      const [colsRes, numRes, catRes, projRes] = await Promise.all([
        supabase
          .from("project_columns")
          .select("column_name, inferred_type, column_index")
          .eq("project_id", project_id)
          .order("column_index"),
        supabase
          .from("project_numeric_stats")
          .select("*")
          .eq("project_id", project_id),
        supabase
          .from("project_categorical_stats")
          .select("*")
          .eq("project_id", project_id),
        supabase
          .from("projects")
          .select("name, dataset_rows, dataset_columns, total_rows")
          .eq("id", project_id)
          .single(),
      ]);

      if (!colsRes.data || colsRes.data.length === 0) {
        return new Response(
          JSON.stringify({
            error: "Nenhuma coluna encontrada. Execute o EDA primeiro.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const totalRows = projRes.data?.total_rows || projRes.data?.dataset_rows || 0;
      const numStatsMap = new Map(
        (numRes.data || []).map((s: any) => [s.column_name, s])
      );
      const catStatsMap = new Map(
        (catRes.data || []).map((s: any) => [s.column_name, s])
      );

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
          edaCol.stats = {
            min: numStat.min_value,
            max: numStat.max_value,
            mean: numStat.mean_value,
            std: numStat.std_value,
          };
          // For numeric columns, estimate unique count from range
          if (!catStat && numStat.max_value !== null && numStat.min_value !== null) {
            const range = numStat.max_value - numStat.min_value;
            if (range === 0) edaCol.unique_count = 1;
            else if (range === 1 && numStat.min_value === 0) edaCol.unique_count = 2; // binary 0/1
            else edaCol.unique_count = Math.min(totalRows, Math.max(20, Math.ceil(range)));
          }
        }

        if (catStat) {
          edaCol.unique_count = catStat.distinct_count;
          const topCats = (catStat.top_categories || []) as Array<{
            category: string;
            count: number;
          }>;
          const totalCatCount = topCats.reduce((s: number, c: any) => s + c.count, 0);
          edaCol.category_top = topCats.slice(0, 5).map((c: any) => ({
            value: c.category,
            pct: totalCatCount > 0 ? c.count / totalCatCount : 0,
          }));
        }

        return edaCol;
      });

      // Detect ID-like and high-null columns
      const idLikeColumns = edaColumns
        .filter((c) => {
          const nameL = c.name.toLowerCase();
          return (
            c.unique_count >= totalRows * 0.9 ||
            nameL.includes("id_") ||
            nameL.startsWith("id") ||
            nameL === "id" ||
            nameL.includes("cpf") ||
            nameL.includes("cnpj") ||
            nameL.includes("_id")
          );
        })
        .map((c) => c.name);

      const highNullColumns = edaColumns
        .filter((c) => c.null_pct > 0.5)
        .map((c) => c.name);

      const datetimeColumns = edaColumns
        .filter((c) => {
          const nameL = c.name.toLowerCase();
          return (
            nameL.includes("data") ||
            nameL.includes("date") ||
            nameL.includes("timestamp") ||
            nameL.includes("dt_") ||
            nameL.includes("_dt")
          );
        })
        .map((c) => c.name);

      const edaJson: EDAJson = {
        dataset: {
          name: projRes.data?.name || "dataset",
          rows: totalRows,
          columns: colsRes.data.length,
        },
        columns: edaColumns,
        notes: {
          datetime_columns: datetimeColumns,
          id_like_columns: idLikeColumns,
          high_null_columns: highNullColumns,
        },
      };

      // Save the generated snapshot for future use
      await supabase.from("project_eda_snapshots").insert({
        project_id,
        org_id: null,
        eda_json: edaJson,
      });

      // Run heuristics
      let suggestions = runHeuristics(edaJson);
      suggestions = await enrichWithLLM(suggestions.slice(0, top_k), edaJson);

      return new Response(
        JSON.stringify({ suggestions }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use existing snapshot
    const edaJson = snapshot.eda_json as EDAJson;
    let suggestions = runHeuristics(edaJson);
    suggestions = await enrichWithLLM(suggestions.slice(0, top_k), edaJson);

    console.log(
      `[ai-suggest-targets] Generated ${suggestions.length} suggestions`
    );

    return new Response(
      JSON.stringify({ suggestions }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[ai-suggest-targets] Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erro interno",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
