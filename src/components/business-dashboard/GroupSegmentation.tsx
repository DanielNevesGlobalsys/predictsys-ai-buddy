import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Users2 } from 'lucide-react';
import type { GroupSegmentation as GroupSegmentationType, DashboardFilters } from './types';

interface GroupSegmentationProps {
  groups: GroupSegmentationType[];
  problemType: string;
  availableFields: string[];
  currentField: string | null;
  onFieldChange: (field: string | null) => void;
  viewMode: DashboardFilters['viewMode'];
}

export function GroupSegmentation({ 
  groups, 
  problemType, 
  availableFields, 
  currentField, 
  onFieldChange,
  viewMode 
}: GroupSegmentationProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
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
  
  const colors = [
    'hsl(var(--chart-1))',
    'hsl(var(--chart-2))',
    'hsl(var(--chart-3))',
    'hsl(var(--chart-4))',
    'hsl(var(--chart-5))'
  ];
  
  const chartData = groups.slice(0, 10).map((group, index) => ({
    name: group.group.length > 15 ? group.group.slice(0, 15) + '...' : group.group,
    fullName: group.group,
    value: isClassification ? (group.avgProbability || 0) * 100 : (group.avgValue || 0),
    highPercent: group.highProbabilityPercent,
    count: group.count,
    fill: colors[index % colors.length]
  }));
  
  const formatValue = (val: number) => {
    if (isClassification) return `${val.toFixed(1)}%`;
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
    return val.toFixed(0);
  };

  if (availableFields.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users2 className="w-5 h-5" />
            {t('businessDashboard.groupSegmentation.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.groupSegmentation.noFields')}
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
              <Users2 className="w-5 h-5" />
              {t('businessDashboard.groupSegmentation.title')}
            </CardTitle>
            <CardDescription>
              {t('businessDashboard.groupSegmentation.description')}
            </CardDescription>
          </div>
          
          <Select 
            value={currentField || availableFields[0]} 
            onValueChange={onFieldChange}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t('businessDashboard.groupSegmentation.viewBy')} />
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
        {groups.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.groupSegmentation.noData')}
          </p>
        ) : (
          <div className="grid lg:grid-cols-2 gap-6">
            {/* Horizontal Bar Chart */}
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} />
                  <XAxis 
                    type="number" 
                    tickFormatter={formatValue}
                    domain={isClassification ? [0, 100] : undefined}
                  />
                  <YAxis 
                    dataKey="name" 
                    type="category" 
                    width={100}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip 
                    formatter={(value: number) => [
                      formatValue(value), 
                      isClassification 
                        ? t('businessDashboard.groupSegmentation.avgProbability')
                        : t('businessDashboard.groupSegmentation.avgValue')
                    ]}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.fullName || ''}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            
            {/* Table */}
            <div className="overflow-auto max-h-80">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('businessDashboard.groupSegmentation.group')}</TableHead>
                    <TableHead className="text-right">{t('businessDashboard.groupSegmentation.records')}</TableHead>
                    <TableHead className="text-right">
                      {isClassification 
                        ? t('businessDashboard.groupSegmentation.avgProb')
                        : t('businessDashboard.groupSegmentation.avgVal')
                      }
                    </TableHead>
                    {isClassification && (
                      <TableHead className="text-right">
                        {viewMode === 'risk' 
                          ? t('businessDashboard.groupSegmentation.highRisk')
                          : t('businessDashboard.groupSegmentation.highOpp')
                        }
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.slice(0, 10).map((group, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <div 
                            className="w-3 h-3 rounded-full flex-shrink-0" 
                            style={{ backgroundColor: colors[index % colors.length] }}
                          />
                          <span className="truncate max-w-[120px]" title={group.group}>
                            {group.group}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{group.count.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {isClassification 
                          ? `${((group.avgProbability || 0) * 100).toFixed(1)}%`
                          : formatValue(group.avgValue || 0)
                        }
                      </TableCell>
                      {isClassification && (
                        <TableCell className="text-right">
                          {group.highProbabilityPercent.toFixed(1)}%
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
