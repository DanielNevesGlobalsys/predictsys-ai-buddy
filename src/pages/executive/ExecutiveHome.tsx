import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  AlertTriangle, 
  TrendingUp, 
  Users, 
  Percent,
  ChevronRight,
  Sparkles,
  RefreshCw,
  Clock
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import AppShell from '@/components/executive/AppShell';

interface OrgSummary {
  revenueAtRisk: number;
  incrementalRevenue: number;
  customersImpacted: number;
  roiPercent: number;
  lastUpdate: Date | null;
}

interface ProjectSummary {
  id: string;
  name: string;
  problem_type: string;
  status: string;
  predictions_count: number;
  high_risk_count: number;
}

const ExecutiveHome = () => {
  const navigate = useNavigate();
  const { currentOrganization, isLoading: orgLoading } = useOrganization();
  
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orgSummary, setOrgSummary] = useState<OrgSummary>({
    revenueAtRisk: 0,
    incrementalRevenue: 0,
    customersImpacted: 0,
    roiPercent: 0,
    lastUpdate: null,
  });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  
  const narratives = [
    {
      title: "Insight do Mês",
      text: "A base de clientes premium apresenta 23% mais propensão a churn em relação ao mês anterior.",
    },
    {
      title: "Oportunidade Detectada",
      text: "O segmento 'Alto Valor' tem potencial de R$ 2.4M em receita incremental.",
    },
    {
      title: "Ação Sugerida",
      text: "Priorize contato com os 500 clientes do grupo crítico identificados esta semana.",
    },
  ];

  const fetchData = useCallback(async (isRefresh = false) => {
    if (!currentOrganization?.id) {
      setLoading(false);
      return;
    }
    
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    
    try {
      const { data: projectsData } = await supabase
        .from('projects')
        .select('id, name, problem_type, status')
        .eq('organization_id', currentOrganization.id)
        .order('updated_at', { ascending: false })
        .limit(5);
      
      const projectSummaries: ProjectSummary[] = [];
      let totalRevAtRisk = 0;
      let totalIncRevenue = 0;
      let totalCustomers = 0;
      let totalROIPercent = 0;
      let projectsWithROI = 0;
      
      for (const project of projectsData || []) {
        const { count: predictionsCount } = await supabase
          .from('predictions')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', project.id)
          .eq('is_latest', true);
        
        const { count: highRiskCount } = await supabase
          .from('predictions')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', project.id)
          .eq('is_latest', true)
          .gte('probability_event', 0.7);
        
        const { data: configData } = await supabase
          .from('project_business_config')
          .select('average_sale_value, average_margin_percent')
          .eq('project_id', project.id)
          .maybeSingle();
        
        const { data: actionsData } = await supabase
          .from('project_actions')
          .select('target_customers, observed_conversion_percent, expected_conversion_percent')
          .eq('project_id', project.id)
          .eq('status', 'completed');
        
        const avgSaleValue = configData?.average_sale_value || 0;
        const marginPercent = configData?.average_margin_percent || 0;
        
        const revAtRisk = (highRiskCount || 0) * avgSaleValue;
        totalRevAtRisk += revAtRisk;
        
        let projectIncRevenue = 0;
        let projectCustomers = 0;
        let projectCost = 0;
        
        for (const action of actionsData || []) {
          if (action.observed_conversion_percent !== null) {
            const baseConv = action.expected_conversion_percent || 0;
            const obsConv = action.observed_conversion_percent || 0;
            const incCustomers = Math.round(((obsConv - baseConv) / 100) * (action.target_customers || 0));
            projectIncRevenue += incCustomers * avgSaleValue * (marginPercent / 100);
            projectCustomers += action.target_customers || 0;
          }
        }
        
        totalIncRevenue += projectIncRevenue;
        totalCustomers += projectCustomers;
        
        if (projectCost > 0) {
          totalROIPercent += ((projectIncRevenue - projectCost) / projectCost) * 100;
          projectsWithROI++;
        }
        
        projectSummaries.push({
          id: project.id,
          name: project.name,
          problem_type: project.problem_type,
          status: project.status,
          predictions_count: predictionsCount || 0,
          high_risk_count: highRiskCount || 0,
        });
      }
      
      setProjects(projectSummaries);
      setOrgSummary({
        revenueAtRisk: totalRevAtRisk,
        incrementalRevenue: totalIncRevenue,
        customersImpacted: totalCustomers,
        roiPercent: projectsWithROI > 0 ? totalROIPercent / projectsWithROI : 0,
        lastUpdate: new Date(),
      });
    } catch (error) {
      console.error('Error fetching executive data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentOrganization?.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = () => {
    fetchData(true);
  };

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
      case 'classification': return 'Classificação';
      case 'regression': return 'Regressão';
      default: return type;
    }
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      draft: 'bg-muted text-muted-foreground',
      data_ready: 'bg-blue-500/10 text-blue-600',
      trained: 'bg-green-500/10 text-green-600',
      deployed: 'bg-purple-500/10 text-purple-600',
    };
    const labels: Record<string, string> = {
      draft: 'Rascunho',
      data_ready: 'Dados OK',
      trained: 'Treinado',
      deployed: 'Em Produção',
    };
    return (
      <Badge variant="secondary" className={colors[status] || 'bg-muted'}>
        {labels[status] || status}
      </Badge>
    );
  };

  if (orgLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <AppShell>
      <div className="p-4 pb-8 space-y-6 max-w-lg mx-auto">
        {/* Last update info + refresh */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="w-4 h-4" />
            <span>
              {orgSummary.lastUpdate 
                ? `Atualizado ${orgSummary.lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                : 'Atualizando...'}
            </span>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {!currentOrganization ? (
          <Card className="p-8 text-center">
            <h3 className="text-lg font-semibold mb-2">Selecione uma Organização</h3>
            <p className="text-muted-foreground">
              Use o ícone de perfil para acessar suas configurações.
            </p>
          </Card>
        ) : loading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        ) : (
          <>
            {/* Business Summary Section */}
            <section>
              <h2 className="text-lg font-semibold mb-3">Resumo do Negócio</h2>
              <div className="grid grid-cols-2 gap-3">
                <Card className="bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="w-5 h-5 text-red-600" />
                      <span className="text-xs text-muted-foreground">Receita em Risco</span>
                    </div>
                    <p className="text-xl font-bold text-red-600">
                      {orgSummary.revenueAtRisk > 0 ? formatCurrency(orgSummary.revenueAtRisk) : '—'}
                    </p>
                  </CardContent>
                </Card>

                <Card className="bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <TrendingUp className="w-5 h-5 text-green-600" />
                      <span className="text-xs text-muted-foreground">Receita Incremental</span>
                    </div>
                    <p className="text-xl font-bold text-green-600">
                      {orgSummary.incrementalRevenue > 0 ? formatCurrency(orgSummary.incrementalRevenue) : '—'}
                    </p>
                  </CardContent>
                </Card>

                <Card className="bg-purple-50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-900">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="w-5 h-5 text-purple-600" />
                      <span className="text-xs text-muted-foreground">Clientes Impactados</span>
                    </div>
                    <p className="text-xl font-bold text-purple-600">
                      {orgSummary.customersImpacted > 0 ? formatNumber(orgSummary.customersImpacted) : '—'}
                    </p>
                  </CardContent>
                </Card>

                <Card className="bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Percent className="w-5 h-5 text-blue-600" />
                      <span className="text-xs text-muted-foreground">ROI Médio</span>
                    </div>
                    <p className="text-xl font-bold text-blue-600">
                      {orgSummary.roiPercent !== 0 ? `${orgSummary.roiPercent.toFixed(0)}%` : '—'}
                    </p>
                  </CardContent>
                </Card>
              </div>
            </section>

            {/* Projects Section */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Projetos</h2>
                <button 
                  onClick={() => navigate('/executivo/projetos')}
                  className="text-sm text-primary font-medium"
                >
                  Ver todos
                </button>
              </div>
              {projects.length === 0 ? (
                <Card className="p-6 text-center">
                  <p className="text-muted-foreground">
                    Nenhum projeto encontrado.
                  </p>
                </Card>
              ) : (
                <div className="space-y-3">
                  {projects.slice(0, 3).map((project) => (
                    <Card 
                      key={project.id}
                      className="cursor-pointer hover:shadow-md transition-all active:scale-[0.99]"
                      onClick={() => navigate(`/executivo/projeto/${project.id}`)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold truncate">{project.name}</h3>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs text-muted-foreground">
                                {getProblemTypeLabel(project.problem_type)}
                              </span>
                              {getStatusBadge(project.status)}
                            </div>
                            <div className="mt-2 text-sm">
                              {project.high_risk_count > 0 ? (
                                <span className="text-red-600 font-medium">
                                  {formatNumber(project.high_risk_count)} em alto risco
                                </span>
                              ) : project.predictions_count > 0 ? (
                                <span className="text-muted-foreground">
                                  {formatNumber(project.predictions_count)} predições
                                </span>
                              ) : (
                                <span className="text-muted-foreground">
                                  Sem predições ainda
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            {/* AI Narratives Section */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">Narrativas da Lys</h2>
              </div>
              <div className="space-y-3">
                {narratives.map((narrative, index) => (
                  <Card key={index} className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
                    <CardContent className="p-4">
                      <h4 className="font-medium text-primary mb-1">{narrative.title}</h4>
                      <p className="text-sm text-muted-foreground">{narrative.text}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <p className="text-xs text-muted-foreground text-center mt-3">
                * Narrativas ilustrativas — em breve com dados reais
              </p>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
};

export default ExecutiveHome;
