import { useState, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import {
  Shield, Database, BarChart3, Brain, CheckCircle, XCircle,
  AlertTriangle, FileText, Cpu, Layers, Target, Rocket,
  RefreshCw, ClipboardCopy, Clock, GitBranch, Activity
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { ProjectStage } from './BlockATrustVision';
import type { SSOTData } from '../hooks/useDashboardState';

interface AuditGovernancePanelProps {
  projectId: string;
  problemType: string;
  projectStage: ProjectStage;
  modelQualityFlag: string | null;
  ssot: SSOTData;
}

export function AuditGovernancePanel({
  projectId,
  problemType,
  projectStage,
  modelQualityFlag,
  ssot,
}: AuditGovernancePanelProps) {
  const [copiedDiag, setCopiedDiag] = useState(false);

  const stageConfig = {
    decisorio: { label: 'Decisório', color: 'text-green-600', icon: CheckCircle },
    exploratorio: { label: 'Exploratório', color: 'text-yellow-600', icon: AlertTriangle },
    nao_confiavel: { label: 'Não confiável', color: 'text-destructive', icon: XCircle },
  };
  const sc = stageConfig[projectStage];

  const statusIcon = (s: string) => {
    if (s === 'pass') return <CheckCircle className="w-4 h-4 text-green-600" />;
    if (s === 'fail') return <XCircle className="w-4 h-4 text-destructive" />;
    if (s === 'warn') return <AlertTriangle className="w-4 h-4 text-yellow-600" />;
    return <AlertTriangle className="w-4 h-4 text-muted-foreground" />;
  };

  const boolIcon = (val: boolean | null | undefined) => {
    if (val === true) return <CheckCircle className="w-4 h-4 text-green-600" />;
    if (val === false) return <XCircle className="w-4 h-4 text-destructive" />;
    return <AlertTriangle className="w-4 h-4 text-muted-foreground" />;
  };

  const handleCopyDiagnostic = useCallback(() => {
    const diagnostic = {
      project_id: projectId,
      timestamp: new Date().toISOString(),
      stage: projectStage,
      dataset_state: ssot.datasetState,
      score_report: ssot.scoreReport,
      scoring_job: ssot.scoringJob,
      model_selection: ssot.modelSelection,
      modeling_contract: ssot.modelingContract,
      modeling_dataset: ssot.modelingDataset,
      production_model: ssot.productionModel ? {
        ...ssot.productionModel,
        hyperparameters: undefined, // omit large data
      } : null,
      intent: ssot.intent,
    };
    navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
    setCopiedDiag(true);
    toast.success('Diagnóstico copiado para a área de transferência');
    setTimeout(() => setCopiedDiag(false), 2000);
  }, [projectId, projectStage, ssot]);

  // Guardrails
  const guardrails: { label: string; status: 'pass' | 'fail' | 'warn' | 'unknown' }[] = [
    {
      label: 'Qualidade do modelo',
      status: ssot.productionModel?.model_quality_flag === 'ok' || ssot.productionModel?.model_quality_flag === 'pass' ? 'pass' 
        : ssot.productionModel?.model_quality_flag === 'fail' ? 'fail' : 'unknown',
    },
    {
      label: 'Sanidade das previsões',
      status: ssot.productionModel?.prediction_sanity?.passed === true ? 'pass' 
        : ssot.productionModel?.prediction_sanity?.passed === false ? 'fail' : 'unknown',
    },
    {
      label: 'Cobertura do score',
      status: ssot.scoreReport
        ? ssot.scoreReport.coverage_pct >= 95 ? 'pass' : ssot.scoreReport.coverage_pct >= 50 ? 'warn' : 'fail'
        : 'unknown',
    },
    {
      label: 'Baseline superado',
      status: Object.keys(ssot.productionModel?.baseline_metrics || {}).length > 0 ? 'pass' : 'unknown',
    },
    {
      label: 'Dashboard permitido',
      status: ssot.productionModel?.dashboard_allowed ? 'pass' : ssot.productionModel ? 'fail' : 'unknown',
    },
  ];

  const relevantActions = [
    'intent_defined', 'dataset_imported', 'builder_executed',
    'training_completed', 'deploy_completed', 'scoring_completed',
    'scoring_job_completed', 'dashboard_blocked', 'model_promoted',
  ];
  const filteredLogs = ssot.recentAuditLogs
    .filter(l => relevantActions.some(a => l.action.includes(a) || l.resource_type.includes(a)))
    .slice(0, 10);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Auditoria & Governança — Lys
            </CardTitle>
            <CardDescription>
              Painel técnico e executivo com transparência completa do pipeline
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={handleCopyDiagnostic} className="gap-2">
            {copiedDiag ? <CheckCircle className="w-4 h-4" /> : <ClipboardCopy className="w-4 h-4" />}
            {copiedDiag ? 'Copiado!' : 'Copiar diagnóstico'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" defaultValue={['executive']} className="space-y-2">
          {/* A) Executive Audit */}
          <AccordionItem value="executive" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Auditoria Executiva
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              <div className="flex items-center gap-3">
                <sc.icon className={cn('w-5 h-5', sc.color)} />
                <span className="font-semibold">{sc.label}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {guardrails.map((g) => (
                  <div key={g.label} className="flex items-center gap-2 text-sm">
                    {statusIcon(g.status)}
                    <span>{g.label}</span>
                  </div>
                ))}
              </div>
              {ssot.productionModel?.prediction_sanity?.passed === false && (
                <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm">
                  <strong>Risco:</strong> Previsões degeneradas detectadas.{' '}
                  {ssot.productionModel.prediction_sanity.reasons?.join('. ')}
                </div>
              )}
              {ssot.productionModel?.model_quality_flag === 'fail' && (
                <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm">
                  <strong>Bloqueio:</strong> Modelo reprovado — desempenho inferior ao baseline.
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* B) Dataset State (SSOT) */}
          <AccordionItem value="dataset-ssot" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4" />
                Dataset State (SSOT)
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              {ssot.datasetState ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Origem</p>
                    <p className="font-semibold">{ssot.datasetState.source_type}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Linhas</p>
                    <p className="font-semibold">{ssot.datasetState.row_count.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Colunas</p>
                    <p className="font-semibold">{ssot.datasetState.col_count}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Manifesto Virtual</p>
                    <p className="font-semibold">{ssot.datasetState.virtual_manifest ? 'Sim' : 'Não'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {boolIcon(ssot.datasetState.eda_ready)}
                    <span className="text-xs">EDA Ready</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {boolIcon(ssot.datasetState.model_ready)}
                    <span className="text-xs">Model Ready</span>
                  </div>
                  <div className="col-span-2">
                    <p className="text-xs text-muted-foreground">Production Model ID</p>
                    <p className="font-mono text-xs truncate">{ssot.datasetState.production_model_id || '—'}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Dataset state não encontrado.</p>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* C) Intent Contract */}
          <AccordionItem value="intent" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4" />
                Intent Contract
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              {ssot.intent ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Tipo de Problema</p>
                    <p className="font-semibold">{ssot.intent.problem_type || problemType}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Janela (dias)</p>
                    <p className="font-semibold">{ssot.intent.window_days ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Métricas Recomendadas</p>
                    <div className="flex flex-wrap gap-1">
                      {ssot.intent.recommended_metrics.length > 0 
                        ? ssot.intent.recommended_metrics.map(m => <Badge key={m} variant="outline" className="text-[10px]">{m}</Badge>)
                        : <span className="text-muted-foreground">—</span>
                      }
                    </div>
                  </div>
                  {ssot.intent.guardrails.length > 0 && (
                    <div className="col-span-full">
                      <p className="text-xs text-muted-foreground mb-1">Guardrails</p>
                      <div className="flex flex-wrap gap-1">
                        {ssot.intent.guardrails.map((g, i) => <Badge key={i} variant="secondary" className="text-[10px]">{g}</Badge>)}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Intent não definido.</p>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* D) Model Selection */}
          <AccordionItem value="selection" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4" />
                Model Selection
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              {ssot.modelSelection ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Selection Version</p>
                    <p className="font-semibold">v{ssot.modelSelection.selection_version}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Target</p>
                    <p className="font-semibold">{ssot.modelSelection.target_column || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Target Hash</p>
                    <p className="font-mono text-xs truncate">{ssot.modelSelection.target_hash || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Features</p>
                    <p className="font-semibold">{ssot.modelSelection.features_count}</p>
                  </div>
                  {ssot.modelingDataset?.selection_version_used != null && (
                    <div className="col-span-full flex items-center gap-2">
                      {ssot.modelingDataset.selection_version_used === ssot.modelSelection.selection_version
                        ? <><CheckCircle className="w-4 h-4 text-green-600" /><span className="text-sm">Builder sincronizado (v{ssot.modelingDataset.selection_version_used})</span></>
                        : <><AlertTriangle className="w-4 h-4 text-yellow-600" /><span className="text-sm text-yellow-600">Builder desatualizado (v{ssot.modelingDataset.selection_version_used} ≠ v{ssot.modelSelection.selection_version})</span></>
                      }
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Seleção de target/features não configurada.</p>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* E) Feature Builder Report */}
          <AccordionItem value="builder" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4" />
                Feature Builder Report
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2 space-y-3">
              {ssot.modelingContract ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Status</p>
                      <Badge variant={ssot.modelingContract.status === 'approved' ? 'default' : 'destructive'} className="text-xs">
                        {ssot.modelingContract.status.toUpperCase()}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Features Finais</p>
                      <p className="font-semibold">{ssot.modelingContract.features_final_count}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Bloqueadas</p>
                      <p className="font-semibold text-destructive">{ssot.modelingContract.features_blocked_count}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Leakage Flags</p>
                      <p className="font-semibold">{ssot.modelingContract.leakage_flags_count}</p>
                    </div>
                  </div>
                  {ssot.modelingDataset && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Missing Feature %</p>
                        <p className="font-semibold">{ssot.modelingDataset.missing_feature_pct.toFixed(1)}%</p>
                      </div>
                      {ssot.modelingDataset.overfit_risk_score != null && (
                        <div>
                          <p className="text-xs text-muted-foreground">Overfit Risk</p>
                          <p className="font-semibold">{ssot.modelingDataset.overfit_risk_score.toFixed(2)}</p>
                        </div>
                      )}
                    </div>
                  )}
                  {ssot.modelingContract.blocked_reasons && ssot.modelingContract.blocked_reasons.length > 0 && (
                    <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm">
                      <strong>Motivos de bloqueio:</strong>
                      <ul className="list-disc list-inside mt-1">
                        {ssot.modelingContract.blocked_reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Contrato de modelagem não encontrado.</p>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* F) Training Report */}
          <AccordionItem value="training" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4" />
                Training Report
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2 space-y-3">
              {ssot.productionModel ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Algoritmo</p>
                      <p className="font-semibold">{ssot.productionModel.algorithm_name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Split</p>
                      <p className="font-semibold">{ssot.modelingContract?.split_strategy || ssot.productionModel.hyperparameters?.split_strategy || 'random'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Quality Flag</p>
                      <Badge variant={ssot.productionModel.model_quality_flag === 'ok' || ssot.productionModel.model_quality_flag === 'pass' ? 'default' : 'destructive'} className="text-xs">
                        {ssot.productionModel.model_quality_flag || '—'}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      {boolIcon(ssot.productionModel.can_promote)}
                      <span className="text-xs">Can Promote</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {boolIcon(ssot.productionModel.dashboard_allowed)}
                      <span className="text-xs">Dashboard Allowed</span>
                    </div>
                  </div>
                  {/* Baseline comparison */}
                  {Object.keys(ssot.productionModel.baseline_metrics).length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2 font-medium">Baseline vs Modelo</p>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(ssot.productionModel.baseline_metrics).map(([k, v]) => {
                          const imp = ssot.productionModel?.improvement_vs_baseline?.[k];
                          return (
                            <Badge key={k} variant="outline" className="font-mono text-xs">
                              {k}: {typeof v === 'number' ? v.toFixed(4) : v}
                              {imp != null && <span className={cn('ml-1', imp > 0 ? 'text-green-600' : 'text-destructive')}>
                                ({imp > 0 ? '+' : ''}{typeof imp === 'number' ? imp.toFixed(4) : imp})
                              </span>}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhum modelo em produção.</p>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* G) Deploy Status */}
          <AccordionItem value="deploy" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Rocket className="w-4 h-4" />
                Deploy Status
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              {ssot.productionModel ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <Badge variant="default" className="text-xs bg-green-600">DEPLOYED</Badge>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Deployed At</p>
                    <p className="font-semibold">{ssot.productionModel.deployed_at ? new Date(ssot.productionModel.deployed_at).toLocaleString() : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Selection Version</p>
                    <p className="font-semibold">v{ssot.productionModel.deployed_selection_version ?? '—'}</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <XCircle className="w-4 h-4 text-destructive" />
                  <span>Nenhum modelo deployado.</span>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* H) Scoring Report */}
          <AccordionItem value="scoring" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Scoring Report
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2 space-y-3">
              {ssot.scoreReport ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <Badge variant={ssot.scoreReport.status === 'DONE' ? 'default' : 'secondary'} className="text-xs">
                      {ssot.scoreReport.status}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Predictions</p>
                    <p className="font-semibold">{ssot.scoreReport.predictions_count.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Coverage</p>
                    <p className="font-semibold">{ssot.scoreReport.coverage_pct.toFixed(1)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Missing Feature %</p>
                    <p className="font-semibold">{ssot.scoreReport.missing_feature_pct.toFixed(1)}%</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-xs text-muted-foreground">Batch ID</p>
                    <p className="font-mono text-xs truncate">{ssot.scoreReport.batch_id || '—'}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-xs text-muted-foreground">Data</p>
                    <p className="font-semibold">{new Date(ssot.scoreReport.created_at).toLocaleString()}</p>
                  </div>
                  {ssot.scoreReport.warnings.length > 0 && (
                    <div className="col-span-full">
                      <p className="text-xs text-muted-foreground mb-1">Warnings</p>
                      <div className="flex flex-wrap gap-1">
                        {ssot.scoreReport.warnings.map((w, i) => <Badge key={i} variant="secondary" className="text-[10px]">{w}</Badge>)}
                      </div>
                    </div>
                  )}
                </div>
              ) : ssot.scoringJob ? (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Último Job</p>
                    <Badge variant="secondary" className="text-xs">{ssot.scoringJob.status}</Badge>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Iniciado em</p>
                    <p className="font-semibold">{new Date(ssot.scoringJob.started_at).toLocaleString()}</p>
                  </div>
                  {ssot.scoringJob.error_friendly && (
                    <div className="col-span-full p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm">
                      {ssot.scoringJob.error_friendly}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhum scoring executado.</p>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* I) Audit Log */}
          <AccordionItem value="audit-log" className="border rounded-lg px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Audit Log
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              {filteredLogs.length > 0 ? (
                <div className="space-y-2">
                  {filteredLogs.map((log, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm py-1 border-b border-border/50 last:border-0">
                      <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[130px]">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{log.resource_type}</Badge>
                      <span className="text-sm">{log.action}</span>
                    </div>
                  ))}
                </div>
              ) : ssot.recentAuditLogs.length > 0 ? (
                <div className="space-y-2">
                  {ssot.recentAuditLogs.slice(0, 10).map((log, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm py-1 border-b border-border/50 last:border-0">
                      <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[130px]">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{log.resource_type}</Badge>
                      <span className="text-sm">{log.action}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhum evento de auditoria encontrado.</p>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
