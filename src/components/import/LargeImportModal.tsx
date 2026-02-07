import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, Loader2, FileWarning, Sparkles, Info, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { buildSafeObjectName } from "@/lib/storageObjectName";
import { detectCSVDelimiter } from "@/lib/csvDelimiterDetector";
import { useImportPreview } from "@/hooks/useImportPreview";
import DataPreviewSection from "@/components/data-ingestion/DataPreviewSection";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface LargeImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: File;
  projectId: string;
  onImportStarted: () => void;
}

interface UploadStats {
  bytesUploaded: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

const MAX_LARGE_IMPORT_GB = 10;
const POLL_INTERVAL_MS = 1500;

const LargeImportModal = ({
  open,
  onOpenChange,
  file,
  projectId,
  onImportStarted,
}: LargeImportModalProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [datasetName, setDatasetName] = useState(
    file.name.replace(/\.(parquet|parq|pq|csv|xlsx|xls|json)$/i, "")
  );
  const [delimiter, setDelimiter] = useState(",");
  const [encoding, setEncoding] = useState("UTF-8");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStats, setUploadStats] = useState<UploadStats | null>(null);
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "processing" | "done">("uploading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDetectingDelimiter, setIsDetectingDelimiter] = useState(false);
  const [delimiterAutoDetected, setDelimiterAutoDetected] = useState(false);
  const [serverProgress, setServerProgress] = useState(0);

  const isParquet = /\.(parquet|parq|pq)$/i.test(file.name);

  const lastBytesRef = useRef(0);
  const lastTimeRef = useRef(Date.now());
  const speedHistoryRef = useRef<number[]>([]);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  // ─── Preview hook ──────────────────────────────────────────
  const {
    preview,
    loading: previewLoading,
    error: previewError,
  } = useImportPreview({
    file: open ? file : null,
    delimiter: isParquet ? undefined : delimiter,
    enabled: open && !isUploading,
  });

  // Auto-detect delimiter when modal opens (skip for Parquet)
  useEffect(() => {
    if (open && file && !isParquet) {
      setIsDetectingDelimiter(true);
      setDelimiterAutoDetected(false);
      
      detectCSVDelimiter(file)
        .then((result) => {
          setDelimiter(result.delimiter);
          setDelimiterAutoDetected(true);
          console.log(`[LargeImportModal] Auto-detected delimiter: "${result.delimiter}" (confidence: ${result.confidence})`);
        })
        .catch((err) => {
          console.warn('[LargeImportModal] Failed to detect delimiter:', err);
        })
        .finally(() => {
          setIsDetectingDelimiter(false);
        });
    }
  }, [open, file, isParquet]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
  const fileSizeGB = (file.size / 1024 / 1024 / 1024).toFixed(2);

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

  // Poll for job progress during server processing phase
  const startProgressPolling = useCallback((jobId: string) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    jobIdRef.current = jobId;

    const poll = async () => {
      if (!jobIdRef.current) return;

      try {
        const { data: job } = await supabase
          .from("import_jobs")
          .select("status, progress, rows_processed, error_message")
          .eq("id", jobIdRef.current)
          .single();

        if (!job) return;

        if (job.status === "completed") {
          setServerProgress(100);
          setUploadProgress(100);
          setUploadPhase("done");
          
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }

          toast({
            title: t("dataIngestion.import.importStarted"),
            description: t("dataIngestion.import.importStartedDesc"),
          });
          onImportStarted();
          onOpenChange(false);
          return;
        }

        if (job.status === "failed") {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }

          setErrorMessage(job.error_message || t("dataIngestion.import.errors.unexpected"));
          setIsUploading(false);
          return;
        }

        // Update progress - map server progress (0-100) to UI progress (75-99)
        const progress = job.progress || 0;
        setServerProgress(progress);
        const uiProgress = 75 + Math.round(progress * 0.24);
        setUploadProgress(Math.min(99, Math.max(75, uiProgress)));

      } catch (err) {
        console.warn("[LargeImportModal] Polling error:", err);
      }
    };

    poll();
    pollIntervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [t, toast, onImportStarted, onOpenChange]);

  // Upload with XMLHttpRequest for real progress tracking
  const uploadFileWithProgress = useCallback(
    async (
      fileToUpload: File,
      storagePath: string,
      onProgress: (loaded: number, total: number) => void
    ): Promise<{ error: Error | null }> => {
      return new Promise(async (resolve) => {
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (!session) {
            resolve({ error: new Error("Not authenticated") });
            return;
          }

          const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
          const apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

          const encodedPath = storagePath
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/");

          const url = `${supabaseUrl}/storage/v1/object/big_imports/${encodedPath}`;

          const xhr = new XMLHttpRequest();

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              onProgress(event.loaded, event.total);
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve({ error: null });
            } else {
              let errorMsg = `Upload failed: ${xhr.status}`;
              try {
                const resp = JSON.parse(xhr.responseText);
                if (resp.message) errorMsg = resp.message;
                if (resp.error) errorMsg = resp.error;
              } catch {
                // keep default message
              }
              resolve({ error: new Error(errorMsg) });
            }
          };

          xhr.onerror = () => {
            resolve({ error: new Error("Erro de rede durante upload. Verifique sua conexão.") });
          };

          xhr.ontimeout = () => {
            resolve({ error: new Error("Upload expirou. O arquivo pode ser muito grande para sua conexão.") });
          };

          xhr.open("POST", url, true);
          xhr.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
          xhr.setRequestHeader("apikey", apiKey);
          xhr.setRequestHeader("x-upsert", "true");
          xhr.timeout = 0;

          xhr.send(fileToUpload);
        } catch (err) {
          resolve({ error: err instanceof Error ? err : new Error("Erro desconhecido") });
        }
      });
    },
    []
  );

  const handleStartImport = async () => {
    setIsUploading(true);
    setUploadProgress(0);
    setUploadPhase("uploading");
    setUploadStats(null);
    setErrorMessage(null);
    setServerProgress(0);
    lastBytesRef.current = 0;
    lastTimeRef.current = Date.now();
    speedHistoryRef.current = [];

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setErrorMessage(t("dataIngestion.import.errors.notAuthenticated"));
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.notAuthenticated"),
          variant: "destructive",
        });
        setIsUploading(false);
        return;
      }

      const storageObjectName = buildSafeObjectName(file.name);
      const storagePath = `${user.id}/${projectId}/${storageObjectName}`;

      // Create job first
      const { data: createdJob, error: jobCreateError } = await supabase
        .from("import_jobs")
        .insert({
          project_id: projectId,
          user_id: user.id,
          file_name: datasetName,
          file_size_bytes: file.size,
          storage_path: storagePath,
          delimiter,
          encoding,
          status: "pending",
          progress: 0,
        })
        .select("id")
        .single();

      if (jobCreateError || !createdJob) {
        console.error("Job creation error:", jobCreateError);
        setErrorMessage(t("dataIngestion.import.errors.jobCreationFailed"));
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.jobCreationFailed"),
          variant: "destructive",
        });
        setIsUploading(false);
        return;
      }

      const jobId = createdJob.id;

      // Upload with real progress (0-70%)
      const { error: uploadError } = await uploadFileWithProgress(file, storagePath, (loaded, total) => {
        const now = Date.now();
        const timeDelta = (now - lastTimeRef.current) / 1000;

        if (timeDelta >= 0.5) {
          const bytesDelta = loaded - lastBytesRef.current;
          const instantSpeed = bytesDelta / timeDelta;

          speedHistoryRef.current.push(instantSpeed);
          if (speedHistoryRef.current.length > 5) {
            speedHistoryRef.current.shift();
          }

          const avgSpeed =
            speedHistoryRef.current.reduce((a, b) => a + b, 0) / speedHistoryRef.current.length;
          const bytesRemaining = total - loaded;
          const eta = avgSpeed > 0 ? bytesRemaining / avgSpeed : 0;

          setUploadStats({
            bytesUploaded: loaded,
            totalBytes: total,
            speed: avgSpeed,
            eta,
          });

          lastBytesRef.current = loaded;
          lastTimeRef.current = now;
        }

        const progress = Math.floor((loaded / total) * 70);
        setUploadProgress(progress);
      });

      if (uploadError) {
        console.error("Upload error:", uploadError);

        await supabase
          .from("import_jobs")
          .update({
            status: "failed",
            error_message: uploadError.message,
            finished_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        setErrorMessage(uploadError.message);
        toast({
          title: t("common.error"),
          description: uploadError.message,
          variant: "destructive",
        });
        setIsUploading(false);
        return;
      }

      // Mark job ready for processing
      await supabase
        .from("import_jobs")
        .update({
          status: "pending",
          progress: 0,
          error_message: null,
        })
        .eq("id", jobId);

      // Keep at 70% first (upload done), then bump to 75% after triggering
      setUploadProgress(70);
      setUploadStats(null);
      setUploadPhase("processing");

      // Start polling for server progress
      startProgressPolling(jobId);

      // Trigger processing
      console.log("Invoking process-import for job:", jobId);
      const { error: processError } = await supabase.functions.invoke("process-import", {
        body: { job_id: jobId },
      });

      // After triggering, bump to 75% and let polling take over
      setUploadProgress(75);

      if (processError) {
        console.error("Process trigger error:", processError);
        // Don't fail - polling will detect actual status
        console.log("Note: Edge function may continue processing in background");
      }

    } catch (error: any) {
      console.error("Import error:", error);
      setErrorMessage(error.message || t("dataIngestion.import.errors.unexpected"));
      toast({
        title: t("common.error"),
        description: error.message || t("dataIngestion.import.errors.unexpected"),
        variant: "destructive",
      });
      setIsUploading(false);
    }
  };

  // Map preview columns to DataPreviewSection format
  const previewColumns = preview?.columns.map((c) => ({
    name: c.name,
    type: c.type,
    index: c.index,
  })) || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            {t("dataIngestion.import.largeImportTitle")}
          </DialogTitle>
          <DialogDescription className="space-y-1">
            <span>{t("dataIngestion.import.largeImportDesc")}</span>
            <span className="block font-medium text-foreground">{t("dataIngestion.import.maxFileSize")}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File info */}
          <div className="flex items-start gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
            <FileWarning className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium">{file.name}</p>
              <p className="text-muted-foreground">
                {Number(fileSizeGB) >= 1 
                  ? `${fileSizeGB} GB`
                  : `${fileSizeMB} MB`
                }
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("dataIngestion.import.processingWarning")}
              </p>
            </div>
          </div>

          {/* Error message */}
          {errorMessage && (
            <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          {/* Dataset name */}
          <div className="space-y-2">
            <Label htmlFor="datasetName">
              {t("dataIngestion.import.datasetName")}
            </Label>
            <Input
              id="datasetName"
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              placeholder={t("dataIngestion.import.datasetNamePlaceholder")}
              disabled={isUploading}
            />
          </div>

          {!isParquet ? (
            <>
              {/* Delimiter */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>{t("dataIngestion.import.delimiter")}</Label>
                  {isDetectingDelimiter && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t("dataIngestion.import.detectingDelimiter")}
                    </span>
                  )}
                  {delimiterAutoDetected && !isDetectingDelimiter && (
                    <span className="text-xs text-primary flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      {t("dataIngestion.import.delimiterAutoDetected")}
                    </span>
                  )}
                </div>
                <Select 
                  value={delimiter} 
                  onValueChange={(val) => {
                    setDelimiter(val);
                    setDelimiterAutoDetected(false);
                  }} 
                  disabled={isUploading || isDetectingDelimiter}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value=",">{t("dataIngestion.import.delimiterComma")}</SelectItem>
                    <SelectItem value=";">{t("dataIngestion.import.delimiterSemicolon")}</SelectItem>
                    <SelectItem value="\t">{t("dataIngestion.import.delimiterTab")}</SelectItem>
                    <SelectItem value="|">{t("dataIngestion.import.delimiterPipe")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Encoding */}
              <div className="space-y-2">
                <Label>{t("dataIngestion.import.encoding")}</Label>
                <Select value={encoding} onValueChange={setEncoding} disabled={isUploading}>
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
          ) : (
            <div className="flex items-start gap-3 p-3 bg-primary/10 border border-primary/20 rounded-lg">
              <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div className="text-sm text-muted-foreground">
                {t("dataIngestion.import.parquetInfoBanner", {
                  defaultValue: "Parquet detectado: o schema e os tipos serão extraídos automaticamente. Delimitador e encoding não se aplicam."
                })}
              </div>
            </div>
          )}

          {/* ─── Preview Section ────────────────────────────── */}
          {!isUploading && (
            <div className="space-y-3">
              {previewLoading && (
                <div className="flex items-center gap-3 p-4 bg-muted/30 rounded-lg border border-border">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">
                    {t("dataIngestion.import.generatingPreview", {
                      defaultValue: "Gerando preview do dataset...",
                    })}
                  </span>
                </div>
              )}

              {previewError && (
                <Alert variant="destructive" className="border-destructive/30 bg-destructive/5">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm">
                    {previewError}
                  </AlertDescription>
                </Alert>
              )}

              {preview && (
                <>
                  {/* Sampling warning banner */}
                  <Alert variant="default" className="border-primary/30 bg-primary/5">
                    <Info className="h-4 w-4 text-primary" />
                    <AlertDescription className="text-sm">
                      {t("dataIngestion.import.previewSamplingWarning", {
                        defaultValue:
                          "Preview por amostragem. O processamento completo roda em background e pode alterar contagens finais.",
                      })}
                    </AlertDescription>
                  </Alert>

                  {/* Warnings from the preview engine */}
                  {preview.warnings.length > 0 && (
                    <div className="space-y-1">
                      {preview.warnings.map((w, i) => (
                        <p key={i} className="text-xs text-muted-foreground italic">
                          {w}
                        </p>
                      ))}
                    </div>
                  )}

                  <DataPreviewSection
                    columns={previewColumns}
                    previewRows={preview.previewRows}
                    totalRows={preview.totalRowsEstimate}
                    sampleRows={preview.previewRows.length}
                    isSampled={preview.totalRowsEstimate > preview.previewRows.length}
                  />
                </>
              )}
            </div>
          )}

          {/* Upload progress with detailed stats */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>
                  {uploadPhase === "uploading" && t("dataIngestion.import.uploading")}
                  {uploadPhase === "processing" && t("dataIngestion.import.processing")}
                  {uploadPhase === "done" && t("dataIngestion.import.done")}
                </span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div 
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              {uploadStats && uploadPhase === "uploading" && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{formatSpeed(uploadStats.speed)}</span>
                  <span>{formatETA(uploadStats.eta)}</span>
                </div>
              )}
              {uploadPhase === "processing" && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {t("dataIngestion.import.uploadCompletedProcessing")}
                  </p>
                  {serverProgress > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("dataIngestion.batchImport.serverProgress", { progress: serverProgress })}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isUploading}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleStartImport}
            disabled={isUploading || !datasetName.trim()}
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {uploadPhase === "uploading" && t("dataIngestion.import.uploading")}
                {uploadPhase === "processing" && t("dataIngestion.import.processing")}
                {uploadPhase === "done" && t("dataIngestion.import.done")}
              </>
            ) : (
              t("dataIngestion.import.startImport")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default LargeImportModal;
