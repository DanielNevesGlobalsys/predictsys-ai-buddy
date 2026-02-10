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
  return columns.map(c => normalizeColumnName(c)).sort().join("|");
}

// ═══════════════════════════════════════════════════════════
// Column Name Normalization (accents, spaces, special chars)
// ═══════════════════════════════════════════════════════════
function normalizeColumnName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/\s+/g, "_")                              // spaces → _
    .replace(/[^a-z0-9_]/g, "")                        // remove special chars
    .replace(/_+/g, "_")                               // collapse underscores
    .replace(/^_|_$/g, "");                             // trim underscores
}

// ═══════════════════════════════════════════════════════════
// Column Equivalence Heuristics
// ═══════════════════════════════════════════════════════════
const EQUIVALENCE_GROUPS: string[][] = [
  ["id", "id_cliente", "cliente_id", "customer_id", "cod_cliente", "codigo_cliente"],
  ["codparc", "cod_parc", "codigo_parceiro", "partner_code", "parceiro_id"],
  ["nome", "name", "nome_cliente", "customer_name", "nm_cliente"],
  ["data", "date", "dt", "data_ref", "reference_date", "dt_ref"],
  ["valor", "value", "vlr", "vlrtot", "valor_total", "total_value", "amount"],
  ["email", "e_mail", "email_cliente", "customer_email"],
  ["telefone", "phone", "tel", "fone", "celular", "mobile"],
  ["cidade", "city", "municipio"],
  ["estado", "state", "uf"],
  ["cep", "zip", "zipcode", "zip_code", "codigo_postal"],
];

// ═══════════════════════════════════════════════════════════
// Entity Key Auto-Detection
// ═══════════════════════════════════════════════════════════
const ENTITY_KEY_PATTERNS = [
  /^id$/i, /^id_/i, /_id$/i,
  /^cod/i, /^codigo/i, /^code/i,
  /^cpf$/i, /^cnpj$/i, /^rg$/i,
  /^contrato/i, /^contract/i,
  /^matricula/i, /^enrollment/i,
  /^cliente/i, /^customer/i,
  /^student_id$/i, /^user_id$/i, /^account/i,
  /^parceiro/i, /^partner/i,
  /^numero/i, /^num_/i, /^nr_/i,
  /^chave/i, /^key$/i,
  /^uuid$/i, /^pk$/i,
  /^nro_/i, /^registro/i,
];

interface EntityKeyCandidate {
  column: string;
  score: number;
  reason: string;
  uniqueRatio: number;
  filesPresent: number;
  totalFiles: number;
}

function detectEntityKeys(
  canonicalColumns: string[],
  canonicalTypes: Record<string, string>,
  fileSchemas: FileSchema[],
  fileNames: string[],
  allSampleRows: Record<string, unknown>[],
): EntityKeyCandidate[] {
  const candidates: EntityKeyCandidate[] = [];

  for (const col of canonicalColumns) {
    const normalized = normalizeColumnName(col);
    let score = 0;
    let reason = "";

    // 1. Name pattern match
    const matchesPattern = ENTITY_KEY_PATTERNS.some(p => p.test(normalized));
    if (matchesPattern) {
      score += 40;
      reason = "Nome corresponde a padrão de chave. ";
    }

    // 2. Check uniqueness ratio from sample
    const values = allSampleRows
      .map(r => r[col])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== "");
    
    if (values.length === 0) continue;

    const uniqueValues = new Set(values.map(v => String(v)));
    const uniqueRatio = uniqueValues.size / values.length;

    // High cardinality = more likely a key
    if (uniqueRatio > 0.8) {
      score += 30;
      reason += `Alta cardinalidade (${(uniqueRatio * 100).toFixed(0)}% únicos). `;
    } else if (uniqueRatio > 0.5) {
      score += 15;
      reason += `Cardinalidade moderada (${(uniqueRatio * 100).toFixed(0)}% únicos). `;
    } else {
      // Low cardinality = unlikely to be a key
      continue;
    }

    // 3. Check presence across files
    const normCol = normalizeColumnName(col);
    let filesPresent = 0;
    for (const schema of fileSchemas) {
      if (schema.columns.some(c => normalizeColumnName(c) === normCol)) {
        filesPresent++;
      }
    }

    if (filesPresent > 1) {
      score += 20;
      reason += `Presente em ${filesPresent}/${fileSchemas.length} arquivos. `;
    }

    // 4. Type bonus: text/numeric keys
    const colType = canonicalTypes[col];
    if (colType === "texto" && uniqueRatio > 0.9) {
      score += 10;
      reason += "Texto com alta unicidade. ";
    }

    if (score >= 40) {
      candidates.push({
        column: col,
        score,
        reason: reason.trim(),
        uniqueRatio: Math.round(uniqueRatio * 1000) / 1000,
        filesPresent,
        totalFiles: fileSchemas.length,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ═══════════════════════════════════════════════════════════
// Target Anchor Detection
// ═══════════════════════════════════════════════════════════
interface TargetAnchorResult {
  anchorFileIndex: number;
  anchorFileName: string;
  targetColumn: string | null;
  targetPresence: { fileName: string; hasTarget: boolean; nullRate: number; rowCount: number }[];
  strategy: "union" | "anchor_enrichment";
  strategyReason: string;
  warnings: string[];
}

function detectTargetAnchor(
  fileSchemas: FileSchema[],
  fileNames: string[],
  projectTargetColumn: string | null,
  canonicalColumns: string[],
): TargetAnchorResult | null {
  if (!projectTargetColumn || fileSchemas.length <= 1) return null;

  const normalizedTarget = normalizeColumnName(projectTargetColumn);
  const targetPresence: TargetAnchorResult["targetPresence"] = [];
  const warnings: string[] = [];

  for (let i = 0; i < fileSchemas.length; i++) {
    const schema = fileSchemas[i];
    const matchCol = schema.columns.find(c => normalizeColumnName(c) === normalizedTarget);

    if (matchCol) {
      // Check null rate in sample
      const nullCount = schema.sampleRows.filter(row => {
        const v = row[matchCol];
        return v === null || v === undefined || String(v).trim() === "" || String(v).toLowerCase() === "nan";
      }).length;
      const nullRate = schema.sampleRows.length > 0 ? nullCount / schema.sampleRows.length : 1;

      targetPresence.push({
        fileName: fileNames[i],
        hasTarget: true,
        nullRate: Math.round(nullRate * 1000) / 1000,
        rowCount: schema.totalRows,
      });
    } else {
      targetPresence.push({
        fileName: fileNames[i],
        hasTarget: false,
        nullRate: 1,
        rowCount: schema.totalRows,
      });
    }
  }

  const filesWithTarget = targetPresence.filter(t => t.hasTarget);
  const filesWithoutTarget = targetPresence.filter(t => !t.hasTarget);

  // All files have target → union strategy
  if (filesWithoutTarget.length === 0) {
    // Validate consistency: check if types are the same
    const targetTypes = fileSchemas
      .map(s => {
        const col = s.columns.find(c => normalizeColumnName(c) === normalizedTarget);
        return col ? s.columnTypes[col] : null;
      })
      .filter(Boolean);

    const uniqueTypes = new Set(targetTypes);
    if (uniqueTypes.size > 1) {
      warnings.push(
        `Target "${projectTargetColumn}" tem tipos diferentes entre arquivos: ${[...uniqueTypes].join(", ")}. ` +
        `Isso pode causar inconsistência no treino. Considere usar um único arquivo como âncora.`
      );
    }

    return {
      anchorFileIndex: 0,
      anchorFileName: fileNames[0],
      targetColumn: projectTargetColumn,
      targetPresence,
      strategy: "union",
      strategyReason: `Target "${projectTargetColumn}" presente em todos os ${fileSchemas.length} arquivos. Usando union-by-name.`,
      warnings,
    };
  }

  // Some files don't have target → anchor strategy
  if (filesWithTarget.length === 0) {
    warnings.push(
      `Target "${projectTargetColumn}" NÃO encontrado em nenhum arquivo. ` +
      `Verifique se o nome da coluna está correto.`
    );
    return {
      anchorFileIndex: 0,
      anchorFileName: fileNames[0],
      targetColumn: projectTargetColumn,
      targetPresence,
      strategy: "union",
      strategyReason: `Target não encontrado em nenhum arquivo. Usando union padrão.`,
      warnings,
    };
  }

  // Select best anchor: lowest null rate, then highest row count
  const bestAnchor = filesWithTarget.sort((a, b) => {
    if (a.nullRate !== b.nullRate) return a.nullRate - b.nullRate;
    return b.rowCount - a.rowCount;
  })[0];

  const anchorIndex = fileNames.indexOf(bestAnchor.fileName);

  warnings.push(
    `Target "${projectTargetColumn}" ausente em ${filesWithoutTarget.length} arquivo(s): ` +
    `${filesWithoutTarget.map(f => f.fileName).join(", ")}. ` +
    `Esses arquivos serão usados apenas como features auxiliares (se houver chave de ligação).`
  );

  return {
    anchorFileIndex: anchorIndex,
    anchorFileName: bestAnchor.fileName,
    targetColumn: projectTargetColumn,
    targetPresence,
    strategy: "anchor_enrichment",
    strategyReason:
      `Target "${projectTargetColumn}" presente em ${filesWithTarget.length}/${fileSchemas.length} arquivos. ` +
      `Arquivo âncora: "${bestAnchor.fileName}" (null_rate=${(bestAnchor.nullRate * 100).toFixed(1)}%, ${bestAnchor.rowCount} linhas).`,
    warnings,
  };
}

function findEquivalentCanonical(normalizedName: string, existingCanonicals: Map<string, string>): string | null {
  // Direct match
  if (existingCanonicals.has(normalizedName)) return normalizedName;

  // Check equivalence groups
  for (const group of EQUIVALENCE_GROUPS) {
    if (group.includes(normalizedName)) {
      for (const equiv of group) {
        if (existingCanonicals.has(equiv)) return equiv;
      }
    }
  }

  // Fuzzy: try removing common prefixes/suffixes
  const stripped = normalizedName
    .replace(/^(cod_?|codigo_?|id_?|num_?|nr_?)/, "")
    .replace(/(_id|_cod|_codigo|_num)$/, "");
  if (stripped && stripped !== normalizedName && existingCanonicals.has(stripped)) {
    return stripped;
  }

  return null;
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
// Canonical Schema Builder (union by name + normalization)
// ═══════════════════════════════════════════════════════════
interface ColumnMappingEntry {
  canonical: string;
  type: string;
  sources: { file: string; original_col: string }[];
}

function buildCanonicalSchema(
  fileSchemas: FileSchema[],
  fileNames?: string[],
): CanonicalSchema & { columnMapping: ColumnMappingEntry[] } {
  if (fileSchemas.length === 0) {
    return { columns: [], columnTypes: {}, sourceFiles: 0, columnMapping: [] };
  }

  // Map: normalizedName → canonical display name (first seen)
  const canonicalNames = new Map<string, string>();
  const columnOrder: string[] = [];
  const mappingEntries = new Map<string, ColumnMappingEntry>();

  for (let fi = 0; fi < fileSchemas.length; fi++) {
    const schema = fileSchemas[fi];
    const fileName = fileNames?.[fi] || `file_${fi + 1}`;

    for (const col of schema.columns) {
      const normalized = normalizeColumnName(col);
      
      // Try direct match or equivalence
      let canonicalKey = canonicalNames.has(normalized) ? normalized : findEquivalentCanonical(normalized, canonicalNames);
      
      if (canonicalKey) {
        // Column exists — add source mapping
        const entry = mappingEntries.get(canonicalKey)!;
        entry.sources.push({ file: fileName, original_col: col });
      } else {
        // New column
        canonicalKey = normalized;
        const displayName = col; // preserve original casing from first file
        canonicalNames.set(normalized, displayName);
        columnOrder.push(displayName);
        mappingEntries.set(normalized, {
          canonical: displayName,
          type: "texto",
          sources: [{ file: fileName, original_col: col }],
        });
      }
    }
  }

  // Merge types with coercion: prefer numérico > categórico > texto
  const mergedTypes: Record<string, string> = {};
  for (const col of columnOrder) {
    const normalized = normalizeColumnName(col);
    const types: string[] = [];
    for (const schema of fileSchemas) {
      const matchCol = schema.columns.find(c => {
        const norm = normalizeColumnName(c);
        return norm === normalized || findEquivalentCanonical(norm, canonicalNames) === normalized;
      });
      if (matchCol && schema.columnTypes[matchCol]) {
        types.push(schema.columnTypes[matchCol]);
      }
    }

    if (types.length === 0) {
      mergedTypes[col] = "texto";
    } else {
      // Type coercion: if any file has "numérico" and another has "texto", try "numérico" (will attempt conversion)
      const hasNumeric = types.includes("numérico");
      const hasText = types.includes("texto");
      if (hasNumeric && !hasText) {
        mergedTypes[col] = "numérico";
      } else if (hasNumeric && hasText) {
        // Mixed — keep numérico, backend will try conversion
        mergedTypes[col] = "numérico";
      } else {
        // Use most common type
        const typeCounts = new Map<string, number>();
        for (const t of types) typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
        let bestType = "texto";
        let bestCount = 0;
        for (const [t, count] of typeCounts) {
          if (count > bestCount) { bestCount = count; bestType = t; }
        }
        mergedTypes[col] = bestType;
      }
    }

    // Update mapping entry type
    const entry = mappingEntries.get(normalized);
    if (entry) entry.type = mergedTypes[col];
  }

  // Build column mapping array
  const columnMapping: ColumnMappingEntry[] = [];
  for (const [, entry] of mappingEntries) {
    columnMapping.push(entry);
  }

  console.log(`[process-import] Canonical schema: ${columnOrder.length} cols from ${fileSchemas.length} files`);

  return {
    columns: columnOrder,
    columnTypes: mergedTypes,
    sourceFiles: fileSchemas.length,
    columnMapping,
  };
}

// ═══════════════════════════════════════════════════════════
// Normalize samples to canonical schema (with normalization)
// ═══════════════════════════════════════════════════════════
function normalizeToSchema(
  sampleRows: Record<string, unknown>[],
  fileColumns: string[],
  canonicalColumns: string[],
  canonicalTypes?: Record<string, string>,
): Record<string, unknown>[] {
  // Build mapping: canonical normalized → file column
  const fileColMap = new Map<string, string>();
  for (const col of fileColumns) {
    fileColMap.set(normalizeColumnName(col), col);
  }

  // Build canonical normalized map
  const canonNormMap = new Map<string, string>();
  for (const col of canonicalColumns) {
    canonNormMap.set(normalizeColumnName(col), col);
  }

  return sampleRows.map(row => {
    const normalized: Record<string, unknown> = {};
    for (const canonCol of canonicalColumns) {
      const normKey = normalizeColumnName(canonCol);
      const fileCol = fileColMap.get(normKey);

      let value: unknown = null;

      if (fileCol) {
        value = row[fileCol] ?? null;
      } else {
        // Try equivalence
        const equivKey = findEquivalentCanonical(normKey, canonNormMap);
        if (equivKey) {
          const eqFileCol = fileColMap.get(equivKey);
          value = eqFileCol ? (row[eqFileCol] ?? null) : null;
        }
      }

      // Missing feature imputation: 0 for numeric, "missing" for categorical
      if (value === null || value === undefined || String(value).trim() === "") {
        const colType = canonicalTypes?.[canonCol] || "texto";
        if (colType === "numérico") {
          value = 0;
        } else {
          value = "missing";
        }
      }

      normalized[canonCol] = value;
    }
    return normalized;
  });
}

// ═══════════════════════════════════════════════════════════
// NULL Diagnostic: detect columns with high NULL from schema mismatch
// ═══════════════════════════════════════════════════════════
interface NullDiagnosticEntry {
  column: string;
  null_pct: number;
  probable_cause: string;
  files_with_data: string[];
}

function computeNullDiagnostic(
  canonicalColumns: string[],
  fileSchemas: FileSchema[],
  fileNames: string[],
  allSampleRows: Record<string, unknown>[],
): NullDiagnosticEntry[] {
  const diagnostics: NullDiagnosticEntry[] = [];
  if (allSampleRows.length === 0) return diagnostics;

  for (const col of canonicalColumns) {
    const nullCount = allSampleRows.filter(row => {
      const v = row[col];
      return v === null || v === undefined || String(v).trim() === "";
    }).length;
    const nullPct = (nullCount / allSampleRows.length) * 100;

    if (nullPct > 50) {
      // Check which files had this column
      const filesWithData: string[] = [];
      const normCol = normalizeColumnName(col);
      for (let i = 0; i < fileSchemas.length; i++) {
        const hasCol = fileSchemas[i].columns.some(c => normalizeColumnName(c) === normCol);
        if (hasCol) filesWithData.push(fileNames[i]);
      }

      let cause = "Coluna ausente em parte dos arquivos.";
      if (filesWithData.length === fileSchemas.length) {
        cause = "Provável mismatch de nome/tipo/parse entre arquivos. Valores perdidos na conversão.";
      } else if (filesWithData.length === 0) {
        cause = "Coluna não encontrada em nenhum arquivo (possível coluna derivada).";
      } else {
        cause = `Coluna presente apenas em ${filesWithData.length}/${fileSchemas.length} arquivos.`;
      }

      diagnostics.push({
        column: col,
        null_pct: Math.round(nullPct * 10) / 10,
        probable_cause: cause,
        files_with_data: filesWithData,
      });
    }
  }

  return diagnostics.sort((a, b) => b.null_pct - a.null_pct);
}

// ═══════════════════════════════════════════════════════════
// Import Manifest Generator
// ═══════════════════════════════════════════════════════════
async function createImportManifest(
  supabase: any,
  projectId: string,
  userId: string,
  batchId: string | null,
  datasetId: string | null,
  fileResults: FileProcessResult[],
  fileSchemas: FileSchema[],
  fileNames: string[],
  canonical: CanonicalSchema & { columnMapping?: ColumnMappingEntry[] },
  totalRowsConsolidated: number,
  allSampleRows: Record<string, unknown>[],
): Promise<void> {
  try {
    const rowsSum = fileSchemas.reduce((s, sc) => s + sc.totalRows, 0);
    const nullDiag = computeNullDiagnostic(canonical.columns, fileSchemas, fileNames, allSampleRows);

    // Build per-file entries
    const files = fileResults.map((result, i) => {
      const schema = result.schema;
      const nullPctByCol: { col: string; pct: number }[] = [];
      const missingCols: string[] = [];

      if (schema && allSampleRows.length > 0) {
        // Compute null% per column for this file's contribution
        for (const col of schema.columns) {
          const nullCount = schema.sampleRows.filter(row => {
            const v = row[col];
            return v === null || v === undefined || String(v).trim() === "";
          }).length;
          const pct = schema.sampleRows.length > 0 ? Math.round((nullCount / schema.sampleRows.length) * 1000) / 10 : 0;
          if (pct > 0) nullPctByCol.push({ col, pct });
        }
        nullPctByCol.sort((a, b) => b.pct - a.pct);

        // Check which canonical columns are missing from this file
        for (const canonCol of canonical.columns) {
          const normCanon = normalizeColumnName(canonCol);
          const hasCol = schema.columns.some(c => normalizeColumnName(c) === normCanon);
          if (!hasCol) missingCols.push(canonCol);
        }
      }

      let status: "ok" | "warn" | "fail" = "ok";
      const parseWarnings: string[] = [];

      if (!result.success) {
        status = "fail";
        if (result.error) parseWarnings.push(result.error);
      } else if (missingCols.length > 0) {
        status = "warn";
        parseWarnings.push(`${missingCols.length} coluna(s) ausente(s): ${missingCols.slice(0, 3).join(", ")}${missingCols.length > 3 ? "..." : ""}`);
      }

      return {
        file_id: result.jobId,
        file_name: result.fileName,
        format: result.format,
        size_mb: schema ? Math.round((schema.sampleRows.length * 100) / 100) : 0, // approximate
        rows_detected: result.rowsRead,
        rows_loaded: result.rowsRead,
        cols_detected: schema?.columns.length || 0,
        schema_detected: schema?.columnTypes || {},
        null_pct_by_col: nullPctByCol.slice(0, 10),
        parse_warnings: parseWarnings,
        status,
        missing_cols: missingCols,
      };
    });

    const filesOk = files.filter(f => f.status === "ok").length;
    const filesWarn = files.filter(f => f.status === "warn").length;
    const filesFail = files.filter(f => f.status === "fail").length;

    let overallStatus: "ok" | "warn" | "fail" = "ok";
    let statusReason: string | null = null;

    if (filesFail > 0 && filesOk === 0) {
      overallStatus = "fail";
      statusReason = "Todos os arquivos falharam no processamento.";
    } else if (filesFail > 0) {
      overallStatus = "warn";
      statusReason = `${filesFail} arquivo(s) falharam. Dataset parcial.`;
    } else if (nullDiag.some(d => d.null_pct > 80)) {
      overallStatus = "warn";
      statusReason = "Colunas com >80% NULL detectadas — possível mismatch de schema.";
    } else if (filesWarn > 0) {
      overallStatus = "warn";
      statusReason = `${filesWarn} arquivo(s) com schemas divergentes.`;
    }

    if (totalRowsConsolidated === 0) {
      overallStatus = "fail";
      statusReason = "Nenhuma linha consolidada. Verifique os arquivos e schemas.";
    }

    const { data: manifestData, error: manifestError } = await supabase.from("import_manifests").insert({
      project_id: projectId,
      user_id: userId,
      batch_id: batchId,
      dataset_id: datasetId,
      total_files: fileResults.length,
      files_ok: filesOk,
      files_warn: filesWarn,
      files_fail: filesFail,
      rows_sum: rowsSum,
      rows_consolidated: totalRowsConsolidated,
      rows_difference: Math.max(0, rowsSum - totalRowsConsolidated),
      columns_final: canonical.columns.length,
      canonical_schema: canonical.columnTypes,
      column_mapping_report: canonical.columnMapping || [],
      null_diagnostic: nullDiag,
      files,
      status: overallStatus,
      status_reason: statusReason,
    }).select("id").single();

    const manifestId = manifestData?.id || null;
    console.log(`[process-import] Manifest created: ${overallStatus}, ${files.length} files, ${totalRowsConsolidated} rows, manifest_id=${manifestId}`);
    return manifestId;
  } catch (e) {
    console.error("[process-import] Failed to create manifest:", e);
    return null;
  }
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

    // Create manifest for single file
    const singleCanonical = { columns: schema.columns, columnTypes: schema.columnTypes, sourceFiles: 1, columnMapping: schema.columns.map(c => ({ canonical: c, type: schema.columnTypes[c] || "texto", sources: [{ file: job.file_name, original_col: c }] })) };
    const singleFileResult: FileProcessResult = { success: true, jobId: job.id, fileName: job.file_name, format: schema.format, schema, rowsRead: schema.totalRows, coveragePct: 100 };
    const manifestId = await createImportManifest(supabase, job.project_id, job.user_id, null, datasetId, [singleFileResult], [schema], [job.file_name], singleCanonical, schema.totalRows, schema.sampleRows);

    console.log(`[process-import] Job ${job.id} completed: ${schema.format.toUpperCase()}, ${schema.totalRows} rows, ${schema.columns.length} cols, manifest_generated=${!!manifestId}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Importação concluída: ~${schema.totalRows.toLocaleString()} linhas`,
      rows_processed: schema.totalRows,
      columns: schema.columns.length,
      format: schema.format,
      dataset_id: datasetId,
      manifest_generated: !!manifestId,
      manifest_id: manifestId,
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
  const successFileNames = successResults.map(r => r.fileName);
  const canonical = buildCanonicalSchema(successSchemas, successFileNames);

  // Log schema divergences (using normalization)
  for (const result of successResults) {
    if (result.schema!.schemaHash !== successSchemas[0].schemaHash) {
      const missing = canonical.columns.filter(c =>
        !result.schema!.columns.some(fc => normalizeColumnName(fc) === normalizeColumnName(c))
      );
      const extra = result.schema!.columns.filter(fc =>
        !canonical.columns.some(c => normalizeColumnName(c) === normalizeColumnName(fc))
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

  // Threshold: skip storage copy for files larger than 20MB to avoid CPU timeout
  const COPY_SIZE_LIMIT = 20 * 1024 * 1024;

  for (let i = 0; i < successResults.length; i++) {
    const result = successResults[i];
    const schema = result.schema!;
    const job = batchJobs.find((j: ImportJob) => j.id === result.jobId) as ImportJob;

    // Normalize samples to canonical schema (with imputation: 0 for numeric, "missing" for categorical)
    const normalizedSamples = normalizeToSchema(schema.sampleRows, schema.columns, canonical.columns, canonical.columnTypes);

    // Proportional sample allocation
    const sampleBudget = Math.max(10, Math.ceil((schema.totalRows / Math.max(totalSuccessRows, 1)) * totalSampleBudget));
    const samplesToAdd = normalizedSamples.slice(0, sampleBudget);

    if (allSampleRows.length < totalSampleBudget) {
      allSampleRows = allSampleRows.concat(samplesToAdd.slice(0, totalSampleBudget - allSampleRows.length));
    }

    totalRowsConsolidated += schema.totalRows;
    totalFileSizeBytes += job.file_size_bytes;

    // For large files, skip the expensive storage copy and reference original path directly
    if (job.file_size_bytes > COPY_SIZE_LIMIT) {
      processedFilePaths.push(job.storage_path);
      await completeJob(supabase, job.id, schema.totalRows, null);
      console.log(`[process-import] ✓ Referenced ${job.file_name} in-place (${(job.file_size_bytes / 1024 / 1024).toFixed(1)} MB > copy limit)`);
    } else {
      // Copy small files to datasets bucket
      const sanitizedName = sanitizeFileName(job.file_name);
      const destPath = `${batchFolder}/${sanitizedName}`;

      try {
        const { error: copyError } = await supabase.storage
          .from("big_imports").copy(job.storage_path, destPath, { destinationBucket: "datasets" });
        if (copyError && !copyError.message?.includes("already exists")) throw copyError;

        processedFilePaths.push(destPath);
        await completeJob(supabase, job.id, schema.totalRows, null);
        console.log(`[process-import] ✓ Copied ${job.file_name} → datasets/${destPath}`);
      } catch (copyErr: any) {
        const errMsg = copyErr?.message || "Falha ao copiar arquivo.";
        console.warn(`[process-import] Copy failed for ${job.file_name}:`, errMsg);
        // Still mark as success — schema was extracted; just reference original path
        processedFilePaths.push(job.storage_path);
        await completeJob(supabase, job.id, schema.totalRows, null);
        console.log(`[process-import] ⚠ Copy failed, referencing original path for ${job.file_name}`);
      }
    }
  }

  // ─── Phase 4: EDA Gate ─────────────────────────────────────
  const coveragePct = batchJobs.length > 0
    ? Math.round((successResults.length / batchJobs.length) * 100)
    : 0;
  const passesEDAGate = totalRowsConsolidated > 0 && canonical.columns.length > 0 && coveragePct >= 50;

  if (!passesEDAGate) {
    // Build specific, actionable error message
    const reasons: string[] = [];
    if (totalRowsConsolidated === 0) {
      reasons.push("Nenhuma linha válida encontrada após consolidação.");
    }
    if (canonical.columns.length === 0) {
      reasons.push("Nenhuma coluna detectada no schema canônico.");
    }
    if (coveragePct < 50) {
      reasons.push(`Apenas ${coveragePct}% dos arquivos foram processados com sucesso (mínimo: 50%).`);
    }
    if (failedResults.length > 0) {
      reasons.push(`Arquivos com falha: ${failedResults.map(r => `"${r.fileName}" (${r.error})`).join("; ")}`);
    }

    const gateMsg = `Não foi possível consolidar o dataset.\n\n` +
      `Motivos:\n${reasons.map(r => `• ${r}`).join("\n")}\n\n` +
      `Ações sugeridas:\n` +
      `• Verifique se os arquivos estão no formato correto e não estão corrompidos.\n` +
      `• Confirme que os delimitadores (;  ,  \\t) estão corretos.\n` +
      `• Tente importar menos arquivos para isolar o problema.`;

    console.error(`[process-import] ${gateMsg}`);
    await updateJobError(supabase, primaryJob.id, gateMsg);
    return new Response(JSON.stringify({ success: false, message: gateMsg, file_results: fileResults }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ─── Phase 5: Entity Key Detection + Target Anchor ─────────
  const entityKeyCandidates = detectEntityKeys(
    canonical.columns, canonical.columnTypes, successSchemas, successFileNames, allSampleRows,
  );
  if (entityKeyCandidates.length > 0) {
    console.log(`[process-import] Entity key candidates: ${entityKeyCandidates.map(k => `${k.column}(score=${k.score})`).join(", ")}`);
  }

  // Try to detect target from project settings
  const { data: projectData } = await supabase
    .from("projects")
    .select("target_column")
    .eq("id", primaryJob.project_id)
    .single();

  const targetAnchor = detectTargetAnchor(
    successSchemas, successFileNames, projectData?.target_column || null, canonical.columns,
  );
  if (targetAnchor) {
    console.log(`[process-import] Target anchor: strategy=${targetAnchor.strategy}, anchor="${targetAnchor.anchorFileName}"`);
    if (targetAnchor.warnings.length > 0) {
      console.log(`[process-import] Target warnings: ${targetAnchor.warnings.join(" | ")}`);
    }
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
      delimiter: primaryJob.delimiter || ",",
      encoding: primaryJob.encoding || "utf-8",
      // New: entity keys and target anchor
      entity_keys: entityKeyCandidates,
      target_anchor: targetAnchor ? {
        strategy: targetAnchor.strategy,
        anchor_file: targetAnchor.anchorFileName,
        target_column: targetAnchor.targetColumn,
        target_presence: targetAnchor.targetPresence,
        warnings: targetAnchor.warnings,
      } : null,
      imputation_applied: true,
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
      entity_keys: entityKeyCandidates.map(k => k.column),
      target_anchor_strategy: targetAnchor?.strategy || null,
    },
  });

  // ─── Create Import Manifest ─────────────────────────────────
  const allFileNames = batchJobs.map((j: ImportJob) => j.file_name);
  const manifestId = await createImportManifest(
    supabase, primaryJob.project_id, primaryJob.user_id, primaryJob.batch_id, datasetId,
    fileResults, successSchemas, allFileNames, canonical, totalRowsConsolidated, allSampleRows,
  );

  // Build response with rich context
  const responseWarnings: string[] = [];
  if (targetAnchor?.warnings) responseWarnings.push(...targetAnchor.warnings);
  if (entityKeyCandidates.length > 0) {
    responseWarnings.push(
      `Chaves de entidade detectadas: ${entityKeyCandidates.map(k => k.column).join(", ")}. ` +
      `Podem ser usadas para enriquecer features via JOIN em versões futuras.`
    );
  }

  const responseMessage = failedResults.length > 0
    ? `Importação parcial: ${successResults.length}/${batchJobs.length} arquivos ok, ~${totalRowsConsolidated.toLocaleString()} linhas, ${coveragePct}% coverage`
    : `Batch consolidado: ${successResults.length} arquivos, ~${totalRowsConsolidated.toLocaleString()} linhas, ${canonical.columns.length} colunas`;

  console.log(`[process-import] Batch ${primaryJob.batch_id} done. ${responseMessage}, manifest_generated=${!!manifestId}`);

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
    manifest_generated: !!manifestId,
    manifest_id: manifestId,
    entity_keys: entityKeyCandidates,
    target_anchor: targetAnchor ? {
      strategy: targetAnchor.strategy,
      anchor_file: targetAnchor.anchorFileName,
      target_column: targetAnchor.targetColumn,
    } : null,
    warnings: responseWarnings,
    imputation_applied: true,
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
