import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CalendarClock, ArrowLeft, CheckCircle, XCircle, AlertTriangle,
  Loader2, Clock, Shield, Play, Pause, Info, RefreshCw, Eye,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";

interface StepSchedulingProps {
  projectData: ProjectData;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onFinalComplete: () => Promise<void>;
}

type ScheduleType = "daily" | "weekly" | "monthly" | "interval_hours";
type ScheduleMode = "full" | "incremental";

interface ScheduleConfig {
  is_enabled: boolean;
  schedule_type: ScheduleType;
  interval_hours: number | null;
  timezone: string;
  hour: number;
  minute: number;
  day_of_week: number | null;
  day_of_month: number | null;
  mode: ScheduleMode;
  pause_on_blocked: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
}

interface PreflightCheck {
  label: string;
  status: "pass" | "warn" | "block";
  detail: string;
  cta?: { label: string; step: number };
}

interface ScheduleRun {
  id: string;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  blocked_reason_code: string | null;
  diagnostics: Record<string, any>;
}

const TIMEZONES = [
  "America/Sao_Paulo", "America/New_York", "America/Chicago",
  "America/Denver", "America/Los_Angeles", "Europe/London",
  "Europe/Paris", "Asia/Tokyo", "UTC",
];

const StepScheduling = ({ projectData, onBack, loading, saveProject, onFinalComplete }: StepSchedulingProps) => {
  const [saving, setSaving] = useState(false);
  const [loadingSchedule, setLoadingSchedule] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [detailJson, setDetailJson] = useState<string | null>(null);

  const [config, setConfig] = useState<ScheduleConfig>({
    is_enabled: false,
    schedule_type: "daily",
    interval_hours: 6,
    timezone: "America/Sao_Paulo",
    hour: 8,
    minute: 0,
    day_of_week: 1,
    day_of_month: 1,
    mode: "full",
    pause_on_blocked: true,
    next_run_at: null,
    last_run_at: null,
  });

  const projectId = projectData.id;

  // Load existing schedule
  useEffect(() => {
    if (!projectId) return;
    loadSchedule();
    loadRuns();
    runPreflight();
  }, [projectId]);

  const loadSchedule = async () => {
    if (!projectId) return;
    setLoadingSchedule(true);
    const { data } = await supabase
      .from("project_schedules" as any)
      .select("*")
      .eq("project_id", projectId)
      .maybeSingle();
    if (data) {
      const d = data as any;
      setConfig({
        is_enabled: d.is_enabled,
        schedule_type: d.schedule_type,
        interval_hours: d.interval_hours,
        timezone: d.timezone,
        hour: d.hour,
        minute: d.minute,
        day_of_week: d.day_of_week,
        day_of_month: d.day_of_month,
        mode: d.mode,
        pause_on_blocked: d.pause_on_blocked,
        next_run_at: d.next_run_at,
        last_run_at: d.last_run_at,
      });
    }
    setLoadingSchedule(false);
  };

  const loadRuns = async () => {
    if (!projectId) return;
    const { data } = await supabase
      .from("project_schedule_runs" as any)
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setRuns(data as any[]);
  };

  const runPreflight = useCallback(async () => {
    if (!projectId) return;
    const checks: PreflightCheck[] = [];

    // Check production model
    const { data: dsState } = await supabase
      .from("project_dataset_state" as any)
      .select("production_model_id, model_ready")
      .eq("project_id", projectId)
      .maybeSingle();

    const prodModelId = (dsState as any)?.production_model_id;
    checks.push({
      label: "Modelo em produção",
      status: prodModelId ? "pass" : "block",
      detail: prodModelId ? "Modelo deployado" : "Nenhum modelo em produção",
      cta: prodModelId ? undefined : { label: "Ir ao Deploy", step: 6 },
    });

    // Check dashboard_allowed via hyperparameters
    if (prodModelId) {
      const { data: model } = await supabase
        .from("project_models")
        .select("hyperparameters")
        .eq("id", prodModelId)
        .maybeSingle();
      const hp = (model?.hyperparameters as any) || {};
      const dashAllowed = hp.dashboard_allowed !== false;
      const qualityOk = hp.model_quality_flag === "ok" || hp.model_quality_flag === "pass";

      checks.push({
        label: "Dashboard permitido",
        status: dashAllowed ? "pass" : "block",
        detail: dashAllowed ? "Dashboard habilitado" : "dashboard_allowed=false",
        cta: dashAllowed ? undefined : { label: "Retreinar modelo", step: 5 },
      });

      checks.push({
        label: "Qualidade do modelo",
        status: qualityOk ? "pass" : "block",
        detail: qualityOk ? "model_quality_flag OK" : `model_quality_flag: ${hp.model_quality_flag || "unknown"}`,
        cta: qualityOk ? undefined : { label: "Retreinar modelo", step: 5 },
      });
    }

    // Check predictions exist via SSOT
    const { data: predState } = await supabase
      .from("project_prediction_state")
      .select("predictions_count, status")
      .eq("project_id", projectId)
      .maybeSingle();
    const predCount = predState?.predictions_count ?? 0;
    const predOk = predCount > 0 && (predState?.status === 'done' || predState?.status === 'sanity_fail');
    checks.push({
      label: "Previsões válidas",
      status: predOk ? "pass" : "block",
      detail: predOk ? `${predCount} previsões ativas` : "Nenhuma previsão gerada",
      cta: predOk ? undefined : { label: "Gerar previsões", step: 6 },
    });

    // Check selection version
    const { data: sel } = await supabase
      .from("project_model_selection" as any)
      .select("selection_version")
      .eq("project_id", projectId)
      .maybeSingle();
    checks.push({
      label: "Seleção configurada",
      status: sel ? "pass" : "warn",
      detail: sel ? `v${(sel as any).selection_version}` : "Sem seleção",
      cta: sel ? undefined : { label: "Ir às Variáveis", step: 4 },
    });

    setPreflightChecks(checks);
  }, [projectId]);

  const hasBlockingIssue = preflightChecks.some(c => c.status === "block");

  const handleSave = async () => {
    if (!projectId) return;
    setSaving(true);

    try {
      // Delegate next_run_at computation to backend (deterministic, timezone-safe)
      const { data, error } = await supabase.functions.invoke("upsert-schedule", {
        body: {
          project_id: projectId,
          is_enabled: config.is_enabled,
          schedule_type: config.schedule_type,
          interval_hours: config.schedule_type === "interval_hours" ? config.interval_hours : null,
          timezone: config.timezone,
          hour: config.hour,
          minute: config.minute,
          day_of_week: config.schedule_type === "weekly" ? config.day_of_week : null,
          day_of_month: config.schedule_type === "monthly" ? config.day_of_month : null,
          mode: config.mode,
          pause_on_blocked: config.pause_on_blocked,
        },
      });

      if (error) throw error;

      toast.success("Agendamento salvo com sucesso!");
      if (config.is_enabled && hasBlockingIssue) {
        toast.warning("⚠️ Agendamento ativado, mas não executará até corrigir os bloqueios identificados no preflight.");
      }
      loadSchedule();
    } catch (err: any) {
      console.error("[StepScheduling] Save error:", err);
      toast.error("Erro ao salvar agendamento: " + (err?.message || "Erro desconhecido"));
    } finally {
      setSaving(false);
    }
  };

  const handleCompleteProject = async () => {
    setCompleting(true);
    try {
      await onFinalComplete();
    } catch (error) {
      console.error("Error completing project:", error);
      toast.error("Erro ao finalizar projeto");
    } finally {
      setCompleting(false);
    }
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      DONE: { variant: "default", label: "✅ DONE" },
      RUNNING: { variant: "secondary", label: "🔄 RUNNING" },
      BLOCKED: { variant: "destructive", label: "🚫 BLOCKED" },
      ERROR: { variant: "destructive", label: "❌ ERROR" },
    };
    const m = map[status] || { variant: "outline" as const, label: status };
    return <Badge variant={m.variant}>{m.label}</Badge>;
  };

  const preflightIcon = (status: string) => {
    if (status === "pass") return <CheckCircle className="w-4 h-4 text-green-600" />;
    if (status === "warn") return <AlertTriangle className="w-4 h-4 text-yellow-600" />;
    return <XCircle className="w-4 h-4 text-destructive" />;
  };

  if (!projectId) {
    return (
      <Card className="bg-gradient-card shadow-card p-8 text-center">
        <CalendarClock className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">Projeto não encontrado.</p>
      </Card>
    );
  }

  if (loadingSchedule) {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <CalendarClock className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">Agendamento de Scoring</h2>
          <p className="text-muted-foreground">Configure execuções recorrentes automáticas de previsões</p>
        </div>

        {/* A) Toggle */}
        <div className="flex items-center justify-between p-4 border border-border rounded-xl">
          <div className="flex items-center gap-3">
            {config.is_enabled ? <Play className="w-5 h-5 text-green-600" /> : <Pause className="w-5 h-5 text-muted-foreground" />}
            <div>
              <p className="font-medium">Agendamento automático</p>
              <p className="text-sm text-muted-foreground">
                {config.is_enabled ? "Ativo — scoring será executado automaticamente" : "Desativado"}
              </p>
            </div>
          </div>
          <Switch
            checked={config.is_enabled}
            onCheckedChange={(v) => setConfig(prev => ({ ...prev, is_enabled: v }))}
          />
        </div>

        {/* B) Frequency */}
        <div className="space-y-3">
          <Label className="text-sm font-semibold">Frequência</Label>
          <RadioGroup
            value={config.schedule_type}
            onValueChange={(v) => setConfig(prev => ({ ...prev, schedule_type: v as ScheduleType }))}
            className="grid grid-cols-2 md:grid-cols-4 gap-3"
          >
            {([
              { value: "daily", label: "Diário" },
              { value: "weekly", label: "Semanal" },
              { value: "monthly", label: "Mensal" },
              { value: "interval_hours", label: "A cada X horas" },
            ] as const).map(opt => (
              <Label
                key={opt.value}
                className={`flex items-center gap-2 p-3 border rounded-lg cursor-pointer transition-colors ${
                  config.schedule_type === opt.value ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <RadioGroupItem value={opt.value} />
                {opt.label}
              </Label>
            ))}
          </RadioGroup>
        </div>

        {/* Interval hours */}
        {config.schedule_type === "interval_hours" && (
          <div className="space-y-2">
            <Label className="text-sm">Intervalo (horas)</Label>
            <Select
              value={String(config.interval_hours ?? 6)}
              onValueChange={(v) => setConfig(prev => ({ ...prev, interval_hours: Number(v) }))}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 6, 8, 12, 24].map(h => (
                  <SelectItem key={h} value={String(h)}>{h}h</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Day of week for weekly */}
        {config.schedule_type === "weekly" && (
          <div className="space-y-2">
            <Label className="text-sm">Dia da semana</Label>
            <Select
              value={String(config.day_of_week ?? 1)}
              onValueChange={(v) => setConfig(prev => ({ ...prev, day_of_week: Number(v) }))}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"].map((d, i) => (
                  <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Day of month for monthly */}
        {config.schedule_type === "monthly" && (
          <div className="space-y-2">
            <Label className="text-sm">Dia do mês</Label>
            <Select
              value={String(config.day_of_month ?? 1)}
              onValueChange={(v) => setConfig(prev => ({ ...prev, day_of_month: Number(v) }))}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                  <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* C) Time & Timezone */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label className="text-sm">Hora</Label>
            <Select
              value={String(config.hour)}
              onValueChange={(v) => setConfig(prev => ({ ...prev, hour: Number(v) }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}:00</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Minuto</Label>
            <Select
              value={String(config.minute)}
              onValueChange={(v) => setConfig(prev => ({ ...prev, minute: Number(v) }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[0, 15, 30, 45].map(m => (
                  <SelectItem key={m} value={String(m)}>{String(m).padStart(2, "0")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Timezone</Label>
            <Select
              value={config.timezone}
              onValueChange={(v) => setConfig(prev => ({ ...prev, timezone: v }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMEZONES.map(tz => (
                  <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* D) Mode */}
        <div className="space-y-3">
          <Label className="text-sm font-semibold flex items-center gap-2">
            Modo de execução
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger><Info className="w-4 h-4 text-muted-foreground" /></TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p><strong>FULL:</strong> Pontua todo o dataset ativo a cada execução.</p>
                  <p className="mt-1"><strong>INCREMENTAL:</strong> Se houver coluna temporal, pontua apenas desde a última execução. Se não houver, faz fallback para FULL.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </Label>
          <RadioGroup
            value={config.mode}
            onValueChange={(v) => setConfig(prev => ({ ...prev, mode: v as ScheduleMode }))}
            className="flex gap-4"
          >
            <Label className={`flex items-center gap-2 p-3 border rounded-lg cursor-pointer ${config.mode === "full" ? "border-primary bg-primary/5" : "border-border"}`}>
              <RadioGroupItem value="full" />
              FULL (completo)
            </Label>
            <Label className={`flex items-center gap-2 p-3 border rounded-lg cursor-pointer ${config.mode === "incremental" ? "border-primary bg-primary/5" : "border-border"}`}>
              <RadioGroupItem value="incremental" />
              INCREMENTAL
            </Label>
          </RadioGroup>
        </div>

        {/* E) Pause on blocked */}
        <div className="flex items-center justify-between p-4 bg-muted/20 border border-border rounded-lg">
          <div>
            <p className="text-sm font-medium">Pausar ao bloquear</p>
            <p className="text-xs text-muted-foreground">Se gates falharem, pausa o agendamento automaticamente</p>
          </div>
          <Switch
            checked={config.pause_on_blocked}
            onCheckedChange={(v) => setConfig(prev => ({ ...prev, pause_on_blocked: v }))}
          />
        </div>

        {/* F) Schedule Preflight */}
        <div className="border border-border rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Pré-checagem (Schedule Preflight)
            </h3>
            <Button variant="ghost" size="sm" onClick={runPreflight}>
              <RefreshCw className="w-4 h-4 mr-1" />Verificar
            </Button>
          </div>
          <div className="space-y-2">
            {preflightChecks.map((check, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-2 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2">
                  {preflightIcon(check.status)}
                  <span>{check.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{check.detail}</span>
                  {check.cta && (
                    <Button variant="outline" size="sm" className="text-xs h-6 px-2" onClick={onBack}>
                      {check.cta.label}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {hasBlockingIssue && (
            <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm text-destructive">
              ⚠️ Existem bloqueios que impedirão a execução do agendamento. Corrija antes de ativar.
            </div>
          )}
        </div>

        {/* Save */}
        <div className="flex justify-center">
          <Button onClick={handleSave} disabled={saving} className="bg-gradient-primary px-8">
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Salvando...</> : "Salvar Agendamento"}
          </Button>
        </div>

        {/* Summary */}
        {config.is_enabled && config.next_run_at && (
          <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg flex items-center gap-3">
            <Clock className="w-5 h-5 text-primary" />
            <div>
              <p className="text-sm font-medium">Próxima execução</p>
              <p className="text-sm text-muted-foreground">{new Date(config.next_run_at).toLocaleString()} ({config.timezone})</p>
            </div>
          </div>
        )}

        {/* G) History */}
        <div className="space-y-3">
          <h3 className="font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Histórico de execuções
          </h3>
          {runs.length > 0 ? (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Previsões</TableHead>
                    <TableHead>Coverage</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map(run => (
                    <TableRow key={run.id}>
                      <TableCell className="text-xs">{new Date(run.scheduled_at).toLocaleString()}</TableCell>
                      <TableCell>{statusBadge(run.status)}</TableCell>
                      <TableCell className="text-sm">{(run.diagnostics as any)?.predictions_count ?? "—"}</TableCell>
                      <TableCell className="text-sm">
                        {(run.diagnostics as any)?.coverage_pct != null
                          ? `${Number((run.diagnostics as any).coverage_pct).toFixed(1)}%`
                          : "—"
                        }
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{run.blocked_reason_code || "—"}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => setDetailJson(detailJson === run.id ? null : run.id)}
                        >
                          <Eye className="w-3 h-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {detailJson && (
                <div className="mt-2 p-3 bg-muted/20 rounded-lg">
                  <pre className="text-xs overflow-auto max-h-40 font-mono">
                    {JSON.stringify(runs.find(r => r.id === detailJson)?.diagnostics, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">Nenhuma execução agendada registrada.</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || completing}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Voltar
          </Button>
          <Button
            onClick={handleCompleteProject}
            disabled={loading || completing}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {completing ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Finalizando...</>
            ) : (
              <><CheckCircle className="w-4 h-4 mr-2" />Finalizar Projeto</>
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepScheduling;
