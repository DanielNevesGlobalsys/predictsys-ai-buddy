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
const FILE_SAMPLE_CAP = 200; // Max sample rows stored per file

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
  phase: string;
  total_files: number;
  processed_files: number;
  bytes_total: number;
  bytes_done: number;
}

interface ImportJobFile {
  id: string;
  job_id: string;
  project_id: string;
  user_id: string;
  file_name: string;
  storage_path: string;
  file_size_bytes: number;
  format: string;
  sequence_index: number;
  status: string;
  rows_detected: number;
  cols_detected: number;
  schema_json: any;
  schema_hash: string | null;
  sample_json: any;
  checkpoint_cursor: any;
  quality_gate: string;
  quality_reasons: any[];
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
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

interface QualityGateResult {
  gate: "approved" | "warn" | "blocked";
  reasons: { code: string; message: string; severity: "info" | "warn" | "error" }[];
}

// ═══════════════════════════════════════════════════════════
// Event logging helper
// ═══════════════════════════════════════════════════════════
async function logEvent(
  supabase: any,
  jobId: string,
  projectId: string,
  eventType: string,
  message: string,
  severity: "info" | "warn" | "error" = "info",
  fileId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from("import_job_events").insert({
      job_id: jobId,
      file_id: fileId || null,
      project_id: projectId,
      event_type: eventType,
      severity,
      message,
      metadata: metadata || {},
    });
  } catch (e) {
    console.warn(`[process-import] Failed to log event ${eventType}:`, e);
  }
}

// ═══════════════════════════════════════════════════════════
// Quality Gates per file (format-specific + schema drift)
// ═══════════════════════════════════════════════════════════
function evaluateFileQualityGate(
  schema: FileSchema,
  fileName: string,
  fileSize: number,
  referenceSchemaHash?: string | null,
): QualityGateResult {
  const reasons: QualityGateResult["reasons"] = [];
  let gate: QualityGateResult["gate"] = "approved";

  // Gate 1: Empty file
  if (schema.totalRows === 0) {
    reasons.push({ code: "EMPTY_FILE", message: `Arquivo "${fileName}" tem 0 linhas.`, severity: "error" });
    return { gate: "blocked", reasons };
  }

  // Gate 2: No columns
  if (schema.columns.length === 0) {
    reasons.push({ code: "NO_COLUMNS", message: `Nenhuma coluna detectada em "${fileName}".`, severity: "error" });
    return { gate: "blocked", reasons };
  }

  // Gate 3: Too few rows
  if (schema.totalRows < 10) {
    reasons.push({ code: "FEW_ROWS", message: `Apenas ${schema.totalRows} linhas em "${fileName}".`, severity: "warn" });
    gate = "warn";
  }

  // Gate 4: Schema drift (compared to first/reference file)
  if (referenceSchemaHash && schema.schemaHash !== referenceSchemaHash) {
    reasons.push({
      code: "SCHEMA_DRIFT",
      message: `Schema de "${fileName}" difere do arquivo de referência. Colunas serão unificadas via union-by-name.`,
      severity: "warn",
    });
    if (gate !== "blocked") gate = "warn";
  }

  // Gate 5: Format-specific checks
  if (schema.format === "excel" && fileSize > 100 * 1024 * 1024) {
    reasons.push({ code: "LARGE_EXCEL", message: `Excel muito grande (${(fileSize / 1024 / 1024).toFixed(0)} MB). Conversão para CSV recomendada.`, severity: "warn" });
    if (gate !== "blocked") gate = "warn";
  }

  if (schema.format === "parquet" && fileSize > PARQUET_MEMORY_LIMIT) {
    reasons.push({ code: "LARGE_PARQUET", message: `Parquet excede limite de memória (${(PARQUET_MEMORY_LIMIT / 1024 / 1024).toFixed(0)} MB).`, severity: "error" });
    return { gate: "blocked", reasons };
  }

  // Gate 6: High null ratio in sample
  if (schema.sampleRows.length > 0) {
    let totalCells = 0;
    let nullCells = 0;
    for (const row of schema.sampleRows.slice(0, 100)) {
      for (const col of schema.columns) {
        totalCells++;
        const v = row[col];
        if (v === null || v === undefined || String(v).trim() === "") nullCells++;
      }
    }
    const nullPct = totalCells > 0 ? (nullCells / totalCells) * 100 : 0;
    if (nullPct > 80) {
      reasons.push({ code: "HIGH_NULL_RATE", message: `${nullPct.toFixed(0)}% de células vazias na amostra de "${fileName}".`, severity: "warn" });
      if (gate !== "blocked") gate = "warn";
    }
  }

  // Gate 7: Column count sanity
  if (schema.columns.length > 1000) {
    reasons.push({ code: "TOO_MANY_COLS", message: `${schema.columns.length} colunas detectadas — possível parse incorreto.`, severity: "error" });
    return { gate: "blocked", reasons };
  }

  if (reasons.length === 0) {
    reasons.push({ code: "OK", message: "Arquivo passou em todas as validações.", severity: "info" });
  }

  return { gate, reasons };
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
const _normalizeCache = new Map<string, string>();
function normalizeColumnName(name: string): string {
  const cached = _normalizeCache.get(name);
  if (cached !== undefined) return cached;
  const result = name
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  _normalizeCache.set(name, result);
  return result;
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

    const matchesPattern = ENTITY_KEY_PATTERNS.some(p => p.test(normalized));
    if (matchesPattern) {
      score += 40;
      reason = "Nome corresponde a padrão de chave. ";
    }

    const values = allSampleRows
      .map(r => r[col])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== "");
    
    if (values.length === 0) continue;

    const uniqueValues = new Set(values.map(v => String(v)));
    const uniqueRatio = uniqueValues.size / values.length;

    if (uniqueRatio > 0.8) {
      score += 30;
      reason += `Alta cardinalidade (${(uniqueRatio * 100).toFixed(0)}% únicos). `;
    } else if (uniqueRatio > 0.5) {
      score += 15;
      reason += `Cardinalidade moderada (${(uniqueRatio * 100).toFixed(0)}% únicos). `;
    } else {
      continue;
    }

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

  if (filesWithoutTarget.length === 0) {
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
  if (existingCanonicals.has(normalizedName)) return normalizedName;
  for (const group of EQUIVALENCE_GROUPS) {
    if (group.includes(normalizedName)) {
      for (const equiv of group) {
        if (existingCanonicals.has(equiv)) return equiv;
      }
    }
  }
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
  job: { storage_path: string; file_size_bytes: number; delimiter: string; encoding: string; file_name: string },
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
          if (!delimiter) {
            detectedDelimiter = autoDetectDelimiter(line);
          }
          headers = parseCSVLine(line, detectedDelimiter);
          isHeaderLine = false;
          console.log(`[process-import] CSV headers: ${headers.length} cols, delimiter="${detectedDelimiter}"`);
          continue;
        }

        rowCount++;
        bytesForRows += rawLine.length + 1;

        if (sampleRows.length < SAMPLE_SIZE) {
          const values = parseCSVLine(line, detectedDelimiter);
          if (values.length !== headers.length && sampleRows.length < 5) {
            console.warn(`[process-import] CSV row ${rowCount}: expected ${headers.length} cols, got ${values.length}`);
          }
          const row: Record<string, unknown> = {};
          headers.forEach((h, idx) => { row[h] = values[idx] ?? null; });
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
  job: { storage_path: string; file_size_bytes: number; file_name: string },
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
  job: { storage_path: string; file_size_bytes: number; file_name: string },
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

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, jsonData.length); i++) {
    const row = jsonData[i] as unknown[];
    const nonEmpty = row.filter(v => v !== null && v !== undefined && String(v).trim() !== "").length;
    if (nonEmpty >= 2) { headerRowIdx = i; break; }
  }

  const rawHeaders = (jsonData[headerRowIdx] as unknown[]);
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
    headers.forEach((header, i) => { obj[header] = (row as unknown[])[i] ?? null; });
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
  job: { storage_path: string; file_size_bytes: number; file_name: string },
  onProgress?: (p: number, r: number) => Promise<void>,
): Promise<FileSchema> {
  const signedUrl = await getSignedUrl(supabase, job.storage_path);
  if (onProgress) await onProgress(10, 0);

  const maxBytes = Math.min(job.file_size_bytes, SAMPLE_BYTES_LIMIT);
  const res = job.file_size_bytes <= SAMPLE_BYTES_LIMIT
    ? await downloadFile(signedUrl)
    : await downloadFile(signedUrl, { rangeEnd: maxBytes });

  const text = await res.text();
  if (onProgress) await onProgress(40, 0);

  let records: Record<string, unknown>[];

  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) { records = data; }
    else { throw new Error("JSON root is not an array"); }
  } else if (trimmed.startsWith("{")) {
    const lines = trimmed.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      records = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line.trim());
          if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
            records.push(obj);
          }
        } catch { /* Skip unparseable lines */ }
      }
      if (records.length === 0) throw new Error("Não foi possível parsear JSON Lines.");
    } else {
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
      if (!found) { records = [data]; }
    }
  } else {
    throw new Error("JSON inválido: não começa com [ ou {");
  }

  if (records.length === 0) throw new Error("Nenhum registro encontrado no arquivo JSON.");

  if (onProgress) await onProgress(60, records.length);

  const flattenedRecords = records.map(record => {
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          flat[`${key}.${nestedKey}`] = nestedValue;
        }
      } else {
        flat[key] = value;
      }
    }
    return flat;
  });

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

  const canonicalNames = new Map<string, string>();
  const columnOrder: string[] = [];
  const mappingEntries = new Map<string, ColumnMappingEntry>();

  for (let fi = 0; fi < fileSchemas.length; fi++) {
    const schema = fileSchemas[fi];
    const fileName = fileNames?.[fi] || `file_${fi + 1}`;

    for (const col of schema.columns) {
      const normalized = normalizeColumnName(col);
      let canonicalKey = canonicalNames.has(normalized) ? normalized : findEquivalentCanonical(normalized, canonicalNames);
      
      if (canonicalKey) {
        const entry = mappingEntries.get(canonicalKey)!;
        entry.sources.push({ file: fileName, original_col: col });
      } else {
        canonicalKey = normalized;
        const displayName = col;
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
      const hasNumeric = types.includes("numérico");
      const hasText = types.includes("texto");
      if (hasNumeric && !hasText) {
        mergedTypes[col] = "numérico";
      } else if (hasNumeric && hasText) {
        mergedTypes[col] = "numérico";
      } else {
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

    const entry = mappingEntries.get(normalized);
    if (entry) entry.type = mergedTypes[col];
  }

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
  const fileColMap = new Map<string, string>();
  for (const col of fileColumns) {
    fileColMap.set(normalizeColumnName(col), col);
  }
  const canonNormMap = new Map<string, string>();
  for (const col of canonicalColumns) {
    canonNormMap.set(normalizeColumnName(col), col);
  }

  const resolvedMap: { canonCol: string; sourceCol: string | null; imputeValue: unknown }[] = [];
  for (const canonCol of canonicalColumns) {
    const normKey = normalizeColumnName(canonCol);
    let sourceCol: string | null = fileColMap.get(normKey) ?? null;
    if (!sourceCol) {
      const equivKey = findEquivalentCanonical(normKey, canonNormMap);
      if (equivKey) sourceCol = fileColMap.get(equivKey) ?? null;
    }
    const colType = canonicalTypes?.[canonCol] || "texto";
    const imputeValue = colType === "numérico" ? 0 : "missing";
    resolvedMap.push({ canonCol, sourceCol, imputeValue });
  }

  return sampleRows.map(row => {
    const normalized: Record<string, unknown> = {};
    for (const { canonCol, sourceCol, imputeValue } of resolvedMap) {
      let value: unknown = sourceCol ? (row[sourceCol] ?? null) : null;
      if (value === null || value === undefined || String(value).trim() === "") {
        value = imputeValue;
      }
      normalized[canonCol] = value;
    }
    return normalized;
  });
}

// ═══════════════════════════════════════════════════════════
// Critical Column Detection
// ═══════════════════════════════════════════════════════════
const CRITICAL_HEURISTIC_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^(id|cod|codigo|code|chave|key|cpf|cnpj|matricula|contrato|uuid|pk)/i, reason: "chave/identificador" },
  { pattern: /(data|date|dt|timestamp|created|updated|ref)/i, reason: "temporal" },
  { pattern: /(valor|value|vlr|amount|price|preco|receita|revenue|total|saldo|balance)/i, reason: "financeiro" },
  { pattern: /(status|estado|state|flag|situacao|ativo|active|cancelado|cancelled|churn)/i, reason: "status/target potencial" },
  { pattern: /(score|prob|rating|nota|rank)/i, reason: "métrica/score" },
  { pattern: /(qty|qtd|quantidade|quantity|count|num_|nr_)/i, reason: "contagem" },
];

interface CriticalColumnTag {
  column: string;
  reason: string;
  source: "intent_contract" | "heuristic";
}

function detectCriticalColumns(
  canonicalColumns: string[],
  canonicalTypes: Record<string, string>,
  intentContract: any | null,
): CriticalColumnTag[] {
  const tags: CriticalColumnTag[] = [];
  const seen = new Set<string>();

  if (intentContract) {
    const ic = intentContract;
    for (const col of canonicalColumns) {
      const norm = normalizeColumnName(col);
      const colType = canonicalTypes[col] || "texto";

      if (ic.recommended_entity_key && norm.includes(normalizeColumnName(ic.recommended_entity_key))) {
        tags.push({ column: col, reason: "chave de entidade (IntentContract)", source: "intent_contract" });
        seen.add(col);
        continue;
      }
      if (ic.requires_time_column && colType === "data") {
        tags.push({ column: col, reason: "coluna temporal (IntentContract)", source: "intent_contract" });
        seen.add(col);
        continue;
      }
      if (["regression", "timeseries"].includes(ic.problem_type) && colType === "numérico") {
        for (const p of CRITICAL_HEURISTIC_PATTERNS.filter(p => p.reason === "financeiro" || p.reason === "contagem")) {
          if (p.pattern.test(norm)) {
            tags.push({ column: col, reason: `${p.reason} (IntentContract: ${ic.declared_objective})`, source: "intent_contract" });
            seen.add(col);
            break;
          }
        }
      }
      if (ic.problem_type === "classification" && colType === "categórico") {
        for (const p of CRITICAL_HEURISTIC_PATTERNS.filter(p => p.reason === "status/target potencial")) {
          if (p.pattern.test(norm)) {
            tags.push({ column: col, reason: `target potencial (IntentContract: ${ic.declared_objective})`, source: "intent_contract" });
            seen.add(col);
            break;
          }
        }
      }
    }
  }

  for (const col of canonicalColumns) {
    if (seen.has(col)) continue;
    const norm = normalizeColumnName(col);
    for (const p of CRITICAL_HEURISTIC_PATTERNS) {
      if (p.pattern.test(norm)) {
        tags.push({ column: col, reason: p.reason, source: "heuristic" });
        seen.add(col);
        break;
      }
    }
  }

  return tags;
}

// ═══════════════════════════════════════════════════════════
// Coverage Stats + NULL Diagnostic + EDA Strategy
// ═══════════════════════════════════════════════════════════
interface CoverageStats {
  critical_columns_pct: number;
  global_null_pct: number;
  top_10_null_columns: { column: string; null_pct: number }[];
  file_contribution: { file: string; rows: number; data_cols: number; null_only_cols: number; contribution_type: "data" | "mostly_null" }[];
}

interface NullDiagnosticEntry {
  column: string;
  null_pct: number;
  severity: "ok" | "warning" | "critical";
  probable_cause: string;
  files_with_data: string[];
  is_critical_column?: boolean;
  critical_reason?: string;
}

function computeCoverageStats(
  canonicalColumns: string[],
  fileSchemas: FileSchema[],
  fileNames: string[],
  allSampleRows: Record<string, unknown>[],
  nullDiag: NullDiagnosticEntry[],
): CoverageStats {
  const criticalCount = nullDiag.filter(d => d.severity === "critical").length;
  const critical_columns_pct = canonicalColumns.length > 0
    ? Math.round((criticalCount / canonicalColumns.length) * 1000) / 10 : 0;

  let totalCells = 0;
  let totalNulls = 0;
  for (const row of allSampleRows) {
    for (const col of canonicalColumns) {
      totalCells++;
      const v = row[col];
      if (v === null || v === undefined || String(v).trim() === "" || v === "missing") totalNulls++;
    }
  }
  const global_null_pct = totalCells > 0 ? Math.round((totalNulls / totalCells) * 1000) / 10 : 0;

  const colNulls: { column: string; null_pct: number }[] = [];
  for (const col of canonicalColumns) {
    const nullCount = allSampleRows.filter(row => {
      const v = row[col];
      return v === null || v === undefined || String(v).trim() === "" || v === "missing";
    }).length;
    const pct = allSampleRows.length > 0 ? Math.round((nullCount / allSampleRows.length) * 1000) / 10 : 0;
    colNulls.push({ column: col, null_pct: pct });
  }
  colNulls.sort((a, b) => b.null_pct - a.null_pct);
  const top_10_null_columns = colNulls.slice(0, 10);

  const file_contribution = fileSchemas.map((schema, i) => {
    const fileName = fileNames[i] || `file_${i + 1}`;
    const normSchemaCols = new Set(schema.columns.map(c => normalizeColumnName(c)));
    const dataCols = canonicalColumns.filter(c => normSchemaCols.has(normalizeColumnName(c))).length;
    const nullOnlyCols = canonicalColumns.length - dataCols;
    const contributionType: "data" | "mostly_null" = dataCols >= canonicalColumns.length * 0.5 ? "data" : "mostly_null";
    return { file: fileName, rows: schema.totalRows, data_cols: dataCols, null_only_cols: nullOnlyCols, contribution_type: contributionType };
  });

  return { critical_columns_pct, global_null_pct, top_10_null_columns, file_contribution };
}

function computeNullDiagnostic(
  canonicalColumns: string[],
  fileSchemas: FileSchema[],
  fileNames: string[],
  allSampleRows: Record<string, unknown>[],
  criticalTags?: CriticalColumnTag[],
): NullDiagnosticEntry[] {
  const diagnostics: NullDiagnosticEntry[] = [];
  if (allSampleRows.length === 0) return diagnostics;

  const criticalMap = new Map<string, CriticalColumnTag>();
  if (criticalTags) {
    for (const tag of criticalTags) criticalMap.set(tag.column, tag);
  }

  for (const col of canonicalColumns) {
    const nullCount = allSampleRows.filter(row => {
      const v = row[col];
      return v === null || v === undefined || String(v).trim() === "";
    }).length;
    const nullPct = (nullCount / allSampleRows.length) * 100;

    const severity: "ok" | "warning" | "critical" =
      nullPct > 50 ? "critical" : nullPct >= 30 ? "warning" : "ok";

    if (severity === "ok") continue;

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

    const critTag = criticalMap.get(col);
    diagnostics.push({
      column: col, null_pct: Math.round(nullPct * 10) / 10, severity, probable_cause: cause,
      files_with_data: filesWithData, is_critical_column: !!critTag, critical_reason: critTag?.reason,
    });
  }

  return diagnostics.sort((a, b) => {
    if (a.is_critical_column && !b.is_critical_column) return -1;
    if (!a.is_critical_column && b.is_critical_column) return 1;
    return b.null_pct - a.null_pct;
  });
}

interface EdaStrategyResult {
  strategy: "UNION_BY_NAME" | "INTERSECTION_ONLY" | "ANCHOR_FILE_EDA";
  scope: string;
  anchor_file?: string;
  reason: string;
}

function chooseEdaStrategy(
  fileSchemas: FileSchema[],
  fileNames: string[],
  canonicalColumns: string[],
  nullDiag: NullDiagnosticEntry[],
): EdaStrategyResult {
  if (fileSchemas.length <= 1) {
    return { strategy: "UNION_BY_NAME", scope: "union", reason: "Arquivo único — union completo." };
  }

  const colSetsNormalized = fileSchemas.map(s => new Set(s.columns.map(c => normalizeColumnName(c))));
  const allNormalized = new Set(canonicalColumns.map(c => normalizeColumnName(c)));
  const commonCols = [...allNormalized].filter(nc => colSetsNormalized.every(set => set.has(nc)));

  if (canonicalColumns.length >= 20 && commonCols.length >= 6) {
    return {
      strategy: "UNION_BY_NAME",
      scope: `union (${canonicalColumns.length} colunas, ${commonCols.length} comuns)`,
      reason: `Schema canônico com ${canonicalColumns.length} colunas, ${commonCols.length} comuns entre todos os arquivos.`,
    };
  }

  if (commonCols.length >= 6) {
    return {
      strategy: "INTERSECTION_ONLY",
      scope: `intersection (${commonCols.length} colunas comuns)`,
      reason: `${commonCols.length} colunas comuns detectadas.`,
    };
  }

  let bestIdx = 0;
  let bestRows = 0;
  for (let i = 0; i < fileSchemas.length; i++) {
    if (fileSchemas[i].totalRows > bestRows) { bestRows = fileSchemas[i].totalRows; bestIdx = i; }
  }

  return {
    strategy: "ANCHOR_FILE_EDA",
    scope: `anchor (${fileNames[bestIdx]})`,
    anchor_file: fileNames[bestIdx],
    reason: `Poucas colunas comuns (${commonCols.length}). Usando arquivo âncora "${fileNames[bestIdx]}".`,
  };
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

    const nativeNumberCount = values.filter(v => typeof v === "number").length;
    if (nativeNumberCount >= values.length * 0.8) { types[header] = "numérico"; continue; }

    const nativeBoolCount = values.filter(v => typeof v === "boolean").length;
    if (nativeBoolCount >= values.length * 0.8) { types[header] = "categórico"; continue; }

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
    .update({ status: "failed", phase: "failed", progress: 0, error_message: errorMessage, finished_at: new Date().toISOString() })
    .eq("id", jobId);
}

async function completeJob(supabase: any, jobId: string, rowsProcessed: number, datasetId: string | null): Promise<void> {
  await supabase
    .from("import_jobs")
    .update({ status: "completed", phase: "done", progress: 100, rows_processed: rowsProcessed, finished_at: new Date().toISOString(), dataset_id: datasetId })
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
// Unified file processing
// ═══════════════════════════════════════════════════════════
async function processFileUnified(
  supabase: any,
  job: { storage_path: string; file_size_bytes: number; file_name: string; delimiter: string; encoding: string },
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
): Promise<string | null> {
  try {
    const rowsSum = fileSchemas.reduce((s, sc) => s + sc.totalRows, 0);

    let intentContract: any = null;
    try {
      const { data: aiCtx } = await supabase
        .from("project_ai_context")
        .select("context")
        .eq("project_id", projectId)
        .single();
      if (aiCtx?.context?.intent) {
        const intentData = aiCtx.context.intent;
        intentContract = Array.isArray(intentData) ? intentData[intentData.length - 1] : intentData;
      }
    } catch { /* no intent contract yet */ }

    const criticalTags = detectCriticalColumns(canonical.columns, canonical.columnTypes, intentContract);
    const nullDiag = computeNullDiagnostic(canonical.columns, fileSchemas, fileNames, allSampleRows, criticalTags);
    const coverageStats = computeCoverageStats(canonical.columns, fileSchemas, fileNames, allSampleRows, nullDiag);
    const edaStrategy = chooseEdaStrategy(fileSchemas, fileNames, canonical.columns, nullDiag);

    const files = fileResults.map((result, i) => {
      const schema = result.schema;
      const nullPctByCol: { col: string; pct: number }[] = [];
      const missingCols: string[] = [];

      if (schema && allSampleRows.length > 0) {
        for (const col of schema.columns) {
          const nullCount = schema.sampleRows.filter(row => {
            const v = row[col];
            return v === null || v === undefined || String(v).trim() === "";
          }).length;
          const pct = schema.sampleRows.length > 0 ? Math.round((nullCount / schema.sampleRows.length) * 1000) / 10 : 0;
          if (pct > 0) nullPctByCol.push({ col, pct });
        }
        nullPctByCol.sort((a, b) => b.pct - a.pct);

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
        file_id: result.jobId, file_name: result.fileName, format: result.format,
        size_mb: schema ? Math.round((schema.sampleRows.length * 100) / 100) : 0,
        rows_detected: result.rowsRead, rows_loaded: result.rowsRead,
        cols_detected: schema?.columns.length || 0, schema_detected: schema?.columnTypes || {},
        null_pct_by_col: nullPctByCol.slice(0, 10), parse_warnings: parseWarnings,
        status, missing_cols: missingCols,
      };
    });

    const filesOk = files.filter(f => f.status === "ok").length;
    const filesWarn = files.filter(f => f.status === "warn").length;
    const filesFail = files.filter(f => f.status === "fail").length;

    let edaReady = true;
    let blockedReasonEda: string | null = null;

    if (totalRowsConsolidated === 0) {
      edaReady = false;
      blockedReasonEda = "Dataset consolidado tem 0 linhas.";
    } else if (canonical.columns.length === 0) {
      edaReady = false;
      blockedReasonEda = "Nenhuma coluna detectada.";
    } else if (filesFail > 0 && filesOk === 0) {
      edaReady = false;
      blockedReasonEda = "Todos os arquivos falharam no processamento.";
    }

    let modelReady = edaReady;
    let blockedReasonModel: string | null = null;

    const criticalCols = nullDiag.filter(d => d.severity === "critical").length;
    const criticalRatio = canonical.columns.length > 0 ? criticalCols / canonical.columns.length : 0;

    if (!edaReady) {
      modelReady = false;
      blockedReasonModel = blockedReasonEda;
    } else if (criticalRatio >= 0.8) {
      modelReady = false;
      blockedReasonModel = `${criticalCols} de ${canonical.columns.length} colunas (${Math.round(criticalRatio * 100)}%) estão em estado crítico (>50% NULL).`;
    }

    let overallStatus: "ok" | "warn" | "fail" | "blocked" = "ok";
    let statusReason: string | null = null;

    if (!edaReady) { overallStatus = "blocked"; statusReason = blockedReasonEda; }
    else if (!modelReady) { overallStatus = "warn"; statusReason = blockedReasonModel; }
    else if (filesFail > 0) { overallStatus = "warn"; statusReason = `${filesFail} arquivo(s) falharam. Dataset parcial.`; }
    else if (nullDiag.some(d => d.severity === "critical")) { overallStatus = "warn"; statusReason = `${criticalCols} coluna(s) com >50% NULL.`; }
    else if (filesWarn > 0) { overallStatus = "warn"; statusReason = `${filesWarn} arquivo(s) com schemas divergentes.`; }

    const { data: manifestData } = await supabase.from("import_manifests").insert({
      project_id: projectId, user_id: userId, batch_id: batchId, dataset_id: datasetId,
      total_files: fileResults.length, files_ok: filesOk, files_warn: filesWarn, files_fail: filesFail,
      rows_sum: rowsSum, rows_consolidated: totalRowsConsolidated,
      rows_difference: Math.max(0, rowsSum - totalRowsConsolidated),
      columns_final: canonical.columns.length,
      canonical_schema: { ...canonical.columnTypes, _coverage_stats: coverageStats, _critical_columns: criticalTags },
      column_mapping_report: canonical.columnMapping || [],
      null_diagnostic: nullDiag, files, status: overallStatus, status_reason: statusReason,
      eda_ready: edaReady, model_ready: modelReady, eda_strategy: edaStrategy.strategy,
      eda_scope: edaStrategy.scope, eda_dataset_id: datasetId,
      model_dataset_id: modelReady ? datasetId : null,
      blocked_reason_eda: blockedReasonEda, blocked_reason_model: blockedReasonModel,
    }).select("id").single();

    await supabase.from("projects").update({
      dataset_ready_for_modeling: modelReady,
      dataset_blocked_reason: modelReady ? null : blockedReasonModel,
    }).eq("id", projectId);

    const manifestId = manifestData?.id || null;
    console.log(`[process-import] Manifest created: status=${overallStatus}, eda_ready=${edaReady}, model_ready=${modelReady}, manifest_id=${manifestId}`);
    return manifestId;
  } catch (e) {
    console.error("[process-import] Failed to create manifest:", e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// PHASE A: Single file import (unchanged flow)
// ═══════════════════════════════════════════════════════════
async function processSingleImport(supabase: any, job: ImportJob): Promise<Response> {
  await supabase.from("import_jobs").update({ status: "processing", phase: "ingest", progress: 0, updated_at: new Date().toISOString() }).eq("id", job.id);

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

    // Quality gate
    const gate = evaluateFileQualityGate(schema, job.file_name, job.file_size_bytes);
    await logEvent(supabase, job.id, job.project_id, "quality_gate", `Gate: ${gate.gate} — ${gate.reasons.map(r => r.message).join("; ")}`, gate.gate === "blocked" ? "error" : gate.gate === "warn" ? "warn" : "info");

    if (gate.gate === "blocked") {
      await updateJobError(supabase, job.id, gate.reasons.map(r => r.message).join("; "));
      return new Response(JSON.stringify({ success: false, message: gate.reasons.map(r => r.message).join("; "), quality_gate: gate }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase.from("project_columns").delete().eq("project_id", job.project_id);
    const columnInserts = schema.columns.map((name, index) => ({
      project_id: job.project_id, column_name: name, column_index: index,
      inferred_type: schema.columnTypes[name] || "texto",
    }));
    await supabase.from("project_columns").insert(columnInserts);

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
        quality_gate: gate,
      },
    );

    await supabase.from("projects").update({
      dataset_filename: datasetPath, dataset_rows: sampleRowsCount,
      dataset_columns: schema.columns.length, total_rows: schema.totalRows,
      sample_rows: sampleRowsCount, status: "data_uploaded",
    }).eq("id", job.project_id);

    await supabase.from("project_data_ingestion_logs").insert({
      project_id: job.project_id, status: "success",
      rows_read: schema.totalRows, rows_sampled: sampleRowsCount,
      completed_at: new Date().toISOString(),
      metadata: { file_name: job.file_name, file_type: schema.format, storage_path: job.storage_path, dataset_path: datasetPath, dataset_id: datasetId, schema_cols: schema.columns.length, schema_hash: schema.schemaHash },
    });

    await completeJob(supabase, job.id, schema.totalRows, datasetId);

    const singleCanonical = { columns: schema.columns, columnTypes: schema.columnTypes, sourceFiles: 1, columnMapping: schema.columns.map(c => ({ canonical: c, type: schema.columnTypes[c] || "texto", sources: [{ file: job.file_name, original_col: c }] })) };
    const singleFileResult: FileProcessResult = { success: true, jobId: job.id, fileName: job.file_name, format: schema.format, schema, rowsRead: schema.totalRows, coveragePct: 100 };
    const manifestId = await createImportManifest(supabase, job.project_id, job.user_id, null, datasetId, [singleFileResult], [schema], [job.file_name], singleCanonical, schema.totalRows, schema.sampleRows);

    await logEvent(supabase, job.id, job.project_id, "job_completed", `Importação concluída: ${schema.totalRows} linhas, ${schema.columns.length} colunas`);

    return new Response(JSON.stringify({
      success: true,
      message: `Importação concluída: ~${schema.totalRows.toLocaleString()} linhas`,
      rows_processed: schema.totalRows, columns: schema.columns.length, format: schema.format,
      dataset_id: datasetId, manifest_generated: !!manifestId, manifest_id: manifestId,
      quality_gate: gate,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[process-import] Error on job ${job.id}:`, msg);
    await updateJobError(supabase, job.id, msg);
    await logEvent(supabase, job.id, job.project_id, "job_failed", msg, "error");
    return new Response(JSON.stringify({ success: false, message: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ═══════════════════════════════════════════════════════════
// PHASE A: Batch import — register files + process 1 at a time
// ═══════════════════════════════════════════════════════════
async function processBatchImport(supabase: any, primaryJob: ImportJob): Promise<Response> {
  console.log(`[process-import] Batch import: job=${primaryJob.id}, batch=${primaryJob.batch_id}`);

  // Fetch all jobs in this batch
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

  // Update primary job with totals
  await supabase.from("import_jobs").update({
    status: "processing",
    phase: "ingest",
    total_files: batchJobs.length,
    bytes_total: totalBatchSize,
    updated_at: new Date().toISOString(),
  }).eq("id", primaryJob.id);

  // ─── Step 1: Register all files in import_job_files (idempotent) ───
  const { data: existingFiles } = await supabase
    .from("import_job_files")
    .select("id, file_name, status")
    .eq("job_id", primaryJob.id);

  if (!existingFiles || existingFiles.length === 0) {
    // First call: register all files
    const fileInserts = batchJobs.map((job: ImportJob, i: number) => ({
      job_id: primaryJob.id,
      project_id: primaryJob.project_id,
      user_id: primaryJob.user_id,
      file_name: job.file_name,
      storage_path: job.storage_path,
      file_size_bytes: job.file_size_bytes,
      format: detectFileFormat(job.file_name, job.storage_path),
      sequence_index: i,
      status: "pending",
      quality_gate: "pending",
    }));

    await supabase.from("import_job_files").insert(fileInserts);
    await logEvent(supabase, primaryJob.id, primaryJob.project_id, "job_started", `Batch registrado: ${batchJobs.length} arquivos, ${(totalBatchSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[process-import] Registered ${batchJobs.length} files in import_job_files`);
  }

  // ─── Step 2: Find next pending file and process it ───
  const { data: pendingFiles } = await supabase
    .from("import_job_files")
    .select("*")
    .eq("job_id", primaryJob.id)
    .eq("status", "pending")
    .order("sequence_index", { ascending: true })
    .limit(1);

  if (!pendingFiles || pendingFiles.length === 0) {
    // All files processed — move to consolidation
    return await runConsolidation(supabase, primaryJob, batchJobs);
  }

  const fileRecord = pendingFiles[0] as ImportJobFile;
  const batchJob = batchJobs.find((j: ImportJob) => j.file_name === fileRecord.file_name && j.storage_path === fileRecord.storage_path) as ImportJob;

  if (!batchJob) {
    // File not found in batch — mark as failed and continue
    await supabase.from("import_job_files").update({
      status: "failed", error_code: "FILE_NOT_FOUND", error_message: "Job correspondente não encontrado no lote.",
      quality_gate: "blocked", finished_at: new Date().toISOString(),
    }).eq("id", fileRecord.id);
    await logEvent(supabase, primaryJob.id, primaryJob.project_id, "file_failed", `Arquivo "${fileRecord.file_name}" não encontrado no lote.`, "error", fileRecord.id);
    return await selfInvokeNext(supabase, primaryJob);
  }

  // ─── Step 3: Process this single file ───
  console.log(`[process-import] Processing file: ${fileRecord.file_name} (${fileRecord.sequence_index + 1}/${batchJobs.length})`);

  await supabase.from("import_job_files").update({
    status: "processing", started_at: new Date().toISOString(),
  }).eq("id", fileRecord.id);

  await supabase.from("import_jobs").update({
    status: "processing", progress: 0, updated_at: new Date().toISOString(),
  }).eq("id", batchJob.id);

  await logEvent(supabase, primaryJob.id, primaryJob.project_id, "file_started", `Processando "${fileRecord.file_name}" (${(fileRecord.file_size_bytes / 1024 / 1024).toFixed(1)} MB)`, "info", fileRecord.id);

  // Get reference schema hash (from first completed file) for schema drift detection
  const { data: refFile } = await supabase
    .from("import_job_files")
    .select("schema_hash")
    .eq("job_id", primaryJob.id)
    .eq("status", "completed")
    .order("sequence_index", { ascending: true })
    .limit(1)
    .maybeSingle();

  const referenceSchemaHash = refFile?.schema_hash || null;

  try {
    const progressCallback = async (p: number, r: number) => {
      await updateJobProgress(supabase, batchJob.id, p, r);
    };

    const schema = await processFileUnified(supabase, batchJob, progressCallback);

    // Quality gate
    const gate = evaluateFileQualityGate(schema, fileRecord.file_name, fileRecord.file_size_bytes, referenceSchemaHash);

    // Store results in import_job_files
    await supabase.from("import_job_files").update({
      status: gate.gate === "blocked" ? "failed" : "completed",
      rows_detected: schema.totalRows,
      cols_detected: schema.columns.length,
      schema_json: { columns: schema.columns, columnTypes: schema.columnTypes, schemaHash: schema.schemaHash, format: schema.format, totalRows: schema.totalRows },
      schema_hash: schema.schemaHash,
      sample_json: schema.sampleRows.slice(0, FILE_SAMPLE_CAP),
      quality_gate: gate.gate,
      quality_reasons: gate.reasons,
      error_code: gate.gate === "blocked" ? gate.reasons[0]?.code || "QUALITY_BLOCKED" : null,
      error_message: gate.gate === "blocked" ? gate.reasons.map(r => r.message).join("; ") : null,
      finished_at: new Date().toISOString(),
    }).eq("id", fileRecord.id);

    // Also store in legacy headers_json for backward compat
    await supabase.from("import_jobs").update({
      headers_json: { columns: schema.columns, columnTypes: schema.columnTypes, totalRows: schema.totalRows, sampleRows: schema.sampleRows.slice(0, FILE_SAMPLE_CAP), format: schema.format, schemaHash: schema.schemaHash },
      headers_hash: schema.schemaHash,
      status: gate.gate === "blocked" ? "failed" : "completed",
      progress: 100,
      rows_processed: schema.totalRows,
      finished_at: new Date().toISOString(),
    }).eq("id", batchJob.id);

    // Update primary job progress
    const { count: completedCount } = await supabase
      .from("import_job_files")
      .select("*", { count: "exact", head: true })
      .eq("job_id", primaryJob.id)
      .in("status", ["completed", "failed"]);

    const processedFiles = completedCount || 0;
    const overallProgress = Math.round((processedFiles / batchJobs.length) * 70);
    await supabase.from("import_jobs").update({
      processed_files: processedFiles,
      bytes_done: fileRecord.file_size_bytes + (primaryJob.bytes_done || 0),
      progress: overallProgress,
      updated_at: new Date().toISOString(),
    }).eq("id", primaryJob.id);

    await logEvent(
      supabase, primaryJob.id, primaryJob.project_id,
      gate.gate === "blocked" ? "file_failed" : "file_completed",
      `${fileRecord.file_name}: ${schema.columns.length} cols, ${schema.totalRows} rows, gate=${gate.gate}`,
      gate.gate === "blocked" ? "error" : gate.gate === "warn" ? "warn" : "info",
      fileRecord.id,
      { quality_gate: gate, schema_hash: schema.schemaHash },
    );

    console.log(`[process-import] ✓ ${fileRecord.file_name}: ${schema.columns.length} cols, ${schema.totalRows} rows, gate=${gate.gate}`);

  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro ao processar";
    console.error(`[process-import] ✗ ${fileRecord.file_name}: ${msg}`);

    await supabase.from("import_job_files").update({
      status: "failed",
      error_code: "PROCESSING_ERROR",
      error_message: msg,
      quality_gate: "blocked",
      quality_reasons: [{ code: "PROCESSING_ERROR", message: msg, severity: "error" }],
      retry_count: fileRecord.retry_count + 1,
      finished_at: new Date().toISOString(),
    }).eq("id", fileRecord.id);

    await updateJobError(supabase, batchJob.id, msg);
    await logEvent(supabase, primaryJob.id, primaryJob.project_id, "file_failed", `${fileRecord.file_name}: ${msg}`, "error", fileRecord.id);
  }

  // ─── Step 4: Self-invoke for next file ───
  return await selfInvokeNext(supabase, primaryJob);
}

// ═══════════════════════════════════════════════════════════
// Self-invoke helper (for sequential processing)
// ═══════════════════════════════════════════════════════════
async function selfInvokeNext(supabase: any, primaryJob: ImportJob): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Check if there are more pending files
  const { data: pendingFiles } = await supabase
    .from("import_job_files")
    .select("id")
    .eq("job_id", primaryJob.id)
    .eq("status", "pending")
    .limit(1);

  const hasMore = pendingFiles && pendingFiles.length > 0;

  try {
    // Self-invoke — the next call will either process the next file or run consolidation
    const invokeRes = await fetch(`${supabaseUrl}/functions/v1/process-import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        job_id: primaryJob.id,
        batch_id: primaryJob.batch_id,
      }),
    });
    await invokeRes.text(); // consume body
    console.log(`[process-import] Self-invoked: hasMore=${hasMore}, status=${invokeRes.status}`);
  } catch (invokeErr) {
    console.error(`[process-import] Failed to self-invoke:`, invokeErr);
  }

  return new Response(JSON.stringify({
    success: true,
    message: hasMore ? "Arquivo processado, continuando..." : "Todos os arquivos processados, consolidando...",
    phase: hasMore ? "ingest" : "consolidate",
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ═══════════════════════════════════════════════════════════
// PHASE B: Consolidation — build canonical schema from persisted data
// ═══════════════════════════════════════════════════════════
async function runConsolidation(supabase: any, primaryJob: ImportJob, batchJobs: ImportJob[]): Promise<Response> {
  console.log(`[process-import] Starting consolidation for batch ${primaryJob.batch_id}`);

  await supabase.from("import_jobs").update({
    phase: "consolidate", progress: 75, updated_at: new Date().toISOString(),
  }).eq("id", primaryJob.id);

  await logEvent(supabase, primaryJob.id, primaryJob.project_id, "consolidation_started", `Consolidando ${batchJobs.length} arquivos`);

  // Read all file records with their schemas
  const { data: allFiles } = await supabase
    .from("import_job_files")
    .select("*")
    .eq("job_id", primaryJob.id)
    .order("sequence_index", { ascending: true });

  if (!allFiles || allFiles.length === 0) {
    await updateJobError(supabase, primaryJob.id, "Nenhum arquivo encontrado para consolidação.");
    return new Response(JSON.stringify({ success: false, message: "No files found" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const completedFiles = (allFiles as ImportJobFile[]).filter(f => f.status === "completed");
  const failedFiles = (allFiles as ImportJobFile[]).filter(f => f.status === "failed");

  if (completedFiles.length === 0) {
    const errMsg = failedFiles.length > 0
      ? `Todos os arquivos falharam: ${failedFiles[0].error_message || "erro desconhecido"}`
      : "Nenhum arquivo processado com sucesso.";
    await updateJobError(supabase, primaryJob.id, errMsg);
    await logEvent(supabase, primaryJob.id, primaryJob.project_id, "job_failed", errMsg, "error");
    return new Response(JSON.stringify({ success: false, message: errMsg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Reconstruct FileSchema objects from import_job_files (no re-download!)
  const fileResults: FileProcessResult[] = [];
  const fileSchemas: FileSchema[] = [];
  const fileNames: string[] = [];

  for (const file of allFiles as ImportJobFile[]) {
    if (file.status === "completed" && file.schema_json) {
      const stored = file.schema_json as any;
      const schema: FileSchema = {
        columns: stored.columns || [],
        columnTypes: stored.columnTypes || {},
        totalRows: stored.totalRows || file.rows_detected || 0,
        sampleRows: (file.sample_json as Record<string, unknown>[]) || [],
        format: (stored.format || file.format) as FileFormat,
        schemaHash: stored.schemaHash || file.schema_hash || generateSchemaHash(stored.columns || []),
      };
      fileSchemas.push(schema);
      fileNames.push(file.file_name);
      fileResults.push({
        success: true, jobId: file.id, fileName: file.file_name,
        format: schema.format, schema, rowsRead: schema.totalRows, coveragePct: 100,
      });
    } else {
      fileResults.push({
        success: false, jobId: file.id, fileName: file.file_name,
        format: file.format as FileFormat, error: file.error_message || "Failed",
        rowsRead: 0, coveragePct: 0,
      });
    }
  }

  // Build canonical schema
  const canonical = buildCanonicalSchema(fileSchemas, fileNames);

  // Normalize + consolidate samples
  let allSampleRows: Record<string, unknown>[] = [];
  let totalRowsConsolidated = 0;
  const totalSuccessRows = fileSchemas.reduce((s, sc) => s + sc.totalRows, 0);
  const totalSampleBudget = fileSchemas.length >= 3 ? 3000 : SAMPLE_SIZE;

  const processedFilePaths: string[] = [];
  let totalFileSizeBytes = 0;
  const COPY_SIZE_LIMIT = 20 * 1024 * 1024;

  for (let i = 0; i < completedFiles.length; i++) {
    const file = completedFiles[i];
    const schemaIdx = fileNames.indexOf(file.file_name);
    if (schemaIdx < 0) continue;
    const schema = fileSchemas[schemaIdx];

    const normalizedSamples = normalizeToSchema(schema.sampleRows, schema.columns, canonical.columns, canonical.columnTypes);
    const sampleBudget = Math.max(10, Math.ceil((schema.totalRows / Math.max(totalSuccessRows, 1)) * totalSampleBudget));
    const samplesToAdd = normalizedSamples.slice(0, sampleBudget);

    if (allSampleRows.length < totalSampleBudget) {
      allSampleRows = allSampleRows.concat(samplesToAdd.slice(0, totalSampleBudget - allSampleRows.length));
    }

    totalRowsConsolidated += schema.totalRows;
    totalFileSizeBytes += file.file_size_bytes;

    if (file.file_size_bytes > COPY_SIZE_LIMIT) {
      processedFilePaths.push(file.storage_path);
    } else {
      const sanitizedName = sanitizeFileName(file.file_name);
      const batchFolder = `${primaryJob.user_id}/${primaryJob.project_id}/batch_${primaryJob.batch_id}`;
      const destPath = `${batchFolder}/${sanitizedName}`;
      try {
        const { error: copyError } = await supabase.storage
          .from("big_imports").copy(file.storage_path, destPath, { destinationBucket: "datasets" });
        if (copyError && !copyError.message?.includes("already exists")) throw copyError;
        processedFilePaths.push(destPath);
      } catch {
        processedFilePaths.push(file.storage_path);
      }
    }
  }

  // EDA Gate
  const passesEDAGate = totalRowsConsolidated > 0 && canonical.columns.length > 0 && completedFiles.length > 0;

  if (!passesEDAGate) {
    const reasons: string[] = [];
    if (totalRowsConsolidated === 0) reasons.push("Nenhuma linha válida.");
    if (canonical.columns.length === 0) reasons.push("Nenhuma coluna detectada.");
    const gateMsg = `Consolidação falhou: ${reasons.join("; ")}`;
    await updateJobError(supabase, primaryJob.id, gateMsg);
    await logEvent(supabase, primaryJob.id, primaryJob.project_id, "job_failed", gateMsg, "error");
    return new Response(JSON.stringify({ success: false, message: gateMsg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Entity Key Detection + Target Anchor
  const entityKeyCandidates = detectEntityKeys(canonical.columns, canonical.columnTypes, fileSchemas, fileNames, allSampleRows);

  const { data: projectData } = await supabase
    .from("projects").select("target_column").eq("id", primaryJob.project_id).single();

  const targetAnchor = detectTargetAnchor(fileSchemas, fileNames, projectData?.target_column || null, canonical.columns);

  // Save canonical columns
  await supabase.from("project_columns").delete().eq("project_id", primaryJob.project_id);
  const columnInserts = canonical.columns.map((name, index) => ({
    project_id: primaryJob.project_id, column_name: name, column_index: index,
    inferred_type: canonical.columnTypes[name] || "texto",
  }));
  await supabase.from("project_columns").insert(columnInserts);

  // Create consolidated dataset
  const batchFolder = `${primaryJob.user_id}/${primaryJob.project_id}/batch_${primaryJob.batch_id}`;
  const sampleRowsCount = Math.min(allSampleRows.length, totalSampleBudget);
  const coveragePct = batchJobs.length > 0 ? Math.round((completedFiles.length / batchJobs.length) * 100) : 0;

  const datasetId = await createDatasetRecord(
    supabase, primaryJob.project_id, primaryJob.user_id, primaryJob.file_name,
    batchFolder, totalFileSizeBytes, totalRowsConsolidated, sampleRowsCount,
    canonical.columns.length,
    completedFiles.length > 1 ? "batch_import" : "upload",
    {
      batch_id: primaryJob.batch_id,
      files_count: batchJobs.length,
      files_processed: completedFiles.length,
      files_failed: failedFiles.length,
      file_paths: processedFilePaths,
      file_names: fileNames,
      canonical_schema_hash: generateSchemaHash(canonical.columns),
      coverage_pct: coveragePct,
      entity_keys: entityKeyCandidates,
      target_anchor: targetAnchor ? { strategy: targetAnchor.strategy, anchor_file: targetAnchor.anchorFileName, target_column: targetAnchor.targetColumn } : null,
      imputation_applied: true,
    },
  );

  if (datasetId) {
    await supabase.from("import_jobs").update({ dataset_id: datasetId }).eq("batch_id", primaryJob.batch_id);
  }

  await supabase.from("projects").update({
    dataset_filename: batchFolder, dataset_rows: sampleRowsCount,
    dataset_columns: canonical.columns.length, total_rows: totalRowsConsolidated,
    sample_rows: sampleRowsCount, status: "data_uploaded",
  }).eq("id", primaryJob.project_id);

  await supabase.from("project_data_ingestion_logs").insert({
    project_id: primaryJob.project_id,
    status: failedFiles.length > 0 ? "partial" : "success",
    rows_read: totalRowsConsolidated, rows_sampled: sampleRowsCount,
    completed_at: new Date().toISOString(),
    metadata: {
      batch_id: primaryJob.batch_id,
      files_processed: completedFiles.length,
      files_failed: failedFiles.length,
      canonical_schema: { columns: canonical.columns, column_count: canonical.columns.length },
      coverage_pct: coveragePct,
      dataset_id: datasetId,
      engine_version: "v3",
    },
  });

  // Create Import Manifest
  const allFileNames = (allFiles as ImportJobFile[]).map(f => f.file_name);
  const manifestId = await createImportManifest(
    supabase, primaryJob.project_id, primaryJob.user_id, primaryJob.batch_id, datasetId,
    fileResults, fileSchemas, allFileNames, canonical, totalRowsConsolidated, allSampleRows,
  );

  // Complete primary job
  await supabase.from("import_jobs").update({
    status: "completed", phase: "done", progress: 100,
    processed_files: completedFiles.length,
    bytes_done: totalFileSizeBytes,
    rows_processed: totalRowsConsolidated,
    finished_at: new Date().toISOString(),
  }).eq("id", primaryJob.id);

  // ── SSOT: Complete ingestion (success) ──
  try {
    await supabase.rpc("rpc_complete_ingestion", {
      p_project_id: primaryJob.project_id,
      p_success: true,
      p_rows_detected: totalRowsConsolidated,
      p_cols_detected: canonical.columns.length,
      p_file_count: completedFiles.length,
      p_total_bytes: totalFileSizeBytes,
      p_dataset_id: datasetId || null,
      p_manifest_id: manifestId || null,
      p_error_code: null,
      p_error_message: null,
    });
  } catch (e) { console.warn("[process-import] rpc_complete_ingestion error:", e); }

  const responseMessage = failedFiles.length > 0
    ? `Importação parcial: ${completedFiles.length}/${batchJobs.length} arquivos ok, ~${totalRowsConsolidated.toLocaleString()} linhas`
    : `Batch consolidado: ${completedFiles.length} arquivos, ~${totalRowsConsolidated.toLocaleString()} linhas, ${canonical.columns.length} colunas`;

  await logEvent(supabase, primaryJob.id, primaryJob.project_id, "consolidation_completed", responseMessage);
  await logEvent(supabase, primaryJob.id, primaryJob.project_id, "job_completed", responseMessage);

  console.log(`[process-import] Batch ${primaryJob.batch_id} done. ${responseMessage}`);

  return new Response(JSON.stringify({
    success: true, status: "DONE", ingestion_state: "done",
    message: responseMessage,
    rows_processed: totalRowsConsolidated, columns: canonical.columns.length,
    files_processed: completedFiles.length, files_failed: failedFiles.length,
    coverage_pct: coveragePct, dataset_id: datasetId,
    manifest_generated: !!manifestId, manifest_id: manifestId,
    entity_keys: entityKeyCandidates,
    target_anchor: targetAnchor ? { strategy: targetAnchor.strategy, anchor_file: targetAnchor.anchorFileName } : null,
    quality_summary: {
      approved: completedFiles.filter(f => f.quality_gate === "approved").length,
      warn: completedFiles.filter(f => f.quality_gate === "warn").length,
      blocked: failedFiles.filter(f => f.quality_gate === "blocked").length,
    },
    engine_version: "v3",
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

    console.log(`[process-import] Starting: job=${job_id}, batch=${batch_id || "none"}`);

    const { data: job, error: jobError } = await supabase.from("import_jobs").select("*").eq("id", job_id).single();

    if (jobError || !job) {
      return new Response(JSON.stringify({ success: false, message: "Import job not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // For batch jobs: allow re-entry when status is "processing" (self-invocation pattern)
    if (!job.batch_id && job.status !== "pending") {
      return new Response(JSON.stringify({ success: true, message: `Job is already ${job.status}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (job.file_size_bytes > MAX_FILE_SIZE_BYTES) {
      await updateJobError(supabase, job_id, `Arquivo excede o limite de ${(MAX_FILE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(0)} GB.`);
      // SSOT: mark failed
      try { await supabase.rpc("rpc_complete_ingestion", {
        p_project_id: job.project_id, p_success: false, p_rows_detected: 0, p_cols_detected: 0,
        p_file_count: 0, p_total_bytes: job.file_size_bytes, p_dataset_id: null, p_manifest_id: null,
        p_error_code: "FILE_TOO_LARGE", p_error_message: "Arquivo excede o limite de tamanho.",
      }); } catch {}
      return new Response(JSON.stringify({ success: false, status: "FAILED", ingestion_state: "failed",
        error_code: "FILE_TOO_LARGE", message: "File too large" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── SSOT: Start ingestion (only on first call, not self-invocations) ──
    if (job.status === "pending" && (!job.batch_id || job.is_batch_primary)) {
      const configHash = `import_${job.file_name}_${job.file_size_bytes}_${job.batch_id || "single"}`;
      try {
        const { data: startResult } = await supabase.rpc("rpc_start_ingestion", {
          p_project_id: job.project_id, p_source_type: "upload", p_source_config_hash: configHash,
        });
        const sr = startResult as Record<string, unknown>;
        if (sr?.status === "ALREADY_DONE") {
          return new Response(JSON.stringify({
            success: true, status: "ALREADY_DONE", ingestion_state: "done",
            message: sr.message || "Dados já importados com esta configuração.",
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (sr?.error === "INGESTION_ALREADY_RUNNING") {
          return new Response(JSON.stringify({
            success: false, status: "ALREADY_RUNNING", ingestion_state: "running",
            error_code: "INGESTION_ALREADY_RUNNING",
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } catch (e) { console.warn("[process-import] rpc_start_ingestion fallback:", e); }
    }

    if (job.batch_id) {
      return await processBatchImport(supabase, job as ImportJob);
    } else {
      return await processSingleImport(supabase, job as ImportJob);
    }
  } catch (error: unknown) {
    console.error("[process-import] Unexpected error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    // Try to mark SSOT as failed if we have any job context
    return new Response(JSON.stringify({ success: false, status: "FAILED", ingestion_state: "failed",
      error_code: "UNKNOWN", error_friendly: message, message }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
