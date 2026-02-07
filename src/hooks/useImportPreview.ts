import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

interface PreviewColumn {
  name: string;
  type: string;
  index: number;
}

interface PreviewData {
  columns: PreviewColumn[];
  previewRows: Record<string, unknown>[];
  totalRowsEstimate: number;
  warnings: string[];
}

interface UseImportPreviewOptions {
  file: File | null;
  delimiter?: string;
  enabled?: boolean;
}

const CSV_SLICE_BYTES = 2 * 1024 * 1024; // 2 MB for CSV/JSON
const BINARY_MAX_BYTES = 100 * 1024 * 1024; // 100 MB for binary formats (Parquet, Excel)
const PARQUET_EXTENSIONS = ["parquet", "parq", "pq"];
const EXCEL_EXTENSIONS = ["xlsx", "xls"];

export function useImportPreview({
  file,
  delimiter,
  enabled = true,
}: UseImportPreviewOptions) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file || !enabled) {
      setPreview(null);
      setError(null);
      return;
    }

    // Avoid re-fetching for the same file
    const fileKey = `${file.name}_${file.size}_${file.lastModified}_${delimiter || ""}`;
    if (lastFileRef.current === fileKey && preview) return;
    lastFileRef.current = fileKey;

    // Cancel previous request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const fetchPreview = async () => {
      setLoading(true);
      setError(null);
      setPreview(null);

      try {
        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        const isParquet = PARQUET_EXTENSIONS.includes(ext);
        const isExcel = EXCEL_EXTENSIONS.includes(ext);
        const isBinaryFormat = isParquet || isExcel;

        let fileSlice: Blob;

        if (isBinaryFormat) {
          if (file.size > BINARY_MAX_BYTES) {
            setError(
              `Preview indisponível para arquivos > ${(BINARY_MAX_BYTES / 1024 / 1024).toFixed(0)} MB. O processamento completo continuará normalmente.`,
            );
            setLoading(false);
            return;
          }
          // Send full file for binary formats (needs complete structure)
          fileSlice = file;
        } else {
          // Send first 2 MB slice for CSV/JSON
          fileSlice = file.slice(0, CSV_SLICE_BYTES);
        }

        const formData = new FormData();
        formData.append("file", fileSlice, file.name);
        formData.append("file_name", file.name);
        formData.append("original_size", String(file.size));
        if (delimiter) formData.append("delimiter", delimiter);

        const { data, error: fnError } = await supabase.functions.invoke(
          "import-preview",
          { body: formData },
        );

        if (controller.signal.aborted) return;

        if (fnError) throw fnError;
        if (!data?.success) throw new Error(data?.message || "Preview failed");

        setPreview({
          columns: data.columns,
          previewRows: data.previewRows,
          totalRowsEstimate: data.totalRowsEstimate,
          warnings: data.warnings || [],
        });
      } catch (err: any) {
        if (controller.signal.aborted) return;
        console.warn("[useImportPreview] Error:", err);
        setError(err.message || "Erro ao gerar preview");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchPreview();

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, delimiter, enabled]);

  return { preview, loading, error };
}
