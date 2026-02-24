import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  GraduationCap,
  ShoppingBag,
  Heart,
  Truck,
  Landmark,
  Globe,
} from "lucide-react";
import type { IndustryInference } from "@/hooks/useProblemInference";

interface IndustryBadgeProps {
  industry: IndustryInference;
}

const INDUSTRY_ICONS: Record<string, React.ElementType> = {
  education: GraduationCap,
  retail_shopping: ShoppingBag,
  healthcare: Heart,
  logistics: Truck,
  financial: Landmark,
  generic: Globe,
};

const IndustryBadge = ({ industry }: IndustryBadgeProps) => {
  const { t } = useTranslation();
  const Icon = INDUSTRY_ICONS[industry.label] || Building2;

  return (
    <div className="flex items-center gap-3 p-3 bg-accent/10 border border-accent/20 rounded-lg">
      <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center flex-shrink-0">
        <Icon className="w-4 h-4 text-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {t("inference.industryDetected", "Segmento detectado")}:
          </span>
          <Badge className="bg-accent/20 text-accent border-accent/30 text-xs">
            {industry.display_name}
          </Badge>
          {industry.confidence != null && (
            <span className="text-xs text-muted-foreground">
              {(industry.confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
        {industry.evidence.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {t("inference.evidence", "Evidências")}: {industry.evidence.slice(0, 4).join(", ")}
            {industry.evidence.length > 4 && ` +${industry.evidence.length - 4}`}
          </p>
        )}
      </div>
    </div>
  );
};

export default IndustryBadge;
