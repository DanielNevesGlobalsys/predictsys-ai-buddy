import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";

/**
 * Detects if running as installed PWA (standalone mode)
 */
function isStandaloneMode(): boolean {
  if ((window.navigator as any).standalone === true) return true;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  return false;
}

/**
 * Detects if device is mobile based on viewport width
 */
function isMobileDevice(): boolean {
  return window.innerWidth < 900;
}

interface PwaInstallGateProps {
  children: React.ReactNode;
}

/**
 * PWA Install Gate - ONLY blocks /app/* routes on mobile when not installed
 * Web routes (/, /auth, etc.) are NEVER blocked
 */
export const PwaInstallGate = ({ children }: PwaInstallGateProps) => {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const checkConditions = () => {
      const mobile = isMobileDevice();
      const standalone = isStandaloneMode();
      const isAppRoute = location.pathname.startsWith("/app");
      const isInstallRoute = location.pathname === "/app/install";
      
      // Only apply logic to /app/* routes
      if (!isAppRoute) return;
      
      // If already on install page, don't redirect
      if (isInstallRoute) return;
      
      // If on mobile + in standalone mode, allow access
      if (mobile && standalone) return;
      
      // If on mobile + NOT standalone + in /app/* routes, redirect to install
      if (mobile && !standalone) {
        navigate("/app/install", { replace: true });
        return;
      }
      
      // Desktop users can access /app/* normally (no blocking)
    };

    checkConditions();
    
    window.addEventListener("resize", checkConditions);
    
    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const handleDisplayModeChange = (e: MediaQueryListEvent) => {
      if (e.matches && location.pathname === "/app/install") {
        navigate("/app/bem-vindo", { replace: true });
      }
    };
    mediaQuery.addEventListener("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("resize", checkConditions);
      mediaQuery.removeEventListener("change", handleDisplayModeChange);
    };
  }, [location.pathname, navigate]);

  return <>{children}</>;
};

export default PwaInstallGate;
