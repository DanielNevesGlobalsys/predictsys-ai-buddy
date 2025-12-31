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
  aiInsights?: string[];
}

const EDAExportPDF = ({ projectName, kpiData, numericStats, categoricalStats, aiInsights = [] }: EDAExportPDFProps) => {
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
    aiInsights: true,
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
      const margin = 20;
      let y = 20;

      const checkPageBreak = (neededSpace: number) => {
        if (y + neededSpace > 280) {
          doc.addPage();
          y = 20;
        }
      };

      // Cover page
      doc.setFontSize(28);
      doc.setTextColor(79, 70, 229);
      doc.text("PredictSys AI", pageWidth / 2, 60, { align: "center" });

      doc.setFontSize(18);
      doc.setTextColor(0, 0, 0);
      doc.text(t("eda.exportTitle"), pageWidth / 2, 80, { align: "center" });

      doc.setFontSize(14);
      doc.setTextColor(100, 100, 100);
      doc.text(projectName, pageWidth / 2, 100, { align: "center" });

      doc.setFontSize(11);
      doc.text(new Date().toLocaleDateString(i18n.language, { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }), pageWidth / 2, 115, { align: "center" });

      doc.addPage();
      y = 20;

      // Summary section with KPI explanations
      if (sections.summary) {
        doc.setFontSize(16);
        doc.setTextColor(79, 70, 229);
        doc.text(t("eda.exportSummary"), margin, y);
        y += 12;

        doc.setFontSize(10);
        doc.setTextColor(60, 60, 60);

        const kpiItems = [
          { label: t("eda.kpis.rows.label"), value: kpiData.totalRows.toLocaleString(), explanation: t("eda.kpis.rows.tooltip") },
          { label: t("eda.kpis.columns.label"), value: kpiData.totalColumns.toString(), explanation: t("eda.kpis.columns.tooltip") },
          { label: t("eda.kpis.numeric.label"), value: kpiData.numericCount.toString(), explanation: t("eda.kpis.numeric.tooltip") },
          { label: t("eda.kpis.categorical.label"), value: kpiData.categoricalCount.toString(), explanation: t("eda.kpis.categorical.tooltip") },
          { label: t("eda.kpis.missing.label"), value: `${kpiData.missingPercentage.toFixed(1)}%`, explanation: t("eda.kpis.missing.tooltip") },
          { label: t("eda.kpis.quality.label"), value: `${kpiData.dataQualityScore}/100`, explanation: t("eda.kpis.quality.tooltip") },
        ];

        if (kpiData.targetColumn) {
          kpiItems.push({ 
            label: t("eda.kpis.target.label"), 
            value: kpiData.targetColumn, 
            explanation: t("eda.kpis.target.tooltip") 
          });
        }

        kpiItems.forEach((item) => {
          checkPageBreak(18);
          doc.setFontSize(11);
          doc.setTextColor(0, 0, 0);
          doc.text(`${item.label}: ${item.value}`, margin + 5, y);
          y += 5;
          doc.setFontSize(9);
          doc.setTextColor(100, 100, 100);
          const lines = doc.splitTextToSize(item.explanation, pageWidth - margin * 2 - 10);
          doc.text(lines, margin + 10, y);
          y += lines.length * 4 + 6;
        });

        y += 10;
      }

      // AI Insights section
      if (sections.aiInsights && aiInsights.length > 0) {
        checkPageBreak(40);
        
        doc.setFontSize(16);
        doc.setTextColor(79, 70, 229);
        doc.text(t("eda.insights.title"), margin, y);
        y += 10;

        doc.setFontSize(10);
        doc.setTextColor(60, 60, 60);

        aiInsights.forEach((insight, index) => {
          checkPageBreak(20);
          doc.setFillColor(245, 245, 250);
          const lines = doc.splitTextToSize(`${index + 1}. ${insight}`, pageWidth - margin * 2 - 10);
          const boxHeight = lines.length * 5 + 6;
          doc.roundedRect(margin, y - 4, pageWidth - margin * 2, boxHeight, 2, 2, "F");
          doc.text(lines, margin + 5, y);
          y += boxHeight + 4;
        });

        y += 10;
      }

      // Numeric stats section
      if (sections.numeric && numericStats.length > 0) {
        checkPageBreak(40);

        doc.setFontSize(16);
        doc.setTextColor(79, 70, 229);
        doc.text(t("eda.exportNumeric"), margin, y);
        y += 10;

        doc.setFontSize(8);
        doc.setTextColor(60, 60, 60);

        // Table header
        const numHeaders = [t("eda.numeric.column"), t("eda.numeric.min"), t("eda.numeric.max"), t("eda.numeric.mean"), t("eda.numeric.median"), t("eda.numeric.std")];
        const colWidths = [45, 25, 25, 25, 25, 25];
        let x = margin;
        
        doc.setFillColor(79, 70, 229);
        doc.rect(margin, y - 4, pageWidth - margin * 2, 7, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(8);
        
        numHeaders.forEach((header, i) => {
          doc.text(header, x + 2, y);
          x += colWidths[i];
        });
        y += 7;
        doc.setTextColor(60, 60, 60);

        // Table rows
        numericStats.slice(0, 20).forEach((stat, rowIndex) => {
          checkPageBreak(8);
          x = margin;
          
          if (rowIndex % 2 === 0) {
            doc.setFillColor(248, 248, 252);
            doc.rect(margin, y - 4, pageWidth - margin * 2, 6, "F");
          }
          
          const values = [
            stat.column_name.slice(0, 18),
            formatNumber(stat.min_value),
            formatNumber(stat.max_value),
            formatNumber(stat.mean_value),
            formatNumber(stat.median_value),
            formatNumber(stat.std_value),
          ];
          values.forEach((val, i) => {
            doc.text(val, x + 2, y);
            x += colWidths[i];
          });
          y += 6;
        });
        y += 10;
      }

      // Categorical stats section
      if (sections.categorical && categoricalStats.length > 0) {
        checkPageBreak(40);

        doc.setFontSize(16);
        doc.setTextColor(79, 70, 229);
        doc.text(t("eda.exportCategorical"), margin, y);
        y += 10;

        doc.setFontSize(8);

        const catHeaders = [t("eda.categorical.column"), t("eda.categorical.distinctCount"), t("eda.categorical.topCategory"), t("eda.categorical.count")];
        const catWidths = [50, 35, 60, 25];
        let x = margin;

        doc.setFillColor(79, 70, 229);
        doc.rect(margin, y - 4, pageWidth - margin * 2, 7, "F");
        doc.setTextColor(255, 255, 255);

        catHeaders.forEach((header, i) => {
          doc.text(header, x + 2, y);
          x += catWidths[i];
        });
        y += 7;
        doc.setTextColor(60, 60, 60);

        categoricalStats.slice(0, 20).forEach((stat, rowIndex) => {
          checkPageBreak(8);
          x = margin;
          
          if (rowIndex % 2 === 0) {
            doc.setFillColor(248, 248, 252);
            doc.rect(margin, y - 4, pageWidth - margin * 2, 6, "F");
          }
          
          const topCat = stat.top_categories[0];
          const values = [
            stat.column_name.slice(0, 22),
            stat.distinct_count.toString(),
            (topCat?.category || "-").slice(0, 28),
            (topCat?.count || 0).toString(),
          ];
          values.forEach((val, i) => {
            doc.text(val, x + 2, y);
            x += catWidths[i];
          });
          y += 6;
        });
        y += 10;
      }

      // Missing values section
      if (sections.missing) {
        checkPageBreak(40);

        doc.setFontSize(16);
        doc.setTextColor(79, 70, 229);
        doc.text(t("eda.exportMissing"), margin, y);
        y += 10;

        doc.setFontSize(10);
        doc.setTextColor(60, 60, 60);

        doc.text(`${t("eda.missing.overallMissing")}: ${kpiData.missingPercentage.toFixed(2)}%`, margin + 5, y);
        y += 6;
        
        const columnsWithMissing = numericStats.filter(s => s.null_count > 0);
        doc.text(`${t("eda.missing.columnsWithMissing")}: ${columnsWithMissing.length}`, margin + 5, y);
        y += 10;

        if (columnsWithMissing.length > 0) {
          doc.setFontSize(9);
          columnsWithMissing.slice(0, 10).forEach((stat) => {
            checkPageBreak(6);
            const pct = ((stat.null_count / kpiData.totalRows) * 100).toFixed(1);
            doc.text(`• ${stat.column_name}: ${stat.null_count} (${pct}%)`, margin + 10, y);
            y += 5;
          });
        }
        y += 10;
      }

      // How to interpret section
      checkPageBreak(50);
      doc.setFontSize(14);
      doc.setTextColor(79, 70, 229);
      doc.text(t("eda.pdfInterpretTitle"), margin, y);
      y += 8;

      doc.setFontSize(9);
      doc.setTextColor(60, 60, 60);
      const interpretText = doc.splitTextToSize(t("eda.pdfInterpretText"), pageWidth - margin * 2);
      doc.text(interpretText, margin, y);

      // Footer on all pages
      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(`PredictSys AI - ${new Date().toISOString().split("T")[0]} - ${t("eda.pdfPage")} ${i}/${pageCount}`, pageWidth / 2, 290, { align: "center" });
      }

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
            { key: "aiInsights", label: t("eda.insights.title"), disabled: aiInsights.length === 0 },
            { key: "numeric", label: t("eda.exportNumeric") },
            { key: "categorical", label: t("eda.exportCategorical") },
            { key: "correlation", label: t("eda.exportCorrelation") },
            { key: "missing", label: t("eda.exportMissing") },
          ].map(({ key, label, disabled }) => (
            <div key={key} className="flex items-center space-x-2">
              <Checkbox
                id={key}
                checked={sections[key as keyof typeof sections]}
                onCheckedChange={(checked) =>
                  setSections((prev) => ({ ...prev, [key]: !!checked }))
                }
                disabled={disabled}
              />
              <Label htmlFor={key} className={disabled ? "text-muted-foreground" : ""}>
                {label}
                {disabled && ` (${t("eda.insights.noInsights")})`}
              </Label>
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