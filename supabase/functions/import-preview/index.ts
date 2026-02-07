import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { parquetRead } from "npm:hyparquet@1.24.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_PREVIEW_ROWS = 200;

interface PreviewColumn {
  name: string;
  type: string;
  index: number;
}

interface PreviewResult {
  columns: PreviewColumn[];
  previewRows: Record<string, unknown>[];
  totalRowsEstimate: number;
  warnings: string[];
}

// ── CSV helpers ──────────────────────────────────────────────

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

function detectDelimiter(firstLine: string): string {
  const delimiters = [",", ";", "\t", "|"];
  let best = ",";
  let max = 0;
  for (const d of delimiters) {
    const count = (firstLine.match(new RegExp(`\\${d}`, "g")) || []).length;
    if (count > max) {
      max = count;
      best = d;
    }
  }
  return best;
}

function previewCSV(
  text: string,
  originalSize: number,
  explicitDelimiter?: string,
): PreviewResult {
  const warnings: string[] = [];

  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new Error("Arquivo CSV vazio");

  const delimiter = explicitDelimiter || detectDelimiter(lines[0]);
  const headers = parseCSVLine(lines[0], delimiter);
  const dataLines = lines.slice(1);

  const previewCount = Math.min(MAX_PREVIEW_ROWS, dataLines.length);
  const previewLines = dataLines.slice(0, previewCount);

  const previewRows: Record<string, unknown>[] = previewLines.map((line) => {
    const values = parseCSVLine(line, delimiter);
    const row: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      row[h || `Column_${idx + 1}`] = values[idx] ?? null;
    });
    return row;
  });

  // Estimate total rows from byte ratio
  const bytesRead = text.length;
  const rowsInSlice = dataLines.length;
  let totalEstimate = rowsInSlice;

  if (originalSize > bytesRead && rowsInSlice > 0) {
    const avgBytesPerRow =
      (bytesRead - lines[0].length) / Math.max(rowsInSlice, 1);
    totalEstimate = Math.round(
      (originalSize - lines[0].length) / avgBytesPerRow,
    );
    warnings.push(
      `Estimativa baseada em amostragem: ~${totalEstimate.toLocaleString()} linhas no total.`,
    );
  }

  const columns = inferTypes(headers, previewRows);

  return { columns, previewRows, totalRowsEstimate: totalEstimate, warnings };
}

// ── JSON helpers ─────────────────────────────────────────────

function previewJSON(text: string, originalSize: number): PreviewResult {
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Might be truncated – try to recover array
    const trimmed = text.replace(/,\s*$/, "");
    parsed = JSON.parse(trimmed + "]");
    warnings.push("JSON parcial recuperado (arquivo truncado na amostragem).");
  }

  let records: Record<string, unknown>[];
  if (Array.isArray(parsed)) {
    records = parsed;
  } else if (
    typeof parsed === "object" &&
    parsed !== null
  ) {
    const obj = parsed as Record<string, unknown>;
    const arrayKey = ["data", "records", "results", "items"].find(
      (k) => Array.isArray(obj[k]),
    );
    records = arrayKey
      ? (obj[arrayKey] as Record<string, unknown>[])
      : [obj as Record<string, unknown>];
  } else {
    throw new Error("Formato JSON não reconhecido");
  }

  if (records.length === 0) throw new Error("JSON sem registros");

  const previewRows = records.slice(0, MAX_PREVIEW_ROWS);

  // Extract all keys
  const keysSet = new Set<string>();
  for (const r of previewRows) {
    if (typeof r === "object" && r !== null) {
      Object.keys(r).forEach((k) => keysSet.add(k));
    }
  }
  const headers = Array.from(keysSet);

  // Normalize rows
  const normalizedRows = previewRows.map((r) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h) => {
      const val = r[h];
      obj[h] =
        val !== null && val !== undefined && typeof val === "object"
          ? JSON.stringify(val)
          : val ?? null;
    });
    return obj;
  });

  // Estimate total
  let totalEstimate = records.length;
  if (originalSize > text.length && records.length > 0) {
    const ratio = originalSize / text.length;
    totalEstimate = Math.round(records.length * ratio);
    warnings.push(
      `Estimativa baseada em amostragem: ~${totalEstimate.toLocaleString()} registros no total.`,
    );
  }

  const columns = inferTypes(headers, normalizedRows);

  return {
    columns,
    previewRows: normalizedRows,
    totalRowsEstimate: totalEstimate,
    warnings,
  };
}

// ── Parquet helper ───────────────────────────────────────────

async function previewParquet(buffer: ArrayBuffer): Promise<PreviewResult> {
  const warnings: string[] = [];

  let allRows: Record<string, unknown>[] = [];

  await parquetRead({
    file: buffer,
    rowFormat: "object",
    onComplete: (data: Record<string, unknown>[]) => {
      allRows = data;
    },
  });

  if (allRows.length === 0)
    throw new Error("Arquivo Parquet vazio ou ilegível.");

  const headers = Object.keys(allRows[0]);
  const totalRows = allRows.length;
  const previewRows = allRows.slice(0, MAX_PREVIEW_ROWS);

  // Clean non-primitive values
  const cleanedRows = previewRows.map((row) => {
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

  const columns = inferTypes(headers, cleanedRows);

  return {
    columns,
    previewRows: cleanedRows,
    totalRowsEstimate: totalRows,
    warnings,
  };
}

// ── Type inference ───────────────────────────────────────────

function inferTypes(
  headers: string[],
  rows: Record<string, unknown>[],
): PreviewColumn[] {
  return headers.map((name, index) => {
    const values = rows
      .map((r) => r[name])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== "");

    if (values.length === 0) return { name, type: "texto", index };

    // Native numbers
    const numNative = values.filter((v) => typeof v === "number").length;
    if (numNative >= values.length * 0.8)
      return { name, type: "numérico", index };

    // Native booleans
    const boolNative = values.filter((v) => typeof v === "boolean").length;
    if (boolNative >= values.length * 0.8)
      return { name, type: "categórico", index };

    // String-based numeric
    const numStr = values.filter((v) => {
      const s = String(v).replace(",", ".").trim();
      return !isNaN(Number(s)) && s !== "";
    }).length;
    if (numStr >= values.length * 0.8) return { name, type: "numérico", index };

    // Dates
    const datePatterns = [
      /^\d{4}-\d{2}-\d{2}/,
      /^\d{2}\/\d{2}\/\d{4}/,
      /^\d{2}-\d{2}-\d{4}/,
    ];
    const dateCount = values.filter((v) =>
      datePatterns.some((p) => p.test(String(v))),
    ).length;
    if (dateCount >= values.length * 0.8) return { name, type: "data", index };

    // Categorical
    const unique = new Set(values.map((v) => String(v)));
    if (unique.size <= Math.min(20, values.length * 0.1))
      return { name, type: "categórico", index };

    return { name, type: "texto", index };
  });
}

// ── Main handler ─────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const fileName = (formData.get("file_name") as string) || file?.name || "";
    const originalSize = parseInt(
      (formData.get("original_size") as string) || "0",
    );
    const explicitDelimiter = formData.get("delimiter") as string | null;

    if (!file) {
      return new Response(
        JSON.stringify({ success: false, message: "file is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log(
      `[import-preview] Previewing: ${fileName}, slice: ${(file.size / 1024).toFixed(1)} KB, original: ${(originalSize / 1024 / 1024).toFixed(2)} MB`,
    );

    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    let result: PreviewResult;

    if (["parquet", "parq", "pq"].includes(ext)) {
      const buffer = await file.arrayBuffer();
      result = await previewParquet(buffer);
    } else if (ext === "json") {
      const text = await file.text();
      result = previewJSON(text, originalSize || file.size);
    } else {
      // CSV and anything else text-based
      const text = await file.text();
      result = previewCSV(
        text,
        originalSize || file.size,
        explicitDelimiter || undefined,
      );
    }

    console.log(
      `[import-preview] Preview ready: ${result.columns.length} cols, ${result.previewRows.length} preview rows, ~${result.totalRowsEstimate} total estimate`,
    );

    return new Response(
      JSON.stringify({ success: true, ...result }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Erro ao gerar preview";
    console.error("[import-preview] Error:", error);
    return new Response(JSON.stringify({ success: false, message: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
