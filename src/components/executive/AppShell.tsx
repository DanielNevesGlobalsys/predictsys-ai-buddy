import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Home, FolderKanban, TrendingUp, User } from 'lucide-react';
import { useOrganization } from '@/contexts/OrganizationContext';
import logoBox from '@/assets/logo-box.svg';

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
  const { currentOrganization } = useOrganization();

  const navItems: NavItem[] = [
    { path: '/executivo', label: 'Resumo', icon: <Home className="w-5 h-5" /> },
    { path: '/executivo/projetos', label: 'Projetos', icon: <FolderKanban className="w-5 h-5" /> },
    { path: '/executivo/impacto', label: 'Impacto', icon: <TrendingUp className="w-5 h-5" /> },
  ];

  const isActive = (path: string) => {
    if (path === '/executivo') {
      return location.pathname === '/executivo';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur border-b safe-area-top">
        <div className="flex items-center justify-between px-4 h-14">
          {/* Left: Back button or Logo */}
          <div className="flex items-center gap-3">
            {showBackButton ? (
              <button
                onClick={() => navigate(-1)}
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
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

          {/* Right: Profile icon */}
          <button
            onClick={() => navigate('/dashboard')}
            className="w-9 h-9 rounded-full bg-muted flex items-center justify-center hover:bg-muted/80 transition-colors"
          >
            <User className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-auto pb-20">
        {children}
      </main>

      {/* Bottom Navigation */}
      {!hideBottomNav && (
        <nav className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur border-t safe-area-bottom z-50">
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
