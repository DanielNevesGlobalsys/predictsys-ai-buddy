import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Building2, Users, FolderKanban, Database, Settings } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/contexts/OrganizationContext';
import Header from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PLAN_LABELS } from '@/types/organization';

interface OrgStats {
  users_count: number;
  projects_count: number;
  total_rows: number;
  connections_count: number;
}

const OrgSettings = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentOrganization, isOrgAdmin, isSuperAdmin } = useOrganization();

  const [stats, setStats] = useState<OrgStats>({
    users_count: 0,
    projects_count: 0,
    total_rows: 0,
    connections_count: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const lang = i18n.language as 'pt' | 'en' | 'es';

  useEffect(() => {
    if (!isOrgAdmin && !isSuperAdmin) {
      navigate('/dashboard');
      return;
    }
    if (currentOrganization) {
      loadStats();
    }
  }, [currentOrganization, isOrgAdmin, isSuperAdmin, navigate]);

  const loadStats = async () => {
    if (!currentOrganization) return;

    try {
      setIsLoading(true);

      // Use separate queries to avoid type depth issues
      const usersQuery = supabase.from('organization_users' as any).select('id', { count: 'exact', head: true }).eq('organization_id', currentOrganization.id);
      const projectsQuery = supabase.from('projects').select('id, total_rows', { count: 'exact' }).eq('organization_id', currentOrganization.id);
      const connectionsQuery = supabase.from('data_sources').select('id', { count: 'exact', head: true }).eq('organization_id', currentOrganization.id);

      const [usersRes, projectsRes, connectionsRes] = await Promise.all([
        usersQuery,
        projectsQuery,
        connectionsQuery,
      ]);

      const totalRows = (projectsRes.data || []).reduce(
        (sum: number, p: any) => sum + (p.total_rows || 0),
        0
      );

      setStats({
        users_count: usersRes.count || 0,
        projects_count: projectsRes.count || 0,
        total_rows: totalRows,
        connections_count: connectionsRes.count || 0,
      });
    } catch (error) {
      console.error('Error loading org stats:', error);
      toast({
        title: t('common.error'),
        description: t('organization.loadStatsError'),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getUsagePercentage = (current: number, max: number | null) => {
    if (!max || max === 0) return 0;
    return Math.min(100, (current / max) * 100);
  };

  if (!currentOrganization) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header
        title={currentOrganization.name}
        subtitle={t('organization.settingsSubtitle')}
        showBackButton
        backTo="/dashboard"
        backIcon={<ArrowLeft className="w-4 h-4" />}
      />

      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList>
            <TabsTrigger value="overview" className="gap-2">
              <Building2 className="w-4 h-4" />
              {t('organization.overview')}
            </TabsTrigger>
            <TabsTrigger value="users" className="gap-2">
              <Users className="w-4 h-4" />
              {t('organization.users')}
            </TabsTrigger>
            <TabsTrigger value="integrations" className="gap-2">
              <Database className="w-4 h-4" />
              {t('organization.integrations')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {/* Organization Info */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="w-5 h-5" />
                  {t('organization.info')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">{t('admin.orgName')}</p>
                    <p className="font-medium">{currentOrganization.name}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('admin.slug')}</p>
                    <p className="font-medium">{currentOrganization.slug}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('admin.plan')}</p>
                    <Badge variant="secondary">
                      {PLAN_LABELS[currentOrganization.plan][lang]}
                    </Badge>
                  </div>
                  {currentOrganization.document && (
                    <div>
                      <p className="text-sm text-muted-foreground">{t('admin.document')}</p>
                      <p className="font-medium">{currentOrganization.document}</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Usage Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    {t('admin.users')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stats.users_count}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <FolderKanban className="w-4 h-4" />
                    {t('admin.projects')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {stats.projects_count}
                    {currentOrganization.max_projects && (
                      <span className="text-sm font-normal text-muted-foreground">
                        {' '}/ {currentOrganization.max_projects}
                      </span>
                    )}
                  </div>
                  {currentOrganization.max_projects && (
                    <Progress
                      value={getUsagePercentage(stats.projects_count, currentOrganization.max_projects)}
                      className="h-1 mt-2"
                    />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    {t('organization.totalRows')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {stats.total_rows.toLocaleString()}
                    {currentOrganization.max_rows && (
                      <span className="text-sm font-normal text-muted-foreground">
                        {' '}/ {Number(currentOrganization.max_rows).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {currentOrganization.max_rows && (
                    <Progress
                      value={getUsagePercentage(stats.total_rows, Number(currentOrganization.max_rows))}
                      className="h-1 mt-2"
                    />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Settings className="w-4 h-4" />
                    {t('organization.connections')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stats.connections_count}</div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="users">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>{t('organization.users')}</CardTitle>
                    <CardDescription>
                      {t('admin.usersDescription', { count: stats.users_count })}
                    </CardDescription>
                  </div>
                  <Button onClick={() => navigate(`/admin/org/${currentOrganization.id}/users`)}>
                    <Users className="w-4 h-4 mr-2" />
                    {t('admin.manageUsers')}
                  </Button>
                </div>
              </CardHeader>
            </Card>
          </TabsContent>

          <TabsContent value="integrations">
            <Card>
              <CardHeader>
                <CardTitle>{t('organization.integrations')}</CardTitle>
                <CardDescription>
                  {t('organization.integrationsDescription', { count: stats.connections_count })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">
                  {t('organization.integrationsHelp')}
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => navigate('/projeto/novo/wizard')}
                >
                  {t('organization.goToWizard')}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default OrgSettings;
