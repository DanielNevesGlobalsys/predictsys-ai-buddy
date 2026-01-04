import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Download, ListOrdered, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Prediction, DashboardFilters } from './types';

interface ActionableListProps {
  predictions: Prediction[];
  problemType: string;
  viewMode: DashboardFilters['viewMode'];
}

const PAGE_SIZE = 10;
const HIGH_PROBABILITY_THRESHOLD = 0.7;

export function ActionableList({ predictions, problemType, viewMode }: ActionableListProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
  const [sortBy, setSortBy] = useState<'probability' | 'value' | 'combined'>('probability');
  const [showHighOnly, setShowHighOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  
  const getProbabilityBand = (prob: number | null) => {
    if (prob === null) return '-';
    if (prob >= 0.8) return '80-100%';
    if (prob >= 0.6) return '60-80%';
    if (prob >= 0.4) return '40-60%';
    if (prob >= 0.2) return '20-40%';
    return '0-20%';
  };
  
  const sortedPredictions = useMemo(() => {
    let filtered = [...predictions];
    
    if (showHighOnly && isClassification) {
      filtered = filtered.filter(p => (p.probability_event || 0) >= HIGH_PROBABILITY_THRESHOLD);
    }
    
    filtered.sort((a, b) => {
      if (sortBy === 'probability') {
        return (b.probability_event || 0) - (a.probability_event || 0);
      } else if (sortBy === 'value') {
        return (b.potential_value || b.predicted_value || 0) - (a.potential_value || a.predicted_value || 0);
      } else {
        // Combined: probability * potential_value
        const scoreA = (a.probability_event || 0) * (a.potential_value || 1);
        const scoreB = (b.probability_event || 0) * (b.potential_value || 1);
        return scoreB - scoreA;
      }
    });
    
    return filtered;
  }, [predictions, sortBy, showHighOnly, isClassification]);
  
  const totalPages = Math.ceil(sortedPredictions.length / PAGE_SIZE);
  const paginatedPredictions = sortedPredictions.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );
  
  const formatCurrency = (val: number | null) => {
    if (val === null) return '-';
    return `R$ ${val.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };
  
  const exportCSV = () => {
    const headers = [
      t('businessDashboard.actionableList.entityId'),
      isClassification ? t('businessDashboard.actionableList.probability') : t('businessDashboard.actionableList.predictedValue'),
      t('businessDashboard.actionableList.segment'),
      t('businessDashboard.actionableList.region'),
      t('businessDashboard.actionableList.potentialValue'),
      t('businessDashboard.actionableList.band')
    ];
    
    const rows = sortedPredictions.map(p => [
      p.entity_id,
      isClassification ? `${((p.probability_event || 0) * 100).toFixed(1)}%` : (p.predicted_value || '-'),
      p.segment || '-',
      p.region || p.state || '-',
      p.potential_value || '-',
      getProbabilityBand(p.probability_event)
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `actionable_list_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ListOrdered className="w-5 h-5" />
              {t('businessDashboard.actionableList.title')}
            </CardTitle>
            <CardDescription>
              {t('businessDashboard.actionableList.description')}
            </CardDescription>
          </div>
          
          <div className="flex items-center gap-4 flex-wrap">
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t('businessDashboard.actionableList.sortBy')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="probability">
                  {isClassification 
                    ? t('businessDashboard.actionableList.byProbability')
                    : t('businessDashboard.actionableList.byValue')
                  }
                </SelectItem>
                <SelectItem value="value">{t('businessDashboard.actionableList.byPotential')}</SelectItem>
                <SelectItem value="combined">{t('businessDashboard.actionableList.byCombined')}</SelectItem>
              </SelectContent>
            </Select>
            
            {isClassification && (
              <div className="flex items-center gap-2">
                <Switch 
                  id="high-only" 
                  checked={showHighOnly} 
                  onCheckedChange={setShowHighOnly}
                />
                <Label htmlFor="high-only" className="text-sm">
                  {viewMode === 'risk'
                    ? t('businessDashboard.actionableList.highRiskOnly')
                    : t('businessDashboard.actionableList.highOppOnly')
                  }
                </Label>
              </div>
            )}
            
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="w-4 h-4 mr-2" />
              {t('businessDashboard.actionableList.export')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {sortedPredictions.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.actionableList.noData')}
          </p>
        ) : (
          <>
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('businessDashboard.actionableList.entityId')}</TableHead>
                    <TableHead className="text-right">
                      {isClassification 
                        ? t('businessDashboard.actionableList.probability')
                        : t('businessDashboard.actionableList.predictedValue')
                      }
                    </TableHead>
                    <TableHead>{t('businessDashboard.actionableList.segment')}</TableHead>
                    <TableHead>{t('businessDashboard.actionableList.region')}</TableHead>
                    <TableHead className="text-right">{t('businessDashboard.actionableList.potentialValue')}</TableHead>
                    <TableHead>{t('businessDashboard.actionableList.band')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedPredictions.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-sm">{p.entity_id}</TableCell>
                      <TableCell className="text-right">
                        {isClassification 
                          ? `${((p.probability_event || 0) * 100).toFixed(1)}%`
                          : formatCurrency(p.predicted_value)
                        }
                      </TableCell>
                      <TableCell>{p.segment || '-'}</TableCell>
                      <TableCell>{p.region || p.state || '-'}</TableCell>
                      <TableCell className="text-right">{formatCurrency(p.potential_value)}</TableCell>
                      <TableCell>
                        <span className={`px-2 py-1 rounded text-xs ${
                          (p.probability_event || 0) >= 0.6 
                            ? 'bg-destructive/10 text-destructive' 
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {getProbabilityBand(p.probability_event)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            
            {/* Pagination */}
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                {t('businessDashboard.actionableList.showing', {
                  from: (currentPage - 1) * PAGE_SIZE + 1,
                  to: Math.min(currentPage * PAGE_SIZE, sortedPredictions.length),
                  total: sortedPredictions.length
                })}
              </p>
              
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="icon" 
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm">
                  {currentPage} / {totalPages}
                </span>
                <Button 
                  variant="outline" 
                  size="icon" 
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
