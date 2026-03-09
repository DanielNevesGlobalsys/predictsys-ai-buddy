import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sparkles, Loader2, AlertTriangle, TrendingUp,
  CheckSquare, BookOpen, Shield, Building2, Brain, RefreshCw,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { KPIData, SegmentationBand, GroupSegmentation, DashboardFilters } from './types';

interface BusinessAIInsightsProps {
  projectId: string;
  problemType: string;
  problemContext: string | null;
  kpis: KPIData;
  segmentationBands: SegmentationBand[];
  groupSegmentation: GroupSegmentation[];
  viewMode: DashboardFilters['viewMode'];
}

interface BusinessStoryInsight {
  business_context: string;
  model_discoveries: string;
  risk_or_opportunity: string;
  recommended_actions: string[];
  confidence_statement: string;
  dashboard_business_story: string;
  // legacy fields for backwards compatibility
  executive_narrative?: string;
  summary?: string;
  opportunities?: string[];
  risk_segments?: string[];
}

const BLOCK_CONFIG = [
  {
    key: 'business_context' as const,
    icon: Building2,
    labelKey: 'businessDashboard.aiInsights.blockContext',
    fallbackLabel: 'Contexto do Negócio',
    colorClass: 'text-primary',
    bgClass: 'bg-primary/5 border-primary/20',
  },
  {
    key: 'model_discoveries' as const,
    icon: Brain,
    labelKey: 'businessDashboard.aiInsights.blockDiscoveries',
    fallbackLabel: 'Descobertas do Modelo',
    colorClass: 'text-blue-600 dark:text-blue-400',
    bgClass: 'bg-blue-500/5 border-blue-500/20',
  },
  {
    key: 'risk_or_opportunity' as const,
    icon: AlertTriangle,
    labelKey: 'businessDashboard.aiInsights.blockRisks',
    fallbackLabel: 'Riscos e Oportunidades',
    colorClass: 'text-amber-600 dark:text-amber-400',
    bgClass: 'bg-amber-500/5 border-amber-500/20',
  },
] as const;

export function BusinessAIInsights({
  projectId,
  problemType,
  problemContext,
  kpis,
  segmentationBands,
  groupSegmentation,
  viewMode,
}: BusinessAIInsightsProps) {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [insight, setInsight] = useState<BusinessStoryInsight | null>(null);
  const [hasStoredInsight, setHasStoredInsight] = useState(false);

  useEffect(() => {
    loadStoredInsight();
  }, [projectId, i18n.language]);

  const loadStoredInsight = async () => {
    try {
      const { data } = await supabase
        .from('project_model_insights')
        .select('insights')
        .eq('project_id', projectId)
        .eq('insight_type', 'business_story')
        .eq('language', i18n.language)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data?.insights) {
        const parsed = typeof data.insights === 'string'
          ? JSON.parse(data.insights)
          : data.insights;

        if (parsed?.business_context || parsed?.executive_narrative || parsed?.summary) {
          setInsight(parsed as BusinessStoryInsight);
          setHasStoredInsight(true);
        }
      }
    } catch (error) {
      console.error('Error loading business insights:', error);
    }
  };

  const generateInsights = async () => {
    setLoading(true);
    try {
      const isRegression = problemType === 'regression';
      const extraContext = {
        dashboard_kpis: {
          total_entities: kpis.totalEntities,
          high_probability_count: kpis.highProbabilityCount,
          high_probability_pct: kpis.highProbabilityPercent,
          financial_impact: kpis.financialImpact,
          expected_events: kpis.expectedEvents,
          predicted_total_value: kpis.predictedTotalValue,
          predicted_avg_value: kpis.predictedAvgValue,
        },
        segmentation_bands: segmentationBands.map(b => ({
          range: b.range,
          count: b.count,
          percent: b.percent,
          total_value: b.totalValue,
        })),
        top_groups: groupSegmentation.slice(0, 8).map(g => ({
          group: g.group,
          count: g.count,
          avg_probability: g.avgProbability,
          high_probability_pct: g.highProbabilityPercent,
          avg_value: g.avgValue,
        })),
        problem_context: problemContext,
        view_mode: viewMode,
        is_regression: isRegression,
      };

      const { data: responseData, error } = await supabase.functions.invoke('lys-pipeline-insights', {
        body: {
          project_id: projectId,
          stage: 'business_story',
          language: i18n.language,
          extra_context: extraContext,
        },
      });

      if (error) throw error;
      if (!responseData?.success) throw new Error(responseData?.error || 'Failed to generate insights');

      const newInsight = responseData.insight as BusinessStoryInsight;
      setInsight(newInsight);
      setHasStoredInsight(true);

      try {
        await supabase.functions.invoke('append-project-context', {
          body: {
            project_id: projectId,
            stage: 'business',
            payload: {
              kpis: extraContext.dashboard_kpis,
              dashboard_type: problemType,
            },
          },
        });
      } catch { /* non-critical */ }

      toast.success(t('businessDashboard.aiInsights.generated'));
    } catch (error) {
      console.error('Error generating business story:', error);
      toast.error(t('businessDashboard.aiInsights.error'));
    } finally {
      setLoading(false);
    }
  };

  // Resolve block text with backwards compatibility for old format
  const getBlockText = (key: 'business_context' | 'model_discoveries' | 'risk_or_opportunity'): string | null => {
    if (!insight) return null;
    if (insight[key]) return insight[key];
    // Legacy fallback: map old executive_narrative to business_context
    if (key === 'business_context' && insight.executive_narrative) return insight.executive_narrative;
    return null;
  };

  const getActions = (): string[] => {
    if (!insight) return [];
    return insight.recommended_actions || [];
  };

  return (
    <Card className="border-primary/20">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">
              {t('businessDashboard.aiInsights.title')}
            </CardTitle>
            {hasStoredInsight && (
              <Badge variant="outline" className="text-xs">
                Lys
              </Badge>
            )}
          </div>

          <Button
            onClick={generateInsights}
            disabled={loading || kpis.totalEntities === 0}
            variant={hasStoredInsight ? 'outline' : 'default'}
            size="sm"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('businessDashboard.aiInsights.generating')}
              </>
            ) : (
              <>
                {hasStoredInsight ? (
                  <RefreshCw className="w-4 h-4 mr-2" />
                ) : (
                  <Sparkles className="w-4 h-4 mr-2" />
                )}
                {hasStoredInsight
                  ? t('businessDashboard.aiInsights.regenerate')
                  : t('businessDashboard.aiInsights.generate')}
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {!insight ? (
          <div className="text-center py-8">
            <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground text-sm">
              {kpis.totalEntities === 0
                ? t('businessDashboard.aiInsights.noData')
                : t('businessDashboard.aiInsights.clickToGenerate')}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary badge */}
            {insight.dashboard_business_story && (
              <div className="p-3 rounded-lg bg-muted/50 border border-border">
                <div className="flex items-center gap-2 mb-2">
                  <BookOpen className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Resumo Executivo
                  </span>
                </div>
                <p className="text-sm leading-relaxed">{insight.dashboard_business_story}</p>
              </div>
            )}

            {/* Fixed 4-block narrative structure */}
            <div className="grid gap-4 md:grid-cols-2">
              {BLOCK_CONFIG.map(({ key, icon: Icon, fallbackLabel, bgClass, colorClass }) => {
                const text = getBlockText(key);
                if (!text) return null;
                return (
                  <div key={key} className={`p-4 rounded-lg border ${bgClass}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className={`w-4 h-4 ${colorClass}`} />
                      <h4 className={`text-sm font-semibold ${colorClass}`}>
                        {fallbackLabel}
                      </h4>
                    </div>
                    <p className="text-sm leading-relaxed whitespace-pre-line">
                      {text}
                    </p>
                  </div>
                );
              })}

              {/* Block D — Recommended Actions */}
              {getActions().length > 0 && (
                <div className="p-4 rounded-lg border bg-green-500/5 border-green-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckSquare className="w-4 h-4 text-green-600 dark:text-green-400" />
                    <h4 className="text-sm font-semibold text-green-600 dark:text-green-400">
                      Recomendações de Ação
                    </h4>
                  </div>
                  <ul className="space-y-1.5">
                    {getActions().map((action, i) => (
                      <li key={i} className="text-sm flex gap-2">
                        <span className="text-green-600 dark:text-green-400 font-bold">{i + 1}.</span>
                        <span>{action}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Confidence statement */}
            {insight.confidence_statement && (
              <div className="p-3 rounded-lg bg-muted/50 border border-border flex items-start gap-2">
                <Shield className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <p className="text-xs text-muted-foreground italic">{insight.confidence_statement}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
