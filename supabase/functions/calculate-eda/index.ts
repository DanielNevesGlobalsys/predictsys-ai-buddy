import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

// Maximum rows to process for EDA (sample for large files)
// NOTE: Keep this conservative to avoid CPU limits in serverless runtime.
const MAX_ROWS_TO_PROCESS = 10000;
// Maximum bytes to download for sampling (10 MB)
const SAMPLE_BYTES_LIMIT = 10 * 1024 * 1024;

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

// CSV parser that respects delimiter
function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Detect delimiter from first line
function detectDelimiter(firstLine: string): string {
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  return semicolonCount > commaCount ? ";" : ",";
}

/**
 * Try to get the actual file path from various sources
 */
async function resolveDatasetPath(
  supabase: any,
  project: any,
): Promise<{ path: string; filePaths?: string[] } | null> {
  const projectId = project.id;
  
  // First, try to get from project_datasets (source of truth for new imports)
  const { data: datasets } = await supabase
    .from("project_datasets")
    .select("storage_path, source_metadata")
    .eq("project_id", projectId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (datasets && datasets.length > 0) {
    const dataset = datasets[0];
    const metadata = dataset.source_metadata as Record<string, any> | null;
    
    // Check if it's a batch with multiple file paths
    if (metadata?.file_paths && Array.isArray(metadata.file_paths) && metadata.file_paths.length > 0) {
      // For batch imports with multiple files, use the first file for EDA
      // Or if storage_path points to an actual file, use that
      console.log(`[calculate-eda] Dataset has ${metadata.file_paths.length} file paths`);
      return { 
        path: metadata.file_paths[0], 
        filePaths: metadata.file_paths 
      };
    }
    
    // Single file import - storage_path should be the actual file path
    if (dataset.storage_path) {
      console.log(`[calculate-eda] Using dataset storage_path: ${dataset.storage_path}`);
      return { path: dataset.storage_path };
    }
  }

  // Fallback to project.dataset_filename
  if (project.dataset_filename) {
    console.log(`[calculate-eda] Using project.dataset_filename: ${project.dataset_filename}`);
    return { path: project.dataset_filename };
  }

  return null;
}

/**
 * Stream-based sampling that reads only first N bytes using Range header
 */
async function sampleFileWithRange(
  supabase: any,
  storagePath: string,
  maxBytes: number,
  maxRows: number,
): Promise<{ headers: string[]; records: Record<string, string>[]; delimiter: string } | null> {
  try {
    // Generate signed URL
    const { data: signedData, error: signedError } = await supabase.storage
      .from("datasets")
      .createSignedUrl(storagePath, 60 * 60);

    if (signedError || !signedData?.signedUrl) {
      console.error(`[calculate-eda] Failed to create signed URL for ${storagePath}:`, signedError);
      return null;
    }

    // Fetch with Range header
    const res = await fetch(signedData.signedUrl, {
      headers: {
        "Accept-Encoding": "identity",
        Range: `bytes=0-${maxBytes - 1}`,
      },
    });

    if (!res.ok && res.status !== 206) {
      console.error(`[calculate-eda] Failed to fetch file: HTTP ${res.status}`);
      return null;
    }

    if (!res.body) {
      console.error(`[calculate-eda] Response has no body`);
      return null;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let bytesRead = 0;

    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    
    text += decoder.decode(); // Flush
    reader.releaseLock();

    // Parse the sampled text
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
    
    if (lines.length === 0) {
      console.error(`[calculate-eda] No lines found in file`);
      return null;
    }

    // Detect delimiter from first line
    const delimiter = detectDelimiter(lines[0]);
    console.log(`[calculate-eda] Detected delimiter: "${delimiter}"`);

    // Parse headers
    const headers = parseCSVLine(lines[0], delimiter);
    console.log(`[calculate-eda] Parsed ${headers.length} headers`);

    // Parse data rows (sample if needed)
    const dataLines = lines.slice(1);
    const sampleRate = dataLines.length > maxRows ? Math.ceil(dataLines.length / maxRows) : 1;
    
    const records: Record<string, string>[] = [];
    
    for (let i = 0; i < dataLines.length && records.length < maxRows; i++) {
      if (sampleRate > 1 && i % sampleRate !== 0) continue;
      
      const values = parseCSVLine(dataLines[i], delimiter);
      const record: Record<string, string> = {};
      
      for (let j = 0; j < headers.length && j < values.length; j++) {
        record[headers[j]] = values[j];
      }
      
      records.push(record);
    }

    console.log(`[calculate-eda] Parsed ${records.length} records from ${bytesRead} bytes`);
    return { headers, records, delimiter };
  } catch (error) {
    console.error(`[calculate-eda] Error sampling file:`, error);
    return null;
  }
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

    console.log(`[calculate-eda] Calculando EDA para projeto: ${project_id}`);

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
      console.error("[calculate-eda] Projeto não encontrado:", projectError);
      return new Response(
        JSON.stringify({ error: "Projeto não encontrado" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve the actual dataset path
    const pathInfo = await resolveDatasetPath(supabase, project);
    
    if (!pathInfo) {
      console.error("[calculate-eda] Nenhum dataset encontrado para o projeto");
      return new Response(
        JSON.stringify({ error: "Nenhum dataset carregado para este projeto" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[calculate-eda] Resolved dataset path: ${pathInfo.path}`);

    // Get column metadata
    const { data: columns, error: columnsError } = await supabase
      .from("project_columns")
      .select("*")
      .eq("project_id", project_id)
      .order("column_index");

    if (columnsError) {
      console.error("[calculate-eda] Erro ao buscar colunas:", columnsError);
    }

    // Sample the file using Range header (memory efficient)
    const sampledData = await sampleFileWithRange(
      supabase,
      pathInfo.path,
      SAMPLE_BYTES_LIMIT,
      MAX_ROWS_TO_PROCESS,
    );

    if (!sampledData) {
      console.error(`[calculate-eda] Falha ao amostrar arquivo: ${pathInfo.path}`);
      return new Response(
        JSON.stringify({ 
          error: "Arquivo de dados não encontrado no storage. Faça upload novamente.",
          details: { path: pathInfo.path, bucket: "datasets" }
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { headers, records, delimiter } = sampledData;
    
    if (records.length === 0) {
      return new Response(
        JSON.stringify({ error: "Arquivo CSV está vazio ou não pôde ser processado" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[calculate-eda] Registros processados: ${records.length} (máx: ${MAX_ROWS_TO_PROCESS})`);

    // Use columns from DB if available, otherwise use headers from file
    const columnsToProcess = columns && columns.length > 0 
      ? columns 
      : headers.map((h, i) => ({ column_name: h, column_index: i, inferred_type: "texto" }));

    const numericStats: NumericStats[] = [];
    const categoricalStats: CategoricalStats[] = [];

    // Process each column
    for (const column of columnsToProcess) {
      const columnName = column.column_name;
      const columnType = column.inferred_type;
      
      if (columnType === "numérico") {
        // Parse numeric values
        const numericValues: number[] = [];
        let nullCount = 0;

        for (const record of records) {
          const val = record[columnName];
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
            null_count: records.length,
          });
        }
      } else {
        // Categorical column
        const counts: Record<string, number> = {};

        for (const record of records) {
          const val = record[columnName];
          if (val === null || val === undefined || val === "") {
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

    console.log(`[calculate-eda] Estatísticas numéricas: ${numericStats.length}, Categóricas: ${categoricalStats.length}`);

    // Delete existing stats and insert new ones
    await supabase.from("project_numeric_stats").delete().eq("project_id", project_id);
    await supabase.from("project_categorical_stats").delete().eq("project_id", project_id);

    if (numericStats.length > 0) {
      const { error: insertNumericError } = await supabase
        .from("project_numeric_stats")
        .insert(numericStats);
      if (insertNumericError) {
        console.error("[calculate-eda] Erro ao inserir estatísticas numéricas:", insertNumericError);
      }
    }

    if (categoricalStats.length > 0) {
      const { error: insertCategoricalError } = await supabase
        .from("project_categorical_stats")
        .insert(categoricalStats);
      if (insertCategoricalError) {
        console.error("[calculate-eda] Erro ao inserir estatísticas categóricas:", insertCategoricalError);
      }
    }

    // Update project status
    await supabase
      .from("projects")
      .update({ status: "eda_complete" })
      .eq("id", project_id);

    console.log("[calculate-eda] EDA calculada com sucesso!");

    return new Response(
      JSON.stringify({
        success: true,
        message: "EDA calculada com sucesso",
        rows_processed: records.length,
        numeric_columns: numericStats.length,
        categorical_columns: categoricalStats.length,
        delimiter_used: delimiter,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[calculate-eda] Erro inesperado:", error);
    return new Response(
      JSON.stringify({ error: "Erro interno do servidor. Tente com um arquivo menor." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
