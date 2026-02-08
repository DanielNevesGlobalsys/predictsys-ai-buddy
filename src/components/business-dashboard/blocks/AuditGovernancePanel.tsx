import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import {
  Shield, Database, BarChart3, Brain, CheckCircle, XCircle,
  AlertTriangle, FileText, Cpu, Layers
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import type { ProjectStage } from './BlockATrustVision';

interface AuditGovernancePanelProps {
  projectId: string;
  problemType: string;
  projectStage: ProjectStage;
  modelQualityFlag: string | null;
}

interface AuditData {
  // Dataset
  totalRows: number | null;
  columnsCount: number | null;
  sampleRows: number | null;
  // Model
  algorithmName: string | null;
  hyperparameters: Record<string, any> | null;
  metrics: Record<string, number>;
  baselineMetrics: Record<string, number>;
  // Validations
  preflightReport: Record<string, any> | null;
  modelQualityFlag: string | null;
  predictionSanity: Record<string, any> | null;
  splitStrategy: string | null;
  sampleStrategy: string | null;
  trainRowsUsed: number | null;
  featuresBlocked: string[];
  // Score
  predictionsCount: number;
  scoreCoveragePct: number | null;
}

export function AuditGovernancePanel({
  projectId,
  problemType,
  projectStage,
  modelQualityFlag,
}: AuditGovernancePanelProps) {
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [modelRes, datasetRes, predictionsRes, aiCtxRes] = await Promise.all([
          supabase
            .from('project_models')
            .select('algorithm_name, hyperparameters')
            .eq('project_id', projectId)
            .eq('is_production', true)
            .eq('status', 'trained')
            .maybeSingle(),
          supabase
            .from('project_datasets')
            .select('total_rows, columns_count, sample_rows')
            .eq('project_id', projectId)
            .eq('is_active', true)
            .maybeSingle(),
          supabase
            .from('predictions')
            .select('id', { count: 'exact', head: true })
            .eq('project_id', projectId)
            .eq('is_latest', true),
          supabase
            .from('project_ai_context')
            .select('context')
            .eq('project_id', projectId)
            .maybeSingle(),
        ]);

        // Get metrics for production model
        let metrics: Record<string, number> = {};
        if (modelRes.data) {
          const { data: metricsData } = await supabase
            .from('project_model_metrics')
            .select('metric_name, metric_value')
            .eq('project_model_id', (modelRes.data as any).id || '');

          // We need the model id - re-fetch with id
          const { data: modelWithId } = await supabase
            .from('project_models')
            .select('id, algorithm_name, hyperparameters')
            .eq('project_id', projectId)
            .eq('is_production', true)
            .eq('status', 'trained')
            .maybeSingle();

          if (modelWithId) {
            const { data: mm } = await supabase
              .from('project_model_metrics')
              .select('metric_name, metric_value')
              .eq('project_model_id', modelWithId.id);
            if (mm) {
              mm.forEach(({ metric_name, metric_value }) => {
                metrics[metric_name] = metric_value;
              });
            }
          }
        }

        const hp = (modelRes.data?.hyperparameters as Record<string, any>) || {};
        const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
        const scoreReport = aiCtx?.predictions?.score_report;

        setAudit({
          totalRows: datasetRes.data?.total_rows ?? null,
          columnsCount: datasetRes.data?.columns_count ?? null,
          sampleRows: datasetRes.data?.sample_rows ?? null,
          algorithmName: modelRes.data?.algorithm_name ?? null,
          hyperparameters: hp,
          metrics,
          baselineMetrics: hp?.baseline_metrics || {},
          preflightReport: hp?.preflight_report || null,
          modelQualityFlag: hp?.model_quality_flag || modelQualityFlag,
          predictionSanity: hp?.prediction_sanity || null,
          splitStrategy: hp?.split_strategy || null,
          sampleStrategy: hp?.sample_strategy || null,
          trainRowsUsed: hp?.sample_size_final || hp?.train_rows_used || null,
          featuresBlocked: hp?.features_blocked || [],
          predictionsCount: predictionsRes.count ?? 0,
          scoreCoveragePct: scoreReport?.coverage_pct ?? null,
        });
      } catch (err) {
        console.error('[AuditGovernancePanel] Error:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [projectId, modelQualityFlag]);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Carregando auditoria…
        </CardContent>
      </Card>
    );
  }

  if (!audit) return null;

  const stageConfig = {
    decisorio: { label: 'Decisório', color: 'text-green-600', icon: CheckCircle },
    exploratorio: { label: 'Exploratório', color: 'text-yellow-600', icon: AlertTriangle },
    nao_confiavel: { label: 'Não confiável', color: 'text-destructive', icon: XCircle },
  };
  const sc = stageConfig[projectStage];

  const guardrails: { label: string; status: 'pass' | 'fail' | 'warn' | 'unknown' }[] = [
    {
      label: 'Qualidade do modelo',
      status: audit.modelQualityFlag === 'pass' ? 'pass' : audit.modelQualityFlag === 'fail' ? 'fail' : 'unknown',
    },
    {
      label: 'Sanidade das previsões',
      status: audit.predictionSanity?.passed === true ? 'pass' : audit.predictionSanity?.passed === false ? 'fail' : 'unknown',
    },
    {
      label: 'Cobertura do score',
      status: audit.scoreCoveragePct !== null
        ? audit.scoreCoveragePct >= 95 ? 'pass' : audit.scoreCoveragePct >= 50 ? 'warn' : 'fail'
        : 'unknown',
    },
    {
      label: 'Baseline superado',
      status: Object.keys(audit.baselineMetrics).length > 0 ? 'pass' : 'unknown',
    },
  ];

  const statusIcon = (s: string) => {
    if (s === 'pass') return <CheckCircle className="w-4 h-4 text-green-600" />;
    if (s === 'fail') return <XCircle className="w-4 h-4 text-destructive" />;
    if (s === 'warn') return <AlertTriangle className="w-4 h-4 text-yellow-600" />;
    return <AlertTriangle className="w-4 h-4 text-muted-foreground" />;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5" />
          Auditoria & Governança — Lys
        </CardTitle>
        <CardDescription>
          Painel técnico e executivo com transparência completa do pipeline
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" defaultValue={['executive']} className="space-y-2">
          {/* 1. Executive Audit */}
          <AccordionItem value="executive" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Auditoria Executiva
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              {/* Status */}
              <div className="flex items-center gap-3">
                <sc.icon className={cn('w-5 h-5', sc.color)} />
                <span className="font-semibold">{sc.label}</span>
              </div>

              {/* Guardrails */}
              <div className="grid grid-cols-2 gap-2">
                {guardrails.map((g) => (
                  <div key={g.label} className="flex items-center gap-2 text-sm">
                    {statusIcon(g.status)}
                    <span>{g.label}</span>
                  </div>
                ))}
              </div>

              {/* Risks */}
              {audit.predictionSanity?.passed === false && (
                <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm">
                  <strong>Risco:</strong> Previsões degeneradas detectadas.{' '}
                  {audit.predictionSanity.reasons?.join('. ')}
                </div>
              )}

              {audit.modelQualityFlag === 'fail' && (
                <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm">
                  <strong>Bloqueio:</strong> Modelo reprovado — desempenho inferior ao baseline.
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* 2. Dataset Stats */}
          <AccordionItem value="dataset" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4" />
                Estatísticas do Dataset
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Total de Linhas</p>
                  <p className="font-semibold">{audit.totalRows?.toLocaleString() ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Colunas</p>
                  <p className="font-semibold">{audit.columnsCount ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Amostra (EDA)</p>
                  <p className="font-semibold">{audit.sampleRows?.toLocaleString() ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Linhas no Treino</p>
                  <p className="font-semibold">{audit.trainRowsUsed?.toLocaleString() ?? '—'}</p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 3. Predictive Engine */}
          <AccordionItem value="engine" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4" />
                Motor Preditivo
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Algoritmo</p>
                  <p className="font-semibold">{audit.algorithmName ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Split</p>
                  <p className="font-semibold">{audit.splitStrategy ?? 'random'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Sampling</p>
                  <p className="font-semibold">{audit.sampleStrategy ?? 'full'}</p>
                </div>
              </div>

              {/* Metrics */}
              {Object.keys(audit.metrics).length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2 font-medium">Métricas do Modelo</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(audit.metrics).map(([k, v]) => (
                      <Badge key={k} variant="outline" className="font-mono text-xs">
                        {k}: {typeof v === 'number' ? v.toFixed(4) : v}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Baseline */}
              {Object.keys(audit.baselineMetrics).length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2 font-medium">Baseline</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(audit.baselineMetrics).map(([k, v]) => (
                      <Badge key={k} variant="secondary" className="font-mono text-xs">
                        {k}: {typeof v === 'number' ? v.toFixed(4) : v}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* 4. Validations */}
          <AccordionItem value="validations" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4" />
                Validações Automáticas
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2 space-y-3">
              {audit.preflightReport && (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {audit.preflightReport.target_validity !== undefined && (
                    <div className="flex items-center gap-2">
                      {audit.preflightReport.target_validity ? statusIcon('pass') : statusIcon('fail')}
                      <span>Target válido</span>
                    </div>
                  )}
                  {audit.preflightReport.feature_validity !== undefined && (
                    <div className="flex items-center gap-2">
                      {audit.preflightReport.feature_validity ? statusIcon('pass') : statusIcon('fail')}
                      <span>Features válidas</span>
                    </div>
                  )}
                  {audit.preflightReport.leak_checks !== undefined && (
                    <div className="flex items-center gap-2">
                      {audit.preflightReport.leak_checks ? statusIcon('pass') : statusIcon('warn')}
                      <span>Leakage check</span>
                    </div>
                  )}
                </div>
              )}

              {audit.featuresBlocked.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Colunas bloqueadas:</p>
                  <div className="flex flex-wrap gap-1">
                    {audit.featuresBlocked.map((f) => (
                      <Badge key={f} variant="destructive" className="text-[10px]">
                        {f}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Score report */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Previsões geradas</p>
                  <p className="font-semibold">{audit.predictionsCount.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Cobertura</p>
                  <p className="font-semibold">
                    {audit.scoreCoveragePct !== null ? `${audit.scoreCoveragePct.toFixed(1)}%` : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Quality flag</p>
                  <p className="font-semibold">{audit.modelQualityFlag ?? '—'}</p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
