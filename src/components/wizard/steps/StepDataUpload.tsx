import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileSpreadsheet, CheckCircle, Info, AlertCircle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import Papa from "papaparse";
import type { ProjectData } from "../WizardContainer";

interface StepDataUploadProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

interface ColumnInfo {
  name: string;
  inferredType: string;
  index: number;
}

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const inferColumnType = (values: string[]): string => {
  const nonEmpty = values.filter(v => v !== null && v !== undefined && v.trim() !== "");
  if (nonEmpty.length === 0) return "texto";
  
  const allNumbers = nonEmpty.every(v => !isNaN(Number(v.replace(",", "."))));
  if (allNumbers) return "numérico";
  
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}/,
    /^\d{2}\/\d{2}\/\d{4}/,
    /^\d{2}-\d{2}-\d{4}/,
  ];
  const allDates = nonEmpty.every(v => datePatterns.some(p => p.test(v)));
  if (allDates) return "data";
  
  const uniqueValues = new Set(nonEmpty);
  if (uniqueValues.size <= Math.min(10, nonEmpty.length * 0.3)) {
    return "categórico";
  }
  
  return "texto";
};

const StepDataUpload = ({ projectData, onNext, onBack, loading, saveProject }: StepDataUploadProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "processing" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [previewData, setPreviewData] = useState<string[][]>([]);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rowCount, setRowCount] = useState(0);

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

  const validateAndProcessFile = (file: File) => {
    setErrorMessage("");
    setUploadStatus("idle");
    
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setErrorMessage(t("stepData.errors.invalidFormat"));
      setUploadStatus("error");
      return;
    }
    
    if (file.size > MAX_FILE_SIZE) {
      setErrorMessage(t("stepData.errors.fileTooLarge", { size: (file.size / 1024 / 1024).toFixed(2) }));
      setUploadStatus("error");
      return;
    }
    
    setSelectedFile(file);
    parseAndUploadFile(file);
  };

  const parseAndUploadFile = async (file: File) => {
    if (!projectData.id) {
      setErrorMessage(t("stepData.errors.projectNotFound"));
      setUploadStatus("error");
      return;
    }

    setUploadStatus("processing");

    Papa.parse(file, {
      complete: async (results) => {
        try {
          const data = results.data as string[][];
          
          if (data.length < 2) {
            setErrorMessage(t("stepData.errors.minRows"));
            setUploadStatus("error");
            return;
          }

          const headers = data[0];
          const dataRows = data.slice(1).filter(row => row.some(cell => cell.trim() !== ""));
          
          const preview = [headers, ...dataRows.slice(0, 10)];
          setPreviewData(preview);
          setRowCount(dataRows.length);

          const columnInfos: ColumnInfo[] = headers.map((header, index) => {
            const columnValues = dataRows.map(row => row[index] || "");
            return {
              name: header,
              inferredType: inferColumnType(columnValues),
              index
            };
          });
          setColumns(columnInfos);

          setUploadStatus("uploading");

          const { data: { user } } = await supabase.auth.getUser();
          if (!user) {
            setErrorMessage(t("stepData.errors.notAuthenticated"));
            setUploadStatus("error");
            return;
          }

          const filePath = `${user.id}/${projectData.id}/${file.name}`;

          const { error: uploadError } = await supabase.storage
            .from("datasets")
            .upload(filePath, file, {
              upsert: true,
              contentType: "text/csv"
            });

          if (uploadError) {
            console.error("Upload error:", uploadError);
            setErrorMessage(t("stepData.errors.uploadFailed"));
            setUploadStatus("error");
            return;
          }

          await supabase
            .from("project_columns")
            .delete()
            .eq("project_id", projectData.id);

          const columnsToInsert = columnInfos.map(col => ({
            project_id: projectData.id,
            column_name: col.name,
            inferred_type: col.inferredType,
            column_index: col.index
          }));

          await supabase
            .from("project_columns")
            .insert(columnsToInsert);

          await saveProject({
            dataset_filename: filePath,
            dataset_rows: dataRows.length,
            dataset_columns: headers.length,
            status: "data_uploaded"
          });

          setUploadStatus("success");
          toast({
            title: t("stepData.uploadSuccess"),
            description: t("stepData.uploadSuccessDesc", { 
              filename: file.name, 
              rows: dataRows.length, 
              columns: headers.length 
            }),
          });

        } catch (error: any) {
          console.error("Processing error:", error);
          setErrorMessage(t("stepData.errors.processingFailed"));
          setUploadStatus("error");
        }
      },
      error: (error) => {
        console.error("Parse error:", error);
        setErrorMessage(t("stepData.errors.parseFailed"));
        setUploadStatus("error");
      },
      encoding: "UTF-8"
    });
  };

  const resetUpload = () => {
    setSelectedFile(null);
    setUploadStatus("idle");
    setErrorMessage("");
    setPreviewData([]);
    setColumns([]);
    setRowCount(0);
  };

  const isUploadComplete = uploadStatus === "success";

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Upload className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("stepData.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("stepData.subtitle")}
          </p>
        </div>

        {/* Info box */}
        <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
          <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-primary mb-1">{t("stepData.requirements")}</p>
            <ul className="text-muted-foreground space-y-1">
              <li>• {t("stepData.reqFormat")}</li>
              <li>• {t("stepData.reqSize")}</li>
              <li>• {t("stepData.reqEncoding")}</li>
              <li>• {t("stepData.reqHeader")}</li>
            </ul>
          </div>
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
              accept=".csv"
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
                  {uploadStatus === "processing" ? t("stepData.processing") : t("stepData.uploading")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {uploadStatus === "processing" 
                    ? t("stepData.processingDesc") 
                    : t("stepData.uploadingDesc")}
                </p>
              </div>
            </div>
          ) : uploadStatus === "success" ? (
            <div className="space-y-4">
              <div className="w-16 h-16 bg-accent/20 rounded-2xl flex items-center justify-center mx-auto">
                <CheckCircle className="w-8 h-8 text-accent" />
              </div>
              <div>
                <p className="font-semibold text-lg">{t("stepData.uploadComplete")}</p>
                <p className="text-sm text-muted-foreground">
                  {selectedFile?.name || projectData.dataset_filename?.split("/").pop()} • {rowCount} {t("stepData.rows")} • {columns.length} {t("stepData.columns")}
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
                {t("stepData.changeFile")}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto">
                <FileSpreadsheet className="w-8 h-8 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-lg">
                  {t("stepData.dragDrop")}
                </p>
                <p className="text-muted-foreground">
                  {t("stepData.orClick")}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Preview table */}
        {previewData.length > 0 && uploadStatus === "success" && (
          <div className="space-y-3">
            <h3 className="font-semibold">{t("stepData.preview")}</h3>
            <div className="bg-muted/30 rounded-lg overflow-hidden border border-border">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50">
                      {previewData[0]?.map((header, i) => (
                        <th key={i} className="px-4 py-3 text-left font-medium text-foreground border-b border-border">
                          <div>
                            <span>{header}</span>
                            <span className="block text-xs text-muted-foreground font-normal">
                              {columns[i]?.inferredType}
                            </span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.slice(1).map((row, rowIndex) => (
                      <tr key={rowIndex} className="hover:bg-muted/20">
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="px-4 py-2 border-b border-border/50 text-muted-foreground">
                            {cell || <span className="text-muted-foreground/50 italic">{t("stepData.empty")}</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 bg-muted/30 text-xs text-muted-foreground border-t border-border">
                {t("stepData.showingRows", { shown: Math.min(10, previewData.length - 1), total: rowCount })}
              </div>
            </div>
          </div>
        )}

        {/* Column summary */}
        {columns.length > 0 && uploadStatus === "success" && (
          <div className="space-y-3">
            <h3 className="font-semibold">{t("stepData.detectedColumns")}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {columns.map((col, i) => (
                <div key={i} className="p-3 bg-muted/30 rounded-lg border border-border/50">
                  <p className="font-medium text-sm truncate" title={col.name}>{col.name}</p>
                  <p className="text-xs text-muted-foreground">{col.inferredType}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || uploadStatus === "uploading" || uploadStatus === "processing"}>
            {t("common.back")}
          </Button>
          <Button
            onClick={() => onNext()}
            disabled={loading || !isUploadComplete}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {isUploadComplete ? t("common.next") : t("stepData.uploadToContinue")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDataUpload;
