import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import jsPDF from 'jspdf';
import type { 
  DashboardFilters, 
  KPIData, 
  SegmentationBand, 
  Prediction 
} from './types';
import type { SimulationParams, SimulationResults, BusinessConfig } from './hooks/useSimulation';

interface DashboardPDFExportProps {
  projectId: string;
  projectName: string;
  organizationName: string;
  modelName: string;
  filters: DashboardFilters;
  kpis: KPIData;
  simulatedKpis: KPIData;
  simulationParams: SimulationParams;
  simulationResults: SimulationResults;
  businessConfig: BusinessConfig;
  segmentationBands: SegmentationBand[];
  predictions: Prediction[];
  problemType: string;
  isSimulationActive: boolean;
}

export function DashboardPDFExport({
  projectId,
  projectName,
  organizationName,
  modelName,
  filters,
  kpis,
  simulatedKpis,
  simulationParams,
  simulationResults,
  businessConfig,
  segmentationBands,
  predictions,
  problemType,
  isSimulationActive,
}: DashboardPDFExportProps) {
  const { t, i18n } = useTranslation();
  const [exporting, setExporting] = useState(false);

  const formatCurrency = (val: number) => {
    if (val >= 1000000) return `R$ ${(val / 1000000).toFixed(2)}M`;
    if (val >= 1000) return `R$ ${(val / 1000).toFixed(2)}K`;
    if (val < 0) return `-R$ ${Math.abs(val).toFixed(0)}`;
    return `R$ ${val.toFixed(0)}`;
  };

  const formatNumber = (num: number) => {
    return num.toLocaleString('pt-BR');
  };

  const exportPDF = async () => {
    setExporting(true);
    try {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.width;
      const margin = 20;
      let yPos = 20;

      // ========== COVER PAGE ==========
      doc.setFontSize(24);
      doc.setFont('helvetica', 'bold');
      doc.text('PredictSys AI', margin, yPos);
      yPos += 12;

      doc.setFontSize(18);
      doc.text(t('businessDashboard.pdf.title'), margin, yPos);
      yPos += 20;

      // Project info
      doc.setFontSize(12);
      doc.setFont('helvetica', 'normal');
      doc.text(`${t('businessDashboard.pdf.project')}: ${projectName}`, margin, yPos);
      yPos += 7;
      doc.text(`${t('businessDashboard.pdf.organization')}: ${organizationName}`, margin, yPos);
      yPos += 7;
      doc.text(`${t('businessDashboard.pdf.model')}: ${modelName}`, margin, yPos);
      yPos += 7;
      doc.text(`${t('businessDashboard.pdf.horizon')}: ${filters.horizon} ${t('common.days')}`, margin, yPos);
      yPos += 7;
      doc.text(`${t('businessDashboard.pdf.viewMode')}: ${filters.viewMode === 'risk' ? t('businessDashboard.filters.risk') : t('businessDashboard.filters.opportunity')}`, margin, yPos);
      yPos += 15;

      // Simulation info
      if (isSimulationActive) {
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text(t('businessDashboard.pdf.simulationActive'), margin, yPos);
        yPos += 7;
        doc.setFont('helvetica', 'normal');
        doc.text(`${t('businessDashboard.simulation.threshold')}: ${(simulationParams.threshold * 100).toFixed(0)}%`, margin + 5, yPos);
        yPos += 6;
        doc.text(`${t('businessDashboard.simulation.percentActioned')}: ${simulationParams.percentActioned}%`, margin + 5, yPos);
        yPos += 12;
      }

      // Generation date
      const dateLocale = i18n.language === 'en' ? 'en-US' : i18n.language === 'es' ? 'es-ES' : 'pt-BR';
      const generatedAt = new Date().toLocaleString(dateLocale);
      doc.text(`${t('businessDashboard.pdf.generatedAt')}: ${generatedAt}`, margin, yPos);
      yPos += 25;

      // ========== EXECUTIVE SUMMARY ==========
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.text(t('businessDashboard.pdf.executiveSummary'), margin, yPos);
      yPos += 12;

      const displayKpis = isSimulationActive ? simulatedKpis : kpis;

      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');

      // KPI Summary
      const kpiItems = [
        { label: t('businessDashboard.kpis.entitiesWithPrediction'), value: formatNumber(displayKpis.totalEntities) },
        { label: isSimulationActive ? t('businessDashboard.simulation.entitiesToAction') : t('businessDashboard.kpis.highRisk'), value: formatNumber(displayKpis.highProbabilityCount) },
        { label: t('businessDashboard.kpis.expectedEvents'), value: formatNumber(displayKpis.expectedEvents) },
        { label: isSimulationActive ? t('businessDashboard.simulation.netROI') : t('businessDashboard.kpis.financialImpact'), value: formatCurrency(displayKpis.financialImpact) },
      ];

      kpiItems.forEach(item => {
        doc.text(`• ${item.label}: ${item.value}`, margin, yPos);
        yPos += 7;
      });
      yPos += 10;

      // Simulation results section
      if (isSimulationActive) {
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text(t('businessDashboard.pdf.simulationResults'), margin, yPos);
        yPos += 10;

        doc.setFontSize(11);
        doc.setFont('helvetica', 'normal');
        const simItems = [
          { label: t('businessDashboard.simulation.entitiesToAction'), value: formatNumber(simulationResults.entitiesToAction) },
          { label: t('businessDashboard.simulation.eventsCaptured'), value: formatNumber(simulationResults.expectedEventsCaptured) },
          { label: t('businessDashboard.simulation.captureRate'), value: `${simulationResults.captureRate.toFixed(1)}%` },
          { label: t('businessDashboard.simulation.totalCost'), value: formatCurrency(simulationResults.costTotal) },
          { label: t('businessDashboard.simulation.grossProfit'), value: formatCurrency(simulationResults.financialImpact) },
          { label: t('businessDashboard.simulation.netROI'), value: formatCurrency(simulationResults.netROI) },
        ];

        simItems.forEach(item => {
          doc.text(`• ${item.label}: ${item.value}`, margin, yPos);
          yPos += 7;
        });
        yPos += 10;
      }

      // ========== SEGMENTATION ==========
      if (segmentationBands.length > 0) {
        if (yPos > 240) {
          doc.addPage();
          yPos = 20;
        }

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text(t('businessDashboard.pdf.segmentation'), margin, yPos);
        yPos += 10;

        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        segmentationBands.forEach(band => {
          doc.text(`• ${band.range}: ${formatNumber(band.count)} (${band.percent.toFixed(1)}%)`, margin, yPos);
          yPos += 6;
        });
        yPos += 10;
      }

      // ========== BUSINESS CONFIG ==========
      if (yPos > 240) {
        doc.addPage();
        yPos = 20;
      }

      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text(t('businessDashboard.pdf.businessConfig'), margin, yPos);
      yPos += 10;

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      const configItems = [
        { label: t('businessDashboard.simulation.avgSale'), value: `R$ ${businessConfig.average_sale_value}` },
        { label: t('businessDashboard.simulation.margin'), value: `${businessConfig.average_margin_percent}%` },
        { label: t('businessDashboard.simulation.costContact'), value: `R$ ${businessConfig.cost_per_contact}` },
        { label: t('businessDashboard.simulation.baseline'), value: `${businessConfig.baseline_conversion_percent}%` },
      ];

      configItems.forEach(item => {
        doc.text(`• ${item.label}: ${item.value}`, margin, yPos);
        yPos += 6;
      });
      yPos += 15;

      // ========== TOP 20 PRIORITY LIST ==========
      doc.addPage();
      yPos = 20;

      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text(t('businessDashboard.pdf.priorityList'), margin, yPos);
      yPos += 12;

      // Sort predictions by probability
      const sortedPredictions = [...predictions]
        .filter(p => p.probability_event !== null)
        .sort((a, b) => (b.probability_event || 0) - (a.probability_event || 0))
        .slice(0, 20);

      if (sortedPredictions.length > 0) {
        // Table header
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.text('#', margin, yPos);
        doc.text(t('businessDashboard.pdf.entityId'), margin + 10, yPos);
        doc.text(t('businessDashboard.pdf.probability'), margin + 70, yPos);
        doc.text(t('businessDashboard.pdf.segment'), margin + 100, yPos);
        doc.text(t('businessDashboard.pdf.potentialValue'), margin + 140, yPos);
        yPos += 6;

        // Separator line
        doc.setLineWidth(0.3);
        doc.line(margin, yPos, pageWidth - margin, yPos);
        yPos += 4;

        // Table rows
        doc.setFont('helvetica', 'normal');
        sortedPredictions.forEach((p, index) => {
          if (yPos > 270) {
            doc.addPage();
            yPos = 20;
          }
          doc.text(`${index + 1}`, margin, yPos);
          doc.text(p.entity_id.substring(0, 20), margin + 10, yPos);
          doc.text(`${((p.probability_event || 0) * 100).toFixed(1)}%`, margin + 70, yPos);
          doc.text(p.segment || '-', margin + 100, yPos);
          doc.text(p.potential_value ? formatCurrency(p.potential_value) : '-', margin + 140, yPos);
          yPos += 5;
        });
      } else {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.text(t('businessDashboard.pdf.noData'), margin, yPos);
      }

      // ========== FOOTER ON ALL PAGES ==========
      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.text(
          t('businessDashboard.pdf.footer'),
          pageWidth / 2,
          doc.internal.pageSize.height - 10,
          { align: 'center' }
        );
        doc.text(
          `${t('businessDashboard.pdf.page')} ${i} / ${pageCount}`,
          pageWidth - margin,
          doc.internal.pageSize.height - 10,
          { align: 'right' }
        );
      }

      // Save PDF
      const fileName = `relatorio_predictsys_${projectName.toLowerCase().replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
      doc.save(fileName);
      toast.success(t('businessDashboard.pdf.success'));
    } catch (error) {
      console.error('Error exporting PDF:', error);
      toast.error(t('businessDashboard.pdf.error'));
    }
    setExporting(false);
  };

  return (
    <Button variant="outline" size="sm" onClick={exportPDF} disabled={exporting} className="gap-2">
      {exporting ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <FileText className="w-4 h-4" />
      )}
      {t('businessDashboard.pdf.export')}
    </Button>
  );
}
