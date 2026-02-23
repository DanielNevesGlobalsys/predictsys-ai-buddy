import { useState, useCallback, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ShieldCheck, Loader2, RefreshCw, AlertTriangle, XCircle, CheckCircle,
  TrendingUp, BarChart3, Eye, ShieldAlert, Activity, HelpCircle
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface QualityGate {
  gate: string;
  status: "OK" | "WARN" | "BLOCK";
  message: string;
}

interface LeakageSuspect {
  column: string;
  importance: number;
  reason: string;
}

interface TargetQualityReport {
  quality_score: number;
  balance_score: number;
  coverage_score: number;
  stability_score: number | null;
  leakage_score: number;
  weights_used?: { balance: number; coverage: number; stability: number; leakage: number };
  na_dimensions?: string[];
  stability_na?: boolean;
  gates: QualityGate[];
  reasons: string[];
  recommended_actions: string[];
  leakage_suspected: boolean;
  leakage_suspects: LeakageSuspect[];
  stability_by_period: { period: string; positive_rate: number; total: number }[];
  eligible_entities: number;
  total_rows: number;
  coverage_pct: number;
  positive_rate: number;
  dominant_rate: number;
  classes: number;
  template_id: string | null;
  quality_label: string;
  created_at: string;
}

interface Props {
  projectId: string | undefined;
  refreshKey?: number;
}

const SCORE_COLORS: Record<string, string> = {
  Excelente: "text-accent",
  Boa: "text-accent",
  Regular: "text-amber-500",
  Ruim: "text-destructive",
};

const DIMENSION_ICONS: Record<string, React.ReactNode> = {
  balance: <BarChart3 className="w-3.5 h-3.5" />,
  coverage: <Eye className="w-3.5 h-3.5" />,
  stability: <Activity className="w-3.5 h-3.5" />,
  leakage: <ShieldAlert className="w-3.5 h-3.5" />,
};

const scoreBg = (score: number | null) => {
  if (score === null || score < 0) return "bg-muted/30 border-border text-muted-foreground";
  return score >= 80 ? "bg-accent/10 border-accent/20 text-accent" :
    score >= 60 ? "bg-accent/10 border-accent/20 text-accent" :
    score >= 40 ? "bg-amber-500/10 border-amber-500/20 text-amber-600" :
    "bg-destructive/10 border-destructive/20 text-destructive";
};

const StatusIcon = ({ status }: { status: string }) =>
  status === "OK" ? <CheckCircle className="w-3 h-3 text-accent flex-shrink-0" /> :
  status === "WARN" ? <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0" /> :
  <XCircle className="w-3 h-3 text-destructive flex-shrink-0" />;

const TargetQualityCard = ({ projectId, refreshKey = 0 }: Props) => {
  const [report, setReport] = useState<TargetQualityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    // Reset on project change to avoid stale cross-project data
    setReport(null);
    setError(null);
    (async () => {
      const { data } = await supabase
        .from("project_settings")
        .select("target_quality_report, target_source, weak_label_result")
        .eq("project_id", projectId)
        .maybeSingle();
      if (data && (data as any).target_quality_report) {
        const r = (data as any).target_quality_report as TargetQualityReport;
        // Validate the report has real data (not a default placeholder)
        if (r.created_at && r.quality_score != null) {
          setReport(r);
        }
      }
    })();
  }, [projectId, refreshKey]);

  const evaluate = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await supabase.functions.invoke("tde-evaluate-target-quality", {
        body: { project_id: projectId },
      });
      if (response.error) { setError(response.error.message); return; }
      const data = response.data as any;
      if (data?.report) setReport(data.report);
      else setError("Nenhum relatório retornado");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const isNA = (dim: string) => report?.na_dimensions?.includes(dim) || false;

  if (!report && !loading && !error) {
    return (
      <div className="p-4 rounded-lg border border-border bg-muted/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h4 className="text-sm font-semibold">Qualidade do Target</h4>
          </div>
          <Button size="sm" variant="outline" onClick={evaluate} disabled={!projectId}>
            <TrendingUp className="w-3.5 h-3.5 mr-1.5" />
            Avaliar
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Avalie a qualidade, estabilidade e riscos de vazamento do target selecionado.
        </p>
      </div>
    );
  }

  const dimensions = [
    { key: "balance", label: "Equilíbrio", score: report?.balance_score ?? null, weight: report?.weights_used?.balance },
    { key: "coverage", label: "Cobertura", score: report?.coverage_score ?? null, weight: report?.weights_used?.coverage },
    { key: "stability", label: "Estabilidade", score: report?.stability_na ? null : (report?.stability_score ?? null), weight: report?.weights_used?.stability },
    { key: "leakage", label: "Anti-Leak", score: report?.leakage_score ?? null, weight: report?.weights_used?.leakage },
  ];

  return (
    <TooltipProvider>
      <div className="p-4 rounded-lg border border-border bg-muted/5 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h4 className="text-sm font-semibold">Qualidade do Target</h4>
            {report && (
              <Badge className={`text-xs ${scoreBg(report.quality_score)}`}>
                {report.quality_score}/95 — {report.quality_label}
              </Badge>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={evaluate} disabled={loading || !projectId}>
            {loading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
            {report ? "Reavaliar" : "Avaliar"}
          </Button>
        </div>

        {error && (
          <Alert className="bg-destructive/5 border-destructive/20">
            <XCircle className="w-4 h-4 text-destructive" />
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Avaliando qualidade do target...
          </div>
        )}

        {report && !loading && (
          <>
            {/* Score dimensions */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {dimensions.map((dim) => (
                <Tooltip key={dim.key}>
                  <TooltipTrigger asChild>
                    <div className={`flex flex-col items-center p-2 rounded-md border ${scoreBg(dim.score)} relative`}>
                      {DIMENSION_ICONS[dim.key]}
                      {dim.score === null ? (
                        <span className="text-lg font-bold text-muted-foreground">N/A</span>
                      ) : (
                        <span className="text-lg font-bold">{dim.score}</span>
                      )}
                      <span className="text-[10px]">{dim.label}</span>
                      {dim.weight != null && dim.weight > 0 && (
                        <span className="text-[8px] text-muted-foreground">{Math.round(dim.weight * 100)}%</span>
                      )}
                      {dim.score === null && (
                        <HelpCircle className="w-3 h-3 absolute top-1 right-1 text-muted-foreground" />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[200px]">
                    {dim.score === null ? (
                      <p className="text-xs">Dimensão N/A: sem dados suficientes para calcular. Peso redistribuído para outras dimensões.</p>
                    ) : (
                      <p className="text-xs">{dim.label}: {dim.score}/100 (peso: {dim.weight != null ? `${Math.round(dim.weight * 100)}%` : "—"})</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>

            {/* N/A notice */}
            {(report.na_dimensions?.length ?? 0) > 0 && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/20 p-2 rounded border border-border/50">
                <HelpCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>Dimensões N/A ({report.na_dimensions?.join(", ")}): pesos foram renormalizados. Score reflete apenas dimensões com dados.</span>
              </div>
            )}

            {/* Top risks */}
            {report.gates.filter(g => g.status !== "OK").length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Riscos identificados:</p>
                {report.gates.filter(g => g.status !== "OK").slice(0, 3).map((g, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs py-0.5">
                    <StatusIcon status={g.status} />
                    <span>{g.message}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Leakage suspects */}
            {report.leakage_suspected && report.leakage_suspects.length > 0 && (
              <div className="p-2 rounded border border-destructive/20 bg-destructive/5 space-y-1">
                <p className="text-xs font-semibold text-destructive flex items-center gap-1">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  Colunas suspeitas de vazamento:
                </p>
                {report.leakage_suspects.slice(0, 3).map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-medium">{s.column}</span>
                    <Badge variant="outline" className="text-[9px]">{(s.importance * 100).toFixed(0)}%</Badge>
                    <span className="text-muted-foreground text-[10px]">{s.reason}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            {report.recommended_actions.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Ações recomendadas:</p>
                {report.recommended_actions.map((a, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-primary">→</span>
                    <span>{a}</span>
                  </div>
                ))}
              </div>
            )}

            <Button variant="ghost" size="sm" className="text-xs h-6 px-2" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? "Ocultar detalhes" : "Ver detalhes"}
            </Button>

            {showDetails && (
              <div className="space-y-2 text-xs border-t border-border/50 pt-2">
                <div className="flex flex-wrap gap-3 text-muted-foreground">
                  <span>Positivos: {(report.positive_rate * 100).toFixed(1)}%</span>
                  <span>Classes: {report.classes}</span>
                  <span>Entidades: {report.eligible_entities}</span>
                  <span>Cobertura: {report.coverage_pct}%</span>
                  {report.template_id && <span>Template: {report.template_id}</span>}
                </div>
                {report.weights_used && (
                  <div className="flex flex-wrap gap-2 text-muted-foreground text-[10px]">
                    <span>Pesos: Equilíbrio={Math.round(report.weights_used.balance * 100)}%</span>
                    <span>Cobertura={Math.round(report.weights_used.coverage * 100)}%</span>
                    <span>Estabilidade={Math.round(report.weights_used.stability * 100)}%</span>
                    <span>Leakage={Math.round(report.weights_used.leakage * 100)}%</span>
                  </div>
                )}
                <div className="space-y-0.5">
                  {report.gates.map((g, i) => (
                    <div key={i} className="flex items-start gap-2 py-0.5">
                      <StatusIcon status={g.status} />
                      <span className="text-muted-foreground">[{g.gate}]</span>
                      <span>{g.message}</span>
                    </div>
                  ))}
                </div>
                {report.stability_by_period.length > 0 && (
                  <div>
                    <p className="font-semibold text-muted-foreground mb-1">Estabilidade temporal:</p>
                    <div className="flex flex-wrap gap-2">
                      {report.stability_by_period.map((s, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {s.period}: {(s.positive_rate * 100).toFixed(1)}% ({s.total})
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">
                  Avaliado em: {new Date(report.created_at).toLocaleString("pt-BR")}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  );
};

export default TargetQualityCard;
