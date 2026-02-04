import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { 
  Target, 
  Calendar, 
  Users,
  AlertTriangle,
  DollarSign,
  TrendingUp,
  Percent,
  Calculator,
  CheckCircle2,
  ExternalLink
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import AppShell from '@/components/executive/AppShell';
import type { ProjectAction, BusinessConfig } from '@/components/business-impact/types';
import { ACTION_TYPES, ACTION_STATUSES } from '@/components/business-impact/types';

interface ProjectData {
  id: string;
  name: string;
  description: string | null;
  business_objective: string | null;
  problem_type: string;
  target_column: string | null;
  status: string;
  total_rows: number | null;
}

interface SituationData {
  highRiskCount: number;
  revenueAtRisk: number;
  criticalSegment: string | null;
}

const ExecutiveProject = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [situation, setSituation] = useState<SituationData>({
    highRiskCount: 0,
    revenueAtRisk: 0,
    criticalSegment: null,
  });
  const [config, setConfig] = useState<BusinessConfig | null>(null);
  const [actions, setActions] = useState<ProjectAction[]>([]);
  const [totalROI, setTotalROI] = useState({
    completedActionsCount: 0,
    totalCustomersImpacted: 0,
    totalIncrementalRevenue: 0,
    totalCost: 0,
    netROI: 0,
    roiPercent: 0,
  });

  useEffect(() => {
    const fetchData = async () => {
      if (!projectId) return;
      
      setLoading(true);
      
      try {
        // Fetch project
        const { data: projectData } = await supabase
          .from('projects')
          .select('id, name, description, business_objective, problem_type, target_column, status, total_rows')
          .eq('id', projectId)
          .single();
        
        if (projectData) {
          setProject(projectData);
        }
        
        // Fetch business config
        const { data: configData } = await supabase
          .from('project_business_config')
          .select('*')
          .eq('project_id', projectId)
          .maybeSingle();
        
        if (configData) {
          setConfig({
            id: configData.id,
            project_id: projectId,
            average_sale_value: configData.average_sale_value ?? 0,
            average_margin_percent: configData.average_margin_percent ?? 0,
            cost_per_contact: configData.cost_per_contact ?? 0,
            impact_window_days: configData.impact_window_days ?? 30,
            baseline_conversion_percent: configData.baseline_conversion_percent ?? 0,
          });
        }
        
        // Fetch situation data (high risk predictions)
        const { count: highRiskCount } = await supabase
          .from('predictions')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .eq('is_latest', true)
          .gte('probability_event', 0.7);
        
        // Get segment with most high-risk
        const { data: segmentData } = await supabase
          .from('predictions')
          .select('segment')
          .eq('project_id', projectId)
          .eq('is_latest', true)
          .gte('probability_event', 0.7)
          .not('segment', 'is', null);
        
        const segmentCounts: Record<string, number> = {};
        for (const pred of segmentData || []) {
          if (pred.segment) {
            segmentCounts[pred.segment] = (segmentCounts[pred.segment] || 0) + 1;
          }
        }
        const criticalSegment = Object.entries(segmentCounts)
          .sort(([, a], [, b]) => b - a)[0]?.[0] || null;
        
        const avgSaleValue = configData?.average_sale_value || 0;
        
        setSituation({
          highRiskCount: highRiskCount || 0,
          revenueAtRisk: (highRiskCount || 0) * avgSaleValue,
          criticalSegment,
        });
        
        // Fetch actions
        const { data: actionsData } = await supabase
          .from('project_actions')
          .select('*')
          .eq('project_id', projectId)
          .order('start_date', { ascending: false });
        
        const typedActions = (actionsData || []) as unknown as ProjectAction[];
        setActions(typedActions);
        
        // Calculate total ROI
        let totalIncRevenue = 0;
        let totalCost = 0;
        let totalCustomers = 0;
        let completedCount = 0;
        
        const completedActions = typedActions.filter(a => 
          a.status === 'completed' && 
          a.observed_conversion_percent !== null
        );
        
        for (const action of completedActions) {
          const targetCustomers = action.target_customers ?? 0;
          const obsConv = action.observed_conversion_percent ?? 0;
          const baseConv = action.expected_conversion_percent ?? (configData?.baseline_conversion_percent ?? 0);
          const avgSale = configData?.average_sale_value ?? 0;
          const margin = configData?.average_margin_percent ?? 0;
          const costPerContact = configData?.cost_per_contact ?? 0;
          
          const incCustomers = Math.round(((obsConv - baseConv) / 100) * targetCustomers);
          const incRevenue = incCustomers * avgSale * (margin / 100);
          const cost = targetCustomers * costPerContact;
          
          totalIncRevenue += incRevenue;
          totalCost += cost;
          totalCustomers += targetCustomers;
          completedCount++;
        }
        
        setTotalROI({
          completedActionsCount: completedCount,
          totalCustomersImpacted: totalCustomers,
          totalIncrementalRevenue: totalIncRevenue,
          totalCost,
          netROI: totalIncRevenue - totalCost,
          roiPercent: totalCost > 0 ? ((totalIncRevenue - totalCost) / totalCost) * 100 : 0,
        });
      } catch (error) {
        console.error('Error fetching project data:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, [projectId]);

  const formatCurrency = (value: number) => {
    if (Math.abs(value) >= 1000000) {
      return `R$ ${(value / 1000000).toFixed(1)}M`;
    } else if (Math.abs(value) >= 1000) {
      return `R$ ${(value / 1000).toFixed(0)}k`;
    }
    return new Intl.NumberFormat('pt-BR', { 
      style: 'currency', 
      currency: 'BRL',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatNumber = (value: number) => {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)}M`;
    } else if (value >= 1000) {
      return `${(value / 1000).toFixed(0)}k`;
    }
    return value.toLocaleString('pt-BR');
  };

  const getProblemTypeLabel = (type: string) => {
    switch (type) {
      case 'classification': return 'Predição de eventos (classificação)';
      case 'regression': return 'Predição de valores (regressão)';
      default: return type;
    }
  };

  const getActionTypeLabel = (type: string) => {
    return ACTION_TYPES.find(t => t.value === type)?.label || type;
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = ACTION_STATUSES.find(s => s.value === status);
    return (
      <Badge className={`${statusConfig?.color || 'bg-gray-500'} text-white text-xs`}>
        {statusConfig?.label || status}
      </Badge>
    );
  };

  if (loading) {
    return (
      <AppShell showBackButton title="Carregando..." hideBottomNav>
        <div className="p-4 space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </AppShell>
    );
  }

  if (!project) {
    return (
      <AppShell showBackButton title="Erro" hideBottomNav>
        <div className="flex items-center justify-center p-8">
          <Card className="p-6 text-center max-w-sm">
            <h3 className="text-lg font-semibold mb-2">Projeto não encontrado</h3>
            <p className="text-muted-foreground mb-4">
              O projeto solicitado não existe ou você não tem permissão para acessá-lo.
            </p>
            <Button onClick={() => navigate('/executivo')}>Voltar</Button>
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell showBackButton title={project.name} hideBottomNav>
      <div className="p-4 pb-8 space-y-6 max-w-lg mx-auto">
        {/* Project Context */}
        <section>
          <h2 className="text-lg font-semibold mb-3">Contexto do Projeto</h2>
          <Card>
            <CardContent className="p-4 space-y-3">
              {project.business_objective && (
                <div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                    <Target className="w-4 h-4" />
                    <span>Objetivo de Negócio</span>
                  </div>
                  <p className="text-sm">{project.business_objective}</p>
                </div>
              )}
              
              <div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <Target className="w-4 h-4" />
                  <span>O que prevê</span>
                </div>
                <p className="text-sm">
                  {getProblemTypeLabel(project.problem_type)}
                  {project.target_column && ` — ${project.target_column}`}
                </p>
              </div>
              
              {project.total_rows && (
                <div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                    <Users className="w-4 h-4" />
                    <span>Base / Público</span>
                  </div>
                  <p className="text-sm">{formatNumber(project.total_rows)} registros</p>
                </div>
              )}
              
              {config?.impact_window_days && (
                <div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                    <Calendar className="w-4 h-4" />
                    <span>Janela de Impacto</span>
                  </div>
                  <p className="text-sm">{config.impact_window_days} dias</p>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Current Situation */}
        <section>
          <h2 className="text-lg font-semibold mb-3">Situação Atual</h2>
          <div className="grid grid-cols-1 gap-3">
            <Card className="bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <span>Clientes em Alto Risco</span>
                  </div>
                  <p className="text-2xl font-bold text-red-600">
                    {situation.highRiskCount > 0 ? formatNumber(situation.highRiskCount) : '—'}
                  </p>
                </div>
              </CardContent>
            </Card>
            
            <Card className="bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-900">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <DollarSign className="w-4 h-4 text-orange-600" />
                  <span>Receita em Risco</span>
                </div>
                <p className="text-2xl font-bold text-orange-600">
                  {situation.revenueAtRisk > 0 ? formatCurrency(situation.revenueAtRisk) : '—'}
                </p>
              </CardContent>
            </Card>
            
            {situation.criticalSegment && (
              <Card className="bg-purple-50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-900">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                    <Target className="w-4 h-4 text-purple-600" />
                    <span>Segmento Crítico</span>
                  </div>
                  <p className="text-lg font-semibold text-purple-600">
                    {situation.criticalSegment}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </section>

        {/* Business Impact */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Impacto de Negócio</h2>
            <Button 
              variant="ghost" 
              size="sm" 
              className="gap-1 text-xs"
              onClick={() => navigate(`/projeto/${projectId}?tab=impacto`)}
            >
              <ExternalLink className="w-3 h-3" />
              Painel completo
            </Button>
          </div>
          
          {/* ROI Cards */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <TrendingUp className="w-3.5 h-3.5" />
                  <span>ROI Líquido</span>
                </div>
                <p className={`text-lg font-bold ${totalROI.netROI >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {totalROI.completedActionsCount > 0 ? formatCurrency(totalROI.netROI) : '—'}
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Percent className="w-3.5 h-3.5" />
                  <span>ROI %</span>
                </div>
                <p className={`text-lg font-bold ${totalROI.roiPercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {totalROI.completedActionsCount > 0 ? `${totalROI.roiPercent.toFixed(0)}%` : '—'}
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <DollarSign className="w-3.5 h-3.5" />
                  <span>Receita Incremental</span>
                </div>
                <p className="text-lg font-bold text-blue-600">
                  {totalROI.completedActionsCount > 0 ? formatCurrency(totalROI.totalIncrementalRevenue) : '—'}
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Calculator className="w-3.5 h-3.5" />
                  <span>Custo Total</span>
                </div>
                <p className="text-lg font-bold text-orange-600">
                  {totalROI.completedActionsCount > 0 ? formatCurrency(totalROI.totalCost) : '—'}
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Users className="w-3.5 h-3.5" />
                  <span>Clientes Impactados</span>
                </div>
                <p className="text-lg font-bold text-purple-600">
                  {totalROI.totalCustomersImpacted > 0 ? formatNumber(totalROI.totalCustomersImpacted) : '—'}
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Ações Concluídas</span>
                </div>
                <p className="text-lg font-bold text-indigo-600">
                  {totalROI.completedActionsCount}
                </p>
              </CardContent>
            </Card>
          </div>
          
          {/* Actions List */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Campanhas & Ações</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {actions.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground">
                  <p>Sem ações registradas ainda.</p>
                  <p className="text-xs mt-1">Registre ações no painel web para acompanhar resultados.</p>
                </div>
              ) : (
                <div className="divide-y">
                  {actions.map((action) => (
                    <div key={action.id} className="p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div>
                          <h4 className="font-medium text-sm">{action.action_name}</h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted-foreground">
                              {getActionTypeLabel(action.action_type)}
                            </span>
                            {getStatusBadge(action.status)}
                          </div>
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                        <div>
                          <span className="text-muted-foreground">Período:</span>
                          <span className="ml-1">
                            {format(new Date(action.start_date), 'dd/MM/yy', { locale: ptBR })}
                            {action.end_date && ` - ${format(new Date(action.end_date), 'dd/MM/yy', { locale: ptBR })}`}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Alvo:</span>
                          <span className="ml-1">{formatNumber(action.target_customers || 0)}</span>
                        </div>
                        {action.observed_conversion_percent !== null && (
                          <div className="col-span-2">
                            <span className="text-muted-foreground">Conversão:</span>
                            <span className="ml-1">
                              {(action.expected_conversion_percent || 0).toFixed(1)}% → 
                              <span className="font-medium text-green-600 ml-1">
                                {action.observed_conversion_percent.toFixed(1)}%
                              </span>
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </AppShell>
  );
};

export default ExecutiveProject;
