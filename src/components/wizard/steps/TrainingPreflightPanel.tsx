import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Shield, Loader2, CheckCircle, AlertTriangle, XCircle,
  Database, Target, Package, Cpu, FileText, RefreshCw, Hammer
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

interface PreflightResult {
  can_build: boolean;
  can_train: boolean;
  can_deploy: boolean;
  can_schedule: boolean;
  dashboard_allowed_precheck: boolean;
  gates: GateResult[];
  blocked_reason_code: string | null;
  human_message: string;
  action_cta: string | null;
  selection_version: number;
  selection_version_current: number;
  selection_version_used_by_builder: number | null;
  builder_is_current: boolean;
  builder_version: number;
}

const GATE_ICONS: Record<string, React.ReactNode> = {
  dataset: <Database className="w-3.5 h-3.5" />,
  intent: <FileText className="w-3.5 h-3.5" />,
  selection: <Target className="w-3.5 h-3.5" />,
  builder: <Package className="w-3.5 h-3.5" />,
  training_gate: <Cpu className="w-3.5 h-3.5" />,
  target_quality: <Shield className="w-3.5 h-3.5" />,
  target_trainable: <Target className="w-3.5 h-3.5" />,
  target_lifecycle: <RefreshCw className="w-3.5 h-3.5" />,
};

const GATE_LABELS: Record<string, string> = {
  dataset: "Dataset",
  intent: "Intent",
  selection: "Seleção",
  builder: "Builder",
  training_gate: "Gates",
  target_quality: "Qualidade",
  target_trainable: "Treinável",
  weak_label_health: "Assistido",
  human_label_health: "Rotulagem",
  target_lifecycle: "Ciclo de Vida",
  label_build: "Label",
  metrics_profile: "Métricas",
  mvp_soft_features: "Features",
  mvp_soft_sampling: "Amostra",
  split_policy: "Split",
  leakage_guard: "Leakage",
  class_balance: "Balanço",
};

interface Props {
  projectId: string | undefined;
  onNavigateBack?: () => void;
  /** Increment to force a re-run of the preflight check */
  refreshKey?: number;
}

const TrainingPreflightPanel = ({ projectId, onNavigateBack, refreshKey = 0 }: Props) => {
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreflight = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);

    try {
      const response = await supabase.functions.invoke("run-training-preflight", {
        body: { project_id: projectId },
      });

      if (response.error) {
        setError(response.error.message);
        return;
      }

      setResult(response.data as PreflightResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Auto-run on mount and when refreshKey changes
  useEffect(() => {
    runPreflight();
  }, [runPreflight, refreshKey]);

  const statusColor = (s: string) =>
    s === "PASS" ? "text-accent" : s === "WARN" ? "text-amber-500" : "text-destructive";

  const statusBg = (s: string) =>
    s === "PASS" ? "bg-accent/10 border-accent/20" : s === "WARN" ? "bg-amber-500/10 border-amber-500/20" : "bg-destructive/10 border-destructive/20";

  const StatusIcon = ({ status }: { status: string }) =>
    status === "PASS" ? <CheckCircle className="w-3.5 h-3.5 text-accent" /> :
    status === "WARN" ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> :
    <XCircle className="w-3.5 h-3.5 text-destructive" />;

  return (
    <div className="p-4 rounded-lg border border-border bg-muted/5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          <h4 className="text-sm font-semibold">🛡️ Training Preflight</h4>
        </div>
        <Button size="sm" variant="outline" onClick={runPreflight} disabled={loading || !projectId}>
          {loading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
          {result ? "Re-verificar" : "Verificar"}
        </Button>
      </div>

      {error && (
        <Alert className="bg-destructive/5 border-destructive/20">
          <XCircle className="w-4 h-4 text-destructive" />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <>
          {/* Active target mode indicator */}
          {result.gates.some(g => g.details && (g.details as any).active_target_mode === "human") && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20 text-xs">
              <Target className="w-3.5 h-3.5 text-primary" />
              <span className="font-medium">Target ativo: Human (rotulagem)</span>
              <Badge className="bg-primary/20 text-primary text-[10px]">ATIVO</Badge>
            </div>
          )}

          {/* Gate badges row */}
          <div className="flex flex-wrap gap-2">
            {result.gates.map((g) => (
              <div key={g.gate} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs ${statusBg(g.status)}`}>
                {GATE_ICONS[g.gate] || <Shield className="w-3.5 h-3.5" />}
                <span className="font-medium">{GATE_LABELS[g.gate] || g.gate}</span>
                <StatusIcon status={g.status} />
              </div>
            ))}
          </div>

          {/* Gate details */}
          <div className="space-y-1">
            {result.gates.map((g) => (
              <div key={g.gate} className="flex items-start gap-2 text-xs py-1">
                <StatusIcon status={g.status} />
                <div className="flex-1">
                  <span className={statusColor(g.status)}>{g.message}</span>
                  {/* Show fix suggestions for blocked human target */}
                  {g.status === "BLOCK" && g.details?.fix_suggestions && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(g.details.fix_suggestions as any[]).map((s: any, i: number) => (
                        <Badge key={i} variant="outline" className="text-[10px] cursor-pointer hover:bg-muted">
                          {s.label}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {/* Show class distribution for human target */}
                  {(g.details as any)?.active_target_mode === "human" && g.details?.pos != null && (
                    <div className="flex gap-2 mt-1 text-[10px] text-muted-foreground">
                      <span>+{(g.details as any).pos}</span>
                      <span>−{(g.details as any).neg}</span>
                      <span>Total: {(g.details as any).join_rows}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Version info */}
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground border-t border-border/50 pt-2">
            <span>Seleção: v{result.selection_version_current}</span>
            <span>Builder: v{result.selection_version_used_by_builder ?? "—"}</span>
            {!result.builder_is_current && (
              <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">OUTDATED</Badge>
            )}
          </div>

          {/* Overall status */}
          <div className={`p-2 rounded text-xs font-medium ${
            result.can_train ? "bg-accent/10 text-accent" : "bg-destructive/10 text-destructive"
          }`}>
            {result.can_train ? "✅ Pronto para treinar" : `❌ ${result.human_message}`}
          </div>

          {/* CTA */}
          {result.action_cta && !result.can_train && (
            <Button size="sm" variant="outline" onClick={onNavigateBack} className="w-full text-xs">
              {result.action_cta}
            </Button>
          )}

          {/* Capability flags */}
          <div className="flex flex-wrap gap-2 text-[10px]">
            <Badge variant={result.can_build ? "default" : "outline"} className="text-[10px]">Build: {result.can_build ? "✓" : "✗"}</Badge>
            <Badge variant={result.can_train ? "default" : "outline"} className="text-[10px]">Train: {result.can_train ? "✓" : "✗"}</Badge>
            <Badge variant={result.can_deploy ? "default" : "outline"} className="text-[10px]">Deploy: {result.can_deploy ? "✓" : "✗"}</Badge>
            <Badge variant={result.dashboard_allowed_precheck ? "default" : "outline"} className="text-[10px]">Dashboard: {result.dashboard_allowed_precheck ? "✓" : "✗"}</Badge>
          </div>
        </>
      )}

      {!result && !loading && (
        <p className="text-xs text-muted-foreground">Clique em "Verificar" para executar o preflight de treinamento.</p>
      )}
    </div>
  );
};

export default TrainingPreflightPanel;
