import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { 
  ArrowLeft, Plus, Users, MoreVertical, Pencil, Trash2, UserPlus, 
  CheckCircle, Ban, ArrowRightLeft, Search, Shield, AlertCircle 
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/contexts/OrganizationContext';
import Header from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  DropdownMenuSeparator,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  Organization, 
  AppRole, 
  UserStatus,
  ROLE_LABELS, 
  STATUS_LABELS,
  SANDBOX_ORG_ID 
} from '@/types/organization';

interface UserWithProfile {
  id: string;
  user_id: string;
  role: AppRole;
  status: UserStatus;
  created_at: string;
  profile: { full_name: string } | null;
  email: string;
}

const AdminOrgUsers = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { orgId } = useParams<{ orgId: string }>();
  const { toast } = useToast();
  const { isSuperAdmin, isOrgAdmin, currentOrganization, organizations } = useOrganization();

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [users, setUsers] = useState<UserWithProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modal states
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [isEditRoleModalOpen, setIsEditRoleModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isMoveOrgModalOpen, setIsMoveOrgModalOpen] = useState(false);
  const [isStatusModalOpen, setIsStatusModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserWithProfile | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<'approve' | 'block'>('approve');

  // Form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AppRole>('analyst');
  const [editRole, setEditRole] = useState<AppRole>('analyst');
  const [targetOrgIdForMove, setTargetOrgIdForMove] = useState<string>('');

  const lang = i18n.language as 'pt' | 'en' | 'es';

  // Determine which org to manage - from URL or current org
  const targetOrgId = orgId || currentOrganization?.id;
  const isSandbox = targetOrgId === SANDBOX_ORG_ID;

  useEffect(() => {
    if (!isSuperAdmin && !isOrgAdmin) {
      navigate('/dashboard');
      return;
    }
    if (targetOrgId) {
      loadOrganizationAndUsers();
    }
  }, [isSuperAdmin, isOrgAdmin, targetOrgId, navigate]);

  const loadOrganizationAndUsers = async () => {
    if (!targetOrgId) return;

    try {
      setIsLoading(true);

      // Load organization
      const { data: org, error: orgError } = await supabase
        .from('organizations' as any)
        .select('*')
        .eq('id', targetOrgId)
        .single();

      if (orgError) throw orgError;
      setOrganization(org as unknown as Organization);

      // Load users with profiles
      const { data: orgUsers, error: usersError } = await supabase
        .from('organization_users' as any)
        .select('*')
        .eq('organization_id', targetOrgId);

      if (usersError) throw usersError;

      // Fetch profiles for each user
      const usersWithProfiles: UserWithProfile[] = [];
      for (const orgUser of (orgUsers || []) as any[]) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', orgUser.user_id)
          .single();

        usersWithProfiles.push({
          id: orgUser.id,
          user_id: orgUser.user_id,
          role: orgUser.role as AppRole,
          status: (orgUser.status || 'active') as UserStatus,
          created_at: orgUser.created_at,
          profile: profile,
          email: profile?.full_name || 'Usuário',
        });
      }

      setUsers(usersWithProfiles);
    } catch (error) {
      console.error('Error loading organization users:', error);
      toast({
        title: t('common.error'),
        description: t('admin.loadUsersError'),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleInviteUser = async () => {
    if (!inviteEmail || !targetOrgId) {
      toast({
        title: t('common.error'),
        description: t('admin.emailRequired'),
        variant: 'destructive',
      });
      return;
    }

    try {
      setIsSaving(true);

      // For now, we'll look up the user by email in profiles
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('full_name', inviteEmail)
        .single();

      if (!existingUser) {
        toast({
          title: t('common.error'),
          description: t('admin.userNotFound'),
          variant: 'destructive',
        });
        return;
      }

      // Check if already a member
      const existingMemberRes = await (supabase as any)
        .from('organization_users')
        .select('id')
        .eq('organization_id', targetOrgId)
        .eq('user_id', existingUser.id)
        .single();

      if (existingMemberRes.data) {
        toast({
          title: t('common.error'),
          description: t('admin.userAlreadyMember'),
          variant: 'destructive',
        });
        return;
      }

      const { error } = await (supabase as any).from('organization_users').insert({
        organization_id: targetOrgId,
        user_id: existingUser.id,
        role: inviteRole,
        status: 'active',
      });

      if (error) throw error;

      toast({
        title: t('common.success'),
        description: t('admin.userAdded'),
      });

      setIsInviteModalOpen(false);
      setInviteEmail('');
      setInviteRole('analyst');
      loadOrganizationAndUsers();
    } catch (error: any) {
      console.error('Error inviting user:', error);
      toast({
        title: t('common.error'),
        description: error.message || t('admin.inviteError'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateRole = async () => {
    if (!selectedUser) return;

    try {
      setIsSaving(true);

      const { error } = await supabase
        .from('organization_users' as any)
        .update({ role: editRole } as any)
        .eq('id', selectedUser.id);

      if (error) throw error;

      toast({
        title: t('common.success'),
        description: t('admin.roleUpdated'),
      });

      setIsEditRoleModalOpen(false);
      setSelectedUser(null);
      loadOrganizationAndUsers();
    } catch (error: any) {
      console.error('Error updating role:', error);
      toast({
        title: t('common.error'),
        description: error.message || t('admin.updateRoleError'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateStatus = async () => {
    if (!selectedUser) return;

    try {
      setIsSaving(true);

      const newStatus = statusAction === 'approve' ? 'active' : 'blocked';

      const { error } = await supabase
        .from('organization_users' as any)
        .update({ status: newStatus } as any)
        .eq('id', selectedUser.id);

      if (error) throw error;

      toast({
        title: t('common.success'),
        description: statusAction === 'approve' 
          ? t('admin.userApproved') 
          : t('admin.userBlocked'),
      });

      setIsStatusModalOpen(false);
      setSelectedUser(null);
      loadOrganizationAndUsers();
    } catch (error: any) {
      console.error('Error updating status:', error);
      toast({
        title: t('common.error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleMoveToOrg = async () => {
    if (!selectedUser || !targetOrgIdForMove) return;

    try {
      setIsSaving(true);

      // Delete from current org
      const { error: deleteError } = await supabase
        .from('organization_users' as any)
        .delete()
        .eq('id', selectedUser.id);

      if (deleteError) throw deleteError;

      // Add to new org with active status
      const { error: insertError } = await (supabase as any)
        .from('organization_users')
        .insert({
          organization_id: targetOrgIdForMove,
          user_id: selectedUser.user_id,
          role: selectedUser.role,
          status: 'active',
        });

      if (insertError) throw insertError;

      toast({
        title: t('common.success'),
        description: t('admin.userMoved'),
      });

      setIsMoveOrgModalOpen(false);
      setSelectedUser(null);
      setTargetOrgIdForMove('');
      loadOrganizationAndUsers();
    } catch (error: any) {
      console.error('Error moving user:', error);
      toast({
        title: t('common.error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveUser = async () => {
    if (!selectedUser) return;

    try {
      setIsSaving(true);

      const { error } = await supabase
        .from('organization_users' as any)
        .delete()
        .eq('id', selectedUser.id);

      if (error) throw error;

      toast({
        title: t('common.success'),
        description: t('admin.userRemoved'),
      });

      setIsDeleteModalOpen(false);
      setSelectedUser(null);
      loadOrganizationAndUsers();
    } catch (error: any) {
      console.error('Error removing user:', error);
      toast({
        title: t('common.error'),
        description: error.message || t('admin.removeUserError'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const openEditRoleModal = (user: UserWithProfile) => {
    setSelectedUser(user);
    setEditRole(user.role);
    setIsEditRoleModalOpen(true);
  };

  const openDeleteModal = (user: UserWithProfile) => {
    setSelectedUser(user);
    setIsDeleteModalOpen(true);
  };

  const openMoveOrgModal = (user: UserWithProfile) => {
    setSelectedUser(user);
    setTargetOrgIdForMove('');
    setIsMoveOrgModalOpen(true);
  };

  const openStatusModal = (user: UserWithProfile, action: 'approve' | 'block') => {
    setSelectedUser(user);
    setStatusAction(action);
    setIsStatusModalOpen(true);
  };

  const getRoleBadgeVariant = (role: AppRole) => {
    switch (role) {
      case 'super_admin':
        return 'destructive';
      case 'org_admin':
        return 'default';
      case 'analyst':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const getStatusBadgeVariant = (status: UserStatus) => {
    switch (status) {
      case 'active':
        return 'default';
      case 'pending':
        return 'secondary';
      case 'blocked':
        return 'destructive';
      default:
        return 'outline';
    }
  };

  const filteredUsers = users.filter(
    (user) =>
      user.profile?.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const pendingCount = users.filter(u => u.status === 'pending').length;

  if (!isSuperAdmin && !isOrgAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <Header 
        title={organization?.name || t('admin.manageUsers')} 
        subtitle={t('admin.usersManagement')}
        showBackButton
        backTo={isSuperAdmin ? '/admin' : '/org/settings'}
        backIcon={<ArrowLeft className="w-4 h-4" />}
      />

      <main className="container mx-auto px-4 py-8 space-y-6">
        {/* Sandbox Alert */}
        {isSandbox && (
          <Alert>
            <Shield className="h-4 w-4" />
            <AlertTitle>{t('admin.sandboxOrg')}</AlertTitle>
            <AlertDescription>
              {t('admin.sandboxDescription')}
            </AlertDescription>
          </Alert>
        )}

        {/* Pending Users Alert */}
        {pendingCount > 0 && (
          <Alert variant="default" className="border-amber-500 bg-amber-50 dark:bg-amber-950/20">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <AlertTitle className="text-amber-800 dark:text-amber-400">
              {t('admin.pendingUsersAlert', { count: pendingCount })}
            </AlertTitle>
            <AlertDescription className="text-amber-700 dark:text-amber-300">
              {t('admin.pendingUsersDescription')}
            </AlertDescription>
          </Alert>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('admin.totalUsers')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{users.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('admin.activeUsers')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {users.filter(u => u.status === 'active').length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('admin.pendingUsers')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600">
                {users.filter(u => u.status === 'pending').length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t('admin.blockedUsers')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">
                {users.filter(u => u.status === 'blocked').length}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Users Table */}
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  {t('admin.organizationUsers')}
                </CardTitle>
                <CardDescription>
                  {t('admin.usersDescription', { count: users.length })}
                </CardDescription>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative flex-1 sm:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder={t('admin.searchUsers')}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Button onClick={() => setIsInviteModalOpen(true)}>
                  <UserPlus className="w-4 h-4 mr-2" />
                  {t('admin.addUser')}
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
                    <TableHead>{t('admin.userName')}</TableHead>
                    <TableHead>{t('admin.role')}</TableHead>
                    <TableHead>{t('admin.status')}</TableHead>
                    <TableHead>{t('admin.addedAt')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">
                        {user.profile?.full_name || 'Usuário'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getRoleBadgeVariant(user.role)}>
                          {ROLE_LABELS[user.role][lang]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusBadgeVariant(user.status)}>
                          {STATUS_LABELS[user.status][lang]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(user.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {user.status === 'pending' && (
                              <DropdownMenuItem onClick={() => openStatusModal(user, 'approve')}>
                                <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                                {t('admin.approveUser')}
                              </DropdownMenuItem>
                            )}
                            {user.status === 'active' && (
                              <DropdownMenuItem onClick={() => openStatusModal(user, 'block')}>
                                <Ban className="w-4 h-4 mr-2 text-amber-600" />
                                {t('admin.blockUser')}
                              </DropdownMenuItem>
                            )}
                            {user.status === 'blocked' && (
                              <DropdownMenuItem onClick={() => openStatusModal(user, 'approve')}>
                                <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                                {t('admin.unblockUser')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => openEditRoleModal(user)}>
                              <Pencil className="w-4 h-4 mr-2" />
                              {t('admin.changeRole')}
                            </DropdownMenuItem>
                            {isSuperAdmin && (
                              <DropdownMenuItem onClick={() => openMoveOrgModal(user)}>
                                <ArrowRightLeft className="w-4 h-4 mr-2" />
                                {t('admin.moveToOrg')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => openDeleteModal(user)}
                              className="text-destructive"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              {t('admin.removeUser')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredUsers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                        {t('admin.noUsersFound')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Invite User Modal */}
      <Dialog open={isInviteModalOpen} onOpenChange={setIsInviteModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.addUser')}</DialogTitle>
            <DialogDescription>{t('admin.addUserDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="email">{t('admin.userNameOrEmail')}</Label>
              <Input
                id="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={t('admin.userNamePlaceholder')}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="role">{t('admin.role')}</Label>
              <Select
                value={inviteRole}
                onValueChange={(value: AppRole) => setInviteRole(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org_admin">{ROLE_LABELS.org_admin[lang]}</SelectItem>
                  <SelectItem value="analyst">{ROLE_LABELS.analyst[lang]}</SelectItem>
                  <SelectItem value="viewer">{ROLE_LABELS.viewer[lang]}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsInviteModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleInviteUser} disabled={isSaving}>
              {isSaving ? t('common.saving') : t('admin.addUser')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Role Modal */}
      <Dialog open={isEditRoleModalOpen} onOpenChange={setIsEditRoleModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.changeRole')}</DialogTitle>
            <DialogDescription>
              {t('admin.changeRoleDescription', { name: selectedUser?.profile?.full_name })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-role">{t('admin.newRole')}</Label>
              <Select
                value={editRole}
                onValueChange={(value: AppRole) => setEditRole(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isSuperAdmin && (
                    <SelectItem value="super_admin">{ROLE_LABELS.super_admin[lang]}</SelectItem>
                  )}
                  <SelectItem value="org_admin">{ROLE_LABELS.org_admin[lang]}</SelectItem>
                  <SelectItem value="analyst">{ROLE_LABELS.analyst[lang]}</SelectItem>
                  <SelectItem value="viewer">{ROLE_LABELS.viewer[lang]}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditRoleModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleUpdateRole} disabled={isSaving}>
              {isSaving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move to Organization Modal */}
      <Dialog open={isMoveOrgModalOpen} onOpenChange={setIsMoveOrgModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.moveToOrg')}</DialogTitle>
            <DialogDescription>
              {t('admin.moveToOrgDescription', { name: selectedUser?.profile?.full_name })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>{t('admin.selectOrg')}</Label>
              <Select
                value={targetOrgIdForMove}
                onValueChange={setTargetOrgIdForMove}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('admin.selectOrgPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {organizations
                    .filter(org => org.id !== targetOrgId)
                    .map(org => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsMoveOrgModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleMoveToOrg} disabled={isSaving || !targetOrgIdForMove}>
              {isSaving ? t('common.saving') : t('admin.moveUser')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status Change Confirmation Modal */}
      <AlertDialog open={isStatusModalOpen} onOpenChange={setIsStatusModalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {statusAction === 'approve' ? t('admin.approveUser') : t('admin.blockUser')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {statusAction === 'approve' 
                ? t('admin.approveUserConfirm', { name: selectedUser?.profile?.full_name })
                : t('admin.blockUserConfirm', { name: selectedUser?.profile?.full_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUpdateStatus}
              className={statusAction === 'block' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
            >
              {isSaving ? t('common.saving') : (statusAction === 'approve' ? t('admin.approve') : t('admin.block'))}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove User Confirmation Modal */}
      <AlertDialog open={isDeleteModalOpen} onOpenChange={setIsDeleteModalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.removeUser')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.removeUserConfirm', { name: selectedUser?.profile?.full_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveUser}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving ? t('common.saving') : t('admin.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminOrgUsers;
