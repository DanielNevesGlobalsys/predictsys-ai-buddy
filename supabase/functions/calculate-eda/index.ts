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

// Conservative limits to avoid WORKER_LIMIT in serverless runtime
const MAX_ROWS_TO_PROCESS = 10000; // Global max across all files
const MAX_BYTES_TO_READ = 10 * 1024 * 1024; // 10MB total across all files
const BYTES_PER_FILE = 5 * 1024 * 1024; // 5MB per individual file
const MEDIAN_SAMPLE_SIZE = 2000;
const MAX_DISTINCT_CATEGORIES = 500;

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function detectDelimiter(headerLine: string): string {
  const candidates: Array<{ d: string; count: number }> = [
    { d: ";", count: (headerLine.match(/;/g) || []).length },
    { d: ",", count: (headerLine.match(/,/g) || []).length },
    { d: "\t", count: (headerLine.match(/\t/g) || []).length },
    { d: "|", count: (headerLine.match(/\|/g) || []).length },
  ];

  candidates.sort((a, b) => b.count - a.count);
  return candidates[0]?.count ? candidates[0].d : ",";
}

function calculateMedianFromSample(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type NumericAccumulator = {
  nullCount: number;
  count: number;
  mean: number;
  M2: number;
  min: number;
  max: number;
  seen: number;
  sample: number[];
};

function createNumericAccumulator(): NumericAccumulator {
  return {
    nullCount: 0,
    count: 0,
    mean: 0,
    M2: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    seen: 0,
    sample: [],
  };
}

function addToReservoirSample(acc: NumericAccumulator, value: number) {
  acc.seen += 1;
  if (acc.sample.length < MEDIAN_SAMPLE_SIZE) {
    acc.sample.push(value);
    return;
  }
  const j = Math.floor(Math.random() * acc.seen);
  if (j < MEDIAN_SAMPLE_SIZE) acc.sample[j] = value;
}

function addNumericValue(acc: NumericAccumulator, value: number) {
  acc.count += 1;
  const delta = value - acc.mean;
  acc.mean += delta / acc.count;
  const delta2 = value - acc.mean;
  acc.M2 += delta * delta2;

  if (value < acc.min) acc.min = value;
  if (value > acc.max) acc.max = value;

  addToReservoirSample(acc, value);
}

type CategoricalAccumulator = {
  nullCount: number;
  counts: Map<string, number>;
  overflowCount: number;
};

function createCategoricalAccumulator(): CategoricalAccumulator {
  return { nullCount: 0, counts: new Map(), overflowCount: 0 };
}

function addCategoricalValue(acc: CategoricalAccumulator, raw: string | null | undefined) {
  const val = raw?.trim();
  const key = !val ? "(vazio)" : val;

  if (key === "(vazio)") acc.nullCount += 1;

  const existing = acc.counts.get(key);
  if (existing !== undefined) {
    acc.counts.set(key, existing + 1);
    return;
  }

  if (acc.counts.size >= MAX_DISTINCT_CATEGORIES) {
    acc.overflowCount += 1;
    acc.counts.set("(outros)", (acc.counts.get("(outros)") ?? 0) + 1);
    return;
  }

  acc.counts.set(key, 1);
}

/**
 * Resolve dataset path - handles both single files and batch folders
 * Returns list of file paths to process
 */
async function resolveDatasetFilePaths(
  supabase: any,
  project: any,
): Promise<string[]> {
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

    // Check if it's a batch with explicit file paths in metadata
    if (
      metadata?.file_paths &&
      Array.isArray(metadata.file_paths) &&
      metadata.file_paths.length > 0
    ) {
      console.log(`[calculate-eda] Found ${metadata.file_paths.length} file paths in metadata`);
      return metadata.file_paths;
    }

    // storage_path might be a folder (batch) or a single file
    const storagePath = dataset.storage_path;
    if (storagePath) {
      // Check if it looks like a folder (no file extension) by listing contents
      const isLikelyFolder = !storagePath.match(/\.[a-zA-Z0-9]{2,5}$/);
      
      if (isLikelyFolder) {
        // Try to list files in this folder
        const { data: files, error: listError } = await supabase.storage
          .from("datasets")
          .list(storagePath, { limit: 100 });

        if (!listError && files && files.length > 0) {
          const csvFiles = files
            .filter((f: any) => f.name && !f.name.startsWith(".") && f.name.toLowerCase().endsWith(".csv"))
            .map((f: any) => `${storagePath}/${f.name}`)
            .sort();

          if (csvFiles.length > 0) {
            console.log(`[calculate-eda] Listed ${csvFiles.length} CSV files in folder: ${storagePath}`);
            return csvFiles;
          }
        }
      }

      // Treat as single file
      console.log(`[calculate-eda] Using single file: ${storagePath}`);
      return [storagePath];
    }
  }

  // Fallback to project.dataset_filename
  if (project.dataset_filename) {
    const filename = project.dataset_filename;
    
    // Same logic: check if it's a folder
    const isLikelyFolder = !filename.match(/\.[a-zA-Z0-9]{2,5}$/);
    
    if (isLikelyFolder) {
      const { data: files, error: listError } = await supabase.storage
        .from("datasets")
        .list(filename, { limit: 100 });

      if (!listError && files && files.length > 0) {
        const csvFiles = files
          .filter((f: any) => f.name && !f.name.startsWith(".") && f.name.toLowerCase().endsWith(".csv"))
          .map((f: any) => `${filename}/${f.name}`)
          .sort();

        if (csvFiles.length > 0) {
          console.log(`[calculate-eda] Listed ${csvFiles.length} CSV files from project.dataset_filename folder`);
          return csvFiles;
        }
      }
    }

    console.log(`[calculate-eda] Using project.dataset_filename as single file: ${filename}`);
    return [filename];
  }

  return [];
}

async function createSignedDatasetUrl(supabase: any, storagePath: string): Promise<string | null> {
  const { data: signedData, error: signedError } = await supabase.storage
    .from("datasets")
    .createSignedUrl(storagePath, 60 * 60);

  if (signedError || !signedData?.signedUrl) {
    console.error(`[calculate-eda] Failed to create signed URL for ${storagePath}:`, signedError);
    return null;
  }

  return signedData.signedUrl;
}

/**
 * Process a single file with streaming, respecting global limits
 */
async function processFileStreaming(
  supabase: any,
  filePath: string,
  globalState: {
    bytesRead: number;
    rowsProcessed: number;
    delimiter: string;
    headerParsed: boolean;
    headerIndex: Map<string, number>;
    numericIndices: Array<{ idx: number; name: string }>;
    categoricalIndices: Array<{ idx: number; name: string }>;
    numericAccByName: Map<string, NumericAccumulator>;
    catAccByName: Map<string, CategoricalAccumulator>;
  },
  columnsToProcess: Array<{ column_name: string; inferred_type: string }>,
): Promise<boolean> {
  const signedUrl = await createSignedDatasetUrl(supabase, filePath);
  if (!signedUrl) {
    console.warn(`[calculate-eda] Could not get signed URL for: ${filePath}`);
    return false;
  }

  const bytesForThisFile = Math.min(BYTES_PER_FILE, MAX_BYTES_TO_READ - globalState.bytesRead);
  if (bytesForThisFile <= 0) {
    console.log(`[calculate-eda] Global byte limit reached, skipping file: ${filePath}`);
    return true;
  }

  try {
    const res = await fetch(signedUrl, {
      headers: {
        "Accept-Encoding": "identity",
        Range: `bytes=0-${bytesForThisFile - 1}`,
      },
    });

    if (!res.ok && res.status !== 206) {
      console.error(`[calculate-eda] Failed to fetch file ${filePath}: HTTP ${res.status}`);
      return false;
    }

    if (!res.body) {
      console.error(`[calculate-eda] Response has no body for ${filePath}`);
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fileBytesRead = 0;

    const numericColumns = columnsToProcess.filter((c) => c.inferred_type === "numérico");
    const categoricalColumns = columnsToProcess.filter((c) => c.inferred_type !== "numérico");

    while (
      globalState.bytesRead < MAX_BYTES_TO_READ &&
      globalState.rowsProcessed < MAX_ROWS_TO_PROCESS &&
      fileBytesRead < bytesForThisFile
    ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      fileBytesRead += value.byteLength;
      globalState.bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      let lineBreakIndex: number;
      while ((lineBreakIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, lineBreakIndex);
        buffer = buffer.slice(lineBreakIndex + 1);

        const line = rawLine.replace(/\r$/, "").trim();
        if (!line) continue;

        if (!globalState.headerParsed) {
          globalState.delimiter = detectDelimiter(line);
          const headers = parseCSVLine(line, globalState.delimiter);
          globalState.headerIndex = new Map(headers.map((h, i) => [h, i]));

          globalState.numericIndices = [];
          globalState.categoricalIndices = [];

          for (const c of numericColumns) {
            const idx = globalState.headerIndex.get(c.column_name);
            if (idx !== undefined) globalState.numericIndices.push({ idx, name: c.column_name });
          }
          for (const c of categoricalColumns) {
            const idx = globalState.headerIndex.get(c.column_name);
            if (idx !== undefined) globalState.categoricalIndices.push({ idx, name: c.column_name });
          }

          // Initialize accumulators
          for (const c of numericColumns) {
            if (!globalState.numericAccByName.has(c.column_name)) {
              globalState.numericAccByName.set(c.column_name, createNumericAccumulator());
            }
          }
          for (const c of categoricalColumns) {
            if (!globalState.catAccByName.has(c.column_name)) {
              globalState.catAccByName.set(c.column_name, createCategoricalAccumulator());
            }
          }

          console.log(
            `[calculate-eda] File ${filePath}: delimiter="${globalState.delimiter}" headers=${headers.length}`,
          );

          globalState.headerParsed = true;
          continue;
        }

        // Skip header line in subsequent files (they should have same headers)
        // We detect if this line looks like a header by checking if it matches known header names
        if (globalState.rowsProcessed === 0 || isHeaderLine(line, globalState)) {
          // For the very first file, we already parsed header above
          // For subsequent files, skip their header lines
          continue;
        }

        // Data line
        const values = parseCSVLine(line, globalState.delimiter);

        for (const { idx, name } of globalState.numericIndices) {
          const raw = values[idx];
          const acc = globalState.numericAccByName.get(name)!;

          if (!raw) {
            acc.nullCount += 1;
            continue;
          }

          const lowered = raw.toLowerCase();
          if (lowered === "nan" || lowered === "null" || lowered === "") {
            acc.nullCount += 1;
            continue;
          }

          const num = parseFloat(raw.replace(",", "."));
          if (Number.isFinite(num)) addNumericValue(acc, num);
          else acc.nullCount += 1;
        }

        for (const { idx, name } of globalState.categoricalIndices) {
          const raw = values[idx];
          const acc = globalState.catAccByName.get(name)!;
          addCategoricalValue(acc, raw);
        }

        globalState.rowsProcessed += 1;

        if (globalState.rowsProcessed >= MAX_ROWS_TO_PROCESS) break;
      }

      if (globalState.rowsProcessed >= MAX_ROWS_TO_PROCESS) break;
      if (globalState.bytesRead >= MAX_BYTES_TO_READ) break;
    }

    try {
      await reader.cancel();
    } catch {
      // ignore
    }

    decoder.decode(); // flush

    return true;
  } catch (error) {
    console.error(`[calculate-eda] Error processing file ${filePath}:`, error);
    return false;
  }
}

/**
 * Check if a line looks like a header (for subsequent files in batch)
 */
function isHeaderLine(line: string, globalState: { headerIndex: Map<string, number>; delimiter: string }): boolean {
  const values = parseCSVLine(line, globalState.delimiter);
  if (values.length === 0) return false;
  
  // Count how many values match known header names
  let matches = 0;
  for (const val of values) {
    if (globalState.headerIndex.has(val)) matches++;
  }
  
  // If more than 50% of values match header names, it's likely a header
  return matches > values.length * 0.5;
}

/**
 * Compute EDA from multiple files with global limits
 */
async function computeEDAFromFiles(
  supabase: any,
  projectId: string,
  filePaths: string[],
  columnsToProcess: Array<{ column_name: string; inferred_type: string }>,
): Promise<{
  delimiter: string;
  rowsProcessed: number;
  numericStats: NumericStats[];
  categoricalStats: CategoricalStats[];
  filesProcessed: number;
} | null> {
  console.log(
    `[calculate-eda] Processing ${filePaths.length} files with limits: rows=${MAX_ROWS_TO_PROCESS}, bytes=${MAX_BYTES_TO_READ}`,
  );

  const numericColumns = columnsToProcess.filter((c) => c.inferred_type === "numérico");
  const categoricalColumns = columnsToProcess.filter((c) => c.inferred_type !== "numérico");

  const globalState = {
    bytesRead: 0,
    rowsProcessed: 0,
    delimiter: ",",
    headerParsed: false,
    headerIndex: new Map<string, number>(),
    numericIndices: [] as Array<{ idx: number; name: string }>,
    categoricalIndices: [] as Array<{ idx: number; name: string }>,
    numericAccByName: new Map<string, NumericAccumulator>(),
    catAccByName: new Map<string, CategoricalAccumulator>(),
  };

  let filesProcessed = 0;

  for (const filePath of filePaths) {
    if (globalState.rowsProcessed >= MAX_ROWS_TO_PROCESS) {
      console.log(`[calculate-eda] Reached row limit, stopping at ${filesProcessed} files`);
      break;
    }
    if (globalState.bytesRead >= MAX_BYTES_TO_READ) {
      console.log(`[calculate-eda] Reached byte limit, stopping at ${filesProcessed} files`);
      break;
    }

    console.log(`[calculate-eda] Processing file ${filesProcessed + 1}/${filePaths.length}: ${filePath}`);

    const success = await processFileStreaming(supabase, filePath, globalState, columnsToProcess);
    if (success) {
      filesProcessed++;
    }
  }

  if (!globalState.headerParsed) {
    console.error(`[calculate-eda] Failed to parse any CSV headers`);
    return null;
  }

  console.log(
    `[calculate-eda] Completed: rows=${globalState.rowsProcessed}, bytes=${globalState.bytesRead}, files=${filesProcessed}`,
  );

  // Build final stats
  const numericStats: NumericStats[] = [];
  for (const c of numericColumns) {
    const acc = globalState.numericAccByName.get(c.column_name);

    if (!acc || acc.count === 0) {
      numericStats.push({
        project_id: projectId,
        column_name: c.column_name,
        min_value: null,
        max_value: null,
        mean_value: null,
        median_value: null,
        std_value: null,
        null_count: globalState.rowsProcessed,
      });
      continue;
    }

    const mean = acc.mean;
    const std = acc.count >= 2 ? Math.sqrt(acc.M2 / (acc.count - 1)) : null;

    numericStats.push({
      project_id: projectId,
      column_name: c.column_name,
      min_value: Number.isFinite(acc.min) ? acc.min : null,
      max_value: Number.isFinite(acc.max) ? acc.max : null,
      mean_value: Math.round(mean * 1000) / 1000,
      median_value: calculateMedianFromSample(acc.sample),
      std_value: std === null ? null : Math.round(std * 1000) / 1000,
      null_count: acc.nullCount,
    });
  }

  const categoricalStats: CategoricalStats[] = [];
  for (const c of categoricalColumns) {
    const acc = globalState.catAccByName.get(c.column_name);

    if (!acc) {
      categoricalStats.push({
        project_id: projectId,
        column_name: c.column_name,
        distinct_count: 0,
        top_categories: [],
      });
      continue;
    }

    const sortedTop = [...acc.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([category, count]) => ({ category, count }));

    categoricalStats.push({
      project_id: projectId,
      column_name: c.column_name,
      distinct_count: acc.counts.size,
      top_categories: sortedTop,
    });
  }

  return {
    delimiter: globalState.delimiter,
    rowsProcessed: globalState.rowsProcessed,
    numericStats,
    categoricalStats,
    filesProcessed,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[calculate-eda] Calculando EDA para projeto: ${project_id}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      console.error("[calculate-eda] Projeto não encontrado:", projectError);
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const filePaths = await resolveDatasetFilePaths(supabase, project);
    if (filePaths.length === 0) {
      console.error("[calculate-eda] Nenhum arquivo de dataset encontrado");
      return new Response(
        JSON.stringify({ error: "Nenhum dataset carregado para este projeto. Faça upload de dados primeiro." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log(`[calculate-eda] Found ${filePaths.length} file(s) to process`);

    // Get column metadata
    const { data: columns, error: columnsError } = await supabase
      .from("project_columns")
      .select("column_name,inferred_type,column_index")
      .eq("project_id", project_id)
      .order("column_index");

    if (columnsError) {
      console.error("[calculate-eda] Erro ao buscar colunas:", columnsError);
    }

    const columnsToProcess =
      columns && columns.length > 0
        ? columns.map((c: any) => ({ column_name: c.column_name, inferred_type: c.inferred_type }))
        : [];

    if (columnsToProcess.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            "Metadados de colunas não encontrados. Refaça o upload/ingestão para gerar as colunas antes de calcular EDA.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const eda = await computeEDAFromFiles(supabase, project_id, filePaths, columnsToProcess);

    if (!eda) {
      console.error(`[calculate-eda] Falha ao processar arquivos do dataset`);
      return new Response(
        JSON.stringify({
          error: "Falha ao processar amostra do CSV. Verifique se os arquivos estão acessíveis e bem formatados.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { numericStats, categoricalStats, rowsProcessed, delimiter, filesProcessed } = eda;

    console.log(
      `[calculate-eda] Computed stats => rows=${rowsProcessed} numeric=${numericStats.length} categorical=${categoricalStats.length} files=${filesProcessed}`,
    );

    // Delete existing stats and insert new ones
    await supabase.from("project_numeric_stats").delete().eq("project_id", project_id);
    await supabase.from("project_categorical_stats").delete().eq("project_id", project_id);

    if (numericStats.length > 0) {
      const { error: insertNumericError } = await supabase.from("project_numeric_stats").insert(numericStats);
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

    await supabase.from("projects").update({ status: "eda_complete" }).eq("id", project_id);

    return new Response(
      JSON.stringify({
        success: true,
        message: "EDA calculada com sucesso",
        rows_processed: rowsProcessed,
        files_processed: filesProcessed,
        numeric_columns: numericStats.length,
        categorical_columns: categoricalStats.length,
        delimiter_used: delimiter,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[calculate-eda] Erro inesperado:", error);
    return new Response(JSON.stringify({ error: "Erro interno do servidor. Tente novamente." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
