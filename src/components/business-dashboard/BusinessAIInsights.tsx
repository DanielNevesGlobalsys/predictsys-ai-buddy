import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2, Lightbulb, AlertTriangle, TrendingUp, CheckSquare } from 'lucide-react';
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

interface AIInsight {
  type: 'summary' | 'opportunities' | 'risks' | 'actions';
  content: string;
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
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [hasStoredInsights, setHasStoredInsights] = useState(false);
  
  useEffect(() => {
    loadStoredInsights();
  }, [projectId, i18n.language]);
  
  const loadStoredInsights = async () => {
    try {
      const { data } = await supabase
        .from('project_model_insights')
        .select('insights')
        .eq('project_id', projectId)
        .eq('insight_type', 'dashboard')
        .eq('language', i18n.language)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (data?.insights) {
        const parsed = typeof data.insights === 'string' 
          ? JSON.parse(data.insights) 
          : data.insights;
        
        if (Array.isArray(parsed) && parsed.length > 0) {
          setInsights(parsed);
          setHasStoredInsights(true);
        }
      }
    } catch (error) {
      console.error('Error loading insights:', error);
    }
  };

  // Gather cumulative project context for richer AI prompts
  const gatherCumulativeContext = async (): Promise<string> => {
    const parts: string[] = [];

    try {
      const [aiCtxRes, inferenceRes, settingsRes] = await Promise.all([
        supabase
          .from('project_ai_context')
          .select('context')
          .eq('project_id', projectId)
          .maybeSingle(),
        supabase
          .from('project_problem_inference')
          .select('problem_type, suggested_problem_labels, narrative, confidence')
          .eq('project_id', projectId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('project_settings')
          .select('target_column, problem_type')
          .eq('project_id', projectId)
          .maybeSingle(),
      ]);

      const aiCtx = aiCtxRes.data?.context as Record<string, any> | null;

      // Domain / industry
      if (aiCtx?.eda?.business_segment?.segment) {
        parts.push(`Domínio de negócio inferido: ${aiCtx.eda.business_segment.segment}`);
      }

      // Problem inference
      if (inferenceRes.data) {
        const inf = inferenceRes.data;
        const labels = Array.isArray(inf.suggested_problem_labels)
          ? (inf.suggested_problem_labels as { label: string }[])
              .filter(l => !(l.label || '').startsWith('__'))
              .map(l => l.label)
          : [];
        if (labels.length > 0) {
          parts.push(`Problemas de negócio inferidos: ${labels.join(', ')}`);
        }
        if (inf.narrative) {
          parts.push(`Narrativa da inferência: ${(inf.narrative as string).substring(0, 400)}`);
        }
      }

      // Target
      if (settingsRes.data?.target_column) {
        parts.push(`Variável alvo: ${settingsRes.data.target_column} (${settingsRes.data.problem_type || problemType})`);
      }

      // Training insights (model quality)
      if (aiCtx?.training?.metrics) {
        const metricsStr = Object.entries(aiCtx.training.metrics)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        parts.push(`Métricas do modelo: ${metricsStr}`);
      }
      if (aiCtx?.training?.confidence_level) {
        parts.push(`Nível de confiança do modelo: ${aiCtx.training.confidence_level}`);
      }

      // Storyline
      if (aiCtx?.storyline?.executive_summary) {
        parts.push(`Resumo executivo anterior: ${(aiCtx.storyline.executive_summary as string).substring(0, 300)}`);
      }
    } catch (err) {
      console.error('[BusinessAIInsights] Error gathering context:', err);
    }

    return parts.length > 0 
      ? `\n\nCONTEXTO CUMULATIVO DO PROJETO:\n${parts.join('\n')}` 
      : '';
  };
  
  const generateInsights = async () => {
    setLoading(true);
    
    try {
      // Gather cumulative context
      const cumulativeContext = await gatherCumulativeContext();

      // Build context for AI
      const highBands = segmentationBands.filter(b => b.min >= 0.6);
      const highCount = highBands.reduce((sum, b) => sum + b.count, 0);
      const topGroups = groupSegmentation.slice(0, 5);
      
      const contextLabel = problemContext || 'generic';
      const viewLabel = viewMode === 'risk' ? 'risco' : 'oportunidade';
      
      const isRegression = problemType === 'regression';
      
      const kpiBlock = isRegression
        ? `KPIs de Regressão:
- Total de entidades: ${kpis.totalEntities}
- Valor total projetado: R$ ${kpis.predictedTotalValue.toLocaleString()}
- Valor médio previsto: R$ ${kpis.predictedAvgValue.toLocaleString()}
- Impacto financeiro estimado: R$ ${kpis.financialImpact.toLocaleString()}`
        : `KPIs de Classificação:
- Total de entidades: ${kpis.totalEntities}
- Alta probabilidade (>=70%): ${kpis.highProbabilityCount} (${kpis.highProbabilityPercent.toFixed(1)}%)
- Eventos esperados: ${kpis.expectedEvents}
- Impacto financeiro estimado: R$ ${kpis.financialImpact.toLocaleString()}`;

      const segBlock = isRegression
        ? `Distribuição por faixas de valor previsto:\n${segmentationBands.map(b => `- ${b.range}: ${b.count} registros, total R$ ${(b.totalValue || 0).toLocaleString()}`).join('\n')}`
        : `Distribuição por faixas de probabilidade:\n${segmentationBands.map(b => `- ${b.range}: ${b.count} registros (${b.percent.toFixed(1)}%)`).join('\n')}`;

      const prompt = `Você é a Lys, analista de negócios da PredictSys. Analise os dados do dashboard preditivo e gere insights ESPECÍFICOS ao problema de negócio, NUNCA genéricos.

Contexto: Pipeline de ${contextLabel} (${problemType})
Visão: ${viewLabel}
${cumulativeContext}

${kpiBlock}

${segBlock}

Top 5 grupos por ${isRegression ? 'valor médio' : 'probabilidade média'}:
${topGroups.map(g => isRegression
  ? `- ${g.group}: R$ ${(g.avgValue || 0).toFixed(2)} média, ${g.count} registros`
  : `- ${g.group}: ${((g.avgProbability || 0) * 100).toFixed(1)}% média, ${g.highProbabilityPercent.toFixed(1)}% alta prob`
).join('\n')}

REGRAS OBRIGATÓRIAS:
- Use o contexto cumulativo do projeto para conectar insights à inferência de problema original
- Para REGRESSÃO: foque em valores previstos, top/bottom entidades, erro esperado e drivers de valor
- Para CLASSIFICAÇÃO: foque em probabilidades, faixas de risco, priorização e ações por segmento
- NUNCA use valores default como "R$100" ou frases genéricas
- Cada insight deve mencionar dados reais do dashboard

Gere exatamente 4 insights no formato JSON:
[
  {"type": "summary", "content": "Resumo executivo conectado ao problema inferido em 2-3 frases"},
  {"type": "opportunities", "content": "Oportunidades específicas baseadas nos dados em 2-3 frases"},
  {"type": "risks", "content": "Riscos reais identificados nos dados em 2-3 frases"},
  {"type": "actions", "content": "3-4 ações concretas baseadas nos segmentos, separadas por ponto e vírgula"}
]

Responda APENAS o JSON, sem markdown ou texto adicional.`;

      const { data: responseData, error } = await supabase.functions.invoke('global-chat', {
        body: { 
          message: prompt,
          context: 'dashboard_insights'
        }
      });
      
      if (error) throw error;
      
      let parsedInsights: AIInsight[] = [];
      
      const responseText = responseData?.response || responseData?.message || '';
      
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        parsedInsights = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse AI response');
      }
      
      setInsights(parsedInsights);
      
      // Save to database
      const { data: existing } = await supabase
        .from('project_model_insights')
        .select('id')
        .eq('project_id', projectId)
        .eq('insight_type', 'dashboard')
        .eq('language', i18n.language)
        .maybeSingle();
      
      const insightsJson = JSON.parse(JSON.stringify(parsedInsights));
      
      if (existing) {
        await supabase
          .from('project_model_insights')
          .update({ 
            insights: insightsJson,
            updated_at: new Date().toISOString()
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('project_model_insights')
          .insert([{
            project_id: projectId,
            insight_type: 'dashboard',
            language: i18n.language,
            insights: insightsJson
          }]);
      }

      // Also update AI context with dashboard mapping
      try {
        await supabase.functions.invoke('append-project-context', {
          body: {
            project_id: projectId,
            stage: 'business',
            payload: {
              kpis: {
                total_entities: kpis.totalEntities,
                financial_impact: kpis.financialImpact,
                high_probability_pct: kpis.highProbabilityPercent,
              },
              risks: parsedInsights.find(i => i.type === 'risks')?.content || '',
              opportunities: parsedInsights.find(i => i.type === 'opportunities')?.content || '',
              dashboard_type: problemType,
            },
          },
        });
      } catch { /* non-critical */ }
      
      setHasStoredInsights(true);
      toast.success(t('businessDashboard.aiInsights.generated'));
      
    } catch (error) {
      console.error('Error generating insights:', error);
      toast.error(t('businessDashboard.aiInsights.error'));
      
      setInsights([
        { type: 'summary', content: t('businessDashboard.aiInsights.fallbackSummary') },
        { type: 'opportunities', content: t('businessDashboard.aiInsights.fallbackOpportunities') },
        { type: 'risks', content: t('businessDashboard.aiInsights.fallbackRisks') },
        { type: 'actions', content: t('businessDashboard.aiInsights.fallbackActions') }
      ]);
    } finally {
      setLoading(false);
    }
  };
  
  const getInsightIcon = (type: string) => {
    switch (type) {
      case 'summary': return <Lightbulb className="w-5 h-5" />;
      case 'opportunities': return <TrendingUp className="w-5 h-5" />;
      case 'risks': return <AlertTriangle className="w-5 h-5" />;
      case 'actions': return <CheckSquare className="w-5 h-5" />;
      default: return <Sparkles className="w-5 h-5" />;
    }
  };
  
  const getInsightColor = (type: string) => {
    switch (type) {
      case 'summary': return 'bg-primary/10 text-primary border-primary/20';
      case 'opportunities': return 'bg-green-500/10 text-green-600 border-green-500/20';
      case 'risks': return 'bg-destructive/10 text-destructive border-destructive/20';
      case 'actions': return 'bg-secondary/10 text-secondary border-secondary/20';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };
  
  const getInsightTitle = (type: string) => {
    switch (type) {
      case 'summary': return t('businessDashboard.aiInsights.summary');
      case 'opportunities': return t('businessDashboard.aiInsights.opportunities');
      case 'risks': return t('businessDashboard.aiInsights.risks');
      case 'actions': return t('businessDashboard.aiInsights.actions');
      default: return '';
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
            variant={hasStoredInsights ? 'outline' : 'default'}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('businessDashboard.aiInsights.generating')}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                {hasStoredInsights 
                  ? t('businessDashboard.aiInsights.regenerate')
                  : t('businessDashboard.aiInsights.generate')
                }
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {insights.length === 0 ? (
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
          <div className="grid md:grid-cols-2 gap-4">
            {insights.map((insight, index) => (
              <Card 
                key={index} 
                className={`p-4 border ${getInsightColor(insight.type)}`}
              >
                <div className="flex items-center gap-2 mb-3">
                  {getInsightIcon(insight.type)}
                  <h4 className="font-semibold">{getInsightTitle(insight.type)}</h4>
                </div>
                <p className="text-sm leading-relaxed">
                  {insight.content}
                </p>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
