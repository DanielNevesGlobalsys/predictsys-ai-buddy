import { useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildSafeObjectName } from "@/lib/storageObjectName";

interface UseAsyncImportOptions {
  projectId: string | undefined;
  onCompleted: () => void;
}

interface UploadStats {
  speed: number;
  eta: number;
  bytesUploaded: number;
  totalBytes: number;
}

const POLL_INTERVAL_MS = 1500;

export function useAsyncImport({ projectId, onCompleted }: UseAsyncImportOptions) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<"idle" | "uploading" | "processing" | "done">("idle");
  const [uploadStats, setUploadStats] = useState<UploadStats | null>(null);
  const [serverProgress, setServerProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const lastBytesRef = useRef(0);
  const lastTimeRef = useRef(Date.now());
  const speedHistoryRef = useRef<number[]>([]);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const startProgressPolling = useCallback((jobId: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
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
          onCompleted();
          return;
        }

        if (job.status === "failed") {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setErrorMessage(job.error_message || "Import failed");
          setIsUploading(false);
          return;
        }

        const progress = job.progress || 0;
        setServerProgress(progress);
        const uiProgress = 75 + Math.round(progress * 0.24);
        setUploadProgress(Math.min(99, Math.max(75, uiProgress)));
      } catch (err) {
        console.warn("[useAsyncImport] Polling error:", err);
      }
    };

    poll();
    pollIntervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [onCompleted]);

  const uploadFileWithProgress = useCallback(
    async (
      file: File,
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
          const apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
          const encodedPath = storagePath
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/");
          const url = `${supabaseUrl}/storage/v1/object/big_imports/${encodedPath}`;

          const xhr = new XMLHttpRequest();

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress(event.loaded, event.total);
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve({ error: null });
            } else {
              let msg = `Upload failed: ${xhr.status}`;
              try {
                const resp = JSON.parse(xhr.responseText);
                if (resp.message) msg = resp.message;
                if (resp.error) msg = resp.error;
              } catch { /* keep default */ }
              resolve({ error: new Error(msg) });
            }
          };

          xhr.onerror = () => resolve({ error: new Error("Network error during upload") });
          xhr.ontimeout = () => resolve({ error: new Error("Upload timed out") });

          xhr.open("POST", url, true);
          xhr.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
          xhr.setRequestHeader("apikey", apiKey);
          xhr.setRequestHeader("x-upsert", "true");
          xhr.timeout = 0;
          xhr.send(file);
        } catch (err) {
          resolve({ error: err instanceof Error ? err : new Error("Unknown error") });
        }
      });
    },
    []
  );

  const startImport = useCallback(
    async (
      file: File,
      options: { delimiter: string; encoding: string; datasetName: string }
    ) => {
      if (!projectId) return;

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
          setErrorMessage("Not authenticated");
          setIsUploading(false);
          return;
        }

        const storageObjectName = buildSafeObjectName(file.name);
        const storagePath = `${user.id}/${projectId}/${storageObjectName}`;

        // Create import job
        const { data: createdJob, error: jobError } = await supabase
          .from("import_jobs")
          .insert({
            project_id: projectId,
            user_id: user.id,
            file_name: options.datasetName,
            file_size_bytes: file.size,
            storage_path: storagePath,
            delimiter: options.delimiter,
            encoding: options.encoding,
            status: "pending",
            progress: 0,
          })
          .select("id")
          .single();

        if (jobError || !createdJob) {
          console.error("Job creation error:", jobError);
          setErrorMessage("Failed to create import job");
          setIsUploading(false);
          return;
        }

        const jobId = createdJob.id;

        // Upload with real progress (0-70%)
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
              if (speedHistoryRef.current.length > 5) speedHistoryRef.current.shift();

              const avgSpeed =
                speedHistoryRef.current.reduce((a, b) => a + b, 0) /
                speedHistoryRef.current.length;
              const bytesRemaining = total - loaded;
              const eta = avgSpeed > 0 ? bytesRemaining / avgSpeed : 0;

              setUploadStats({ bytesUploaded: loaded, totalBytes: total, speed: avgSpeed, eta });
              lastBytesRef.current = loaded;
              lastTimeRef.current = now;
            }

            setUploadProgress(Math.floor((loaded / total) * 70));
          }
        );

        if (uploadError) {
          await supabase
            .from("import_jobs")
            .update({
              status: "failed",
              error_message: uploadError.message,
              finished_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          setErrorMessage(uploadError.message);
          setIsUploading(false);
          return;
        }

        // Mark ready for processing
        await supabase
          .from("import_jobs")
          .update({ status: "pending", progress: 0, error_message: null })
          .eq("id", jobId);

        setUploadProgress(70);
        setUploadStats(null);
        setUploadPhase("processing");

        // Start polling
        startProgressPolling(jobId);

        // Trigger processing
        console.log("[useAsyncImport] Invoking process-import for job:", jobId);
        const { error: processError } = await supabase.functions.invoke(
          "process-import",
          { body: { job_id: jobId } }
        );

        setUploadProgress(75);

        if (processError) {
          console.error("[useAsyncImport] Process trigger error:", processError);
          // Don't fail - polling will detect actual status
        }
      } catch (error: any) {
        console.error("[useAsyncImport] Import error:", error);
        setErrorMessage(error.message || "Import failed");
        setIsUploading(false);
      }
    },
    [projectId, uploadFileWithProgress, startProgressPolling]
  );

  const reset = useCallback(() => {
    setIsUploading(false);
    setUploadProgress(0);
    setUploadPhase("idle");
    setUploadStats(null);
    setServerProgress(0);
    setErrorMessage(null);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    jobIdRef.current = null;
  }, []);

  return {
    startImport,
    isUploading,
    uploadProgress,
    uploadPhase,
    uploadStats,
    serverProgress,
    errorMessage,
    reset,
  };
}
