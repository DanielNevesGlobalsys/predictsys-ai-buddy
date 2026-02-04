/**
 * Detects if the app is running as a PWA (standalone mode)
 * Works on both Android and iOS
 */
export function isPWA(): boolean {
  // Check for iOS standalone mode
  const isIOSStandalone = (window.navigator as any).standalone === true;
  
  // Check for Android/Desktop standalone mode
  const isStandaloneMedia = window.matchMedia('(display-mode: standalone)').matches;
  
  // Check for fullscreen mode (some PWAs use this)
  const isFullscreen = window.matchMedia('(display-mode: fullscreen)').matches;
  
  return isIOSStandalone || isStandaloneMedia || isFullscreen;
}

/**
 * Returns true if current path starts with /app
 */
export function isAppRoute(): boolean {
  return window.location.pathname.startsWith('/app');
}
