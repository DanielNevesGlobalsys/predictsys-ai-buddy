import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Info, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { KPIData } from '../types';

export type ProjectStage = 'decisorio' | 'exploratorio' | 'nao_confiavel';

export interface BlockATrustVisionProps {
  problemType: string;
  inferredProblemType?: string;
  modelQualityFlag: string | null;
  scoreCoveragePct: number | null;
  mainMetric: { name: string; value: number } | null;
  baselineMetric: { name: string; value: number } | null;
  predictionsCount: number;
  totalEntities: number;
  projectName?: string;
}

function determineProjectStage(
  modelQualityFlag: string | null,
  scoreCoveragePct: number | null,
  mainMetric: { name: string; value: number } | null,
  baselineMetric: { name: string; value: number } | null,
  predictionsCount: number,
  problemType: string,
): ProjectStage {
  // Não confiável: model fail, no model, or very low coverage
  if (modelQualityFlag === 'fail') return 'nao_confiavel';
  if (!mainMetric) return 'nao_confiavel';
  if (predictionsCount === 0) return 'nao_confiavel';

  // Check baseline
  if (baselineMetric && mainMetric) {
    if (problemType === 'regression' && mainMetric.value < 0) return 'nao_confiavel';
    if (problemType === 'classification' && mainMetric.value < 0.55) return 'nao_confiavel';
  }

  // Exploratório: partial coverage or marginal quality
  if (scoreCoveragePct !== null && scoreCoveragePct < 95) return 'exploratorio';
  if (problemType === 'regression' && mainMetric.value < 0.3) return 'exploratorio';
  if (problemType === 'classification' && mainMetric.value < 0.7) return 'exploratorio';

  return 'decisorio';
}

const STAGE_CONFIG = {
  decisorio: {
    icon: ShieldCheck,
    label: 'Decisório',
    color: 'text-green-600',
    bgColor: 'bg-green-600/10',
    borderColor: 'border-green-600/30',
    badgeVariant: 'default' as const,
    badgeClass: 'bg-green-600 hover:bg-green-700',
  },
  exploratorio: {
    icon: ShieldQuestion,
    label: 'Exploratório',
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-600/10',
    borderColor: 'border-yellow-600/30',
    badgeVariant: 'secondary' as const,
    badgeClass: 'bg-yellow-600 text-white hover:bg-yellow-700',
  },
  nao_confiavel: {
    icon: ShieldAlert,
    label: 'Não confiável',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
    borderColor: 'border-destructive/30',
    badgeVariant: 'destructive' as const,
    badgeClass: '',
  },
};

const USAGE_DECLARATIONS: Record<ProjectStage, string> = {
  decisorio:
    'Este projeto está em estágio decisório. As previsões podem ser usadas para priorização, segmentação e cálculo de impacto financeiro com confiança razoável.',
  exploratorio:
    'Este projeto está em estágio exploratório. As previsões podem ser usadas para análise e aprendizado, mas NÃO devem ser base para decisões operacionais, cálculo de ROI ou priorização individual.',
  nao_confiavel:
    'Este projeto NÃO é confiável para uso em decisões. O modelo não supera o baseline ou apresenta falhas de qualidade. Revise o target, as features e re-treine antes de utilizar os resultados.',
};

export function BlockATrustVision({
  problemType,
  inferredProblemType,
  modelQualityFlag,
  scoreCoveragePct,
  mainMetric,
  baselineMetric,
  predictionsCount,
  totalEntities,
}: BlockATrustVisionProps) {
  const { t } = useTranslation();

  const stage = useMemo(
    () =>
      determineProjectStage(
        modelQualityFlag,
        scoreCoveragePct,
        mainMetric,
        baselineMetric,
        predictionsCount,
        problemType,
      ),
    [modelQualityFlag, scoreCoveragePct, mainMetric, baselineMetric, predictionsCount, problemType],
  );

  const config = STAGE_CONFIG[stage];
  const StageIcon = config.icon;

  const problemTypeLabel =
    problemType === 'classification'
      ? 'Classificação'
      : problemType === 'regression'
      ? 'Regressão'
      : 'Série Temporal';

  const effectiveProblemLabel = inferredProblemType || problemTypeLabel;

  const getMetricInterpretation = () => {
    if (!mainMetric) return 'Sem métrica disponível — modelo não treinado ou não promovido.';
    const { name, value } = mainMetric;
    if (problemType === 'regression') {
      if (value < 0) return `${name} = ${value.toFixed(3)} — O modelo é pior que prever a média. Não confiável.`;
      if (value < 0.3) return `${name} = ${value.toFixed(3)} — Explica menos de 30% da variação. Uso limitado a exploração.`;
      if (value < 0.6) return `${name} = ${value.toFixed(3)} — Performance moderada. Útil para tendências e segmentação.`;
      return `${name} = ${value.toFixed(3)} — Boa capacidade preditiva. Adequado para decisões de negócio.`;
    }
    // classification
    if (value < 0.55) return `${name} = ${(value * 100).toFixed(1)}% — Próximo ao acaso. Não confiável.`;
    if (value < 0.7) return `${name} = ${(value * 100).toFixed(1)}% — Separação marginal. Uso exploratório.`;
    if (value < 0.85) return `${name} = ${(value * 100).toFixed(1)}% — Boa separação de classes. Adequado para decisões.`;
    return `${name} = ${(value * 100).toFixed(1)}% — Excelente capacidade discriminativa.`;
  };

  return (
    <Card className={cn('border-2', config.borderColor)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-3 text-lg">
            <div className={cn('p-2 rounded-lg', config.bgColor)}>
              <StageIcon className={cn('w-6 h-6', config.color)} />
            </div>
            Visão Executiva de Confiança
          </CardTitle>
          <Badge className={config.badgeClass} variant={config.badgeVariant}>
            {config.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Problem Type */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              Tipo de Problema
            </p>
            <p className="text-sm font-semibold">{effectiveProblemLabel}</p>
          </div>

          {/* Main Metric */}
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Métrica Principal
              </p>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="w-3 h-3 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-sm">{getMetricInterpretation()}</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <p className="text-sm font-semibold">
              {mainMetric
                ? problemType === 'classification'
                  ? `${mainMetric.name}: ${(mainMetric.value * 100).toFixed(1)}%`
                  : `${mainMetric.name}: ${mainMetric.value.toFixed(3)}`
                : '—'}
            </p>
          </div>

          {/* Coverage */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              Cobertura do Score
            </p>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">
                {scoreCoveragePct !== null ? `${scoreCoveragePct.toFixed(1)}%` : '—'}
              </p>
              {scoreCoveragePct !== null && (
                scoreCoveragePct >= 95
                  ? <CheckCircle className="w-4 h-4 text-green-600" />
                  : scoreCoveragePct >= 50
                  ? <AlertTriangle className="w-4 h-4 text-yellow-600" />
                  : <XCircle className="w-4 h-4 text-destructive" />
              )}
            </div>
          </div>

          {/* Entities */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              Entidades Previstas
            </p>
            <p className="text-sm font-semibold">{totalEntities.toLocaleString()}</p>
          </div>
        </div>

        {/* Usage Declaration */}
        <div className={cn('p-4 rounded-lg border', config.bgColor, config.borderColor)}>
          <p className="text-sm leading-relaxed">
            {USAGE_DECLARATIONS[stage]}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export { determineProjectStage };
