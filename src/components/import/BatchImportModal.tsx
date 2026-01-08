import { useState, useCallback } from "react";
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
  Info
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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

const MAX_LARGE_IMPORT_GB = 10;

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
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>(
    initialFiles.map(f => ({ file: f, status: "pending" }))
  );

  const totalSizeBytes = batchFiles.reduce((sum, bf) => sum + bf.file.size, 0);
  const totalSizeGB = (totalSizeBytes / 1024 / 1024 / 1024).toFixed(2);
  const totalSizeMB = (totalSizeBytes / 1024 / 1024).toFixed(2);

  const formatFileSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
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

  const handleStartImport = async () => {
    if (batchFiles.length === 0) return;
    
    setIsUploading(true);
    setUploadProgress(0);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.notAuthenticated"),
          variant: "destructive",
        });
        return;
      }

      // Generate batch ID
      const batchId = crypto.randomUUID();
      const progressPerFile = 70 / batchFiles.length;
      let currentProgress = 0;

      // Upload each file
      for (let i = 0; i < batchFiles.length; i++) {
        const bf = batchFiles[i];
        
        setBatchFiles(prev => 
          prev.map((item, idx) => 
            idx === i ? { ...item, status: "uploading" } : item
          )
        );

        const storagePath = `${user.id}/${projectId}/${batchId}/${bf.file.name}`;
        
        const { error: uploadError } = await supabase.storage
          .from("big_imports")
          .upload(storagePath, bf.file, { upsert: true });

        if (uploadError) {
          console.error(`Upload error for ${bf.file.name}:`, uploadError);
          setBatchFiles(prev => 
            prev.map((item, idx) => 
              idx === i ? { ...item, status: "error", error: t("dataIngestion.import.errors.uploadFailed") } : item
            )
          );
          continue;
        }

        // Create import job for this file
        const { data: job, error: jobError } = await supabase
          .from("import_jobs")
          .insert({
            project_id: projectId,
            user_id: user.id,
            file_name: i === 0 ? datasetName : `${datasetName}_${i + 1}`,
            file_size_bytes: bf.file.size,
            storage_path: storagePath,
            delimiter,
            encoding,
            status: "pending",
            batch_id: batchId,
            batch_sequence: i + 1,
            is_batch_primary: i === 0,
          })
          .select()
          .single();

        if (jobError) {
          console.error(`Job creation error for ${bf.file.name}:`, jobError);
          setBatchFiles(prev => 
            prev.map((item, idx) => 
              idx === i ? { ...item, status: "error", error: t("dataIngestion.import.errors.jobCreationFailed") } : item
            )
          );
          continue;
        }

        setBatchFiles(prev => 
          prev.map((item, idx) => 
            idx === i ? { ...item, status: "uploaded", storagePathfile: storagePath } : item
          )
        );

        currentProgress += progressPerFile;
        setUploadProgress(Math.floor(currentProgress));
      }

      setUploadProgress(80);

      // Trigger batch processing (process primary file first, it will chain others)
      const { data: primaryJob } = await supabase
        .from("import_jobs")
        .select("id")
        .eq("batch_id", batchId)
        .eq("is_batch_primary", true)
        .single();

      if (primaryJob) {
        await supabase.functions.invoke("process-import", {
          body: { job_id: primaryJob.id, batch_id: batchId },
        });
      }

      setUploadProgress(100);

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
    }
  };

  const successCount = batchFiles.filter(bf => bf.status === "uploaded").length;
  const errorCount = batchFiles.filter(bf => bf.status === "error").length;
  const canStart = batchFiles.length > 0 && !isUploading && datasetName.trim();

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

          {/* Files list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("dataIngestion.batchImport.files")} ({batchFiles.length})</Label>
              <span className="text-sm text-muted-foreground">
                {Number(totalSizeGB) >= 1 ? `${totalSizeGB} GB` : `${totalSizeMB} MB`} {t("dataIngestion.batchImport.total")}
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

          {/* Upload progress */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>{t("dataIngestion.batchImport.uploading")}</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div 
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
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
                {t("dataIngestion.batchImport.uploading")}
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
