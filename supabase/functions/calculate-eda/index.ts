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

// Keep these conservative to avoid CPU/memory limits in serverless runtime.
const MAX_ROWS_TO_PROCESS = 5000;
const SAMPLE_BYTES_LIMIT = 3 * 1024 * 1024; // 3MB
const MEDIAN_SAMPLE_SIZE = 2000;
const MAX_DISTINCT_CATEGORIES = 500;

// CSV parser that respects delimiter + quotes.
// NOTE: This is a pragmatic parser for EDA sampling; it does not implement full RFC4180.
function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      // Handle escaped double quotes "" inside quoted strings
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
  // Support common delimiters
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
  // Reservoir sample for approx median
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
  // Welford online mean/std
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

  // Cap cardinality to avoid unbounded memory for high-cardinality columns.
  if (acc.counts.size >= MAX_DISTINCT_CATEGORIES) {
    acc.overflowCount += 1;
    acc.counts.set("(outros)", (acc.counts.get("(outros)") ?? 0) + 1);
    return;
  }

  acc.counts.set(key, 1);
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
    if (
      metadata?.file_paths &&
      Array.isArray(metadata.file_paths) &&
      metadata.file_paths.length > 0
    ) {
      console.log(`[calculate-eda] Dataset has ${metadata.file_paths.length} file paths`);
      return {
        path: metadata.file_paths[0],
        filePaths: metadata.file_paths,
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
 * Stream + sample only first N bytes, stop after N rows.
 * Avoid building a full "records" array (big memory spike).
 */
async function computeEDAFromCSVSample(
  supabase: any,
  projectId: string,
  storagePath: string,
  columnsToProcess: Array<{ column_name: string; inferred_type: string }>,
): Promise<{
  delimiter: string;
  rowsProcessed: number;
  numericStats: NumericStats[];
  categoricalStats: CategoricalStats[];
} | null> {
  const signedUrl = await createSignedDatasetUrl(supabase, storagePath);
  if (!signedUrl) return null;

  console.log(
    `[calculate-eda] Sampling limits => bytes=${SAMPLE_BYTES_LIMIT}, rows=${MAX_ROWS_TO_PROCESS}, medianSample=${MEDIAN_SAMPLE_SIZE}`,
  );

  const res = await fetch(signedUrl, {
    headers: {
      "Accept-Encoding": "identity",
      Range: `bytes=0-${SAMPLE_BYTES_LIMIT - 1}`,
    },
  });

  // Some storages may ignore Range and return 200. That is OK; we will stop reading after SAMPLE_BYTES_LIMIT anyway.
  if (!res.ok) {
    console.error(`[calculate-eda] Failed to fetch file: HTTP ${res.status}`);
    return null;
  }

  if (!res.body) {
    console.error(`[calculate-eda] Response has no body`);
    return null;
  }

  // Build fast lookup from column name to accumulator.
  const numericColumns = columnsToProcess.filter((c) => c.inferred_type === "numérico");
  const categoricalColumns = columnsToProcess.filter((c) => c.inferred_type !== "numérico");

  const numericAccByName = new Map<string, NumericAccumulator>();
  for (const c of numericColumns) numericAccByName.set(c.column_name, createNumericAccumulator());

  const catAccByName = new Map<string, CategoricalAccumulator>();
  for (const c of categoricalColumns) catAccByName.set(c.column_name, createCategoricalAccumulator());

  // Header resolution
  let delimiter = ",";
  let headerParsed = false;
  let headerIndex = new Map<string, number>();
  let numericIndices: Array<{ idx: number; name: string }> = [];
  let categoricalIndices: Array<{ idx: number; name: string }> = [];

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";
  let bytesRead = 0;
  let rowsProcessed = 0;

  const stopEarly = async () => {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  };

  while (bytesRead < SAMPLE_BYTES_LIMIT && rowsProcessed < MAX_ROWS_TO_PROCESS) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    bytesRead += value.byteLength;
    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    let lineBreakIndex: number;
    while ((lineBreakIndex = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, lineBreakIndex);
      buffer = buffer.slice(lineBreakIndex + 1);

      const line = rawLine.replace(/\r$/, "").trim();
      if (!line) continue;

      if (!headerParsed) {
        delimiter = detectDelimiter(line);
        const headers = parseCSVLine(line, delimiter);
        headerIndex = new Map(headers.map((h, i) => [h, i]));

        // Precompute indices for columns we care about
        numericIndices = [];
        categoricalIndices = [];

        for (const c of numericColumns) {
          const idx = headerIndex.get(c.column_name);
          if (idx !== undefined) numericIndices.push({ idx, name: c.column_name });
        }
        for (const c of categoricalColumns) {
          const idx = headerIndex.get(c.column_name);
          if (idx !== undefined) categoricalIndices.push({ idx, name: c.column_name });
        }

        console.log(
          `[calculate-eda] Detected delimiter: "${delimiter}" | headers=${headers.length} | numericCols=${numericIndices.length} | catCols=${categoricalIndices.length}`,
        );

        headerParsed = true;
        continue;
      }

      // Data line
      const values = parseCSVLine(line, delimiter);

      for (const { idx, name } of numericIndices) {
        const raw = values[idx];
        const acc = numericAccByName.get(name)!;

        if (!raw) {
          acc.nullCount += 1;
          continue;
        }

        const lowered = raw.toLowerCase();
        if (lowered === "nan" || lowered === "null") {
          acc.nullCount += 1;
          continue;
        }

        const num = parseFloat(raw.replace(",", "."));
        if (Number.isFinite(num)) addNumericValue(acc, num);
        else acc.nullCount += 1;
      }

      for (const { idx, name } of categoricalIndices) {
        const raw = values[idx];
        const acc = catAccByName.get(name)!;
        addCategoricalValue(acc, raw);
      }

      rowsProcessed += 1;
      if (rowsProcessed >= MAX_ROWS_TO_PROCESS) break;
    }

    // If the chunk put us over the byte budget, stop.
    if (bytesRead >= SAMPLE_BYTES_LIMIT) break;
  }

  await stopEarly();
  decoder.decode(); // flush

  if (!headerParsed) {
    console.error(`[calculate-eda] Failed to parse CSV header from sample`);
    return null;
  }

  console.log(`[calculate-eda] Sampled rows=${rowsProcessed}, bytesRead=${bytesRead}`);

  const numericStats: NumericStats[] = [];
  for (const c of numericColumns) {
    const acc = numericAccByName.get(c.column_name)!;

    if (acc.count === 0) {
      numericStats.push({
        project_id: projectId,
        column_name: c.column_name,
        min_value: null,
        max_value: null,
        mean_value: null,
        median_value: null,
        std_value: null,
        null_count: rowsProcessed, // best-effort
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
    const acc = catAccByName.get(c.column_name)!;

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

  return { delimiter, rowsProcessed, numericStats, categoricalStats };
}

Deno.serve(async (req) => {
  // Handle CORS preflight
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

    // Get project info
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

    const pathInfo = await resolveDatasetPath(supabase, project);
    if (!pathInfo) {
      console.error("[calculate-eda] Nenhum dataset encontrado para o projeto");
      return new Response(JSON.stringify({ error: "Nenhum dataset carregado para este projeto" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[calculate-eda] Resolved dataset path: ${pathInfo.path}`);

    // Get column metadata (prefer DB-inferred types)
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
      // Without column metadata, EDA would require processing all headers; that can be expensive.
      // Return a clear message instead of timing out.
      return new Response(
        JSON.stringify({
          error:
            "Metadados de colunas não encontrados. Refaça o upload/ingestão para gerar as colunas antes de calcular EDA.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const eda = await computeEDAFromCSVSample(supabase, project_id, pathInfo.path, columnsToProcess);

    if (!eda) {
      console.error(`[calculate-eda] Falha ao processar amostra: ${pathInfo.path}`);
      return new Response(
        JSON.stringify({
          error: "Falha ao processar amostra do CSV. Verifique se o arquivo está acessível e bem formatado.",
          details: { path: pathInfo.path, bucket: "datasets" },
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { numericStats, categoricalStats, rowsProcessed, delimiter } = eda;

    console.log(
      `[calculate-eda] Computed stats => rows=${rowsProcessed} numeric=${numericStats.length} categorical=${categoricalStats.length}`,
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
        numeric_columns: numericStats.length,
        categorical_columns: categoricalStats.length,
        delimiter_used: delimiter,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[calculate-eda] Erro inesperado:", error);
    return new Response(JSON.stringify({ error: "Erro interno do servidor. Tente com um arquivo menor." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
