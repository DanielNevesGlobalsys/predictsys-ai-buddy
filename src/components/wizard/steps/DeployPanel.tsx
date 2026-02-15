import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Rocket, Shield, CheckCircle, AlertTriangle, XCircle,
  RotateCcw, Clock, Loader2, ArrowRight, Info,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// ─── Types ───

interface DeployGate {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
}

interface DeploymentRecord {
  id: string;
  model_id: string;
  previous_model_id: string | null;
  selection_version: number;
  deployed_by: string | null;
  reason: string | null;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface ChampionInfo {
  model_id: string;
  name: string;
  score: number;
  primary_metric: string;
  quality_flag: string;
  calibration?: { method: string; brier_before?: number; brier_after?: number };
  recommended_threshold?: number;
}

interface DeployPanelProps {
  projectId: string;
  problemType: string;
  champion: ChampionInfo | null;
  onDeploySuccess?: () => void;
}

// ─── Helpers ───

function gateIcon(status: string) {
  if (status === "PASS") return <CheckCircle className="w-3.5 h-3.5 text-accent" />;
  if (status === "WARN") return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
  return <XCircle className="w-3.5 h-3.5 text-destructive" />;
}

function gateColor(status: string) {
  if (status === "PASS") return "border-accent/20 bg-accent/5";
  if (status === "WARN") return "border-amber-500/20 bg-amber-500/5";
  return "border-destructive/20 bg-destructive/5";
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

// ─── Component ───

export default function DeployPanel({ projectId, problemType, champion, onDeploySuccess }: DeployPanelProps) {
  const [deploying, setDeploying] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [deployResult, setDeployResult] = useState<{ gates: DeployGate[]; ctas: any[]; status: string; deployment_id?: string; previous_model_id?: string } | null>(null);
  const [lastDeployment, setLastDeployment] = useState<DeploymentRecord | null>(null);
  const [productionModel, setProductionModel] = useState<{ id: string; algorithm_name: string; deployed_at: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDeployState = useCallback(async () => {
    setLoading(true);
    const [deployRes, modelRes] = await Promise.all([
      supabase.from("project_model_deployments")
        .select("*").eq("project_id", projectId).eq("status", "success")
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_models")
        .select("id, algorithm_name, deployed_at")
        .eq("project_id", projectId).eq("is_production", true).maybeSingle(),
    ]);
    setLastDeployment((deployRes.data as any) || null);
    setProductionModel((modelRes.data as any) || null);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { loadDeployState(); }, [loadDeployState]);

  const handleDeploy = async () => {
    if (!champion) return;
    setDeploying(true);
    setDeployResult(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/deploy-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ project_id: projectId, model_id: champion.model_id, reason: "Deploy Champion via UI" }),
      });
      const data = await res.json();
      setDeployResult({ gates: data.gates || [], ctas: data.ctas || [], status: data.status, deployment_id: data.deployment_id, previous_model_id: data.previous_model_id });
      if (data.success || data.status === "DEPLOYED") {
        toast.success("Modelo promovido para produção!");
        await loadDeployState();
        onDeploySuccess?.();
      } else {
        toast.error(data.blocked_reason_code || "Deploy bloqueado");
      }
    } catch (err) {
      toast.error("Erro ao fazer deploy");
      console.error(err);
    } finally {
      setDeploying(false);
    }
  };

  const handleRollback = async () => {
    setRollingBack(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/rollback-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ project_id: projectId }),
      });
      const data = await res.json();
      if (data.success || data.status === "ROLLED_BACK") {
        toast.success("Rollback concluído — modelo anterior restaurado.");
        setDeployResult(null);
        await loadDeployState();
        onDeploySuccess?.();
      } else {
        toast.error(data.gates?.[0]?.message || "Rollback bloqueado");
      }
    } catch (err) {
      toast.error("Erro no rollback");
      console.error(err);
    } finally {
      setRollingBack(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-6 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </Card>
    );
  }

  const canRollback = lastDeployment?.previous_model_id != null;
  const isChampionAlreadyDeployed = productionModel?.id === champion?.model_id;

  return (
    <Card className="p-5 space-y-4 border-primary/20">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
          <Rocket className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-bold">Deploy & Governança</h3>
          <p className="text-xs text-muted-foreground">Promoção atômica com auditoria completa</p>
        </div>
      </div>

      {/* Champion recommendation */}
      {champion && (
        <div className="bg-accent/10 border border-accent/20 rounded-lg p-3 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Champion recomendado</span>
            <Badge variant="outline" className="text-[10px]">{champion.primary_metric}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{champion.name}</span>
            <span className="text-sm font-bold text-accent">
              {["MAE", "RMSE"].includes(champion.primary_metric) ? champion.score.toFixed(2) : `${(champion.score * 100).toFixed(1)}%`}
            </span>
          </div>
          {champion.quality_flag !== "ok" && (
            <Badge variant="destructive" className="text-[9px]">{champion.quality_flag}</Badge>
          )}
        </div>
      )}

      {/* Current production */}
      {productionModel && (
        <div className="bg-muted/30 rounded-lg p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Shield className="w-3.5 h-3.5" />
            <span>Em produção agora</span>
          </div>
          <p className="text-sm font-medium">{productionModel.algorithm_name}</p>
          {productionModel.deployed_at && (
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDate(productionModel.deployed_at)}
            </p>
          )}
          {lastDeployment && (
            <p className="text-[10px] text-muted-foreground">
              selection_version: v{lastDeployment.selection_version}
            </p>
          )}
        </div>
      )}

      {/* Deploy gates result */}
      {deployResult && deployResult.gates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Gates do Deploy</p>
          {deployResult.gates.map((g, i) => (
            <div key={i} className={`flex items-start gap-2 text-xs p-2 rounded border ${gateColor(g.status)}`}>
              {gateIcon(g.status)}
              <div>
                <span className="font-medium">{g.gate}</span>
                <span className="ml-1 text-muted-foreground">{g.message}</span>
              </div>
            </div>
          ))}
          {deployResult.ctas?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {deployResult.ctas.map((cta: any, i: number) => (
                <Badge key={i} variant="outline" className="text-[10px] cursor-pointer hover:bg-primary/10">
                  <ArrowRight className="w-3 h-3 mr-0.5" />{cta.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2">
        {champion && !isChampionAlreadyDeployed && (
          <Button
            className="w-full"
            onClick={handleDeploy}
            disabled={deploying || champion.quality_flag === "fail_sanity" || champion.quality_flag === "fail_metrics"}
          >
            {deploying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Rocket className="w-4 h-4 mr-2" />}
            {deploying ? "Promovendo…" : "Deploy Champion"}
          </Button>
        )}

        {isChampionAlreadyDeployed && (
          <div className="flex items-center gap-2 text-xs text-accent p-2 bg-accent/10 rounded-lg">
            <CheckCircle className="w-4 h-4" />
            <span>Champion já está em produção</span>
          </div>
        )}

        {canRollback && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full" disabled={rollingBack}>
                {rollingBack ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
                {rollingBack ? "Restaurando…" : "Rollback para modelo anterior"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirmar Rollback</AlertDialogTitle>
                <AlertDialogDescription>
                  Isso restaurará o modelo anterior como modelo de produção. O scoring usará o modelo restaurado a partir de agora.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={handleRollback}>Confirmar Rollback</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Info */}
      <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
        <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <span>Deploy atômico com advisory lock. Apenas 1 modelo em produção por projeto. Histórico completo auditado.</span>
      </div>
    </Card>
  );
}
