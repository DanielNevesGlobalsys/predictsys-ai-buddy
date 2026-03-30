import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Brain, Target, Database, AlertTriangle, CheckCircle2,
  XCircle, RefreshCw, ChevronRight, Shield, Layers, Clock,
  User, BarChart3, Loader2,
} from "lucide-react";
import type { ProjectData } from "@/components/wizard/WizardContainer";

interface PredictiveResolutionPanelProps {
  projectData: ProjectData;
  onAccept: (resolution: any) => void;
  onReject: () => void;
  onBack: () => void;
  loading?: boolean;
}

const PredictiveResolutionPanel = ({
  projectData, onAccept, onReject, onBack, loading: externalLoading,
}: PredictiveResolutionPanelProps) => {
  const { toast } = useToast();
  const { currentOrganization } = useOrganization();
  const [resolution, setResolution] = useState<any>(null);
  const [resolving, setResolving] = useState(false);
  const [resolutionId, setResolutionId] = useState<string | null>(null);

  const runResolution = useCallback(async () => {
    if (!projectData.id || !currentOrganization?.id) return;
    setResolving(true);
    try {
      const { data, error } = await supabase.functions.invoke("run-predictive-resolution", {
        body: {
          project_id: projectData.id,
          organization_id: currentOrganization.id,
          mode: "assisted",
        },
      });
      if (error) throw error;
      if (data?.success && data?.resolution) {
        setResolution(data.resolution);
        setResolutionId(data.resolution_id);
      } else {
        throw new Error(data?.error || "Falha na resolução");
      }
    } catch (err: any) {
      toast({ title: "Erro na resolução preditiva", description: err.message, variant: "destructive" });
    } finally {
      setResolving(false);
    }
  }, [projectData.id, currentOrganization?.id, toast]);

  useEffect(() => {
    if (projectData.id && currentOrganization?.id && !resolution) {
      // Check for existing resolution
      supabase
        .from("project_predictive_resolutions" as any)
        .select("*")
        .eq("project_id", projectData.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .then(({ data }) => {
          const rows = data as any[];
          if (rows?.length && rows[0].status !== "rejected") {
            setResolution(rows[0].resolution_json);
            setResolutionId(rows[0].id);
          } else {
            runResolution();
          }
        });
    }
  }, [projectData.id, currentOrganization?.id]);

  const handleAccept = async () => {
    if (!resolutionId) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await (supabase.from("project_predictive_resolutions" as any) as any)
        .update({ status: "accepted", accepted_by: user?.id, accepted_at: new Date().toISOString() })
        .eq("id", resolutionId);
      await supabase.from("project_settings" as any).update({
        predictive_resolution_state: "accepted",
      } as any).eq("project_id", projectData.id);
      toast({ title: "Resolução aceita", description: "O PRE definiu o problema preditivo." });
      onAccept(resolution);
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
  };

  const handleReject = async () => {
    if (!resolutionId) return;
    try {
      await (supabase.from("project_predictive_resolutions" as any) as any)
        .update({ status: "rejected" })
        .eq("id", resolutionId);
      await supabase.from("project_settings" as any).update({
        predictive_resolution_state: "rejected",
      } as any).eq("project_id", projectData.id);
      toast({ title: "Resolução rejeitada", description: "Defina manualmente na próxima etapa." });
      onReject();
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
  };

  if (resolving) {
    return (
      <Card className="max-w-4xl mx-auto">
        <CardContent className="py-16 flex flex-col items-center gap-4">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="text-lg font-medium">Analisando dados e formulando problema preditivo...</p>
          <p className="text-sm text-muted-foreground">O PRE está resolvendo target, entidade, grain e horizonte automaticamente.</p>
        </CardContent>
      </Card>
    );
  }

  if (!resolution) {
    return (
      <Card className="max-w-4xl mx-auto">
        <CardContent className="py-16 flex flex-col items-center gap-4">
          <Brain className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">Nenhuma resolução disponível.</p>
          <Button onClick={runResolution}>
            <RefreshCw className="h-4 w-4 mr-2" /> Executar PRE
          </Button>
        </CardContent>
      </Card>
    );
  }

  const prob = resolution.problem_definition;
  const tgt = resolution.target_definition;
  const ds = resolution.dataset_strategy;
  const fp = resolution.feature_plan;
  const val = resolution.validation;
  const expl = resolution.explanation;
  const conf = resolution.confidence;

  const confidenceColor = conf.overall >= 0.7 ? "text-green-500" : conf.overall >= 0.5 ? "text-yellow-500" : "text-red-500";
  const confidenceBg = conf.overall >= 0.7 ? "bg-green-500/10" : conf.overall >= 0.5 ? "bg-yellow-500/10" : "bg-red-500/10";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Resolução Preditiva (PRE)</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Formulação automática do problema com base no contrato de intenção e dados.
              </p>
            </div>
          </div>
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full ${confidenceBg}`}>
            <span className={`text-2xl font-bold ${confidenceColor}`}>
              {Math.round(conf.overall * 100)}%
            </span>
            <span className="text-xs text-muted-foreground">confiança</span>
          </div>
        </CardHeader>
      </Card>

      {/* Blocking errors */}
      {val.blocking_errors?.length > 0 && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>
            <strong>Bloqueios detectados:</strong>
            <ul className="mt-1 list-disc pl-4">
              {val.issues_detected?.filter((i: any) => i.severity === "block").map((i: any, idx: number) => (
                <li key={idx}>{i.message} — {i.suggestion}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Accordion type="multiple" defaultValue={["problem", "target", "strategy"]} className="space-y-3">
        {/* 1. Problem Understanding */}
        <AccordionItem value="problem" className="border rounded-lg bg-card">
          <AccordionTrigger className="px-6 hover:no-underline">
            <div className="flex items-center gap-3">
              <BarChart3 className="h-5 w-5 text-primary" />
              <span className="font-semibold">O que o sistema entendeu</span>
              <Badge variant="outline" className="ml-2">
                {prob.problem_type === "classification" ? "Classificação" : "Regressão"}
              </Badge>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <InfoBlock icon={<BarChart3 className="h-4 w-4" />} label="Tipo de Problema" value={prob.problem_type === "classification" ? "Classificação" : "Regressão"} />
              <InfoBlock icon={<User className="h-4 w-4" />} label="Entity Key" value={prob.entity?.entity_key || "Não detectado"} alert={!prob.entity?.entity_key} />
              <InfoBlock icon={<Layers className="h-4 w-4" />} label="Grain" value={prob.entity?.grain || "original_row"} />
              <InfoBlock icon={<Clock className="h-4 w-4" />} label="Âncora Temporal" value={prob.time_anchor || "Não detectada"} alert={!prob.time_anchor} />
              <InfoBlock icon={<Clock className="h-4 w-4" />} label="Horizonte" value={`${prob.horizon_days} dias`} />
              <InfoBlock icon={<Database className="h-4 w-4" />} label="Shape do Dataset" value={prob.dataset_shape_detected || "desconhecido"} />
            </div>
            <p className="mt-4 text-sm text-muted-foreground italic">{expl.why_this_problem}</p>
          </AccordionContent>
        </AccordionItem>

        {/* 2. Target */}
        <AccordionItem value="target" className="border rounded-lg bg-card">
          <AccordionTrigger className="px-6 hover:no-underline">
            <div className="flex items-center gap-3">
              <Target className="h-5 w-5 text-primary" />
              <span className="font-semibold">Target Sugerido</span>
              <Badge variant={tgt.mode === "blocked" ? "destructive" : "default"} className="ml-2">
                {tgt.mode === "explicit" ? "Explícito" : tgt.mode === "derived" ? "Derivado" : tgt.mode === "weak" ? "Fraco" : "Bloqueado"}
              </Badge>
              {tgt.target_name && (
                <Badge variant="outline" className="ml-1">{tgt.target_name}</Badge>
              )}
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-4">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <InfoBlock icon={<Target className="h-4 w-4" />} label="Coluna Target" value={tgt.target_name || "Nenhum"} alert={!tgt.target_name} />
                <InfoBlock icon={<Shield className="h-4 w-4" />} label="Confiança" value={`${Math.round((tgt.target_confidence || 0) * 100)}%`} />
              </div>
              <p className="text-sm text-muted-foreground">{tgt.target_reasoning}</p>

              {tgt.alternatives?.length > 0 && (
                <div className="mt-3">
                  <p className="text-sm font-medium mb-2">Alternativas:</p>
                  <div className="space-y-1">
                    {tgt.alternatives.slice(0, 5).map((alt: any, idx: number) => (
                      <div key={idx} className="flex items-center justify-between text-sm py-1 px-3 rounded bg-muted/50">
                        <span>{alt.column}</span>
                        <span className="text-muted-foreground">{Math.round(alt.score * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* 3. Dataset Strategy */}
        <AccordionItem value="strategy" className="border rounded-lg bg-card">
          <AccordionTrigger className="px-6 hover:no-underline">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-primary" />
              <span className="font-semibold">Estratégia de Dataset</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-4">
            <div className="grid grid-cols-2 gap-4">
              <InfoBlock label="Precisa Agregação?" value={ds.needs_aggregation ? "Sim" : "Não"} />
              <InfoBlock label="Precisa Snapshots?" value={ds.snapshot_required ? "Sim" : "Não"} />
              <InfoBlock label="Estratégia Temporal" value={ds.temporal_strategy || "nenhuma"} />
              <InfoBlock label="Split Sugerido" value={ds.split_suggestion || "stratified"} />
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* 4. Risks */}
        <AccordionItem value="risks" className="border rounded-lg bg-card">
          <AccordionTrigger className="px-6 hover:no-underline">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              <span className="font-semibold">Riscos Detectados</span>
              {val.issues_detected?.length > 0 && (
                <Badge variant="outline" className="ml-2">{val.issues_detected.length}</Badge>
              )}
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-4">
            {val.issues_detected?.length > 0 ? (
              <div className="space-y-2">
                {val.issues_detected.map((issue: any, idx: number) => (
                  <div key={idx} className={`flex items-start gap-3 p-3 rounded-lg ${
                    issue.severity === "block" ? "bg-destructive/10" : issue.severity === "warn" ? "bg-yellow-500/10" : "bg-muted"
                  }`}>
                    {issue.severity === "block" ? <XCircle className="h-4 w-4 text-destructive mt-0.5" /> :
                     issue.severity === "warn" ? <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5" /> :
                     <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />}
                    <div>
                      <p className="text-sm font-medium">{issue.message}</p>
                      {issue.suggestion && <p className="text-xs text-muted-foreground mt-1">{issue.suggestion}</p>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-green-600 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> Nenhum risco crítico detectado.
              </p>
            )}

            {fp.leakage_flags?.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-medium text-yellow-600">Colunas com risco de leakage:</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {fp.leakage_flags.map((col: string, idx: number) => (
                    <Badge key={idx} variant="outline" className="text-yellow-600">{col}</Badge>
                  ))}
                </div>
              </div>
            )}
          </AccordionContent>
        </AccordionItem>

        {/* 5. Features */}
        <AccordionItem value="features" className="border rounded-lg bg-card">
          <AccordionTrigger className="px-6 hover:no-underline">
            <div className="flex items-center gap-3">
              <Layers className="h-5 w-5 text-primary" />
              <span className="font-semibold">Plano de Features</span>
              <Badge variant="outline" className="ml-2">{fp.include_features?.length || 0} selecionadas</Badge>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-4">
            <p className="text-sm text-muted-foreground mb-3">{fp.feature_reasoning}</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-green-600 mb-1">Incluídas ({fp.include_features?.length})</p>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {(fp.include_features || []).slice(0, 20).map((f: string, i: number) => (
                    <Badge key={i} variant="outline" className="text-xs mr-1 mb-1">{f}</Badge>
                  ))}
                  {(fp.include_features?.length || 0) > 20 && (
                    <span className="text-xs text-muted-foreground">+{fp.include_features.length - 20} mais</span>
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-red-600 mb-1">Excluídas / Bloqueadas ({(fp.exclude_features?.length || 0) + (fp.blocked_features?.length || 0)})</p>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {[...(fp.exclude_features || []), ...(fp.blocked_features || [])].slice(0, 15).map((f: string, i: number) => (
                    <Badge key={i} variant="outline" className="text-xs mr-1 mb-1 text-muted-foreground">{f}</Badge>
                  ))}
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Confidence Scores */}
        <AccordionItem value="confidence" className="border rounded-lg bg-card">
          <AccordionTrigger className="px-6 hover:no-underline">
            <div className="flex items-center gap-3">
              <Shield className="h-5 w-5 text-primary" />
              <span className="font-semibold">Detalhes de Confiança</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <ScoreBar label="Problema" score={conf.scores?.problem_fit || 0} />
              <ScoreBar label="Target" score={conf.scores?.target_fit || 0} />
              <ScoreBar label="Grain" score={conf.scores?.grain_fit || 0} />
              <ScoreBar label="Temporal" score={conf.scores?.time_fit || 0} />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* Actions */}
      <Card>
        <CardContent className="py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onBack}>Voltar</Button>
            <Button variant="outline" onClick={runResolution} disabled={resolving}>
              <RefreshCw className={`h-4 w-4 mr-2 ${resolving ? "animate-spin" : ""}`} /> Reexecutar
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleReject}>
              Revisar Manualmente
            </Button>
            <Button
              onClick={handleAccept}
              disabled={val.blocking_errors?.length > 0}
              className="bg-primary"
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Aceitar Resolução
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Debug info (collapsible) */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">🔧 Debug: inputs e regras</summary>
        <pre className="mt-2 p-3 bg-muted rounded-lg overflow-auto max-h-48">
          {JSON.stringify({
            inputs_used: resolution.inputs_used,
            rules_triggered: resolution.rules_triggered,
          }, null, 2)}
        </pre>
      </details>
    </div>
  );
};

// ── Helper Components ──────────────────────────────────────────

function InfoBlock({ icon, label, value, alert }: { icon?: React.ReactNode; label: string; value: string; alert?: boolean }) {
  return (
    <div className={`p-3 rounded-lg ${alert ? "bg-yellow-500/10 border border-yellow-500/20" : "bg-muted/50"}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        {icon} {label}
      </div>
      <p className={`text-sm font-medium ${alert ? "text-yellow-600" : ""}`}>{value}</p>
    </div>
  );
}

function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 70 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span>{label}</span>
        <span className="font-medium">{pct}%</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default PredictiveResolutionPanel;
