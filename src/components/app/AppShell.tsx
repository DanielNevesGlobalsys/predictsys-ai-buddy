import { ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Home, FolderKanban, TrendingUp, MessageCircle, ChevronLeft, Settings, FileText, BookOpen, LogOut } from 'lucide-react';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import logoBox from '@/assets/logo-box.svg';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const APP_THEME_KEY = 'predictsys_app_theme';
const ONBOARDING_KEY = 'predictsys_app_onboarding_seen';

interface AppShellProps {
  children: ReactNode;
  showBackButton?: boolean;
  title?: string;
  hideBottomNav?: boolean;
}

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
}

const AppShell = ({ children, showBackButton, title, hideBottomNav = false }: AppShellProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentOrganization, setCurrentOrganization } = useOrganization();
  const [userName, setUserName] = useState<string>('');

  // Apply saved theme on mount (reads from localStorage)
  useEffect(() => {
    const savedTheme = localStorage.getItem(APP_THEME_KEY) || 'dark';
    const root = document.documentElement;
    
    if (savedTheme === 'dark') {
      root.classList.remove('light');
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
    }
    
    // Update theme-color meta
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', savedTheme === 'dark' ? '#0f172a' : '#ffffff');
    }
  }, []);

  // Fetch user info for avatar
  useEffect(() => {
    const fetchUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', user.id)
          .single();
        
        if (profile?.full_name) {
          setUserName(profile.full_name);
        }
      }
    };
    fetchUser();
  }, []);

  const navItems: NavItem[] = [
    { path: '/app/home', label: 'Resumo', icon: <Home className="w-5 h-5" /> },
    { path: '/app/projetos', label: 'Projetos', icon: <FolderKanban className="w-5 h-5" /> },
    { path: '/app/impacto', label: 'Impacto', icon: <TrendingUp className="w-5 h-5" /> },
    { path: '/app/lys', label: 'Lys', icon: <MessageCircle className="w-5 h-5" /> },
  ];

  const isActive = (path: string) => {
    if (path === '/app/home') {
      return location.pathname === '/app/home' || location.pathname === '/app';
    }
    return location.pathname.startsWith(path);
  };

  const getInitials = (name: string) => {
    if (!name) return 'U';
    return name
      .split(' ')
      .map(n => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  const handleLogout = async () => {
    // Clear organization selection
    setCurrentOrganization(null);
    localStorage.removeItem('currentOrganizationId');
    
    // Clear onboarding seen flag so next login shows full flow
    localStorage.removeItem(ONBOARDING_KEY);
    
    // DO NOT clear theme preference - user's visual preference persists
    // localStorage.getItem(APP_THEME_KEY) stays
    
    // Sign out from Supabase
    await supabase.auth.signOut();
    
    // Navigate to app welcome (not /auth, not /)
    navigate('/app/bem-vindo', { replace: true });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur border-b border-border safe-area-top">
        <div className="flex items-center justify-between px-4 h-14">
          {/* Left: Back button or Logo */}
          <div className="flex items-center gap-3">
            {showBackButton ? (
              <button
                onClick={() => navigate(-1)}
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
            ) : (
              <img src={logoBox} alt="PredictSys" className="w-8 h-8" />
            )}
            
            {title ? (
              <h1 className="font-semibold text-foreground truncate max-w-[200px]">{title}</h1>
            ) : (
              <span className="text-sm font-medium text-muted-foreground truncate max-w-[150px]">
                {currentOrganization?.name || 'Selecione'}
              </span>
            )}
          </div>

          {/* Right: User Avatar Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="focus:outline-none">
                <Avatar className="h-9 w-9 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all">
                  <AvatarFallback className="bg-primary text-primary-foreground text-sm">
                    {getInitials(userName)}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => navigate('/app/settings')}>
                <Settings className="w-4 h-4 mr-2" />
                Configurações
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/app/docs')}>
                <FileText className="w-4 h-4 mr-2" />
                Documentação
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/app/guia-rapido')}>
                <BookOpen className="w-4 h-4 mr-2" />
                Guia Rápido
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                <LogOut className="w-4 h-4 mr-2" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-auto pb-20">
        {children}
      </main>

      {/* Bottom Navigation */}
      {!hideBottomNav && (
        <nav className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur border-t border-border safe-area-bottom z-50">
          <div className="flex items-center justify-around h-16 max-w-md mx-auto">
            {navItems.map((item) => {
              const active = isActive(item.path);
              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={`flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors active:scale-95 ${
                    active 
                      ? 'text-primary' 
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <div className={`p-1 rounded-lg transition-colors ${active ? 'bg-primary/10' : ''}`}>
                    {item.icon}
                  </div>
                  <span className="text-xs font-medium">{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      )}

      <style>{`
        .safe-area-top {
          padding-top: env(safe-area-inset-top, 0px);
        }
        .safe-area-bottom {
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }
      `}</style>
    </div>
  );
};

export default AppShell;
