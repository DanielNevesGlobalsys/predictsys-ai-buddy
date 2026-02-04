import { ReactNode, useEffect, useState, createContext, useContext } from 'react';

const APP_THEME_KEY = 'predictsys_app_theme';

interface AppThemeContextType {
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;
}

const AppThemeContext = createContext<AppThemeContextType | undefined>(undefined);

/**
 * App-specific theme provider for PWA/App experience.
 * Reads and persists theme preference to localStorage.
 * Default is 'dark' if no preference is saved.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<'dark' | 'light'>(() => {
    // Initialize from localStorage or default to dark
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(APP_THEME_KEY);
      return saved === 'light' ? 'light' : 'dark';
    }
    return 'dark';
  });

  const setTheme = (newTheme: 'dark' | 'light') => {
    setThemeState(newTheme);
    localStorage.setItem(APP_THEME_KEY, newTheme);
  };

  // Apply theme to document on mount and when theme changes
  useEffect(() => {
    const root = document.documentElement;
    
    if (theme === 'dark') {
      root.classList.remove('light');
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
    }
    
    // Update theme-color meta tag based on theme
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#ffffff');
    }
  }, [theme]);

  return (
    <AppThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </AppThemeContext.Provider>
  );
}

export function useAppTheme() {
  const context = useContext(AppThemeContext);
  if (context === undefined) {
    throw new Error('useAppTheme must be used within an AppThemeProvider');
  }
  return context;
}

/**
 * Utility to detect if we're running in standalone/PWA mode
 */
export function isStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  
  // Check for display-mode: standalone (Android/Chrome)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  
  // Check for iOS standalone mode
  const isIOSStandalone = (window.navigator as any).standalone === true;
  
  // Check if in /app routes
  const isAppRoute = window.location.pathname.startsWith('/app');
  
  return isStandalone || isIOSStandalone || isAppRoute;
}
