import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface ExcludedFeaturesListProps {
  excludedColumns: string[];
}

const ExcludedFeaturesList = ({ excludedColumns }: ExcludedFeaturesListProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  if (excludedColumns.length === 0) return null;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full py-2">
        {isOpen ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
        <ShieldAlert className="w-4 h-4 text-amber-500" />
        <span>
          {t("lysSuggestions.excludedTitle", "Excluídas automaticamente")} ({excludedColumns.length})
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-wrap gap-1.5 pt-2 pl-6">
          {excludedColumns.map((col) => (
            <Badge key={col} variant="outline" className="text-xs text-muted-foreground">
              {col}
            </Badge>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2 pl-6">
          {t(
            "lysSuggestions.excludedReason",
            "Colunas de ID, com alta cardinalidade, muitos nulos ou datas foram excluídas para evitar data leakage."
          )}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
};

export default ExcludedFeaturesList;
