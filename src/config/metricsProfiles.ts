/**
 * Intent-based Metrics Profiles
 * Maps declared_objective + industry → primary/secondary metrics + calibration config
 */

export interface MetricsProfile {
  id: string;
  label: string;
  /** Primary metric for champion selection */
  primary: string;
  /** Secondary metrics for comparison */
  secondary: string[];
  /** Calibration metric (classification only) */
  calibration?: string;
  /** Threshold optimization strategy */
  threshold_strategy: "max_recall_min_precision" | "max_precision_at_k" | "max_f1" | "max_recall" | "balanced" | "none";
  /** Min precision constraint for threshold search (classification) */
  min_precision?: number;
  /** Business explanation template */
  explanation: {
    good: string;
    weak: string;
    metric_meaning: string;
  };
}

const PROFILES: Record<string, MetricsProfile> = {
  churn: {
    id: "churn",
    label: "Previsão de Churn",
    primary: "pr_auc",
    secondary: ["AUC", "F1", "Recall"],
    calibration: "brier",
    threshold_strategy: "max_recall_min_precision",
    min_precision: 0.3,
    explanation: {
      good: "O modelo identifica bem quem está prestes a sair, permitindo ações de retenção eficazes.",
      weak: "O modelo tem dificuldade em distinguir quem vai sair. As campanhas de retenção podem ser pouco efetivas.",
      metric_meaning: "PR-AUC mede a capacidade de encontrar os clientes em risco sem gerar muitos alarmes falsos.",
    },
  },
  conversao: {
    id: "conversao",
    label: "Previsão de Conversão",
    primary: "Precisão",
    secondary: ["AUC", "pr_auc", "F1"],
    calibration: "brier",
    threshold_strategy: "max_precision_at_k",
    min_precision: 0.5,
    explanation: {
      good: "O modelo prioriza leads com alta chance de converter, otimizando o investimento em vendas.",
      weak: "O modelo não consegue separar bem os leads que convertem. A taxa de acerto pode ser baixa.",
      metric_meaning: "Precisão mede quantos dos leads indicados realmente convertem.",
    },
  },
  receita: {
    id: "receita",
    label: "Previsão de Receita/Valor",
    primary: "MAE",
    secondary: ["RMSE", "R²"],
    threshold_strategy: "none",
    explanation: {
      good: "O modelo estima valores com boa precisão, permitindo projeções financeiras confiáveis.",
      weak: "As estimativas do modelo têm margem de erro alta. Use com cautela para decisões financeiras.",
      metric_meaning: "MAE (Erro Absoluto Médio) indica o quanto a previsão desvia do valor real, em média.",
    },
  },
  health: {
    id: "health",
    label: "Saúde / No-Show / Adesão",
    primary: "Recall",
    secondary: ["F1", "pr_auc", "AUC"],
    calibration: "brier",
    threshold_strategy: "max_recall",
    min_precision: 0.2,
    explanation: {
      good: "O modelo detecta a grande maioria dos casos de risco, minimizando falsos negativos.",
      weak: "O modelo deixa passar muitos casos de risco. Em saúde, isso pode ter consequências graves.",
      metric_meaning: "Recall mede a proporção de casos reais que o modelo detecta corretamente.",
    },
  },
  generic: {
    id: "generic",
    label: "Genérico",
    primary: "AUC",
    secondary: ["F1", "Recall", "Precisão"],
    calibration: "brier",
    threshold_strategy: "max_f1",
    explanation: {
      good: "O modelo tem boa capacidade preditiva geral.",
      weak: "O modelo tem capacidade preditiva limitada. Considere revisar features ou dados.",
      metric_meaning: "AUC mede a capacidade geral do modelo de separar classes.",
    },
  },
  generic_regression: {
    id: "generic_regression",
    label: "Regressão Genérica",
    primary: "R²",
    secondary: ["MAE", "RMSE"],
    threshold_strategy: "none",
    explanation: {
      good: "O modelo explica bem a variação dos dados e faz boas previsões numéricas.",
      weak: "O modelo explica pouca variação. As previsões podem ter margem de erro significativa.",
      metric_meaning: "R² indica quanto da variação real o modelo consegue explicar (0 a 1).",
    },
  },
};

/**
 * Resolves the metrics profile from intent contract data
 */
export function resolveMetricsProfile(
  intentBase?: Record<string, unknown>,
  domainAdapter?: Record<string, unknown>,
  problemType?: string
): { profile: MetricsProfile; source: string } {
  const objective = String(intentBase?.declared_objective || "").toLowerCase();
  const industry = String(domainAdapter?.industry || "").toLowerCase();

  // Match by objective keywords
  if (objective.includes("churn") || objective.includes("retenção") || objective.includes("cancelamento") || objective.includes("evasão")) {
    return { profile: PROFILES.churn, source: "objective:churn" };
  }
  if (objective.includes("conversão") || objective.includes("conversion") || objective.includes("propensão") || objective.includes("lead")) {
    return { profile: PROFILES.conversao, source: "objective:conversao" };
  }
  if (objective.includes("receita") || objective.includes("revenue") || objective.includes("faturamento") || objective.includes("ticket") || objective.includes("ltv") || objective.includes("valor")) {
    if (problemType === "regression") return { profile: PROFILES.receita, source: "objective:receita" };
  }
  if (objective.includes("no-show") || objective.includes("no show") || objective.includes("adesão") || objective.includes("aderência") || objective.includes("falta")) {
    return { profile: PROFILES.health, source: "objective:health" };
  }

  // Match by industry
  if (industry.includes("saúde") || industry.includes("saude") || industry.includes("health") || industry.includes("hospital")) {
    return { profile: PROFILES.health, source: "industry:health" };
  }

  // Fallback by problem type
  if (problemType === "regression") {
    return { profile: PROFILES.generic_regression, source: "fallback:regression" };
  }

  return { profile: PROFILES.generic, source: "fallback:generic" };
}

export { PROFILES };
export default PROFILES;
