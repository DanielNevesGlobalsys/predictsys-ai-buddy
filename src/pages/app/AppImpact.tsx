import { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Users, 
  Percent,
  CheckCircle2,
  RefreshCw,
  Filter
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import AppShell from '@/components/app/AppShell';
import { ACTION_TYPES, ACTION_STATUSES } from '@/components/business-impact/types';

interface ImpactMetrics {
  revenueAtRisk: number;
  incrementalRevenue: number;
  totalCost: number;
  netROI: number;
  roiPercent: number;
  customersImpacted: number;
  actionsCompleted: number;
}

interface ActionItem {
  id: string;
  action_name: string;
  action_type: string;
  status: string;
  project_id: string;
  project_name: string;
  target_customers: number | null;
  start_date: string;
  end_date: string | null;
  expected_conversion_percent: number | null;
  observed_conversion_percent: number | null;
}

const AppImpact = () => {
  const { currentOrganization } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [metrics, setMetrics] = useState<ImpactMetrics>({
    revenueAtRisk: 0,
    incrementalRevenue: 0,
    totalCost: 0,
    netROI: 0,
    roiPercent: 0,
    customersImpacted: 0,
    actionsCompleted: 0,
  });
  const [allActions, setAllActions] = useState<ActionItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [projects, setProjects] = useState<{id: string; name: string}[]>([]);

  const fetchData = async () => {
    if (!currentOrganization?.id) {
      setLoading(false);
      return;
    }

    try {
      // Get all projects for this org
      const { data: projectsData } = await supabase
        .from('projects')
        .select('id, name')
        .eq('organization_id', currentOrganization.id);

      setProjects(projectsData || []);

      let totalRevAtRisk = 0;
      let totalIncRevenue = 0;
      let totalCost = 0;
      let totalCustomers = 0;
      let totalActions = 0;
      const actionsList: ActionItem[] = [];

      for (const project of projectsData || []) {
        // Get business config
        const { data: config } = await supabase
          .from('project_business_config')
          .select('average_sale_value, average_margin_percent, cost_per_contact, baseline_conversion_percent')
          .eq('project_id', project.id)
          .maybeSingle();

        const avgSaleValue = config?.average_sale_value || 0;
        const marginPercent = config?.average_margin_percent || 0;
        const costPerContact = config?.cost_per_contact || 0;

        // Get latest batch_id from SSOT
        const { data: predState } = await supabase
          .from('project_prediction_state')
          .select('latest_batch_id')
          .eq('project_id', project.id)
          .maybeSingle();
        const batchId = predState?.latest_batch_id;

        const { count: highRiskCount } = await supabase
          .from('predictions')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', project.id)
          .eq(batchId ? 'batch_id' : 'is_latest', batchId || true)
          .gte('probability_event', 0.7);

        totalRevAtRisk += (highRiskCount || 0) * avgSaleValue;

        // Get all actions
        const { data: actions } = await supabase
          .from('project_actions')
          .select('*')
          .eq('project_id', project.id)
          .order('start_date', { ascending: false });

        for (const action of actions || []) {
          actionsList.push({
            ...action,
            project_name: project.name,
          });

          if (action.status === 'completed' && action.observed_conversion_percent !== null) {
            const baseConv = action.expected_conversion_percent || config?.baseline_conversion_percent || 0;
            const obsConv = action.observed_conversion_percent || 0;
            const customers = action.target_customers || 0;
            
            const incCustomers = Math.round(((obsConv - baseConv) / 100) * customers);
            const incRevenue = incCustomers * avgSaleValue * (marginPercent / 100);
            const cost = customers * costPerContact;
            
            totalIncRevenue += incRevenue;
            totalCost += cost;
            totalCustomers += customers;
            totalActions++;
          }
        }
      }

      const netROI = totalIncRevenue - totalCost;
      const roiPercent = totalCost > 0 ? ((netROI / totalCost) * 100) : 0;

      setMetrics({
        revenueAtRisk: totalRevAtRisk,
        incrementalRevenue: totalIncRevenue,
        totalCost,
        netROI,
        roiPercent,
        customersImpacted: totalCustomers,
        actionsCompleted: totalActions,
      });
      setAllActions(actionsList);
    } catch (error) {
      console.error('Error fetching impact data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [currentOrganization?.id]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
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

  const filteredActions = allActions.filter(action => {
    if (statusFilter !== 'all' && action.status !== statusFilter) return false;
    if (projectFilter !== 'all' && action.project_id !== projectFilter) return false;
    return true;
  });

  const metricCards = [
    {
      label: 'Receita em Risco',
      value: formatCurrency(metrics.revenueAtRisk),
      icon: <TrendingDown className="w-5 h-5" />,
      color: 'text-red-600',
      bgColor: 'bg-red-50 dark:bg-red-950/20',
      borderColor: 'border-red-200 dark:border-red-900',
    },
    {
      label: 'Receita Incremental',
      value: formatCurrency(metrics.incrementalRevenue),
      icon: <TrendingUp className="w-5 h-5" />,
      color: 'text-green-600',
      bgColor: 'bg-green-50 dark:bg-green-950/20',
      borderColor: 'border-green-200 dark:border-green-900',
    },
    {
      label: 'ROI Líquido',
      value: formatCurrency(metrics.netROI),
      icon: <DollarSign className="w-5 h-5" />,
      color: metrics.netROI >= 0 ? 'text-primary' : 'text-destructive',
      bgColor: 'bg-primary/5',
      borderColor: 'border-primary/20',
    },
    {
      label: 'ROI %',
      value: `${metrics.roiPercent.toFixed(0)}%`,
      icon: <Percent className="w-5 h-5" />,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50 dark:bg-purple-950/20',
      borderColor: 'border-purple-200 dark:border-purple-900',
    },
    {
      label: 'Clientes Impactados',
      value: metrics.customersImpacted.toLocaleString('pt-BR'),
      icon: <Users className="w-5 h-5" />,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50 dark:bg-blue-950/20',
      borderColor: 'border-blue-200 dark:border-blue-900',
    },
    {
      label: 'Ações Concluídas',
      value: metrics.actionsCompleted.toString(),
      icon: <CheckCircle2 className="w-5 h-5" />,
      color: 'text-secondary',
      bgColor: 'bg-secondary/10',
      borderColor: 'border-secondary/20',
    },
  ];

  return (
    <AppShell>
      <div className="p-4 space-y-6 max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold">Impacto de Negócio</h2>
            <p className="text-sm text-muted-foreground">
              Visão consolidada da organização
            </p>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Metrics Grid */}
        {loading ? (
          <div className="grid grid-cols-2 gap-3">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {metricCards.map((card) => (
              <Card 
                key={card.label} 
                className={`${card.bgColor} ${card.borderColor} border`}
              >
                <CardContent className="p-4">
                  <div className={`flex items-center gap-2 mb-2 ${card.color}`}>
                    {card.icon}
                    <span className="text-sm font-medium text-muted-foreground">
                      {card.label}
                    </span>
                  </div>
                  <p className={`text-2xl font-bold ${card.color}`}>
                    {card.value}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="flex-1 h-9">
              <SelectValue placeholder="Projeto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os projetos</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-32 h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {ACTION_STATUSES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Actions List */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Campanhas & Ações</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {filteredActions.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">
                <p>Nenhuma ação encontrada.</p>
                <p className="text-xs mt-1">
                  Registre ações no painel web para visualizar o impacto aqui.
                </p>
              </div>
            ) : (
              <div className="divide-y max-h-96 overflow-y-auto">
                {filteredActions.map((action) => {
                  const hasResult = action.observed_conversion_percent !== null;
                  const convDiff = hasResult 
                    ? (action.observed_conversion_percent! - (action.expected_conversion_percent || 0)) 
                    : null;
                  
                  return (
                    <div key={action.id} className="p-4">
                      <div className="flex items-start justify-between mb-1">
                        <div>
                          <h4 className="font-medium">{action.action_name}</h4>
                          <p className="text-xs text-muted-foreground">
                            {action.project_name} • {getActionTypeLabel(action.action_type)}
                          </p>
                        </div>
                        {getStatusBadge(action.status)}
                      </div>
                      
                      <div className="flex items-center justify-between text-sm mt-2">
                        <span className="text-muted-foreground">
                          {action.target_customers?.toLocaleString('pt-BR') || '—'} clientes
                        </span>
                        <span className="text-muted-foreground">
                          {format(new Date(action.start_date), 'dd/MM/yy', { locale: ptBR })}
                        </span>
                      </div>
                      
                      {hasResult && (
                        <div className="flex items-center justify-between text-sm mt-1">
                          <span className="text-muted-foreground">
                            Conv: {action.expected_conversion_percent?.toFixed(1)}% → {action.observed_conversion_percent?.toFixed(1)}%
                          </span>
                          <span className={`font-semibold ${convDiff && convDiff > 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {convDiff && convDiff > 0 ? '+' : ''}{convDiff?.toFixed(1)}%
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
};

export default AppImpact;
