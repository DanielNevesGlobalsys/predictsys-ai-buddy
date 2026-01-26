import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ProjectAction, ActionType, ActionStatus } from './types';
import { ACTION_TYPES, ACTION_STATUSES } from './types';

interface ActionFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action?: ProjectAction | null;
  onSave: (action: Omit<ProjectAction, 'id' | 'created_at' | 'updated_at'>) => Promise<boolean>;
  onUpdate?: (actionId: string, updates: Partial<ProjectAction>) => Promise<boolean>;
  saving: boolean;
}

const initialFormState = {
  action_name: '',
  action_type: 'email' as ActionType,
  segment_used: '',
  target_customers: 0,
  start_date: format(new Date(), 'yyyy-MM-dd'),
  end_date: '',
  expected_conversion_percent: 0,
  observed_conversion_percent: null as number | null,
  success_metric: '',
  notes: '',
  status: 'planned' as ActionStatus,
};

export function ActionFormModal({ 
  open, 
  onOpenChange, 
  action, 
  onSave, 
  onUpdate,
  saving 
}: ActionFormModalProps) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState(initialFormState);
  
  const isEditing = !!action;

  useEffect(() => {
    if (action) {
      setFormData({
        action_name: action.action_name,
        action_type: action.action_type,
        segment_used: action.segment_used || '',
        target_customers: action.target_customers,
        start_date: action.start_date,
        end_date: action.end_date || '',
        expected_conversion_percent: action.expected_conversion_percent,
        observed_conversion_percent: action.observed_conversion_percent,
        success_metric: action.success_metric || '',
        notes: action.notes || '',
        status: action.status,
      });
    } else {
      setFormData(initialFormState);
    }
  }, [action, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const actionData = {
      ...formData,
      project_id: action?.project_id || '',
      user_id: action?.user_id || '',
      segment_used: formData.segment_used || null,
      end_date: formData.end_date || null,
      success_metric: formData.success_metric || null,
      notes: formData.notes || null,
    };
    
    let success = false;
    
    if (isEditing && action?.id && onUpdate) {
      success = await onUpdate(action.id, actionData);
    } else {
      success = await onSave(actionData);
    }
    
    if (success) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('businessImpact.editAction') : t('businessImpact.newAction')}
          </DialogTitle>
          <DialogDescription>
            {t('businessImpact.actionFormDescription')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Action Name */}
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="action_name">{t('businessImpact.actionName')} *</Label>
              <Input
                id="action_name"
                value={formData.action_name}
                onChange={(e) => setFormData(prev => ({ ...prev, action_name: e.target.value }))}
                placeholder={t('businessImpact.actionNamePlaceholder')}
                required
              />
            </div>

            {/* Action Type */}
            <div className="space-y-2">
              <Label>{t('businessImpact.actionType')} *</Label>
              <Select
                value={formData.action_type}
                onValueChange={(value: ActionType) => setFormData(prev => ({ ...prev, action_type: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTION_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Status */}
            <div className="space-y-2">
              <Label>{t('businessImpact.status')} *</Label>
              <Select
                value={formData.status}
                onValueChange={(value: ActionStatus) => setFormData(prev => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTION_STATUSES.map(status => (
                    <SelectItem key={status.value} value={status.value}>
                      {status.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Segment Used */}
            <div className="space-y-2">
              <Label htmlFor="segment_used">{t('businessImpact.segmentUsed')}</Label>
              <Input
                id="segment_used"
                value={formData.segment_used}
                onChange={(e) => setFormData(prev => ({ ...prev, segment_used: e.target.value }))}
                placeholder={t('businessImpact.segmentUsedPlaceholder')}
              />
            </div>

            {/* Target Customers */}
            <div className="space-y-2">
              <Label htmlFor="target_customers">{t('businessImpact.targetCustomers')} *</Label>
              <Input
                id="target_customers"
                type="number"
                min="0"
                value={formData.target_customers}
                onChange={(e) => setFormData(prev => ({ ...prev, target_customers: parseInt(e.target.value) || 0 }))}
                required
              />
            </div>

            {/* Start Date */}
            <div className="space-y-2">
              <Label htmlFor="start_date">{t('businessImpact.startDate')} *</Label>
              <Input
                id="start_date"
                type="date"
                value={formData.start_date}
                onChange={(e) => setFormData(prev => ({ ...prev, start_date: e.target.value }))}
                required
              />
            </div>

            {/* End Date */}
            <div className="space-y-2">
              <Label htmlFor="end_date">{t('businessImpact.endDate')}</Label>
              <Input
                id="end_date"
                type="date"
                value={formData.end_date}
                onChange={(e) => setFormData(prev => ({ ...prev, end_date: e.target.value }))}
              />
            </div>

            {/* Expected Conversion */}
            <div className="space-y-2">
              <Label htmlFor="expected_conversion">{t('businessImpact.expectedConversion')}</Label>
              <div className="relative">
                <Input
                  id="expected_conversion"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={formData.expected_conversion_percent}
                  onChange={(e) => setFormData(prev => ({ ...prev, expected_conversion_percent: parseFloat(e.target.value) || 0 }))}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
              </div>
            </div>

            {/* Observed Conversion */}
            <div className="space-y-2">
              <Label htmlFor="observed_conversion">{t('businessImpact.observedConversion')}</Label>
              <div className="relative">
                <Input
                  id="observed_conversion"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={formData.observed_conversion_percent ?? ''}
                  onChange={(e) => setFormData(prev => ({ 
                    ...prev, 
                    observed_conversion_percent: e.target.value ? parseFloat(e.target.value) : null 
                  }))}
                  placeholder={t('businessImpact.fillAfterCompletion')}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
              </div>
            </div>

            {/* Success Metric */}
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="success_metric">{t('businessImpact.successMetric')}</Label>
              <Input
                id="success_metric"
                value={formData.success_metric}
                onChange={(e) => setFormData(prev => ({ ...prev, success_metric: e.target.value }))}
                placeholder={t('businessImpact.successMetricPlaceholder')}
              />
            </div>

            {/* Notes */}
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="notes">{t('businessImpact.notes')}</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder={t('businessImpact.notesPlaceholder')}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('common.saving') : (isEditing ? t('common.save') : t('common.create'))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
