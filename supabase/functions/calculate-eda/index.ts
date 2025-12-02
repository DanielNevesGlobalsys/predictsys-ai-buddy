import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { parse } from "https://esm.sh/csv-parse@5.5.6/sync";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NumericStats {
  project_id: string;
  column_name: string;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  median_value: number | null;
  std_value: number | null;
  null_count: number;
}

interface CategoricalStats {
  project_id: string;
  column_name: string;
  distinct_count: number;
  top_categories: { category: string; count: number }[];
}

function calculateMedian(sortedValues: number[]): number | null {
  if (sortedValues.length === 0) return null;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 !== 0
    ? sortedValues[mid]
    : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function calculateStd(values: number[], mean: number): number | null {
  if (values.length < 2) return null;
  const squareDiffs = values.map((value) => Math.pow(value - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  return Math.sqrt(avgSquareDiff);
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Calculando EDA para projeto: ${project_id}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get project info
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      console.error("Projeto não encontrado:", projectError);
      return new Response(
        JSON.stringify({ error: "Projeto não encontrado" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!project.dataset_filename) {
      return new Response(
        JSON.stringify({ error: "Nenhum dataset carregado para este projeto" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get column metadata
    const { data: columns, error: columnsError } = await supabase
      .from("project_columns")
      .select("*")
      .eq("project_id", project_id)
      .order("column_index");

    if (columnsError || !columns || columns.length === 0) {
      console.error("Colunas não encontradas:", columnsError);
      return new Response(
        JSON.stringify({ error: "Metadados de colunas não encontrados" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Colunas encontradas: ${columns.length}`);

    // Download CSV from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("datasets")
      .download(project.dataset_filename);

    if (downloadError || !fileData) {
      console.error("Erro ao baixar arquivo:", downloadError);
      return new Response(
        JSON.stringify({ error: "Erro ao acessar o arquivo do dataset" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse CSV
    const csvText = await fileData.text();
    let records: Record<string, string>[];
    
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (parseError) {
      console.error("Erro ao parsear CSV:", parseError);
      return new Response(
        JSON.stringify({ error: "Erro ao processar o arquivo CSV" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Registros carregados: ${records.length}`);

    const numericStats: NumericStats[] = [];
    const categoricalStats: CategoricalStats[] = [];

    // Process each column
    for (const column of columns) {
      const columnName = column.column_name;
      const columnType = column.inferred_type;
      const values = records.map((r) => r[columnName]);

      if (columnType === "numérico") {
        // Parse numeric values
        const numericValues: number[] = [];
        let nullCount = 0;

        for (const val of values) {
          if (val === null || val === undefined || val === "" || val.toLowerCase() === "nan" || val.toLowerCase() === "null") {
            nullCount++;
          } else {
            const num = parseFloat(val.replace(",", "."));
            if (!isNaN(num)) {
              numericValues.push(num);
            } else {
              nullCount++;
            }
          }
        }

        if (numericValues.length > 0) {
          const sorted = [...numericValues].sort((a, b) => a - b);
          const sum = numericValues.reduce((a, b) => a + b, 0);
          const mean = sum / numericValues.length;

          numericStats.push({
            project_id,
            column_name: columnName,
            min_value: sorted[0],
            max_value: sorted[sorted.length - 1],
            mean_value: Math.round(mean * 1000) / 1000,
            median_value: calculateMedian(sorted),
            std_value: calculateStd(numericValues, mean),
            null_count: nullCount,
          });
        } else {
          numericStats.push({
            project_id,
            column_name: columnName,
            min_value: null,
            max_value: null,
            mean_value: null,
            median_value: null,
            std_value: null,
            null_count: values.length,
          });
        }
      } else {
        // Categorical column
        const counts: Record<string, number> = {};
        let nullCount = 0;

        for (const val of values) {
          if (val === null || val === undefined || val === "") {
            nullCount++;
            const key = "(vazio)";
            counts[key] = (counts[key] || 0) + 1;
          } else {
            counts[val] = (counts[val] || 0) + 1;
          }
        }

        const sortedCategories = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([category, count]) => ({ category, count }));

        categoricalStats.push({
          project_id,
          column_name: columnName,
          distinct_count: Object.keys(counts).length,
          top_categories: sortedCategories,
        });
      }
    }

    console.log(`Estatísticas numéricas: ${numericStats.length}, Categóricas: ${categoricalStats.length}`);

    // Delete existing stats and insert new ones
    await supabase.from("project_numeric_stats").delete().eq("project_id", project_id);
    await supabase.from("project_categorical_stats").delete().eq("project_id", project_id);

    if (numericStats.length > 0) {
      const { error: insertNumericError } = await supabase
        .from("project_numeric_stats")
        .insert(numericStats);
      if (insertNumericError) {
        console.error("Erro ao inserir estatísticas numéricas:", insertNumericError);
      }
    }

    if (categoricalStats.length > 0) {
      const { error: insertCategoricalError } = await supabase
        .from("project_categorical_stats")
        .insert(categoricalStats);
      if (insertCategoricalError) {
        console.error("Erro ao inserir estatísticas categóricas:", insertCategoricalError);
      }
    }

    // Update project status
    await supabase
      .from("projects")
      .update({ status: "eda_complete" })
      .eq("id", project_id);

    return new Response(
      JSON.stringify({
        success: true,
        message: "EDA calculada com sucesso",
        numeric_columns: numericStats.length,
        categorical_columns: categoricalStats.length,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Erro inesperado:", error);
    return new Response(
      JSON.stringify({ error: "Erro interno do servidor" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
