/**
 * Intent-based Metrics Profiles
 * Maps declared_objective + industry + problem_type → primary/secondary metrics + calibration config
 */

export type ProblemFamily = "binary_classification" | "multiclass" | "regression" | "ranking" | "segmentation";

export interface MetricsProfile {
  id: string;
  label: string;
  /** Problem family this profile applies to */
  problem_family: ProblemFamily;
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
  /** All valid metrics for this family — UI must not display anything outside this set */
  valid_metrics: string[];
  /** Business explanation template */
  explanation: {
    good: string;
    weak: string;
    metric_meaning: string;
  };
}

/**
 * Returns the valid metric family for a given problem type.
 * Used to filter what the UI can display.
 */
export function getValidMetricsForProblemType(problemType: string): string[] {
  switch (normalizeProblemFamily(problemType)) {
    case "binary_classification":
      return ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"];
    case "multiclass":
      return ["macro_f1", "weighted_f1", "Acurácia", "macro_precision", "macro_recall"];
    case "regression":
      return ["MAE", "RMSE", "MSE", "R²", "MAPE"];
    case "ranking":
      return ["precision_at_5", "precision_at_10", "precision_at_20", "recall_at_10", "lift_at_10", "AUC", "pr_auc"];
    case "segmentation":
      return ["silhouette", "cluster_separation", "stability"];
    default:
      return ["AUC", "F1", "Recall", "Precisão", "Acurácia"];
  }
}

/**
 * Normalizes a problem_type string to a ProblemFamily
 */
export function normalizeProblemFamily(problemType?: string): ProblemFamily {
  const pt = (problemType || "").toLowerCase();
  if (pt === "regression") return "regression";
  if (pt === "multiclass" || pt === "multi_class") return "multiclass";
  if (pt === "ranking" || pt === "propensity") return "ranking";
  if (pt === "segmentation" || pt === "clustering") return "segmentation";
  return "binary_classification";
}

const PROFILES: Record<string, MetricsProfile> = {
  churn: {
    id: "churn",
    label: "Previsão de Churn",
    problem_family: "binary_classification",
    primary: "pr_auc",
    secondary: ["AUC", "F1", "Recall"],
    calibration: "brier",
    threshold_strategy: "max_recall_min_precision",
    min_precision: 0.3,
    valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"],
    explanation: {
      good: "O modelo identifica bem quem está prestes a sair, permitindo ações de retenção eficazes.",
      weak: "O modelo tem dificuldade em distinguir quem vai sair. As campanhas de retenção podem ser pouco efetivas.",
      metric_meaning: "PR-AUC mede a capacidade de encontrar os clientes em risco sem gerar muitos alarmes falsos.",
    },
  },
  conversao: {
    id: "conversao",
    label: "Previsão de Conversão",
    problem_family: "binary_classification",
    primary: "Precisão",
    secondary: ["AUC", "pr_auc", "F1"],
    calibration: "brier",
    threshold_strategy: "max_precision_at_k",
    min_precision: 0.5,
    valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"],
    explanation: {
      good: "O modelo prioriza leads com alta chance de converter, otimizando o investimento em vendas.",
      weak: "O modelo não consegue separar bem os leads que convertem. A taxa de acerto pode ser baixa.",
      metric_meaning: "Precisão mede quantos dos leads indicados realmente convertem.",
    },
  },
  receita: {
    id: "receita",
    label: "Previsão de Receita/Valor",
    problem_family: "regression",
    primary: "MAE",
    secondary: ["RMSE", "R²", "MAPE"],
    threshold_strategy: "none",
    valid_metrics: ["MAE", "RMSE", "MSE", "R²", "MAPE"],
    explanation: {
      good: "O modelo estima valores com boa precisão, permitindo projeções financeiras confiáveis.",
      weak: "As estimativas do modelo têm margem de erro alta. Use com cautela para decisões financeiras.",
      metric_meaning: "MAE (Erro Absoluto Médio) indica o quanto a previsão desvia do valor real, em média.",
    },
  },
  health: {
    id: "health",
    label: "Saúde / No-Show / Adesão",
    problem_family: "binary_classification",
    primary: "Recall",
    secondary: ["F1", "pr_auc", "AUC"],
    calibration: "brier",
    threshold_strategy: "max_recall",
    min_precision: 0.2,
    valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"],
    explanation: {
      good: "O modelo detecta a grande maioria dos casos de risco, minimizando falsos negativos.",
      weak: "O modelo deixa passar muitos casos de risco. Em saúde, isso pode ter consequências graves.",
      metric_meaning: "Recall mede a proporção de casos reais que o modelo detecta corretamente.",
    },
  },
  generic: {
    id: "generic",
    label: "Classificação Binária Genérica",
    problem_family: "binary_classification",
    primary: "AUC",
    secondary: ["F1", "Recall", "Precisão"],
    calibration: "brier",
    threshold_strategy: "max_f1",
    valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"],
    explanation: {
      good: "O modelo tem boa capacidade preditiva geral.",
      weak: "O modelo tem capacidade preditiva limitada. Considere revisar features ou dados.",
      metric_meaning: "AUC mede a capacidade geral do modelo de separar classes.",
    },
  },
  generic_multiclass: {
    id: "generic_multiclass",
    label: "Classificação Multiclasse",
    problem_family: "multiclass",
    primary: "macro_f1",
    secondary: ["weighted_f1", "Acurácia"],
    threshold_strategy: "none",
    valid_metrics: ["macro_f1", "weighted_f1", "Acurácia", "macro_precision", "macro_recall"],
    explanation: {
      good: "O modelo separa bem as múltiplas classes, com boa performance equilibrada.",
      weak: "O modelo confunde classes — revise a definição do target ou o balanceamento.",
      metric_meaning: "Macro F1 mede a média do F1 de cada classe, tratando todas igualmente.",
    },
  },
  generic_regression: {
    id: "generic_regression",
    label: "Regressão Genérica",
    problem_family: "regression",
    primary: "R²",
    secondary: ["MAE", "RMSE"],
    threshold_strategy: "none",
    valid_metrics: ["MAE", "RMSE", "MSE", "R²", "MAPE"],
    explanation: {
      good: "O modelo explica bem a variação dos dados e faz boas previsões numéricas.",
      weak: "O modelo explica pouca variação. As previsões podem ter margem de erro significativa.",
      metric_meaning: "R² indica quanto da variação real o modelo consegue explicar (0 a 1).",
    },
  },
  ranking: {
    id: "ranking",
    label: "Ranking / Propensão",
    problem_family: "ranking",
    primary: "lift_at_10",
    secondary: ["precision_at_10", "recall_at_10", "AUC"],
    threshold_strategy: "none",
    valid_metrics: ["precision_at_5", "precision_at_10", "precision_at_20", "recall_at_10", "lift_at_10", "AUC", "pr_auc"],
    explanation: {
      good: "O modelo ordena bem os itens/clientes, colocando os mais relevantes no topo.",
      weak: "O ranking gerado pelo modelo não é muito melhor que aleatório.",
      metric_meaning: "Lift@10% mede quantas vezes o modelo é melhor que o acaso nos top 10%.",
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
  const family = normalizeProblemFamily(problemType);

  // Match by objective keywords
  if (objective.includes("churn") || objective.includes("retenção") || objective.includes("cancelamento") || objective.includes("evasão")) {
    if (family === "binary_classification") return { profile: PROFILES.churn, source: "objective:churn" };
  }
  if (objective.includes("conversão") || objective.includes("conversion") || objective.includes("propensão") || objective.includes("lead")) {
    if (family === "binary_classification") return { profile: PROFILES.conversao, source: "objective:conversao" };
    if (family === "ranking") return { profile: PROFILES.ranking, source: "objective:ranking" };
  }
  if (objective.includes("receita") || objective.includes("revenue") || objective.includes("faturamento") || objective.includes("ticket") || objective.includes("ltv") || objective.includes("valor")) {
    if (family === "regression") return { profile: PROFILES.receita, source: "objective:receita" };
  }
  if (objective.includes("no-show") || objective.includes("no show") || objective.includes("adesão") || objective.includes("aderência") || objective.includes("falta")) {
    return { profile: PROFILES.health, source: "objective:health" };
  }
  if (objective.includes("ranking") || objective.includes("recomend")) {
    if (family === "ranking" || family === "binary_classification") return { profile: PROFILES.ranking, source: "objective:ranking" };
  }

  // Match by industry
  if (industry.includes("saúde") || industry.includes("saude") || industry.includes("health") || industry.includes("hospital")) {
    if (family === "binary_classification") return { profile: PROFILES.health, source: "industry:health" };
  }

  // Fallback by problem family
  if (family === "regression") return { profile: PROFILES.generic_regression, source: "fallback:regression" };
  if (family === "multiclass") return { profile: PROFILES.generic_multiclass, source: "fallback:multiclass" };
  if (family === "ranking") return { profile: PROFILES.ranking, source: "fallback:ranking" };

  return { profile: PROFILES.generic, source: "fallback:generic" };
}

export { PROFILES };
export default PROFILES;
