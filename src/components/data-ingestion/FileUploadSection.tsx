import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  Plus,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../wizard/WizardContainer";
import DataPreviewSection from "./DataPreviewSection";
import DatasetSelector from "./DatasetSelector";
import { ImportJobsModal, BatchImportModal } from "@/components/import";
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

// ─── Constants ─────────────────────────────────────────────
const SYNC_THRESHOLD = 500 * 1024 * 1024; // 500 MB — internal fast-path, NOT a UX gate
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB per file
const SAMPLE_SIZE = 100000;

const SUPPORTED_FORMATS = [
  { ext: ".csv", icon: FileSpreadsheet, label: "CSV" },
  { ext: ".parquet", icon: Table, label: "Parquet" },
  { ext: ".xlsx", icon: FileSpreadsheet, label: "Excel" },
  { ext: ".json", icon: FileJson, label: "JSON" },
];

const PARQUET_EXTENSIONS = [".parquet", ".parq", ".pq"];
const EXCEL_EXTENSIONS = [".xlsx", ".xls"];
const ACCEPTED_EXTENSIONS = ".csv,.parquet,.parq,.pq,.xlsx,.xls,.json";

// ─── Utilities ─────────────────────────────────────────────
const getFileExtension = (filename: string): string =>
  filename.slice(filename.lastIndexOf(".")).toLowerCase();

const isValidFormat = (filename: string): boolean => {
  const ext = getFileExtension(filename);
  return (
    SUPPORTED_FORMATS.some((f) => f.ext === ext) ||
    PARQUET_EXTENSIONS.includes(ext) ||
    EXCEL_EXTENSIONS.includes(ext)
  );
};

const isCSVFile = (filename: string): boolean =>
  getFileExtension(filename) === ".csv";

const isBinaryFormat = (filename: string): boolean => {
  const ext = getFileExtension(filename);
  return PARQUET_EXTENSIONS.includes(ext) || EXCEL_EXTENSIONS.includes(ext);
};

const getFormatLabel = (filename: string): string => {
  const ext = getFileExtension(filename);
  if (PARQUET_EXTENSIONS.includes(ext)) return "Parquet";
  if (EXCEL_EXTENSIONS.includes(ext)) return "Excel";
  if (ext === ".json") return "JSON";
  return "CSV";
};

const getFormatIcon = (filename: string) => {
  const ext = getFileExtension(filename);
  if (PARQUET_EXTENSIONS.includes(ext))
    return <Table className="w-4 h-4 flex-shrink-0 text-muted-foreground" />;
  if (ext === ".json")
    return <FileJson className="w-4 h-4 flex-shrink-0 text-muted-foreground" />;
  return <FileSpreadsheet className="w-4 h-4 flex-shrink-0 text-muted-foreground" />;
};

const getFormatBadgeColor = (filename: string): string => {
  const ext = getFileExtension(filename);
  if (PARQUET_EXTENSIONS.includes(ext))
    return "bg-purple-500/10 text-purple-600 border-purple-500/30";
  if (EXCEL_EXTENSIONS.includes(ext))
    return "bg-green-500/10 text-green-600 border-green-500/30";
  if (ext === ".json")
    return "bg-amber-500/10 text-amber-600 border-amber-500/30";
  return "bg-blue-500/10 text-blue-600 border-blue-500/30";
};

const formatFileSize = (bytes: number) => {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
};

const formatTotalSize = (files: File[]) =>
  formatFileSize(files.reduce((sum, f) => sum + f.size, 0));

const formatSpeed = (bytesPerSecond: number) => {
  if (bytesPerSecond >= 1024 * 1024)
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
};

const formatETA = (seconds: number) => {
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  return `~${hours}h ${mins}min`;
};

// ═══════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════
const FileUploadSection = ({ projectData, saveProject, onDataReady }: FileUploadSectionProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();

  // ─── Multi-file selection ──────────────────────────────────
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // ─── Sync upload state (single small file) ────────────────
  const [uploadStatus, setUploadStatus] = useState<
    "idle" | "uploading" | "processing" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  // ─── Full data from sync upload ───────────────────────────
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [previewData, setPreviewData] = useState<string[][]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [isSampled, setIsSampled] = useState(false);

  // ─── Dataset config ───────────────────────────────────────
  const [datasetName, setDatasetName] = useState("");
  const [csvDelimiter, setCsvDelimiter] = useState(",");
  const [csvEncoding, setCsvEncoding] = useState("UTF-8");
  const [isDetectingDelimiter, setIsDetectingDelimiter] = useState(false);
  const [delimiterAutoDetected, setDelimiterAutoDetected] = useState(false);

  // ─── Modals ───────────────────────────────────────────────
  const [showImportJobsModal, setShowImportJobsModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);

  // ─── Computed ─────────────────────────────────────────────
  const firstFile = selectedFiles[0] || null;
  const hasCSVFile = selectedFiles.some((f) => isCSVFile(f.name));
  const hasBinaryOnly = selectedFiles.length > 0 && selectedFiles.every((f) => isBinaryFormat(f.name));
  const isMultiFile = selectedFiles.length > 1;
  const hasFiles = selectedFiles.length > 0;

  // ─── Preview (first file) ────────────────────────────────
  const {
    preview: immediatePreview,
    loading: previewLoading,
    error: previewError,
  } = useImportPreview({
    file: firstFile,
    delimiter: firstFile && isCSVFile(firstFile.name) ? csvDelimiter : undefined,
    enabled: !!firstFile && uploadStatus !== "success",
  });

  // ─── Async import (single large file) ────────────────────
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
            setColumns(
              columnsData.map((c) => ({
                name: c.column_name,
                inferredType: c.inferred_type,
                index: c.column_index,
              }))
            );
          }
        }

        setRowCount(updatedProject.dataset_rows || updatedProject.sample_rows || 0);
        setTotalRows(updatedProject.total_rows || 0);
        setIsSampled(
          (updatedProject.total_rows || 0) > (updatedProject.sample_rows || 0)
        );
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

  // ─── Load existing data ──────────────────────────────────
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
      setColumns(
        columnsData.map((c) => ({
          name: c.column_name,
          inferredType: c.inferred_type,
          index: c.column_index,
        }))
      );
    }

    if (projectData.dataset_rows) {
      setRowCount(projectData.dataset_rows);
    }

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

  // ─── Auto-detect delimiter for CSV ────────────────────────
  useEffect(() => {
    const firstCSV = selectedFiles.find((f) => isCSVFile(f.name));
    if (!firstCSV) return;

    setIsDetectingDelimiter(true);
    setDelimiterAutoDetected(false);

    detectCSVDelimiter(firstCSV)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFiles.length]);

  // ─── File handlers (multi-file) ──────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) validateAndAddFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) validateAndAddFiles(files);
    e.target.value = "";
  };

  const validateAndAddFiles = (files: File[]) => {
    setErrorMessage("");

    const validFiles: File[] = [];
    for (const file of files) {
      if (!isValidFormat(file.name)) {
        setErrorMessage(t("dataIngestion.file.errors.invalidFormat"));
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setErrorMessage(
          t("dataIngestion.import.fileTooLargeMax", {
            maxSize: (MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(0),
          })
        );
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length > 0) {
      setSelectedFiles((prev) => {
        const next = [...prev, ...validFiles];
        if (prev.length === 0) {
          setDatasetName(
            validFiles[0].name.replace(/\.(parquet|parq|pq|csv|xlsx|xls|json)$/i, "")
          );
        }
        return next;
      });
      if (uploadStatus === "error") setUploadStatus("idle");
    }
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) {
        resetUpload();
      } else if (index === 0) {
        setDatasetName(
          next[0].name.replace(/\.(parquet|parq|pq|csv|xlsx|xls|json)$/i, "")
        );
      }
      return next;
    });
  };

  // ─── Start import (routes to appropriate strategy) ───────
  const handleStartImport = () => {
    if (selectedFiles.length === 0) return;

    if (selectedFiles.length === 1) {
      const file = selectedFiles[0];
      if (file.size <= SYNC_THRESHOLD) {
        // Sync fast-path (internal optimization — UX is the same)
        parseAndUploadFile(file);
      } else {
        // Async single file
        asyncImport.startImport(file, {
          delimiter: csvDelimiter,
          encoding: csvEncoding,
          datasetName,
        });
      }
    } else {
      // Multiple files → batch modal with progress
      setShowBatchModal(true);
    }
  };

  // ─── Sync parse & upload (single small file) ─────────────
  const parseAndUploadFile = async (file: File) => {
    if (!projectData.id) {
      setErrorMessage(t("dataIngestion.file.errors.projectNotFound"));
      setUploadStatus("error");
      return;
    }

    setUploadStatus("processing");
    const startTime = Date.now();

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
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
          headers.map((h) =>
            row[h] !== null && row[h] !== undefined ? String(row[h]) : ""
          )
        );
        setPreviewData([headers, ...previewRows]);
      }

      await supabase.from("project_data_ingestion_logs").insert({
        project_id: projectData.id,
        status: "success",
        rows_read: data.totalRows,
        rows_sampled: data.sampleRows,
        completed_at: new Date().toISOString(),
        metadata: {
          file_type: file.name.split(".").pop(),
          file_name: file.name,
        },
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
          metadata: {
            file_type: file.name.split(".").pop(),
            rows: data.totalRows,
            columns: columnInfos.length,
          },
          source: "app",
        },
        startTime
      );

      logProjectAuditEvent(
        projectData.id,
        "dataset_uploaded",
        "dataset",
        file.name,
        {
          rows: data.totalRows,
          columns: columnInfos.length,
          file_type: file.name.split(".").pop(),
        }
      );

      onDataReady();
    } catch (error: any) {
      console.error("Processing error:", error);
      setErrorMessage(
        error.message || t("dataIngestion.file.errors.processingFailed")
      );
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

  // ─── Reset ────────────────────────────────────────────────
  const resetUpload = () => {
    setSelectedFiles([]);
    setUploadStatus("idle");
    setErrorMessage("");
    setPreviewData([]);
    setColumns([]);
    setRowCount(0);
    setTotalRows(0);
    setIsSampled(false);
    setDatasetName("");
    setCsvDelimiter(",");
    setCsvEncoding("UTF-8");
    setDelimiterAutoDetected(false);
    asyncImport.reset();
  };

  const handleBatchStarted = () => {
    setShowBatchModal(false);
    toast({
      title: t("dataIngestion.import.importStarted"),
      description: t("dataIngestion.import.importStartedDesc"),
    });
    setShowImportJobsModal(true);
  };

  const handleJobCompleted = async () => {
    await handleAsyncCompleted();
  };

  // ─── Derived display state ────────────────────────────────
  const hasFullData = uploadStatus === "success" && columns.length > 0;
  const hasImmediatePreview = !!immediatePreview;
  const showPreview = hasFullData || hasImmediatePreview;
  const isUploading =
    uploadStatus === "uploading" || uploadStatus === "processing";
  const isAsyncUploading = asyncImport.isUploading;
  const isProcessing = isUploading || isAsyncUploading;

  const displayColumns = hasFullData
    ? columns.map((c) => ({
        name: c.name,
        type: c.inferredType,
        index: c.index,
      }))
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

  const displayTotalRows = hasFullData
    ? totalRows
    : immediatePreview?.totalRowsEstimate || 0;
  const displaySampleRows = hasFullData
    ? rowCount
    : immediatePreview?.previewRows.length || 0;
  const displayIsSampled = hasFullData
    ? isSampled
    : immediatePreview
      ? immediatePreview.totalRowsEstimate > immediatePreview.previewRows.length
      : false;

  const headerStatus =
    hasFullData || asyncImport.uploadPhase === "done"
      ? "success"
      : isProcessing
        ? "processing"
        : hasFiles
          ? "selected"
          : "idle";

  // ═══════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════
  return (
    <div className="space-y-6">
      {/* ─── Info box ─────────────────────────────────────── */}
      <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-primary mb-2">
            {t("dataIngestion.file.supportedFormats")}
          </p>
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
            <li>
              •{" "}
              {t("dataIngestion.file.reqMaxSize", {
                size: (MAX_FILE_SIZE / 1024 / 1024 / 1024).toFixed(0),
              })}
            </li>
            <li>• {t("dataIngestion.file.reqEncoding")}</li>
            <li>• {t("dataIngestion.file.reqHeader")}</li>
            <li>
              •{" "}
              {t("dataIngestion.file.samplingNote", {
                sampleSize: SAMPLE_SIZE.toLocaleString(),
              })}
            </li>
          </ul>
        </div>
      </div>

      {/* ─── View Imports Button ──────────────────────────── */}
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowImportJobsModal(true)}
        >
          <History className="w-4 h-4 mr-2" />
          {t("dataIngestion.import.viewImports")}
        </Button>
      </div>

      {/* ─── Error messages ───────────────────────────────── */}
      {errorMessage && (
        <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
          <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="text-sm text-destructive">{errorMessage}</div>
        </div>
      )}

      {asyncImport.errorMessage && (
        <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
          <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="text-sm text-destructive">
            {asyncImport.errorMessage}
          </div>
        </div>
      )}

      {/* ─── Drop zone ────────────────────────────────────── */}
      <div
        className={`relative border-2 border-dashed rounded-xl p-12 text-center transition-all ${
          isDragging
            ? "border-primary bg-primary/5"
            : headerStatus === "success"
              ? "border-accent bg-accent/5"
              : uploadStatus === "error"
                ? "border-destructive bg-destructive/5"
                : headerStatus === "processing"
                  ? "border-primary/50 bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/50"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* File input — always multiple */}
        {!isProcessing && headerStatus !== "success" && (
          <input
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            multiple
            onChange={handleFileSelect}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        )}

        {/* Idle state */}
        {headerStatus === "idle" && !isProcessing && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto">
              <Upload className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-semibold text-lg">
                {t("dataIngestion.file.dragDrop")}
              </p>
              <p className="text-muted-foreground">
                {t("dataIngestion.file.orClick")}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                {t("dataIngestion.file.multipleFilesHint", {
                  defaultValue:
                    "Você pode selecionar um ou vários arquivos de uma vez",
                })}
              </p>
            </div>
          </div>
        )}

        {/* Files selected (before processing) */}
        {headerStatus === "selected" && !isProcessing && (
          <div className="space-y-2">
            <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center mx-auto">
              {previewLoading ? (
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
              ) : (
                <CheckCircle className="w-6 h-6 text-primary" />
              )}
            </div>
            <p className="font-semibold">
              {selectedFiles.length === 1
                ? t("dataIngestion.file.fileSelected", {
                    defaultValue: "Arquivo selecionado!",
                  })
                : t("dataIngestion.file.filesSelected", {
                    count: selectedFiles.length,
                    defaultValue: `${selectedFiles.length} arquivos selecionados`,
                  })}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatTotalSize(selectedFiles)}
              {displayColumns.length > 0 && (
                <>
                  {" • "}
                  {displayTotalRows.toLocaleString()}{" "}
                  {t("dataIngestion.file.rows")}
                  {" • "}
                  {displayColumns.length} {t("dataIngestion.file.columns")}
                </>
              )}
            </p>
          </div>
        )}

        {/* Processing state (sync) */}
        {isUploading && !isAsyncUploading && (
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

        {/* Async upload in progress */}
        {isAsyncUploading && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-primary/20 rounded-2xl flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <div>
              <p className="font-semibold text-lg">
                {asyncImport.uploadPhase === "uploading"
                  ? t("dataIngestion.import.uploading", {
                      defaultValue: "Enviando arquivo...",
                    })
                  : asyncImport.uploadPhase === "processing"
                    ? t("dataIngestion.import.processing", {
                        defaultValue: "Processando...",
                      })
                    : t("dataIngestion.import.done", {
                        defaultValue: "Concluído!",
                      })}
              </p>
              <p className="text-sm text-muted-foreground">
                {firstFile?.name}
              </p>
            </div>
          </div>
        )}

        {/* Success state */}
        {headerStatus === "success" && !isProcessing && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-accent/20 rounded-2xl flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8 text-accent" />
            </div>
            <div>
              <p className="font-semibold text-lg">
                {t("dataIngestion.file.uploadComplete")}
              </p>
              <p className="text-sm text-muted-foreground">
                {displayColumns.length > 0 && (
                  <>
                    {displayTotalRows.toLocaleString()}{" "}
                    {t("dataIngestion.file.rows")}
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
      </div>

      {/* ─── Async upload progress bar ────────────────────── */}
      {isAsyncUploading && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>
              {asyncImport.uploadPhase === "uploading" &&
                t("dataIngestion.import.uploading", {
                  defaultValue: "Enviando arquivo...",
                })}
              {asyncImport.uploadPhase === "processing" &&
                t("dataIngestion.import.processing", {
                  defaultValue: "Processando...",
                })}
              {asyncImport.uploadPhase === "done" &&
                t("dataIngestion.import.done", {
                  defaultValue: "Concluído!",
                })}
            </span>
            <span>{asyncImport.uploadProgress}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-300"
              style={{ width: `${asyncImport.uploadProgress}%` }}
            />
          </div>
          {asyncImport.uploadStats &&
            asyncImport.uploadPhase === "uploading" && (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatSpeed(asyncImport.uploadStats.speed)}</span>
                <span>{formatETA(asyncImport.uploadStats.eta)}</span>
              </div>
            )}
          {asyncImport.uploadPhase === "processing" &&
            asyncImport.serverProgress > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("dataIngestion.batchImport.serverProgress", {
                  progress: asyncImport.serverProgress,
                  defaultValue: `Processamento: ${asyncImport.serverProgress}%`,
                })}
              </p>
            )}
        </div>
      )}

      {/* ═══ FILE LIST ═══════════════════════════════════════ */}
      {hasFiles && uploadStatus !== "success" && !isProcessing && asyncImport.uploadPhase !== "done" && (
        <Card className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              {t("dataIngestion.file.selectedFiles", {
                defaultValue: "Arquivos selecionados",
              })}
              <Badge variant="outline">{selectedFiles.length}</Badge>
            </h3>
            <span className="text-sm text-muted-foreground">
              {formatTotalSize(selectedFiles)}
            </span>
          </div>

          {/* File items */}
          <div className="space-y-2">
            {selectedFiles.map((file, index) => (
              <div
                key={`${file.name}-${file.size}-${index}`}
                className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-border/50"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {getFormatIcon(file.name)}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-xs shrink-0 ${getFormatBadgeColor(file.name)}`}
                  >
                    {getFormatLabel(file.name)}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 ml-2 shrink-0"
                  onClick={() => handleRemoveFile(index)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>

          {/* Add more files */}
          <div className="relative">
            <input
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              multiple
              onChange={handleFileSelect}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <Button variant="outline" className="w-full" type="button">
              <Plus className="w-4 h-4 mr-2" />
              {t("dataIngestion.file.addMoreFiles", {
                defaultValue: "Adicionar mais arquivos",
              })}
            </Button>
          </div>

          {/* Multi-file info */}
          {isMultiFile && (
            <Alert variant="default" className="border-primary/30 bg-primary/5">
              <Info className="h-4 w-4 text-primary" />
              <AlertDescription className="text-sm">
                {t("dataIngestion.file.multiFileCombineInfo", {
                  defaultValue:
                    "Os arquivos serão combinados na etapa de ingestão.",
                })}
              </AlertDescription>
            </Alert>
          )}
        </Card>
      )}

      {/* ═══ IMPORT CONTROLS ═════════════════════════════════ */}
      {hasFiles && uploadStatus !== "success" && !isProcessing && asyncImport.uploadPhase !== "done" && (
        <Card className="p-4 space-y-4">
          {/* Dataset name */}
          <div className="space-y-2">
            <Label htmlFor="datasetName">
              {t("dataIngestion.import.datasetName", {
                defaultValue: "Nome do dataset",
              })}
            </Label>
            <Input
              id="datasetName"
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              placeholder={t("dataIngestion.import.datasetNamePlaceholder", {
                defaultValue: "Nome descritivo para o dataset",
              })}
            />
          </div>

          {/* CSV-only: delimiter & encoding */}
          {hasCSVFile && (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>
                    {t("dataIngestion.import.delimiter", {
                      defaultValue: "Delimitador",
                    })}
                  </Label>
                  {isDetectingDelimiter && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t("dataIngestion.import.detectingDelimiter", {
                        defaultValue: "Detectando...",
                      })}
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
                    <SelectItem value=",">
                      {t("dataIngestion.import.delimiterComma", {
                        defaultValue: "Vírgula (,)",
                      })}
                    </SelectItem>
                    <SelectItem value=";">
                      {t("dataIngestion.import.delimiterSemicolon", {
                        defaultValue: "Ponto e vírgula (;)",
                      })}
                    </SelectItem>
                    <SelectItem value={"\t"}>
                      {t("dataIngestion.import.delimiterTab", {
                        defaultValue: "Tab (\\t)",
                      })}
                    </SelectItem>
                    <SelectItem value="|">
                      {t("dataIngestion.import.delimiterPipe", {
                        defaultValue: "Pipe (|)",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>
                  {t("dataIngestion.import.encoding", {
                    defaultValue: "Encoding",
                  })}
                </Label>
                <Select value={csvEncoding} onValueChange={setCsvEncoding}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UTF-8">UTF-8</SelectItem>
                    <SelectItem value="ISO-8859-1">
                      ISO-8859-1 (Latin-1)
                    </SelectItem>
                    <SelectItem value="Windows-1252">Windows-1252</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Binary format info */}
          {hasBinaryOnly && (
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
            onClick={handleStartImport}
            disabled={!datasetName.trim()}
            className="w-full bg-gradient-primary hover:shadow-hover transition-all"
          >
            <Play className="w-4 h-4 mr-2" />
            {isMultiFile
              ? t("dataIngestion.file.startImportMultiple", {
                  count: selectedFiles.length,
                  defaultValue: `Iniciar importação (${selectedFiles.length} arquivos)`,
                })
              : t("dataIngestion.import.startImport", {
                  defaultValue: "Iniciar importação",
                })}
          </Button>
        </Card>
      )}

      {/* ═══ PREVIEW SECTION ═════════════════════════════════ */}
      {!isProcessing && showPreview && displayColumns.length > 0 && (
        <div className="space-y-3">
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

          {previewError && !hasFullData && (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/5"
            >
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                {previewError}
              </AlertDescription>
            </Alert>
          )}

          {!hasFullData && hasImmediatePreview && (
            <Alert
              variant="default"
              className="border-primary/30 bg-primary/5"
            >
              <Info className="h-4 w-4 text-primary" />
              <AlertDescription className="text-sm">
                {t("dataIngestion.import.previewSamplingWarning", {
                  defaultValue:
                    "Preview por amostragem. O processamento completo roda em background e pode alterar contagens finais.",
                })}
              </AlertDescription>
            </Alert>
          )}

          {!hasFullData &&
            immediatePreview?.warnings &&
            immediatePreview.warnings.length > 0 && (
              <div className="space-y-1">
                {immediatePreview.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-muted-foreground italic">
                    {w}
                  </p>
                ))}
              </div>
            )}

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
      {previewLoading && !showPreview && hasFiles && (
        <div className="flex items-center gap-3 p-4 bg-muted/30 rounded-lg border border-border">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">
            {t("dataIngestion.import.generatingPreview", {
              defaultValue: "Gerando preview do dataset...",
            })}
          </span>
        </div>
      )}

      {/* ═══ MODALS ══════════════════════════════════════════ */}
      {projectData.id && (
        <ImportJobsModal
          open={showImportJobsModal}
          onOpenChange={setShowImportJobsModal}
          projectId={projectData.id}
          onJobCompleted={handleJobCompleted}
        />
      )}

      {projectData.id && (
        <DatasetSelector
          projectId={projectData.id}
          onDatasetChange={onDataReady}
        />
      )}

      {/* Batch Import Modal (multiple files) */}
      {showBatchModal && projectData.id && (
        <BatchImportModal
          open={showBatchModal}
          onOpenChange={setShowBatchModal}
          initialFiles={selectedFiles}
          projectId={projectData.id}
          onImportStarted={handleBatchStarted}
        />
      )}
    </div>
  );
};

export default FileUploadSection;
