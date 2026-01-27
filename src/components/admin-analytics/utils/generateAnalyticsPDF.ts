import jsPDF from "jspdf";
import type { GlobalKPIs, HealthMetrics, OrganizationUsage, DailyTrend, TimeToValueGlobal } from "../types";

interface GeneratePDFParams {
  dateRange: string;
  globalKPIs: GlobalKPIs;
  healthMetrics: HealthMetrics;
  organizationUsage: OrganizationUsage[];
  dailyTrend: DailyTrend[];
  timeToValue: TimeToValueGlobal;
  options: {
    includeDetails: boolean;
    includeCharts: boolean;
    includeHealth: boolean;
    includeTTV: boolean;
  };
}

const COLORS = {
  primary: [8, 145, 178] as [number, number, number], // cyan-600
  secondary: [100, 116, 139] as [number, number, number], // slate-500
  text: [30, 41, 59] as [number, number, number], // slate-800
  lightText: [100, 116, 139] as [number, number, number], // slate-500
  background: [248, 250, 252] as [number, number, number], // slate-50
  white: [255, 255, 255] as [number, number, number],
  border: [226, 232, 240] as [number, number, number], // slate-200
};

const dateRangeLabels: Record<string, string> = {
  "7": "Últimos 7 dias",
  "30": "Últimos 30 dias",
  "90": "Últimos 90 dias",
};

export async function generateAnalyticsPDF(params: GeneratePDFParams): Promise<void> {
  const { dateRange, globalKPIs, healthMetrics, organizationUsage, dailyTrend, timeToValue, options } = params;

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  let yPosition = margin;

  // Helper functions
  const addNewPageIfNeeded = (requiredSpace: number) => {
    if (yPosition + requiredSpace > pageHeight - 20) {
      doc.addPage();
      yPosition = margin;
      return true;
    }
    return false;
  };

  const drawHeader = () => {
    // Header background
    doc.setFillColor(...COLORS.primary);
    doc.rect(0, 0, pageWidth, 35, "F");

    // Logo text
    doc.setTextColor(...COLORS.white);
    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("PredictSys AI", margin, 15);

    // Subtitle
    doc.setFontSize(12);
    doc.setFont("helvetica", "normal");
    doc.text("Relatório de Analytics (Admin Global)", margin, 23);

    // Date range
    doc.setFontSize(10);
    doc.text(`Período: ${dateRangeLabels[dateRange] || dateRange}`, margin, 30);

    yPosition = 45;
  };

  const drawSectionTitle = (title: string) => {
    addNewPageIfNeeded(15);
    doc.setTextColor(...COLORS.primary);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, yPosition);
    yPosition += 8;
  };

  const drawKPICards = () => {
    drawSectionTitle("Resumo de KPIs");

    const kpis = [
      { label: "Organizações Ativas", value: globalKPIs.active_organizations.toString() },
      { label: "Total Organizações", value: globalKPIs.total_organizations.toString() },
      { label: "Projetos Criados", value: globalKPIs.projects_created.toString() },
      { label: "Datasets Conectados", value: globalKPIs.datasets_connected.toString() },
      { label: "Modelos Treinados", value: globalKPIs.models_trained.toString() },
      { label: "Previsões Executadas", value: globalKPIs.predictions_run.toString() },
      { label: "Segmentos Exportados", value: globalKPIs.segments_exported.toString() },
      { label: "Jobs com Erro", value: globalKPIs.jobs_error_count.toString() },
    ];

    const cardWidth = (pageWidth - margin * 2 - 15) / 4;
    const cardHeight = 20;
    const cardsPerRow = 4;

    kpis.forEach((kpi, index) => {
      const row = Math.floor(index / cardsPerRow);
      const col = index % cardsPerRow;
      const x = margin + col * (cardWidth + 5);
      const y = yPosition + row * (cardHeight + 5);

      // Card background
      doc.setFillColor(...COLORS.background);
      doc.setDrawColor(...COLORS.border);
      doc.roundedRect(x, y, cardWidth, cardHeight, 2, 2, "FD");

      // Label
      doc.setTextColor(...COLORS.lightText);
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.text(kpi.label, x + 3, y + 6);

      // Value
      doc.setTextColor(...COLORS.text);
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text(kpi.value, x + 3, y + 14);
    });

    yPosition += Math.ceil(kpis.length / cardsPerRow) * (cardHeight + 5) + 10;
  };

  const drawOrganizationTable = () => {
    addNewPageIfNeeded(60);
    drawSectionTitle("Uso por Organização");

    if (organizationUsage.length === 0) {
      doc.setTextColor(...COLORS.lightText);
      doc.setFontSize(10);
      doc.text("Nenhum dado disponível", margin, yPosition);
      yPosition += 10;
      return;
    }

    const headers = ["Organização", "Plano", "Projetos", "Modelos", "Previsões", "Exports", "Usuários"];
    const colWidths = [50, 25, 20, 20, 22, 18, 20];
    const rowHeight = 8;

    // Header row
    doc.setFillColor(...COLORS.primary);
    doc.rect(margin, yPosition, pageWidth - margin * 2, rowHeight, "F");
    doc.setTextColor(...COLORS.white);
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");

    let xPos = margin + 2;
    headers.forEach((header, index) => {
      doc.text(header, xPos, yPosition + 5.5);
      xPos += colWidths[index];
    });
    yPosition += rowHeight;

    // Data rows
    doc.setFont("helvetica", "normal");
    const maxRows = Math.min(organizationUsage.length, 10);

    for (let i = 0; i < maxRows; i++) {
      const org = organizationUsage[i];
      
      if (addNewPageIfNeeded(rowHeight)) {
        // Re-draw header on new page
        doc.setFillColor(...COLORS.primary);
        doc.rect(margin, yPosition, pageWidth - margin * 2, rowHeight, "F");
        doc.setTextColor(...COLORS.white);
        doc.setFont("helvetica", "bold");
        xPos = margin + 2;
        headers.forEach((header, index) => {
          doc.text(header, xPos, yPosition + 5.5);
          xPos += colWidths[index];
        });
        yPosition += rowHeight;
        doc.setFont("helvetica", "normal");
      }

      // Alternating row colors
      if (i % 2 === 0) {
        doc.setFillColor(...COLORS.background);
        doc.rect(margin, yPosition, pageWidth - margin * 2, rowHeight, "F");
      }

      doc.setTextColor(...COLORS.text);
      doc.setFontSize(8);
      xPos = margin + 2;

      const rowData = [
        org.organization_name.substring(0, 20),
        org.plan,
        org.projects_created.toString(),
        org.models_trained.toString(),
        org.predictions_run.toString(),
        org.segments_exported.toString(),
        `${org.active_users}/${org.total_users}`,
      ];

      rowData.forEach((cell, index) => {
        doc.text(cell, xPos, yPosition + 5.5);
        xPos += colWidths[index];
      });

      yPosition += rowHeight;
    }

    if (organizationUsage.length > 10) {
      doc.setTextColor(...COLORS.lightText);
      doc.setFontSize(8);
      doc.text(`... e mais ${organizationUsage.length - 10} organizações`, margin, yPosition + 5);
      yPosition += 8;
    }

    yPosition += 10;
  };

  const drawDailyTrendTable = () => {
    addNewPageIfNeeded(50);
    drawSectionTitle("Tendência Diária");

    if (dailyTrend.length === 0) {
      doc.setTextColor(...COLORS.lightText);
      doc.setFontSize(10);
      doc.text("Nenhum dado disponível", margin, yPosition);
      yPosition += 10;
      return;
    }

    const headers = ["Data", "Modelos", "Previsões", "Erros"];
    const colWidths = [40, 40, 40, 40];
    const rowHeight = 7;

    // Header row
    doc.setFillColor(...COLORS.primary);
    doc.rect(margin, yPosition, pageWidth - margin * 2, rowHeight, "F");
    doc.setTextColor(...COLORS.white);
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");

    let xPos = margin + 2;
    headers.forEach((header, index) => {
      doc.text(header, xPos, yPosition + 5);
      xPos += colWidths[index];
    });
    yPosition += rowHeight;

    // Data rows (last 7 days)
    doc.setFont("helvetica", "normal");
    const displayData = dailyTrend.slice(-7);

    displayData.forEach((day, i) => {
      if (i % 2 === 0) {
        doc.setFillColor(...COLORS.background);
        doc.rect(margin, yPosition, pageWidth - margin * 2, rowHeight, "F");
      }

      doc.setTextColor(...COLORS.text);
      doc.setFontSize(8);
      xPos = margin + 2;

      const rowData = [
        day.day,
        day.models_trained.toString(),
        day.predictions_run.toString(),
        day.jobs_error_count.toString(),
      ];

      rowData.forEach((cell, index) => {
        doc.text(cell, xPos, yPosition + 5);
        xPos += colWidths[index];
      });

      yPosition += rowHeight;
    });

    yPosition += 10;
  };

  const drawHealthMetrics = () => {
    addNewPageIfNeeded(40);
    drawSectionTitle("Saúde da Plataforma");

    const metrics = [
      { label: "Tempo médio de importação", value: `${healthMetrics.avg_import_ms} ms` },
      { label: "Tempo médio de EDA", value: `${healthMetrics.avg_eda_ms} ms` },
      { label: "Tempo médio de treinamento", value: `${healthMetrics.avg_train_ms} ms` },
      { label: "Tempo médio de previsão", value: `${healthMetrics.avg_predict_ms} ms` },
      { label: "Total de erros no período", value: healthMetrics.total_errors.toString() },
    ];

    const cardWidth = (pageWidth - margin * 2 - 10) / 3;
    const cardHeight = 18;

    metrics.forEach((metric, index) => {
      const row = Math.floor(index / 3);
      const col = index % 3;
      const x = margin + col * (cardWidth + 5);
      const y = yPosition + row * (cardHeight + 5);

      doc.setFillColor(...COLORS.background);
      doc.setDrawColor(...COLORS.border);
      doc.roundedRect(x, y, cardWidth, cardHeight, 2, 2, "FD");

      doc.setTextColor(...COLORS.lightText);
      doc.setFontSize(7);
      doc.text(metric.label, x + 3, y + 6);

      doc.setTextColor(...COLORS.text);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(metric.value, x + 3, y + 13);
      doc.setFont("helvetica", "normal");
    });

    yPosition += Math.ceil(metrics.length / 3) * (cardHeight + 5) + 10;
  };

  const drawTimeToValue = () => {
    addNewPageIfNeeded(50);
    drawSectionTitle("Time to Value");

    const formatHours = (hours: number | null): string => {
      if (hours === null || hours === 0) return "-";
      if (hours < 1) return `${Math.round(hours * 60)} min`;
      if (hours < 24) return `${hours.toFixed(1)} h`;
      return `${(hours / 24).toFixed(1)} dias`;
    };

    const stages = [
      { label: "Projeto → Dataset", value: formatHours(timeToValue.avg_project_to_dataset_hours), pct: timeToValue.projects_with_dataset_pct },
      { label: "Dataset → Treino", value: formatHours(timeToValue.avg_dataset_to_training_hours), pct: timeToValue.projects_with_training_pct },
      { label: "Treino → Previsão", value: formatHours(timeToValue.avg_training_to_prediction_hours), pct: timeToValue.projects_with_prediction_pct },
      { label: "Previsão → Export", value: formatHours(timeToValue.avg_prediction_to_export_hours), pct: timeToValue.projects_with_export_pct },
      { label: "Total TTV", value: formatHours(timeToValue.avg_total_time_to_value_hours), pct: null },
    ];

    stages.forEach((stage) => {
      doc.setFillColor(...COLORS.background);
      doc.roundedRect(margin, yPosition, pageWidth - margin * 2, 10, 2, 2, "F");

      doc.setTextColor(...COLORS.text);
      doc.setFontSize(9);
      doc.text(stage.label, margin + 3, yPosition + 6.5);

      doc.setFont("helvetica", "bold");
      doc.setTextColor(...COLORS.primary);
      doc.text(stage.value, pageWidth - margin - 20, yPosition + 6.5, { align: "right" });

      if (stage.pct !== null) {
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...COLORS.lightText);
        doc.setFontSize(7);
        doc.text(`${stage.pct.toFixed(0)}% dos projetos`, pageWidth - margin - 3, yPosition + 6.5, { align: "right" });
      }

      doc.setFont("helvetica", "normal");
      yPosition += 12;
    });

    yPosition += 5;
  };

  const drawFooter = () => {
    const now = new Date();
    const formattedDate = now.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    doc.setFillColor(...COLORS.secondary);
    doc.rect(0, pageHeight - 15, pageWidth, 15, "F");

    doc.setTextColor(...COLORS.white);
    doc.setFontSize(8);
    doc.text("Produto desenvolvido pela GlobalSys", margin, pageHeight - 6);
    doc.text(`Gerado em: ${formattedDate}`, pageWidth - margin, pageHeight - 6, { align: "right" });
  };

  // Generate PDF content
  drawHeader();
  drawKPICards();

  if (options.includeDetails) {
    drawOrganizationTable();
  }

  if (options.includeCharts) {
    drawDailyTrendTable();
  }

  if (options.includeHealth) {
    drawHealthMetrics();
  }

  if (options.includeTTV) {
    drawTimeToValue();
  }

  // Add footer to all pages
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawFooter();
  }

  // Download the PDF
  const timestamp = new Date().toISOString().split("T")[0];
  doc.save(`predictsys-analytics-${timestamp}.pdf`);
}
