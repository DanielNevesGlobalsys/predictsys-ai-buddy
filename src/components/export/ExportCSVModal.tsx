import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Info, Loader2 } from "lucide-react";
import { trackEvent } from "@/lib/platformTracking";
import { logProjectAuditEvent } from "@/lib/auditLog";

interface ExportCSVModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  exportContext: 'dashboard' | 'eda' | 'data';
  currentFilters?: {
    horizon?: number;
    segmentField?: string | null;
    segmentValue?: string | null;
    batchId?: string | null;
  };
  onExportStarted?: () => void;
}

export function ExportCSVModal({
  open,
  onOpenChange,
  projectId,
  exportContext,
  currentFilters,
  onExportStarted,
}: ExportCSVModalProps) {
  const { t } = useTranslation();
  const [exportType, setExportType] = useState<string>(
    exportContext === 'dashboard' ? 'predictions' : 
    exportContext === 'eda' ? 'eda_results' : 'dataset'
  );
  const [applyFilters, setApplyFilters] = useState<string>('current');
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Build parameters based on filters
      const parameters: Record<string, any> = {};
      
      if (exportType === 'predictions' && applyFilters === 'current' && currentFilters) {
        if (currentFilters.horizon) parameters.horizon_days = currentFilters.horizon;
        if (currentFilters.segmentField && currentFilters.segmentValue) {
          parameters.segment_field = currentFilters.segmentField;
          parameters.segment_value = currentFilters.segmentValue;
        }
        if (currentFilters.batchId) parameters.batch_id = currentFilters.batchId;
      }

      // Create export job
      const { data: job, error: insertError } = await supabase
        .from('export_jobs')
        .insert({
          project_id: projectId,
          user_id: user.id,
          export_type: exportType,
          parameters,
          status: 'pending',
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Trigger the processing edge function
      const { error: invokeError } = await supabase.functions.invoke('process-export', {
        body: { job_id: job.id, trigger_type: 'manual' },
      });

      if (invokeError) {
        console.warn('Edge function invocation warning:', invokeError);
        // The job was created, it will be picked up by the worker
      }

      toast.success(t('export.started'), {
        description: t('export.startedDescription'),
      });

      // Track segment export event
      trackEvent({
        event_type: "segment_exported",
        project_id: projectId,
        source: "app",
        metadata: { export_type: exportType },
      });

      // Audit log for LGPD compliance
      logProjectAuditEvent(
        projectId,
        "segment_exported",
        "export",
        exportType,
        { filters: currentFilters }
      );

      onOpenChange(false);
      onExportStarted?.();
    } catch (error) {
      console.error('Error creating export job:', error);
      toast.error(t('export.error'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {t('export.title')}
          </DialogTitle>
          <DialogDescription>
            {t('export.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Export Type Selection */}
          <div className="space-y-3">
            <Label>{t('export.whatToExport')}</Label>
            <RadioGroup value={exportType} onValueChange={setExportType}>
              {exportContext === 'dashboard' && (
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="predictions" id="predictions" />
                  <Label htmlFor="predictions" className="font-normal cursor-pointer">
                    {t('export.types.predictions')}
                  </Label>
                </div>
              )}
              {exportContext === 'eda' && (
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="eda_results" id="eda_results" />
                  <Label htmlFor="eda_results" className="font-normal cursor-pointer">
                    {t('export.types.eda_results')}
                  </Label>
                </div>
              )}
              {exportContext === 'data' && (
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="dataset" id="dataset" />
                  <Label htmlFor="dataset" className="font-normal cursor-pointer">
                    {t('export.types.dataset')}
                  </Label>
                </div>
              )}
            </RadioGroup>
          </div>

          {/* Filters for predictions */}
          {exportType === 'predictions' && currentFilters && (
            <div className="space-y-3">
              <Label>{t('export.filters')}</Label>
              <Select value={applyFilters} onValueChange={setApplyFilters}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">{t('export.applyCurrentFilters')}</SelectItem>
                  <SelectItem value="all">{t('export.allPredictions')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Info alert */}
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              {t('export.backgroundInfo')}
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleExport} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('export.starting')}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                {t('export.startExport')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
