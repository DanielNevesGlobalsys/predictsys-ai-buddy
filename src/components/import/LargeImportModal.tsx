import { useState, useCallback, useRef } from "react";
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
import { Upload, Loader2, FileWarning } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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

const LargeImportModal = ({
  open,
  onOpenChange,
  file,
  projectId,
  onImportStarted,
}: LargeImportModalProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [datasetName, setDatasetName] = useState(file.name);
  const [delimiter, setDelimiter] = useState(",");
  const [encoding, setEncoding] = useState("UTF-8");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStats, setUploadStats] = useState<UploadStats | null>(null);
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "processing" | "done">("uploading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const lastBytesRef = useRef(0);
  const lastTimeRef = useRef(Date.now());
  const speedHistoryRef = useRef<number[]>([]);

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

  // Upload with XMLHttpRequest for real progress tracking
  const uploadFileWithProgress = useCallback(async (
    fileToUpload: File,
    storagePath: string,
    onProgress: (loaded: number, total: number) => void
  ): Promise<{ error: Error | null }> => {
    return new Promise(async (resolve) => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          resolve({ error: new Error("Not authenticated") });
          return;
        }

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const url = `${supabaseUrl}/storage/v1/object/big_imports/${storagePath}`;

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
            } catch {}
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
        xhr.setRequestHeader("x-upsert", "true");
        xhr.timeout = 0; // No timeout for large files

        xhr.send(fileToUpload);
      } catch (err) {
        resolve({ error: err instanceof Error ? err : new Error("Erro desconhecido") });
      }
    });
  }, []);

  const handleStartImport = async () => {
    setIsUploading(true);
    setUploadProgress(0);
    setUploadPhase("uploading");
    setUploadStats(null);
    setErrorMessage(null);
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
        return;
      }

      const storagePath = `${user.id}/${projectId}/${file.name}`;

      // Upload with real progress
      const { error: uploadError } = await uploadFileWithProgress(
        file,
        storagePath,
        (loaded, total) => {
          const now = Date.now();
          const timeDelta = (now - lastTimeRef.current) / 1000;

          if (timeDelta >= 0.5) {
            const bytesDelta = loaded - lastBytesRef.current;
            const instantSpeed = bytesDelta / timeDelta;

            speedHistoryRef.current.push(instantSpeed);
            if (speedHistoryRef.current.length > 5) {
              speedHistoryRef.current.shift();
            }

            const avgSpeed = speedHistoryRef.current.reduce((a, b) => a + b, 0) / speedHistoryRef.current.length;
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
        }
      );

      if (uploadError) {
        console.error("Upload error:", uploadError);
        setErrorMessage(uploadError.message);
        toast({
          title: t("common.error"),
          description: uploadError.message,
          variant: "destructive",
        });
        return;
      }

      setUploadProgress(75);
      setUploadStats(null);

      // Create import job
      const { data: job, error: jobError } = await supabase
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
        })
        .select()
        .single();

      if (jobError) {
        console.error("Job creation error:", jobError);
        setErrorMessage(t("dataIngestion.import.errors.jobCreationFailed"));
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.jobCreationFailed"),
          variant: "destructive",
        });
        return;
      }

      setUploadProgress(85);
      setUploadPhase("processing");

      // Trigger processing
      console.log("Invoking process-import for job:", job.id);
      const { error: processError } = await supabase.functions.invoke("process-import", {
        body: { job_id: job.id },
      });

      if (processError) {
        console.error("Process trigger error:", processError);
        // Don't fail - the job was created and might still process
        console.log("Note: Edge function may continue processing in background");
      }

      setUploadProgress(100);
      setUploadPhase("done");

      toast({
        title: t("dataIngestion.import.importStarted"),
        description: t("dataIngestion.import.importStartedDesc"),
      });

      onImportStarted();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Import error:", error);
      setErrorMessage(error.message || t("dataIngestion.import.errors.unexpected"));
      toast({
        title: t("common.error"),
        description: error.message || t("dataIngestion.import.errors.unexpected"),
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
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

          {/* Delimiter */}
          <div className="space-y-2">
            <Label>{t("dataIngestion.import.delimiter")}</Label>
            <Select value={delimiter} onValueChange={setDelimiter} disabled={isUploading}>
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
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              {uploadStats && uploadPhase === "uploading" && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{formatSpeed(uploadStats.speed)}</span>
                  <span>{formatETA(uploadStats.eta)}</span>
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
