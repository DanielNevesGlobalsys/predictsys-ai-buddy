import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu';
import { Loader2, Globe, Moon, Sun } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import logoBox from '@/assets/logo-box.svg';

const APP_THEME_KEY = 'predictsys_app_theme';
const APP_LOCALE_KEY = 'predictsys_app_locale';

/**
 * App-specific Login page (PWA mode)
 * Features: language switcher, theme toggle
 * Always redirects to /app/home after successful login
 * Theme choice persists and applies to entire app
 */
const AppLogin = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupName, setSignupName] = useState('');
  const [isDark, setIsDark] = useState(true);
  const [currentLocale, setCurrentLocale] = useState('pt');

  const emailSchema = z.string().email('E-mail inválido').max(255);
  const passwordSchema = z.string().min(6, 'Senha deve ter no mínimo 6 caracteres').max(100);

  // Initialize theme and locale from localStorage
  useEffect(() => {
    const savedTheme = localStorage.getItem(APP_THEME_KEY) || 'dark';
    const savedLocale = localStorage.getItem(APP_LOCALE_KEY) || 'pt';
    
    setIsDark(savedTheme === 'dark');
    setCurrentLocale(savedLocale);
    i18n.changeLanguage(savedLocale);
    
    // Apply theme to document
    const root = document.documentElement;
    if (savedTheme === 'dark') {
      root.classList.remove('light');
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
    }
    
    // Update meta theme-color
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', savedTheme === 'dark' ? '#0f172a' : '#ffffff');
    }
  }, [i18n]);

  useEffect(() => {
    // If already logged in, go to app home
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/app/home', { replace: true });
      }
    });
  }, [navigate]);

  const toggleTheme = () => {
    const newTheme = isDark ? 'light' : 'dark';
    setIsDark(!isDark);
    localStorage.setItem(APP_THEME_KEY, newTheme);
    
    const root = document.documentElement;
    if (newTheme === 'dark') {
      root.classList.remove('light');
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
    }
    
    // Update meta theme-color
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', newTheme === 'dark' ? '#0f172a' : '#ffffff');
    }
  };

  const changeLocale = (locale: string) => {
    setCurrentLocale(locale);
    localStorage.setItem(APP_LOCALE_KEY, locale);
    i18n.changeLanguage(locale);
  };

  const getLocaleLabel = (locale: string) => {
    switch (locale) {
      case 'pt': return 'Português';
      case 'en': return 'English';
      case 'es': return 'Español';
      default: return 'Português';
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      emailSchema.parse(loginEmail);
      passwordSchema.parse(loginPassword);

      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail.trim(),
        password: loginPassword,
      });

      if (error) throw error;

      toast({
        title: 'Login realizado!',
        description: 'Bem-vindo de volta.',
      });
      
      // Always redirect to app home (not web routes)
      navigate('/app/home', { replace: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast({
          title: 'Erro de validação',
          description: error.errors[0].message,
          variant: 'destructive',
        });
      } else if (error instanceof Error) {
        toast({
          title: 'Erro no login',
          description: error.message,
          variant: 'destructive',
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      emailSchema.parse(signupEmail);
      passwordSchema.parse(signupPassword);

      if (!signupName.trim()) {
        throw new Error('Nome é obrigatório');
      }

      const { error } = await supabase.auth.signUp({
        email: signupEmail.trim(),
        password: signupPassword,
        options: {
          // Redirect to app home after email confirmation
          emailRedirectTo: `${window.location.origin}/app/home`,
          data: {
            full_name: signupName.trim(),
          },
        },
      });

      if (error) throw error;

      toast({
        title: 'Conta criada!',
        description: 'Verifique seu e-mail para confirmar.',
      });
      
      // Navigate to app home (user might need to confirm email first)
      navigate('/app/home', { replace: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast({
          title: 'Erro de validação',
          description: error.errors[0].message,
          variant: 'destructive',
        });
      } else if (error instanceof Error) {
        toast({
          title: 'Erro no cadastro',
          description: error.message,
          variant: 'destructive',
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div 
      className="min-h-screen flex flex-col items-center justify-center p-4"
      style={{
        background: isDark 
          ? 'linear-gradient(135deg, hsl(222 47% 11%) 0%, hsl(215 90% 25%) 50%, hsl(189 85% 30%) 100%)'
          : 'linear-gradient(135deg, hsl(210 40% 98%) 0%, hsl(210 40% 96%) 50%, hsl(210 40% 94%) 100%)',
      }}
    >
      {/* Theme and Language Toggles - Top Right */}
      <div className="fixed top-4 right-4 flex items-center gap-2 z-50">
        {/* Language Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              className={`${isDark ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'}`}
            >
              <Globe className="w-5 h-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={isDark ? 'bg-slate-800 border-slate-700' : ''}>
            <DropdownMenuItem 
              onClick={() => changeLocale('pt')}
              className={currentLocale === 'pt' ? 'bg-primary/20' : ''}
            >
              🇧🇷 Português
            </DropdownMenuItem>
            <DropdownMenuItem 
              onClick={() => changeLocale('en')}
              className={currentLocale === 'en' ? 'bg-primary/20' : ''}
            >
              🇺🇸 English
            </DropdownMenuItem>
            <DropdownMenuItem 
              onClick={() => changeLocale('es')}
              className={currentLocale === 'es' ? 'bg-primary/20' : ''}
            >
              🇪🇸 Español
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme Toggle */}
        <Button 
          variant="ghost" 
          size="icon" 
          onClick={toggleTheme}
          className={`${isDark ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'}`}
        >
          {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </Button>
      </div>

      <div className="w-full max-w-md space-y-8">
        {/* Logo */}
        <div className="text-center space-y-4">
          <img 
            src={logoBox} 
            alt="PredictSys AI" 
            className="w-24 h-24 mx-auto"
            style={{ filter: isDark ? 'drop-shadow(0 0 20px hsl(189 85% 52% / 0.4))' : 'none' }}
          />
          <h1 className={`text-3xl font-display font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
            PredictSys AI
          </h1>
          <p className={isDark ? 'text-white/70' : 'text-slate-600'}>
            IA para decisões de negócio
          </p>
        </div>

        {/* Auth Card */}
        <Card className={`${isDark ? 'bg-slate-900/80 backdrop-blur border-slate-700' : 'bg-white/90 backdrop-blur border-slate-200'} shadow-2xl p-6`}>
          <Tabs defaultValue="login" className="w-full">
            <TabsList className={`grid w-full grid-cols-2 mb-6 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
              <TabsTrigger value="login" className="data-[state=active]:bg-primary data-[state=active]:text-white">
                Entrar
              </TabsTrigger>
              <TabsTrigger value="signup" className="data-[state=active]:bg-primary data-[state=active]:text-white">
                Criar conta
              </TabsTrigger>
            </TabsList>

            {/* Login Form */}
            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="login-email" className={isDark ? 'text-slate-200' : 'text-slate-700'}>E-mail</Label>
                  <Input
                    id="login-email"
                    type="email"
                    placeholder="seu@email.com"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                    disabled={isLoading}
                    className={isDark 
                      ? 'bg-slate-800 border-slate-600 text-white placeholder:text-slate-400' 
                      : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-password" className={isDark ? 'text-slate-200' : 'text-slate-700'}>Senha</Label>
                  <Input
                    id="login-password"
                    type="password"
                    placeholder="••••••••"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                    disabled={isLoading}
                    className={isDark 
                      ? 'bg-slate-800 border-slate-600 text-white placeholder:text-slate-400' 
                      : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'
                    }
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-primary hover:bg-primary/90 text-white"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Entrando...
                    </>
                  ) : (
                    'Entrar'
                  )}
                </Button>
              </form>
            </TabsContent>

            {/* Signup Form */}
            <TabsContent value="signup">
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signup-name" className={isDark ? 'text-slate-200' : 'text-slate-700'}>Nome completo</Label>
                  <Input
                    id="signup-name"
                    type="text"
                    placeholder="Seu nome"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    required
                    disabled={isLoading}
                    className={isDark 
                      ? 'bg-slate-800 border-slate-600 text-white placeholder:text-slate-400' 
                      : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-email" className={isDark ? 'text-slate-200' : 'text-slate-700'}>E-mail</Label>
                  <Input
                    id="signup-email"
                    type="email"
                    placeholder="seu@email.com"
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    required
                    disabled={isLoading}
                    className={isDark 
                      ? 'bg-slate-800 border-slate-600 text-white placeholder:text-slate-400' 
                      : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password" className={isDark ? 'text-slate-200' : 'text-slate-700'}>Senha</Label>
                  <Input
                    id="signup-password"
                    type="password"
                    placeholder="Mínimo 6 caracteres"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    required
                    disabled={isLoading}
                    className={isDark 
                      ? 'bg-slate-800 border-slate-600 text-white placeholder:text-slate-400' 
                      : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'
                    }
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-primary hover:bg-primary/90 text-white"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Criando conta...
                    </>
                  ) : (
                    'Criar conta'
                  )}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </Card>

        {/* App Version and Locale */}
        <div className="text-center">
          <p className={`text-xs ${isDark ? 'text-white/50' : 'text-slate-500'}`}>
            PredictSys AI v2.0 • App Executivo • {getLocaleLabel(currentLocale)}
          </p>
        </div>
      </div>
    </div>
  );
};

export default AppLogin;
