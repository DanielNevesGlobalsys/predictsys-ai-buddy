import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Building2, GraduationCap, ShoppingBag, Heart,
  Truck, Landmark, Globe, Check, Wheat,
} from "lucide-react";
import type { IndustryKey } from "@/types/intentContract";
import { INDUSTRY_DISPLAY_NAMES } from "@/types/intentContract";

interface IndustrySelectorProps {
  value: IndustryKey | "";
  onChange: (industry: IndustryKey) => void;
  error?: string;
}

const INDUSTRY_OPTIONS: {
  key: IndustryKey;
  icon: React.ElementType;
  description: string;
}[] = [
  { key: "retail", icon: ShoppingBag, description: "E-commerce, lojas, marketplaces" },
  { key: "health", icon: Heart, description: "Hospitais, clínicas, planos de saúde" },
  { key: "finance", icon: Landmark, description: "Bancos, fintechs, seguradoras" },
  { key: "education", icon: GraduationCap, description: "Escolas, universidades, EAD" },
  { key: "logistics", icon: Truck, description: "Transporte, entregas, supply chain" },
  { key: "agro", icon: Wheat, description: "Cooperativas, fazendas, produtores rurais" },
  { key: "generic", icon: Globe, description: "Outro segmento / não sei" },
];

const IndustrySelector = ({ value, onChange, error }: IndustrySelectorProps) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <Label className="text-base font-medium flex items-center gap-2">
        <Building2 className="w-4 h-4 text-primary" />
        Segmento / Indústria *
      </Label>
      <p className="text-sm text-muted-foreground">
        Selecione o segmento do seu negócio. Isso ativa um adaptador com regras e defaults específicos.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {INDUSTRY_OPTIONS.map(({ key, icon: Icon, description }) => {
          const isSelected = value === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              className={`relative flex flex-col items-start gap-2 p-4 rounded-xl border-2 transition-all text-left
                ${isSelected
                  ? "border-primary bg-primary/5 shadow-sm"
                  : "border-border hover:border-primary/40 hover:bg-muted/30"
                }`}
            >
              {isSelected && (
                <div className="absolute top-2 right-2">
                  <Check className="w-4 h-4 text-primary" />
                </div>
              )}
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                isSelected ? "bg-primary/15" : "bg-muted"
              }`}>
                <Icon className={`w-4.5 h-4.5 ${isSelected ? "text-primary" : "text-muted-foreground"}`} />
              </div>
              <div>
                <span className={`text-sm font-semibold ${isSelected ? "text-primary" : ""}`}>
                  {INDUSTRY_DISPLAY_NAMES[key]}
                </span>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                  {description}
                </p>
              </div>
              {key === "health" && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 absolute top-2 left-2">
                  Novo
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
};

export default IndustrySelector;
