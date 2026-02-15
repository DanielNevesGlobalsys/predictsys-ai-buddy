/**
 * Business Translator — Translates model metrics into business narratives
 * 
 * Input: intent_base + domain_adapter + metrics_profile + dashboard_kpis
 * Output: { headline, whatItMeans, recommendedActions[] }
 */

import type { IndustryKey } from "@/types/intentContract";

export interface BusinessTranslation {
  headline: string;
  whatItMeans: string;
  recommendedActions: string[];
  confidenceLabel: string;
  confidenceColor: "green" | "yellow" | "red";
  operationalDisclaimer?: string;
  thresholdExplanation?: string;
}

interface TranslatorInput {
  industry: IndustryKey;
  declaredObjective: string;
  problemType: string;
  totalEntities: number;
  highRiskCount: number;
  expectedEvents: number;
  financialImpact: number;
  predictedTotalValue: number;
  coveragePct: number;
  confidenceScore: number | null;
  targetColumn?: string;
  recommendedThreshold?: number;
}

// ─── Industry + Objective Templates ───────────────────────────

interface NarrativeTemplate {
  headline: (input: TranslatorInput) => string;
  whatItMeans: (input: TranslatorInput) => string;
  actions: string[];
}

const TEMPLATES: Record<string, NarrativeTemplate> = {
  // Retail churn
  "retail:churn": {
    headline: (i) => `${i.highRiskCount} clientes em risco alto de churn`,
    whatItMeans: (i) =>
      `De ${i.totalEntities.toLocaleString("pt-BR")} clientes analisados, ${i.highRiskCount.toLocaleString("pt-BR")} ` +
      `apresentam alta probabilidade de cancelamento. Espera-se ${Math.round(i.expectedEvents)} eventos nos próximos dias.`,
    actions: [
      "Priorize contato direto com os clientes de maior risco",
      "Lance campanha de retenção segmentada para o grupo 60-80%",
      "Revise condições comerciais para os top 20% em risco",
    ],
  },

  // Retail conversion
  "retail:conversão": {
    headline: (i) => `${i.highRiskCount} leads com alta propensão de conversão`,
    whatItMeans: (i) =>
      `${i.highRiskCount.toLocaleString("pt-BR")} de ${i.totalEntities.toLocaleString("pt-BR")} leads ` +
      `têm probabilidade elevada de converter. Impacto financeiro estimado: R$ ${i.financialImpact.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}.`,
    actions: [
      "Direcione a equipe comercial para os leads de maior score",
      "Automatize nutrição para o segmento 40-60%",
      "Avalie ofertas personalizadas para os top leads",
    ],
  },

  // Health no-show
  "health:no_show": {
    headline: (i) => `${i.highRiskCount} pacientes com alta chance de falta`,
    whatItMeans: (i) =>
      `Dentre ${i.totalEntities.toLocaleString("pt-BR")} pacientes analisados, ${i.highRiskCount.toLocaleString("pt-BR")} ` +
      `têm alta probabilidade de não comparecer à consulta agendada.`,
    actions: [
      "Envie confirmação de consulta automatizada (SMS/WhatsApp)",
      "Ligue para os pacientes do grupo de maior risco",
      "Implemente política de overbooking para horários com alto no-show",
    ],
  },

  // Health treatment adherence
  "health:adesão": {
    headline: (i) => `${i.highRiskCount} pacientes em risco de abandono de tratamento`,
    whatItMeans: (i) =>
      `${i.highRiskCount.toLocaleString("pt-BR")} pacientes apresentam sinais de abandono do tratamento. ` +
      `Monitoramento proativo pode reduzir a taxa de evasão.`,
    actions: [
      "Agende retorno proativo para os pacientes em risco",
      "Ative programa de acompanhamento telefônico",
      "Revise protocolo de comunicação com pacientes crônicos",
    ],
  },

  // Finance default/inadimplência
  "finance:inadimplência": {
    headline: (i) => `${i.highRiskCount} clientes com risco elevado de inadimplência`,
    whatItMeans: (i) =>
      `De ${i.totalEntities.toLocaleString("pt-BR")} contas analisadas, ${i.highRiskCount.toLocaleString("pt-BR")} ` +
      `apresentam alta probabilidade de atraso. Impacto financeiro em risco: R$ ${i.financialImpact.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}.`,
    actions: [
      "Antecipe contato de cobrança preventiva",
      "Ofereça renegociação para clientes de risco moderado (40-60%)",
      "Revise limites de crédito para o grupo de maior risco",
    ],
  },

  // Education dropout
  "education:evasão": {
    headline: (i) => `${i.highRiskCount} alunos em risco de evasão`,
    whatItMeans: (i) =>
      `${i.highRiskCount.toLocaleString("pt-BR")} alunos apresentam indicadores de possível abandono. ` +
      `Intervenção precoce pode reverter esse cenário.`,
    actions: [
      "Acione tutoria para alunos com maior risco",
      "Ofereça flexibilização financeira para grupo vulnerável",
      "Implemente programa de mentoria para os alunos sinalizados",
    ],
  },
};

// ─── Objective Matcher ────────────────────────────────────────

function matchObjective(industry: IndustryKey, objective: string): string | null {
  const obj = objective.toLowerCase();
  const candidates: [string, string[]][] = [
    ["churn", ["churn", "cancelamento", "retenção", "evasão", "abandono"]],
    ["conversão", ["conversão", "conversion", "propensão", "lead"]],
    ["no_show", ["no-show", "no show", "falta", "absenteísmo"]],
    ["adesão", ["adesão", "aderência", "tratamento", "adherence"]],
    ["inadimplência", ["inadimplência", "default", "atraso", "cobrança"]],
    ["evasão", ["evasão", "dropout", "abandono"]],
    ["receita", ["receita", "revenue", "faturamento", "ticket", "ltv", "valor"]],
  ];

  for (const [key, keywords] of candidates) {
    if (keywords.some(kw => obj.includes(kw))) {
      return key;
    }
  }
  return null;
}

// ─── Confidence Label ─────────────────────────────────────────

function getConfidenceInfo(score: number | null): { label: string; color: "green" | "yellow" | "red" } {
  if (score === null) return { label: "Não calculado", color: "yellow" };
  if (score >= 70) return { label: "Alta confiança", color: "green" };
  if (score >= 40) return { label: "Confiança moderada", color: "yellow" };
  return { label: "Baixa confiança", color: "red" };
}

// ─── Health Compliance Disclaimer ──────────────────────────────

const HEALTH_DISCLAIMER = "⚕️ Uso operacional: Este resultado é suporte à operação (agendamento, confirmação, triagem), não diagnóstico clínico. Não substitui avaliação médica.";

function isHealthIndustry(industry: IndustryKey): boolean {
  return industry === "health";
}

// ─── Threshold Explanation ────────────────────────────────────

function buildThresholdExplanation(threshold: number, objective: string): string {
  const pct = (threshold * 100).toFixed(0);
  const context = objective.toLowerCase().includes("churn") || objective.toLowerCase().includes("cancelamento")
    ? "priorizando recall para capturar mais casos"
    : objective.toLowerCase().includes("conversão") || objective.toLowerCase().includes("lead")
    ? "balanceando precisão e recall"
    : "definido pelo modelo";
  return `Risco alto = probabilidade ≥ ${pct}% (${context})`;
}

// ─── Main Translator ──────────────────────────────────────────

export function translateToBusinessNarrative(input: TranslatorInput): BusinessTranslation {
  const objectiveKey = matchObjective(input.industry, input.declaredObjective);
  const templateKey = objectiveKey ? `${input.industry}:${objectiveKey}` : null;
  const template = templateKey ? TEMPLATES[templateKey] : null;

  const confidenceInfo = getConfidenceInfo(input.confidenceScore);
  const operationalDisclaimer = isHealthIndustry(input.industry) ? HEALTH_DISCLAIMER : undefined;
  const thresholdExplanation = input.recommendedThreshold != null
    ? buildThresholdExplanation(input.recommendedThreshold, input.declaredObjective)
    : undefined;

  if (template) {
    return {
      headline: template.headline(input),
      whatItMeans: template.whatItMeans(input),
      recommendedActions: template.actions,
      confidenceLabel: confidenceInfo.label,
      confidenceColor: confidenceInfo.color,
      operationalDisclaimer,
      thresholdExplanation,
    };
  }

  // Generic fallback
  const isRegression = input.problemType === "regression";

  if (isRegression) {
    return {
      headline: `Previsão para ${input.totalEntities.toLocaleString("pt-BR")} entidades`,
      whatItMeans:
        `O modelo prevê um valor total de R$ ${input.predictedTotalValue.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} ` +
        `para as ${input.totalEntities.toLocaleString("pt-BR")} entidades analisadas. ` +
        `Cobertura: ${input.coveragePct.toFixed(0)}%.`,
      recommendedActions: [
        "Analise os segmentos com maior valor previsto",
        "Compare projeções com dados históricos",
        "Use a simulação para testar cenários",
      ],
      confidenceLabel: confidenceInfo.label,
      confidenceColor: confidenceInfo.color,
      operationalDisclaimer,
      thresholdExplanation,
    };
  }

  return {
    headline: `${input.highRiskCount.toLocaleString("pt-BR")} entidades em alta probabilidade`,
    whatItMeans:
      `De ${input.totalEntities.toLocaleString("pt-BR")} entidades, ${input.highRiskCount.toLocaleString("pt-BR")} ` +
      `foram classificadas com alta probabilidade. ` +
      `Espera-se ${Math.round(input.expectedEvents)} eventos no horizonte analisado.`,
    recommendedActions: [
      "Priorize ação para o grupo de maior probabilidade",
      "Analise os segmentos para direcionar campanhas",
      "Acompanhe a evolução com execuções periódicas de scoring",
    ],
    confidenceLabel: confidenceInfo.label,
    confidenceColor: confidenceInfo.color,
    operationalDisclaimer,
    thresholdExplanation,
  };
}
