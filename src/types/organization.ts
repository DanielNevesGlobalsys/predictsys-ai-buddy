// Organization types for multi-tenant system

export type AppRole = 'super_admin' | 'org_admin' | 'analyst' | 'viewer';
export type OrgPlan = 'trial' | 'standard' | 'enterprise';
export type UserStatus = 'active' | 'pending' | 'blocked';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  document: string | null;
  plan: OrgPlan;
  max_projects: number | null;
  max_rows: number | null;
  max_storage_mb: number | null;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationUser {
  id: string;
  organization_id: string;
  user_id: string;
  role: AppRole;
  status: UserStatus;
  created_at: string;
}

export interface OrganizationUserWithDetails extends OrganizationUser {
  organization?: Organization;
  profile?: {
    full_name: string;
  };
  email?: string;
}

export interface OrganizationWithStats extends Organization {
  users_count?: number;
  projects_count?: number;
  total_rows?: number;
}

export const ROLE_LABELS: Record<AppRole, { pt: string; en: string; es: string }> = {
  super_admin: { pt: 'Super Admin', en: 'Super Admin', es: 'Super Admin' },
  org_admin: { pt: 'Admin da Organização', en: 'Org Admin', es: 'Admin de Org' },
  analyst: { pt: 'Analista', en: 'Analyst', es: 'Analista' },
  viewer: { pt: 'Visualizador', en: 'Viewer', es: 'Visualizador' },
};

export const STATUS_LABELS: Record<UserStatus, { pt: string; en: string; es: string }> = {
  active: { pt: 'Ativo', en: 'Active', es: 'Activo' },
  pending: { pt: 'Pendente', en: 'Pending', es: 'Pendiente' },
  blocked: { pt: 'Bloqueado', en: 'Blocked', es: 'Bloqueado' },
};

export const PLAN_LABELS: Record<OrgPlan, { pt: string; en: string; es: string }> = {
  trial: { pt: 'Trial', en: 'Trial', es: 'Trial' },
  standard: { pt: 'Standard', en: 'Standard', es: 'Standard' },
  enterprise: { pt: 'Enterprise', en: 'Enterprise', es: 'Enterprise' },
};

export const SANDBOX_ORG_ID = 'b0000000-0000-0000-0000-000000000001';
