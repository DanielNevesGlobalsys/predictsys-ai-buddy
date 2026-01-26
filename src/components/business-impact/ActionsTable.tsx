import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Plus, Pencil, Trash2, TrendingUp, TrendingDown, Minus, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ProjectAction, BusinessConfig, ROICalculation } from './types';
import { ACTION_TYPES, ACTION_STATUSES } from './types';
import { ActionFormModal } from './ActionFormModal';

interface ActionsTableProps {
  actions: ProjectAction[];
  config: BusinessConfig | null;
  calculateROI: (action: ProjectAction) => ROICalculation | null;
  onCreate: (action: Omit<ProjectAction, 'id' | 'created_at' | 'updated_at'>) => Promise<boolean>;
  onUpdate: (actionId: string, updates: Partial<ProjectAction>) => Promise<boolean>;
  onDelete: (actionId: string) => Promise<boolean>;
  saving: boolean;
}

export function ActionsTable({ 
  actions, 
  config,
  calculateROI,
  onCreate, 
  onUpdate, 
  onDelete,
  saving 
}: ActionsTableProps) {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<ProjectAction | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [actionToDelete, setActionToDelete] = useState<string | null>(null);

  const handleEdit = (action: ProjectAction) => {
    setEditingAction(action);
    setModalOpen(true);
  };

  const handleCreate = () => {
    setEditingAction(null);
    setModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (actionToDelete) {
      await onDelete(actionToDelete);
      setActionToDelete(null);
      setDeleteDialogOpen(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = ACTION_STATUSES.find(s => s.value === status);
    return (
      <Badge variant="secondary" className={`${statusConfig?.color} text-white`}>
        {statusConfig?.label || status}
      </Badge>
    );
  };

  const getActionTypeLabel = (type: string) => {
    return ACTION_TYPES.find(t => t.value === type)?.label || type;
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', { 
      style: 'currency', 
      currency: 'BRL',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const ROIIndicator = ({ roi }: { roi: ROICalculation | null }) => {
    if (!roi) {
      return <span className="text-muted-foreground">-</span>;
    }

    const isPositive = roi.netROI > 0;
    const isNeutral = roi.netROI === 0;

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`flex items-center gap-1 font-medium ${
              isPositive ? 'text-green-600' : isNeutral ? 'text-muted-foreground' : 'text-red-600'
            }`}>
              {isPositive ? (
                <TrendingUp className="w-4 h-4" />
              ) : isNeutral ? (
                <Minus className="w-4 h-4" />
              ) : (
                <TrendingDown className="w-4 h-4" />
              )}
              {formatCurrency(roi.netROI)}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="space-y-1 text-sm">
              <p>Δ Conversão: {roi.incrementalConversionPercent.toFixed(1)}%</p>
              <p>Clientes incrementais: {roi.incrementalCustomers}</p>
              <p>Receita incremental: {formatCurrency(roi.incrementalRevenue)}</p>
              <p>Lucro incremental: {formatCurrency(roi.incrementalProfit)}</p>
              <p>Custo total: {formatCurrency(roi.totalCost)}</p>
              <p className="font-medium">ROI: {roi.roiPercent.toFixed(0)}%</p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('businessImpact.actionsTitle')}</CardTitle>
              <CardDescription>
                {t('businessImpact.actionsDescription')}
              </CardDescription>
            </div>
            <Button onClick={handleCreate} className="gap-2">
              <Plus className="w-4 h-4" />
              {t('businessImpact.newAction')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {actions.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p>{t('businessImpact.noActions')}</p>
              <p className="text-sm mt-2">{t('businessImpact.noActionsHint')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('businessImpact.actionName')}</TableHead>
                    <TableHead>{t('businessImpact.actionType')}</TableHead>
                    <TableHead>{t('businessImpact.status')}</TableHead>
                    <TableHead className="text-right">{t('businessImpact.targetCustomers')}</TableHead>
                    <TableHead>{t('businessImpact.period')}</TableHead>
                    <TableHead className="text-right">{t('businessImpact.conversion')}</TableHead>
                    <TableHead className="text-right">{t('businessImpact.roiResult')}</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actions.map((action) => {
                    const roi = calculateROI(action);
                    return (
                      <TableRow key={action.id}>
                        <TableCell className="font-medium">
                          <div>
                            {action.action_name}
                            {action.segment_used && (
                              <span className="block text-xs text-muted-foreground">
                                {action.segment_used}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{getActionTypeLabel(action.action_type)}</TableCell>
                        <TableCell>{getStatusBadge(action.status)}</TableCell>
                        <TableCell className="text-right">
                          {action.target_customers.toLocaleString('pt-BR')}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {format(new Date(action.start_date), 'dd/MM/yy', { locale: ptBR })}
                            {action.end_date && (
                              <span> - {format(new Date(action.end_date), 'dd/MM/yy', { locale: ptBR })}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="text-sm">
                            <span className="text-muted-foreground">
                              {action.expected_conversion_percent.toFixed(1)}%
                            </span>
                            {action.observed_conversion_percent !== null && (
                              <span className="font-medium">
                                {' → '}{action.observed_conversion_percent.toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <ROIIndicator roi={roi} />
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleEdit(action)}>
                                <Pencil className="w-4 h-4 mr-2" />
                                {t('common.edit')}
                              </DropdownMenuItem>
                              <DropdownMenuItem 
                                onClick={() => {
                                  setActionToDelete(action.id!);
                                  setDeleteDialogOpen(true);
                                }}
                                className="text-destructive"
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                {t('common.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ActionFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        action={editingAction}
        onSave={onCreate}
        onUpdate={onUpdate}
        saving={saving}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('businessImpact.deleteActionTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('businessImpact.deleteActionDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
