import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import {
  Download,
  Loader2,
  AlertCircle,
  CheckCircle,
  Clock,
  FileSpreadsheet,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

interface ExportJob {
  id: string;
  export_type: string;
  status: string;
  file_url: string | null;
  file_size_bytes: number | null;
  rows_exported: number | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

interface ExportJobsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function ExportJobsModal({ open, onOpenChange, projectId }: ExportJobsModalProps) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadingJobId, setDownloadingJobId] = useState<string | null>(null);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('export_jobs')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      setJobs(data || []);
    } catch (error) {
      console.error('Error fetching export jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && projectId) {
      fetchJobs();
      const interval = setInterval(fetchJobs, 5000);
      return () => clearInterval(interval);
    }
  }, [open, projectId]);

  // ── Direct download via signed URL ────────────────────────────
  const handleDirectDownload = async (job: ExportJob) => {
    setDownloadingJobId(job.id);
    try {
      const { data, error } = await supabase.functions.invoke('get-signed-download-url', {
        body: { export_job_id: job.id },
      });

      if (error) throw error;

      if (data?.signed_url) {
        // Open signed URL directly — browser handles the download
        window.open(data.signed_url, "_blank");

        if (data.signed_url_generation_ms) {
          console.log(
            `[download] direct_storage | signed_url generated in ${data.signed_url_generation_ms}ms`
          );
        }
      } else {
        throw new Error(data?.error || "Falha ao gerar URL de download");
      }
    } catch (err: any) {
      console.error("Direct download failed, falling back to stored URL:", err);

      // Fallback: use the pre-stored file_url (old behavior)
      if (job.file_url) {
        window.open(job.file_url, "_blank");
        console.log("[download] api_proxy (fallback) | reason:", err.message);
      } else {
        toast.error("Download falhou", {
          description: err.message || "Não foi possível gerar o link de download.",
        });
      }
    } finally {
      setDownloadingJobId(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-accent" />;
      case 'running':
        return <Loader2 className="h-4 w-4 text-primary animate-spin" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      completed: "default",
      running: "secondary",
      failed: "destructive",
      pending: "outline",
    };
    return (
      <Badge variant={variants[status] || "outline"}>
        {t(`export.status.${status}`, status)}
      </Badge>
    );
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const getExportTypeLabel = (type: string) => {
    return t(`export.types.${type}`, type);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {t('export.jobsTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('export.jobsDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end mb-2">
          <Button variant="ghost" size="sm" onClick={fetchJobs} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            {t('common.retry')}
          </Button>
        </div>

        <ScrollArea className="max-h-[400px]">
          {jobs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {loading ? (
                <Loader2 className="h-6 w-6 animate-spin mx-auto" />
              ) : (
                <p>{t('export.noJobs')}</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="p-4 border rounded-lg bg-card hover:bg-accent/5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      {getStatusIcon(job.status)}
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {getExportTypeLabel(job.export_type)}
                          </span>
                          {getStatusBadge(job.status)}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {format(new Date(job.created_at), 'dd/MM/yyyy HH:mm')}
                        </p>
                        {job.status === 'completed' && job.rows_exported && (
                          <p className="text-sm text-muted-foreground">
                            {job.rows_exported.toLocaleString()} {t('export.rows')} • {formatFileSize(job.file_size_bytes)}
                          </p>
                        )}
                        {job.status === 'failed' && job.error_message && (
                          <p className="text-sm text-destructive">{job.error_message}</p>
                        )}
                      </div>
                    </div>

                    {job.status === 'completed' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDirectDownload(job)}
                        disabled={downloadingJobId === job.id}
                      >
                        {downloadingJobId === job.id ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4 mr-1" />
                        )}
                        {t('export.download')}
                      </Button>
                    )}

                    {job.status === 'running' && (
                      <Badge variant="secondary" className="animate-pulse">
                        {t('export.processing')}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
