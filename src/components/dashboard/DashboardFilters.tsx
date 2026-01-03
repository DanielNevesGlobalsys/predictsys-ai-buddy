import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Filter } from "lucide-react";

interface DashboardFiltersProps {
  selectedDataset: string;
  onDatasetChange: (value: string) => void;
  availableSplits?: string[];
}

const DashboardFilters = ({ selectedDataset, onDatasetChange, availableSplits = ["training", "validation"] }: DashboardFiltersProps) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t("modelDashboard.filters.title")}</span>
      </div>
      
      <Select value={selectedDataset} onValueChange={onDatasetChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t("modelDashboard.filters.dataset")} />
        </SelectTrigger>
        <SelectContent>
          {availableSplits.includes("training") && (
            <SelectItem value="training">{t("modelDashboard.filters.training")}</SelectItem>
          )}
          {availableSplits.includes("validation") && (
            <SelectItem value="validation">{t("modelDashboard.filters.validation")}</SelectItem>
          )}
          {availableSplits.includes("test") && (
            <SelectItem value="test">{t("modelDashboard.filters.test")}</SelectItem>
          )}
        </SelectContent>
      </Select>
      
      <span className="text-xs text-muted-foreground">
        {t("modelDashboard.filters.currentlyShowing", { split: t(`modelDashboard.filters.${selectedDataset}`) })}
      </span>
    </div>
  );
};

export default DashboardFilters;
