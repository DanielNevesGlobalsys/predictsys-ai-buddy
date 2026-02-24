import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { parquetRead } from "npm:hyparquet@1.24.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ParsedData {
  columns: { name: string; type: string; index: number }[];
  rows: Record<string, unknown>[];
  totalRows: number;
  sampleRows: number;
}

const STALE_INGESTION_MS = 2 * 60 * 1000; // 2 minutes

function inferColumnType(values: unknown[]): string {
  const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
  if (nonNullValues.length === 0) return 'texto';

  let numericCount = 0;
  let dateCount = 0;
  let boolCount = 0;

  for (const value of nonNullValues.slice(0, 100)) {
    const strValue = String(value).trim();
    
    if (['true', 'false', '0', '1', 'sim', 'não', 'yes', 'no'].includes(strValue.toLowerCase())) {
      boolCount++;
      continue;
    }
    
    const num = Number(strValue.replace(',', '.'));
    if (!isNaN(num) && strValue !== '') {
      numericCount++;
      continue;
    }
    
    const datePatterns = [
      /^\d{4}-\d{2}-\d{2}$/,
      /^\d{2}\/\d{2}\/\d{4}$/,
      /^\d{2}-\d{2}-\d{4}$/,
    ];
    if (datePatterns.some(p => p.test(strValue))) {
      dateCount++;
    }
  }

  const threshold = nonNullValues.slice(0, 100).length * 0.7;
  
  if (numericCount >= threshold) return 'numérico';
  if (dateCount >= threshold) return 'data';
  if (boolCount >= threshold) return 'booleano';
  return 'texto';
}

function parseExcel(buffer: ArrayBuffer, maxSampleRows: number): ParsedData {
  console.log("[parse-file] Parsing Excel file...");
  
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  
  if (jsonData.length === 0) {
    throw new Error("Empty Excel file");
  }
  
  const headers = (jsonData[0] as unknown[]).map((h, i) => String(h || `Column_${i + 1}`));
  const dataRows = jsonData.slice(1);
  const totalRows = dataRows.length;
  
  const sampleSize = Math.min(maxSampleRows, totalRows);
  const sampledRows = dataRows.slice(0, sampleSize);
  
  const columns = headers.map((name, index) => {
    const columnValues = sampledRows.map(row => (row as unknown[])[index]);
    return {
      name,
      type: inferColumnType(columnValues),
      index
    };
  });
  
  const rows = sampledRows.map(row => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      obj[header] = (row as unknown[])[i] ?? null;
    });
    return obj;
  });
  
  console.log(`[parse-file] Excel parsed: ${columns.length} columns, ${totalRows} total rows, ${sampleSize} sampled`);
  
  return { columns, rows, totalRows, sampleRows: sampleSize };
}

function parseCSV(text: string, maxSampleRows: number): ParsedData {
  console.log("[parse-file] Parsing CSV file...");
  
  const firstLine = text.split('\n')[0];
  const delimiters = [',', ';', '\t', '|'];
  let delimiter = ',';
  let maxCount = 0;
  
  for (const d of delimiters) {
    const count = (firstLine.match(new RegExp(`\\${d}`, 'g')) || []).length;
    if (count > maxCount) {
      maxCount = count;
      delimiter = d;
    }
  }
  
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length === 0) {
    throw new Error("Empty CSV file");
  }
  
  const headers = parseCSVLine(lines[0], delimiter);
  const dataLines = lines.slice(1);
  const totalRows = dataLines.length;
  
  const sampleSize = Math.min(maxSampleRows, totalRows);
  const sampledLines = dataLines.slice(0, sampleSize);
  
  const parsedRows = sampledLines.map(line => parseCSVLine(line, delimiter));
  
  const columns = headers.map((name, index) => {
    const columnValues = parsedRows.map(row => row[index]);
    return {
      name: name || `Column_${index + 1}`,
      type: inferColumnType(columnValues),
      index
    };
  });
  
  const rows = parsedRows.map(row => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      obj[header || `Column_${i + 1}`] = row[i] ?? null;
    });
    return obj;
  });
  
  console.log(`[parse-file] CSV parsed: ${columns.length} columns, ${totalRows} total rows, ${sampleSize} sampled`);
  
  return { columns, rows, totalRows, sampleRows: sampleSize };
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
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
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

function parseJSON(text: string, maxSampleRows: number): ParsedData {
  console.log("[parse-file] Parsing JSON file...");
  
  const data = JSON.parse(text);
  let records: Record<string, unknown>[];
  
  if (Array.isArray(data)) {
    records = data;
  } else if (data.data && Array.isArray(data.data)) {
    records = data.data;
  } else if (data.records && Array.isArray(data.records)) {
    records = data.records;
  } else if (data.results && Array.isArray(data.results)) {
    records = data.results;
  } else {
    records = [data];
  }
  
  if (records.length === 0) {
    throw new Error("No records found in JSON file");
  }
  
  const totalRows = records.length;
  const sampleSize = Math.min(maxSampleRows, totalRows);
  const sampledRecords = records.slice(0, sampleSize);
  
  const keysSet = new Set<string>();
  for (const record of sampledRecords) {
    if (typeof record === 'object' && record !== null) {
      Object.keys(record).forEach(key => keysSet.add(key));
    }
  }
  const headers = Array.from(keysSet);
  
  const columns = headers.map((name, index) => {
    const columnValues = sampledRecords.map(row => row[name]);
    return {
      name,
      type: inferColumnType(columnValues),
      index
    };
  });
  
  const rows = sampledRecords.map(record => {
    const obj: Record<string, unknown> = {};
    headers.forEach(header => {
      obj[header] = record[header] ?? null;
    });
    return obj;
  });
  
  console.log(`[parse-file] JSON parsed: ${columns.length} columns, ${totalRows} total rows, ${sampleSize} sampled`);
  
  return { columns, rows, totalRows, sampleRows: sampleSize };
}

async function parseParquet(buffer: ArrayBuffer, maxSampleRows: number): Promise<ParsedData> {
  console.log("[parse-file] Parsing Parquet file...");
  
  let allRows: Record<string, unknown>[] = [];

  await parquetRead({
    file: buffer,
    rowFormat: "object",
    onComplete: (data: Record<string, unknown>[]) => {
      allRows = data;
    },
  });

  if (allRows.length === 0) throw new Error("Arquivo Parquet vazio ou ilegível.");

  const headers = Object.keys(allRows[0]);
  const totalRows = allRows.length;
  const sampleSize = Math.min(maxSampleRows, totalRows);
  const sampledRows = allRows.slice(0, sampleSize);

  // Clean non-primitive values
  const rows = sampledRows.map((row) => {
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

  const columns = headers.map((name, index) => {
    const columnValues = rows.map(row => row[name]);
    return {
      name,
      type: inferColumnType(columnValues),
      index
    };
  });

  console.log(`[parse-file] Parquet parsed: ${columns.length} columns, ${totalRows} total rows, ${sampleSize} sampled`);

  return { columns, rows, totalRows, sampleRows: sampleSize };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let projectId = "";

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    projectId = formData.get('project_id') as string;
    const maxSampleRows = parseInt(formData.get('max_sample_rows') as string || '100000');
    const originalSize = parseInt(formData.get('original_size') as string || '0');

    if (!file || !projectId) {
      throw new Error("File and project_id are required");
    }

    // ── ENTERPRISE: Validate project access ──
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
      if (user) {
        const { data: canAccess } = await supabase.rpc("user_can_access_project", {
          _user_id: user.id,
          _project_id: projectId,
        });
        if (canAccess === false) {
          return new Response(
            JSON.stringify({ error: "Access denied to this project", code: "ACCESS_DENIED" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    const isSliced = originalSize > 0 && originalSize > file.size;

    // ── SSOT: Start ingestion ──
    const configHash = `upload_${file.name}_${originalSize || file.size}`;
    const { canProceed, status: startStatus, response: earlyResponse } = await startIngestionSafe(supabase, projectId, "upload", configHash);
    if (!canProceed && earlyResponse) return earlyResponse;

    console.log(`[parse-file] Processing file: ${file.name}, size: ${file.size}, original: ${originalSize || file.size}, type: ${file.type}`);

    const fileName = file.name.toLowerCase();
    let parsedData: ParsedData;

    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      const buffer = await file.arrayBuffer();
      parsedData = parseExcel(buffer, maxSampleRows);
    } else if (fileName.endsWith('.csv')) {
      const text = await file.text();
      parsedData = parseCSV(text, maxSampleRows);
      // If we received a slice, estimate total rows from original file size
      if (isSliced && originalSize > 0) {
        const bytesPerRow = file.size / Math.max(parsedData.totalRows, 1);
        parsedData.totalRows = Math.round(originalSize / bytesPerRow);
      }
    } else if (fileName.endsWith('.json')) {
      const text = await file.text();
      parsedData = parseJSON(text, maxSampleRows);
    } else if (fileName.endsWith('.parquet') || fileName.endsWith('.parq') || fileName.endsWith('.pq')) {
      const buffer = await file.arrayBuffer();
      parsedData = await parseParquet(buffer, maxSampleRows);
    } else {
      throw new Error(`Unsupported file format: ${fileName}`);
    }

    // Store columns in project_columns
    console.log(`[parse-file] Storing ${parsedData.columns.length} columns for project ${projectId}`);
    
    await supabase
      .from('project_columns')
      .delete()
      .eq('project_id', projectId);

    const columnsToInsert = parsedData.columns.map(col => ({
      project_id: projectId,
      column_name: col.name,
      column_index: col.index,
      inferred_type: col.type
    }));

    const { error: columnsError } = await supabase
      .from('project_columns')
      .insert(columnsToInsert);

    if (columnsError) {
      console.error("[parse-file] Error inserting columns:", columnsError);
      throw columnsError;
    }

    await supabase
      .from('projects')
      .update({
        total_rows: parsedData.totalRows,
        sample_rows: parsedData.sampleRows,
        dataset_rows: parsedData.sampleRows,
        dataset_columns: parsedData.columns.length,
        dataset_filename: file.name,
        status: 'data_uploaded'
      })
      .eq('id', projectId);

    // ── SSOT: Finalize ingestion (atomic manifest + state=done) ──
    const schemaForManifest = parsedData.columns.map(col => ({
      name: col.name, type: col.type, index: col.index,
    }));

    try {
      const { data: finalizeResult, error: finalizeError } = await supabase.rpc("rpc_finalize_ingestion", {
        p_project_id: projectId,
        p_source_type: "upload",
        p_config_hash: configHash,
        p_dataset_id: null,
        p_source_pointer: { file_name: file.name, file_size: originalSize || file.size, sliced: isSliced },
        p_schema_json: schemaForManifest,
        p_row_count: parsedData.totalRows,
        p_col_count: parsedData.columns.length,
        p_total_bytes: originalSize || file.size,
        p_sample_strategy: { method: "head", max_rows: maxSampleRows },
        p_file_count: 1,
      });

      if (finalizeError) {
        console.error("[parse-file] rpc_finalize_ingestion error:", finalizeError);
        // Fallback: try legacy complete + activate
        await completeIngestionSafe(supabase, projectId, true, {
          rowsDetected: parsedData.totalRows, colsDetected: parsedData.columns.length,
          fileCount: 1, totalBytes: originalSize || file.size,
        });
        try {
          await supabase.rpc("rpc_activate_ingestion", {
            p_project_id: projectId, p_source_type: "upload", p_config_hash: configHash,
            p_dataset_id: null, p_manifest_id: null,
            p_stats: { rows_detected: parsedData.totalRows, cols_detected: parsedData.columns.length, file_count: 1, total_bytes: originalSize || file.size },
          });
        } catch (e2) { console.warn("[parse-file] fallback rpc_activate_ingestion:", e2); }
      } else {
        const fr = finalizeResult as Record<string, unknown>;
        console.log(`[parse-file] Finalized: manifest=${fr.manifest_id}, v${fr.dataset_version}`);
      }
    } catch (e) {
      console.warn("[parse-file] rpc_finalize_ingestion fallback:", e);
    }

    console.log(`[parse-file] File processing complete for project ${projectId}`);

    return new Response(
      JSON.stringify({
        success: true,
        status: "DONE",
        ingestion_state: "done",
        columns: parsedData.columns,
        totalRows: parsedData.totalRows,
        sampleRows: parsedData.sampleRows,
        preview: parsedData.rows.slice(0, 10)
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  } catch (error: unknown) {
    console.error("[parse-file] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred while parsing the file";
    const errorCode = classifyIngestionError(error);

    // ── SSOT: Complete ingestion (failure) ──
    if (projectId) {
      await completeIngestionSafe(supabase, projectId, false, {
        errorCode,
        errorMessage,
      });
    }
    
    return new Response(
      JSON.stringify({ 
        success: false,
        status: "FAILED",
        ingestion_state: "failed",
        error_code: errorCode,
        error_friendly: errorMessage,
        ctas: [{ label: "Tentar novamente", action: "retry_ingestion" }],
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  }
});

// ── Lightweight SSOT wrappers (no import needed) ──
async function startIngestionSafe(
  supabase: any, projectId: string, sourceType: string, configHash: string,
): Promise<{ canProceed: boolean; status: string; response?: Response }> {
  try {
    const startArgs = {
      p_project_id: projectId,
      p_source_type: sourceType,
      p_source_config_hash: configHash,
    };

    const { data, error } = await supabase.rpc("rpc_start_ingestion", startArgs);
    if (error) {
      console.warn("[parse-file] rpc_start_ingestion error:", error);
      return { canProceed: true, status: "rpc_error" };
    }

    const r = data as Record<string, unknown>;

    if (r.status === "ALREADY_DONE") {
      return {
        canProceed: false,
        status: "ALREADY_DONE",
        response: new Response(
          JSON.stringify({
            success: true,
            status: "ALREADY_DONE",
            ingestion_state: "done",
            message: r.message || "Dados já importados com esta configuração.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
        ),
      };
    }

    if (r.error === "INGESTION_ALREADY_RUNNING") {
      // Recovery path for orphan "running" state caused by abrupt worker shutdown (e.g., WORKER_LIMIT)
      const { data: stateRow } = await supabase
        .from("project_settings")
        .select("ingestion_state, ingestion_started_at")
        .eq("project_id", projectId)
        .maybeSingle();

      const startedAt = stateRow?.ingestion_started_at ? new Date(String(stateRow.ingestion_started_at)).getTime() : 0;
      const isRunning = stateRow?.ingestion_state === "running";
      const isStale = Boolean(startedAt) && Date.now() - startedAt > STALE_INGESTION_MS;

      if (isRunning && isStale) {
        console.warn("[parse-file] Detected stale ingestion lock. Releasing and retrying start...");

        await completeIngestionSafe(supabase, projectId, false, {
          errorCode: "INGESTION_STALE_LOCK",
          errorMessage: "Ingestão anterior interrompida por falta de recursos.",
        });

        const { data: retryData, error: retryError } = await supabase.rpc("rpc_start_ingestion", startArgs);
        if (!retryError) {
          const retry = retryData as Record<string, unknown>;
          if (retry.status !== "ALREADY_DONE" && retry.error !== "INGESTION_ALREADY_RUNNING") {
            return { canProceed: true, status: String(retry.status || "STARTED") };
          }
        } else {
          console.warn("[parse-file] rpc_start_ingestion retry error:", retryError);
        }
      }

      return {
        canProceed: false,
        status: "ALREADY_RUNNING",
        response: new Response(
          JSON.stringify({
            success: false,
            status: "ALREADY_RUNNING",
            ingestion_state: "running",
            error_code: "INGESTION_ALREADY_RUNNING",
            error_friendly: "Já existe uma ingestão em andamento para este projeto.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
        ),
      };
    }

    return { canProceed: true, status: String(r.status || "STARTED") };
  } catch (e) {
    console.warn("[parse-file] startIngestion fallback:", e);
    return { canProceed: true, status: "fallback" };
  }
}

async function completeIngestionSafe(
  supabase: any, projectId: string, success: boolean,
  stats: { rowsDetected?: number; colsDetected?: number; fileCount?: number; totalBytes?: number;
    datasetId?: string; manifestId?: string; errorCode?: string; errorMessage?: string; } = {},
): Promise<void> {
  try {
    await supabase.rpc("rpc_complete_ingestion", {
      p_project_id: projectId, p_success: success,
      p_rows_detected: stats.rowsDetected || 0, p_cols_detected: stats.colsDetected || 0,
      p_file_count: stats.fileCount || 0, p_total_bytes: stats.totalBytes || 0,
      p_dataset_id: stats.datasetId || null, p_manifest_id: stats.manifestId || null,
      p_error_code: stats.errorCode || null, p_error_message: stats.errorMessage || null,
    });
  } catch (e) { console.warn("[parse-file] completeIngestion fallback:", e); }
}

function classifyIngestionError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("worker_limit") || msg.includes("memory limit exceeded") || msg.includes("not having enough compute resources")) return "WORKER_LIMIT";
  if (msg.includes("parquet")) return "PARQUET_READ_FAIL";
  if (msg.includes("empty") || msg.includes("0 linhas")) return "EMPTY_DATASET";
  if (msg.includes("unsupported file")) return "UPLOAD_PARSE_ERROR";
  if (msg.includes("too large") || msg.includes("excede")) return "FILE_TOO_LARGE";
  if (msg.includes("parse") || msg.includes("csv") || msg.includes("excel")) return "UPLOAD_PARSE_ERROR";
  return "UNKNOWN";
}
