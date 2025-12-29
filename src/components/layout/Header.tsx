import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Brain, LogOut, MessageSquare, Moon, Sun, Globe } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/contexts/ThemeContext";

interface HeaderProps {
  showBackButton?: boolean;
  backTo?: string;
  backIcon?: React.ReactNode;
  title?: string;
  subtitle?: string;
  rightContent?: React.ReactNode;
}

const Header = ({ 
  showBackButton, 
  backTo, 
  backIcon, 
  title, 
  subtitle,
  rightContent 
}: HeaderProps) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive",
      });
    } else {
      navigate("/auth");
    }
  };

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  const currentLanguage = i18n.language;
  const languageLabels: Record<string, string> = {
    pt: "PT",
    en: "EN",
    es: "ES",
  };

  return (
    <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {showBackButton && backTo && (
            <Button variant="ghost" size="icon" onClick={() => navigate(backTo)}>
              {backIcon}
            </Button>
          )}
          <div 
            className="flex items-center gap-3 cursor-pointer" 
            onClick={() => navigate("/dashboard")}
          >
            <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-primary-foreground" />
            </div>
            {title ? (
              <div>
                <h1 className="text-xl font-bold">{title}</h1>
                {subtitle && (
                  <p className="text-sm text-muted-foreground">{subtitle}</p>
                )}
              </div>
            ) : (
              <h1 className="text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent">
                PredictSys AI
              </h1>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {rightContent}
          
          {/* Language Selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <Globe className="w-5 h-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => changeLanguage("pt")}
                className={currentLanguage === "pt" ? "bg-primary/10" : ""}
              >
                🇧🇷 Português
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => changeLanguage("en")}
                className={currentLanguage === "en" ? "bg-primary/10" : ""}
              >
                🇺🇸 English
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => changeLanguage("es")}
                className={currentLanguage === "es" ? "bg-primary/10" : ""}
              >
                🇪🇸 Español
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Theme Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={toggleTheme}>
                {theme === "light" ? (
                  <Moon className="w-5 h-5" />
                ) : (
                  <Sun className="w-5 h-5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("header.toggleTheme")}</p>
            </TooltipContent>
          </Tooltip>

          {/* Chatbot Link */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => navigate("/chatbot")}>
                <MessageSquare className="w-5 h-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("header.openChatbot")}</p>
            </TooltipContent>
          </Tooltip>

          <Button variant="ghost" onClick={handleLogout}>
            <LogOut className="w-4 h-4 mr-2" />
            {t("auth.logout")}
          </Button>
        </div>
      </div>
    </header>
  );
};

export default Header;
