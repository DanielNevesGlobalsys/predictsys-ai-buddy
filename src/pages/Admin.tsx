import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Building2, Users, FolderKanban, MoreVertical, Pencil, Trash2, Search, BarChart3 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/contexts/OrganizationContext';
import Header from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Organization, OrgPlan, PLAN_LABELS } from '@/types/organization';

interface OrgStats {
  org_id: string;
  users_count: number;
  projects_count: number;
}

const Admin = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isSuperAdmin, refreshOrganizations } = useOrganization();

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [orgStats, setOrgStats] = useState<Record<string, OrgStats>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modal states
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    document: '',
    plan: 'trial' as OrgPlan,
    max_projects: 10,
    max_rows: 1000000,
    max_storage_mb: 5000,
  });

  const lang = i18n.language as 'pt' | 'en' | 'es';

  useEffect(() => {
    if (!isSuperAdmin) {
      navigate('/dashboard');
      return;
    }
    loadOrganizations();
  }, [isSuperAdmin, navigate]);

  const loadOrganizations = async () => {
    try {
      setIsLoading(true);

      const { data: orgs, error } = await supabase
        .from('organizations' as any)
        .select('*')
        .order('name');

      if (error) throw error;

      const typedOrgs = (orgs || []) as unknown as Organization[];
      setOrganizations(typedOrgs);

      // Load stats for each org
      const stats: Record<string, OrgStats> = {};
      for (const org of typedOrgs) {
        // Use separate promise-based queries to avoid type depth issues
        const usersPromise = (supabase as any)
          .from('organization_users')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', org.id);
        
        const projectsPromise = supabase
          .from('projects')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', org.id);

        const [usersRes, projectsRes] = await Promise.all([usersPromise, projectsPromise]);

        stats[org.id] = {
          org_id: org.id,
          users_count: usersRes.count || 0,
          projects_count: projectsRes.count || 0,
        };
      }
      setOrgStats(stats);
    } catch (error) {
      console.error('Error loading organizations:', error);
      toast({
        title: t('common.error'),
        description: t('admin.loadError'),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateOrg = async () => {
    if (!formData.name || !formData.slug) {
      toast({
        title: t('common.error'),
        description: t('admin.requiredFields'),
        variant: 'destructive',
      });
      return;
    }

    try {
      setIsSaving(true);

      const { error } = await supabase.from('organizations' as any).insert({
        name: formData.name,
        slug: formData.slug.toLowerCase().replace(/\s+/g, '-'),
        document: formData.document || null,
        plan: formData.plan,
        max_projects: formData.max_projects,
        max_rows: formData.max_rows,
        max_storage_mb: formData.max_storage_mb,
      } as any);

      if (error) throw error;

      toast({
        title: t('common.success'),
        description: t('admin.orgCreated'),
      });

      setIsCreateModalOpen(false);
      resetForm();
      loadOrganizations();
      refreshOrganizations();
    } catch (error: any) {
      console.error('Error creating organization:', error);
      toast({
        title: t('common.error'),
        description: error.message || t('admin.createError'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditOrg = async () => {
    if (!selectedOrg || !formData.name || !formData.slug) {
      toast({
        title: t('common.error'),
        description: t('admin.requiredFields'),
        variant: 'destructive',
      });
      return;
    }

    try {
      setIsSaving(true);

      const { error } = await supabase
        .from('organizations' as any)
        .update({
          name: formData.name,
          slug: formData.slug.toLowerCase().replace(/\s+/g, '-'),
          document: formData.document || null,
          plan: formData.plan,
          max_projects: formData.max_projects,
          max_rows: formData.max_rows,
          max_storage_mb: formData.max_storage_mb,
        } as any)
        .eq('id', selectedOrg.id);

      if (error) throw error;

      toast({
        title: t('common.success'),
        description: t('admin.orgUpdated'),
      });

      setIsEditModalOpen(false);
      setSelectedOrg(null);
      resetForm();
      loadOrganizations();
      refreshOrganizations();
    } catch (error: any) {
      console.error('Error updating organization:', error);
      toast({
        title: t('common.error'),
        description: error.message || t('admin.updateError'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteOrg = async () => {
    if (!selectedOrg) return;

    try {
      setIsSaving(true);

      const { error } = await supabase
        .from('organizations' as any)
        .delete()
        .eq('id', selectedOrg.id);

      if (error) throw error;

      toast({
        title: t('common.success'),
        description: t('admin.orgDeleted'),
      });

      setIsDeleteModalOpen(false);
      setSelectedOrg(null);
      loadOrganizations();
      refreshOrganizations();
    } catch (error: any) {
      console.error('Error deleting organization:', error);
      toast({
        title: t('common.error'),
        description: error.message || t('admin.deleteError'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      slug: '',
      document: '',
      plan: 'trial',
      max_projects: 10,
      max_rows: 1000000,
      max_storage_mb: 5000,
    });
  };

  const openEditModal = (org: Organization) => {
    setSelectedOrg(org);
    setFormData({
      name: org.name,
      slug: org.slug,
      document: org.document || '',
      plan: org.plan,
      max_projects: org.max_projects || 10,
      max_rows: Number(org.max_rows) || 1000000,
      max_storage_mb: org.max_storage_mb || 5000,
    });
    setIsEditModalOpen(true);
  };

  const openDeleteModal = (org: Organization) => {
    setSelectedOrg(org);
    setIsDeleteModalOpen(true);
  };

  const filteredOrganizations = organizations.filter(
    (org) =>
      org.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      org.slug.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getPlanBadgeVariant = (plan: OrgPlan) => {
    switch (plan) {
      case 'enterprise':
        return 'default';
      case 'standard':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  if (!isSuperAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <Header title={t('admin.title')} subtitle={t('admin.subtitle')} />

      <main className="container mx-auto px-4 py-8">
        {/* Analytics Link */}
        <div className="mb-6">
          <Link to="/admin/analytics">
            <Button variant="outline" className="gap-2">
              <BarChart3 className="w-4 h-4" />
              {t('admin.analytics')}
            </Button>
          </Link>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('admin.totalOrganizations')}
              </CardTitle>
              <Building2 className="w-5 h-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{organizations.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('admin.totalUsers')}
              </CardTitle>
              <Users className="w-5 h-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {Object.values(orgStats).reduce((sum, s) => sum + s.users_count, 0)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('admin.totalProjects')}
              </CardTitle>
              <FolderKanban className="w-5 h-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {Object.values(orgStats).reduce((sum, s) => sum + s.projects_count, 0)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Organizations Table */}
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <CardTitle>{t('admin.organizations')}</CardTitle>
              <div className="flex items-center gap-3">
                <div className="relative flex-1 sm:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder={t('admin.searchOrgs')}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Button onClick={() => setIsCreateModalOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  {t('admin.newOrg')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.orgName')}</TableHead>
                    <TableHead>{t('admin.slug')}</TableHead>
                    <TableHead>{t('admin.plan')}</TableHead>
                    <TableHead className="text-center">{t('admin.users')}</TableHead>
                    <TableHead className="text-center">{t('admin.projects')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOrganizations.map((org) => (
                    <TableRow key={org.id}>
                      <TableCell className="font-medium">{org.name}</TableCell>
                      <TableCell className="text-muted-foreground">{org.slug}</TableCell>
                      <TableCell>
                        <Badge variant={getPlanBadgeVariant(org.plan)}>
                          {PLAN_LABELS[org.plan][lang]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        {orgStats[org.id]?.users_count || 0}
                      </TableCell>
                      <TableCell className="text-center">
                        {orgStats[org.id]?.projects_count || 0}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEditModal(org)}>
                              <Pencil className="w-4 h-4 mr-2" />
                              {t('common.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => navigate(`/admin/org/${org.id}/users`)}
                            >
                              <Users className="w-4 h-4 mr-2" />
                              {t('admin.manageUsers')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => openDeleteModal(org)}
                              className="text-destructive"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredOrganizations.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        {t('admin.noOrgsFound')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Create Organization Modal */}
      <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('admin.newOrg')}</DialogTitle>
            <DialogDescription>{t('admin.newOrgDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">{t('admin.orgName')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin.orgNamePlaceholder')}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="slug">{t('admin.slug')} *</Label>
              <Input
                id="slug"
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                placeholder={t('admin.slugPlaceholder')}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="document">{t('admin.document')}</Label>
              <Input
                id="document"
                value={formData.document}
                onChange={(e) => setFormData({ ...formData, document: e.target.value })}
                placeholder={t('admin.documentPlaceholder')}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="plan">{t('admin.plan')}</Label>
              <Select
                value={formData.plan}
                onValueChange={(value: OrgPlan) => setFormData({ ...formData, plan: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">{PLAN_LABELS.trial[lang]}</SelectItem>
                  <SelectItem value="standard">{PLAN_LABELS.standard[lang]}</SelectItem>
                  <SelectItem value="enterprise">{PLAN_LABELS.enterprise[lang]}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="max_projects">{t('admin.maxProjects')}</Label>
                <Input
                  id="max_projects"
                  type="number"
                  value={formData.max_projects}
                  onChange={(e) =>
                    setFormData({ ...formData, max_projects: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="max_rows">{t('admin.maxRows')}</Label>
                <Input
                  id="max_rows"
                  type="number"
                  value={formData.max_rows}
                  onChange={(e) =>
                    setFormData({ ...formData, max_rows: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="max_storage">{t('admin.maxStorageMB')}</Label>
                <Input
                  id="max_storage"
                  type="number"
                  value={formData.max_storage_mb}
                  onChange={(e) =>
                    setFormData({ ...formData, max_storage_mb: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateOrg} disabled={isSaving}>
              {isSaving ? t('common.saving') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Organization Modal */}
      <Dialog open={isEditModalOpen} onOpenChange={setIsEditModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('admin.editOrg')}</DialogTitle>
            <DialogDescription>{t('admin.editOrgDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">{t('admin.orgName')} *</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-slug">{t('admin.slug')} *</Label>
              <Input
                id="edit-slug"
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-document">{t('admin.document')}</Label>
              <Input
                id="edit-document"
                value={formData.document}
                onChange={(e) => setFormData({ ...formData, document: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-plan">{t('admin.plan')}</Label>
              <Select
                value={formData.plan}
                onValueChange={(value: OrgPlan) => setFormData({ ...formData, plan: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">{PLAN_LABELS.trial[lang]}</SelectItem>
                  <SelectItem value="standard">{PLAN_LABELS.standard[lang]}</SelectItem>
                  <SelectItem value="enterprise">{PLAN_LABELS.enterprise[lang]}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-max_projects">{t('admin.maxProjects')}</Label>
                <Input
                  id="edit-max_projects"
                  type="number"
                  value={formData.max_projects}
                  onChange={(e) =>
                    setFormData({ ...formData, max_projects: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-max_rows">{t('admin.maxRows')}</Label>
                <Input
                  id="edit-max_rows"
                  type="number"
                  value={formData.max_rows}
                  onChange={(e) =>
                    setFormData({ ...formData, max_rows: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-max_storage">{t('admin.maxStorageMB')}</Label>
                <Input
                  id="edit-max_storage"
                  type="number"
                  value={formData.max_storage_mb}
                  onChange={(e) =>
                    setFormData({ ...formData, max_storage_mb: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleEditOrg} disabled={isSaving}>
              {isSaving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={isDeleteModalOpen} onOpenChange={setIsDeleteModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.deleteOrg')}</DialogTitle>
            <DialogDescription>
              {t('admin.deleteOrgConfirm', { name: selectedOrg?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDeleteOrg} disabled={isSaving}>
              {isSaving ? t('common.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Admin;
