/**
 * Shared ingestion SSOT helpers for all ingestion edge functions.
 * Provides consistent state management, error codes, and response format.
 */

// ═══════════════════════════════════════════════════════════
// Standardized Error Codes
// ═══════════════════════════════════════════════════════════
export const INGESTION_ERROR_CODES = {
  UPLOAD_PARSE_ERROR: "UPLOAD_PARSE_ERROR",
  CONNECTOR_AUTH_ERROR: "CONNECTOR_AUTH_ERROR",
  CONNECTOR_TIMEOUT: "CONNECTOR_TIMEOUT",
  SCHEMA_INFERENCE_FAIL: "SCHEMA_INFERENCE_FAIL",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  MULTI_FILE_MISMATCH: "MULTI_FILE_MISMATCH",
  PARQUET_READ_FAIL: "PARQUET_READ_FAIL",
  CSV_DELIMITER_UNKNOWN: "CSV_DELIMITER_UNKNOWN",
  ENCODING_UNSUPPORTED: "ENCODING_UNSUPPORTED",
  STALE_INGESTION: "STALE_INGESTION",
  EMPTY_DATASET: "EMPTY_DATASET",
  CONNECTOR_NOT_FOUND: "CONNECTOR_NOT_FOUND",
  TABLE_NOT_FOUND: "TABLE_NOT_FOUND",
  SQL_VALIDATION_ERROR: "SQL_VALIDATION_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type IngestionErrorCode = keyof typeof INGESTION_ERROR_CODES;

// ═══════════════════════════════════════════════════════════
// Friendly error messages (pt-BR)
// ═══════════════════════════════════════════════════════════
const ERROR_FRIENDLY: Record<string, string> = {
  UPLOAD_PARSE_ERROR: "Erro ao interpretar o arquivo. Verifique o formato e tente novamente.",
  CONNECTOR_AUTH_ERROR: "Falha na autenticação do conector. Verifique suas credenciais.",
  CONNECTOR_TIMEOUT: "Conexão com a fonte de dados expirou. Tente novamente.",
  SCHEMA_INFERENCE_FAIL: "Não foi possível detectar o schema dos dados.",
  FILE_TOO_LARGE: "Arquivo excede o limite de tamanho permitido.",
  MULTI_FILE_MISMATCH: "Os arquivos possuem schemas incompatíveis.",
  PARQUET_READ_FAIL: "Erro ao ler arquivo Parquet. Verifique se o arquivo é válido.",
  CSV_DELIMITER_UNKNOWN: "Não foi possível detectar o delimitador do CSV.",
  ENCODING_UNSUPPORTED: "Encoding do arquivo não é suportado.",
  STALE_INGESTION: "A ingestão anterior ficou travada e foi recuperada. Tente novamente.",
  EMPTY_DATASET: "O dataset está vazio (0 linhas).",
  CONNECTOR_NOT_FOUND: "Conector de dados não encontrado.",
  TABLE_NOT_FOUND: "Tabela não encontrada na fonte de dados.",
  SQL_VALIDATION_ERROR: "A query SQL não é válida ou contém comandos proibidos.",
  UNKNOWN: "Erro desconhecido durante a ingestão.",
};

// ═══════════════════════════════════════════════════════════
// CTA helpers
// ═══════════════════════════════════════════════════════════
interface CTA {
  label: string;
  action: string;
  params?: Record<string, unknown>;
}

function getCTAsForError(errorCode: string): CTA[] {
  const ctas: CTA[] = [
    { label: "Tentar novamente", action: "retry_ingestion" },
  ];

  if (errorCode === "CONNECTOR_AUTH_ERROR") {
    ctas.push({ label: "Revalidar credenciais", action: "revalidate_credentials" });
  }
  if (errorCode !== "STALE_INGESTION") {
    ctas.push({ label: "Ver manifest", action: "view_manifest" });
  }

  return ctas;
}

// ═══════════════════════════════════════════════════════════
// Classify error into standard code
// ═══════════════════════════════════════════════════════════
export function classifyError(error: unknown, sourceType: string): { code: string; message: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const msgLower = msg.toLowerCase();

  if (msgLower.includes("auth") || msgLower.includes("permission") || msgLower.includes("401") || msgLower.includes("403")) {
    return { code: INGESTION_ERROR_CODES.CONNECTOR_AUTH_ERROR, message: msg };
  }
  if (msgLower.includes("timeout") || msgLower.includes("timed out") || msgLower.includes("econnreset")) {
    return { code: INGESTION_ERROR_CODES.CONNECTOR_TIMEOUT, message: msg };
  }
  if (msgLower.includes("parquet") || msgLower.includes("hyparquet")) {
    return { code: INGESTION_ERROR_CODES.PARQUET_READ_FAIL, message: msg };
  }
  if (msgLower.includes("empty") || msgLower.includes("0 linhas") || msgLower.includes("no records")) {
    return { code: INGESTION_ERROR_CODES.EMPTY_DATASET, message: msg };
  }
  if (msgLower.includes("too large") || msgLower.includes("excede") || msgLower.includes("limit")) {
    return { code: INGESTION_ERROR_CODES.FILE_TOO_LARGE, message: msg };
  }
  if (msgLower.includes("not found") && (msgLower.includes("table") || msgLower.includes("tabela"))) {
    return { code: INGESTION_ERROR_CODES.TABLE_NOT_FOUND, message: msg };
  }
  if (msgLower.includes("data source not found") || msgLower.includes("conector")) {
    return { code: INGESTION_ERROR_CODES.CONNECTOR_NOT_FOUND, message: msg };
  }
  if (msgLower.includes("delimiter") || msgLower.includes("delimitador")) {
    return { code: INGESTION_ERROR_CODES.CSV_DELIMITER_UNKNOWN, message: msg };
  }
  if (msgLower.includes("encoding") || msgLower.includes("charset")) {
    return { code: INGESTION_ERROR_CODES.ENCODING_UNSUPPORTED, message: msg };
  }
  if (msgLower.includes("sql") && (msgLower.includes("invalid") || msgLower.includes("proibid"))) {
    return { code: INGESTION_ERROR_CODES.SQL_VALIDATION_ERROR, message: msg };
  }
  if (msgLower.includes("parse") || msgLower.includes("unsupported file")) {
    return { code: INGESTION_ERROR_CODES.UPLOAD_PARSE_ERROR, message: msg };
  }

  return { code: INGESTION_ERROR_CODES.UNKNOWN, message: msg };
}

// ═══════════════════════════════════════════════════════════
// Generate source config hash
// ═══════════════════════════════════════════════════════════
export async function generateConfigHash(config: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(config));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ═══════════════════════════════════════════════════════════
// Start ingestion via RPC
// ═══════════════════════════════════════════════════════════
export async function startIngestion(
  supabase: any,
  projectId: string,
  sourceType: string,
  sourceConfigHash?: string,
): Promise<{ canProceed: boolean; status: string; response?: Response }> {
  const { data, error } = await supabase.rpc("rpc_start_ingestion", {
    p_project_id: projectId,
    p_source_type: sourceType,
    p_source_config_hash: sourceConfigHash || null,
  });

  if (error) {
    console.error(`[ingestion-ssot] rpc_start_ingestion error:`, error);
    return { canProceed: true, status: "rpc_error" }; // Graceful fallback: proceed anyway
  }

  const result = data as Record<string, unknown>;

  if (result.status === "ALREADY_DONE") {
    return {
      canProceed: false,
      status: "ALREADY_DONE",
      response: new Response(JSON.stringify({
        success: true,
        status: "ALREADY_DONE",
        ingestion_state: "done",
        message: result.message || "Dados já importados com esta configuração.",
        ctas: [{ label: "Forçar reimportação", action: "force_reimport" }],
      }), { headers: { "Content-Type": "application/json" }, status: 200 }),
    };
  }

  if (result.error === "INGESTION_ALREADY_RUNNING") {
    return {
      canProceed: false,
      status: "ALREADY_RUNNING",
      response: new Response(JSON.stringify({
        success: false,
        status: "ALREADY_RUNNING",
        ingestion_state: "running",
        error_code: "INGESTION_ALREADY_RUNNING",
        error_friendly: "Já existe uma ingestão em andamento para este projeto.",
        started_at: result.started_at,
        ctas: [{ label: "Aguardar", action: "wait" }],
      }), { headers: { "Content-Type": "application/json" }, status: 200 }),
    };
  }

  return { canProceed: true, status: result.status as string || "STARTED" };
}

// ═══════════════════════════════════════════════════════════
// Complete ingestion via RPC
// ═══════════════════════════════════════════════════════════
export async function completeIngestion(
  supabase: any,
  projectId: string,
  success: boolean,
  stats: {
    rowsDetected?: number;
    colsDetected?: number;
    fileCount?: number;
    totalBytes?: number;
    datasetId?: string;
    manifestId?: string;
    errorCode?: string;
    errorMessage?: string;
  } = {},
): Promise<void> {
  try {
    await supabase.rpc("rpc_complete_ingestion", {
      p_project_id: projectId,
      p_success: success,
      p_rows_detected: stats.rowsDetected || 0,
      p_cols_detected: stats.colsDetected || 0,
      p_file_count: stats.fileCount || 0,
      p_total_bytes: stats.totalBytes || 0,
      p_dataset_id: stats.datasetId || null,
      p_manifest_id: stats.manifestId || null,
      p_error_code: stats.errorCode || null,
      p_error_message: stats.errorMessage || null,
    });
  } catch (e) {
    console.error(`[ingestion-ssot] rpc_complete_ingestion error:`, e);
  }

  // On success, also activate (creates dataset_state + cascade)
  if (success) {
    try {
      await supabase.rpc("rpc_activate_ingestion", {
        p_project_id: projectId,
        p_source_type: "upload",
        p_config_hash: null,
        p_dataset_id: stats.datasetId || null,
        p_manifest_id: stats.manifestId || null,
        p_stats: {
          rows_detected: stats.rowsDetected || 0,
          cols_detected: stats.colsDetected || 0,
          file_count: stats.fileCount || 0,
          total_bytes: stats.totalBytes || 0,
        },
      });
    } catch (e) {
      console.error(`[ingestion-ssot] rpc_activate_ingestion error:`, e);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Build standardized error response
// ═══════════════════════════════════════════════════════════
export function buildErrorResponse(
  errorCode: string,
  errorMessage: string,
  debugContext?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({
    success: false,
    status: "FAILED",
    ingestion_state: "failed",
    error_code: errorCode,
    error_friendly: ERROR_FRIENDLY[errorCode] || ERROR_FRIENDLY.UNKNOWN,
    error_message: errorMessage,
    debug_context: debugContext || {},
    ctas: getCTAsForError(errorCode),
  }), { headers: { "Content-Type": "application/json" }, status: 200 }); // Always 200 per reliability standard
}

// ═══════════════════════════════════════════════════════════
// Build standardized success response
// ═══════════════════════════════════════════════════════════
export function buildSuccessResponse(
  data: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({
    success: true,
    status: "DONE",
    ingestion_state: "done",
    ...data,
    ctas: [{ label: "Ver manifest", action: "view_manifest" }],
  }), { headers: { "Content-Type": "application/json" }, status: 200 });
}
