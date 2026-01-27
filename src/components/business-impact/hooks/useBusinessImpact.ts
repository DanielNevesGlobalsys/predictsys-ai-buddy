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

// Helper to normalize config values (handle nulls from database)
function normalizeConfig(data: any, projectId: string): BusinessConfig {
  return {
    id: data?.id,
    project_id: projectId,
    average_sale_value: data?.average_sale_value ?? 0,
    average_margin_percent: data?.average_margin_percent ?? 0,
    cost_per_contact: data?.cost_per_contact ?? 0,
    impact_window_days: data?.impact_window_days ?? 30,
    baseline_conversion_percent: data?.baseline_conversion_percent ?? 0,
    created_at: data?.created_at,
    updated_at: data?.updated_at,
  };
}

// Helper to normalize action values (handle nulls from database)
function normalizeAction(data: any): ProjectAction {
  return {
    ...data,
    target_customers: data.target_customers ?? 0,
    expected_conversion_percent: data.expected_conversion_percent ?? 0,
  };
}

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
      
      // Always normalize config to handle null values
      setConfig(normalizeConfig(configData, projectId));
      
      // Fetch actions
      const { data: actionsData, error: actionsError } = await supabase
        .from('project_actions' as any)
        .select('*')
        .eq('project_id', projectId)
        .order('start_date', { ascending: false });
      
      if (actionsError) throw actionsError;
      
      // Normalize all actions to handle null values
      const normalizedActions = (actionsData || []).map(normalizeAction);
      setActions(normalizedActions as ProjectAction[]);
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
    if (!projectId) return false;
    
    setSaving(true);
    setError(null);
    
    try {
      // Create normalized config with new values, ensuring no nulls
      const configToSave: BusinessConfig = {
        ...DEFAULT_CONFIG,
        ...config,
        ...newConfig,
        project_id: projectId,
        average_sale_value: newConfig.average_sale_value ?? config?.average_sale_value ?? 0,
        average_margin_percent: newConfig.average_margin_percent ?? config?.average_margin_percent ?? 0,
        cost_per_contact: newConfig.cost_per_contact ?? config?.cost_per_contact ?? 0,
        impact_window_days: newConfig.impact_window_days ?? config?.impact_window_days ?? 30,
        baseline_conversion_percent: newConfig.baseline_conversion_percent ?? config?.baseline_conversion_percent ?? 0,
      };
      
      // Check if config exists
      const { data: existing } = await supabase
        .from('project_business_config' as any)
        .select('id')
        .eq('project_id', projectId)
        .maybeSingle();
      
      if (existing) {
        // Update
        const { data: updatedData, error: updateError } = await supabase
          .from('project_business_config' as any)
          .update({
            average_sale_value: configToSave.average_sale_value,
            average_margin_percent: configToSave.average_margin_percent,
            cost_per_contact: configToSave.cost_per_contact,
            impact_window_days: configToSave.impact_window_days,
            baseline_conversion_percent: configToSave.baseline_conversion_percent,
          })
          .eq('project_id', projectId)
          .select()
          .single();
        
        if (updateError) throw updateError;
        
        // Update state with the returned data to ensure consistency
        setConfig(normalizeConfig(updatedData, projectId));
      } else {
        // Insert
        const { data: insertedData, error: insertError } = await supabase
          .from('project_business_config' as any)
          .insert({
            project_id: projectId,
            average_sale_value: configToSave.average_sale_value,
            average_margin_percent: configToSave.average_margin_percent,
            cost_per_contact: configToSave.cost_per_contact,
            impact_window_days: configToSave.impact_window_days,
            baseline_conversion_percent: configToSave.baseline_conversion_percent,
          })
          .select()
          .single();
        
        if (insertError) throw insertError;
        
        // Update state with the returned data
        setConfig(normalizeConfig(insertedData, projectId));
      }
      
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
          target_customers: action.target_customers ?? 0,
          expected_conversion_percent: action.expected_conversion_percent ?? 0,
        })
        .select()
        .single();
      
      if (insertError) throw insertError;
      
      // Normalize the returned action data
      const normalizedAction = normalizeAction(data);
      setActions(prev => [normalizedAction as ProjectAction, ...prev]);
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
      const { data: updatedData, error: updateError } = await supabase
        .from('project_actions' as any)
        .update(updates)
        .eq('id', actionId)
        .select()
        .single();
      
      if (updateError) throw updateError;
      
      // Normalize and update the action in state
      const normalizedAction = normalizeAction(updatedData);
      setActions(prev => prev.map(a => 
        a.id === actionId ? normalizedAction as ProjectAction : a
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

  // Calculate ROI for a single action - uses normalized config values
  const calculateActionROI = useCallback((action: ProjectAction): ROICalculation | null => {
    // Only calculate if we have config and observed conversion
    if (!config || action.observed_conversion_percent === null || action.observed_conversion_percent === undefined) {
      return null;
    }
    
    // Use normalized values (already handled nulls in fetch/save)
    const targetCustomers = action.target_customers ?? 0;
    const observedConversion = action.observed_conversion_percent ?? 0;
    const expectedConversion = action.expected_conversion_percent ?? 0;
    const baselineConversion = expectedConversion || (config.baseline_conversion_percent ?? 0);
    
    const avgSaleValue = config.average_sale_value ?? 0;
    const avgMarginPercent = config.average_margin_percent ?? 0;
    const costPerContact = config.cost_per_contact ?? 0;
    
    const incrementalConversionPercent = observedConversion - baselineConversion;
    const incrementalCustomers = Math.round((incrementalConversionPercent / 100) * targetCustomers);
    const incrementalRevenue = incrementalCustomers * avgSaleValue;
    const incrementalProfit = incrementalRevenue * (avgMarginPercent / 100);
    const totalCost = targetCustomers * costPerContact;
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

  // Calculate total ROI across all completed actions - reactive to config and actions changes
  const totalROI = useMemo(() => {
    // Filter only completed actions with observed conversion
    const completedActions = actions.filter(a => 
      a.status === 'completed' && 
      a.observed_conversion_percent !== null && 
      a.observed_conversion_percent !== undefined
    );
    
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
        // Handle potential null values
        totalCustomersImpacted += action.target_customers ?? 0;
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
  }, [actions, calculateActionROI, config]); // Added config dependency for full reactivity

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
