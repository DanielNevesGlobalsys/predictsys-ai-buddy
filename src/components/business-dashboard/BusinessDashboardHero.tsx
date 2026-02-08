import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, Users, AlertTriangle, ShoppingCart, CreditCard, DollarSign, BarChart3, GraduationCap, Heart, Truck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { PROBLEM_CONTEXT_LABELS } from './types';

interface BusinessDashboardHeroProps {
  projectId?: string;
  problemContext: string | null;
  problemType: string;
  horizonDays: number;
}

interface InferredContext {
  industryLabel: string | null;
  industryDisplay: string | null;
  problemLabels: string[];
  narrative: string | null;
}

export function BusinessDashboardHero({ projectId, problemContext, problemType, horizonDays }: BusinessDashboardHeroProps) {
  const { t } = useTranslation();
  const [inferred, setInferred] = useState<InferredContext>({
    industryLabel: null,
    industryDisplay: null,
    problemLabels: [],
    narrative: null,
  });
  
  // Load inferred context from AI context and problem inference
  useEffect(() => {
    if (!projectId) return;
    
    const loadInferredContext = async () => {
      try {
        const [aiCtxRes, inferenceRes] = await Promise.all([
          supabase
            .from('project_ai_context')
            .select('context')
            .eq('project_id', projectId)
            .maybeSingle(),
          supabase
            .from('project_problem_inference')
            .select('suggested_problem_labels, narrative')
            .eq('project_id', projectId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        const aiCtx = aiCtxRes.data?.context as Record<string, any> | null;
        const segment = aiCtx?.eda?.business_segment;
        
        let labels: string[] = [];
        if (inferenceRes.data?.suggested_problem_labels) {
          labels = (inferenceRes.data.suggested_problem_labels as { label: string }[])
            .filter(l => !(l.label || '').startsWith('__'))
            .map(l => l.label)
            .slice(0, 3);
        }

        setInferred({
          industryLabel: segment?.label || null,
          industryDisplay: segment?.segment || null,
          problemLabels: labels,
          narrative: inferenceRes.data?.narrative ? (inferenceRes.data.narrative as string).substring(0, 200) : null,
        });
      } catch (err) {
        console.error('[BusinessDashboardHero] Error loading context:', err);
      }
    };
    
    loadInferredContext();
  }, [projectId]);
  
  const getContextIcon = () => {
    // Use inferred industry for icon when available
    if (inferred.industryLabel) {
      switch (inferred.industryLabel) {
        case 'education': return <GraduationCap className="w-8 h-8" />;
        case 'healthcare': return <Heart className="w-8 h-8" />;
        case 'logistics': return <Truck className="w-8 h-8" />;
        case 'retail_shopping': return <ShoppingCart className="w-8 h-8" />;
        case 'financial': return <CreditCard className="w-8 h-8" />;
      }
    }
    switch (problemContext) {
      case 'churn': return <Users className="w-8 h-8" />;
      case 'propensao_compra': return <ShoppingCart className="w-8 h-8" />;
      case 'inadimplencia': return <AlertTriangle className="w-8 h-8" />;
      case 'demanda': return <TrendingUp className="w-8 h-8" />;
      case 'ltv': return <DollarSign className="w-8 h-8" />;
      case 'credito': return <CreditCard className="w-8 h-8" />;
      default: return <BarChart3 className="w-8 h-8" />;
    }
  };
  
  // Build dynamic subtitle from inferred problems
  const getSubtitle = (): string => {
    if (inferred.problemLabels.length > 0) {
      return inferred.problemLabels.join(' · ');
    }
    if (problemContext && PROBLEM_CONTEXT_LABELS[problemContext]) {
      return t(PROBLEM_CONTEXT_LABELS[problemContext].subtitle);
    }
    return t('businessDashboard.hero.defaultSubtitle');
  };
  
  const problemTypeLabel = problemType === 'classification' 
    ? t('businessDashboard.hero.classification')
    : problemType === 'regression'
    ? t('businessDashboard.hero.regression')
    : t('businessDashboard.hero.timeSeries');
  
  const horizonLabel = horizonDays <= 30 
    ? t('businessDashboard.hero.next30Days')
    : horizonDays <= 60 
    ? t('businessDashboard.hero.next60Days')
    : horizonDays <= 180 
    ? t('businessDashboard.hero.next6Months')
    : t('businessDashboard.hero.next12Months');

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-background border border-border p-8">
      <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="absolute bottom-0 left-0 w-48 h-48 bg-secondary/5 rounded-full translate-y-1/2 -translate-x-1/2" />
      
      <div className="relative z-10 flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center text-primary-foreground">
              {getContextIcon()}
            </div>
            <div>
              <h1 className="text-3xl font-display font-bold">
                {t('businessDashboard.hero.title')}
              </h1>
              <p className="text-lg text-muted-foreground mt-1">
                {getSubtitle()}
              </p>
            </div>
          </div>
        </div>
        
        <div className="flex flex-wrap gap-2">
          {inferred.industryDisplay && (
            <Badge variant="secondary" className="text-sm px-3 py-1 bg-primary/10 text-primary border-primary/20">
              {inferred.industryDisplay}
            </Badge>
          )}
          <Badge variant="secondary" className="text-sm px-3 py-1">
            {problemTypeLabel}
          </Badge>
          <Badge variant="outline" className="text-sm px-3 py-1">
            {horizonLabel}
          </Badge>
        </div>
      </div>
    </div>
  );
}