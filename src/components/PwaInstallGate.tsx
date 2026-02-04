import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import PredictSysLogo from "@/components/PredictSysLogo";
import { Share, MoreVertical, Plus, Download, ExternalLink } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Detects if running as installed PWA (standalone mode)
 */
function isStandaloneMode(): boolean {
  // iOS Safari standalone
  if ((window.navigator as any).standalone === true) {
    return true;
  }
  // Android/Desktop standalone
  if (window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }
  // Fullscreen mode (some PWAs use this)
  if (window.matchMedia("(display-mode: fullscreen)").matches) {
    return true;
  }
  return false;
}

/**
 * Detects if device is mobile based on viewport width
 */
function isMobileDevice(): boolean {
  return window.innerWidth < 900;
}

/**
 * Detects iOS device
 */
function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
}

/**
 * Detects if browser supports PWA installation
 */
function isSafari(): boolean {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

interface PwaInstallGateProps {
  children: React.ReactNode;
}

export const PwaInstallGate = ({ children }: PwaInstallGateProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isBlocked, setIsBlocked] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [wasPromptDismissed, setWasPromptDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Check conditions on mount and resize
  useEffect(() => {
    const checkConditions = () => {
      const mobile = isMobileDevice();
      const standalone = isStandaloneMode();
      const isAppRoute = location.pathname.startsWith("/app");
      
      setIsMobile(mobile);
      
      // If in standalone mode on mobile, redirect to app welcome
      if (mobile && standalone && !isAppRoute) {
        navigate("/app/bem-vindo", { replace: true });
        return;
      }
      
      // Block if: mobile + not standalone (regardless of route)
      // User MUST install PWA to use on mobile
      if (mobile && !standalone) {
        setIsBlocked(true);
      } else {
        setIsBlocked(false);
      }
    };

    checkConditions();
    
    // Listen for resize events
    window.addEventListener("resize", checkConditions);
    
    // Listen for display-mode changes (when user installs PWA)
    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const handleDisplayModeChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        navigate("/app/bem-vindo", { replace: true });
      }
    };
    mediaQuery.addEventListener("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("resize", checkConditions);
      mediaQuery.removeEventListener("change", handleDisplayModeChange);
    };
  }, [location.pathname, navigate]);

  // Capture beforeinstallprompt event
  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    // Check if app was installed
    window.addEventListener("appinstalled", () => {
      setDeferredPrompt(null);
      navigate("/app/bem-vindo", { replace: true });
    });

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, [navigate]);

  // Handle install button click
  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    
    setIsInstalling(true);
    
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      
      if (outcome === "accepted") {
        setDeferredPrompt(null);
        // Will be redirected by appinstalled event or display-mode change
      } else {
        setWasPromptDismissed(true);
      }
    } catch (error) {
      console.error("Install prompt error:", error);
    } finally {
      setIsInstalling(false);
    }
  };

  // If not blocked, render children normally
  if (!isBlocked) {
    return <>{children}</>;
  }

  // Render install gate screen
  const showIOSInstructions = isIOS() || (isSafari() && !deferredPrompt);
  const showAndroidInstructions = !isIOS() && !deferredPrompt;

  return (
    <div className="fixed inset-0 z-[9999] bg-gradient-to-br from-[#1e3a5f] via-[#0f2744] to-[#0a1929] flex flex-col items-center justify-center p-6 text-white">
      {/* Logo */}
      <div className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <PredictSysLogo size="3xl" className="drop-shadow-2xl" />
      </div>

      {/* Title */}
      <h1 className="text-2xl font-bold text-center mb-3 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100">
        Instale o PredictSys para continuar
      </h1>

      {/* Subtitle */}
      <p className="text-white/70 text-center mb-8 max-w-xs animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
        A experiência é otimizada como aplicativo (PWA).
      </p>

      {/* Dismissed message */}
      {wasPromptDismissed && (
        <div className="bg-amber-500/20 border border-amber-500/30 rounded-lg p-4 mb-6 max-w-xs text-center animate-in fade-in duration-300">
          <p className="text-amber-200 text-sm">
            Para usar o PredictSys é necessário instalar o app.
          </p>
        </div>
      )}

      {/* Install button (Android/Chrome) */}
      {deferredPrompt && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
          <Button
            size="lg"
            onClick={handleInstallClick}
            disabled={isInstalling}
            className="bg-white text-[#1e3a5f] hover:bg-white/90 font-semibold px-8 py-6 text-lg rounded-xl shadow-xl"
          >
            <Download className="w-5 h-5 mr-2" />
            {isInstalling ? "Instalando..." : "Instalar agora"}
          </Button>
        </div>
      )}

      {/* iOS Instructions */}
      {showIOSInstructions && (
        <div className="bg-white/10 backdrop-blur-sm rounded-2xl p-6 max-w-sm animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
          <h2 className="text-lg font-semibold mb-4 text-center">
            Como instalar no iOS
          </h2>
          
          <div className="space-y-4">
            {/* Step 1 */}
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <Share className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium">1. Toque em Compartilhar</p>
                <p className="text-sm text-white/60">No Safari, toque no ícone de compartilhar na barra inferior.</p>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <Plus className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium">2. Adicionar à Tela de Início</p>
                <p className="text-sm text-white/60">Role e toque em "Adicionar à Tela de Início".</p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <ExternalLink className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium">3. Toque em Adicionar</p>
                <p className="text-sm text-white/60">Confirme para adicionar o ícone à sua tela inicial.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Android Instructions (when beforeinstallprompt is not available) */}
      {showAndroidInstructions && (
        <div className="bg-white/10 backdrop-blur-sm rounded-2xl p-6 max-w-sm animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
          <h2 className="text-lg font-semibold mb-4 text-center">
            Como instalar no Android
          </h2>
          
          <div className="space-y-4">
            {/* Step 1 */}
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <MoreVertical className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium">1. Abra o menu</p>
                <p className="text-sm text-white/60">Toque nos três pontos (⋮) no canto superior direito.</p>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <Download className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium">2. Instalar aplicativo</p>
                <p className="text-sm text-white/60">Selecione "Instalar aplicativo" ou "Adicionar à tela inicial".</p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                <ExternalLink className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium">3. Confirme</p>
                <p className="text-sm text-white/60">Toque em "Instalar" para adicionar o app.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <p className="text-white/50 text-sm text-center mt-8 max-w-xs animate-in fade-in duration-700 delay-500">
        Após instalar, abra pelo ícone na tela inicial.
      </p>
    </div>
  );
};

export default PwaInstallGate;
