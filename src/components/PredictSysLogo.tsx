import { cn } from "@/lib/utils";
import logoIcon from "@/assets/logo-icon.svg";

interface PredictSysLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
  className?: string;
}

// Tamanhos do container e ícone
const sizeConfig = {
  xs: { container: "w-8 h-8", icon: "w-5 h-5", rounded: "rounded-lg" },
  sm: { container: "w-10 h-10", icon: "w-6 h-6", rounded: "rounded-xl" },
  md: { container: "w-11 h-11", icon: "w-7 h-7", rounded: "rounded-xl" },
  lg: { container: "w-12 h-12", icon: "w-7 h-7", rounded: "rounded-xl" },
  xl: { container: "w-14 h-14", icon: "w-8 h-8", rounded: "rounded-2xl" },
  "2xl": { container: "w-16 h-16", icon: "w-10 h-10", rounded: "rounded-2xl" },
  "3xl": { container: "w-20 h-20", icon: "w-12 h-12", rounded: "rounded-2xl" },
};

export const PredictSysLogo = ({
  size = "md",
  className,
}: PredictSysLogoProps) => {
  const config = sizeConfig[size];
  
  return (
    <div
      className={cn(
        "flex items-center justify-center flex-shrink-0",
        config.container,
        config.rounded,
        className
      )}
      style={{
        background: "linear-gradient(135deg, #1ABCEC 0%, #1083E9 100%)"
      }}
    >
      <img 
        src={logoIcon} 
        alt="PredictSys Logo" 
        className={cn(config.icon)}
      />
    </div>
  );
};

export default PredictSysLogo;
