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
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  Loader2, 
  CheckCircle, 
  XCircle, 
  Clock, 
  FileSpreadsheet,
  RefreshCw,
  AlertCircle,
  Layers,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Play,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { ptBR, es } from "date-fns/locale";
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
  phase: string | null;
  total_files: number | null;
  processed_files: number | null;
  bytes_total: number | null;
  bytes_done: number | null;
}

interface QualityReason {
  code: string;
  message: string;
  severity: string;
}

interface ImportJobFile {
  id: string;
  job_id: string;
  file_name: string;
  storage_path: string;
  file_size_bytes: number;
  format: string;
  sequence_index: number;
  status: string;
  rows_detected: number | null;
  cols_detected: number | null;
  quality_gate: string;
  quality_reasons: QualityReason[] | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  started_at: string | null;
  finished_at: string | null;
}

interface BatchGroup {
  batchId: string;
  jobs: ImportJob[];
  files: ImportJobFile[];
  totalSize: number;
  totalRows: number;
  status: "pending" | "processing" | "completed" | "partial" | "failed";
  primaryJob: ImportJob;
  createdAt: string;
  phase: string | null;
}

interface ImportJobsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onJobCompleted?: () => void;
}

const POLLING_INTERVAL = 2000;

const ImportJobsModal = ({
  open,
  onOpenChange,
  projectId,
  onJobCompleted,
}: ImportJobsModalProps) => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobFiles, setJobFiles] = useState<ImportJobFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousJobsRef = useRef<ImportJob[]>([]);

  const getDateLocale = () => {
    switch (i18n.language) {
      case 'pt': return ptBR;
      case 'es': return es;
      default: return undefined;
    }
  };

  const fetchJobs = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setIsRefreshing(true);
    
    try {
      // Fetch jobs and job files in parallel
      const [jobsRes, filesRes] = await Promise.all([
        supabase
          .from("import_jobs")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("import_job_files")
          .select("*")
          .eq("project_id", projectId)
          .order("sequence_index", { ascending: true })
          .limit(500),
      ]);

      if (jobsRes.error) {
        console.error("Error fetching import jobs:", jobsRes.error);
        return;
      }

      const newJobs = (jobsRes.data || []) as ImportJob[];
      const newFiles = (filesRes.data || []) as unknown as ImportJobFile[];
      
      // Check if any job completed
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
      setJobFiles(newFiles);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [projectId, onJobCompleted]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = setInterval(() => {
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

  useEffect(() => {
    if (open && projectId) {
      fetchJobs(true).then(() => startPolling());
    } else {
      stopPolling();
      setJobs([]);
      setJobFiles([]);
      previousJobsRef.current = [];
    }
    return () => stopPolling();
  }, [open, projectId, fetchJobs, startPolling, stopPolling]);

  useEffect(() => {
    if (!open) return;
    const hasActiveJobs = jobs.some(j => j.status === 'pending' || j.status === 'processing');
    if (hasActiveJobs && !pollingRef.current) {
      startPolling();
    } else if (!hasActiveJobs) {
      stopPolling();
    }
  }, [jobs, open, startPolling, stopPolling]);

  const handleManualRefresh = () => {
    fetchJobs(false);
    const hasActiveJobs = jobs.some(j => j.status === 'pending' || j.status === 'processing');
    if (hasActiveJobs) startPolling();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  const toggleBatch = (batchId: string) => {
    setExpandedBatches(prev => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  // Group jobs by batch, enriching with import_job_files
  const groupJobsByBatch = useCallback((): (BatchGroup | ImportJob)[] => {
    const batches = new Map<string, ImportJob[]>();
    const standalone: ImportJob[] = [];

    for (const job of jobs) {
      if (job.batch_id) {
        if (!batches.has(job.batch_id)) batches.set(job.batch_id, []);
        batches.get(job.batch_id)!.push(job);
      } else {
        standalone.push(job);
      }
    }

    const result: (BatchGroup | ImportJob)[] = [];

    batches.forEach((batchJobs, batchId) => {
      batchJobs.sort((a, b) => (a.batch_sequence || 0) - (b.batch_sequence || 0));
      const primaryJob = batchJobs.find(j => j.is_batch_primary) || batchJobs[0];
      const totalSize = batchJobs.reduce((sum, j) => sum + j.file_size_bytes, 0);
      const totalRows = batchJobs.reduce((sum, j) => sum + (j.rows_processed || 0), 0);

      // Get import_job_files for this batch (linked to primary job)
      const batchFiles = jobFiles.filter(f => f.job_id === primaryJob.id);

      let status: BatchGroup["status"] = "pending";
      if (batchFiles.length > 0) {
        const allCompleted = batchFiles.every(f => f.status === "completed");
        const allFailed = batchFiles.every(f => f.status === "failed");
        const anyProcessing = batchFiles.some(f => f.status === "processing");
        const anyCompleted = batchFiles.some(f => f.status === "completed");
        const anyFailed = batchFiles.some(f => f.status === "failed");

        if (allCompleted) status = "completed";
        else if (allFailed) status = "failed";
        else if (anyProcessing) status = "processing";
        else if (anyCompleted && anyFailed) status = "partial";
        else if (primaryJob.status === "completed") status = "completed";
      } else {
        // Fallback to legacy logic
        const allCompleted = batchJobs.every(j => j.status === "completed");
        const allFailed = batchJobs.every(j => j.status === "failed");
        const anyProcessing = batchJobs.some(j => j.status === "processing");
        const anyCompleted = batchJobs.some(j => j.status === "completed");
        const anyFailed = batchJobs.some(j => j.status === "failed");

        if (allCompleted) status = "completed";
        else if (allFailed) status = "failed";
        else if (anyProcessing) status = "processing";
        else if (anyCompleted && anyFailed) status = "partial";
      }

      result.push({
        batchId,
        jobs: batchJobs,
        files: batchFiles,
        totalSize,
        totalRows,
        status,
        primaryJob,
        createdAt: primaryJob.created_at,
        phase: primaryJob.phase,
      });
    });

    result.push(...standalone);

    result.sort((a, b) => {
      const dateA = 'createdAt' in a ? a.createdAt : a.created_at;
      const dateB = 'createdAt' in b ? b.createdAt : b.created_at;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    return result;
  }, [jobs, jobFiles]);

  const getStatusBadge = (status: string, progress?: number) => {
    switch (status) {
      case 'completed':
        return (
          <Badge variant="default" className="bg-accent text-accent-foreground">
            <CheckCircle className="w-3 h-3 mr-1" />
            {t("dataIngestion.import.statusCompleted")} ✓
          </Badge>
        );
      case 'processing':
        return (
          <Badge variant="secondary">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            {(progress ?? 0) > 0 ? `${progress}%` : t("dataIngestion.import.statusProcessing")}
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
          <Badge variant="secondary" className="bg-warning/20 text-warning-foreground">
            <AlertCircle className="w-3 h-3 mr-1" />
            Parcial
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

  const getQualityGateIcon = (gate: string) => {
    switch (gate) {
      case 'approved':
        return <ShieldCheck className="w-3.5 h-3.5 text-accent" />;
      case 'warn':
        return <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground" />;
      case 'blocked':
        return <ShieldX className="w-3.5 h-3.5 text-destructive" />;
      default:
        return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
    }
  };

  const getFileStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-3.5 h-3.5 text-accent" />;
      case 'failed': return <XCircle className="w-3.5 h-3.5 text-destructive" />;
      case 'processing': return <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />;
      default: return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
    }
  };

  const retryJob = async (jobId: string, batchId?: string | null) => {
    try {
      if (batchId) {
        // Reset failed files back to pending
        await supabase
          .from("import_job_files")
          .update({ status: 'pending', error_code: null, error_message: null, retry_count: 0 })
          .eq('job_id', jobId)
          .eq('status', 'failed');

        // Reset primary job
        await supabase
          .from("import_jobs")
          .update({ status: 'processing', phase: 'ingest', progress: 0, error_message: null })
          .eq('id', jobId);
      } else {
        await supabase
          .from("import_jobs")
          .update({ status: 'pending', progress: 0, error_message: null })
          .eq('id', jobId);
      }

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

  const resumePending = async (primaryJob: ImportJob) => {
    try {
      // Simply re-invoke — the function will find the next pending file
      await supabase.functions.invoke("process-import", {
        body: { job_id: primaryJob.id, batch_id: primaryJob.batch_id },
      });

      toast({
        title: "Retomando importação",
        description: "Processamento dos arquivos pendentes reiniciado.",
      });

      fetchJobs();
      startPolling();
    } catch (error) {
      console.error("Resume error:", error);
      toast({ title: t("common.error"), description: "Falha ao retomar.", variant: "destructive" });
    }
  };

  const groupedItems = groupJobsByBatch();
  const isBatchGroup = (item: BatchGroup | ImportJob): item is BatchGroup => 'batchId' in item;

  // ─── Render helpers ───

  const renderFileRow = (file: ImportJobFile) => {
    const hasReasons = file.quality_reasons && file.quality_reasons.length > 0;
    const reasonsText = hasReasons
      ? file.quality_reasons!.map(r => r.message).join("\n")
      : "";

    return (
      <div key={file.id} className="flex items-center gap-2 py-1.5 text-sm">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {getFileStatusIcon(file.status)}
          <span className="truncate text-muted-foreground">{file.file_name}</span>
          <span className="text-xs text-muted-foreground/60 flex-shrink-0">
            {formatFileSize(file.file_size_bytes)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {file.rows_detected && file.rows_detected > 0 && (
            <span className="text-xs text-muted-foreground">{file.rows_detected.toLocaleString()} rows</span>
          )}
          {file.quality_gate && file.quality_gate !== 'pending' && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">{getQualityGateIcon(file.quality_gate)}</span>
                </TooltipTrigger>
                {hasReasons && (
                  <TooltipContent side="left" className="max-w-xs">
                    <div className="space-y-1 text-xs">
                      {file.quality_reasons!.map((r, i) => (
                        <div key={i} className="flex items-start gap-1">
                          <span className={r.severity === 'error' ? 'text-destructive' : r.severity === 'warn' ? 'text-orange-500' : 'text-muted-foreground'}>
                            {r.severity === 'error' ? '✗' : r.severity === 'warn' ? '⚠' : '✓'}
                          </span>
                          <span>{r.message}</span>
                        </div>
                      ))}
                    </div>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    );
  };

  const renderBatchGroup = (batch: BatchGroup) => {
    const isExpanded = expandedBatches.has(batch.batchId);
    const hasFiles = batch.files.length > 0;
    const completedFiles = batch.files.filter(f => f.status === 'completed').length;
    const failedFiles = batch.files.filter(f => f.status === 'failed').length;
    const pendingFiles = batch.files.filter(f => f.status === 'pending').length;
    const totalFiles = hasFiles ? batch.files.length : batch.jobs.length;
    const processedCount = hasFiles ? completedFiles + failedFiles : (batch.primaryJob.processed_files || 0);
    const overallProgress = totalFiles > 0 ? Math.round((processedCount / totalFiles) * 100) : 0;

    const isActive = batch.status === 'processing' || batch.status === 'pending';
    const canResume = pendingFiles > 0 && !isActive && completedFiles > 0;
    const canRetry = (batch.status === 'failed' || batch.status === 'partial') && failedFiles > 0;
    const phaseLabel = batch.phase === 'consolidate' ? 'Consolidando...' : batch.phase === 'ingest' ? `Processando ${processedCount}/${totalFiles}` : null;

    return (
      <div key={batch.batchId} className="border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div
          className="p-4 cursor-pointer hover:bg-muted/30 transition-colors"
          onClick={() => toggleBatch(batch.batchId)}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
              <Layers className="w-4 h-4 text-primary flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-medium truncate">{batch.primaryJob.file_name}</p>
                <p className="text-sm text-muted-foreground">
                  {totalFiles} arquivo{totalFiles !== 1 ? 's' : ''} • {formatFileSize(batch.totalSize)}
                  {batch.totalRows > 0 && ` • ${batch.totalRows.toLocaleString()} linhas`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {phaseLabel && isActive && (
                <span className="text-xs text-primary font-medium">{phaseLabel}</span>
              )}
              {getStatusBadge(batch.status, batch.primaryJob.progress || overallProgress)}
            </div>
          </div>

          {/* Overall progress bar */}
          {isActive && (
            <div className="mt-3 ml-10">
              <Progress value={batch.primaryJob.progress || overallProgress} className="h-2" />
              <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                <span>{completedFiles} completo{completedFiles !== 1 ? 's' : ''}{failedFiles > 0 && `, ${failedFiles} falha${failedFiles !== 1 ? 's' : ''}`}</span>
                <span>{batch.primaryJob.progress || overallProgress}%</span>
              </div>
            </div>
          )}
        </div>

        {/* Expanded files list */}
        {isExpanded && (
          <div className="border-t border-border bg-muted/10 px-4 py-3 space-y-0.5">
            {hasFiles ? (
              <>
                {batch.files.map(renderFileRow)}

                {/* Error details */}
                {batch.files.filter(f => f.status === 'failed' && f.error_message).map(file => (
                  <div key={`err-${file.id}`} className="flex items-start gap-2 p-2 mt-2 bg-destructive/10 rounded text-sm">
                    <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-destructive">{file.file_name}:</p>
                      <p className="text-destructive/80 text-xs">{file.error_message}</p>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              // Legacy: show jobs list
              batch.jobs.map(job => (
                <div key={job.id} className="flex items-center justify-between text-sm py-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {getFileStatusIcon(job.status)}
                    <span className="truncate text-muted-foreground">{job.file_name}</span>
                    <span className="text-xs text-muted-foreground/60">{formatFileSize(job.file_size_bytes)}</span>
                  </div>
                </div>
              ))
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2 pt-3 mt-2 border-t border-border/50">
              <span className="text-xs text-muted-foreground flex-1">
                {format(new Date(batch.createdAt), 'PPp', { locale: getDateLocale() })}
              </span>
              {canResume && (
                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); resumePending(batch.primaryJob); }}>
                  <Play className="w-3 h-3 mr-1" />
                  Retomar
                </Button>
              )}
              {canRetry && (
                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); retryJob(batch.primaryJob.id, batch.batchId); }}>
                  <RefreshCw className="w-3 h-3 mr-1" />
                  {t("dataIngestion.import.retry")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderStandaloneJob = (job: ImportJob) => (
    <div key={job.id} className="p-4 border border-border rounded-lg space-y-2">
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

      {(job.status === 'processing' || job.status === 'pending') && (
        <Progress value={job.status === 'pending' ? 5 : (job.progress || 0)} className="h-2" />
      )}

      {job.status === 'failed' && job.error_message && (
        <div className="flex items-start gap-2 p-2 bg-destructive/10 rounded text-sm">
          <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-destructive">{job.error_message}</p>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{format(new Date(job.created_at), 'PPp', { locale: getDateLocale() })}</span>
        {job.finished_at && <span>{format(new Date(job.finished_at), 'PPp', { locale: getDateLocale() })}</span>}
      </div>

      {job.status === 'failed' && (
        <Button variant="outline" size="sm" onClick={() => retryJob(job.id)} className="mt-2">
          <RefreshCw className="w-4 h-4 mr-1" />
          {t("dataIngestion.import.retry")}
        </Button>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
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
          <Button variant="ghost" size="sm" onClick={handleManualRefresh} disabled={loading || isRefreshing}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t("common.refresh")}
          </Button>
        </div>

        <ScrollArea className="max-h-[500px]">
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
              {groupedItems.map((item) =>
                isBatchGroup(item)
                  ? renderBatchGroup(item)
                  : renderStandaloneJob(item)
              )}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default ImportJobsModal;
