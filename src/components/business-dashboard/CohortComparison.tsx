import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Users } from 'lucide-react';
import type { Prediction, DashboardFilters } from './types';

interface CohortComparisonProps {
  predictions: Prediction[];
  problemType: string;
  availableFields: string[];
  viewMode: DashboardFilters['viewMode'];
}

const HIGH_PROBABILITY_THRESHOLD = 0.7;

export function CohortComparison({ predictions, problemType, availableFields, viewMode }: CohortComparisonProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
  const [groupField, setGroupField] = useState(availableFields[0] || 'segment');
  
  const fieldLabels: Record<string, string> = {
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
  
  const cohortData = useMemo(() => {
    const cohorts = new Map<string, { count: number; probabilities: number[]; values: number[]; highProbCount: number }>();
    
    predictions.forEach(p => {
      const cohortValue = p[groupField as keyof Prediction] as string | null;
      if (!cohortValue) return;
      
      if (!cohorts.has(cohortValue)) {
        cohorts.set(cohortValue, { count: 0, probabilities: [], values: [], highProbCount: 0 });
      }
      
      const cohort = cohorts.get(cohortValue)!;
      cohort.count++;
      
      if (p.probability_event !== null) {
        cohort.probabilities.push(p.probability_event);
        if (p.probability_event >= HIGH_PROBABILITY_THRESHOLD) {
          cohort.highProbCount++;
        }
      }
      
      if (p.predicted_value !== null) {
        cohort.values.push(p.predicted_value);
      }
    });
    
    return Array.from(cohorts.entries())
      .map(([cohort, data]) => ({
        cohort,
        count: data.count,
        avgProbability: data.probabilities.length > 0 
          ? data.probabilities.reduce((a, b) => a + b, 0) / data.probabilities.length 
          : null,
        avgValue: data.values.length > 0 
          ? data.values.reduce((a, b) => a + b, 0) / data.values.length 
          : null,
        highProbabilityPercent: data.count > 0 ? (data.highProbCount / data.count) * 100 : 0
      }))
      .sort((a, b) => {
        if (isClassification) return (b.avgProbability || 0) - (a.avgProbability || 0);
        return (b.avgValue || 0) - (a.avgValue || 0);
      })
      .slice(0, 10);
  }, [predictions, groupField, isClassification]);
  
  const formatCurrency = (val: number) => {
    if (val >= 1000000) return `R$ ${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `R$ ${(val / 1000).toFixed(1)}K`;
    return `R$ ${val.toFixed(0)}`;
  };

  const chartData = cohortData.map(c => ({
    name: c.cohort.length > 12 ? c.cohort.slice(0, 12) + '...' : c.cohort,
    fullName: c.cohort,
    avgProbability: isClassification ? (c.avgProbability || 0) * 100 : 0,
    avgValue: !isClassification ? (c.avgValue || 0) : 0,
    highProbPercent: c.highProbabilityPercent,
    count: c.count
  }));

  if (availableFields.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            {t('businessDashboard.cohortComparison.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.cohortComparison.noFields')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              {t('businessDashboard.cohortComparison.title')}
            </CardTitle>
            <CardDescription>
              {t('businessDashboard.cohortComparison.description')}
            </CardDescription>
          </div>
          
          <Select value={groupField} onValueChange={setGroupField}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t('businessDashboard.cohortComparison.groupBy')} />
            </SelectTrigger>
            <SelectContent>
              {availableFields.map(field => (
                <SelectItem key={field} value={field}>
                  {fieldLabels[field] || field}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {cohortData.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.cohortComparison.noData')}
          </p>
        ) : (
          <div className="grid lg:grid-cols-2 gap-6">
            {/* Chart */}
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="name" 
                    tick={{ fontSize: 11 }}
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  {isClassification ? (
                    <YAxis 
                      tickFormatter={(val) => `${val}%`}
                      domain={[0, 100]}
                    />
                  ) : (
                    <YAxis 
                      tickFormatter={(val) => formatCurrency(val)}
                    />
                  )}
                  <Tooltip 
                    formatter={(value: number, name: string) => {
                      if (name === 'avgProbability') {
                        return [`${value.toFixed(1)}%`, t('businessDashboard.cohortComparison.avgProbability')];
                      }
                      if (name === 'avgValue') {
                        return [formatCurrency(value), t('businessDashboard.cohortComparison.avgValue')];
                      }
                      return [`${value.toFixed(1)}%`, t('businessDashboard.cohortComparison.highProbPercent')];
                    }}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName || ''}
                  />
                  <Legend />
                  {isClassification ? (
                    <>
                      <Bar 
                        dataKey="avgProbability" 
                        fill="hsl(var(--primary))" 
                        name={t('businessDashboard.cohortComparison.avgProbability')}
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar 
                        dataKey="highProbPercent" 
                        fill="hsl(var(--chart-3))" 
                        name={viewMode === 'risk' 
                          ? t('businessDashboard.cohortComparison.highRisk')
                          : t('businessDashboard.cohortComparison.highOpp')
                        }
                        radius={[4, 4, 0, 0]}
                      />
                    </>
                  ) : (
                    <Bar 
                      dataKey="avgValue" 
                      fill="hsl(var(--primary))" 
                      name={t('businessDashboard.cohortComparison.avgValue')}
                      radius={[4, 4, 0, 0]}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            
            {/* Table */}
            <div className="overflow-auto max-h-72">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('businessDashboard.cohortComparison.cohort')}</TableHead>
                    <TableHead className="text-right">{t('businessDashboard.cohortComparison.count')}</TableHead>
                    <TableHead className="text-right">
                      {isClassification 
                        ? t('businessDashboard.cohortComparison.avgProb')
                        : t('businessDashboard.cohortComparison.avgVal')
                      }
                    </TableHead>
                    {isClassification && (
                      <TableHead className="text-right">
                        {viewMode === 'risk' 
                          ? t('businessDashboard.cohortComparison.highRiskShort')
                          : t('businessDashboard.cohortComparison.highOppShort')
                        }
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cohortData.map((c, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium truncate max-w-[120px]" title={c.cohort}>
                        {c.cohort}
                      </TableCell>
                      <TableCell className="text-right">{c.count.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {isClassification
                          ? (c.avgProbability !== null ? `${(c.avgProbability * 100).toFixed(1)}%` : '-')
                          : (c.avgValue !== null ? formatCurrency(c.avgValue) : '-')
                        }
                      </TableCell>
                      {isClassification && (
                        <TableCell className="text-right">
                          {c.highProbabilityPercent.toFixed(1)}%
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
