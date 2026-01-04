import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Layers } from 'lucide-react';
import type { SegmentationBand, DashboardFilters } from './types';

interface ProbabilitySegmentationProps {
  bands: SegmentationBand[];
  problemType: string;
  viewMode: DashboardFilters['viewMode'];
}

export function ProbabilitySegmentation({ bands, problemType, viewMode }: ProbabilitySegmentationProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
  const colors = [
    'hsl(var(--chart-1))',
    'hsl(var(--chart-2))',
    'hsl(var(--chart-3))',
    'hsl(var(--chart-4))',
    'hsl(var(--chart-5))'
  ];
  
  const chartData = bands.map((band, index) => ({
    name: band.range,
    value: band.count,
    percent: band.percent,
    fill: colors[index % colors.length]
  }));
  
  const formatCurrency = (num: number | null) => {
    if (num === null) return '-';
    return `R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const getInterpretation = () => {
    if (bands.length === 0) return '';
    
    const highBands = bands.filter(b => b.min >= 0.6);
    const highCount = highBands.reduce((sum, b) => sum + b.count, 0);
    const highPercent = bands.length > 0 
      ? (highCount / bands.reduce((sum, b) => sum + b.count, 0)) * 100 
      : 0;
    
    if (viewMode === 'risk') {
      return t('businessDashboard.segmentation.riskInterpretation', { percent: highPercent.toFixed(1) });
    }
    return t('businessDashboard.segmentation.opportunityInterpretation', { percent: highPercent.toFixed(1) });
  };

  if (bands.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="w-5 h-5" />
            {t('businessDashboard.segmentation.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.segmentation.noData')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="w-5 h-5" />
          {t('businessDashboard.segmentation.title')}
        </CardTitle>
        <CardDescription>
          {isClassification 
            ? t('businessDashboard.segmentation.classificationDesc')
            : t('businessDashboard.segmentation.regressionDesc')
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Chart */}
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} />
                <XAxis type="number" tickFormatter={(val) => `${val}`} />
                <YAxis 
                  dataKey="name" 
                  type="category" 
                  width={60}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip 
                  formatter={(value: number) => [value, t('businessDashboard.segmentation.records')]}
                  labelFormatter={(label) => `${t('businessDashboard.segmentation.band')}: ${label}`}
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
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('businessDashboard.segmentation.band')}</TableHead>
                  <TableHead className="text-right">{t('businessDashboard.segmentation.records')}</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  {isClassification && (
                    <TableHead className="text-right">{t('businessDashboard.segmentation.avgValue')}</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {bands.map((band, index) => (
                  <TableRow key={index}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <div 
                          className="w-3 h-3 rounded-full" 
                          style={{ backgroundColor: colors[index % colors.length] }}
                        />
                        {band.range}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{band.count.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{band.percent.toFixed(1)}%</TableCell>
                    {isClassification && (
                      <TableCell className="text-right">{formatCurrency(band.avgPotentialValue)}</TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        
        {/* Interpretation */}
        <div className="mt-4 p-3 bg-muted/50 rounded-lg">
          <p className="text-sm text-muted-foreground">
            {getInterpretation()}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
