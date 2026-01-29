import logoImage from "@/assets/logo-predictsys.png";
import { cn } from "@/lib/utils";

interface PredictSysLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
  className?: string;
}

// Tamanhos maiores para melhor visibilidade
const sizeClasses = {
  xs: "w-10 h-10",     // 40px - cards pequenos
  sm: "w-12 h-12",     // 48px - footer/cards
  md: "w-14 h-14",     // 56px - navbar/header
  lg: "w-16 h-16",     // 64px
  xl: "w-20 h-20",     // 80px
  "2xl": "w-24 h-24",  // 96px - login
  "3xl": "w-32 h-32",  // 128px - splash/hero grande
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
