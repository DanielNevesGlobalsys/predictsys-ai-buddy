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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { 
  Upload, 
  Loader2, 
  FileSpreadsheet, 
  X, 
  CheckCircle, 
  AlertCircle,
  Plus,
  Info,
  Sparkles
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { buildSafeObjectName } from "@/lib/storageObjectName";
import { detectCSVDelimiterFromFiles } from "@/lib/csvDelimiterDetector";

interface BatchFile {
  file: File;
  status: "pending" | "uploading" | "uploaded" | "error";
  error?: string;
  storagePathfile?: string;
}

interface BatchImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFiles: File[];
  projectId: string;
  onImportStarted: () => void;
}

interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  speed: number; // bytes per second
  eta: number; // seconds remaining
}

const MAX_LARGE_IMPORT_GB = 10;
const MAX_LARGE_IMPORT_BYTES = MAX_LARGE_IMPORT_GB * 1024 * 1024 * 1024;

const BatchImportModal = ({
  open,
  onOpenChange,
  initialFiles,
  projectId,
  onImportStarted,
}: BatchImportModalProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [datasetName, setDatasetName] = useState(
    initialFiles.length > 0 
      ? initialFiles[0].name.replace(/\.[^/.]+$/, "") + "_batch"
      : "dataset_batch"
  );
  const [delimiter, setDelimiter] = useState(",");
  const [encoding, setEncoding] = useState("UTF-8");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStats, setUploadStats] = useState<UploadProgress | null>(null);
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "processing" | "done">("uploading");
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>(
    initialFiles.map(f => ({ file: f, status: "pending" }))
  );
  const [isDetectingDelimiter, setIsDetectingDelimiter] = useState(false);
  const [delimiterAutoDetected, setDelimiterAutoDetected] = useState(false);

  // Refs for speed calculation
  const lastBytesRef = useRef(0);
  const lastTimeRef = useRef(Date.now());
  const speedHistoryRef = useRef<number[]>([]);

  // Auto-detect delimiter when modal opens or files change
  useEffect(() => {
    if (open && batchFiles.length > 0) {
      const files = batchFiles.map(bf => bf.file);
      setIsDetectingDelimiter(true);
      setDelimiterAutoDetected(false);
      
      detectCSVDelimiterFromFiles(files)
        .then((result) => {
          setDelimiter(result.delimiter);
          setDelimiterAutoDetected(true);
          console.log(`[BatchImportModal] Auto-detected delimiter: "${result.delimiter}" (confidence: ${result.confidence})`);
        })
        .catch((err) => {
          console.warn('[BatchImportModal] Failed to detect delimiter:', err);
        })
        .finally(() => {
          setIsDetectingDelimiter(false);
        });
    }
  }, [open, batchFiles.length]);

  const totalSizeBytes = batchFiles.reduce((sum, bf) => sum + bf.file.size, 0);
  const totalSizeGB = (totalSizeBytes / 1024 / 1024 / 1024).toFixed(2);
  const totalSizeMB = (totalSizeBytes / 1024 / 1024).toFixed(2);

  const formatFileSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  const formatSpeed = (bytesPerSecond: number) => {
    if (bytesPerSecond >= 1024 * 1024) {
      return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
    }
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  };

  const formatETA = (seconds: number) => {
    if (seconds < 60) {
      return `~${Math.ceil(seconds)}s`;
    } else if (seconds < 3600) {
      const mins = Math.ceil(seconds / 60);
      return `~${mins} min`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.ceil((seconds % 3600) / 60);
      return `~${hours}h ${mins}min`;
    }
  };

  const handleAddFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
    
    if (csvFiles.length !== files.length) {
      toast({
        title: t("common.error"),
        description: t("dataIngestion.batchImport.onlyCsv"),
        variant: "destructive",
      });
    }
    
    const newBatchFiles = csvFiles.map(f => ({ file: f, status: "pending" as const }));
    setBatchFiles(prev => [...prev, ...newBatchFiles]);
    
    // Reset input
    e.target.value = "";
  };

  const handleRemoveFile = (index: number) => {
    setBatchFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Upload file with XMLHttpRequest for real progress tracking
  const uploadFileWithProgress = useCallback(
    async (
      file: File,
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

          // IMPORTANT: URL-encode each segment, preserving "/".
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
                // keep default
              }
              resolve({ error: new Error(errorMsg) });
            }
          };

          xhr.onerror = () => {
            resolve({ error: new Error("Network error during upload") });
          };

          xhr.ontimeout = () => {
            resolve({ error: new Error("Upload timed out") });
          };

          xhr.open("POST", url, true);
          xhr.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
          xhr.setRequestHeader("apikey", apiKey);
          xhr.setRequestHeader("x-upsert", "true");
          xhr.timeout = 0; // No timeout for large files

          xhr.send(file);
        } catch (err) {
          resolve({ error: err instanceof Error ? err : new Error("Unknown error") });
        }
      });
    },
    []
  );

  const handleStartImport = async () => {
    if (batchFiles.length === 0) return;
    
    // Validate total size before starting
    if (totalSizeBytes > MAX_LARGE_IMPORT_BYTES) {
      toast({
        title: t("common.error"),
        description: t("dataIngestion.import.batchTooLarge", { maxSize: MAX_LARGE_IMPORT_GB }),
        variant: "destructive",
      });
      return;
    }
    
    setIsUploading(true);
    setUploadProgress(0);
    setUploadPhase("uploading");
    setUploadStats(null);
    lastBytesRef.current = 0;
    lastTimeRef.current = Date.now();
    speedHistoryRef.current = [];

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.notAuthenticated"),
          variant: "destructive",
        });
        setIsUploading(false);
        return;
      }

      // Generate batch ID
      const batchId = crypto.randomUUID();
      
      // Track total progress across all files
      let totalUploaded = 0;
      const fileOffsets: number[] = [];
      let runningOffset = 0;
      for (const bf of batchFiles) {
        fileOffsets.push(runningOffset);
        runningOffset += bf.file.size;
      }

      // Upload each file with real progress
      let primaryJobId: string | null = null;
      let anyUploadFailed = false;

      for (let i = 0; i < batchFiles.length; i++) {
        const bf = batchFiles[i];

        setBatchFiles((prev) =>
          prev.map((item, idx) => (idx === i ? { ...item, status: "uploading" } : item))
        );

         const storageObjectName = buildSafeObjectName(bf.file.name);
         const storagePath = `${user.id}/${projectId}/${batchId}/${storageObjectName}`;
        const jobFileName = i === 0 ? datasetName : `${datasetName}_part${i + 1}`;

        // Create job BEFORE upload so it never disappears.
        const { data: createdJob, error: jobError } = await supabase
          .from("import_jobs")
          .insert({
            project_id: projectId,
            user_id: user.id,
            file_name: jobFileName,
            file_size_bytes: bf.file.size,
            storage_path: storagePath,
            delimiter,
            encoding,
            status: "pending",
            progress: 0,
            batch_id: batchId,
            batch_sequence: i + 1,
            is_batch_primary: i === 0,
          })
          .select("id")
          .single();

        if (jobError || !createdJob) {
          console.error(`Job creation error for ${bf.file.name}:`, jobError);
          anyUploadFailed = true;
          setBatchFiles((prev) =>
            prev.map((item, idx) =>
              idx === i
                ? { ...item, status: "error", error: t("dataIngestion.import.errors.jobCreationFailed") }
                : item
            )
          );
          continue;
        }

        if (i === 0) primaryJobId = createdJob.id;

        const { error: uploadError } = await uploadFileWithProgress(bf.file, storagePath, (loaded, total) => {
          const currentTotalUploaded = fileOffsets[i] + loaded;
          totalUploaded = currentTotalUploaded;

          const now = Date.now();
          const timeDelta = (now - lastTimeRef.current) / 1000;

          if (timeDelta >= 0.5) {
            const bytesDelta = currentTotalUploaded - lastBytesRef.current;
            const instantSpeed = bytesDelta / timeDelta;

            speedHistoryRef.current.push(instantSpeed);
            if (speedHistoryRef.current.length > 5) {
              speedHistoryRef.current.shift();
            }

            const avgSpeed =
              speedHistoryRef.current.reduce((a, b) => a + b, 0) / speedHistoryRef.current.length;
            const bytesRemaining = totalSizeBytes - currentTotalUploaded;
            const eta = avgSpeed > 0 ? bytesRemaining / avgSpeed : 0;

            setUploadStats({
              bytesUploaded: currentTotalUploaded,
              totalBytes: totalSizeBytes,
              speed: avgSpeed,
              eta,
            });

            lastBytesRef.current = currentTotalUploaded;
            lastTimeRef.current = now;
          }

          const overallProgress = Math.floor((currentTotalUploaded / totalSizeBytes) * 70);
          setUploadProgress(overallProgress);
        });

        if (uploadError) {
          console.error(`Upload error for ${bf.file.name}:`, uploadError);
          anyUploadFailed = true;

          await supabase
            .from("import_jobs")
            .update({
              status: "failed",
              error_message: uploadError.message,
              finished_at: new Date().toISOString(),
            })
            .eq("id", createdJob.id);

          setBatchFiles((prev) =>
            prev.map((item, idx) =>
              idx === i
                ? { ...item, status: "error", error: t("dataIngestion.import.errors.uploadFailed") }
                : item
            )
          );
          continue;
        }

        // Mark job ready for backend processing
        await supabase
          .from("import_jobs")
          .update({ status: "pending", progress: 0, error_message: null })
          .eq("id", createdJob.id);

        setBatchFiles((prev) =>
          prev.map((item, idx) =>
            idx === i ? { ...item, status: "uploaded", storagePathfile: storagePath } : item
          )
        );
      }

      if (anyUploadFailed || !primaryJobId) {
        // Ensure no "pending" jobs remain stuck when the batch upload is incomplete.
        await supabase
          .from("import_jobs")
          .update({
            status: "failed",
            error_message: "Upload do lote não foi concluído. Reenvie o lote.",
            finished_at: new Date().toISOString(),
          })
          .eq("batch_id", batchId)
          .neq("status", "failed");

        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.uploadFailed"),
          variant: "destructive",
        });

        // Keep modal open so the user can see which files failed.
        return;
      }

      setUploadProgress(80);
      setUploadPhase("processing");
      setUploadStats(null);

      console.log("Invoking process-import for batch primary job:", primaryJobId);
      const { error: fnError } = await supabase.functions.invoke("process-import", {
        body: { job_id: primaryJobId, batch_id: batchId },
      });

      if (fnError) {
        console.error("Process-import error:", fnError);
        // Do not flip to failed here (function might have started). Store the error message for visibility.
        await supabase
          .from("import_jobs")
          .update({ error_message: `Falha ao acionar processamento: ${fnError.message}` })
          .eq("batch_id", batchId)
          .eq("status", "pending");
      }

      setUploadProgress(100);
      setUploadPhase("done");

      toast({
        title: t("dataIngestion.batchImport.importStarted"),
        description: t("dataIngestion.batchImport.importStartedDesc", { count: batchFiles.length }),
      });

      onImportStarted();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Batch import error:", error);
      toast({
        title: t("common.error"),
        description: error.message || t("dataIngestion.import.errors.unexpected"),
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      setUploadStats(null);
    }
  };

  const successCount = batchFiles.filter(bf => bf.status === "uploaded").length;
  const errorCount = batchFiles.filter(bf => bf.status === "error").length;
  const isTooLarge = totalSizeBytes > MAX_LARGE_IMPORT_BYTES;
  const canStart = batchFiles.length > 0 && !isUploading && datasetName.trim() && !isTooLarge;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            {t("dataIngestion.batchImport.title")}
          </DialogTitle>
          <DialogDescription className="space-y-1">
            <span>{t("dataIngestion.batchImport.description")}</span>
            <span className="block font-medium text-foreground">
              {t("dataIngestion.import.maxFileSize")}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Info about batch behavior */}
          <div className="flex items-start gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
            <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium">{t("dataIngestion.batchImport.infoTitle")}</p>
              <p className="text-muted-foreground">{t("dataIngestion.batchImport.infoDesc")}</p>
            </div>
          </div>

          {/* Size warning if too large */}
          {isTooLarge && (
            <div className="flex items-start gap-3 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
              <div className="text-sm text-destructive">
                <p className="font-medium">{t("dataIngestion.import.batchTooLargeTitle")}</p>
                <p>{t("dataIngestion.import.batchTooLarge", { maxSize: MAX_LARGE_IMPORT_GB })}</p>
              </div>
            </div>
          )}

          {/* Files list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("dataIngestion.batchImport.files")} ({batchFiles.length})</Label>
              <span className={`text-sm ${isTooLarge ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                {Number(totalSizeGB) >= 1 ? `${totalSizeGB} GB` : `${totalSizeMB} MB`} {t("dataIngestion.batchImport.total")}
                {isTooLarge && ` (máx: ${MAX_LARGE_IMPORT_GB} GB)`}
              </span>
            </div>
            
            <ScrollArea className="max-h-[200px] border rounded-lg p-2">
              <div className="space-y-2">
                {batchFiles.map((bf, index) => (
                  <div 
                    key={`${bf.file.name}-${index}`}
                    className="flex items-center justify-between p-2 bg-muted/50 rounded"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileSpreadsheet className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                      <span className="text-sm truncate">{bf.file.name}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatFileSize(bf.file.size)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {bf.status === "uploading" && (
                        <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      )}
                      {bf.status === "uploaded" && (
                        <CheckCircle className="w-4 h-4 text-accent" />
                      )}
                      {bf.status === "error" && (
                        <Badge variant="destructive" className="text-xs">
                          <AlertCircle className="w-3 h-3 mr-1" />
                          {t("dataIngestion.batchImport.error")}
                        </Badge>
                      )}
                      {!isUploading && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => handleRemoveFile(index)}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            {/* Add more files button */}
            {!isUploading && (
              <div className="relative">
                <input
                  type="file"
                  accept=".csv"
                  multiple
                  onChange={handleAddFiles}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <Button variant="outline" className="w-full" type="button">
                  <Plus className="w-4 h-4 mr-2" />
                  {t("dataIngestion.batchImport.addMoreFiles")}
                </Button>
              </div>
            )}
          </div>

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

          {/* Delimiter & Encoding */}
          <div className="grid grid-cols-2 gap-4">
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
          </div>

          {/* Upload progress with speed and ETA */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>
                  {uploadPhase === "processing" 
                    ? t("dataIngestion.batchImport.processingServer")
                    : t("dataIngestion.batchImport.uploading")
                  }
                </span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div 
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              
              {/* Speed and ETA */}
              {uploadPhase === "uploading" && uploadStats && uploadStats.speed > 0 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {formatFileSize(uploadStats.bytesUploaded)} / {formatFileSize(uploadStats.totalBytes)}
                  </span>
                  <span>
                    {formatSpeed(uploadStats.speed)} • {formatETA(uploadStats.eta)}
                  </span>
                </div>
              )}
              
              {uploadPhase === "processing" && (
                <p className="text-xs text-muted-foreground">
                  {t("dataIngestion.batchImport.processingServerDesc")}
                </p>
              )}
              
              {successCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("dataIngestion.batchImport.uploadedCount", { count: successCount, total: batchFiles.length })}
                </p>
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
            disabled={!canStart}
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {uploadPhase === "processing" 
                  ? t("dataIngestion.batchImport.processingServer")
                  : t("dataIngestion.batchImport.uploading")
                }
              </>
            ) : (
              <>
                {t("dataIngestion.batchImport.startImport")} ({batchFiles.length} {batchFiles.length === 1 ? t("dataIngestion.batchImport.file") : t("dataIngestion.batchImport.filesPlural")})
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BatchImportModal;
