import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  Info,
  AlertCircle,
  Loader2,
  FileJson,
  Table,
  History,
  Sparkles,
  AlertTriangle,
  Play,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../wizard/WizardContainer";
import DataPreviewSection from "./DataPreviewSection";
import DatasetSelector from "./DatasetSelector";
import { ImportJobsModal } from "@/components/import";
import { trackEventWithTiming } from "@/lib/platformTracking";
import { logProjectAuditEvent } from "@/lib/auditLog";
import { useImportPreview } from "@/hooks/useImportPreview";
import { useAsyncImport } from "@/hooks/useAsyncImport";
import { detectCSVDelimiter } from "@/lib/csvDelimiterDetector";

interface FileUploadSectionProps {
  projectData: ProjectData;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onDataReady: () => void;
}

interface ColumnInfo {
  name: string;
  inferredType: string;
  index: number;
}

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB for direct upload
const MAX_LARGE_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB for async import
const SAMPLE_SIZE = 100000;

const SUPPORTED_FORMATS = [
  { ext: ".csv", icon: FileSpreadsheet, label: "CSV" },
  { ext: ".parquet", icon: Table, label: "Parquet" },
  { ext: ".xlsx", icon: FileSpreadsheet, label: "Excel" },
  { ext: ".json", icon: FileJson, label: "JSON" },
];

const PARQUET_EXTENSIONS = [".parquet", ".parq", ".pq"];
const EXCEL_EXTENSIONS = [".xlsx", ".xls"];

const getFileExtension = (filename: string): string => {
  return filename.slice(filename.lastIndexOf(".")).toLowerCase();
};

const isValidFormat = (filename: string): boolean => {
  const ext = getFileExtension(filename);
  return SUPPORTED_FORMATS.some((f) => f.ext === ext) || PARQUET_EXTENSIONS.includes(ext);
};

const isCSVFile = (filename: string): boolean => {
  return getFileExtension(filename) === ".csv";
};

const isBinaryFormat = (filename: string): boolean => {
  const ext = getFileExtension(filename);
  return PARQUET_EXTENSIONS.includes(ext) || EXCEL_EXTENSIONS.includes(ext);
};

const formatSpeed = (bytesPerSecond: number) => {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  }
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
};

const formatETA = (seconds: number) => {
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  return `~${hours}h ${mins}min`;
};

const FileUploadSection = ({ projectData, saveProject, onDataReady }: FileUploadSectionProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();

  // File selection
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Sync upload state (small files)
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "processing" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  // Full data from sync upload
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [previewData, setPreviewData] = useState<string[][]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [isSampled, setIsSampled] = useState(false);

  // Async import state
  const [isAsyncRequired, setIsAsyncRequired] = useState(false);
  const [asyncDatasetName, setAsyncDatasetName] = useState("");

  // CSV-specific controls
  const [csvDelimiter, setCsvDelimiter] = useState(",");
  const [csvEncoding, setCsvEncoding] = useState("UTF-8");
  const [isDetectingDelimiter, setIsDetectingDelimiter] = useState(false);
  const [delimiterAutoDetected, setDelimiterAutoDetected] = useState(false);

  // Import jobs modal
  const [showImportJobsModal, setShowImportJobsModal] = useState(false);

  // ─── Hooks ──────────────────────────────────────────────────
  const fileIsCSV = selectedFile ? isCSVFile(selectedFile.name) : false;

  const {
    preview: immediatePreview,
    loading: previewLoading,
    error: previewError,
  } = useImportPreview({
    file: selectedFile,
    delimiter: fileIsCSV ? csvDelimiter : undefined,
    enabled: !!selectedFile && uploadStatus !== "success",
  });

  const handleAsyncCompleted = useCallback(async () => {
    if (projectData.id) {
      const { data: updatedProject } = await supabase
        .from("projects")
        .select("dataset_filename, dataset_rows, dataset_columns, total_rows, sample_rows, status")
        .eq("id", projectData.id)
        .single();

      if (updatedProject) {
        if (updatedProject.dataset_columns) {
          const { data: columnsData } = await supabase
            .from("project_columns")
            .select("*")
            .eq("project_id", projectData.id)
            .order("column_index");

          if (columnsData && columnsData.length > 0) {
            setColumns(columnsData.map((c) => ({
              name: c.column_name,
              inferredType: c.inferred_type,
              index: c.column_index,
            })));
          }
        }

        setRowCount(updatedProject.dataset_rows || updatedProject.sample_rows || 0);
        setTotalRows(updatedProject.total_rows || 0);
        setIsSampled((updatedProject.total_rows || 0) > (updatedProject.sample_rows || 0));
        setUploadStatus("success");
      }
    }

    onDataReady();
    toast({
      title: t("dataIngestion.import.statusCompleted"),
      description: t("dataIngestion.file.uploadSuccess"),
    });
  }, [projectData.id, onDataReady, toast, t]);

  const asyncImport = useAsyncImport({
    projectId: projectData.id,
    onCompleted: handleAsyncCompleted,
  });

  // ─── Load existing data ──────────────────────────────────────
  useEffect(() => {
    if (projectData.dataset_filename) {
      setUploadStatus("success");
      loadExistingData();
    }
  }, [projectData.dataset_filename]);

  const loadExistingData = async () => {
    if (!projectData.id) return;

    const { data: columnsData } = await supabase
      .from("project_columns")
      .select("*")
      .eq("project_id", projectData.id)
      .order("column_index");

    if (columnsData && columnsData.length > 0) {
      setColumns(columnsData.map((c) => ({
        name: c.column_name,
        inferredType: c.inferred_type,
        index: c.column_index,
      })));
    }

    if (projectData.dataset_rows) {
      setRowCount(projectData.dataset_rows);
    }

    // Load total rows from project_datasets
    const { data: datasets } = await supabase
      .from("project_datasets")
      .select("total_rows")
      .eq("project_id", projectData.id)
      .eq("is_active", true)
      .limit(1);

    if (datasets && datasets.length > 0 && datasets[0].total_rows) {
      setTotalRows(datasets[0].total_rows);
      setIsSampled(datasets[0].total_rows > (projectData.dataset_rows || 0));
    }
  };

  // ─── Auto-detect delimiter for CSV ──────────────────────────
  useEffect(() => {
    if (selectedFile && isCSVFile(selectedFile.name) && isAsyncRequired) {
      setIsDetectingDelimiter(true);
      setDelimiterAutoDetected(false);

      detectCSVDelimiter(selectedFile)
        .then((result) => {
          setCsvDelimiter(result.delimiter);
          setDelimiterAutoDetected(true);
        })
        .catch((err) => {
          console.warn("[FileUploadSection] Delimiter detection failed:", err);
        })
        .finally(() => {
          setIsDetectingDelimiter(false);
        });
    }
  }, [selectedFile, isAsyncRequired]);

  // ─── File handlers ──────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) validateAndProcessFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) validateAndProcessFile(file);
  };

  const validateAndProcessFile = (file: File) => {
    setErrorMessage("");
    setUploadStatus("idle");
    setIsAsyncRequired(false);
    asyncImport.reset();

    if (!isValidFormat(file.name)) {
      setErrorMessage(t("dataIngestion.file.errors.invalidFormat"));
      setUploadStatus("error");
      return;
    }

    if (file.size > MAX_LARGE_FILE_SIZE) {
      setErrorMessage(
        t("dataIngestion.import.fileTooLargeMax", {
          maxSize: (MAX_LARGE_FILE_SIZE / 1024 / 1024 / 1024).toFixed(0),
        })
      );
      setUploadStatus("error");
      return;
    }

    // Set file — this triggers useImportPreview for immediate preview
    setSelectedFile(file);
    setAsyncDatasetName(file.name.replace(/\.(parquet|parq|pq|csv|xlsx|xls|json)$/i, ""));

    // Route: sync (small, non-binary or small binary) vs async (large)
    if (file.size > MAX_FILE_SIZE) {
      // Large file → async import (user must click "Start Import")
      setIsAsyncRequired(true);
    } else {
      // Small file → sync upload via parse-file
      setIsAsyncRequired(false);
      parseAndUploadFile(file);
    }
  };

  const parseAndUploadFile = async (file: File) => {
    if (!projectData.id) {
      setErrorMessage(t("dataIngestion.file.errors.projectNotFound"));
      setUploadStatus("error");
      return;
    }

    setUploadStatus("processing");
    const startTime = Date.now();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setErrorMessage(t("dataIngestion.file.errors.notAuthenticated"));
        setUploadStatus("error");
        return;
      }

      const filePath = `${user.id}/${projectData.id}/${file.name}`;

      setUploadStatus("uploading");

      const { error: uploadError } = await supabase.storage
        .from("datasets")
        .upload(filePath, file, { upsert: true });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        setErrorMessage(t("dataIngestion.file.errors.uploadFailed"));
        setUploadStatus("error");
        return;
      }

      // Call parse-file edge function
      setUploadStatus("processing");

      const formData = new FormData();
      formData.append("file", file);
      formData.append("project_id", projectData.id);
      formData.append("max_sample_rows", String(SAMPLE_SIZE));

      const { data, error } = await supabase.functions.invoke("parse-file", {
        body: formData,
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.message || "Failed to parse file");

      // Update local state with full results
      const columnInfos: ColumnInfo[] = data.columns.map((col: any) => ({
        name: col.name,
        inferredType: col.type,
        index: col.index,
      }));

      setColumns(columnInfos);
      setRowCount(data.sampleRows);
      setTotalRows(data.totalRows);
      setIsSampled(data.totalRows > data.sampleRows);

      if (data.preview && data.preview.length > 0) {
        const headers = columnInfos.map((c) => c.name);
        const previewRows = data.preview.map((row: Record<string, unknown>) =>
          headers.map((h) => (row[h] !== null && row[h] !== undefined ? String(row[h]) : ""))
        );
        setPreviewData([headers, ...previewRows]);
      }

      // Log ingestion
      await supabase.from("project_data_ingestion_logs").insert({
        project_id: projectData.id,
        status: "success",
        rows_read: data.totalRows,
        rows_sampled: data.sampleRows,
        completed_at: new Date().toISOString(),
        metadata: { file_type: file.name.split(".").pop(), file_name: file.name },
      });

      await saveProject({
        dataset_filename: filePath,
        dataset_rows: data.sampleRows,
        dataset_columns: columnInfos.length,
        total_rows: data.totalRows,
        sample_rows: data.sampleRows,
        status: "data_uploaded",
      });

      setUploadStatus("success");
      toast({
        title: t("dataIngestion.file.uploadSuccess"),
        description:
          data.totalRows > data.sampleRows
            ? t("dataIngestion.file.uploadSuccessSampled", {
                filename: file.name,
                sampled: data.sampleRows,
                total: data.totalRows,
              })
            : t("dataIngestion.file.uploadSuccessDesc", {
                filename: file.name,
                rows: data.totalRows,
                columns: columnInfos.length,
              }),
      });

      trackEventWithTiming(
        {
          event_type: "dataset_uploaded",
          project_id: projectData.id,
          status: "success",
          metadata: { file_type: file.name.split(".").pop(), rows: data.totalRows, columns: columnInfos.length },
          source: "app",
        },
        startTime
      );

      logProjectAuditEvent(
        projectData.id,
        "dataset_uploaded",
        "dataset",
        file.name,
        { rows: data.totalRows, columns: columnInfos.length, file_type: file.name.split(".").pop() }
      );

      onDataReady();
    } catch (error: any) {
      console.error("Processing error:", error);
      setErrorMessage(error.message || t("dataIngestion.file.errors.processingFailed"));
      setUploadStatus("error");

      trackEventWithTiming(
        {
          event_type: "job_error",
          project_id: projectData.id,
          status: "error",
          metadata: { stage: "dataset_upload", error_message: error.message },
          source: "app",
        },
        Date.now()
      );
    }
  };

  const handleStartAsyncImport = () => {
    if (!selectedFile) return;
    asyncImport.startImport(selectedFile, {
      delimiter: csvDelimiter,
      encoding: csvEncoding,
      datasetName: asyncDatasetName,
    });
  };

  const resetUpload = () => {
    setSelectedFile(null);
    setUploadStatus("idle");
    setErrorMessage("");
    setPreviewData([]);
    setColumns([]);
    setRowCount(0);
    setTotalRows(0);
    setIsSampled(false);
    setIsAsyncRequired(false);
    setAsyncDatasetName("");
    setCsvDelimiter(",");
    setCsvEncoding("UTF-8");
    setDelimiterAutoDetected(false);
    asyncImport.reset();
  };

  const handleImportStarted = () => {
    toast({
      title: t("dataIngestion.import.importStarted"),
      description: t("dataIngestion.import.importStartedDesc"),
    });
    setShowImportJobsModal(true);
  };

  const handleJobCompleted = async () => {
    await handleAsyncCompleted();
  };

  // ─── Derived display state ──────────────────────────────────
  const hasFullData = uploadStatus === "success" && columns.length > 0;
  const hasImmediatePreview = !!immediatePreview;
  const showPreview = hasFullData || hasImmediatePreview;
  const isUploading = uploadStatus === "uploading" || uploadStatus === "processing";
  const isAsyncUploading = asyncImport.isUploading;

  // Prefer full data, fall back to immediate preview
  const displayColumns = hasFullData
    ? columns.map((c) => ({ name: c.name, type: c.inferredType, index: c.index }))
    : immediatePreview?.columns || [];

  const displayRows = hasFullData
    ? previewData.length > 1
      ? previewData.slice(1).map((row) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((col, i) => {
            obj[col.name] = row[i] || null;
          });
          return obj;
        })
      : []
    : immediatePreview?.previewRows || [];

  const displayTotalRows = hasFullData ? totalRows : immediatePreview?.totalRowsEstimate || 0;
  const displaySampleRows = hasFullData ? rowCount : immediatePreview?.previewRows.length || 0;
  const displayIsSampled = hasFullData
    ? isSampled
    : immediatePreview
      ? immediatePreview.totalRowsEstimate > immediatePreview.previewRows.length
      : false;

  // File info for display
  const displayFileName = selectedFile?.name || projectData.dataset_filename?.split("/").pop() || "";
  const displayFileSize = selectedFile
    ? selectedFile.size >= 1024 * 1024 * 1024
      ? `${(selectedFile.size / 1024 / 1024 / 1024).toFixed(2)} GB`
      : `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB`
    : "";

  // Header status
  const headerStatus = hasFullData || asyncImport.uploadPhase === "done"
    ? "success"
    : isUploading || isAsyncUploading
      ? "processing"
      : selectedFile
        ? "selected"
        : "idle";

  return (
    <div className="space-y-6">
      {/* Info box */}
      <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-primary mb-2">{t("dataIngestion.file.supportedFormats")}</p>
          <div className="flex flex-wrap gap-2 mb-3">
            {SUPPORTED_FORMATS.map((format) => (
              <span
                key={format.ext}
                className="inline-flex items-center gap-1 px-2 py-1 bg-background rounded border border-border text-xs font-medium"
              >
                <format.icon className="w-3 h-3" />
                {format.label}
              </span>
            ))}
          </div>
          <ul className="text-muted-foreground space-y-1">
            <li>• {t("dataIngestion.file.reqMaxSize", { size: (MAX_LARGE_FILE_SIZE / 1024 / 1024 / 1024).toFixed(0) })}</li>
            <li>• {t("dataIngestion.file.reqEncoding")}</li>
            <li>• {t("dataIngestion.file.reqHeader")}</li>
            <li>• {t("dataIngestion.file.samplingNote", { sampleSize: SAMPLE_SIZE.toLocaleString() })}</li>
          </ul>
        </div>
      </div>

      {/* View Imports Button */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setShowImportJobsModal(true)}>
          <History className="w-4 h-4 mr-2" />
          {t("dataIngestion.import.viewImports")}
        </Button>
      </div>

      {/* Error messages */}
      {errorMessage && (
        <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
          <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="text-sm text-destructive">{errorMessage}</div>
        </div>
      )}

      {asyncImport.errorMessage && (
        <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
          <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="text-sm text-destructive">{asyncImport.errorMessage}</div>
        </div>
      )}

      {/* Upload area */}
      <div
        className={`relative border-2 border-dashed rounded-xl p-12 text-center transition-all ${
          isDragging
            ? "border-primary bg-primary/5"
            : headerStatus === "success"
              ? "border-accent bg-accent/5"
              : uploadStatus === "error"
                ? "border-destructive bg-destructive/5"
                : headerStatus === "selected" || headerStatus === "processing"
                  ? "border-primary/50 bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/50"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {headerStatus === "idle" && !isUploading && !isAsyncUploading && (
          <input
            type="file"
            accept=".csv,.parquet,.parq,.pq,.xlsx,.json"
            onChange={handleFileSelect}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        )}

        {/* Idle state */}
        {headerStatus === "idle" && !isUploading && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto">
              <Upload className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-semibold text-lg">{t("dataIngestion.file.dragDrop")}</p>
              <p className="text-muted-foreground">{t("dataIngestion.file.orClick")}</p>
            </div>
          </div>
        )}

        {/* Processing state (sync upload) */}
        {isUploading && !isAsyncRequired && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-primary/20 rounded-2xl flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <div>
              <p className="font-semibold text-lg">
                {uploadStatus === "processing"
                  ? t("dataIngestion.file.processing")
                  : t("dataIngestion.file.uploading")}
              </p>
              <p className="text-sm text-muted-foreground">
                {uploadStatus === "processing"
                  ? t("dataIngestion.file.processingDesc")
                  : t("dataIngestion.file.uploadingDesc")}
              </p>
            </div>
          </div>
        )}

        {/* File selected / Success state */}
        {(headerStatus === "success" || headerStatus === "selected") && !isUploading && (
          <div className="space-y-4">
            <div
              className={`w-16 h-16 ${
                headerStatus === "success" ? "bg-accent/20" : "bg-primary/20"
              } rounded-2xl flex items-center justify-center mx-auto`}
            >
              {headerStatus === "success" ? (
                <CheckCircle className="w-8 h-8 text-accent" />
              ) : previewLoading ? (
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              ) : (
                <CheckCircle className="w-8 h-8 text-primary" />
              )}
            </div>
            <div>
              <p className="font-semibold text-lg">
                {headerStatus === "success"
                  ? t("dataIngestion.file.uploadComplete")
                  : t("dataIngestion.file.fileSelected", {
                      defaultValue: "Arquivo selecionado!",
                    })}
              </p>
              <p className="text-sm text-muted-foreground">
                {displayFileName}
                {displayFileSize && ` • ${displayFileSize}`}
                {displayColumns.length > 0 && (
                  <>
                    {" • "}
                    {displayTotalRows.toLocaleString()} {t("dataIngestion.file.rows")}
                    {displayIsSampled &&
                      ` (${t("dataIngestion.file.sampledFrom", {
                        total: displayTotalRows.toLocaleString(),
                      })})`}
                    {" • "}
                    {displayColumns.length} {t("dataIngestion.file.columns")}
                  </>
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                resetUpload();
              }}
            >
              {t("dataIngestion.file.changeFile")}
            </Button>
          </div>
        )}

        {/* Async upload in progress (inside the drop zone) */}
        {isAsyncUploading && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-primary/20 rounded-2xl flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <div>
              <p className="font-semibold text-lg">
                {asyncImport.uploadPhase === "uploading"
                  ? t("dataIngestion.import.uploading", { defaultValue: "Enviando arquivo..." })
                  : asyncImport.uploadPhase === "processing"
                    ? t("dataIngestion.import.processing", { defaultValue: "Processando..." })
                    : t("dataIngestion.import.done", { defaultValue: "Concluído!" })}
              </p>
              <p className="text-sm text-muted-foreground">{displayFileName}</p>
            </div>
          </div>
        )}
      </div>

      {/* Async upload progress bar (outside drop zone) */}
      {isAsyncUploading && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>
              {asyncImport.uploadPhase === "uploading" &&
                t("dataIngestion.import.uploading", { defaultValue: "Enviando arquivo..." })}
              {asyncImport.uploadPhase === "processing" &&
                t("dataIngestion.import.processing", { defaultValue: "Processando..." })}
              {asyncImport.uploadPhase === "done" &&
                t("dataIngestion.import.done", { defaultValue: "Concluído!" })}
            </span>
            <span>{asyncImport.uploadProgress}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-300"
              style={{ width: `${asyncImport.uploadProgress}%` }}
            />
          </div>
          {asyncImport.uploadStats && asyncImport.uploadPhase === "uploading" && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{formatSpeed(asyncImport.uploadStats.speed)}</span>
              <span>{formatETA(asyncImport.uploadStats.eta)}</span>
            </div>
          )}
          {asyncImport.uploadPhase === "processing" && asyncImport.serverProgress > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("dataIngestion.batchImport.serverProgress", {
                progress: asyncImport.serverProgress,
                defaultValue: `Processamento: ${asyncImport.serverProgress}%`,
              })}
            </p>
          )}
        </div>
      )}

      {/* Async import controls (dataset name, delimiter, start button) */}
      {isAsyncRequired && !isAsyncUploading && asyncImport.uploadPhase !== "done" && headerStatus !== "success" && (
        <Card className="p-4 space-y-4">
          {/* Dataset name */}
          <div className="space-y-2">
            <Label htmlFor="datasetName">
              {t("dataIngestion.import.datasetName", { defaultValue: "Nome do dataset" })}
            </Label>
            <Input
              id="datasetName"
              value={asyncDatasetName}
              onChange={(e) => setAsyncDatasetName(e.target.value)}
              placeholder={t("dataIngestion.import.datasetNamePlaceholder", {
                defaultValue: "Nome descritivo para o dataset",
              })}
            />
          </div>

          {/* CSV-only: delimiter & encoding */}
          {fileIsCSV && (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>{t("dataIngestion.import.delimiter", { defaultValue: "Delimitador" })}</Label>
                  {isDetectingDelimiter && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t("dataIngestion.import.detectingDelimiter", { defaultValue: "Detectando..." })}
                    </span>
                  )}
                  {delimiterAutoDetected && !isDetectingDelimiter && (
                    <span className="text-xs text-primary flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      {t("dataIngestion.import.delimiterAutoDetected", {
                        defaultValue: "Auto-detectado",
                      })}
                    </span>
                  )}
                </div>
                <Select
                  value={csvDelimiter}
                  onValueChange={(val) => {
                    setCsvDelimiter(val);
                    setDelimiterAutoDetected(false);
                  }}
                  disabled={isDetectingDelimiter}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value=",">{t("dataIngestion.import.delimiterComma", { defaultValue: "Vírgula (,)" })}</SelectItem>
                    <SelectItem value=";">{t("dataIngestion.import.delimiterSemicolon", { defaultValue: "Ponto e vírgula (;)" })}</SelectItem>
                    <SelectItem value={"\t"}>{t("dataIngestion.import.delimiterTab", { defaultValue: "Tab (\\t)" })}</SelectItem>
                    <SelectItem value="|">{t("dataIngestion.import.delimiterPipe", { defaultValue: "Pipe (|)" })}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t("dataIngestion.import.encoding", { defaultValue: "Encoding" })}</Label>
                <Select value={csvEncoding} onValueChange={setCsvEncoding}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UTF-8">UTF-8</SelectItem>
                    <SelectItem value="ISO-8859-1">ISO-8859-1 (Latin-1)</SelectItem>
                    <SelectItem value="Windows-1252">Windows-1252</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Non-CSV info banner */}
          {!fileIsCSV && (
            <div className="flex items-start gap-3 p-3 bg-primary/10 border border-primary/20 rounded-lg">
              <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div className="text-sm text-muted-foreground">
                {t("dataIngestion.import.binaryFormatInfo", {
                  defaultValue:
                    "Schema e tipos serão extraídos automaticamente. Delimitador e encoding não se aplicam a este formato.",
                })}
              </div>
            </div>
          )}

          {/* Start import button */}
          <Button
            onClick={handleStartAsyncImport}
            disabled={!asyncDatasetName.trim()}
            className="w-full bg-gradient-primary hover:shadow-hover transition-all"
          >
            <Play className="w-4 h-4 mr-2" />
            {t("dataIngestion.import.startImport", { defaultValue: "Iniciar importação" })}
          </Button>
        </Card>
      )}

      {/* Preview section */}
      {!isUploading && !isAsyncUploading && showPreview && displayColumns.length > 0 && (
        <div className="space-y-3">
          {/* Preview loading */}
          {previewLoading && !hasFullData && (
            <div className="flex items-center gap-3 p-4 bg-muted/30 rounded-lg border border-border">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">
                {t("dataIngestion.import.generatingPreview", {
                  defaultValue: "Gerando preview do dataset...",
                })}
              </span>
            </div>
          )}

          {/* Preview error */}
          {previewError && !hasFullData && (
            <Alert variant="destructive" className="border-destructive/30 bg-destructive/5">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">{previewError}</AlertDescription>
            </Alert>
          )}

          {/* Sampling warning for async / preview-only */}
          {!hasFullData && hasImmediatePreview && (
            <Alert variant="default" className="border-primary/30 bg-primary/5">
              <Info className="h-4 w-4 text-primary" />
              <AlertDescription className="text-sm">
                {t("dataIngestion.import.previewSamplingWarning", {
                  defaultValue:
                    "Preview por amostragem. O processamento completo roda em background e pode alterar contagens finais.",
                })}
              </AlertDescription>
            </Alert>
          )}

          {/* Warnings from preview engine */}
          {!hasFullData && immediatePreview?.warnings && immediatePreview.warnings.length > 0 && (
            <div className="space-y-1">
              {immediatePreview.warnings.map((w, i) => (
                <p key={i} className="text-xs text-muted-foreground italic">
                  {w}
                </p>
              ))}
            </div>
          )}

          {/* The unified DataPreviewSection */}
          <DataPreviewSection
            columns={displayColumns}
            previewRows={displayRows}
            totalRows={displayTotalRows}
            sampleRows={displaySampleRows}
            isSampled={displayIsSampled}
          />
        </div>
      )}

      {/* Preview loading when no data yet */}
      {previewLoading && !showPreview && selectedFile && (
        <div className="flex items-center gap-3 p-4 bg-muted/30 rounded-lg border border-border">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">
            {t("dataIngestion.import.generatingPreview", {
              defaultValue: "Gerando preview do dataset...",
            })}
          </span>
        </div>
      )}

      {/* Import Jobs Modal */}
      {projectData.id && (
        <ImportJobsModal
          open={showImportJobsModal}
          onOpenChange={setShowImportJobsModal}
          projectId={projectData.id}
          onJobCompleted={handleJobCompleted}
        />
      )}

      {/* Dataset History Selector */}
      {projectData.id && (
        <DatasetSelector projectId={projectData.id} onDatasetChange={onDataReady} />
      )}
    </div>
  );
};

export default FileUploadSection;
