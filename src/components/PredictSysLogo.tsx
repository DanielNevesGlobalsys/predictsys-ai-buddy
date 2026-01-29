import logoImage from "@/assets/logo-predictsys.png";
import { cn } from "@/lib/utils";

interface PredictSysLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
  className?: string;
}

// Tamanhos controlados via CSS - altura fixa, largura automática
const sizeClasses = {
  xs: "h-6 w-auto",      // 24px
  sm: "h-7 w-auto",      // 28px - header mobile
  md: "h-8 w-auto",      // 32px - header desktop
  lg: "h-12 w-auto",     // 48px - landing
  xl: "h-14 w-auto",     // 56px - landing grande
  "2xl": "h-16 w-auto",  // 64px - login
  "3xl": "h-20 w-auto",  // 80px
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
        "object-contain block flex-shrink-0",
        sizeClasses[size],
        className
      )}
    />
  );
};

export default PredictSysLogo;
