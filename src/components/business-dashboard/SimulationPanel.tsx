import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  Calculator, 
  Users, 
  Target, 
  DollarSign, 
  RotateCcw,
  Info,
  TrendingUp,
  AlertCircle,
  BarChart3
} from 'lucide-react';
import type { SimulationParams, SimulationResults, BusinessConfig } from './hooks/useSimulation';
import { cn } from '@/lib/utils';

interface SimulationPanelProps {
  params: SimulationParams;
  results: SimulationResults;
  businessConfig: BusinessConfig;
  onParamsChange: (params: Partial<SimulationParams>) => void;
  onReset: () => void;
  isActive: boolean;
  problemType: string;
  viewMode: 'risk' | 'opportunity';
}

export function SimulationPanel({
  params,
  results,
  businessConfig,
  onParamsChange,
  onReset,
  isActive,
  problemType,
  viewMode,
}: SimulationPanelProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
  const formatCurrency = (val: number) => {
    const absVal = Math.abs(val);
    const prefix = val < 0 ? '-' : '';
    if (absVal >= 1000000) return `${prefix}R$ ${(absVal / 1000000).toFixed(1)}M`;
    if (absVal >= 1000) return `${prefix}R$ ${(absVal / 1000).toFixed(1)}K`;
    return `${prefix}R$ ${absVal.toFixed(0)}`;
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  const isPositiveROI = isClassification ? results.netROI > 0 : results.estimatedProfit > 0;

  return (
    <Card className={cn(
      "transition-all",
      isActive && "ring-2 ring-primary/50"
    )}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calculator className="w-5 h-5" />
            <CardTitle>{t('businessDashboard.simulation.title')}</CardTitle>
            {isActive && (
              <Badge variant="secondary" className="ml-2">
                {t('businessDashboard.simulation.active')}
              </Badge>
            )}
          </div>
          {isActive && (
            <Button variant="ghost" size="sm" onClick={onReset}>
              <RotateCcw className="w-4 h-4 mr-1" />
              {t('businessDashboard.simulation.reset')}
            </Button>
          )}
        </div>
        <CardDescription>
          {isClassification 
            ? t('businessDashboard.simulation.description')
            : t('businessDashboard.simulation.regressionDescription')
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid lg:grid-cols-2 gap-8">
          {/* Controls */}
          <div className="space-y-6">
            {isClassification ? (
              <>
                {/* Classification: Threshold + Percent Actioned */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      {t('businessDashboard.simulation.threshold')}
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="w-4 h-4 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-xs">{t('businessDashboard.simulation.thresholdDesc')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    <span className="text-sm font-medium bg-muted px-2 py-1 rounded">
                      {(params.threshold * 100).toFixed(0)}%
                    </span>
                  </div>
                  <Slider
                    value={[params.threshold]}
                    onValueChange={([value]) => onParamsChange({ threshold: value })}
                    min={0.5}
                    max={0.95}
                    step={0.05}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>50%</span>
                    <span>95%</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      {t('businessDashboard.simulation.percentActioned')}
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="w-4 h-4 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-xs">{t('businessDashboard.simulation.percentActionedDesc')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    <span className="text-sm font-medium bg-muted px-2 py-1 rounded">
                      {params.percentActioned}%
                    </span>
                  </div>
                  <Slider
                    value={[params.percentActioned]}
                    onValueChange={([value]) => onParamsChange({ percentActioned: value })}
                    min={5}
                    max={100}
                    step={5}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>5%</span>
                    <span>100%</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Regression: Top X% by predicted value */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      {t('businessDashboard.simulation.topPercent')}
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="w-4 h-4 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-xs">{t('businessDashboard.simulation.topPercentDesc')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    <span className="text-sm font-medium bg-muted px-2 py-1 rounded">
                      Top {params.topPercent}%
                    </span>
                  </div>
                  <Slider
                    value={[params.topPercent]}
                    onValueChange={([value]) => onParamsChange({ topPercent: value })}
                    min={5}
                    max={100}
                    step={5}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Top 5%</span>
                    <span>100%</span>
                  </div>
                </div>
              </>
            )}

            {/* Business Config Summary */}
            <div className="p-3 bg-muted/50 rounded-lg space-y-1">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                {t('businessDashboard.simulation.configUsed')}
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {isClassification ? (
                  <>
                    <span>{t('businessDashboard.simulation.avgSale')}: R$ {businessConfig.average_sale_value}</span>
                    <span>{t('businessDashboard.simulation.margin')}: {businessConfig.average_margin_percent}%</span>
                    <span>{t('businessDashboard.simulation.costContact')}: R$ {businessConfig.cost_per_contact}</span>
                    <span>{t('businessDashboard.simulation.baseline')}: {businessConfig.baseline_conversion_percent}%</span>
                  </>
                ) : (
                  <>
                    <span>{t('businessDashboard.simulation.margin')}: {businessConfig.average_margin_percent}%</span>
                    <span>{t('businessDashboard.simulation.costContact')}: R$ {businessConfig.cost_per_contact}</span>
                    <span>{t('businessDashboard.simulation.baseline')}: {businessConfig.baseline_conversion_percent}%</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Results */}
          <div className="space-y-4">
            {isClassification ? (
              /* Classification results */
              <div className="grid grid-cols-2 gap-3">
                <Card className="p-4 bg-primary/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Users className="w-4 h-4 text-primary" />
                    <span className="text-xs text-muted-foreground">
                      {t('businessDashboard.simulation.entitiesToAction')}
                    </span>
                  </div>
                  <p className="text-2xl font-bold">{formatNumber(results.entitiesToAction)}</p>
                </Card>

                <Card className="p-4 bg-secondary/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Target className="w-4 h-4 text-secondary" />
                    <span className="text-xs text-muted-foreground">
                      {viewMode === 'risk'
                        ? t('businessDashboard.simulation.eventsCaptured')
                        : t('businessDashboard.simulation.opportunitiesCaptured')
                      }
                    </span>
                  </div>
                  <p className="text-2xl font-bold">{formatNumber(results.expectedEventsCaptured)}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {results.captureRate.toFixed(1)}% {t('businessDashboard.simulation.ofTotal')}
                  </p>
                </Card>

                <Card className="p-4 bg-muted/50">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {t('businessDashboard.simulation.totalCost')}
                    </span>
                  </div>
                  <p className="text-xl font-bold">{formatCurrency(results.costTotal)}</p>
                </Card>

                <Card className={cn(
                  "p-4",
                  isPositiveROI ? "bg-green-600/10" : "bg-destructive/10"
                )}>
                  <div className="flex items-center gap-2 mb-2">
                    <TrendingUp className={cn(
                      "w-4 h-4",
                      isPositiveROI ? "text-green-600" : "text-destructive"
                    )} />
                    <span className="text-xs text-muted-foreground">
                      {t('businessDashboard.simulation.netROI')}
                    </span>
                  </div>
                  <p className={cn(
                    "text-xl font-bold",
                    isPositiveROI ? "text-green-600" : "text-destructive"
                  )}>
                    {formatCurrency(results.netROI)}
                  </p>
                </Card>
              </div>
            ) : (
              /* Regression results */
              <div className="grid grid-cols-2 gap-3">
                <Card className="p-4 bg-primary/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Users className="w-4 h-4 text-primary" />
                    <span className="text-xs text-muted-foreground">
                      {t('businessDashboard.simulation.entitiesToAction')}
                    </span>
                  </div>
                  <p className="text-2xl font-bold">{formatNumber(results.entitiesToAction)}</p>
                </Card>

                <Card className="p-4 bg-secondary/5">
                  <div className="flex items-center gap-2 mb-2">
                    <BarChart3 className="w-4 h-4 text-secondary" />
                    <span className="text-xs text-muted-foreground">
                      {t('businessDashboard.simulation.valuePotential')}
                    </span>
                  </div>
                  <p className="text-2xl font-bold">{formatCurrency(results.valuePotential)}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {results.captureRate.toFixed(1)}% {t('businessDashboard.simulation.ofTotal')}
                  </p>
                </Card>

                <Card className="p-4 bg-accent/5">
                  <div className="flex items-center gap-2 mb-2">
                    <DollarSign className="w-4 h-4 text-accent" />
                    <span className="text-xs text-muted-foreground">
                      {t('businessDashboard.simulation.expectedRevenue')}
                    </span>
                  </div>
                  <p className="text-xl font-bold">{formatCurrency(results.expectedRevenue)}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('businessDashboard.simulation.withConversion', { percent: businessConfig.baseline_conversion_percent })}
                  </p>
                </Card>

                <Card className={cn(
                  "p-4",
                  isPositiveROI ? "bg-green-600/10" : "bg-destructive/10"
                )}>
                  <div className="flex items-center gap-2 mb-2">
                    <TrendingUp className={cn(
                      "w-4 h-4",
                      isPositiveROI ? "text-green-600" : "text-destructive"
                    )} />
                    <span className="text-xs text-muted-foreground">
                      {t('businessDashboard.simulation.estimatedProfit')}
                    </span>
                  </div>
                  <p className={cn(
                    "text-xl font-bold",
                    isPositiveROI ? "text-green-600" : "text-destructive"
                  )}>
                    {formatCurrency(results.estimatedProfit)}
                  </p>
                </Card>
              </div>
            )}

            {/* Cost card for regression */}
            {!isClassification && (
              <Card className="p-4 bg-muted/50">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    {t('businessDashboard.simulation.totalCost')}
                  </span>
                </div>
                <p className="text-xl font-bold">{formatCurrency(results.costTotal)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatNumber(results.entitiesToAction)} × R$ {businessConfig.cost_per_contact}
                </p>
              </Card>
            )}

            {/* Gross profit card for classification */}
            {isClassification && (
              <Card className="p-4 bg-accent/5">
                <div className="flex items-center gap-2 mb-2">
                  <DollarSign className="w-4 h-4 text-accent" />
                  <span className="text-xs text-muted-foreground">
                    {t('businessDashboard.simulation.estimatedImpact')}
                  </span>
                </div>
                <p className="text-2xl font-bold">{formatCurrency(results.financialImpact)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('businessDashboard.simulation.grossProfit')}
                </p>
              </Card>
            )}
          </div>
        </div>

        <div className="mt-6 p-3 bg-muted/50 rounded-lg">
          <p className="text-sm text-muted-foreground">
            {isClassification 
              ? t('businessDashboard.simulation.interpretation')
              : t('businessDashboard.simulation.regressionInterpretation', { percent: params.topPercent })
            }
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
