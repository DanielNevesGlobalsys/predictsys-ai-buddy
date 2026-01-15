import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { applyFeatureTransforms, type ProjectFeature, type RawRecord } from "../_shared/feature-engineering.ts";

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
// These are tuned to work reliably with 10GB datasets
const MAX_ROWS_TO_PROCESS = 50000; // Global max across all files - enough for good stats
const MAX_BYTES_TO_READ = 25 * 1024 * 1024; // 25MB total - safe limit for edge function
const BYTES_PER_FILE = 15 * 1024 * 1024; // 15MB per individual file
const MEDIAN_SAMPLE_SIZE = 5000; // Reservoir sample size for median calculation
const MAX_DISTINCT_CATEGORIES = 500; // Limit distinct values tracked for categories

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

// Welford's online algorithm for streaming mean and variance
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

// Reservoir sampling for median estimation
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
  
  // Welford's algorithm for online mean/variance
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
): Promise<{ paths: string[]; delimiter: string; encoding: string }> {
  const projectId = project.id;
  let delimiter = ",";
  let encoding = "UTF-8";

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

    // Extract delimiter and encoding from metadata if available
    if (metadata?.delimiter) delimiter = metadata.delimiter;
    if (metadata?.encoding) encoding = metadata.encoding;

    // Check if it's a batch with explicit file paths in metadata
    if (
      metadata?.file_paths &&
      Array.isArray(metadata.file_paths) &&
      metadata.file_paths.length > 0
    ) {
      console.log(`[calculate-eda] Found ${metadata.file_paths.length} file paths in metadata`);
      return { paths: metadata.file_paths, delimiter, encoding };
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
            return { paths: csvFiles, delimiter, encoding };
          }
        }
      }

      // Treat as single file
      console.log(`[calculate-eda] Using single file: ${storagePath}`);
      return { paths: [storagePath], delimiter, encoding };
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
          return { paths: csvFiles, delimiter, encoding };
        }
      }
    }

    console.log(`[calculate-eda] Using project.dataset_filename as single file: ${filename}`);
    return { paths: [filename], delimiter, encoding };
  }

  return { paths: [], delimiter, encoding };
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

function makeTextDecoder(encoding: string): TextDecoder {
  const encodingMap: Record<string, string> = {
    "ISO-8859-1": "iso-8859-1",
    "Windows-1252": "windows-1252",
    "UTF-8": "utf-8",
  };
  return new TextDecoder(encodingMap[encoding] || "utf-8");
}

/**
 * Check if a line looks like a header (for subsequent files in batch)
 */
function isHeaderLine(line: string, headerIndex: Map<string, number>, delimiter: string): boolean {
  const values = parseCSVLine(line, delimiter);
  if (values.length === 0) return false;
  
  let matches = 0;
  for (const val of values) {
    if (headerIndex.has(val)) matches++;
  }
  
  // If more than 60% of values match header names, it's likely a header
  return matches > values.length * 0.6;
}

/**
 * Process a single file with streaming, respecting global limits
 * Now supports feature engineering - computed features are accumulated alongside raw columns
 */
async function processFileStreaming(
  supabase: any,
  filePath: string,
  globalState: {
    bytesRead: number;
    rowsProcessed: number;
    delimiter: string;
    encoding: string;
    headerParsed: boolean;
    headerIndex: Map<string, number>;
    numericIndices: Array<{ idx: number; name: string }>;
    categoricalIndices: Array<{ idx: number; name: string }>;
    numericAccByName: Map<string, NumericAccumulator>;
    catAccByName: Map<string, CategoricalAccumulator>;
    featureAccByName: Map<string, NumericAccumulator>;
  },
  columnsToProcess: Array<{ column_name: string; inferred_type: string; is_feature?: boolean }>,
  enabledFeatures: ProjectFeature[] = [],
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
    const decoder = makeTextDecoder(globalState.encoding);
    let buffer = "";
    let fileBytesRead = 0;
    let isFirstLineOfFile = !globalState.headerParsed;

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

        // Parse header from first file
        if (!globalState.headerParsed) {
          // Auto-detect delimiter if not set
          if (!globalState.delimiter || globalState.delimiter === ",") {
            globalState.delimiter = detectDelimiter(line);
          }
          
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

          // Initialize accumulators for ALL columns
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
            `[calculate-eda] File ${filePath}: delimiter="${globalState.delimiter}" headers=${headers.length} ` +
            `numericCols=${globalState.numericIndices.length} catCols=${globalState.categoricalIndices.length}`,
          );

          globalState.headerParsed = true;
          isFirstLineOfFile = false;
          continue;
        }

        // For subsequent files in batch, skip their header lines
        if (isFirstLineOfFile) {
          if (isHeaderLine(line, globalState.headerIndex, globalState.delimiter)) {
            console.log(`[calculate-eda] Skipping header line in subsequent file: ${filePath}`);
            isFirstLineOfFile = false;
            continue;
          }
          isFirstLineOfFile = false;
        }

        // Data line - parse and accumulate stats
        const values = parseCSVLine(line, globalState.delimiter);

        // Process numeric columns
        for (const { idx, name } of globalState.numericIndices) {
          const raw = values[idx];
          const acc = globalState.numericAccByName.get(name);
          if (!acc) continue;

          if (!raw || raw.trim() === "") {
            acc.nullCount += 1;
            continue;
          }

          const lowered = raw.toLowerCase().trim();
          if (lowered === "nan" || lowered === "null" || lowered === "na" || lowered === "-") {
            acc.nullCount += 1;
            continue;
          }

          // Parse number, handling comma as decimal separator
          const num = parseFloat(raw.replace(",", "."));
          if (Number.isFinite(num)) {
            addNumericValue(acc, num);
          } else {
            acc.nullCount += 1;
          }
        }

        // Process categorical columns
        for (const { idx, name } of globalState.categoricalIndices) {
          const raw = values[idx];
          const acc = globalState.catAccByName.get(name);
          if (acc) {
            addCategoricalValue(acc, raw);
          }
        }

        // Process feature engineering - apply transforms to this row
        if (enabledFeatures.length > 0) {
          // Build raw record from values
          const rawRecord: RawRecord = {};
          for (const [headerName, headerIdx] of globalState.headerIndex.entries()) {
            rawRecord[headerName] = values[headerIdx] ?? null;
          }
          
          // Apply feature transforms
          const featureValues = applyFeatureTransforms(rawRecord, enabledFeatures);
          
          // Accumulate feature stats
          for (const [featureName, featureValue] of Object.entries(featureValues)) {
            const acc = globalState.featureAccByName.get(featureName);
            if (!acc) continue;
            
            if (featureValue === null || featureValue === undefined) {
              acc.nullCount += 1;
              continue;
            }
            
            const num = typeof featureValue === "number" ? featureValue : parseFloat(String(featureValue));
            if (Number.isFinite(num)) {
              addNumericValue(acc, num);
            } else {
              acc.nullCount += 1;
            }
          }
        }

        globalState.rowsProcessed += 1;

        if (globalState.rowsProcessed >= MAX_ROWS_TO_PROCESS) break;
      }

      if (globalState.rowsProcessed >= MAX_ROWS_TO_PROCESS) break;
      if (globalState.bytesRead >= MAX_BYTES_TO_READ) break;
    }

    try {
      await reader.cancel();
    } catch { /* ignore */ }

    decoder.decode(); // flush

    return true;
  } catch (error) {
    console.error(`[calculate-eda] Error processing file ${filePath}:`, error);
    return false;
  }
}

/**
 * Compute EDA from multiple files with global limits
 * Now supports feature engineering - computed features are included in stats
 */
async function computeEDAFromFiles(
  supabase: any,
  projectId: string,
  filePaths: string[],
  columnsToProcess: Array<{ column_name: string; inferred_type: string; is_feature?: boolean }>,
  delimiter: string,
  encoding: string,
  enabledFeatures: ProjectFeature[] = [],
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

  // Split original columns vs feature columns
  const originalColumns = columnsToProcess.filter((c) => !c.is_feature);
  const featureColumns = columnsToProcess.filter((c) => c.is_feature);
  
  const numericColumns = originalColumns.filter((c) => c.inferred_type === "numérico");
  const categoricalColumns = originalColumns.filter((c) => c.inferred_type !== "numérico");

  const globalState = {
    bytesRead: 0,
    rowsProcessed: 0,
    delimiter: delimiter,
    encoding: encoding,
    headerParsed: false,
    headerIndex: new Map<string, number>(),
    numericIndices: [] as Array<{ idx: number; name: string }>,
    categoricalIndices: [] as Array<{ idx: number; name: string }>,
    numericAccByName: new Map<string, NumericAccumulator>(),
    catAccByName: new Map<string, CategoricalAccumulator>(),
    featureAccByName: new Map<string, NumericAccumulator>(),
  };

  // Initialize accumulators for feature columns
  for (const fc of featureColumns) {
    globalState.featureAccByName.set(fc.column_name, createNumericAccumulator());
  }

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

    const success = await processFileStreaming(supabase, filePath, globalState, originalColumns, enabledFeatures);
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

  // Build final numeric stats
  const numericStats: NumericStats[] = [];
  for (const c of numericColumns) {
    const acc = globalState.numericAccByName.get(c.column_name);

    if (!acc || acc.count === 0) {
      // No valid numeric values found - still record the column with nulls
      numericStats.push({
        project_id: projectId,
        column_name: c.column_name,
        min_value: null,
        max_value: null,
        mean_value: null,
        median_value: null,
        std_value: null,
        null_count: acc?.nullCount ?? globalState.rowsProcessed,
      });
      continue;
    }

    const mean = acc.mean;
    const variance = acc.count >= 2 ? acc.M2 / (acc.count - 1) : 0;
    const std = variance > 0 ? Math.sqrt(variance) : null;
    const median = calculateMedianFromSample(acc.sample);

    numericStats.push({
      project_id: projectId,
      column_name: c.column_name,
      min_value: Number.isFinite(acc.min) ? Math.round(acc.min * 10000) / 10000 : null,
      max_value: Number.isFinite(acc.max) ? Math.round(acc.max * 10000) / 10000 : null,
      mean_value: Number.isFinite(mean) ? Math.round(mean * 10000) / 10000 : null,
      median_value: median !== null ? Math.round(median * 10000) / 10000 : null,
      std_value: std !== null && Number.isFinite(std) ? Math.round(std * 10000) / 10000 : null,
      null_count: acc.nullCount,
    });
  }

  // Add feature stats to numeric stats (features always produce numeric values)
  for (const [featureName, acc] of globalState.featureAccByName.entries()) {
    if (!acc || acc.count === 0) {
      numericStats.push({
        project_id: projectId,
        column_name: featureName,
        min_value: null,
        max_value: null,
        mean_value: null,
        median_value: null,
        std_value: null,
        null_count: acc?.nullCount ?? globalState.rowsProcessed,
      });
      continue;
    }

    const mean = acc.mean;
    const variance = acc.count >= 2 ? acc.M2 / (acc.count - 1) : 0;
    const std = variance > 0 ? Math.sqrt(variance) : null;
    const median = calculateMedianFromSample(acc.sample);

    numericStats.push({
      project_id: projectId,
      column_name: featureName,
      min_value: Number.isFinite(acc.min) ? Math.round(acc.min * 10000) / 10000 : null,
      max_value: Number.isFinite(acc.max) ? Math.round(acc.max * 10000) / 10000 : null,
      mean_value: Number.isFinite(mean) ? Math.round(mean * 10000) / 10000 : null,
      median_value: median !== null ? Math.round(median * 10000) / 10000 : null,
      std_value: std !== null && Number.isFinite(std) ? Math.round(std * 10000) / 10000 : null,
      null_count: acc.nullCount,
    });
  }

  // Build final categorical stats
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

    const { paths: filePaths, delimiter, encoding } = await resolveDatasetFilePaths(supabase, project);
    
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

    console.log(`[calculate-eda] Found ${filePaths.length} file(s) to process, delimiter="${delimiter}", encoding="${encoding}"`);

    // Get column metadata from project_columns (populated by process-import)
    const { data: columns, error: columnsError } = await supabase
      .from("project_columns")
      .select("column_name,inferred_type,column_index")
      .eq("project_id", project_id)
      .order("column_index");

    if (columnsError) {
      console.error("[calculate-eda] Erro ao buscar colunas:", columnsError);
    }

    // Get project features for feature engineering
    const { data: projectFeatures, error: featuresError } = await supabase
      .from("project_features")
      .select("*")
      .eq("project_id", project_id)
      .eq("enabled", true);

    if (featuresError) {
      console.error("[calculate-eda] Erro ao buscar features:", featuresError);
    }

    const enabledFeatures: ProjectFeature[] = (projectFeatures || []).map((f: any) => ({
      id: f.id,
      project_id: f.project_id,
      name: f.name,
      label: f.label,
      description: f.description,
      enabled: f.enabled,
      expression: f.expression,
    }));

    console.log(`[calculate-eda] Found ${enabledFeatures.length} enabled features`);

    // Build columns to process - include original columns + feature columns
    let columnsToProcess =
      columns && columns.length > 0
        ? columns.map((c: any) => ({ column_name: c.column_name, inferred_type: c.inferred_type, is_feature: false }))
        : [];

    // Add feature columns as numeric (features always produce numeric values)
    for (const feature of enabledFeatures) {
      columnsToProcess.push({
        column_name: feature.name,
        inferred_type: "numérico",
        is_feature: true,
      });
    }

    if (columnsToProcess.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            "Metadados de colunas não encontrados. Refaça o upload/ingestão para gerar as colunas antes de calcular EDA.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[calculate-eda] Processing ${columnsToProcess.length} columns: ` +
      `${columnsToProcess.filter((c: any) => c.inferred_type === "numérico").length} numeric, ` +
      `${columnsToProcess.filter((c: any) => c.inferred_type !== "numérico").length} categorical`);

    const eda = await computeEDAFromFiles(supabase, project_id, filePaths, columnsToProcess, delimiter, encoding, enabledFeatures);

    if (!eda) {
      console.error(`[calculate-eda] Falha ao processar arquivos do dataset`);
      return new Response(
        JSON.stringify({
          error: "Falha ao processar amostra do CSV. Verifique se os arquivos estão acessíveis e bem formatados.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { numericStats, categoricalStats, rowsProcessed, filesProcessed } = eda;

    console.log(
      `[calculate-eda] Computed stats => rows=${rowsProcessed} numeric=${numericStats.length} categorical=${categoricalStats.length} files=${filesProcessed}`,
    );

    // Log sample of numeric stats for debugging
    const sampleNumeric = numericStats.slice(0, 3).map(s => 
      `${s.column_name}: min=${s.min_value}, max=${s.max_value}, mean=${s.mean_value}, nulls=${s.null_count}`
    );
    console.log(`[calculate-eda] Sample numeric stats: ${sampleNumeric.join(" | ")}`);

    // Delete existing stats and insert new ones
    await supabase.from("project_numeric_stats").delete().eq("project_id", project_id);
    await supabase.from("project_categorical_stats").delete().eq("project_id", project_id);

    if (numericStats.length > 0) {
      const { error: insertNumericError } = await supabase.from("project_numeric_stats").insert(numericStats);
      if (insertNumericError) {
        console.error("[calculate-eda] Erro ao inserir estatísticas numéricas:", insertNumericError);
      } else {
        console.log(`[calculate-eda] Inserted ${numericStats.length} numeric stats`);
      }
    }

    if (categoricalStats.length > 0) {
      const { error: insertCategoricalError } = await supabase
        .from("project_categorical_stats")
        .insert(categoricalStats);
      if (insertCategoricalError) {
        console.error("[calculate-eda] Erro ao inserir estatísticas categóricas:", insertCategoricalError);
      } else {
        console.log(`[calculate-eda] Inserted ${categoricalStats.length} categorical stats`);
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
        delimiter_used: eda.delimiter,
        sampled: rowsProcessed < (project.total_rows || 0),
        total_rows: project.total_rows || rowsProcessed,
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
