import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Bug, Loader2, CheckCircle, AlertTriangle, XCircle } from "lucide-react";

interface AdminManifestDebugModalProps {
  projectId: string;
}

interface ManifestRow {
  id: string;
  created_at: string;
  batch_id: string | null;
  dataset_id: string | null;
  status: string;
  total_files: number;
  rows_sum: number;
  rows_consolidated: number;
  columns_final: number;
  status_reason: string | null;
  canonical_schema: unknown;
  null_diagnostic: unknown;
}

interface JobRow {
  id: string;
  created_at: string;
  file_name: string;
  status: string;
  rows_processed: number | null;
  batch_id: string | null;
  dataset_id: string | null;
  error_message: string | null;
}

const AdminManifestDebugModal = ({ projectId }: AdminManifestDebugModalProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [manifests, setManifests] = useState<ManifestRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const checkAndLoad = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setIsAdmin(false); return; }

      // Check if user is admin/super_admin
      const { data: orgUser } = await supabase
        .from("organization_users")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["org_admin", "super_admin"])
        .limit(1);

      if (!orgUser || orgUser.length === 0) {
        setIsAdmin(false);
        return;
      }
      setIsAdmin(true);

      // Load manifests and jobs in parallel
      const [manifestRes, jobRes] = await Promise.all([
        supabase
          .from("import_manifests")
          .select("id, created_at, batch_id, dataset_id, status, total_files, rows_sum, rows_consolidated, columns_final, status_reason, canonical_schema, null_diagnostic")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("import_jobs")
          .select("id, created_at, file_name, status, rows_processed, batch_id, dataset_id, error_message")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);

      setManifests((manifestRes.data || []) as unknown as ManifestRow[]);
      setJobs((jobRes.data || []) as unknown as JobRow[]);
    } catch (e) {
      console.error("[AdminDebug] Error:", e);
    } finally {
      setLoading(false);
    }
  };

  const statusIcon = (s: string) => {
    if (s === "ok" || s === "completed") return <CheckCircle className="w-3.5 h-3.5 text-green-500" />;
    if (s === "warn" || s === "processing" || s === "pending") return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
    return <XCircle className="w-3.5 h-3.5 text-destructive" />;
  };

  const truncateJson = (obj: unknown) => {
    const str = JSON.stringify(obj, null, 2);
    return str.length > 500 ? str.slice(0, 500) + "\n..." : str;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) checkAndLoad(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Bug className="w-4 h-4" />
          Verificar Import Manifest
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="w-5 h-5" />
            Debug: Import Manifests & Jobs
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        )}

        {isAdmin === false && !loading && (
          <p className="text-sm text-muted-foreground py-4">
            Acesso restrito a administradores.
          </p>
        )}

        {isAdmin && !loading && (
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-6">
              {/* Manifests */}
              <div>
                <h4 className="font-semibold text-sm mb-2">
                  Import Manifests ({manifests.length})
                </h4>
                {manifests.length === 0 ? (
                  <p className="text-sm text-muted-foreground bg-muted/30 p-3 rounded">
                    Nenhum manifesto encontrado para este projeto.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {manifests.map((m) => (
                      <div key={m.id} className="border rounded-lg p-3 space-y-2 text-xs">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {statusIcon(m.status)}
                            <Badge variant="outline" className="text-[10px]">{m.status.toUpperCase()}</Badge>
                            <span className="font-mono text-muted-foreground">{m.id.slice(0, 8)}...</span>
                          </div>
                          <span className="text-muted-foreground">{new Date(m.created_at).toLocaleString()}</span>
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          <div className="bg-muted/30 p-2 rounded text-center">
                            <p className="font-bold">{m.total_files}</p>
                            <p className="text-muted-foreground">Arquivos</p>
                          </div>
                          <div className="bg-muted/30 p-2 rounded text-center">
                            <p className="font-bold">{m.rows_sum?.toLocaleString()}</p>
                            <p className="text-muted-foreground">Σ Linhas</p>
                          </div>
                          <div className="bg-muted/30 p-2 rounded text-center">
                            <p className="font-bold">{m.rows_consolidated?.toLocaleString()}</p>
                            <p className="text-muted-foreground">Consolidadas</p>
                          </div>
                          <div className="bg-muted/30 p-2 rounded text-center">
                            <p className="font-bold">{m.columns_final}</p>
                            <p className="text-muted-foreground">Colunas</p>
                          </div>
                        </div>
                        {m.status_reason && (
                          <p className="text-amber-600 bg-amber-500/10 p-2 rounded">{m.status_reason}</p>
                        )}
                        {m.batch_id && <p className="text-muted-foreground">batch: <span className="font-mono">{m.batch_id}</span></p>}
                        {m.dataset_id && <p className="text-muted-foreground">dataset: <span className="font-mono">{m.dataset_id}</span></p>}
                        <details className="cursor-pointer">
                          <summary className="text-primary hover:underline">Schema JSON</summary>
                          <pre className="bg-muted/50 p-2 rounded mt-1 overflow-x-auto text-[10px] whitespace-pre-wrap">
                            {truncateJson(m.canonical_schema)}
                          </pre>
                        </details>
                        {m.null_diagnostic && (
                          <details className="cursor-pointer">
                            <summary className="text-primary hover:underline">NULL Diagnostic</summary>
                            <pre className="bg-muted/50 p-2 rounded mt-1 overflow-x-auto text-[10px] whitespace-pre-wrap">
                              {truncateJson(m.null_diagnostic)}
                            </pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Jobs */}
              <div>
                <h4 className="font-semibold text-sm mb-2">
                  Import Jobs ({jobs.length})
                </h4>
                {jobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground bg-muted/30 p-3 rounded">
                    Nenhum job encontrado.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {jobs.map((j) => (
                      <div key={j.id} className="border rounded-lg p-3 text-xs flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          {statusIcon(j.status)}
                          <span className="truncate font-medium">{j.file_name}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">{j.status}</Badge>
                        </div>
                        <div className="text-right shrink-0 text-muted-foreground">
                          <p>{j.rows_processed?.toLocaleString() || "—"} rows</p>
                          <p>{new Date(j.created_at).toLocaleString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default AdminManifestDebugModal;
