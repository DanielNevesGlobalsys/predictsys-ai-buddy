import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Building2, LogOut, ChevronRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import AppShell from '@/components/app/AppShell';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

const AppSettings = () => {
  const navigate = useNavigate();
  const { currentOrganization } = useOrganization();
  const [user, setUser] = useState<{ email?: string; full_name?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUser = async () => {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (authUser) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', authUser.id)
          .single();
        
        setUser({
          email: authUser.email,
          full_name: profile?.full_name || 'Usuário'
        });
      }
      setLoading(false);
    };
    
    fetchUser();
  }, []);

  const handleLogout = async () => {
    // Clear any local state
    localStorage.removeItem('currentOrganizationId');
    
    // Sign out from Supabase
    await supabase.auth.signOut();
    
    // Navigate to app splash (will then redirect to app login)
    navigate('/app', { replace: true });
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  if (loading) {
    return (
      <AppShell title="Configurações" showBackButton>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Configurações" showBackButton>
      <div className="p-4 space-y-6">
        {/* User Profile Section */}
        <Card className="bg-card border-border">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                <AvatarFallback className="bg-primary text-primary-foreground text-lg">
                  {getInitials(user?.full_name || 'U')}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground">
                  {user?.full_name}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {user?.email}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Organization Section */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground px-1">
            ORGANIZAÇÃO
          </h3>
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="font-medium text-foreground">
                    {currentOrganization?.name || 'Nenhuma organização'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Organização atual
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Quick Links */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground px-1">
            AJUDA
          </h3>
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <button
                onClick={() => navigate('/app/docs')}
                className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
              >
                <span className="text-foreground">Documentação</span>
                <ChevronRight className="h-5 w-5 text-muted-foreground" />
              </button>
              <Separator />
              <button
                onClick={() => navigate('/app/guia-rapido')}
                className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
              >
                <span className="text-foreground">Guia Rápido</span>
                <ChevronRight className="h-5 w-5 text-muted-foreground" />
              </button>
            </CardContent>
          </Card>
        </div>

        {/* Logout */}
        <Button
          variant="destructive"
          className="w-full mt-8"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sair da conta
        </Button>

        {/* App Version */}
        <p className="text-center text-xs text-muted-foreground pt-4">
          PredictSys AI v2.0 • App Executivo
        </p>
      </div>
    </AppShell>
  );
};

export default AppSettings;
