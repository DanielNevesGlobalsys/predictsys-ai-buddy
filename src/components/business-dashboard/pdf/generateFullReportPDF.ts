import jsPDF from 'jspdf';
import type {
  DashboardFilters,
  KPIData,
  SegmentationBand,
  GroupSegmentation,
  Prediction,
  TimeProjection,
} from '../types';
import type { SimulationParams, SimulationResults, BusinessConfig } from '../hooks/useSimulation';
import type { ProjectStage } from '../blocks/BlockATrustVision';

// ============================
// Types
// ============================

export interface FullReportData {
  // Project info
  projectName: string;
  organizationName: string;
  problemType: string;
  problemContext: string | null;
  modelName: string;
  projectStage: ProjectStage;

  // Filters
  filters: DashboardFilters;

  // Section 1 — Trust vision
  mainMetric: { name: string; value: number } | null;
  baselineMetric: { name: string; value: number } | null;
  scoreCoveragePct: number | null;
  totalEntities: number;
  executiveNarrative: string | null;

  // Section 2 — Analytical translation
  featureImportances: { feature_name: string; importance_value: number }[];
  modelMetrics: Record<string, number>;
  baselineMetrics: Record<string, number>;

  // Section 3 — Operational analysis
  kpis: KPIData;
  segmentationBands: SegmentationBand[];
  groupSegmentation: GroupSegmentation[];
  predictions: Prediction[];
  timeProjections: TimeProjection[];

  // Section 4 — Business impact (only if decisorio)
  displayKpis: KPIData;
  simulationParams: SimulationParams;
  simulationResults: SimulationResults;
  businessConfig: BusinessConfig;
  isSimulationActive: boolean;

  // Section 5 — AI Insights
  aiInsights: { type: string; content: string }[];

  // Section 6 — Audit
  audit: {
    totalRows: number | null;
    columnsCount: number | null;
    sampleRows: number | null;
    algorithmName: string | null;
    splitStrategy: string | null;
    sampleStrategy: string | null;
    trainRowsUsed: number | null;
    metrics: Record<string, number>;
    baselineMetrics: Record<string, number>;
    modelQualityFlag: string | null;
    predictionSanity: { passed?: boolean; reasons?: string[] } | null;
    preflightReport: { target_validity?: boolean; feature_validity?: boolean; leak_checks?: boolean } | null;
    featuresBlocked: string[];
    predictionsCount: number;
    scoreCoveragePct: number | null;
    batchId: string | null;
  };

  // Language
  locale: string;
}

// ============================
// Helpers
// ============================

const MARGIN = 20;
const LINE_HEIGHT = 6;
const PAGE_BOTTOM = 275;

function ensureSpace(doc: jsPDF, yPos: number, needed: number): number {
  if (yPos + needed > PAGE_BOTTOM) {
    doc.addPage();
    return 20;
  }
  return yPos;
}

function formatCurrency(val: number): string {
  if (val >= 1_000_000) return `R$ ${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `R$ ${(val / 1_000).toFixed(2)}K`;
  if (val < 0) return `-R$ ${Math.abs(val).toFixed(0)}`;
  return `R$ ${val.toFixed(0)}`;
}

function formatNumber(num: number): string {
  return num.toLocaleString('pt-BR');
}

function sectionTitle(doc: jsPDF, title: string, yPos: number): number {
  yPos = ensureSpace(doc, yPos, 20);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(title, MARGIN, yPos);
  yPos += 10;
  return yPos;
}

function subsectionTitle(doc: jsPDF, title: string, yPos: number): number {
  yPos = ensureSpace(doc, yPos, 14);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(title, MARGIN, yPos);
  yPos += 7;
  return yPos;
}

function bodyText(doc: jsPDF, text: string, yPos: number, maxWidth?: number): number {
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const width = maxWidth || (doc.internal.pageSize.width - MARGIN * 2);
  const lines = doc.splitTextToSize(text, width);
  for (const line of lines) {
    yPos = ensureSpace(doc, yPos, LINE_HEIGHT);
    doc.text(line, MARGIN, yPos);
    yPos += LINE_HEIGHT;
  }
  return yPos;
}

function bulletItem(doc: jsPDF, label: string, value: string, yPos: number): number {
  yPos = ensureSpace(doc, yPos, LINE_HEIGHT);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(`• ${label}: `, MARGIN, yPos);
  const labelWidth = doc.getTextWidth(`• ${label}: `);
  doc.setFont('helvetica', 'normal');
  doc.text(value, MARGIN + labelWidth, yPos);
  yPos += LINE_HEIGHT;
  return yPos;
}

function separator(doc: jsPDF, yPos: number): number {
  yPos = ensureSpace(doc, yPos, 8);
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, yPos, doc.internal.pageSize.width - MARGIN, yPos);
  yPos += 6;
  return yPos;
}

// ============================
// Stage labels
// ============================
const STAGE_LABELS: Record<ProjectStage, string> = {
  decisorio: 'Decisório',
  exploratorio: 'Exploratório',
  nao_confiavel: 'Não Confiável',
};

const STAGE_DESCRIPTIONS: Record<ProjectStage, string> = {
  decisorio: 'As previsões podem ser usadas para priorização, segmentação e cálculo de impacto financeiro com confiança razoável.',
  exploratorio: 'As previsões podem ser usadas para análise e aprendizado, mas NÃO devem ser base para decisões operacionais.',
  nao_confiavel: 'Este projeto NÃO é confiável para uso em decisões. O modelo não supera o baseline ou apresenta falhas de qualidade.',
};

// ============================
// Main generator
// ============================

export function generateFullReportPDF(data: FullReportData): void {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;
  let y = 20;

  const dateLocale = data.locale === 'en' ? 'en-US' : data.locale === 'es' ? 'es-ES' : 'pt-BR';
  const generatedAt = new Date().toLocaleString(dateLocale);

  // ========================================
  // 📌 CAPA
  // ========================================
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.text('PredictSys AI', MARGIN, y);
  y += 12;

  doc.setFontSize(16);
  doc.text('Relatório Completo do Dashboard de Negócio', MARGIN, y);
  y += 20;

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  y = bulletItem(doc, 'Projeto', data.projectName, y);
  y = bulletItem(doc, 'Organização', data.organizationName, y);
  y = bulletItem(doc, 'Tipo de Problema', data.problemType === 'classification' ? 'Classificação' : data.problemType === 'regression' ? 'Regressão' : data.problemType, y);
  if (data.problemContext) {
    y = bulletItem(doc, 'Contexto', data.problemContext, y);
  }
  y = bulletItem(doc, 'Modelo em Produção', data.modelName, y);
  y = bulletItem(doc, 'Horizonte', `${data.filters.horizon} dias`, y);
  y = bulletItem(doc, 'Visão', data.filters.viewMode === 'risk' ? 'Risco' : 'Oportunidade', y);
  y = bulletItem(doc, 'Status do Modelo', STAGE_LABELS[data.projectStage], y);
  y = bulletItem(doc, 'Gerado em', generatedAt, y);

  y += 10;
  y = bodyText(doc, STAGE_DESCRIPTIONS[data.projectStage], y);

  // ========================================
  // 📊 SEÇÃO 1 — VISÃO EXECUTIVA
  // ========================================
  doc.addPage();
  y = 20;

  y = sectionTitle(doc, '📊 SEÇÃO 1 — VISÃO EXECUTIVA DE CONFIANÇA', y);
  y += 2;

  // Main metric
  if (data.mainMetric) {
    const mVal = data.problemType === 'classification'
      ? `${(data.mainMetric.value * 100).toFixed(1)}%`
      : data.mainMetric.value.toFixed(3);
    y = bulletItem(doc, `Métrica principal (${data.mainMetric.name})`, mVal, y);
  } else {
    y = bulletItem(doc, 'Métrica principal', '— sem dados', y);
  }

  // Baseline
  if (data.baselineMetric) {
    const bVal = data.problemType === 'classification'
      ? `${(data.baselineMetric.value * 100).toFixed(1)}%`
      : data.baselineMetric.value.toFixed(3);
    y = bulletItem(doc, `Baseline (${data.baselineMetric.name})`, bVal, y);
  }

  // Coverage
  y = bulletItem(doc, 'Cobertura do Score', data.scoreCoveragePct !== null ? `${data.scoreCoveragePct.toFixed(1)}%` : '—', y);

  // Total entities
  y = bulletItem(doc, 'Total de Entidades Previstas', formatNumber(data.totalEntities), y);

  y += 5;

  // Executive narrative
  if (data.executiveNarrative) {
    y = subsectionTitle(doc, 'Narrativa Executiva — Lys', y);
    y = bodyText(doc, data.executiveNarrative, y);
  }

  // ========================================
  // 📈 SEÇÃO 2 — TRADUÇÃO ANALÍTICA → NEGÓCIO
  // ========================================
  y += 5;
  y = ensureSpace(doc, y, 30);
  y = sectionTitle(doc, '📈 SEÇÃO 2 — TRADUÇÃO ANALÍTICA → NEGÓCIO', y);

  // Feature importances
  if (data.featureImportances.length > 0) {
    y = subsectionTitle(doc, 'Variáveis mais influentes', y);
    const totalImp = data.featureImportances.reduce((s, f) => s + f.importance_value, 0);
    data.featureImportances.slice(0, 10).forEach((f, i) => {
      const pct = totalImp > 0 ? ((f.importance_value / totalImp) * 100).toFixed(1) : '0';
      y = ensureSpace(doc, y, LINE_HEIGHT);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(`${i + 1}. ${f.feature_name}: ${pct}%`, MARGIN + 5, y);
      y += LINE_HEIGHT;
    });
    y += 3;
  }

  // Model capability text
  if (Object.keys(data.modelMetrics).length > 0) {
    y = subsectionTitle(doc, 'O que o modelo consegue explicar', y);
    const isRegression = data.problemType === 'regression';
    if (isRegression) {
      const r2 = data.modelMetrics['r2'] ?? data.modelMetrics['R²'] ?? null;
      if (r2 !== null) {
        const explainsPct = Math.max(0, r2 * 100);
        y = bodyText(doc, `O modelo explica ${explainsPct.toFixed(0)}% da variação nos dados. ${(100 - explainsPct).toFixed(0)}% permanece inexplicada — fatores externos, dados faltantes ou complexidade não capturada.`, y);
      }
    } else {
      const auc = data.modelMetrics['auc'] ?? data.modelMetrics['AUC'] ?? null;
      if (auc !== null) {
        if (auc > 0.85) {
          y = bodyText(doc, `O modelo separa bem as classes (AUC = ${(auc * 100).toFixed(1)}%). A maioria dos padrões no dado é capturada. Casos próximos ao limiar de decisão podem ser menos precisos.`, y);
        } else {
          y = bodyText(doc, `O modelo consegue separar parcialmente as classes (AUC = ${(auc * 100).toFixed(1)}%). Parte significativa dos padrões não é capturada. Novos dados ou features podem melhorar a separação.`, y);
        }
      }
    }
    y += 3;
  }

  // Baseline comparison
  if (Object.keys(data.baselineMetrics).length > 0) {
    y = subsectionTitle(doc, 'Comparação com Baseline', y);
    Object.entries(data.baselineMetrics).forEach(([key, val]) => {
      const modelVal = data.modelMetrics[key];
      const improvement = modelVal !== undefined ? modelVal - val : null;
      const improvStr = improvement !== null ? ` (modelo: ${modelVal!.toFixed(4)}, delta: ${improvement > 0 ? '+' : ''}${improvement.toFixed(4)})` : '';
      y = bulletItem(doc, key, `baseline ${val.toFixed(4)}${improvStr}`, y);
    });
    y += 3;
  }

  // ========================================
  // 🧩 SEÇÃO 3 — ANÁLISES OPERACIONAIS
  // ========================================
  y = ensureSpace(doc, y, 30);
  y = sectionTitle(doc, '🧩 SEÇÃO 3 — ANÁLISES OPERACIONAIS', y);

  // Probability Segmentation
  if (data.segmentationBands.length > 0) {
    y = subsectionTitle(doc, 'Segmentação por Probabilidade', y);
    data.segmentationBands.forEach(band => {
      y = bulletItem(doc, band.range, `${formatNumber(band.count)} registros (${band.percent.toFixed(1)}%)`, y);
    });
    y += 3;
  }

  // Group Segmentation
  if (data.groupSegmentation.length > 0) {
    y = subsectionTitle(doc, 'Segmentação por Grupos', y);
    data.groupSegmentation.slice(0, 10).forEach(g => {
      const prob = g.avgProbability !== null ? `prob média: ${(g.avgProbability * 100).toFixed(1)}%` : '';
      const val = g.avgValue !== null ? `valor médio: ${formatCurrency(g.avgValue)}` : '';
      const info = [prob, val].filter(Boolean).join(', ');
      y = bulletItem(doc, g.group, `${formatNumber(g.count)} registros${info ? ` — ${info}` : ''}`, y);
    });
    y += 3;
  }

  // Priority List (top 20)
  const sortedPredictions = [...data.predictions]
    .filter(p => p.probability_event !== null || p.predicted_value !== null)
    .sort((a, b) => {
      if (data.problemType === 'regression') {
        return (b.predicted_value || 0) - (a.predicted_value || 0);
      }
      return (b.probability_event || 0) - (a.probability_event || 0);
    })
    .slice(0, 20);

  if (sortedPredictions.length > 0) {
    y = ensureSpace(doc, y, 30);
    y = subsectionTitle(doc, 'Lista de Ação Prioritária (Top 20)', y);

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('#', MARGIN, y);
    doc.text('Entidade', MARGIN + 8, y);
    if (data.problemType === 'classification') {
      doc.text('Probabilidade', MARGIN + 65, y);
    } else {
      doc.text('Valor Previsto', MARGIN + 65, y);
    }
    doc.text('Segmento', MARGIN + 100, y);
    doc.text('Valor Potencial', MARGIN + 140, y);
    y += 5;

    doc.setLineWidth(0.2);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    y += 3;

    doc.setFont('helvetica', 'normal');
    sortedPredictions.forEach((p, i) => {
      y = ensureSpace(doc, y, 5);
      doc.text(`${i + 1}`, MARGIN, y);
      doc.text(p.entity_id.substring(0, 22), MARGIN + 8, y);
      if (data.problemType === 'classification') {
        doc.text(`${((p.probability_event || 0) * 100).toFixed(1)}%`, MARGIN + 65, y);
      } else {
        doc.text(p.predicted_value ? formatCurrency(p.predicted_value) : '—', MARGIN + 65, y);
      }
      doc.text(p.segment || '—', MARGIN + 100, y);
      doc.text(p.potential_value ? formatCurrency(p.potential_value) : '—', MARGIN + 140, y);
      y += 5;
    });
    y += 5;
  }

  // ========================================
  // 💰 SEÇÃO 4 — IMPACTO DE NEGÓCIO
  // ========================================
  if (data.projectStage === 'decisorio') {
    y = ensureSpace(doc, y, 30);
    y = sectionTitle(doc, '💰 SEÇÃO 4 — IMPACTO DE NEGÓCIO', y);

    // Big Numbers
    y = subsectionTitle(doc, 'KPIs de Negócio', y);
    const dk = data.displayKpis;
    if (data.problemType === 'classification') {
      y = bulletItem(doc, 'Entidades com previsão', formatNumber(dk.totalEntities), y);
      y = bulletItem(doc, 'Alto risco/oportunidade', `${formatNumber(dk.highProbabilityCount)} (${dk.highProbabilityPercent.toFixed(1)}%)`, y);
      y = bulletItem(doc, 'Eventos esperados', formatNumber(dk.expectedEvents), y);
      y = bulletItem(doc, 'Impacto financeiro', formatCurrency(dk.financialImpact), y);
    } else {
      y = bulletItem(doc, 'Entidades com previsão', formatNumber(dk.totalEntities), y);
      y = bulletItem(doc, 'Valor total projetado', formatCurrency(dk.predictedTotalValue), y);
      y = bulletItem(doc, 'Valor médio previsto', formatCurrency(dk.predictedAvgValue), y);
      y = bulletItem(doc, 'Impacto financeiro estimado', formatCurrency(dk.financialImpact), y);
    }
    y += 3;

    // Simulation
    if (data.isSimulationActive) {
      y = subsectionTitle(doc, 'Simulação Ativa', y);
      if (data.problemType === 'classification') {
        y = bulletItem(doc, 'Threshold', `${(data.simulationParams.threshold * 100).toFixed(0)}%`, y);
        y = bulletItem(doc, '% Acionados', `${data.simulationParams.percentActioned}%`, y);
      } else {
        y = bulletItem(doc, 'Top %', `${data.simulationParams.topPercent}%`, y);
      }
      y = bulletItem(doc, 'Entidades a acionar', formatNumber(data.simulationResults.entitiesToAction), y);
      y = bulletItem(doc, 'Taxa de captura', `${data.simulationResults.captureRate.toFixed(1)}%`, y);
      y = bulletItem(doc, 'Custo total', formatCurrency(data.simulationResults.costTotal), y);
      y = bulletItem(doc, 'ROI líquido', formatCurrency(data.simulationResults.netROI), y);
      y += 3;
    }

    // Time Projection
    if (data.timeProjections.length > 0) {
      y = subsectionTitle(doc, 'Projeção Temporal', y);
      data.timeProjections.forEach(tp => {
        y = bulletItem(doc, tp.period, `${formatNumber(tp.expectedEvents)} eventos, impacto ${formatCurrency(tp.financialImpact)}`, y);
      });
      y += 3;
    }

    // Business config
    y = subsectionTitle(doc, 'Premissas Financeiras', y);
    y = bulletItem(doc, 'Ticket médio', `R$ ${data.businessConfig.average_sale_value}`, y);
    y = bulletItem(doc, 'Margem', `${data.businessConfig.average_margin_percent}%`, y);
    y = bulletItem(doc, 'Custo por contato', `R$ ${data.businessConfig.cost_per_contact}`, y);
    y = bulletItem(doc, 'Conversão baseline', `${data.businessConfig.baseline_conversion_percent}%`, y);
    y += 3;
  } else {
    // Exploratory note
    y = ensureSpace(doc, y, 30);
    y = sectionTitle(doc, '💰 SEÇÃO 4 — IMPACTO DE NEGÓCIO', y);
    y = bodyText(doc, `Esta seção está bloqueada pois o projeto está em estágio "${STAGE_LABELS[data.projectStage]}". Os dados financeiros e KPIs de impacto não são exibidos para evitar decisões baseadas em previsões de baixa confiança.`, y);
    y += 5;
  }

  // ========================================
  // 🤖 SEÇÃO 5 — INSIGHTS DE IA
  // ========================================
  y = ensureSpace(doc, y, 30);
  y = sectionTitle(doc, '🤖 SEÇÃO 5 — INSIGHTS DE IA', y);

  if (data.aiInsights.length > 0) {
    const typeLabels: Record<string, string> = {
      summary: 'Resumo',
      opportunities: 'Oportunidades',
      risks: 'Riscos',
      actions: 'Ações Recomendadas',
    };
    data.aiInsights.forEach(insight => {
      y = subsectionTitle(doc, typeLabels[insight.type] || insight.type, y);
      y = bodyText(doc, insight.content, y);
      y += 3;
    });
  } else {
    y = bodyText(doc, 'Nenhum insight de IA gerado para este projeto. Clique em "Gerar Insights" no dashboard para ativar a análise.', y);
    y += 3;
  }

  // ========================================
  // 🛡️ SEÇÃO 6 — AUDITORIA & GOVERNANÇA
  // ========================================
  doc.addPage();
  y = 20;
  y = sectionTitle(doc, '🛡️ SEÇÃO 6 — AUDITORIA & GOVERNANÇA', y);

  const a = data.audit;

  // Executive status
  y = subsectionTitle(doc, 'Status Executivo', y);
  y = bulletItem(doc, 'Estágio', STAGE_LABELS[data.projectStage], y);
  y = bulletItem(doc, 'Model Quality Flag', a.modelQualityFlag ?? '—', y);
  y = bulletItem(doc, 'Prediction Sanity', a.predictionSanity?.passed === true ? 'PASS' : a.predictionSanity?.passed === false ? 'FAIL' : '—', y);
  if (a.predictionSanity?.passed === false && a.predictionSanity?.reasons) {
    y = bodyText(doc, `Motivos: ${a.predictionSanity.reasons.join('; ')}`, y);
  }
  y += 3;

  // Dataset stats
  y = subsectionTitle(doc, 'Estatísticas do Dataset', y);
  y = bulletItem(doc, 'Total de linhas', a.totalRows !== null ? formatNumber(a.totalRows) : '—', y);
  y = bulletItem(doc, 'Colunas', a.columnsCount !== null ? String(a.columnsCount) : '—', y);
  y = bulletItem(doc, 'Amostra (EDA)', a.sampleRows !== null ? formatNumber(a.sampleRows) : '—', y);
  y = bulletItem(doc, 'Linhas no treino', a.trainRowsUsed !== null ? formatNumber(a.trainRowsUsed) : '—', y);
  y += 3;

  // Predictive engine
  y = subsectionTitle(doc, 'Motor Preditivo', y);
  y = bulletItem(doc, 'Algoritmo', a.algorithmName ?? '—', y);
  y = bulletItem(doc, 'Estratégia de split', a.splitStrategy ?? 'random', y);
  y = bulletItem(doc, 'Sampling', a.sampleStrategy ?? 'full', y);
  y += 3;

  // Model metrics
  if (Object.keys(a.metrics).length > 0) {
    y = subsectionTitle(doc, 'Métricas do Modelo Final', y);
    Object.entries(a.metrics).forEach(([k, v]) => {
      y = bulletItem(doc, k, typeof v === 'number' ? v.toFixed(4) : String(v), y);
    });
    y += 3;
  }

  // Baseline metrics
  if (Object.keys(a.baselineMetrics).length > 0) {
    y = subsectionTitle(doc, 'Métricas de Baseline', y);
    Object.entries(a.baselineMetrics).forEach(([k, v]) => {
      y = bulletItem(doc, k, typeof v === 'number' ? v.toFixed(4) : String(v), y);
    });
    y += 3;
  }

  // Validations
  y = subsectionTitle(doc, 'Validações Automáticas', y);
  if (a.preflightReport) {
    y = bulletItem(doc, 'Target validity', a.preflightReport.target_validity === true ? 'PASS' : a.preflightReport.target_validity === false ? 'FAIL' : '—', y);
    y = bulletItem(doc, 'Feature validity', a.preflightReport.feature_validity === true ? 'PASS' : a.preflightReport.feature_validity === false ? 'FAIL' : '—', y);
    y = bulletItem(doc, 'Leakage check', a.preflightReport.leak_checks === true ? 'PASS' : a.preflightReport.leak_checks === false ? 'WARN' : '—', y);
  }
  y += 2;

  // Blocked features
  if (a.featuresBlocked.length > 0) {
    y = subsectionTitle(doc, 'Features Bloqueadas', y);
    y = bodyText(doc, a.featuresBlocked.join(', '), y);
    y += 3;
  }

  // Score coverage
  y = subsectionTitle(doc, 'Cobertura do Scoring', y);
  y = bulletItem(doc, 'Previsões geradas', formatNumber(a.predictionsCount), y);
  y = bulletItem(doc, 'coverage_pct', a.scoreCoveragePct !== null ? `${a.scoreCoveragePct.toFixed(1)}%` : '—', y);
  y = bulletItem(doc, 'batch_id', a.batchId ?? '—', y);
  y += 3;

  // Multi-pass note
  y = subsectionTitle(doc, 'Observações de Multi-pass Scoring', y);
  y = bodyText(doc, 'O scoring é executado em passes de 40.000 linhas para evitar timeout de CPU. Cada pass insere previsões incrementalmente e o cálculo das métricas do dashboard agrega TODAS as previsões via paginação completa no banco, garantindo que os KPIs reflitam 100% do dataset.', y);

  // ========================================
  // FOOTER ON ALL PAGES
  // ========================================
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.text(
      'PredictSys AI — Relatório gerado automaticamente. Não substitui análise humana.',
      pageWidth / 2,
      doc.internal.pageSize.height - 10,
      { align: 'center' }
    );
    doc.text(
      `Página ${i} / ${pageCount}`,
      pageWidth - MARGIN,
      doc.internal.pageSize.height - 10,
      { align: 'right' }
    );
  }

  // Save
  const safeName = data.projectName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `relatorio_completo_predictsys_${safeName}_${dateStr}.pdf`;
  doc.save(fileName);
}
