import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { BusinessConfig, ProjectAction, ROICalculation } from '../types';

const DEFAULT_CONFIG: Omit<BusinessConfig, 'project_id'> = {
  average_sale_value: 0,
  average_margin_percent: 0,
  cost_per_contact: 0,
  impact_window_days: 30,
  baseline_conversion_percent: 0,
};

export function useBusinessImpact(projectId: string) {
  const [config, setConfig] = useState<BusinessConfig | null>(null);
  const [actions, setActions] = useState<ProjectAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch config and actions
  const fetchData = useCallback(async () => {
    if (!projectId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Fetch config
      const { data: configData, error: configError } = await supabase
        .from('project_business_config' as any)
        .select('*')
        .eq('project_id', projectId)
        .maybeSingle();
      
      if (configError) throw configError;
      
      if (configData) {
        setConfig(configData as unknown as BusinessConfig);
      } else {
        // Set default config if none exists
        setConfig({ ...DEFAULT_CONFIG, project_id: projectId });
      }
      
      // Fetch actions
      const { data: actionsData, error: actionsError } = await supabase
        .from('project_actions' as any)
        .select('*')
        .eq('project_id', projectId)
        .order('start_date', { ascending: false });
      
      if (actionsError) throw actionsError;
      
      setActions((actionsData as unknown as ProjectAction[]) || []);
    } catch (err) {
      console.error('Error fetching business impact data:', err);
      setError(err instanceof Error ? err.message : 'Erro ao carregar dados');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Save config
  const saveConfig = useCallback(async (newConfig: Partial<BusinessConfig>) => {
    if (!projectId) return;
    
    setSaving(true);
    setError(null);
    
    try {
      const configToSave = {
        ...config,
        ...newConfig,
        project_id: projectId,
      };
      
      // Check if config exists
      const { data: existing } = await supabase
        .from('project_business_config' as any)
        .select('id')
        .eq('project_id', projectId)
        .maybeSingle();
      
      if (existing) {
        // Update
        const { error: updateError } = await supabase
          .from('project_business_config' as any)
          .update({
            average_sale_value: configToSave.average_sale_value,
            average_margin_percent: configToSave.average_margin_percent,
            cost_per_contact: configToSave.cost_per_contact,
            impact_window_days: configToSave.impact_window_days,
            baseline_conversion_percent: configToSave.baseline_conversion_percent,
          })
          .eq('project_id', projectId);
        
        if (updateError) throw updateError;
      } else {
        // Insert
        const { error: insertError } = await supabase
          .from('project_business_config' as any)
          .insert({
            project_id: projectId,
            average_sale_value: configToSave.average_sale_value,
            average_margin_percent: configToSave.average_margin_percent,
            cost_per_contact: configToSave.cost_per_contact,
            impact_window_days: configToSave.impact_window_days,
            baseline_conversion_percent: configToSave.baseline_conversion_percent,
          });
        
        if (insertError) throw insertError;
      }
      
      setConfig(configToSave as BusinessConfig);
      return true;
    } catch (err) {
      console.error('Error saving config:', err);
      setError(err instanceof Error ? err.message : 'Erro ao salvar configuração');
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId, config]);

  // Create action
  const createAction = useCallback(async (action: Omit<ProjectAction, 'id' | 'created_at' | 'updated_at'>) => {
    setSaving(true);
    setError(null);
    
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error('Usuário não autenticado');
      
      const { data, error: insertError } = await supabase
        .from('project_actions' as any)
        .insert({
          ...action,
          project_id: projectId,
          user_id: userData.user.id,
        })
        .select()
        .single();
      
      if (insertError) throw insertError;
      
      setActions(prev => [data as unknown as ProjectAction, ...prev]);
      return true;
    } catch (err) {
      console.error('Error creating action:', err);
      setError(err instanceof Error ? err.message : 'Erro ao criar ação');
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  // Update action
  const updateAction = useCallback(async (actionId: string, updates: Partial<ProjectAction>) => {
    setSaving(true);
    setError(null);
    
    try {
      const { error: updateError } = await supabase
        .from('project_actions' as any)
        .update(updates)
        .eq('id', actionId);
      
      if (updateError) throw updateError;
      
      setActions(prev => prev.map(a => 
        a.id === actionId ? { ...a, ...updates } : a
      ));
      return true;
    } catch (err) {
      console.error('Error updating action:', err);
      setError(err instanceof Error ? err.message : 'Erro ao atualizar ação');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  // Delete action
  const deleteAction = useCallback(async (actionId: string) => {
    setSaving(true);
    setError(null);
    
    try {
      const { error: deleteError } = await supabase
        .from('project_actions' as any)
        .delete()
        .eq('id', actionId);
      
      if (deleteError) throw deleteError;
      
      setActions(prev => prev.filter(a => a.id !== actionId));
      return true;
    } catch (err) {
      console.error('Error deleting action:', err);
      setError(err instanceof Error ? err.message : 'Erro ao excluir ação');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  // Calculate ROI for a single action
  const calculateActionROI = useCallback((action: ProjectAction): ROICalculation | null => {
    if (!config || action.observed_conversion_percent === null) return null;
    
    const baselineConversion = action.expected_conversion_percent || config.baseline_conversion_percent;
    const incrementalConversionPercent = action.observed_conversion_percent - baselineConversion;
    const incrementalCustomers = Math.round((incrementalConversionPercent / 100) * action.target_customers);
    const incrementalRevenue = incrementalCustomers * config.average_sale_value;
    const incrementalProfit = incrementalRevenue * (config.average_margin_percent / 100);
    const totalCost = action.target_customers * config.cost_per_contact;
    const netROI = incrementalProfit - totalCost;
    const roiPercent = totalCost > 0 ? (netROI / totalCost) * 100 : 0;
    
    return {
      incrementalConversionPercent,
      incrementalCustomers,
      incrementalRevenue,
      incrementalProfit,
      totalCost,
      netROI,
      roiPercent,
    };
  }, [config]);

  // Calculate total ROI across all completed actions
  const totalROI = useMemo(() => {
    const completedActions = actions.filter(a => a.status === 'completed' && a.observed_conversion_percent !== null);
    
    let totalIncrementalRevenue = 0;
    let totalIncrementalProfit = 0;
    let totalCost = 0;
    let totalCustomersImpacted = 0;
    
    completedActions.forEach(action => {
      const roi = calculateActionROI(action);
      if (roi) {
        totalIncrementalRevenue += roi.incrementalRevenue;
        totalIncrementalProfit += roi.incrementalProfit;
        totalCost += roi.totalCost;
        totalCustomersImpacted += action.target_customers;
      }
    });
    
    const netROI = totalIncrementalProfit - totalCost;
    const roiPercent = totalCost > 0 ? (netROI / totalCost) * 100 : 0;
    
    return {
      completedActionsCount: completedActions.length,
      totalCustomersImpacted,
      totalIncrementalRevenue,
      totalIncrementalProfit,
      totalCost,
      netROI,
      roiPercent,
    };
  }, [actions, calculateActionROI]);

  return {
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
    refetch: fetchData,
  };
}
