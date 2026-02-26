import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, TrendingUp } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBusinessImpact } from './hooks/useBusinessImpact';
import { BusinessConfigForm } from './BusinessConfigForm';
import { ROISummaryCards } from './ROISummaryCards';
import { ActionsTable } from './ActionsTable';
import ChurnSimulator from './ChurnSimulator';
import { supabase } from '@/integrations/supabase/client';

interface BusinessImpactTabProps {
  projectId: string;
}

export function BusinessImpactTab({ projectId }: BusinessImpactTabProps) {
  const { t } = useTranslation();
  const [extendedMetrics, setExtendedMetrics] = useState<any>(null);
  const [totalEntities, setTotalEntities] = useState(0);
  const [problemType, setProblemType] = useState<string>('classification');
  
  const {
    config,
    actions,
    loading,
    saving,
    error,
    saveConfig,
    createAction,
    updateAction,
    deleteAction,
    calculateActionROI,
    totalROI,
  } = useBusinessImpact(projectId);

  // Load extended metrics from latest training run
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const { data: project } = await supabase
        .from('projects')
        .select('problem_type, total_rows')
        .eq('id', projectId)
        .maybeSingle();
      if (project) {
        setProblemType(project.problem_type || 'classification');
        setTotalEntities(project.total_rows || 0);
      }

      const { data: run } = await supabase
        .from('training_runs' as any)
        .select('extended_metrics')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const runData = run as any;
      if (runData?.extended_metrics) {
        setExtendedMetrics(runData.extended_metrics);
      }
    })();
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const hasSimulator = problemType === 'classification' && extendedMetrics;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <TrendingUp className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h2 className="text-2xl font-bold">{t('businessImpact.title')}</h2>
          <p className="text-muted-foreground">{t('businessImpact.subtitle')}</p>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="config" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="config">Configuração & Ações</TabsTrigger>
          {hasSimulator && <TabsTrigger value="simulator">Simulador de Impacto</TabsTrigger>}
        </TabsList>

        <TabsContent value="config" className="space-y-6 mt-4">
          {/* ROI Summary Cards */}
          <ROISummaryCards totalROI={totalROI} />

          {/* Configuration Form */}
          <BusinessConfigForm 
            config={config} 
            onSave={saveConfig} 
            saving={saving} 
          />

          {/* Actions Table */}
          <ActionsTable
            actions={actions}
            config={config}
            calculateROI={calculateActionROI}
            onCreate={createAction}
            onUpdate={updateAction}
            onDelete={deleteAction}
            saving={saving}
          />
        </TabsContent>

        {hasSimulator && (
          <TabsContent value="simulator" className="mt-4">
            <ChurnSimulator
              extendedMetrics={extendedMetrics}
              totalEntities={totalEntities}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
