import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

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

function inferColumnType(values: unknown[]): string {
  const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
  if (nonNullValues.length === 0) return 'texto';

  let numericCount = 0;
  let dateCount = 0;
  let boolCount = 0;

  for (const value of nonNullValues.slice(0, 100)) {
    const strValue = String(value).trim();
    
    // Check for boolean
    if (['true', 'false', '0', '1', 'sim', 'não', 'yes', 'no'].includes(strValue.toLowerCase())) {
      boolCount++;
      continue;
    }
    
    // Check for number
    const num = Number(strValue.replace(',', '.'));
    if (!isNaN(num) && strValue !== '') {
      numericCount++;
      continue;
    }
    
    // Check for date
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
  
  // Convert to JSON with header row
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  
  if (jsonData.length === 0) {
    throw new Error("Empty Excel file");
  }
  
  // First row is headers
  const headers = (jsonData[0] as unknown[]).map((h, i) => String(h || `Column_${i + 1}`));
  const dataRows = jsonData.slice(1);
  const totalRows = dataRows.length;
  
  // Sample rows
  const sampleSize = Math.min(maxSampleRows, totalRows);
  const sampledRows = dataRows.slice(0, sampleSize);
  
  // Infer column types
  const columns = headers.map((name, index) => {
    const columnValues = sampledRows.map(row => (row as unknown[])[index]);
    return {
      name,
      type: inferColumnType(columnValues),
      index
    };
  });
  
  // Convert rows to objects
  const rows = sampledRows.map(row => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      obj[header] = (row as unknown[])[i] ?? null;
    });
    return obj;
  });
  
  console.log(`[parse-file] Excel parsed: ${columns.length} columns, ${totalRows} total rows, ${sampleSize} sampled`);
  
  return {
    columns,
    rows,
    totalRows,
    sampleRows: sampleSize
  };
}

function parseCSV(text: string, maxSampleRows: number): ParsedData {
  console.log("[parse-file] Parsing CSV file...");
  
  // Detect delimiter
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
  
  // Parse headers
  const headers = parseCSVLine(lines[0], delimiter);
  const dataLines = lines.slice(1);
  const totalRows = dataLines.length;
  
  // Sample rows
  const sampleSize = Math.min(maxSampleRows, totalRows);
  const sampledLines = dataLines.slice(0, sampleSize);
  
  // Parse sampled rows
  const parsedRows = sampledLines.map(line => parseCSVLine(line, delimiter));
  
  // Infer column types
  const columns = headers.map((name, index) => {
    const columnValues = parsedRows.map(row => row[index]);
    return {
      name: name || `Column_${index + 1}`,
      type: inferColumnType(columnValues),
      index
    };
  });
  
  // Convert to objects
  const rows = parsedRows.map(row => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      obj[header || `Column_${i + 1}`] = row[i] ?? null;
    });
    return obj;
  });
  
  console.log(`[parse-file] CSV parsed: ${columns.length} columns, ${totalRows} total rows, ${sampleSize} sampled`);
  
  return {
    columns,
    rows,
    totalRows,
    sampleRows: sampleSize
  };
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
  
  // Handle different JSON structures
  if (Array.isArray(data)) {
    records = data;
  } else if (data.data && Array.isArray(data.data)) {
    records = data.data;
  } else if (data.records && Array.isArray(data.records)) {
    records = data.records;
  } else if (data.results && Array.isArray(data.results)) {
    records = data.results;
  } else {
    // Single object, wrap in array
    records = [data];
  }
  
  if (records.length === 0) {
    throw new Error("No records found in JSON file");
  }
  
  const totalRows = records.length;
  const sampleSize = Math.min(maxSampleRows, totalRows);
  const sampledRecords = records.slice(0, sampleSize);
  
  // Extract all unique keys from sampled records
  const keysSet = new Set<string>();
  for (const record of sampledRecords) {
    if (typeof record === 'object' && record !== null) {
      Object.keys(record).forEach(key => keysSet.add(key));
    }
  }
  const headers = Array.from(keysSet);
  
  // Infer column types
  const columns = headers.map((name, index) => {
    const columnValues = sampledRecords.map(row => row[name]);
    return {
      name,
      type: inferColumnType(columnValues),
      index
    };
  });
  
  // Normalize rows to have all columns
  const rows = sampledRecords.map(record => {
    const obj: Record<string, unknown> = {};
    headers.forEach(header => {
      obj[header] = record[header] ?? null;
    });
    return obj;
  });
  
  console.log(`[parse-file] JSON parsed: ${columns.length} columns, ${totalRows} total rows, ${sampleSize} sampled`);
  
  return {
    columns,
    rows,
    totalRows,
    sampleRows: sampleSize
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const projectId = formData.get('project_id') as string;
    const maxSampleRows = parseInt(formData.get('max_sample_rows') as string || '100000');

    if (!file || !projectId) {
      throw new Error("File and project_id are required");
    }

    console.log(`[parse-file] Processing file: ${file.name}, size: ${file.size}, type: ${file.type}`);

    const fileName = file.name.toLowerCase();
    let parsedData: ParsedData;

    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      const buffer = await file.arrayBuffer();
      parsedData = parseExcel(buffer, maxSampleRows);
    } else if (fileName.endsWith('.csv')) {
      const text = await file.text();
      parsedData = parseCSV(text, maxSampleRows);
    } else if (fileName.endsWith('.json')) {
      const text = await file.text();
      parsedData = parseJSON(text, maxSampleRows);
    } else if (fileName.endsWith('.parquet')) {
      // Parquet parsing requires specialized handling
      // For now, return an error suggesting conversion
      throw new Error("Parquet files require conversion. Please convert to CSV or use a database connector for large datasets.");
    } else {
      throw new Error(`Unsupported file format: ${fileName}`);
    }

    // Store columns in project_columns
    console.log(`[parse-file] Storing ${parsedData.columns.length} columns for project ${projectId}`);
    
    // Delete existing columns
    await supabase
      .from('project_columns')
      .delete()
      .eq('project_id', projectId);

    // Insert new columns
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

    // Update project with row counts
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

    console.log(`[parse-file] File processing complete for project ${projectId}`);

    return new Response(
      JSON.stringify({
        success: true,
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
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        message: errorMessage
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500 
      }
    );
  }
});
