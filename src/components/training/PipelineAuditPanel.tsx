import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ClipboardCheck,
  Info,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useProjectPipelineAudit, type AuditReport, type AuditCheckResult, type AuditContextFlags } from "@/hooks/useProjectPipelineAudit";

interface PipelineAuditPanelProps {
  projectId: string;
  pipelineStage?: "training" | "production";
}

const STAGE_LABELS: Record<string, { label: string; icon: string }> = {
  eda: { label: "EDA (Análise Exploratória)", icon: "📊" },
  inference: { label: "Inferência de Problema", icon: "🧠" },
  target: { label: "Target (Variável Alvo)", icon: "🎯" },
  model: { label: "Modelo Treinado", icon: "⚙️" },
  dashboard: { label: "Dashboard de Negócio", icon: "📈" },
};

const StatusIcon = ({ status }: { status: string }) => {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="w-4 h-4 text-accent" />;
    case "warning":
      return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    case "error":
      return <XCircle className="w-4 h-4 text-destructive" />;
    case "pending":
      return <Info className="w-4 h-4 text-blue-400" />;
    default:
      return <Info className="w-4 h-4 text-muted-foreground" />;
  }
};

const StatusBadge = ({ status }: { status: string }) => {
  const variants: Record<string, string> = {
    ok: "bg-accent/10 text-accent border-accent/30",
    warning: "bg-yellow-500/10 text-yellow-600 border-yellow-500/30",
    error: "bg-destructive/10 text-destructive border-destructive/30",
    pending: "bg-blue-500/10 text-blue-500 border-blue-500/30",
  };
  const labels: Record<string, string> = {
    ok: "Coerente",
    warning: "Atenção",
    error: "Incoerente",
    pending: "Pendente",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${variants[status] || ""}`}>
      {labels[status] || status}
    </span>
  );
};

const StageCard = ({ stageKey, check }: { stageKey: string; check: AuditCheckResult }) => {
  const meta = STAGE_LABELS[stageKey] || { label: stageKey, icon: "❓" };
  return (
    <div className={`p-3 rounded-lg border ${
      check.status === "ok" ? "border-accent/20 bg-accent/5" :
      check.status === "warning" ? "border-yellow-500/20 bg-yellow-500/5" :
      check.status === "pending" ? "border-blue-500/20 bg-blue-500/5" :
      "border-destructive/20 bg-destructive/5"
    }`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm">{meta.icon}</span>
          <span className="text-sm font-medium">{meta.label}</span>
        </div>
        <StatusBadge status={check.status} />
      </div>
      {check.observations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {check.observations.map((obs, idx) => (
            <li key={idx} className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <StatusIcon status={check.status} />
              <span>{obs}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const ContextFlagsGrid = ({ flags }: { flags: AuditContextFlags }) => {
  const labels: Record<string, string> = {
    has_eda: "EDA",
    has_inference: "Inferência",
    has_target: "Target",
    has_features: "Features",
    has_model: "Modelo",
    has_metrics: "Métricas",
    has_feature_importance: "Importância",
    has_predictions: "Previsões",
    has_dashboard_context: "Dashboard",
  };
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {Object.entries(flags).map(([key, value]) => (
        <div key={key} className="flex items-center gap-1 text-xs">
          {value ? (
            <CheckCircle2 className="w-3 h-3 text-accent flex-shrink-0" />
          ) : (
            <XCircle className="w-3 h-3 text-destructive flex-shrink-0" />
          )}
          <span className={value ? "text-foreground" : "text-destructive/70"}>
            {labels[key] || key}
          </span>
        </div>
      ))}
    </div>
  );
};

const PipelineAuditPanel = ({ projectId, pipelineStage = "production" }: PipelineAuditPanelProps) => {
  const { t, i18n } = useTranslation();
  const [isAdmin, setIsAdmin] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { report, loading, error, runAudit } = useProjectPipelineAudit(projectId);

  useEffect(() => {
    checkAdminStatus();
  }, []);

  const checkAdminStatus = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("organization_users")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["super_admin", "org_admin"]);
    if (data && data.length > 0) {
      setIsAdmin(data.some(d => d.role === "super_admin"));
    }
  };

  if (!isAdmin) return null;

  const OverallIcon = report
    ? report.overall_coherent
      ? ShieldCheck
      : report.confidence_level === "medium"
        ? ShieldAlert
        : ShieldX
    : ClipboardCheck;

  const overallColor = report
    ? report.overall_coherent
      ? "text-accent"
      : report.confidence_level === "medium"
        ? "text-yellow-500"
        : "text-destructive"
    : "text-muted-foreground";

  return (
    <Card className="border-dashed border-primary/30 bg-primary/5 p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <OverallIcon className={`w-5 h-5 ${overallColor}`} />
          <span className="text-sm font-semibold text-primary">
            Validador Cumulativo da Lys
          </span>
          {report && (
            <Badge
              variant={report.overall_coherent ? "secondary" : "destructive"}
              className="text-xs"
            >
              {report.overall_coherent ? "COERENTE" : "INCOERENTE"}
              {" · "}
              {report.confidence_level === "high" ? "Alta" : report.confidence_level === "medium" ? "Média" : "Baixa"} confiança
            </Badge>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {/* Run Audit Button */}
          {!report && !loading && (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground mb-3">
                Execute a auditoria para validar a coerência do pipeline EDA → Modelo → Dashboard.
              </p>
              <Button
                onClick={() => runAudit(i18n.language, pipelineStage)}
                disabled={loading}
                className="bg-gradient-primary hover:shadow-hover"
              >
                <ClipboardCheck className="w-4 h-4 mr-2" />
                Executar Auditoria
              </Button>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-8 gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">Auditando pipeline do projeto...</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => runAudit(i18n.language, pipelineStage)}>
                Tentar novamente
              </Button>
            </div>
          )}

          {/* Report */}
          {report && !loading && (
            <>
              {/* Context Flags */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Contexto disponível:</p>
                <ContextFlagsGrid flags={report.context_flags} />
              </div>

              {/* Stages */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Diagnóstico por etapa:</p>
                {Object.entries(report.stages).map(([key, check]) => (
                  <StageCard key={key} stageKey={key} check={check} />
                ))}
              </div>

              {/* Incoherences */}
              {report.incoherences.length > 0 && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                  <p className="text-xs font-semibold text-destructive mb-2 flex items-center gap-1">
                    <ShieldX className="w-3.5 h-3.5" />
                    Incoerências encontradas:
                  </p>
                  <ul className="space-y-1">
                    {report.incoherences.map((inc, idx) => (
                      <li key={idx} className="text-xs text-destructive/80 flex items-start gap-1.5">
                        <span className="mt-0.5">•</span>
                        <span>{inc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Corrections */}
              {report.corrections.length > 0 && (
                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <p className="text-xs font-semibold text-yellow-600 mb-2">
                    🛠️ Correções necessárias (em ordem):
                  </p>
                  <ol className="space-y-1 list-decimal list-inside">
                    {report.corrections.map((cor, idx) => (
                      <li key={idx} className="text-xs text-yellow-700/80">{cor}</li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Executive Conclusion */}
              <div className="p-3 bg-muted/50 border border-border rounded-lg">
                <p className="text-xs font-semibold text-foreground mb-2">🧠 Conclusão executiva:</p>
                <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                  {report.executive_conclusion}
                </p>
              </div>

              {/* Disclaimer */}
              <p className="text-[10px] text-muted-foreground italic text-center">
                ⚠️ {report.disclaimer}
              </p>

              {/* Re-run */}
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => runAudit(i18n.language, pipelineStage)}
                  disabled={loading}
                  className="text-xs"
                >
                  <ClipboardCheck className="w-3.5 h-3.5 mr-1" />
                  Re-executar auditoria
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
};

export default PipelineAuditPanel;
