import logoImage from "@/assets/logo-predictsys.png";
import { cn } from "@/lib/utils";

interface PredictSysLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeClasses = {
  xs: "w-6 h-6",
  sm: "w-8 h-8",
  md: "w-10 h-10",
  lg: "w-12 h-12",
  xl: "w-16 h-16",
};

export const PredictSysLogo = ({
  size = "md",
  className,
}: PredictSysLogoProps) => {
  return (
    <img
      src={logoImage}
      alt="PredictSys AI"
      className={cn("object-contain", sizeClasses[size], className)}
    />
  );
};

export default PredictSysLogo;
