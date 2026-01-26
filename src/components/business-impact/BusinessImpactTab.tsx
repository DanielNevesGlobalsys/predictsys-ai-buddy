import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, TrendingUp } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useBusinessImpact } from './hooks/useBusinessImpact';
import { BusinessConfigForm } from './BusinessConfigForm';
import { ROISummaryCards } from './ROISummaryCards';
import { ActionsTable } from './ActionsTable';

interface BusinessImpactTabProps {
  projectId: string;
}

export function BusinessImpactTab({ projectId }: BusinessImpactTabProps) {
  const { t } = useTranslation();
  
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

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
    </div>
  );
}
