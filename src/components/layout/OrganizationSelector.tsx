import { useTranslation } from 'react-i18next';
import { Building2, Check, ChevronDown, Settings, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useNavigate } from 'react-router-dom';

const OrganizationSelector = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    organizations,
    currentOrganization,
    setCurrentOrganization,
    isSuperAdmin,
    isOrgAdmin,
    isLoading,
  } = useOrganization();

  if (isLoading) {
    return (
      <div className="h-9 w-32 bg-muted animate-pulse rounded-md" />
    );
  }

  if (!currentOrganization && organizations.length === 0) {
    return null;
  }

  // If only one org and not super admin, just show the name
  if (organizations.length === 1 && !isSuperAdmin) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 rounded-md">
        <Building2 className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">{currentOrganization?.name}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Building2 className="w-4 h-4" />
          <span className="max-w-[150px] truncate">
            {currentOrganization?.name || t('organization.select')}
          </span>
          <ChevronDown className="w-4 h-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {organizations.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => setCurrentOrganization(org)}
            className="flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Building2 className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{org.name}</span>
            </div>
            {org.id === currentOrganization?.id && (
              <Check className="w-4 h-4 text-primary flex-shrink-0" />
            )}
          </DropdownMenuItem>
        ))}

        {(isSuperAdmin || isOrgAdmin) && (
          <>
            <DropdownMenuSeparator />
            {isOrgAdmin && currentOrganization && (
              <DropdownMenuItem onClick={() => navigate('/org/settings')}>
                <Settings className="w-4 h-4 mr-2" />
                {t('organization.settings')}
              </DropdownMenuItem>
            )}
            {isSuperAdmin && (
              <DropdownMenuItem onClick={() => navigate('/admin')}>
                <Shield className="w-4 h-4 mr-2" />
                <span className="flex-1">{t('organization.adminPanel')}</span>
                <Badge variant="secondary" className="ml-2 text-xs">
                  Admin
                </Badge>
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default OrganizationSelector;
