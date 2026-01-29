import logoImage from "@/assets/logo-predictsys.png";
import { cn } from "@/lib/utils";

interface PredictSysLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
  showBackground?: boolean;
}

const sizeClasses = {
  xs: "w-6 h-6",
  sm: "w-8 h-8",
  md: "w-10 h-10",
  lg: "w-12 h-12",
  xl: "w-16 h-16",
};

const imageSizeClasses = {
  xs: "w-5 h-5",
  sm: "w-6 h-6",
  md: "w-8 h-8",
  lg: "w-10 h-10",
  xl: "w-14 h-14",
};

export const PredictSysLogo = ({
  size = "md",
  className,
  showBackground = true,
}: PredictSysLogoProps) => {
  if (showBackground) {
    return (
      <div
        className={cn(
          "bg-gradient-primary rounded-xl flex items-center justify-center",
          sizeClasses[size],
          className
        )}
      >
        <img
          src={logoImage}
          alt="PredictSys AI"
          className={cn("object-contain", imageSizeClasses[size])}
        />
      </div>
    );
  }

  return (
    <img
      src={logoImage}
      alt="PredictSys AI"
      className={cn("object-contain", sizeClasses[size], className)}
    />
  );
};

export default PredictSysLogo;
