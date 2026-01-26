import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Settings2, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { BusinessConfig } from './types';

interface BusinessConfigFormProps {
  config: BusinessConfig | null;
  onSave: (config: Partial<BusinessConfig>) => Promise<boolean>;
  saving: boolean;
}

export function BusinessConfigForm({ config, onSave, saving }: BusinessConfigFormProps) {
  const { t } = useTranslation();
  
  const [formData, setFormData] = useState({
    average_sale_value: 0,
    average_margin_percent: 0,
    cost_per_contact: 0,
    impact_window_days: 30,
    baseline_conversion_percent: 0,
  });
  
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (config) {
      setFormData({
        average_sale_value: config.average_sale_value || 0,
        average_margin_percent: config.average_margin_percent || 0,
        cost_per_contact: config.cost_per_contact || 0,
        impact_window_days: config.impact_window_days || 30,
        baseline_conversion_percent: config.baseline_conversion_percent || 0,
      });
      setHasChanges(false);
    }
  }, [config]);

  const handleChange = (field: keyof typeof formData, value: number) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    const success = await onSave(formData);
    if (success) {
      setHasChanges(false);
    }
  };

  const FieldTooltip = ({ content }: { content: string }) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <HelpCircle className="w-4 h-4 text-muted-foreground cursor-help" />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p>{content}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="w-5 h-5" />
          {t('businessImpact.configTitle')}
        </CardTitle>
        <CardDescription>
          {t('businessImpact.configDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Average Sale Value */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              {t('businessImpact.averageSaleValue')}
              <FieldTooltip content={t('businessImpact.averageSaleValueTooltip')} />
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                R$
              </span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={formData.average_sale_value}
                onChange={(e) => handleChange('average_sale_value', parseFloat(e.target.value) || 0)}
                className="pl-10"
              />
            </div>
          </div>

          {/* Average Margin */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              {t('businessImpact.averageMargin')}
              <FieldTooltip content={t('businessImpact.averageMarginTooltip')} />
            </Label>
            <div className="relative">
              <Input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={formData.average_margin_percent}
                onChange={(e) => handleChange('average_margin_percent', parseFloat(e.target.value) || 0)}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                %
              </span>
            </div>
          </div>

          {/* Cost per Contact */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              {t('businessImpact.costPerContact')}
              <FieldTooltip content={t('businessImpact.costPerContactTooltip')} />
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                R$
              </span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={formData.cost_per_contact}
                onChange={(e) => handleChange('cost_per_contact', parseFloat(e.target.value) || 0)}
                className="pl-10"
              />
            </div>
          </div>

          {/* Impact Window */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              {t('businessImpact.impactWindow')}
              <FieldTooltip content={t('businessImpact.impactWindowTooltip')} />
            </Label>
            <Select
              value={formData.impact_window_days.toString()}
              onValueChange={(value) => handleChange('impact_window_days', parseInt(value))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 {t('common.days')}</SelectItem>
                <SelectItem value="14">14 {t('common.days')}</SelectItem>
                <SelectItem value="30">30 {t('common.days')}</SelectItem>
                <SelectItem value="60">60 {t('common.days')}</SelectItem>
                <SelectItem value="90">90 {t('common.days')}</SelectItem>
                <SelectItem value="180">180 {t('common.days')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Baseline Conversion */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              {t('businessImpact.baselineConversion')}
              <FieldTooltip content={t('businessImpact.baselineConversionTooltip')} />
            </Label>
            <div className="relative">
              <Input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={formData.baseline_conversion_percent}
                onChange={(e) => handleChange('baseline_conversion_percent', parseFloat(e.target.value) || 0)}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                %
              </span>
            </div>
          </div>
        </div>

        <div className="flex justify-end mt-6">
          <Button 
            onClick={handleSave} 
            disabled={saving || !hasChanges}
            className="gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
