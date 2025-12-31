import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { FileDown, Loader2 } from "lucide-react";
import jsPDF from "jspdf";

interface NumericStat {
  column_name: string;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  median_value: number | null;
  std_value: number | null;
  null_count: number;
}

interface CategoricalStat {
  column_name: string;
  distinct_count: number;
  top_categories: { category: string; count: number }[];
}

interface KPIData {
  totalRows: number;
  totalColumns: number;
  numericCount: number;
  categoricalCount: number;
  missingPercentage: number;
  targetColumn?: string;
  dataQualityScore: number;
}

interface EDAExportPDFProps {
  projectName: string;
  kpiData: KPIData;
  numericStats: NumericStat[];
  categoricalStats: CategoricalStat[];
}

const EDAExportPDF = ({ projectName, kpiData, numericStats, categoricalStats }: EDAExportPDFProps) => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sections, setSections] = useState({
    summary: true,
    numeric: true,
    categorical: true,
    correlation: true,
    missing: true,
  });

  const formatNumber = (value: number | null): string => {
    if (value === null) return "-";
    return value.toFixed(2);
  };

  const generatePDF = async () => {
    setGenerating(true);

    try {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      let y = 20;

      // Title
      doc.setFontSize(24);
      doc.setTextColor(79, 70, 229); // Primary color
      doc.text("PredictSys AI", pageWidth / 2, y, { align: "center" });
      y += 10;

      doc.setFontSize(16);
      doc.setTextColor(0, 0, 0);
      doc.text(t("eda.exportTitle"), pageWidth / 2, y, { align: "center" });
      y += 10;

      doc.setFontSize(12);
      doc.setTextColor(100, 100, 100);
      doc.text(projectName, pageWidth / 2, y, { align: "center" });
      y += 8;

      doc.setFontSize(10);
      doc.text(new Date().toLocaleDateString(i18n.language), pageWidth / 2, y, { align: "center" });
      y += 15;

      // Summary section
      if (sections.summary) {
        doc.setFontSize(14);
        doc.setTextColor(0, 0, 0);
        doc.text(t("eda.exportSummary"), 20, y);
        y += 8;

        doc.setFontSize(10);
        doc.setTextColor(60, 60, 60);
        const summaryLines = [
          `${t("eda.kpis.rows.label")}: ${kpiData.totalRows.toLocaleString()}`,
          `${t("eda.kpis.columns.label")}: ${kpiData.totalColumns}`,
          `${t("eda.kpis.numeric.label")}: ${kpiData.numericCount}`,
          `${t("eda.kpis.categorical.label")}: ${kpiData.categoricalCount}`,
          `${t("eda.kpis.missing.label")}: ${kpiData.missingPercentage.toFixed(1)}%`,
          `${t("eda.kpis.quality.label")}: ${kpiData.dataQualityScore}/100`,
        ];
        if (kpiData.targetColumn) {
          summaryLines.push(`${t("eda.kpis.target.label")}: ${kpiData.targetColumn}`);
        }

        summaryLines.forEach((line) => {
          doc.text(line, 25, y);
          y += 6;
        });
        y += 10;
      }

      // Numeric stats section
      if (sections.numeric && numericStats.length > 0) {
        if (y > 250) {
          doc.addPage();
          y = 20;
        }

        doc.setFontSize(14);
        doc.setTextColor(0, 0, 0);
        doc.text(t("eda.exportNumeric"), 20, y);
        y += 8;

        doc.setFontSize(8);
        doc.setTextColor(60, 60, 60);

        // Table header
        const numHeaders = [t("eda.numeric.column"), t("eda.numeric.min"), t("eda.numeric.max"), t("eda.numeric.mean"), t("eda.numeric.median"), t("eda.numeric.std")];
        const colWidths = [40, 25, 25, 25, 25, 25];
        let x = 20;
        
        doc.setFillColor(240, 240, 240);
        doc.rect(20, y - 4, pageWidth - 40, 6, "F");
        
        numHeaders.forEach((header, i) => {
          doc.text(header, x, y);
          x += colWidths[i];
        });
        y += 6;

        // Table rows
        numericStats.slice(0, 15).forEach((stat) => {
          if (y > 280) {
            doc.addPage();
            y = 20;
          }
          x = 20;
          const values = [
            stat.column_name.slice(0, 15),
            formatNumber(stat.min_value),
            formatNumber(stat.max_value),
            formatNumber(stat.mean_value),
            formatNumber(stat.median_value),
            formatNumber(stat.std_value),
          ];
          values.forEach((val, i) => {
            doc.text(val, x, y);
            x += colWidths[i];
          });
          y += 5;
        });
        y += 10;
      }

      // Categorical stats section
      if (sections.categorical && categoricalStats.length > 0) {
        if (y > 250) {
          doc.addPage();
          y = 20;
        }

        doc.setFontSize(14);
        doc.setTextColor(0, 0, 0);
        doc.text(t("eda.exportCategorical"), 20, y);
        y += 8;

        doc.setFontSize(8);
        doc.setTextColor(60, 60, 60);

        const catHeaders = [t("eda.categorical.column"), t("eda.categorical.distinctCount"), t("eda.categorical.topCategory"), t("eda.categorical.count")];
        const catWidths = [50, 30, 60, 30];
        let x = 20;

        doc.setFillColor(240, 240, 240);
        doc.rect(20, y - 4, pageWidth - 40, 6, "F");

        catHeaders.forEach((header, i) => {
          doc.text(header, x, y);
          x += catWidths[i];
        });
        y += 6;

        categoricalStats.slice(0, 15).forEach((stat) => {
          if (y > 280) {
            doc.addPage();
            y = 20;
          }
          x = 20;
          const topCat = stat.top_categories[0];
          const values = [
            stat.column_name.slice(0, 20),
            stat.distinct_count.toString(),
            (topCat?.category || "-").slice(0, 25),
            (topCat?.count || 0).toString(),
          ];
          values.forEach((val, i) => {
            doc.text(val, x, y);
            x += catWidths[i];
          });
          y += 5;
        });
        y += 10;
      }

      // Missing values section
      if (sections.missing) {
        if (y > 250) {
          doc.addPage();
          y = 20;
        }

        doc.setFontSize(14);
        doc.setTextColor(0, 0, 0);
        doc.text(t("eda.exportMissing"), 20, y);
        y += 8;

        doc.setFontSize(10);
        doc.setTextColor(60, 60, 60);

        const totalMissing = numericStats.reduce((sum, s) => sum + s.null_count, 0);
        doc.text(`${t("eda.missing.overallMissing")}: ${kpiData.missingPercentage.toFixed(2)}%`, 25, y);
        y += 6;
        doc.text(`${t("eda.missing.columnsWithMissing")}: ${numericStats.filter(s => s.null_count > 0).length}`, 25, y);
        y += 10;
      }

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(`Generated by PredictSys AI - ${new Date().toISOString()}`, pageWidth / 2, 290, { align: "center" });

      // Save
      const fileName = `eda_predictsys_${projectName.replace(/[^a-zA-Z0-9]/g, "_")}_${new Date().toISOString().split("T")[0]}.pdf`;
      doc.save(fileName);

      toast({ title: t("eda.pdfSuccess") });
      setOpen(false);
    } catch (err: any) {
      console.error("Error generating PDF:", err);
      toast({ title: t("eda.pdfError"), description: err.message, variant: "destructive" });
    }

    setGenerating(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileDown className="w-4 h-4 mr-2" />
          {t("eda.exportPdf")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("eda.exportTitle")}</DialogTitle>
          <DialogDescription>{t("eda.exportDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {[
            { key: "summary", label: t("eda.exportSummary") },
            { key: "numeric", label: t("eda.exportNumeric") },
            { key: "categorical", label: t("eda.exportCategorical") },
            { key: "correlation", label: t("eda.exportCorrelation") },
            { key: "missing", label: t("eda.exportMissing") },
          ].map(({ key, label }) => (
            <div key={key} className="flex items-center space-x-2">
              <Checkbox
                id={key}
                checked={sections[key as keyof typeof sections]}
                onCheckedChange={(checked) =>
                  setSections((prev) => ({ ...prev, [key]: !!checked }))
                }
              />
              <Label htmlFor={key}>{label}</Label>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={generatePDF} disabled={generating}>
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("eda.generating")}
              </>
            ) : (
              <>
                <FileDown className="w-4 h-4 mr-2" />
                {t("eda.exportPdf")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EDAExportPDF;
