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
  AlertCircle,
  Layers
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
  is_batch_primary: boolean | null;
}

interface BatchGroup {
  batchId: string;
  jobs: ImportJob[];
  totalSize: number;
  totalRows: number;
  status: "pending" | "processing" | "completed" | "partial" | "failed";
  primaryJobName: string;
  createdAt: string;
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
        .limit(100);

      if (error) {
        console.error("Error fetching import jobs:", error);
        toast({
          title: t("common.error"),
          description: t("dataIngestion.import.errors.fetchJobsFailed"),
          variant: "destructive",
        });
        return;
      }

      const newJobs = (data || []) as ImportJob[];
      
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

  // Group jobs by batch
  const groupJobsByBatch = useCallback((): (BatchGroup | ImportJob)[] => {
    const batches = new Map<string, ImportJob[]>();
    const standalone: ImportJob[] = [];

    for (const job of jobs) {
      if (job.batch_id) {
        if (!batches.has(job.batch_id)) {
          batches.set(job.batch_id, []);
        }
        batches.get(job.batch_id)!.push(job);
      } else {
        standalone.push(job);
      }
    }

    const result: (BatchGroup | ImportJob)[] = [];

    // Process batches
    batches.forEach((batchJobs, batchId) => {
      // Sort by sequence
      batchJobs.sort((a, b) => (a.batch_sequence || 0) - (b.batch_sequence || 0));
      
      const totalSize = batchJobs.reduce((sum, j) => sum + j.file_size_bytes, 0);
      const totalRows = batchJobs.reduce((sum, j) => sum + (j.rows_processed || 0), 0);
      const primaryJob = batchJobs.find(j => j.is_batch_primary) || batchJobs[0];
      
      // Determine batch status
      let status: BatchGroup["status"] = "pending";
      const allCompleted = batchJobs.every(j => j.status === "completed");
      const allFailed = batchJobs.every(j => j.status === "failed");
      const anyProcessing = batchJobs.some(j => j.status === "processing");
      const anyFailed = batchJobs.some(j => j.status === "failed");
      const anyCompleted = batchJobs.some(j => j.status === "completed");

      if (allCompleted) {
        status = "completed";
      } else if (allFailed) {
        status = "failed";
      } else if (anyProcessing) {
        status = "processing";
      } else if (anyCompleted && anyFailed) {
        status = "partial";
      }

      result.push({
        batchId,
        jobs: batchJobs,
        totalSize,
        totalRows,
        status,
        primaryJobName: primaryJob.file_name,
        createdAt: primaryJob.created_at,
      });
    });

    // Add standalone jobs
    result.push(...standalone);

    // Sort by created_at descending
    result.sort((a, b) => {
      const dateA = 'createdAt' in a ? a.createdAt : a.created_at;
      const dateB = 'createdAt' in b ? b.createdAt : b.created_at;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    return result;
  }, [jobs]);

  const getStatusBadge = (status: string, progress?: number) => {
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
            {progress !== undefined ? `${progress}%` : t("dataIngestion.import.statusProcessing")}
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="destructive">
            <XCircle className="w-3 h-3 mr-1" />
            {t("dataIngestion.import.statusFailed")}
          </Badge>
        );
      case 'partial':
        return (
          <Badge variant="secondary" className="bg-orange-500/20 text-orange-700 dark:text-orange-400">
            <AlertCircle className="w-3 h-3 mr-1" />
            {t("dataIngestion.import.statusPartial") || "Partial"}
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

  const retryJob = async (jobId: string, batchId?: string | null) => {
    try {
      if (batchId) {
        // Reset all jobs in batch
        await supabase
          .from("import_jobs")
          .update({ status: 'pending', progress: 0, error_message: null })
          .eq('batch_id', batchId);
      } else {
        // Reset single job
        await supabase
          .from("import_jobs")
          .update({ status: 'pending', progress: 0, error_message: null })
          .eq('id', jobId);
      }

      // Trigger processing again
      await supabase.functions.invoke("process-import", {
        body: { job_id: jobId, batch_id: batchId },
      });

      toast({
        title: t("dataIngestion.import.retryStarted"),
        description: t("dataIngestion.import.retryStartedDesc"),
      });

      fetchJobs();
      startPolling();
    } catch (error) {
      console.error("Retry error:", error);
      toast({
        title: t("common.error"),
        description: t("dataIngestion.import.errors.retryFailed"),
        variant: "destructive",
      });
    }
  };

  const groupedItems = groupJobsByBatch();

  const isBatchGroup = (item: BatchGroup | ImportJob): item is BatchGroup => {
    return 'batchId' in item;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[650px]">
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

        <ScrollArea className="max-h-[450px]">
          {loading && jobs.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : groupedItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FileSpreadsheet className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>{t("dataIngestion.import.noJobs")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {groupedItems.map((item) => {
                if (isBatchGroup(item)) {
                  // Render batch group
                  return (
                    <div
                      key={item.batchId}
                      className="p-4 border border-border rounded-lg space-y-3"
                    >
                      {/* Batch header */}
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Layers className="w-4 h-4 text-primary" />
                            <p className="font-medium truncate">{item.primaryJobName}</p>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {item.jobs.length} {item.jobs.length === 1 
                              ? t("dataIngestion.batchImport.file") 
                              : t("dataIngestion.batchImport.filesPlural")} • {formatFileSize(item.totalSize)}
                            {item.totalRows > 0 && ` • ${item.totalRows.toLocaleString()} ${t("dataIngestion.import.rows")}`}
                          </p>
                        </div>
                        {getStatusBadge(item.status)}
                      </div>

                      {/* Progress for processing batches */}
                      {item.status === 'processing' && (
                        <div className="space-y-1">
                          {item.jobs.map((job) => (
                            job.status === 'processing' && (
                              <div key={job.id} className="space-y-1">
                                <div className="flex justify-between text-xs text-muted-foreground">
                                  <span>{job.file_name}</span>
                                  <span>{job.progress}%</span>
                                </div>
                                <div className="w-full bg-muted rounded-full h-1.5">
                                  <div 
                                    className="bg-primary h-1.5 rounded-full transition-all"
                                    style={{ width: `${job.progress}%` }}
                                  />
                                </div>
                              </div>
                            )
                          ))}
                        </div>
                      )}

                      {/* Files list for batch */}
                      <div className="space-y-1 pl-4 border-l-2 border-muted">
                        {item.jobs.map((job) => (
                          <div key={job.id} className="flex items-center justify-between text-sm py-1">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <span className="truncate text-muted-foreground">
                                {job.batch_sequence}. {job.file_name.replace(item.primaryJobName, '').replace(/^_part\d+$/, '') || job.file_name}
                              </span>
                              <span className="text-xs text-muted-foreground flex-shrink-0">
                                {formatFileSize(job.file_size_bytes)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              {job.status === 'completed' && <CheckCircle className="w-3 h-3 text-accent" />}
                              {job.status === 'failed' && <XCircle className="w-3 h-3 text-destructive" />}
                              {job.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
                              {job.status === 'pending' && <Clock className="w-3 h-3 text-muted-foreground" />}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Error messages */}
                      {item.jobs.filter(j => j.status === 'failed' && j.error_message).map((job) => (
                        <div key={`error-${job.id}`} className="flex items-start gap-2 p-2 bg-destructive/10 rounded text-sm">
                          <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="font-medium text-destructive">{job.file_name}:</p>
                            <p className="text-destructive/80">{job.error_message}</p>
                          </div>
                        </div>
                      ))}

                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {t("dataIngestion.import.createdAt")}: {format(new Date(item.createdAt), 'PPp', { locale: getDateLocale() })}
                        </span>
                        {(item.status === 'failed' || item.status === 'partial') && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const primaryJob = item.jobs.find(j => j.is_batch_primary);
                              if (primaryJob) {
                                retryJob(primaryJob.id, item.batchId);
                              }
                            }}
                          >
                            <RefreshCw className="w-3 h-3 mr-1" />
                            {t("dataIngestion.import.retry")}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                } else {
                  // Render standalone job
                  const job = item;
                  return (
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
                  );
                }
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default ImportJobsModal;
