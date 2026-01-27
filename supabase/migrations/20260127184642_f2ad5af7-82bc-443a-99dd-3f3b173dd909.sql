-- ========================================
-- MÓDULO LGPD & GOVERNANÇA - MIGRATION
-- ========================================

-- 1) Tabela de Configuração LGPD por Organização
CREATE TABLE public.organization_data_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  data_retention_months INTEGER NOT NULL DEFAULT 12,
  anonymize_ids BOOLEAN NOT NULL DEFAULT false,
  log_retention_months INTEGER NOT NULL DEFAULT 12,
  allow_data_export BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger para updated_at
CREATE TRIGGER update_organization_data_policy_updated_at
  BEFORE UPDATE ON public.organization_data_policy
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- Enable RLS
ALTER TABLE public.organization_data_policy ENABLE ROW LEVEL SECURITY;

-- RLS Policies para organization_data_policy
CREATE POLICY "Org admins can view their org data policy"
  ON public.organization_data_policy FOR SELECT
  USING (
    is_super_admin(auth.uid()) 
    OR (
      user_belongs_to_org(auth.uid(), organization_id) 
      AND has_role(auth.uid(), 'org_admin')
    )
  );

CREATE POLICY "Org admins can insert their org data policy"
  ON public.organization_data_policy FOR INSERT
  WITH CHECK (
    is_super_admin(auth.uid()) 
    OR (
      user_belongs_to_org(auth.uid(), organization_id) 
      AND has_role(auth.uid(), 'org_admin')
    )
  );

CREATE POLICY "Org admins can update their org data policy"
  ON public.organization_data_policy FOR UPDATE
  USING (
    is_super_admin(auth.uid()) 
    OR (
      user_belongs_to_org(auth.uid(), organization_id) 
      AND has_role(auth.uid(), 'org_admin')
    )
  );

CREATE POLICY "Super admins can delete org data policy"
  ON public.organization_data_policy FOR DELETE
  USING (is_super_admin(auth.uid()));

-- 2) Tabela de Auditoria de Ações Sensíveis
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT
);

-- Índices para performance
CREATE INDEX idx_audit_org_time ON public.audit_logs (organization_id, timestamp DESC);
CREATE INDEX idx_audit_action ON public.audit_logs (action, timestamp DESC);
CREATE INDEX idx_audit_user ON public.audit_logs (user_id, timestamp DESC);

-- Enable RLS
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies para audit_logs
CREATE POLICY "Super admins can view all audit logs"
  ON public.audit_logs FOR SELECT
  USING (is_super_admin(auth.uid()));

CREATE POLICY "Org admins can view their org audit logs"
  ON public.audit_logs FOR SELECT
  USING (
    user_belongs_to_org(auth.uid(), organization_id) 
    AND has_role(auth.uid(), 'org_admin')
  );

CREATE POLICY "Service role can insert audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can insert their own audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL 
    AND (user_id = auth.uid() OR user_id IS NULL)
    AND user_belongs_to_org(auth.uid(), organization_id)
  );

-- Super admins e service role podem deletar (para limpeza automática)
CREATE POLICY "Service role can delete audit logs"
  ON public.audit_logs FOR DELETE
  USING (auth.role() = 'service_role');

CREATE POLICY "Super admins can delete audit logs"
  ON public.audit_logs FOR DELETE
  USING (is_super_admin(auth.uid()));