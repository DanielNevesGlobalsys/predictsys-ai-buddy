import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import logoBox from '@/assets/logo-box.svg';

const ONBOARDING_KEY = 'predictsys_app_onboarding_seen';
const APP_THEME_KEY = 'predictsys_app_theme';

/**
 * Splash screen only for APP mode (/app/* routes or standalone PWA)
 * Flow:
 * 1. Show animated splash (1.5s)
 * 2. Check if onboarding was seen (localStorage)
 * 3. If not seen -> /app/bem-vindo (onboarding)
 * 4. If seen, check auth:
 *    - Not logged in -> /app/login
 *    - Logged in -> /app/home
 */
const AppSplash = () => {
  const navigate = useNavigate();
  const [isAnimating, setIsAnimating] = useState(true);

  // Apply saved theme immediately to prevent flash
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
  }, []);

  useEffect(() => {
    const checkAndRedirect = async () => {
      // Wait for animation to complete
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setIsAnimating(false);

      // Check if onboarding was already seen (localStorage)
      const onboardingSeen = localStorage.getItem(ONBOARDING_KEY) === 'true';

      if (!onboardingSeen) {
        // First time user - show onboarding
        navigate('/app/bem-vindo', { replace: true });
        return;
      }

      // Onboarding was seen, check auth status
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        // Not logged in - go to app login
        navigate('/app/login', { replace: true });
        return;
      }

      // Logged in - go to app home
      navigate('/app/home', { replace: true });
    };

    checkAndRedirect();
  }, [navigate]);

  // Get theme for styling
  const isDark = (localStorage.getItem(APP_THEME_KEY) || 'dark') === 'dark';

  return (
    <div 
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: isDark
          ? 'linear-gradient(135deg, hsl(222 47% 11%) 0%, hsl(215 90% 25%) 50%, hsl(189 85% 30%) 100%)'
          : 'linear-gradient(135deg, hsl(210 40% 98%) 0%, hsl(210 40% 96%) 50%, hsl(210 40% 94%) 100%)',
      }}
    >
      {/* Glow effect behind logo */}
      <div 
        className={`absolute w-48 h-48 rounded-full blur-3xl transition-opacity duration-1000 ${
          isAnimating ? 'opacity-60' : 'opacity-0'
        }`}
        style={{
          background: 'radial-gradient(circle, hsl(189 85% 52% / 0.5) 0%, transparent 70%)',
        }}
      />
      
      {/* Pulse ring animation */}
      <div 
        className={`absolute w-32 h-32 rounded-full border-2 border-secondary/30 ${
          isAnimating ? 'animate-ping' : ''
        }`}
        style={{ animationDuration: '2s' }}
      />
      
      {/* Logo with fade and scale animation */}
      <img
        src={logoBox}
        alt="PredictSys AI"
        className={`w-28 h-28 z-10 transition-all duration-1000 ease-out ${
          isAnimating 
            ? 'opacity-100 scale-100' 
            : 'opacity-0 scale-95'
        }`}
        style={{
          animation: isAnimating ? 'splash-logo 1.5s ease-out forwards' : 'none',
          filter: 'drop-shadow(0 0 20px hsl(189 85% 52% / 0.4))',
        }}
      />
      
      <style>{`
        @keyframes splash-logo {
          0% {
            opacity: 0;
            transform: scale(0.9);
          }
          50% {
            opacity: 1;
            transform: scale(1.02);
          }
          100% {
            opacity: 1;
            transform: scale(1);
          }
        }
      `}</style>
    </div>
  );
};

export default AppSplash;
