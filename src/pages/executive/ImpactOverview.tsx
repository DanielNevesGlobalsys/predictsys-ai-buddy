import { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Users, 
  Percent,
  CheckCircle2,
  RefreshCw
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import AppShell from '@/components/executive/AppShell';

interface ImpactMetrics {
  revenueAtRisk: number;
  incrementalRevenue: number;
  totalCost: number;
  netROI: number;
  roiPercent: number;
  customersImpacted: number;
  actionsCompleted: number;
}

const ImpactOverview = () => {
  const { currentOrganization } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<ImpactMetrics>({
    revenueAtRisk: 0,
    incrementalRevenue: 0,
    totalCost: 0,
    netROI: 0,
    roiPercent: 0,
    customersImpacted: 0,
    actionsCompleted: 0,
  });
  const [refreshing, setRefreshing] = useState(false);

  const fetchMetrics = async () => {
    if (!currentOrganization?.id) {
      setLoading(false);
      return;
    }

    try {
      // Get all projects for this org
      const { data: projects } = await supabase
        .from('projects')
        .select('id')
        .eq('organization_id', currentOrganization.id);

      let totalRevAtRisk = 0;
      let totalIncRevenue = 0;
      let totalCost = 0;
      let totalCustomers = 0;
      let totalActions = 0;

      for (const project of projects || []) {
        // Get business config
        const { data: config } = await supabase
          .from('project_business_config')
          .select('average_sale_value, average_margin_percent, cost_per_contact')
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

        // Get completed actions
        const { data: actions } = await supabase
          .from('project_actions')
          .select('*')
          .eq('project_id', project.id)
          .eq('status', 'completed');

        for (const action of actions || []) {
          if (action.observed_conversion_percent !== null) {
            const baseConv = action.expected_conversion_percent || 0;
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
    } catch (error) {
      console.error('Error fetching impact metrics:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
  }, [currentOrganization?.id]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchMetrics();
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

  const cards = [
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
      <div className="p-4 space-y-6">
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
            {cards.map((card) => (
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

        {/* Empty state */}
        {!loading && metrics.actionsCompleted === 0 && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">
              Nenhuma ação concluída ainda.
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Registre ações no painel web para visualizar o impacto aqui.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default ImpactOverview;
