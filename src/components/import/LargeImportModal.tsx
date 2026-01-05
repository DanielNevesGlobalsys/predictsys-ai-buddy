import { useState } from "react";
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

const MAX_LARGE_IMPORT_GB = 10; // 10 GB max

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

  const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
  const fileSizeGB = (file.size / 1024 / 1024 / 1024).toFixed(2);

  const handleStartImport = async () => {
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

      // Upload file to big_imports bucket
      const storagePath = `${user.id}/${projectId}/${file.name}`;
      
      setUploadProgress(10);
      
      const { error: uploadError } = await supabase.storage
        .from("big_imports")
        .upload(storagePath, file, {
          upsert: true,
        });

      if (uploadError) {
        console.error("Upload error:", uploadError);
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.uploadFailed"),
          variant: "destructive",
        });
        return;
      }

      setUploadProgress(70);

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
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.jobCreationFailed"),
          variant: "destructive",
        });
        return;
      }

      setUploadProgress(90);

      // Trigger processing
      const { error: processError } = await supabase.functions.invoke("process-import", {
        body: { job_id: job.id },
      });

      if (processError) {
        console.error("Process trigger error:", processError);
        // Job was created, processing will be picked up
      }

      setUploadProgress(100);

      toast({
        title: t("dataIngestion.import.importStarted"),
        description: t("dataIngestion.import.importStartedDesc"),
      });

      onImportStarted();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Import error:", error);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            {t("dataIngestion.import.largeImportTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("dataIngestion.import.largeImportDesc")}
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
            />
          </div>

          {/* Delimiter */}
          <div className="space-y-2">
            <Label>{t("dataIngestion.import.delimiter")}</Label>
            <Select value={delimiter} onValueChange={setDelimiter}>
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
            <Select value={encoding} onValueChange={setEncoding}>
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

          {/* Upload progress */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>{t("dataIngestion.import.uploading")}</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div 
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
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
                {t("dataIngestion.import.uploading")}
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
