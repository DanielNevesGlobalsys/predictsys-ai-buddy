import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import jsPDF from "jspdf";

interface ModelData {
  id: string;
  algorithm_name: string;
  is_production: boolean;
  trained_at: string | null;
  metrics: { metric_name: string; metric_value: number }[];
}

interface DashboardData {
  models: ModelData[];
  productionModel: ModelData | null;
  featureImportances: { feature_name: string; importance_value: number }[];
  totalPredictions: number;
  lastPredictionAt: string | null;
}

interface DashboardExportPDFProps {
  projectId: string;
  projectName: string;
  problemType: string;
  dashboardData: DashboardData;
}

const DashboardExportPDF = ({
  projectId,
  projectName,
  problemType,
  dashboardData,
}: DashboardExportPDFProps) => {
  const { t, i18n } = useTranslation();
  const [exporting, setExporting] = useState(false);

  const exportPDF = async () => {
    setExporting(true);
    try {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.width;
      const margin = 20;
      let yPos = 20;

      // Title
      doc.setFontSize(20);
      doc.setFont("helvetica", "bold");
      doc.text(t("modelDashboard.pdf.title"), margin, yPos);
      yPos += 10;

      // Subtitle
      doc.setFontSize(12);
      doc.setFont("helvetica", "normal");
      doc.text(projectName, margin, yPos);
      yPos += 15;

      // Problem type
      doc.setFontSize(10);
      doc.text(`${t("modelDashboard.pdf.problemType")}: ${t(`project.${problemType}`)}`, margin, yPos);
      yPos += 7;

      // Generated date
      const dateLocale = i18n.language === "en" ? "en-US" : i18n.language === "es" ? "es-ES" : "pt-BR";
      doc.text(`${t("modelDashboard.pdf.generatedAt")}: ${new Date().toLocaleDateString(dateLocale)}`, margin, yPos);
      yPos += 15;

      // Production Model
      if (dashboardData.productionModel) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text(t("modelDashboard.pdf.productionModel"), margin, yPos);
        yPos += 8;

        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`${t("modelDashboard.pdf.algorithm")}: ${dashboardData.productionModel.algorithm_name}`, margin, yPos);
        yPos += 15;

        // Metrics table
        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.text(t("modelDashboard.pdf.metrics"), margin, yPos);
        yPos += 8;

        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        dashboardData.productionModel.metrics.forEach(metric => {
          doc.text(`${metric.metric_name}: ${metric.metric_value.toFixed(4)}`, margin + 5, yPos);
          yPos += 6;
        });
        yPos += 10;
      }

      // Feature Importance
      if (dashboardData.featureImportances.length > 0) {
        if (yPos > 250) {
          doc.addPage();
          yPos = 20;
        }

        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text(t("modelDashboard.pdf.featureImportance"), margin, yPos);
        yPos += 8;

        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        dashboardData.featureImportances.slice(0, 10).forEach((feature, index) => {
          doc.text(
            `${index + 1}. ${feature.feature_name}: ${feature.importance_value.toFixed(4)}`,
            margin + 5,
            yPos
          );
          yPos += 6;
        });
        yPos += 10;
      }

      // Footer
      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.text(
          `PredictSys AI - ${t("modelDashboard.pdf.page")} ${i} / ${pageCount}`,
          pageWidth / 2,
          doc.internal.pageSize.height - 10,
          { align: "center" }
        );
      }

      // Save
      const fileName = `dashboard_predictsys_${projectName.toLowerCase().replace(/\s+/g, "_")}_${new Date().toISOString().split("T")[0]}.pdf`;
      doc.save(fileName);
      toast.success(t("modelDashboard.pdf.success"));
    } catch (error) {
      console.error("Error exporting PDF:", error);
      toast.error(t("modelDashboard.pdf.error"));
    }
    setExporting(false);
  };

  return (
    <Button variant="outline" onClick={exportPDF} disabled={exporting}>
      {exporting ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      ) : (
        <Download className="w-4 h-4 mr-2" />
      )}
      {t("modelDashboard.pdf.export")}
    </Button>
  );
};

export default DashboardExportPDF;
