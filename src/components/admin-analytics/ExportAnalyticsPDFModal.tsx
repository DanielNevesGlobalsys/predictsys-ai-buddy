import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileText, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { generateAnalyticsPDF } from "./utils/generateAnalyticsPDF";
import type { GlobalKPIs, HealthMetrics, OrganizationUsage, DailyTrend, TimeToValueGlobal } from "./types";

interface ExportAnalyticsPDFModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dateRange: string;
  globalKPIs: GlobalKPIs;
  healthMetrics: HealthMetrics;
  organizationUsage: OrganizationUsage[];
  dailyTrend: DailyTrend[];
  timeToValue: TimeToValueGlobal;
}

export function ExportAnalyticsPDFModal({
  open,
  onOpenChange,
  dateRange,
  globalKPIs,
  healthMetrics,
  organizationUsage,
  dailyTrend,
  timeToValue,
}: ExportAnalyticsPDFModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isGenerating, setIsGenerating] = useState(false);
  const [includeDetails, setIncludeDetails] = useState(true);
  const [includeCharts, setIncludeCharts] = useState(true);
  const [includeHealth, setIncludeHealth] = useState(true);
  const [includeTTV, setIncludeTTV] = useState(true);

  const handleExport = async () => {
    setIsGenerating(true);
    try {
      await generateAnalyticsPDF({
        dateRange,
        globalKPIs,
        healthMetrics,
        organizationUsage,
        dailyTrend,
        timeToValue,
        options: {
          includeDetails,
          includeCharts,
          includeHealth,
          includeTTV,
        },
      });

      toast({
        title: t("adminAnalytics.export.success", "Relatório exportado"),
        description: t("adminAnalytics.export.successDescription", "O PDF foi gerado e baixado com sucesso."),
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Error generating PDF:", error);
      toast({
        title: t("adminAnalytics.export.error", "Erro ao exportar"),
        description: t("adminAnalytics.export.errorDescription", "Não foi possível gerar o relatório PDF."),
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t("adminAnalytics.export.title", "Exportar Relatório PDF")}
          </DialogTitle>
          <DialogDescription>
            {t("adminAnalytics.export.description", "Selecione as seções que deseja incluir no relatório.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="include-details"
              checked={includeDetails}
              onCheckedChange={(checked) => setIncludeDetails(checked === true)}
            />
            <Label htmlFor="include-details" className="text-sm font-medium leading-none">
              {t("adminAnalytics.export.includeDetails", "Tabela detalhada por organização")}
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="include-charts"
              checked={includeCharts}
              onCheckedChange={(checked) => setIncludeCharts(checked === true)}
            />
            <Label htmlFor="include-charts" className="text-sm font-medium leading-none">
              {t("adminAnalytics.export.includeCharts", "Tabela de tendência diária")}
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="include-health"
              checked={includeHealth}
              onCheckedChange={(checked) => setIncludeHealth(checked === true)}
            />
            <Label htmlFor="include-health" className="text-sm font-medium leading-none">
              {t("adminAnalytics.export.includeHealth", "Métricas de saúde da plataforma")}
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="include-ttv"
              checked={includeTTV}
              onCheckedChange={(checked) => setIncludeTTV(checked === true)}
            />
            <Label htmlFor="include-ttv" className="text-sm font-medium leading-none">
              {t("adminAnalytics.export.includeTTV", "Time to Value")}
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isGenerating}>
            {t("common.cancel", "Cancelar")}
          </Button>
          <Button onClick={handleExport} disabled={isGenerating}>
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("adminAnalytics.export.generating", "Gerando...")}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {t("adminAnalytics.export.download", "Baixar PDF")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
