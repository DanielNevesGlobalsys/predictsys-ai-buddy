import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Moon, Sun, Globe } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

const GlobalControls = () => {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  const currentLanguage = i18n.language;

  return (
    <div className="flex items-center gap-2">
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
    </div>
  );
};

export default GlobalControls;
