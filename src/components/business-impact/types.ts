export interface BusinessConfig {
  id?: string;
  project_id: string;
  average_sale_value: number;
  average_margin_percent: number;
  cost_per_contact: number;
  impact_window_days: number;
  baseline_conversion_percent: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectAction {
  id?: string;
  project_id: string;
  user_id: string;
  action_name: string;
  action_type: ActionType;
  segment_used: string | null;
  target_customers: number;
  start_date: string;
  end_date: string | null;
  expected_conversion_percent: number;
  observed_conversion_percent: number | null;
  success_metric: string | null;
  notes: string | null;
  status: ActionStatus;
  created_at?: string;
  updated_at?: string;
}

export type ActionType = 'whatsapp' | 'email' | 'sales_force' | 'push' | 'sms' | 'call' | 'other';
export type ActionStatus = 'planned' | 'running' | 'completed' | 'cancelled';

export interface ROICalculation {
  incrementalConversionPercent: number;
  incrementalCustomers: number;
  incrementalRevenue: number;
  incrementalProfit: number;
  totalCost: number;
  netROI: number;
  roiPercent: number;
}

export const ACTION_TYPES: { value: ActionType; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'E-mail' },
  { value: 'sales_force', label: 'Força de Vendas' },
  { value: 'push', label: 'Push Notification' },
  { value: 'sms', label: 'SMS' },
  { value: 'call', label: 'Ligação' },
  { value: 'other', label: 'Outro' },
];

export const ACTION_STATUSES: { value: ActionStatus; label: string; color: string }[] = [
  { value: 'planned', label: 'Planejada', color: 'bg-blue-500' },
  { value: 'running', label: 'Em Execução', color: 'bg-yellow-500' },
  { value: 'completed', label: 'Concluída', color: 'bg-green-500' },
  { value: 'cancelled', label: 'Cancelada', color: 'bg-gray-500' },
];
