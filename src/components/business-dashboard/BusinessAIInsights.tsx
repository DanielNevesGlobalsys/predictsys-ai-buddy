import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2, Lightbulb, AlertTriangle, TrendingUp, CheckSquare, BookOpen, Shield } from 'lucide-react';
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
  executive_narrative: string;
  summary: string;
  opportunities: string[];
  risk_segments: string[];
  recommended_actions: string[];
  confidence_statement: string;
}

export function BusinessAIInsights({ 
  projectId, 
  problemType, 
  problemContext,
  kpis, 
  segmentationBands, 
  groupSegmentation,
  viewMode 
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
        
        if (parsed?.executive_narrative || parsed?.summary) {
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
      // Build extra context with current dashboard data
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
        }
      });
      
      if (error) throw error;
      if (!responseData?.success) throw new Error(responseData?.error || 'Failed to generate insights');
      
      const newInsight = responseData.insight as BusinessStoryInsight;
      setInsight(newInsight);
      setHasStoredInsight(true);

      // Also update AI context with business stage
      try {
        await supabase.functions.invoke('append-project-context', {
          body: {
            project_id: projectId,
            stage: 'business',
            payload: {
              kpis: extraContext.dashboard_kpis,
              risks: newInsight.risk_segments || [],
              opportunities: newInsight.opportunities || [],
              recommended_actions: newInsight.recommended_actions || [],
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" />
              {t('businessDashboard.aiInsights.title')}
            </CardTitle>
            <CardDescription>
              {t('businessDashboard.aiInsights.description')}
            </CardDescription>
          </div>
          
          <Button 
            onClick={generateInsights} 
            disabled={loading || kpis.totalEntities === 0}
            variant={hasStoredInsight ? 'outline' : 'default'}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('businessDashboard.aiInsights.generating')}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                {hasStoredInsight 
                  ? t('businessDashboard.aiInsights.regenerate')
                  : t('businessDashboard.aiInsights.generate')
                }
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!insight ? (
          <div className="text-center py-8">
            <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground">
              {kpis.totalEntities === 0 
                ? t('businessDashboard.aiInsights.noData')
                : t('businessDashboard.aiInsights.clickToGenerate')
              }
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Executive Narrative */}
            {insight.executive_narrative && (
              <div className="p-4 rounded-lg border bg-card">
                <div className="flex items-center gap-2 mb-3">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary">
                    <BookOpen className="w-5 h-5" />
                  </div>
                  <h4 className="font-semibold">{t('businessDashboard.aiInsights.summary')}</h4>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-line text-foreground">
                  {insight.executive_narrative}
                </p>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              {/* Opportunities */}
              {insight.opportunities?.length > 0 && (
                <div className="p-4 rounded-lg border bg-green-500/5 border-green-500/20">
                  <div className="flex items-center gap-2 mb-3">
                    <TrendingUp className="w-5 h-5 text-green-600" />
                    <h4 className="font-semibold text-green-700 dark:text-green-400">
                      {t('businessDashboard.aiInsights.opportunities')}
                    </h4>
                  </div>
                  <ul className="space-y-2">
                    {insight.opportunities.map((opp, i) => (
                      <li key={i} className="text-sm flex gap-2">
                        <span className="text-green-600 font-bold mt-0.5">•</span>
                        <span>{opp}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Risk Segments */}
              {insight.risk_segments?.length > 0 && (
                <div className="p-4 rounded-lg border bg-destructive/5 border-destructive/20">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                    <h4 className="font-semibold text-destructive">
                      {t('businessDashboard.aiInsights.risks')}
                    </h4>
                  </div>
                  <ul className="space-y-2">
                    {insight.risk_segments.map((risk, i) => (
                      <li key={i} className="text-sm flex gap-2">
                        <span className="text-destructive font-bold mt-0.5">•</span>
                        <span>{risk}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Recommended Actions */}
            {insight.recommended_actions?.length > 0 && (
              <div className="p-4 rounded-lg border bg-secondary/5 border-secondary/20">
                <div className="flex items-center gap-2 mb-3">
                  <CheckSquare className="w-5 h-5 text-secondary" />
                  <h4 className="font-semibold">{t('businessDashboard.aiInsights.actions')}</h4>
                </div>
                <ul className="space-y-2">
                  {insight.recommended_actions.map((action, i) => (
                    <li key={i} className="text-sm flex gap-2">
                      <span className="text-secondary font-bold">{i + 1}.</span>
                      <span>{action}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Confidence Statement */}
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
