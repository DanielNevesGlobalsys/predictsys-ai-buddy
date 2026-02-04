import { ReactNode, useEffect } from 'react';

/**
 * App-specific theme provider that forces dark mode for the PWA/App experience.
 * This is separate from the web ThemeProvider to ensure the app is always dark.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Force dark mode for app
    const root = document.documentElement;
    root.classList.remove('light');
    root.classList.add('dark');
    
    // Update theme-color meta tag for app bar
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', '#0f172a');
    }
    
    // Also set localStorage to prevent flash on reload
    localStorage.setItem('predictsys-theme', 'dark');
    
    return () => {
      // Cleanup not needed as app stays dark
    };
  }, []);

  return <>{children}</>;
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
