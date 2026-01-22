import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Organization, OrganizationUser, AppRole } from '@/types/organization';

interface OrganizationContextType {
  organizations: Organization[];
  currentOrganization: Organization | null;
  currentRole: AppRole | null;
  userOrganizations: OrganizationUser[];
  isSuperAdmin: boolean;
  isOrgAdmin: boolean;
  isLoading: boolean;
  setCurrentOrganization: (org: Organization | null) => void;
  refreshOrganizations: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

export const useOrganization = () => {
  const context = useContext(OrganizationContext);
  if (context === undefined) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }
  return context;
};

interface OrganizationProviderProps {
  children: React.ReactNode;
}

export const OrganizationProvider: React.FC<OrganizationProviderProps> = ({ children }) => {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [userOrganizations, setUserOrganizations] = useState<OrganizationUser[]>([]);
  const [currentOrganization, setCurrentOrganizationState] = useState<Organization | null>(null);
  const [currentRole, setCurrentRole] = useState<AppRole | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const loadOrganizations = useCallback(async () => {
    try {
      setIsLoading(true);
      
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setOrganizations([]);
        setUserOrganizations([]);
        setCurrentOrganizationState(null);
        setCurrentRole(null);
        setIsSuperAdmin(false);
        return;
      }

      // Fetch user's organization memberships using raw query
      const { data: orgUsers, error: orgUsersError } = await supabase
        .from('organization_users' as any)
        .select('*')
        .eq('user_id', user.id);

      if (orgUsersError) {
        console.error('Error fetching organization users:', orgUsersError);
        setIsLoading(false);
        return;
      }

      const typedOrgUsers = (orgUsers || []) as unknown as OrganizationUser[];
      setUserOrganizations(typedOrgUsers);

      // Check if user is super_admin
      const hasSuperAdmin = typedOrgUsers.some(ou => ou.role === 'super_admin');
      setIsSuperAdmin(hasSuperAdmin);

      // Fetch organizations the user has access to
      const { data: orgs, error: orgsError } = await supabase
        .from('organizations' as any)
        .select('*')
        .order('name');

      if (orgsError) {
        console.error('Error fetching organizations:', orgsError);
        setIsLoading(false);
        return;
      }

      const typedOrgs = (orgs || []) as unknown as Organization[];
      setOrganizations(typedOrgs);

      // Set current organization from localStorage or first available
      const storedOrgId = localStorage.getItem('currentOrganizationId');
      let selectedOrg: Organization | null = null;

      if (storedOrgId) {
        selectedOrg = typedOrgs.find(o => o.id === storedOrgId) || null;
      }
      
      if (!selectedOrg && typedOrgs.length > 0) {
        selectedOrg = typedOrgs[0];
      }

      if (selectedOrg) {
        setCurrentOrganizationState(selectedOrg);
        localStorage.setItem('currentOrganizationId', selectedOrg.id);

        // Set current role for the selected org
        const userOrgRole = typedOrgUsers.find(ou => ou.organization_id === selectedOrg!.id);
        setCurrentRole(userOrgRole?.role || null);
      }
    } catch (error) {
      console.error('Error loading organizations:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setCurrentOrganization = useCallback((org: Organization | null) => {
    setCurrentOrganizationState(org);
    if (org) {
      localStorage.setItem('currentOrganizationId', org.id);
      const userOrgRole = userOrganizations.find(ou => ou.organization_id === org.id);
      setCurrentRole(userOrgRole?.role || null);
    } else {
      localStorage.removeItem('currentOrganizationId');
      setCurrentRole(null);
    }
  }, [userOrganizations]);

  const refreshOrganizations = useCallback(async () => {
    await loadOrganizations();
  }, [loadOrganizations]);

  useEffect(() => {
    loadOrganizations();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        loadOrganizations();
      } else if (event === 'SIGNED_OUT') {
        setOrganizations([]);
        setUserOrganizations([]);
        setCurrentOrganizationState(null);
        setCurrentRole(null);
        setIsSuperAdmin(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [loadOrganizations]);

  const isOrgAdmin = currentRole === 'org_admin' || isSuperAdmin;

  return (
    <OrganizationContext.Provider
      value={{
        organizations,
        currentOrganization,
        currentRole,
        userOrganizations,
        isSuperAdmin,
        isOrgAdmin,
        isLoading,
        setCurrentOrganization,
        refreshOrganizations,
      }}
    >
      {children}
    </OrganizationContext.Provider>
  );
};
