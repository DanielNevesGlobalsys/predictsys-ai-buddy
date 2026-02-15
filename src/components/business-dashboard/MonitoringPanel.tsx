import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ShieldCheck, ShieldAlert, AlertTriangle, CheckCircle, XCircle,
  RefreshCw, Loader2, ChevronDown, Activity, Info,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface MonitoringCheck {
  check: string;
  status: 'PASS' | 'WARN' | 'ALERT' | 'FAIL';
  message: string;
  value?: number | string | null;
  threshold?: string;
}

interface MonitoringCTA {
  label: string;
  action: string;
  step?: number;
}

interface MonitoringState {
  status: string;
  monitoring_score: number;
  checks: MonitoringCheck[];
  last_run_at: string | null;
  latest_batch_id: string | null;
}

interface MonitoringPanelProps {
  projectId: string;
}

const CHECK_LABELS: Record<string, string> = {
  COVERAGE_CHECK: 'Cobertura de Scoring',
  SANITY_CHECK: 'Sanidade das Previsões',
  DATA_DRIFT_CHECK: 'Drift de Dados (PSI)',
  VERSION_DRIFT_CHECK: 'Versão do Modelo',
  HEALTH_COMPLIANCE_CHECK: 'Compliance (Saúde)',
};

const STATUS_CONFIG = {
  ok: { icon: ShieldCheck, color: 'text-emerald-600', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Saudável' },
  warn: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-500/10', border: 'border-amber-500/20', label: 'Atenção' },
  alert: { icon: ShieldAlert, color: 'text-destructive', bg: 'bg-destructive/10', border: 'border-destructive/20', label: 'Alerta' },
  failed: { icon: XCircle, color: 'text-destructive', bg: 'bg-destructive/10', border: 'border-destructive/20', label: 'Falha' },
};

const CHECK_STATUS_ICON = {
  PASS: { icon: CheckCircle, color: 'text-emerald-600' },
  WARN: { icon: AlertTriangle, color: 'text-amber-600' },
  ALERT: { icon: ShieldAlert, color: 'text-destructive' },
  FAIL: { icon: XCircle, color: 'text-destructive' },
};

export function MonitoringPanel({ projectId }: MonitoringPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<MonitoringState | null>(null);
  const [ctas, setCtas] = useState<MonitoringCTA[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);

  const fetchState = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('project_monitoring_state')
        .select('*')
        .eq('project_id', projectId)
        .maybeSingle();

      if (error) {
        console.error('Error fetching monitoring state:', error);
        setState(null);
      } else if (data) {
        setState({
          status: data.status,
          monitoring_score: data.monitoring_score,
          checks: (data.checks as unknown as MonitoringCheck[]) || [],
          last_run_at: data.last_run_at,
          latest_batch_id: data.latest_batch_id,
        });
      } else {
        setState(null);
      }
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchState(); }, [fetchState]);

  const runChecks = useCallback(async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke('run-monitoring-checks', {
        body: { project_id: projectId },
      });
      if (error) {
        toast.error('Erro ao executar monitoramento');
        return;
      }
      if (data?.success) {
        setState({
          status: data.status,
          monitoring_score: data.monitoring_score,
          checks: data.checks || [],
          last_run_at: data.last_run_at,
          latest_batch_id: null,
        });
        setCtas(data.ctas || []);
        toast.success(`Monitoramento concluído: ${data.status.toUpperCase()} (score: ${data.monitoring_score})`);
      } else {
        toast.error(data?.error || 'Erro no monitoramento');
      }
    } catch (err) {
      toast.error('Erro inesperado');
    } finally {
      setRunning(false);
    }
  }, [projectId]);

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      </Card>
    );
  }

  if (!state) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
              <Activity className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">Saúde do Modelo</h3>
              <p className="text-xs text-muted-foreground">Monitoramento não executado</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={runChecks} disabled={running} className="gap-2">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Executar
          </Button>
        </div>
      </Card>
    );
  }

  const config = STATUS_CONFIG[state.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.ok;
  const StatusIcon = config.icon;
  const scoreColor = state.monitoring_score >= 80 ? 'text-emerald-600' : state.monitoring_score >= 50 ? 'text-amber-600' : 'text-destructive';
  const progressColor = state.monitoring_score >= 80 ? '[&>div]:bg-emerald-500' : state.monitoring_score >= 50 ? '[&>div]:bg-amber-500' : '[&>div]:bg-destructive';

  const nonPassChecks = state.checks.filter(c => c.status !== 'PASS');
  const passChecks = state.checks.filter(c => c.status === 'PASS');

  return (
    <Card className={`border ${config.border}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg ${config.bg} flex items-center justify-center`}>
              <StatusIcon className={`w-5 h-5 ${config.color}`} />
            </div>
            <div>
              <CardTitle className="text-base">Saúde do Modelo</CardTitle>
              <div className="flex items-center gap-2 mt-0.5">
                <Badge variant="outline" className={`text-xs ${config.color}`}>{config.label}</Badge>
                {state.last_run_at && (
                  <span className="text-xs text-muted-foreground">
                    Última verificação: {new Date(state.last_run_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <span className={`text-2xl font-bold ${scoreColor}`}>{state.monitoring_score}</span>
              <span className="text-xs text-muted-foreground">/100</span>
            </div>
            <Button variant="ghost" size="sm" onClick={runChecks} disabled={running} className="gap-1">
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        <Progress value={state.monitoring_score} className={`h-1.5 mt-3 ${progressColor}`} />
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Non-pass checks first */}
        {nonPassChecks.length > 0 && (
          <div className="space-y-2">
            {nonPassChecks.map((check, i) => {
              const checkConf = CHECK_STATUS_ICON[check.status];
              const Icon = checkConf.icon;
              return (
                <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-muted/50">
                  <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${checkConf.color}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{CHECK_LABELS[check.check] || check.check}</p>
                    <p className="text-xs text-muted-foreground">{check.message}</p>
                  </div>
                  <Badge variant="outline" className={`text-xs flex-shrink-0 ${checkConf.color}`}>{check.status}</Badge>
                </div>
              );
            })}
          </div>
        )}

        {/* CTAs */}
        {ctas.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {ctas.map((cta, i) => (
              <Button key={i} variant="outline" size="sm" className="text-xs gap-1">
                <Info className="w-3 h-3" />
                {cta.label}
              </Button>
            ))}
          </div>
        )}

        {/* Pass checks collapsed */}
        {passChecks.length > 0 && (
          <Collapsible open={checksOpen} onOpenChange={setChecksOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <ChevronDown className={`w-3 h-3 transition-transform ${checksOpen ? 'rotate-180' : ''}`} />
              {passChecks.length} verificação(ões) OK
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-1">
              {passChecks.map((check, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle className="w-3 h-3 text-emerald-600 flex-shrink-0" />
                  <span>{CHECK_LABELS[check.check] || check.check}: {check.message}</span>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Health compliance disclaimer */}
        {state.checks.some(c => c.check === 'HEALTH_COMPLIANCE_CHECK') && (
          <div className="p-2 rounded bg-muted/30 border border-border text-xs text-muted-foreground flex items-start gap-2">
            <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span>Este modelo é uma ferramenta de apoio operacional. Não substitui diagnóstico ou decisão médica profissional.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
