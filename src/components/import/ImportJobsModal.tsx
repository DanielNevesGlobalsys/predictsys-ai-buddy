import { useState, useEffect, useCallback, useRef } from "react";
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
import { 
  Loader2, 
  CheckCircle, 
  XCircle, 
  Clock, 
  FileSpreadsheet,
  RefreshCw,
  AlertCircle
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR, enUS, es } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";

interface ImportJob {
  id: string;
  file_name: string;
  file_size_bytes: number;
  status: string;
  progress: number;
  rows_processed: number | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  batch_id: string | null;
  batch_sequence: number | null;
}

interface ImportJobsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onJobCompleted?: () => void;
}

const POLLING_INTERVAL = 5000; // 5 seconds

const ImportJobsModal = ({
  open,
  onOpenChange,
  projectId,
  onJobCompleted,
}: ImportJobsModalProps) => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const previousJobsRef = useRef<ImportJob[]>([]);

  const getDateLocale = () => {
    switch (i18n.language) {
      case 'pt': return ptBR;
      case 'es': return es;
      default: return enUS;
    }
  };

  const fetchJobs = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setIsRefreshing(true);
    
    try {
      const { data, error } = await supabase
        .from("import_jobs")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        console.error("Error fetching import jobs:", error);
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.fetchJobsFailed"),
          variant: "destructive",
        });
        return;
      }

      const newJobs = data || [];
      
      // Check if any job completed that was previously processing
      const previouslyProcessing = previousJobsRef.current.filter(
        j => j.status === 'processing' || j.status === 'pending'
      );
      const nowCompleted = newJobs.filter(j => 
        j.status === 'completed' && 
        previouslyProcessing.some(p => p.id === j.id)
      );
      
      if (nowCompleted.length > 0 && onJobCompleted) {
        onJobCompleted();
      }
      
      previousJobsRef.current = newJobs;
      setJobs(newJobs);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [projectId, onJobCompleted, t, toast]);

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Start polling if there are active jobs
  const startPolling = useCallback(() => {
    stopPolling();
    
    pollingRef.current = setInterval(() => {
      // Check current jobs state using ref to avoid stale closure
      const hasActiveJobs = previousJobsRef.current.some(
        j => j.status === 'pending' || j.status === 'processing'
      );
      
      if (hasActiveJobs) {
        fetchJobs(false);
      } else {
        stopPolling();
      }
    }, POLLING_INTERVAL);
  }, [fetchJobs, stopPolling]);

  // Initial fetch when modal opens
  useEffect(() => {
    if (open && projectId) {
      fetchJobs(true).then(() => {
        startPolling();
      });
    } else {
      stopPolling();
      setJobs([]);
      previousJobsRef.current = [];
    }

    return () => {
      stopPolling();
    };
  }, [open, projectId, fetchJobs, startPolling, stopPolling]);

  // Restart polling when jobs change and there are active ones
  useEffect(() => {
    if (!open) return;
    
    const hasActiveJobs = jobs.some(
      j => j.status === 'pending' || j.status === 'processing'
    );
    
    if (hasActiveJobs && !pollingRef.current) {
      startPolling();
    } else if (!hasActiveJobs) {
      stopPolling();
    }
  }, [jobs, open, startPolling, stopPolling]);

  const handleManualRefresh = () => {
    fetchJobs(false);
    // Restart polling after manual refresh
    const hasActiveJobs = jobs.some(
      j => j.status === 'pending' || j.status === 'processing'
    );
    if (hasActiveJobs) {
      startPolling();
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  const getStatusBadge = (status: string, progress: number) => {
    switch (status) {
      case 'completed':
        return (
          <Badge variant="default" className="bg-accent text-accent-foreground">
            <CheckCircle className="w-3 h-3 mr-1" />
            {t("dataIngestion.import.statusCompleted")}
          </Badge>
        );
      case 'processing':
        return (
          <Badge variant="secondary">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            {progress}%
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="destructive">
            <XCircle className="w-3 h-3 mr-1" />
            {t("dataIngestion.import.statusFailed")}
          </Badge>
        );
      default:
        return (
          <Badge variant="outline">
            <Clock className="w-3 h-3 mr-1" />
            {t("dataIngestion.import.statusPending")}
          </Badge>
        );
    }
  };

  const retryJob = async (jobId: string) => {
    try {
      // Reset job to pending
      await supabase
        .from("import_jobs")
        .update({ status: 'pending', progress: 0, error_message: null })
        .eq('id', jobId);

      // Trigger processing again
      await supabase.functions.invoke("process-import", {
        body: { job_id: jobId },
      });

      toast({
        title: t("dataIngestion.import.retryStarted"),
        description: t("dataIngestion.import.retryStartedDesc"),
      });

      fetchJobs();
    } catch (error) {
      console.error("Retry error:", error);
      toast({
        title: t("common.error"),
        description: t("dataIngestion.import.errors.retryFailed"),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5" />
            {t("dataIngestion.import.jobsTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("dataIngestion.import.jobsDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end mb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleManualRefresh}
            disabled={loading || isRefreshing}
          >
            <RefreshCw className={`w-4 h-4 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t("common.refresh")}
          </Button>
        </div>

        <ScrollArea className="max-h-[400px]">
          {loading && jobs.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FileSpreadsheet className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>{t("dataIngestion.import.noJobs")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="p-4 border border-border rounded-lg space-y-2"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{job.file_name}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatFileSize(job.file_size_bytes)}
                        {job.rows_processed && ` • ${job.rows_processed.toLocaleString()} ${t("dataIngestion.import.rows")}`}
                      </p>
                    </div>
                    {getStatusBadge(job.status, job.progress)}
                  </div>

                  {/* Progress bar for processing jobs */}
                  {job.status === 'processing' && (
                    <div className="w-full bg-muted rounded-full h-2">
                      <div 
                        className="bg-primary h-2 rounded-full transition-all"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  )}

                  {/* Error message */}
                  {job.status === 'failed' && job.error_message && (
                    <div className="flex items-start gap-2 p-2 bg-destructive/10 rounded text-sm">
                      <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                      <p className="text-destructive">{job.error_message}</p>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {t("dataIngestion.import.createdAt")}: {format(new Date(job.created_at), 'PPp', { locale: getDateLocale() })}
                    </span>
                    {job.finished_at && (
                      <span>
                        {t("dataIngestion.import.finishedAt")}: {format(new Date(job.finished_at), 'PPp', { locale: getDateLocale() })}
                      </span>
                    )}
                  </div>

                  {/* Retry button for failed jobs */}
                  {job.status === 'failed' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => retryJob(job.id)}
                      className="mt-2"
                    >
                      <RefreshCw className="w-4 h-4 mr-1" />
                      {t("dataIngestion.import.retry")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default ImportJobsModal;
