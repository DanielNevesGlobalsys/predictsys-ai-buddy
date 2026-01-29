import { cn } from "@/lib/utils";
import logoBox from "@/assets/logo-box.svg";

interface PredictSysLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
  className?: string;
}

// Tamanhos do container
const sizeConfig = {
  xs: "w-8 h-8",
  sm: "w-10 h-10",
  md: "w-11 h-11",
  lg: "w-12 h-12",
  xl: "w-14 h-14",
  "2xl": "w-16 h-16",
  "3xl": "w-20 h-20",
};

export const PredictSysLogo = ({
  size = "md",
  className,
}: PredictSysLogoProps) => {
  const sizeClass = sizeConfig[size];
  
  return (
    <img 
      src={logoBox} 
      alt="PredictSys Logo" 
      className={cn("flex-shrink-0", sizeClass, className)}
    />
  );
};

export default PredictSysLogo;
