import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileSpreadsheet, CheckCircle, Info, AlertCircle, Loader2, FileJson, FileText, Table, History } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../wizard/WizardContainer";
import DataPreviewSection from "./DataPreviewSection";
import { BatchImportModal, ImportJobsModal } from "@/components/import";

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
const MAX_LARGE_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB for async import (all formats)
const SAMPLE_SIZE = 100000; // Max rows for EDA sampling

const SUPPORTED_FORMATS = [
  { ext: ".csv", icon: FileSpreadsheet, label: "CSV" },
  { ext: ".parquet", icon: Table, label: "Parquet" },
  { ext: ".xlsx", icon: FileSpreadsheet, label: "Excel" },
  { ext: ".json", icon: FileJson, label: "JSON" },
];

const inferColumnType = (values: string[]): string => {
  const nonEmpty = values.filter(v => v !== null && v !== undefined && String(v).trim() !== "");
  if (nonEmpty.length === 0) return "texto";
  
  const allNumbers = nonEmpty.every(v => !isNaN(Number(String(v).replace(",", "."))));
  if (allNumbers) return "numérico";
  
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}/,
    /^\d{2}\/\d{2}\/\d{4}/,
    /^\d{2}-\d{2}-\d{4}/,
  ];
  const allDates = nonEmpty.every(v => datePatterns.some(p => p.test(String(v))));
  if (allDates) return "data";
  
  const uniqueValues = new Set(nonEmpty);
  if (uniqueValues.size <= Math.min(10, nonEmpty.length * 0.3)) {
    return "categórico";
  }
  
  return "texto";
};

const FileUploadSection = ({ projectData, saveProject, onDataReady }: FileUploadSectionProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "processing" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [previewData, setPreviewData] = useState<string[][]>([]);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [isSampled, setIsSampled] = useState(false);
  
  // Large import modal states
  const [showLargeImportModal, setShowLargeImportModal] = useState(false);
  const [showImportJobsModal, setShowImportJobsModal] = useState(false);
  const [largeFiles, setLargeFiles] = useState<File[]>([]);

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
      setColumns(columnsData.map(c => ({
        name: c.column_name,
        inferredType: c.inferred_type,
        index: c.column_index
      })));
    }
    
    if (projectData.dataset_rows) {
      setRowCount(projectData.dataset_rows);
    }
  };

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
    validateAndProcessFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      validateAndProcessFile(file);
    }
  };

  const getFileExtension = (filename: string): string => {
    return filename.slice(filename.lastIndexOf('.')).toLowerCase();
  };

  const isValidFormat = (filename: string): boolean => {
    const ext = getFileExtension(filename);
    return SUPPORTED_FORMATS.some(f => f.ext === ext);
  };

  const validateAndProcessFile = (file: File) => {
    setErrorMessage("");
    setUploadStatus("idle");
    
    if (!isValidFormat(file.name)) {
      setErrorMessage(t("dataIngestion.file.errors.invalidFormat"));
      setUploadStatus("error");
      return;
    }
    
    // Check file size and route to appropriate flow
    if (file.size > MAX_LARGE_FILE_SIZE) {
      // File too large even for async import
      setErrorMessage(t("dataIngestion.import.fileTooLargeMax", { 
        maxSize: (MAX_LARGE_FILE_SIZE / 1024 / 1024 / 1024).toFixed(0)
      }));
      setUploadStatus("error");
      return;
    }
    
    if (file.size > MAX_FILE_SIZE) {
      // Large file - use async import flow
      // All supported formats can use large import
      setLargeFiles([file]);
      setShowLargeImportModal(true);
      return;
    }
    
    // Normal upload flow
    setSelectedFile(file);
    parseAndUploadFile(file);
  };

  const handleImportStarted = () => {
    toast({
      title: t("dataIngestion.import.importStarted"),
      description: t("dataIngestion.import.importStartedDesc"),
    });
    setShowImportJobsModal(true);
  };

  const handleJobCompleted = () => {
    // Refresh project data when import completes
    onDataReady();
    toast({
      title: t("dataIngestion.import.statusCompleted"),
      description: t("dataIngestion.file.uploadSuccess"),
    });
  };

  const parseAndUploadFile = async (file: File) => {
    if (!projectData.id) {
      setErrorMessage(t("dataIngestion.file.errors.projectNotFound"));
      setUploadStatus("error");
      return;
    }

    setUploadStatus("processing");

    try {
      // First, upload the file to storage
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
        .upload(filePath, file, {
          upsert: true
        });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        setErrorMessage(t("dataIngestion.file.errors.uploadFailed"));
        setUploadStatus("error");
        return;
      }

      // Now call the parse-file edge function
      setUploadStatus("processing");
      
      const formData = new FormData();
      formData.append("file", file);
      formData.append("project_id", projectData.id);
      formData.append("max_sample_rows", String(SAMPLE_SIZE));

      const { data, error } = await supabase.functions.invoke("parse-file", {
        body: formData
      });

      if (error) throw error;

      if (!data.success) {
        throw new Error(data.message || "Failed to parse file");
      }

      // Update local state with results
      const columnInfos: ColumnInfo[] = data.columns.map((col: any) => ({
        name: col.name,
        inferredType: col.type,
        index: col.index
      }));
      
      setColumns(columnInfos);
      setRowCount(data.sampleRows);
      setTotalRows(data.totalRows);
      setIsSampled(data.totalRows > data.sampleRows);
      
      // Convert preview to array format for display
      if (data.preview && data.preview.length > 0) {
        const headers = columnInfos.map(c => c.name);
        const previewRows = data.preview.map((row: Record<string, unknown>) => 
          headers.map(h => row[h] !== null && row[h] !== undefined ? String(row[h]) : "")
        );
        setPreviewData([headers, ...previewRows]);
      }

      // Log the ingestion
      await supabase
        .from("project_data_ingestion_logs")
        .insert({
          project_id: projectData.id,
          status: "success",
          rows_read: data.totalRows,
          rows_sampled: data.sampleRows,
          completed_at: new Date().toISOString(),
          metadata: { file_type: file.name.split('.').pop(), file_name: file.name }
        });

      await saveProject({
        dataset_filename: filePath,
        dataset_rows: data.sampleRows,
        dataset_columns: columnInfos.length,
        total_rows: data.totalRows,
        sample_rows: data.sampleRows,
        status: "data_uploaded"
      });

      setUploadStatus("success");
      toast({
        title: t("dataIngestion.file.uploadSuccess"),
        description: data.totalRows > data.sampleRows 
          ? t("dataIngestion.file.uploadSuccessSampled", { 
              filename: file.name, 
              sampled: data.sampleRows,
              total: data.totalRows 
            })
          : t("dataIngestion.file.uploadSuccessDesc", { 
              filename: file.name, 
              rows: data.totalRows, 
              columns: columnInfos.length 
            }),
      });

      onDataReady();
    } catch (error: any) {
      console.error("Processing error:", error);
      setErrorMessage(error.message || t("dataIngestion.file.errors.processingFailed"));
      setUploadStatus("error");
    }
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
  };

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
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowImportJobsModal(true)}
        >
          <History className="w-4 h-4 mr-2" />
          {t("dataIngestion.import.viewImports")}
        </Button>
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
          <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="text-sm text-destructive">{errorMessage}</div>
        </div>
      )}

      {/* Upload area */}
      <div
        className={`relative border-2 border-dashed rounded-xl p-12 text-center transition-all ${
          isDragging
            ? "border-primary bg-primary/5"
            : uploadStatus === "success"
            ? "border-accent bg-accent/5"
            : uploadStatus === "error"
            ? "border-destructive bg-destructive/5"
            : "border-border hover:border-primary/50 hover:bg-muted/50"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {uploadStatus !== "uploading" && uploadStatus !== "processing" && (
          <input
            type="file"
            accept=".csv,.parquet,.xlsx,.json"
            onChange={handleFileSelect}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        )}

        {uploadStatus === "uploading" || uploadStatus === "processing" ? (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-primary/20 rounded-2xl flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <div>
              <p className="font-semibold text-lg">
                {uploadStatus === "processing" ? t("dataIngestion.file.processing") : t("dataIngestion.file.uploading")}
              </p>
              <p className="text-sm text-muted-foreground">
                {uploadStatus === "processing" 
                  ? t("dataIngestion.file.processingDesc") 
                  : t("dataIngestion.file.uploadingDesc")}
              </p>
            </div>
          </div>
        ) : uploadStatus === "success" ? (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-accent/20 rounded-2xl flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8 text-accent" />
            </div>
            <div>
              <p className="font-semibold text-lg">{t("dataIngestion.file.uploadComplete")}</p>
              <p className="text-sm text-muted-foreground">
                {selectedFile?.name || projectData.dataset_filename?.split("/").pop()} • {rowCount.toLocaleString()} {t("dataIngestion.file.rows")}
                {isSampled && ` (${t("dataIngestion.file.sampledFrom", { total: totalRows.toLocaleString() })})`}
                {" • "}{columns.length} {t("dataIngestion.file.columns")}
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
        ) : (
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
            </div>
          </div>
        )}
      </div>

      {/* Data Preview with stats */}
      {columns.length > 0 && uploadStatus === "success" && (
        <DataPreviewSection
          columns={columns.map(c => ({ name: c.name, type: c.inferredType, index: c.index }))}
          previewRows={previewData.length > 1 
            ? previewData.slice(1).map(row => {
                const obj: Record<string, unknown> = {};
                columns.forEach((col, i) => {
                  obj[col.name] = row[i] || null;
                });
                return obj;
              })
            : []
          }
          totalRows={totalRows}
          sampleRows={rowCount}
          isSampled={isSampled}
        />
      )}

      {/* Batch Import Modal */}
      {largeFiles.length > 0 && projectData.id && (
        <BatchImportModal
          open={showLargeImportModal}
          onOpenChange={setShowLargeImportModal}
          initialFiles={largeFiles}
          projectId={projectData.id}
          onImportStarted={handleImportStarted}
        />
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
    </div>
  );
};

export default FileUploadSection;
