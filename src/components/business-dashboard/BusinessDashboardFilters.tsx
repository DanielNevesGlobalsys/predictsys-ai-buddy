import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Filter, RotateCcw } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR, es } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import type { DashboardFilters } from './types';

interface BusinessDashboardFiltersProps {
  filters: DashboardFilters;
  onFilterChange: (filters: Partial<DashboardFilters>) => void;
  availableSegmentFields: string[];
}

export function BusinessDashboardFilters({ filters, onFilterChange, availableSegmentFields }: BusinessDashboardFiltersProps) {
  const { t, i18n } = useTranslation();
  
  const getLocale = () => {
    switch (i18n.language) {
      case 'es': return es;
      default: return ptBR;
    }
  };
  
  const segmentFieldLabels: Record<string, string> = {
    segment: t('businessDashboard.filters.segment'),
    age_group: t('businessDashboard.filters.ageGroup'),
    region: t('businessDashboard.filters.region'),
    state: t('businessDashboard.filters.state'),
    city: t('businessDashboard.filters.city'),
    product_category: t('businessDashboard.filters.productCategory'),
    channel: t('businessDashboard.filters.channel'),
    campaign: t('businessDashboard.filters.campaign'),
    cohort: t('businessDashboard.filters.cohort')
  };
  
  const resetFilters = () => {
    onFilterChange({
      dataset: 'latest',
      dateRange: { from: null, to: null },
      horizon: 30,
      segmentField: null,
      segmentValue: null,
      viewMode: 'risk'
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-4 p-4 bg-card rounded-xl border border-border">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Filter className="w-4 h-4" />
        <span className="text-sm font-medium">{t('businessDashboard.filters.title')}</span>
      </div>
      
      {/* Dataset */}
      <Select 
        value={filters.dataset} 
        onValueChange={(value: 'latest' | 'all') => onFilterChange({ dataset: value })}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t('businessDashboard.filters.dataset')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="latest">{t('businessDashboard.filters.latestBatch')}</SelectItem>
          <SelectItem value="all">{t('businessDashboard.filters.allPredictions')}</SelectItem>
        </SelectContent>
      </Select>
      
      {/* Date Range */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className={cn("justify-start text-left font-normal", !filters.dateRange.from && "text-muted-foreground")}>
            <CalendarIcon className="mr-2 h-4 w-4" />
            {filters.dateRange.from ? (
              filters.dateRange.to ? (
                <>
                  {format(filters.dateRange.from, "dd/MM/yy", { locale: getLocale() })} - {format(filters.dateRange.to, "dd/MM/yy", { locale: getLocale() })}
                </>
              ) : (
                format(filters.dateRange.from, "dd/MM/yyyy", { locale: getLocale() })
              )
            ) : (
              t('businessDashboard.filters.selectPeriod')
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            initialFocus
            mode="range"
            selected={{ from: filters.dateRange.from || undefined, to: filters.dateRange.to || undefined }}
            onSelect={(range) => onFilterChange({ dateRange: { from: range?.from || null, to: range?.to || null } })}
            numberOfMonths={2}
            locale={getLocale()}
          />
        </PopoverContent>
      </Popover>
      
      {/* Horizon */}
      <Select 
        value={String(filters.horizon)} 
        onValueChange={(value) => onFilterChange({ horizon: Number(value) as 30 | 60 | 90 | 180 | 365 })}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder={t('businessDashboard.filters.horizon')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="30">{t('businessDashboard.filters.next30Days')}</SelectItem>
          <SelectItem value="60">{t('businessDashboard.filters.next60Days')}</SelectItem>
          <SelectItem value="90">{t('businessDashboard.filters.next90Days')}</SelectItem>
          <SelectItem value="180">{t('businessDashboard.filters.next6Months')}</SelectItem>
          <SelectItem value="365">{t('businessDashboard.filters.next12Months')}</SelectItem>
        </SelectContent>
      </Select>
      
      {/* Segment Field */}
      {availableSegmentFields.length > 0 && (
        <Select 
          value={filters.segmentField || '__all__'} 
          onValueChange={(value) => onFilterChange({ segmentField: value === '__all__' ? null : value, segmentValue: null })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder={t('businessDashboard.filters.filterBy')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('businessDashboard.filters.allSegments')}</SelectItem>
            {availableSegmentFields.map(field => (
              <SelectItem key={field} value={field}>
                {segmentFieldLabels[field] || field}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      
      {/* View Mode Toggle */}
      <div className="flex items-center border border-border rounded-lg overflow-hidden">
        <Button 
          variant={filters.viewMode === 'risk' ? 'default' : 'ghost'}
          size="sm"
          className="rounded-none"
          onClick={() => onFilterChange({ viewMode: 'risk' })}
        >
          {t('businessDashboard.filters.riskView')}
        </Button>
        <Button 
          variant={filters.viewMode === 'opportunity' ? 'default' : 'ghost'}
          size="sm"
          className="rounded-none"
          onClick={() => onFilterChange({ viewMode: 'opportunity' })}
        >
          {t('businessDashboard.filters.opportunityView')}
        </Button>
      </div>
      
      {/* Reset */}
      <Button variant="ghost" size="icon" onClick={resetFilters}>
        <RotateCcw className="w-4 h-4" />
      </Button>
    </div>
  );
}
