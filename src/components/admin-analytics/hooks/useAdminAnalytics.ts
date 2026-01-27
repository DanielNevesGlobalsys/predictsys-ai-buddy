import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { 
  AnalyticsData, 
  TimeToValueData, 
  DateRange, 
  GlobalKPIs, 
  HealthMetrics, 
  OrganizationUsage, 
  DailyTrend,
  TimeToValueGlobal,
  TimeToValueByOrg
} from "../types";

const DEFAULT_GLOBAL_KPIS: GlobalKPIs = {
  projects_created: 0,
  datasets_connected: 0,
  models_trained: 0,
  predictions_run: 0,
  segments_exported: 0,
  jobs_error_count: 0,
  active_organizations: 0,
  total_organizations: 0,
};

const DEFAULT_HEALTH_METRICS: HealthMetrics = {
  avg_import_ms: 0,
  avg_eda_ms: 0,
  avg_train_ms: 0,
  avg_predict_ms: 0,
  total_errors: 0,
};

const DEFAULT_TTV: TimeToValueGlobal = {
  avg_project_to_dataset_hours: 0,
  avg_dataset_to_training_hours: 0,
  avg_training_to_prediction_hours: 0,
  avg_prediction_to_export_hours: 0,
  avg_total_time_to_value_hours: 0,
  projects_with_dataset_pct: 0,
  projects_with_training_pct: 0,
  projects_with_prediction_pct: 0,
  projects_with_export_pct: 0,
  total_projects: 0,
};

export function useAdminAnalytics() {
  const { toast } = useToast();
  
  const [dateRange, setDateRange] = useState<DateRange>("30");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingTTV, setIsLoadingTTV] = useState(true);
  
  // Data states
  const [globalKPIs, setGlobalKPIs] = useState<GlobalKPIs>(DEFAULT_GLOBAL_KPIS);
  const [healthMetrics, setHealthMetrics] = useState<HealthMetrics>(DEFAULT_HEALTH_METRICS);
  const [organizationUsage, setOrganizationUsage] = useState<OrganizationUsage[]>([]);
  const [dailyTrend, setDailyTrend] = useState<DailyTrend[]>([]);
  const [timeToValue, setTimeToValue] = useState<TimeToValueGlobal>(DEFAULT_TTV);
  const [timeToValueByOrg, setTimeToValueByOrg] = useState<TimeToValueByOrg[]>([]);

  const getDateFromDays = (days: number): string => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split("T")[0];
  };

  const fetchAnalyticsData = useCallback(async () => {
    try {
      setIsLoading(true);
      
      const dateFrom = getDateFromDays(parseInt(dateRange));
      const dateTo = new Date().toISOString().split("T")[0];

      const { data, error } = await supabase.functions.invoke<AnalyticsData>("analytics-data", {
        body: null,
        headers: {},
      });

      // Construct URL with params
      const params = new URLSearchParams({
        date_from: dateFrom,
        date_to: dateTo,
      });
      if (selectedOrgId) {
        params.append("organization_id", selectedOrgId);
      }

      const response = await supabase.functions.invoke("analytics-data", {
        body: null,
        headers: {
          "x-params": params.toString(),
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const result = response.data as AnalyticsData;

      if (result?.success) {
        setGlobalKPIs(result.global_kpis || DEFAULT_GLOBAL_KPIS);
        setHealthMetrics(result.health_metrics || DEFAULT_HEALTH_METRICS);
        setOrganizationUsage(result.organization_usage || []);
        setDailyTrend(result.daily_trend || []);
      }
    } catch (error) {
      console.error("[useAdminAnalytics] Error fetching data:", error);
      toast({
        title: "Erro",
        description: "Erro ao carregar dados de analytics",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [dateRange, selectedOrgId, toast]);

  const fetchTimeToValue = useCallback(async () => {
    try {
      setIsLoadingTTV(true);
      
      const dateFrom = getDateFromDays(parseInt(dateRange));
      const dateTo = new Date().toISOString();

      const params = new URLSearchParams({
        date_from: dateFrom,
        date_to: dateTo,
      });
      if (selectedOrgId) {
        params.append("organization_id", selectedOrgId);
      }

      const response = await supabase.functions.invoke("analytics-time-to-value", {
        body: null,
        headers: {
          "x-params": params.toString(),
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const result = response.data as TimeToValueData;

      if (result?.success) {
        setTimeToValue(result.global_averages || DEFAULT_TTV);
        setTimeToValueByOrg(result.by_organization || []);
      }
    } catch (error) {
      console.error("[useAdminAnalytics] Error fetching TTV:", error);
    } finally {
      setIsLoadingTTV(false);
    }
  }, [dateRange, selectedOrgId]);

  const refresh = useCallback(() => {
    fetchAnalyticsData();
    fetchTimeToValue();
  }, [fetchAnalyticsData, fetchTimeToValue]);

  useEffect(() => {
    fetchAnalyticsData();
    fetchTimeToValue();
  }, [fetchAnalyticsData, fetchTimeToValue]);

  return {
    // State
    dateRange,
    setDateRange,
    selectedOrgId,
    setSelectedOrgId,
    isLoading,
    isLoadingTTV,
    // Data
    globalKPIs,
    healthMetrics,
    organizationUsage,
    dailyTrend,
    timeToValue,
    timeToValueByOrg,
    // Actions
    refresh,
  };
}
