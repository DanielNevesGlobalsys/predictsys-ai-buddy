import logoImage from "@/assets/logo-predictsys.png";
import { cn } from "@/lib/utils";

interface PredictSysLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  className?: string;
}

// Tamanhos ajustados para melhor visibilidade
// xs: ícones pequenos, sm: footer, md: header/navbar, lg: cards, xl: login/splash, 2xl: hero
const sizeClasses = {
  xs: "w-8 h-8",      // 32px
  sm: "w-10 h-10",    // 40px
  md: "w-10 h-10",    // 40px - navbar/header
  lg: "w-14 h-14",    // 56px
  xl: "w-16 h-16",    // 64px - login
  "2xl": "w-20 h-20", // 80px - splash/hero
};

export const PredictSysLogo = ({
  size = "md",
  className,
}: PredictSysLogoProps) => {
  return (
    <img
      src={logoImage}
      alt="PredictSys AI"
      className={cn(
        "object-contain aspect-square flex-shrink-0",
        sizeClasses[size],
        className
      )}
    />
  );
};

export default PredictSysLogo;
