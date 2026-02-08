import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parquetRead } from "npm:hyparquet@1.24.1";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const SAMPLE_SIZE = 10000;
const SAMPLE_BYTES_LIMIT = 50 * 1024 * 1024; // 50 MB for CSV sampling
const PARQUET_MEMORY_LIMIT = 400 * 1024 * 1024; // 400 MB for Parquet in-memory
const RETRY_MAX = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════
interface ImportJob {
  id: string;
  project_id: string;
  user_id: string;
  file_name: string;
  file_size_bytes: number;
  storage_path: string;
  delimiter: string;
  encoding: string;
  status: string;
  batch_id: string | null;
  batch_sequence: number;
  is_batch_primary: boolean;
  headers_json: string[] | null;
  headers_hash: string | null;
  dataset_id: string | null;
}

type FileFormat = "csv" | "parquet" | "excel" | "json";

interface FileSchema {
  columns: string[];
  columnTypes: Record<string, string>;
  totalRows: number;
  sampleRows: Record<string, unknown>[];
  format: FileFormat;
  schemaHash: string;
}

interface FileProcessResult {
  success: boolean;
  jobId: string;
  fileName: string;
  format: FileFormat;
  schema?: FileSchema;
  error?: string;
  rowsRead: number;
  coveragePct: number;
}

interface CanonicalSchema {
  columns: string[];
  columnTypes: Record<string, string>;
  sourceFiles: number;
}

// ═══════════════════════════════════════════════════════════
// Utility: Retry with exponential backoff
// ═══════════════════════════════════════════════════════════
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = RETRY_MAX,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[process-import] ${label} attempt ${attempt}/${maxRetries} failed: ${lastError.message}. Retrying in ${delay}ms...`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

// ═══════════════════════════════════════════════════════════
// Utility: Detect file format
// ═══════════════════════════════════════════════════════════
function detectFileFormat(fileName: string, storagePath: string): FileFormat {
  const ext = (fileName || storagePath).split(".").pop()?.toLowerCase() || "";
  if (["parquet", "parq", "pq"].includes(ext)) return "parquet";
  if (["xlsx", "xls"].includes(ext)) return "excel";
  if (ext === "json") return "json";
  return "csv";
}

// ═══════════════════════════════════════════════════════════
// Utility: Generate schema hash (for column-set comparison)
// ═══════════════════════════════════════════════════════════
function generateSchemaHash(columns: string[]): string {
  return columns.map(c => c.toLowerCase().trim()).sort().join("|");
}

// ═══════════════════════════════════════════════════════════
// Utility: Safe signed URL with retry
// ═══════════════════════════════════════════════════════════
async function getSignedUrl(supabase: any, storagePath: string): Promise<string> {
  return withRetry(async () => {
    const { data, error } = await supabase.storage
      .from("big_imports")
      .createSignedUrl(storagePath, 60 * 60);
    if (error || !data?.signedUrl) {
      throw new Error(`Falha ao gerar URL assinada: ${error?.message || "erro desconhecido"}`);
    }
    return data.signedUrl;
  }, `signedUrl(${storagePath})`);
}

// ═══════════════════════════════════════════════════════════
// Utility: Download file with retry
// ═══════════════════════════════════════════════════════════
async function downloadFile(
  url: string,
  opts?: { rangeEnd?: number },
): Promise<Response> {
  return withRetry(async () => {
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (opts?.rangeEnd) {
      headers["Range"] = `bytes=0-${opts.rangeEnd - 1}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status} ao baixar arquivo`);
    }
    return res;
  }, "download");
}

// ═══════════════════════════════════════════════════════════
// CSV Parser
// ═══════════════════════════════════════════════════════════
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
      } else {
        inQuotes = !inQuotes;
      }
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

function autoDetectDelimiter(headerLine: string): string {
  const delimiters = [",", ";", "\t", "|"];
  let best = ",";
  let maxCount = 0;
  for (const d of delimiters) {
    const count = (headerLine.match(new RegExp(`\\${d}`, "g")) || []).length;
    if (count > maxCount) {
      maxCount = count;
      best = d;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════
// Format-specific schema extraction
// ═══════════════════════════════════════════════════════════

async function extractSchemaCSV(
  supabase: any,
  job: ImportJob,
  onProgress?: (p: number, r: number) => Promise<void>,
): Promise<FileSchema> {
  const signedUrl = await getSignedUrl(supabase, job.storage_path);
  const bytesToFetch = Math.min(job.file_size_bytes, SAMPLE_BYTES_LIMIT);
  const res = await downloadFile(signedUrl, { rangeEnd: bytesToFetch });

  if (!res.body) throw new Error("Resposta sem body");

  const delimiter = job.delimiter && job.delimiter !== "," ? job.delimiter : undefined;
  const encoding = job.encoding || "UTF-8";
  const encodingMap: Record<string, string> = {
    "ISO-8859-1": "iso-8859-1",
    "Windows-1252": "windows-1252",
    "UTF-8": "utf-8",
  };
  const decoder = new TextDecoder(encodingMap[encoding] || "utf-8");

  let headers: string[] = [];
  let rowCount = 0;
  const sampleRows: Record<string, unknown>[] = [];
  let isHeaderLine = true;
  let totalBytesRead = 0;
  let bytesForRows = 0;
  let detectedDelimiter = delimiter || ",";
  let lastProgressUpdate = Date.now();

  const reader = res.body.getReader();
  let leftover = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytesRead += value.byteLength;
      leftover += decoder.decode(value, { stream: true });

      let nlIndex = -1;
      while ((nlIndex = leftover.indexOf("\n")) !== -1) {
        const rawLine = leftover.slice(0, nlIndex);
        leftover = leftover.slice(nlIndex + 1);
        const line = rawLine.replace(/\r$/, "");
        if (!line.trim()) continue;

        if (isHeaderLine) {
          // Auto-detect delimiter if not explicitly set
          if (!delimiter) {
            detectedDelimiter = autoDetectDelimiter(line);
          }
          headers = parseCSVLine(line, detectedDelimiter);
          isHeaderLine = false;

          // Validate column count consistency with first 5 data lines
          console.log(`[process-import] CSV headers: ${headers.length} cols, delimiter="${detectedDelimiter}"`);
          continue;
        }

        rowCount++;
        bytesForRows += rawLine.length + 1;

        if (sampleRows.length < SAMPLE_SIZE) {
          const values = parseCSVLine(line, detectedDelimiter);
          
          // Check for misaligned rows (different column count)
          if (values.length !== headers.length && sampleRows.length < 5) {
            console.warn(`[process-import] CSV row ${rowCount}: expected ${headers.length} cols, got ${values.length}`);
          }

          const row: Record<string, unknown> = {};
          headers.forEach((h, idx) => {
            row[h] = values[idx] ?? null;
          });
          sampleRows.push(row);
        }

        if (onProgress && Date.now() - lastProgressUpdate > 500) {
          await onProgress(Math.min(Math.round((totalBytesRead / job.file_size_bytes) * 80), 80), rowCount);
          lastProgressUpdate = Date.now();
        }

        if (sampleRows.length >= SAMPLE_SIZE) break;
      }

      if (sampleRows.length >= SAMPLE_SIZE) break;
    }

    // Flush remaining
    leftover += decoder.decode();
    if (leftover.trim() && !isHeaderLine) {
      const line = leftover.replace(/\r$/, "");
      if (line.trim()) {
        rowCount++;
        bytesForRows += line.length;
        if (sampleRows.length < SAMPLE_SIZE) {
          const values = parseCSVLine(line, detectedDelimiter);
          const row: Record<string, unknown> = {};
          headers.forEach((h, idx) => { row[h] = values[idx] ?? null; });
          sampleRows.push(row);
        }
      }
    }

    // Estimate total rows
    const avgBytesPerRow = rowCount > 0 ? bytesForRows / rowCount : 100;
    let estimatedRowCount: number;
    if (job.file_size_bytes <= totalBytesRead) {
      estimatedRowCount = rowCount;
    } else {
      const headerBytes = totalBytesRead - bytesForRows;
      const dataBytesTotal = job.file_size_bytes - headerBytes;
      estimatedRowCount = Math.round(dataBytesTotal / avgBytesPerRow);
    }

    const columnTypes = inferColumnTypes(headers, sampleRows);

    console.log(`[process-import] CSV schema: ${headers.length} cols, ~${estimatedRowCount} rows, ${sampleRows.length} sampled`);

    return {
      columns: headers,
      columnTypes,
      totalRows: estimatedRowCount,
      sampleRows,
      format: "csv",
      schemaHash: generateSchemaHash(headers),
    };
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function extractSchemaParquet(
  supabase: any,
  job: ImportJob,
  onProgress?: (p: number, r: number) => Promise<void>,
): Promise<FileSchema> {
  if (job.file_size_bytes > PARQUET_MEMORY_LIMIT) {
    throw new Error(
      `Arquivo Parquet muito grande (${(job.file_size_bytes / 1024 / 1024).toFixed(0)} MB). ` +
      `Limite: ${(PARQUET_MEMORY_LIMIT / 1024 / 1024).toFixed(0)} MB.`
    );
  }

  const signedUrl = await getSignedUrl(supabase, job.storage_path);
  if (onProgress) await onProgress(10, 0);

  const res = await downloadFile(signedUrl);
  const arrayBuffer = await res.arrayBuffer();
  if (onProgress) await onProgress(40, 0);

  console.log(`[process-import] Parquet downloaded: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

  let allRows: Record<string, unknown>[] = [];
  await parquetRead({
    file: arrayBuffer,
    rowFormat: "object",
    onComplete: (data: Record<string, unknown>[]) => { allRows = data; },
  });

  if (onProgress) await onProgress(70, allRows.length);

  if (allRows.length === 0) throw new Error("Arquivo Parquet vazio ou ilegível.");

  const headers = Object.keys(allRows[0]);
  const totalRows = allRows.length;
  const sampleRows = allRows.slice(0, SAMPLE_SIZE).map(row => {
    const clean: Record<string, unknown> = {};
    for (const key of headers) {
      const val = row[key];
      if (val === null || val === undefined) clean[key] = null;
      else if (typeof val === "bigint") clean[key] = Number(val);
      else if (val instanceof Date) clean[key] = val.toISOString();
      else if (typeof val === "object") clean[key] = JSON.stringify(val);
      else clean[key] = val;
    }
    return clean;
  });

  const columnTypes = inferColumnTypes(headers, sampleRows);

  console.log(`[process-import] Parquet schema: ${headers.length} cols, ${totalRows} rows, ${sampleRows.length} sampled`);

  return {
    columns: headers,
    columnTypes,
    totalRows,
    sampleRows,
    format: "parquet",
    schemaHash: generateSchemaHash(headers),
  };
}

async function extractSchemaExcel(
  supabase: any,
  job: ImportJob,
  onProgress?: (p: number, r: number) => Promise<void>,
): Promise<FileSchema> {
  if (job.file_size_bytes > PARQUET_MEMORY_LIMIT) {
    throw new Error(
      `Arquivo Excel muito grande (${(job.file_size_bytes / 1024 / 1024).toFixed(0)} MB). ` +
      `Limite: ${(PARQUET_MEMORY_LIMIT / 1024 / 1024).toFixed(0)} MB.`
    );
  }

  const signedUrl = await getSignedUrl(supabase, job.storage_path);
  if (onProgress) await onProgress(10, 0);

  const res = await downloadFile(signedUrl);
  const arrayBuffer = await res.arrayBuffer();
  if (onProgress) await onProgress(40, 0);

  console.log(`[process-import] Excel downloaded: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  if (jsonData.length === 0) throw new Error("Arquivo Excel vazio.");

  if (onProgress) await onProgress(60, 0);

  // Detect actual header row (skip empty or title rows)
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, jsonData.length); i++) {
    const row = jsonData[i] as unknown[];
    const nonEmpty = row.filter(v => v !== null && v !== undefined && String(v).trim() !== "").length;
    if (nonEmpty >= 2) {
      headerRowIdx = i;
      break;
    }
  }

  const rawHeaders = (jsonData[headerRowIdx] as unknown[]);
  // Filter out "phantom" empty columns at the end
  let lastNonEmptyCol = rawHeaders.length - 1;
  while (lastNonEmptyCol >= 0 && (rawHeaders[lastNonEmptyCol] === null || rawHeaders[lastNonEmptyCol] === undefined || String(rawHeaders[lastNonEmptyCol]).trim() === "")) {
    lastNonEmptyCol--;
  }
  const headers = rawHeaders.slice(0, lastNonEmptyCol + 1).map((h, i) => String(h || `Column_${i + 1}`));

  const dataRows = jsonData.slice(headerRowIdx + 1);
  const totalRows = dataRows.length;
  const sampleSize = Math.min(SAMPLE_SIZE, totalRows);
  const sampledRows = dataRows.slice(0, sampleSize);

  const sampleRows = sampledRows.map(row => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      obj[header] = (row as unknown[])[i] ?? null;
    });
    return obj;
  });

  if (onProgress) await onProgress(80, totalRows);

  const columnTypes = inferColumnTypes(headers, sampleRows);

  console.log(`[process-import] Excel schema: ${headers.length} cols, ${totalRows} rows, sheet="${sheetName}"`);

  return {
    columns: headers,
    columnTypes,
    totalRows,
    sampleRows,
    format: "excel",
    schemaHash: generateSchemaHash(headers),
  };
}

async function extractSchemaJSON(
  supabase: any,
  job: ImportJob,
  onProgress?: (p: number, r: number) => Promise<void>,
): Promise<FileSchema> {
  const signedUrl = await getSignedUrl(supabase, job.storage_path);
  if (onProgress) await onProgress(10, 0);

  // Download — for very large JSON, only grab first portion
  const maxBytes = Math.min(job.file_size_bytes, SAMPLE_BYTES_LIMIT);
  const res = job.file_size_bytes <= SAMPLE_BYTES_LIMIT
    ? await downloadFile(signedUrl)
    : await downloadFile(signedUrl, { rangeEnd: maxBytes });

  const text = await res.text();
  if (onProgress) await onProgress(40, 0);

  let records: Record<string, unknown>[];

  // Detect JSON Lines vs JSON Array
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    // Regular JSON array
    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) {
      records = data;
    } else {
      throw new Error("JSON root is not an array");
    }
  } else if (trimmed.startsWith("{")) {
    // Could be JSON Lines or a wrapper object
    const lines = trimmed.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      // Try JSON Lines
      records = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line.trim());
          if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
            records.push(obj);
          }
        } catch {
          // Skip unparseable lines
        }
      }
      if (records.length === 0) throw new Error("Não foi possível parsear JSON Lines.");
    } else {
      // Single wrapper object — look for common array keys
      const data = JSON.parse(trimmed);
      const arrayKeys = ["data", "records", "results", "rows", "items"];
      let found = false;
      for (const key of arrayKeys) {
        if (data[key] && Array.isArray(data[key])) {
          records = data[key];
          found = true;
          break;
        }
      }
      if (!found) {
        records = [data]; // Single record
      }
    }
  } else {
    throw new Error("JSON inválido: não começa com [ ou {");
  }

  if (records.length === 0) throw new Error("Nenhum registro encontrado no arquivo JSON.");

  if (onProgress) await onProgress(60, records.length);

  // Flatten nested objects one level deep
  const flattenedRecords = records.map(record => {
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        // Flatten nested object
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          flat[`${key}.${nestedKey}`] = nestedValue;
        }
      } else {
        flat[key] = value;
      }
    }
    return flat;
  });

  // Collect all unique keys
  const keysSet = new Set<string>();
  for (const record of flattenedRecords) {
    Object.keys(record).forEach(key => keysSet.add(key));
  }
  const headers = Array.from(keysSet);

  const totalRows = flattenedRecords.length;
  const sampleSize = Math.min(SAMPLE_SIZE, totalRows);
  const sampleRows = flattenedRecords.slice(0, sampleSize).map(record => {
    const obj: Record<string, unknown> = {};
    headers.forEach(h => { obj[h] = record[h] ?? null; });
    return obj;
  });

  // If file was truncated, estimate
  const isPartial = job.file_size_bytes > SAMPLE_BYTES_LIMIT;
  const estimatedTotal = isPartial
    ? Math.round(totalRows * (job.file_size_bytes / text.length))
    : totalRows;

  if (onProgress) await onProgress(80, estimatedTotal);

  const columnTypes = inferColumnTypes(headers, sampleRows);

  console.log(`[process-import] JSON schema: ${headers.length} cols, ${estimatedTotal} rows (${isPartial ? "estimated" : "exact"})`);

  return {
    columns: headers,
    columnTypes,
    totalRows: estimatedTotal,
    sampleRows,
    format: "json",
    schemaHash: generateSchemaHash(headers),
  };
}

// ═══════════════════════════════════════════════════════════
// Canonical Schema Builder (union by name)
// ═══════════════════════════════════════════════════════════
function buildCanonicalSchema(fileSchemas: FileSchema[]): CanonicalSchema {
  if (fileSchemas.length === 0) {
    return { columns: [], columnTypes: {}, sourceFiles: 0 };
  }

  // Union all column names preserving order of first appearance
  const seenColumns = new Map<string, string>(); // lowercase → original name
  const columnOrder: string[] = [];

  // Use frequency-based approach: columns from more files get priority
  const columnFrequency = new Map<string, number>();
  const columnOriginalNames = new Map<string, string>(); // lowercase → first-seen original

  for (const schema of fileSchemas) {
    for (const col of schema.columns) {
      const key = col.toLowerCase().trim();
      columnFrequency.set(key, (columnFrequency.get(key) || 0) + 1);
      if (!columnOriginalNames.has(key)) {
        columnOriginalNames.set(key, col);
      }
    }
  }

  // Sort by frequency (descending), then by first appearance
  const allColumnKeys = Array.from(columnFrequency.keys());
  // Maintain insertion order from first schema, then add extras
  for (const schema of fileSchemas) {
    for (const col of schema.columns) {
      const key = col.toLowerCase().trim();
      if (!seenColumns.has(key)) {
        seenColumns.set(key, columnOriginalNames.get(key) || col);
        columnOrder.push(columnOriginalNames.get(key) || col);
      }
    }
  }

  // Merge types: prefer most specific (numérico > categórico > texto)
  const mergedTypes: Record<string, string> = {};
  for (const col of columnOrder) {
    const key = col.toLowerCase().trim();
    const types: string[] = [];
    for (const schema of fileSchemas) {
      const matchCol = schema.columns.find(c => c.toLowerCase().trim() === key);
      if (matchCol && schema.columnTypes[matchCol]) {
        types.push(schema.columnTypes[matchCol]);
      }
    }
    // Use most common type, fallback to texto
    if (types.length === 0) {
      mergedTypes[col] = "texto";
    } else {
      const typeCounts = new Map<string, number>();
      for (const t of types) {
        typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
      }
      let bestType = "texto";
      let bestCount = 0;
      for (const [t, count] of typeCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestType = t;
        }
      }
      mergedTypes[col] = bestType;
    }
  }

  console.log(`[process-import] Canonical schema: ${columnOrder.length} cols from ${fileSchemas.length} files`);

  return {
    columns: columnOrder,
    columnTypes: mergedTypes,
    sourceFiles: fileSchemas.length,
  };
}

// ═══════════════════════════════════════════════════════════
// Normalize samples to canonical schema
// ═══════════════════════════════════════════════════════════
function normalizeToSchema(
  sampleRows: Record<string, unknown>[],
  fileColumns: string[],
  canonicalColumns: string[],
): Record<string, unknown>[] {
  // Build mapping: canonical column → file column (case-insensitive)
  const fileColMap = new Map<string, string>();
  for (const col of fileColumns) {
    fileColMap.set(col.toLowerCase().trim(), col);
  }

  return sampleRows.map(row => {
    const normalized: Record<string, unknown> = {};
    for (const canonCol of canonicalColumns) {
      const key = canonCol.toLowerCase().trim();
      const fileCol = fileColMap.get(key);
      normalized[canonCol] = fileCol ? (row[fileCol] ?? null) : null;
    }
    return normalized;
  });
}

// ═══════════════════════════════════════════════════════════
// Column type inference
// ═══════════════════════════════════════════════════════════
function inferColumnTypes(headers: string[], sampleRows: Record<string, unknown>[]): Record<string, string> {
  const types: Record<string, string> = {};

  for (const header of headers) {
    const values = sampleRows
      .map(row => row[header])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== "");

    if (values.length === 0) { types[header] = "texto"; continue; }

    // Native type checks (for Parquet/JSON)
    const nativeNumberCount = values.filter(v => typeof v === "number").length;
    if (nativeNumberCount >= values.length * 0.8) { types[header] = "numérico"; continue; }

    const nativeBoolCount = values.filter(v => typeof v === "boolean").length;
    if (nativeBoolCount >= values.length * 0.8) { types[header] = "categórico"; continue; }

    // String-based inference
    const numericCount = values.filter(v => {
      const str = String(v).replace(",", ".").trim();
      return !isNaN(Number(str)) && str !== "";
    }).length;
    if (numericCount >= values.length * 0.8) { types[header] = "numérico"; continue; }

    const datePatterns = [/^\d{4}-\d{2}-\d{2}/, /^\d{2}\/\d{2}\/\d{4}/, /^\d{2}-\d{2}-\d{4}/];
    const dateCount = values.filter(v => datePatterns.some(p => p.test(String(v)))).length;
    if (dateCount >= values.length * 0.8) { types[header] = "data"; continue; }

    const uniqueValues = new Set(values.map(v => String(v)));
    if (uniqueValues.size <= Math.min(20, values.length * 0.1)) { types[header] = "categórico"; continue; }

    types[header] = "texto";
  }

  return types;
}

// ═══════════════════════════════════════════════════════════
// Job helper functions
// ═══════════════════════════════════════════════════════════
async function updateJobProgress(supabase: any, jobId: string, progress: number, rowsProcessed: number): Promise<void> {
  try {
    await supabase
      .from("import_jobs")
      .update({ progress: Math.min(100, Math.max(0, Math.round(progress))), rows_processed: rowsProcessed, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    console.warn(`[process-import] Failed to update progress for ${jobId}:`, e);
  }
}

async function updateJobError(supabase: any, jobId: string, errorMessage: string): Promise<void> {
  await supabase
    .from("import_jobs")
    .update({ status: "failed", progress: 0, error_message: errorMessage, finished_at: new Date().toISOString() })
    .eq("id", jobId);
}

async function completeJob(supabase: any, jobId: string, rowsProcessed: number, datasetId: string | null): Promise<void> {
  await supabase
    .from("import_jobs")
    .update({ status: "completed", progress: 100, rows_processed: rowsProcessed, finished_at: new Date().toISOString(), dataset_id: datasetId })
    .eq("id", jobId);
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

async function createDatasetRecord(
  supabase: any, projectId: string, userId: string, name: string,
  storagePath: string, fileSizeBytes: number, totalRows: number,
  sampleRows: number, columnsCount: number, sourceType: string,
  sourceMetadata: Record<string, unknown>,
): Promise<string | null> {
  try {
    await supabase.from("project_datasets").update({ is_active: false }).eq("project_id", projectId).eq("is_active", true);
    const { data, error } = await supabase
      .from("project_datasets")
      .insert({ project_id: projectId, user_id: userId, name, storage_path: storagePath, file_size_bytes: fileSizeBytes, total_rows: totalRows, sample_rows: sampleRows, columns_count: columnsCount, is_active: true, source_type: sourceType, source_metadata: sourceMetadata })
      .select("id").single();
    if (error) { console.error("[process-import] Dataset creation error:", error); return null; }
    return data.id;
  } catch (e) { console.error("[process-import] Dataset creation error:", e); return null; }
}

// ═══════════════════════════════════════════════════════════
// Unified file processing: extract schema for any format
// ═══════════════════════════════════════════════════════════
async function processFileUnified(
  supabase: any,
  job: ImportJob,
  onProgress?: (p: number, r: number) => Promise<void>,
): Promise<FileSchema> {
  const format = detectFileFormat(job.file_name, job.storage_path);
  console.log(`[process-import] Processing ${job.file_name} as ${format.toUpperCase()} (${(job.file_size_bytes / 1024 / 1024).toFixed(2)} MB)`);

  switch (format) {
    case "csv": return await extractSchemaCSV(supabase, job, onProgress);
    case "parquet": return await extractSchemaParquet(supabase, job, onProgress);
    case "excel": return await extractSchemaExcel(supabase, job, onProgress);
    case "json": return await extractSchemaJSON(supabase, job, onProgress);
    default: throw new Error(`Formato não suportado: ${format}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Single file import
// ═══════════════════════════════════════════════════════════
async function processSingleImport(supabase: any, job: ImportJob): Promise<Response> {
  await supabase.from("import_jobs").update({ status: "processing", progress: 0, updated_at: new Date().toISOString() }).eq("id", job.id);

  try {
    const progressCallback = async (p: number, r: number) => {
      await updateJobProgress(supabase, job.id, p, r);
    };

    const schema = await processFileUnified(supabase, job, progressCallback);

    if (schema.columns.length === 0) {
      await updateJobError(supabase, job.id, "Não foi possível detectar colunas no arquivo.");
      return new Response(JSON.stringify({ success: false, message: "Could not parse headers" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Save columns
    await supabase.from("project_columns").delete().eq("project_id", job.project_id);
    const columnInserts = schema.columns.map((name, index) => ({
      project_id: job.project_id, column_name: name, column_index: index,
      inferred_type: schema.columnTypes[name] || "texto",
    }));
    await supabase.from("project_columns").insert(columnInserts);

    // Copy to datasets bucket
    const sanitizedName = sanitizeFileName(job.file_name);
    const datasetPath = `${job.user_id}/${job.project_id}/${sanitizedName}`;

    const { error: copyError } = await supabase.storage
      .from("big_imports").copy(job.storage_path, datasetPath, { destinationBucket: "datasets" });
    if (copyError && !copyError.message?.includes("already exists")) {
      console.error("[process-import] Copy error:", copyError);
    }

    const sampleRowsCount = Math.min(schema.sampleRows.length, SAMPLE_SIZE);
    const datasetId = await createDatasetRecord(
      supabase, job.project_id, job.user_id, job.file_name, datasetPath,
      job.file_size_bytes, schema.totalRows, sampleRowsCount, schema.columns.length,
      "upload", {
        original_path: job.storage_path,
        file_type: schema.format,
        rows_estimated: schema.format === "csv",
        ...(schema.format === "csv" ? { delimiter: job.delimiter, encoding: job.encoding } : {}),
      },
    );

    // Update project
    await supabase.from("projects").update({
      dataset_filename: datasetPath, dataset_rows: sampleRowsCount,
      dataset_columns: schema.columns.length, total_rows: schema.totalRows,
      sample_rows: sampleRowsCount, status: "data_uploaded",
    }).eq("id", job.project_id);

    // Log
    await supabase.from("project_data_ingestion_logs").insert({
      project_id: job.project_id, status: "success",
      rows_read: schema.totalRows, rows_sampled: sampleRowsCount,
      completed_at: new Date().toISOString(),
      metadata: { file_name: job.file_name, file_type: schema.format, storage_path: job.storage_path, dataset_path: datasetPath, dataset_id: datasetId, schema_cols: schema.columns.length, schema_hash: schema.schemaHash },
    });

    await completeJob(supabase, job.id, schema.totalRows, datasetId);

    console.log(`[process-import] Job ${job.id} completed: ${schema.format.toUpperCase()}, ${schema.totalRows} rows, ${schema.columns.length} cols`);

    return new Response(JSON.stringify({
      success: true,
      message: `Importação concluída: ~${schema.totalRows.toLocaleString()} linhas`,
      rows_processed: schema.totalRows,
      columns: schema.columns.length,
      format: schema.format,
      dataset_id: datasetId,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[process-import] Error on job ${job.id}:`, msg);
    await updateJobError(supabase, job.id, msg);
    return new Response(JSON.stringify({ success: false, message: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Batch import (multi-file → consolidated dataset)
// ═══════════════════════════════════════════════════════════
async function processBatchImport(supabase: any, primaryJob: ImportJob): Promise<Response> {
  console.log(`[process-import] Processing batch: ${primaryJob.batch_id}`);

  const { data: batchJobs, error: batchError } = await supabase
    .from("import_jobs").select("*").eq("batch_id", primaryJob.batch_id)
    .order("batch_sequence", { ascending: true });

  if (batchError || !batchJobs || batchJobs.length === 0) {
    await updateJobError(supabase, primaryJob.id, "Falha ao buscar jobs do lote.");
    return new Response(JSON.stringify({ success: false, message: "Failed to fetch batch jobs" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const totalBatchSize = batchJobs.reduce((sum: number, j: ImportJob) => sum + j.file_size_bytes, 0);
  if (totalBatchSize > MAX_FILE_SIZE_BYTES) {
    for (const job of batchJobs) {
      await updateJobError(supabase, job.id, `Lote excede o limite de ${(MAX_FILE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(0)} GB.`);
    }
    return new Response(JSON.stringify({ success: false, message: "Batch too large" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log(`[process-import] Batch: ${batchJobs.length} files, ${(totalBatchSize / 1024 / 1024).toFixed(2)} MB total`);

  // ─── Phase 1: Extract schema from each file ────────────────
  const fileResults: FileProcessResult[] = [];
  const fileSchemas: FileSchema[] = [];
  const batchFolder = `${primaryJob.user_id}/${primaryJob.project_id}/${primaryJob.batch_id}`;

  for (let i = 0; i < batchJobs.length; i++) {
    const job = batchJobs[i] as ImportJob;
    const format = detectFileFormat(job.file_name, job.storage_path);

    console.log(`[process-import] [${i + 1}/${batchJobs.length}] ${job.file_name} (${format})`);

    await supabase.from("import_jobs").update({ status: "processing", progress: 0, updated_at: new Date().toISOString() }).eq("id", job.id);

    try {
      const progressCallback = async (p: number, r: number) => {
        await updateJobProgress(supabase, job.id, p, r);
      };

      const schema = await processFileUnified(supabase, job, progressCallback);
      fileSchemas.push(schema);

      fileResults.push({
        success: true, jobId: job.id, fileName: job.file_name,
        format, schema, rowsRead: schema.totalRows, coveragePct: 100,
      });

      console.log(`[process-import] ✓ ${job.file_name}: ${schema.columns.length} cols, ${schema.totalRows} rows, hash=${schema.schemaHash}`);

    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao processar";
      console.error(`[process-import] ✗ ${job.file_name}: ${msg}`);

      fileResults.push({
        success: false, jobId: job.id, fileName: job.file_name,
        format, error: msg, rowsRead: 0, coveragePct: 0,
      });

      await updateJobError(supabase, job.id, msg);
    }
  }

  const successResults = fileResults.filter(r => r.success);
  const failedResults = fileResults.filter(r => !r.success);

  if (successResults.length === 0) {
    const errMsg = failedResults.length > 0
      ? `Todos os arquivos falharam: ${failedResults[0].error}`
      : "Nenhum arquivo processado";
    await updateJobError(supabase, primaryJob.id, errMsg);
    return new Response(JSON.stringify({
      success: false, message: errMsg,
      file_results: fileResults.map(r => ({ file: r.fileName, format: r.format, status: r.success ? "OK" : "FAIL", error: r.error })),
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ─── Phase 2: Build canonical schema ───────────────────────
  const successSchemas = successResults.map(r => r.schema!);
  const canonical = buildCanonicalSchema(successSchemas);

  // Log schema divergences
  for (const result of successResults) {
    if (result.schema!.schemaHash !== successSchemas[0].schemaHash) {
      const missing = canonical.columns.filter(c =>
        !result.schema!.columns.some(fc => fc.toLowerCase().trim() === c.toLowerCase().trim())
      );
      const extra = result.schema!.columns.filter(fc =>
        !canonical.columns.some(c => c.toLowerCase().trim() === fc.toLowerCase().trim())
      );
      console.log(`[process-import] Schema divergence in ${result.fileName}: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
    }
  }

  // ─── Phase 3: Normalize + consolidate ──────────────────────
  let allSampleRows: Record<string, unknown>[] = [];
  let totalRowsConsolidated = 0;
  const processedFilePaths: string[] = [];
  let totalFileSizeBytes = 0;

  // Proportional sample allocation
  const totalSampleBudget = SAMPLE_SIZE;
  const totalSuccessRows = successSchemas.reduce((s, sc) => s + sc.totalRows, 0);

  for (let i = 0; i < successResults.length; i++) {
    const result = successResults[i];
    const schema = result.schema!;
    const job = batchJobs.find((j: ImportJob) => j.id === result.jobId) as ImportJob;

    // Normalize samples to canonical schema
    const normalizedSamples = normalizeToSchema(schema.sampleRows, schema.columns, canonical.columns);

    // Proportional sample allocation
    const sampleBudget = Math.max(10, Math.ceil((schema.totalRows / Math.max(totalSuccessRows, 1)) * totalSampleBudget));
    const samplesToAdd = normalizedSamples.slice(0, sampleBudget);

    if (allSampleRows.length < totalSampleBudget) {
      allSampleRows = allSampleRows.concat(samplesToAdd.slice(0, totalSampleBudget - allSampleRows.length));
    }

    totalRowsConsolidated += schema.totalRows;

    // Copy file to datasets bucket
    const sanitizedName = sanitizeFileName(job.file_name);
    const destPath = `${batchFolder}/${sanitizedName}`;

    try {
      const { error: copyError } = await supabase.storage
        .from("big_imports").copy(job.storage_path, destPath, { destinationBucket: "datasets" });
      if (copyError && !copyError.message?.includes("already exists")) throw copyError;

      processedFilePaths.push(destPath);
      totalFileSizeBytes += job.file_size_bytes;

      await completeJob(supabase, job.id, schema.totalRows, null);
      console.log(`[process-import] ✓ Copied ${job.file_name} → datasets/${destPath}`);
    } catch (copyErr: any) {
      const errMsg = copyErr?.message || "Falha ao copiar arquivo.";
      console.warn(`[process-import] Copy failed for ${job.file_name}:`, errMsg);
      failedResults.push({ ...result, success: false, error: errMsg });
      await updateJobError(supabase, job.id, errMsg);
    }
  }

  // ─── Phase 4: EDA Gate ─────────────────────────────────────
  const coveragePct = batchJobs.length > 0
    ? Math.round((successResults.length / batchJobs.length) * 100)
    : 0;
  const passesEDAGate = totalRowsConsolidated > 0 && canonical.columns.length > 0 && coveragePct >= 50;

  if (!passesEDAGate) {
    const gateMsg = `EDA Gate falhou: ${totalRowsConsolidated} rows, ${canonical.columns.length} cols, ${coveragePct}% coverage`;
    console.error(`[process-import] ${gateMsg}`);
    await updateJobError(supabase, primaryJob.id, gateMsg);
    return new Response(JSON.stringify({ success: false, message: gateMsg, file_results: fileResults }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ─── Save canonical columns ────────────────────────────────
  await supabase.from("project_columns").delete().eq("project_id", primaryJob.project_id);
  const columnInserts = canonical.columns.map((name, index) => ({
    project_id: primaryJob.project_id, column_name: name, column_index: index,
    inferred_type: canonical.columnTypes[name] || "texto",
  }));
  await supabase.from("project_columns").insert(columnInserts);

  // ─── Create consolidated dataset ──────────────────────────
  const sampleRowsCount = Math.min(allSampleRows.length, totalSampleBudget);
  const datasetId = await createDatasetRecord(
    supabase, primaryJob.project_id, primaryJob.user_id, primaryJob.file_name,
    batchFolder, totalFileSizeBytes, totalRowsConsolidated, sampleRowsCount,
    canonical.columns.length,
    successResults.length > 1 ? "batch_import" : "upload",
    {
      batch_id: primaryJob.batch_id,
      files_count: batchJobs.length,
      files_processed: successResults.length,
      files_failed: failedResults.length,
      file_paths: processedFilePaths,
      file_names: batchJobs.map((j: ImportJob) => j.file_name),
      file_formats: successResults.map(r => r.format),
      canonical_schema_hash: generateSchemaHash(canonical.columns),
      canonical_columns: canonical.columns.length,
      coverage_pct: coveragePct,
      rows_consolidated: totalRowsConsolidated,
    },
  );

  if (datasetId) {
    await supabase.from("import_jobs").update({ dataset_id: datasetId }).eq("batch_id", primaryJob.batch_id);
  }

  // Update project
  await supabase.from("projects").update({
    dataset_filename: batchFolder, dataset_rows: sampleRowsCount,
    dataset_columns: canonical.columns.length, total_rows: totalRowsConsolidated,
    sample_rows: sampleRowsCount, status: "data_uploaded",
  }).eq("id", primaryJob.project_id);

  // Log
  await supabase.from("project_data_ingestion_logs").insert({
    project_id: primaryJob.project_id,
    status: failedResults.length > 0 ? "partial" : "success",
    rows_read: totalRowsConsolidated, rows_sampled: sampleRowsCount,
    completed_at: new Date().toISOString(),
    metadata: {
      batch_id: primaryJob.batch_id,
      files_processed: successResults.length,
      files_failed: failedResults.length,
      file_results: fileResults.map(r => ({
        file: r.fileName, format: r.format, status: r.success ? "OK" : "FAIL",
        rows: r.rowsRead, cols: r.schema?.columns.length || 0, error: r.error || null,
        schema_hash: r.schema?.schemaHash || null,
      })),
      canonical_schema: { columns: canonical.columns, column_count: canonical.columns.length },
      coverage_pct: coveragePct,
      dataset_path: batchFolder,
      dataset_id: datasetId,
    },
  });

  const responseMessage = failedResults.length > 0
    ? `Importação parcial: ${successResults.length}/${batchJobs.length} arquivos ok, ~${totalRowsConsolidated.toLocaleString()} linhas, ${coveragePct}% coverage`
    : `Batch consolidado: ${successResults.length} arquivos, ~${totalRowsConsolidated.toLocaleString()} linhas, ${canonical.columns.length} colunas`;

  console.log(`[process-import] Batch ${primaryJob.batch_id} done. ${responseMessage}`);

  return new Response(JSON.stringify({
    success: true,
    message: responseMessage,
    rows_processed: totalRowsConsolidated,
    columns: canonical.columns.length,
    files_processed: successResults.length,
    files_failed: failedResults.length,
    coverage_pct: coveragePct,
    canonical_schema: { columns: canonical.columns, types: canonical.columnTypes },
    dataset_id: datasetId,
    file_results: fileResults.map(r => ({
      file: r.fileName, format: r.format, status: r.success ? "OK" : "FAIL",
      rows: r.rowsRead, cols: r.schema?.columns.length || 0, error: r.error || null,
    })),
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ═══════════════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════════════
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { job_id, batch_id } = await req.json();

    if (!job_id) {
      return new Response(JSON.stringify({ success: false, message: "job_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[process-import] Starting job: ${job_id}, batch: ${batch_id || "none"}`);

    const { data: job, error: jobError } = await supabase.from("import_jobs").select("*").eq("id", job_id).single();

    if (jobError || !job) {
      return new Response(JSON.stringify({ success: false, message: "Import job not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (job.status !== "pending") {
      return new Response(JSON.stringify({ success: true, message: `Job is already ${job.status}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (job.file_size_bytes > MAX_FILE_SIZE_BYTES) {
      await updateJobError(supabase, job_id, `Arquivo excede o limite de ${(MAX_FILE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(0)} GB.`);
      return new Response(JSON.stringify({ success: false, message: "File too large" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (job.batch_id) {
      return await processBatchImport(supabase, job as ImportJob);
    } else {
      return await processSingleImport(supabase, job as ImportJob);
    }
  } catch (error: unknown) {
    console.error("[process-import] Unexpected error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(JSON.stringify({ success: false, message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
