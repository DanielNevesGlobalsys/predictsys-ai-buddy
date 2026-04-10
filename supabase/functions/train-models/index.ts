// train-models v2.5.0 — uses compute_eda_ready RPC as SSOT
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parquetRead } from "npm:hyparquet@1.24.1";
import { applyFeatureTransforms, type ProjectFeature } from "../_shared/feature-engineering.ts";
import { evaluateTargetTrainability, trainabilityHumanMessage, evaluateTargetTrainabilityFromSSOT } from "../_shared/evaluate-target-trainability.ts";
import { resolveActiveTarget, buildHumanTargetStats, buildTrainabilityReport } from "../_shared/resolve-active-target.ts";
import { detectTargetType, validateTargetTypeMismatch, coerceToNumber, checkLowVariance, computeTargetStats, sampleRows as mvpSampleRows, samplePlan, validateSchemaSelection, filterInvalidFeatures } from "../_shared/training-prepare-mvp-soft.ts";
import { recoverAllStaleStates } from "../_shared/stale-state-recovery.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ==================== SAMPLING CONSTANTS ====================
// Minimum absolute rows required for reliable training
const MIN_ROWS_FOR_TRAIN = 500;
// Target sample size for train+val+test (healthy model size)
// IMPORTANT: Keep this low to avoid CPU Time exceeded in Edge Functions
const TARGET_SAMPLE_SIZE = 12_000;
// Maximum rows to read with early stop (for large datasets)
const MAX_ROWS_TO_READ = 40_000;
// Minimum samples per class to avoid warning
const MIN_CLASS_SAMPLES = 50;

// ==================== UTILITY FUNCTIONS ====================

/** Safe fire-and-forget for Supabase query builders (which are PromiseLike, not Promise — no .catch) */
function safeFire(query: PromiseLike<any>): void {
  Promise.resolve(query).catch((e) => console.warn("[safeFire] suppressed:", e));
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, val) => acc + Math.pow(val - m, 2), 0) / arr.length);
}

function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function normalize(data: number[][]): { normalized: number[][]; means: number[]; stds: number[] } {
  if (data.length === 0) return { normalized: [], means: [], stds: [] };
  const numFeatures = data[0].length;
  const means: number[] = [];
  const stds: number[] = [];
  
  for (let j = 0; j < numFeatures; j++) {
    const col = data.map(row => row[j]);
    means.push(mean(col));
    stds.push(std(col) || 1);
  }
  
  const normalized = data.map(row => row.map((val, j) => (val - means[j]) / stds[j]));
  return { normalized, means, stds };
}

// ==================== PREFLIGHT VALIDATION ====================

interface PreflightResult {
  target_valid: boolean;
  target_issues: string[];
  target_suggestions: string[];
  features_blocked: string[];
  features_block_reasons: Record<string, string>;
  warnings: string[];
}

/**
 * Validates the target column BEFORE training.
 * Checks: cardinality, sequential patterns, near-constant, null rate
 */
function validateTarget(
  yValues: number[],
  targetName: string,
  problemType: string,
  isTargetCategorical: boolean,
  labelMap: Map<string, number>
): { valid: boolean; issues: string[]; suggestions: string[] } {
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (yValues.length === 0) {
    return { valid: false, issues: ["Nenhum valor válido no target."], suggestions: ["Verifique a coluna alvo e o dataset."] };
  }

  const uniqueValues = new Set(yValues);
  const nUnique = uniqueValues.size;
  const nRows = yValues.length;
  const uniqueRatio = nUnique / nRows;

  // Null rate check (already filtered, but check original data proportion)
  // This is checked earlier in the pipeline

  if (problemType === "regression") {
    // A1: Cardinality check for regression
    if (nUnique <= 20) {
      issues.push(`Target "${targetName}" tem apenas ${nUnique} valores únicos — muito discreto para regressão.`);
      if (nUnique <= 10) {
        suggestions.push(`Considere converter para classificação (${nUnique} classes).`);
      }
    }

    if (uniqueRatio < 0.01 && nRows > 100) {
      issues.push(`Target "${targetName}" é quase constante (unique_ratio = ${(uniqueRatio * 100).toFixed(2)}%).`);
    }

    // Check for sequential/ID pattern
    const sorted = [...yValues].sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < Math.min(sorted.length, 1000); i++) {
      diffs.push(sorted[i] - sorted[i - 1]);
    }
    const constantDiff = diffs.length > 0 && diffs.every(d => d === diffs[0]) && diffs[0] > 0;
    if (constantDiff && nUnique > 100) {
      issues.push(`Target "${targetName}" parece ser um ID sequencial (incremento constante de ${diffs[0]}).`);
      suggestions.push("Selecione uma variável que represente um fenômeno de negócio, não um identificador.");
    }

    // Near-zero variance check
    const yMean = mean(yValues);
    const yStd = std(yValues);
    if (yStd < 1e-8) {
      issues.push(`Target "${targetName}" tem variância zero — todos os valores são iguais (${yMean}).`);
    } else if (yStd / Math.abs(yMean || 1) < 0.001) {
      issues.push(`Target "${targetName}" tem variância extremamente baixa (CV = ${(yStd / Math.abs(yMean || 1) * 100).toFixed(4)}%).`);
    }

    // Check for "coded categorical" — integers with few levels
    const allIntegers = yValues.every(v => Number.isInteger(v));
    if (allIntegers && nUnique >= 2 && nUnique <= 10) {
      issues.push(`Target "${targetName}" tem ${nUnique} valores inteiros distintos — pode ser categórico codificado.`);
      suggestions.push(`Considere converter para classificação (${nUnique} classes).`);
    }
  }

  if (problemType === "classification") {
    // Single class dominant check (>90%)
    const classCounts: Record<number, number> = {};
    yValues.forEach(v => { classCounts[v] = (classCounts[v] || 0) + 1; });
    const maxClassCount = Math.max(...Object.values(classCounts));
    const maxClassPct = maxClassCount / nRows;
    
    if (maxClassPct > 0.9) {
      issues.push(`Uma classe domina ${(maxClassPct * 100).toFixed(1)}% dos dados — desbalanceamento severo.`);
      suggestions.push("Considere técnicas de balanceamento ou reavalie a definição do target.");
    }

    if (nUnique === 1) {
      issues.push(`Target "${targetName}" tem cardinalidade 1 — classificação impossível.`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    suggestions
  };
}

/**
 * Validates features BEFORE training.
 * Blocks: IDs/keys, high cardinality categoricals, zero-variance, leakage suspects
 */
interface LeakageReport {
  blocked: string[];
  blockReasons: Record<string, string>;
  warnings: string[];
  suspects: { leakage: string[]; id_like: string[] };
  base_rate: number | null;
}

function validateFeatures(
  featureNames: string[],
  X: number[][],
  targetName: string,
  y: number[]
): LeakageReport {
  const blocked: string[] = [];
  const blockReasons: Record<string, string> = {};
  const warnings: string[] = [];
  const suspectsLeakage: string[] = [];
  const suspectsIdLike: string[] = [];

  const idPatterns = /^(id|_id|codigo|cod_|numero|num_|chave|key|uuid|pk|fk|idx|index)/i;
  const idSuffixPatterns = /(_id|_key|_code|_cod|_numero|_num|_uuid)$/i;

  // Churn-specific leakage patterns
  const churnLeakageTokens = [
    "status", "churn", "cancel", "inativ", "encerr", "dt_fim", "fim_previsto",
    "vencimento", "pago", "multa", "juros", "mora", "inadimpl", "rescis",
    "deslig", "saida", "obito", "alta", "resultado", "outcome", "target",
    "label", "y_true", "y_pred",
  ];
  const targetLower = targetName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Base rate for classification
  let baseRate: number | null = null;
  if (y.length > 0) {
    const positives = y.filter(v => v === 1).length;
    baseRate = positives / y.length;
  }

  for (let j = 0; j < featureNames.length; j++) {
    const name = featureNames[j];
    const nameLower = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let isBlocked = false;

    // 0. Exact target name match (should never be a feature)
    if (nameLower === targetLower) {
      blocked.push(name);
      blockReasons[name] = `Idêntica ao target "${targetName}".`;
      continue;
    }

    // 1. ID/Key pattern detection
    if (idPatterns.test(nameLower) || idSuffixPatterns.test(nameLower)) {
      const col = X.map(row => row[j]);
      const uniqueCount = new Set(col).size;
      const uniqueRatio = uniqueCount / col.length;
      
      if (uniqueRatio > 0.5) {
        blocked.push(name);
        blockReasons[name] = `ID/chave alta cardinalidade (${uniqueCount} únicos em ${col.length} linhas).`;
        suspectsIdLike.push(name);
        continue;
      } else if (uniqueRatio > 0.98) {
        suspectsIdLike.push(name);
        warnings.push(`Feature "${name}" quase-ID (${(uniqueRatio * 100).toFixed(0)}% únicos) — mantida com cautela.`);
      }
    }

    // 2. Zero/near-zero variance
    const col = X.map(row => row[j]);
    const colStd = std(col);
    if (colStd < 1e-10) {
      blocked.push(name);
      blockReasons[name] = `Variância zero — coluna constante.`;
      continue;
    }

    // 3. Churn-specific leakage: feature name contains leakage tokens
    for (const token of churnLeakageTokens) {
      if (nameLower.includes(token)) {
        suspectsLeakage.push(name);
        warnings.push(`Feature "${name}" contém token suspeito "${token}" — possível vazamento.`);
        break;
      }
    }

    // 4. Feature contains target name as substring
    if (nameLower.includes(targetLower) && nameLower !== targetLower) {
      suspectsLeakage.push(name);
      warnings.push(`Feature "${name}" contém o nome do target "${targetName}" — possível vazamento.`);
    }

    // 5. Extremely high correlation with target (leakage)
    if (y.length > 0 && y.length === col.length) {
      const yMean = mean(y);
      const colMean = mean(col);
      const yStd = std(y);
      
      if (yStd > 0 && colStd > 0) {
        let cov = 0;
        for (let i = 0; i < y.length; i++) {
          cov += (y[i] - yMean) * (col[i] - colMean);
        }
        cov /= y.length;
        const corr = Math.abs(cov / (yStd * colStd));
        
        if (corr > 0.98) {
          blocked.push(name);
          blockReasons[name] = `Correlação com target = ${corr.toFixed(4)} — vazamento de dados.`;
          suspectsLeakage.push(name);
          continue;
        } else if (corr > 0.9) {
          suspectsLeakage.push(name);
          warnings.push(`Feature "${name}" alta correlação com target (${corr.toFixed(3)}) — verifique vazamento.`);
        }
      }
    }

    // 6. High unique ratio (possible ID even without name match)
    {
      const uniqueCount = new Set(col).size;
      const uniqueRatio = uniqueCount / col.length;
      if (uniqueRatio > 0.98 && col.length > 100) {
        suspectsIdLike.push(name);
        warnings.push(`Feature "${name}" tem ${(uniqueRatio * 100).toFixed(0)}% valores únicos — possível ID.`);
      }
    }
  }

  return { blocked, blockReasons, warnings, suspects: { leakage: [...new Set(suspectsLeakage)], id_like: [...new Set(suspectsIdLike)] }, base_rate: baseRate };
}

// ==================== MODEL STRATEGY ====================

interface ModelStrategy {
  id: string;
  name: string;
  type: "classification" | "regression";
  algorithm: "logistic_regression" | "linear_regression" | "gradient_boosting" | "random_forest";
  params: {
    nEstimators?: number;
    maxDepth?: number;
    learningRate?: number;
    lambda?: number;
    epochs?: number;
  };
  reason: string;
}

/**
 * Selects the best model strategy based on dataset characteristics
 * This is the core AutoML heuristic for choosing a single model
 */
function selectBestModelStrategy(
  problemType: "classification" | "regression",
  nRows: number,
  nFeatures: number
): ModelStrategy {
  // CRITICAL: In Edge Functions, Gradient Boosting is too CPU-intensive
  // Only use it for VERY small datasets (< 3k rows)
  // For everything else, use linear models which are much faster
  const useGradientBoosting = nRows <= 3_000 && nFeatures <= 30;
  
  console.log(`[AutoML] Dataset: ${nRows} linhas, ${nFeatures} features`);
  console.log(`[AutoML] Usar Gradient Boosting: ${useGradientBoosting}`);

  if (problemType === "classification") {
    if (useGradientBoosting) {
      return {
        id: "gradient_boosting_classifier",
        name: "Gradient Boosting Classifier",
        type: "classification",
        algorithm: "gradient_boosting",
        params: {
          nEstimators: 8,
          maxDepth: 3,
          learningRate: 0.2,
        },
        reason: `Dataset pequeno (${nRows.toLocaleString()} linhas). Gradient Boosting com parâmetros ultra-conservadores.`,
      };
    } else {
      return {
        id: "logistic_regression",
        name: "Regressão Logística Regularizada",
        type: "classification",
        algorithm: "logistic_regression",
        params: {
          epochs: 100,
          lambda: 0.1,
        },
        reason: `Dataset de ${nRows.toLocaleString()} linhas. Regressão Logística é eficiente para Edge Functions e oferece probabilidades calibradas.`,
      };
    }
  } else {
    // Regression
    if (useGradientBoosting) {
      return {
        id: "gradient_boosting_regressor",
        name: "Gradient Boosting Regressor",
        type: "regression",
        algorithm: "gradient_boosting",
        params: {
          nEstimators: 8,
          maxDepth: 3,
          learningRate: 0.2,
        },
        reason: `Dataset pequeno (${nRows.toLocaleString()} linhas). Gradient Boosting com parâmetros ultra-conservadores.`,
      };
    } else {
      return {
        id: "linear_regression",
        name: "Regressão Linear Regularizada (Ridge)",
        type: "regression",
        algorithm: "linear_regression",
        params: {
          epochs: 100,
          lambda: 0.1,
        },
        reason: `Dataset de ${nRows.toLocaleString()} linhas. Regressão Linear é eficiente e interpretável para Edge Functions.`,
      };
    }
  }
}

// ==================== ALGORITHMS ====================

function trainLinearRegression(X: number[][], y: number[], lambda = 0.1): { weights: number[]; bias: number } {
  const n = X.length;
  const numFeatures = X[0]?.length || 0;
  const weights = new Array(numFeatures).fill(0);
  let bias = 0;
  const lr = 0.01;
  const epochs = 100;
  
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = 0; i < n; i++) {
      let pred = bias;
      for (let j = 0; j < numFeatures; j++) {
        pred += weights[j] * X[i][j];
      }
      const error = pred - y[i];
      bias -= lr * error / n;
      for (let j = 0; j < numFeatures; j++) {
        weights[j] -= lr * (error * X[i][j] / n + lambda * weights[j] / n);
      }
    }
  }
  
  return { weights, bias };
}

function trainLogisticRegression(X: number[][], y: number[], lambda = 0.1): { weights: number[]; bias: number } {
  const n = X.length;
  const numFeatures = X[0]?.length || 0;
  const weights = new Array(numFeatures).fill(0);
  let bias = 0;
  const lr = 0.1;
  const epochs = 100;
  
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < numFeatures; j++) {
        z += weights[j] * X[i][j];
      }
      const pred = sigmoid(z);
      const error = pred - y[i];
      bias -= lr * error / n;
      for (let j = 0; j < numFeatures; j++) {
        weights[j] -= lr * (error * X[i][j] / n + lambda * weights[j] / n);
      }
    }
  }
  
  return { weights, bias };
}

function predictLinear(X: number[][], weights: number[], bias: number): number[] {
  return X.map(row => {
    let pred = bias;
    for (let j = 0; j < weights.length; j++) {
      pred += weights[j] * row[j];
    }
    return pred;
  });
}

function predictLogistic(X: number[][], weights: number[], bias: number): number[] {
  return X.map(row => {
    let z = bias;
    for (let j = 0; j < weights.length; j++) {
      z += weights[j] * row[j];
    }
    return sigmoid(z);
  });
}

// Simple Decision Tree for Gradient Boosting — optimized for Edge Function CPU limits
function trainSimpleTree(X: number[][], y: number[], maxDepth = 3): any {
  function buildTree(indices: number[], depth: number): any {
    if (depth >= maxDepth || indices.length < 10) {
      let sum = 0;
      for (let k = 0; k < indices.length; k++) sum += y[indices[k]];
      return { isLeaf: true, value: sum / indices.length };
    }
    
    const numFeatures = X[0].length;
    let bestFeature = 0, bestThreshold = 0, bestScore = Infinity;
    
    // Sample features for faster training
    const featuresToCheck = Math.min(numFeatures, Math.max(3, Math.floor(Math.sqrt(numFeatures))));
    const featureIndices = shuffle(Array.from({ length: numFeatures }, (_, i) => i)).slice(0, featuresToCheck);
    
    // Use subset of indices for split search to save CPU
    const searchSize = Math.min(indices.length, 500);
    const searchIndices = indices.length <= searchSize ? indices : shuffle([...indices]).slice(0, searchSize);
    
    for (const f of featureIndices) {
      // Find median threshold from search sample
      const vals: number[] = [];
      for (let k = 0; k < searchIndices.length; k++) vals.push(X[searchIndices[k]][f]);
      vals.sort((a, b) => a - b);
      const threshold = vals[Math.floor(vals.length / 2)];
      
      let leftSum = 0, leftCount = 0, rightSum = 0, rightCount = 0;
      for (let k = 0; k < searchIndices.length; k++) {
        const idx = searchIndices[k];
        if (X[idx][f] <= threshold) { leftSum += y[idx]; leftCount++; }
        else { rightSum += y[idx]; rightCount++; }
      }
      
      if (leftCount === 0 || rightCount === 0) continue;
      
      const leftMean = leftSum / leftCount;
      const rightMean = rightSum / rightCount;
      
      // Compute MSE without creating arrays
      let score = 0;
      for (let k = 0; k < searchIndices.length; k++) {
        const idx = searchIndices[k];
        const m = X[idx][f] <= threshold ? leftMean : rightMean;
        const diff = y[idx] - m;
        score += diff * diff;
      }
      
      if (score < bestScore) {
        bestScore = score;
        bestFeature = f;
        bestThreshold = threshold;
      }
    }
    
    // Split on full indices using best feature/threshold
    const leftIdx: number[] = [];
    const rightIdx: number[] = [];
    for (let k = 0; k < indices.length; k++) {
      if (X[indices[k]][bestFeature] <= bestThreshold) leftIdx.push(indices[k]);
      else rightIdx.push(indices[k]);
    }
    
    if (leftIdx.length === 0 || rightIdx.length === 0) {
      let sum = 0;
      for (let k = 0; k < indices.length; k++) sum += y[indices[k]];
      return { isLeaf: true, value: sum / indices.length };
    }
    
    return {
      isLeaf: false,
      feature: bestFeature,
      threshold: bestThreshold,
      left: buildTree(leftIdx, depth + 1),
      right: buildTree(rightIdx, depth + 1)
    };
  }
  
  const allIdx: number[] = [];
  for (let i = 0; i < X.length; i++) allIdx.push(i);
  return buildTree(allIdx, 0);
}

function predictTree(tree: any, x: number[]): number {
  if (tree.isLeaf) return tree.value;
  return x[tree.feature] <= tree.threshold 
    ? predictTree(tree.left, x) 
    : predictTree(tree.right, x);
}

// Gradient Boosting - optimized for Edge Function limits
function trainGradientBoosting(
  X: number[][], 
  y: number[], 
  isClassification: boolean,
  nTrees: number,
  maxDepth: number,
  learningRate: number
): { trees: any[]; lr: number; base: number; isClassification: boolean } {
  // Subsample for faster training — keep low to avoid CPU timeout
  const maxSamples = Math.min(X.length, 2500);
  const sampleIndices = shuffle(Array.from({ length: X.length }, (_, i) => i)).slice(0, maxSamples);
  const Xs = sampleIndices.map(i => X[i]);
  const ys = sampleIndices.map(i => y[i]);
  
  const base = mean(ys);
  let residuals = ys.map(v => v - base);
  const trees: any[] = [];
  
  for (let t = 0; t < nTrees; t++) {
    const tree = trainSimpleTree(Xs, residuals, maxDepth);
    trees.push(tree);
    
    for (let i = 0; i < Xs.length; i++) {
      const pred = predictTree(tree, Xs[i]);
      residuals[i] -= learningRate * pred;
    }
  }
  
  return { trees, lr: learningRate, base, isClassification };
}

function predictGradientBoosting(
  model: { trees: any[]; lr: number; base: number; isClassification: boolean }, 
  X: number[][]
): number[] {
  return X.map(x => {
    let pred = model.base;
    for (const tree of model.trees) {
      pred += model.lr * predictTree(tree, x);
    }
    return model.isClassification ? sigmoid(pred) : pred;
  });
}

// ==================== METRICS PROFILES (Intent-based) ====================

interface MetricsProfileDef {
  id: string;
  primary: string;
  secondary: string[];
  calibration?: string;
  threshold_strategy: string;
  min_precision?: number;
  label: string;
  problem_family: string;
  valid_metrics: string[];
}

function resolveMetricsProfileEdge(
  intentBase: Record<string, any>,
  domainAdapter: Record<string, any>,
  problemType: string
): { profile: MetricsProfileDef; source: string } {
  const objective = String(intentBase?.declared_objective || "").toLowerCase();
  const industry = String(domainAdapter?.industry || "").toLowerCase();

  // Determine problem family
  const pt = problemType.toLowerCase();
  const isRegression = pt === "regression";
  const isMulticlass = pt === "multiclass" || pt === "multi_class";
  const isRanking = pt === "ranking" || pt === "propensity";

  // Classification-specific profiles
  if (!isRegression && !isMulticlass && !isRanking) {
    if (objective.includes("churn") || objective.includes("retenção") || objective.includes("cancelamento")) {
      return { profile: { id: "churn", primary: "pr_auc", secondary: ["AUC", "F1", "Recall"], calibration: "brier", threshold_strategy: "max_recall_min_precision", min_precision: 0.3, label: "Churn", problem_family: "binary_classification", valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"] }, source: "objective:churn" };
    }
    if (objective.includes("conversão") || objective.includes("conversion") || objective.includes("lead")) {
      return { profile: { id: "conversao", primary: "Precisão", secondary: ["AUC", "pr_auc"], calibration: "brier", threshold_strategy: "max_precision_at_k", min_precision: 0.5, label: "Conversão", problem_family: "binary_classification", valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"] }, source: "objective:conversao" };
    }
    if (objective.includes("no-show") || objective.includes("adesão") || objective.includes("falta")) {
      return { profile: { id: "health", primary: "Recall", secondary: ["F1", "pr_auc"], calibration: "brier", threshold_strategy: "max_recall", min_precision: 0.2, label: "Saúde", problem_family: "binary_classification", valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"] }, source: "objective:health" };
    }
    if (industry.includes("saúde") || industry.includes("health")) {
      return { profile: { id: "health", primary: "Recall", secondary: ["F1", "pr_auc"], calibration: "brier", threshold_strategy: "max_recall", min_precision: 0.2, label: "Saúde", problem_family: "binary_classification", valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"] }, source: "industry:health" };
    }
    // Generic binary classification
    return { profile: { id: "generic", primary: "AUC", secondary: ["F1", "Recall", "Precisão"], calibration: "brier", threshold_strategy: "max_f1", label: "Classificação Binária", problem_family: "binary_classification", valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"] }, source: "fallback:generic" };
  }

  // Regression profiles
  if (isRegression) {
    if (objective.includes("receita") || objective.includes("revenue") || objective.includes("valor") || objective.includes("ticket") || objective.includes("ltv")) {
      return { profile: { id: "receita", primary: "MAE", secondary: ["RMSE", "R²", "MAPE"], threshold_strategy: "none", label: "Receita", problem_family: "regression", valid_metrics: ["MAE", "RMSE", "MSE", "R²", "MAPE"] }, source: "objective:receita" };
    }
    return { profile: { id: "generic_regression", primary: "R²", secondary: ["MAE", "RMSE"], threshold_strategy: "none", label: "Regressão", problem_family: "regression", valid_metrics: ["MAE", "RMSE", "MSE", "R²", "MAPE"] }, source: "fallback:regression" };
  }

  // Multiclass
  if (isMulticlass) {
    return { profile: { id: "generic_multiclass", primary: "macro_f1", secondary: ["weighted_f1", "Acurácia"], threshold_strategy: "none", label: "Multiclasse", problem_family: "multiclass", valid_metrics: ["macro_f1", "weighted_f1", "Acurácia", "macro_precision", "macro_recall"] }, source: "fallback:multiclass" };
  }

  // Ranking
  if (isRanking) {
    return { profile: { id: "ranking", primary: "lift_at_10", secondary: ["precision_at_10", "recall_at_10"], threshold_strategy: "none", label: "Ranking", problem_family: "ranking", valid_metrics: ["precision_at_5", "precision_at_10", "precision_at_20", "recall_at_10", "lift_at_10", "AUC", "pr_auc"] }, source: "fallback:ranking" };
  }

  return { profile: { id: "generic", primary: "AUC", secondary: ["F1", "Recall", "Precisão"], calibration: "brier", threshold_strategy: "max_f1", label: "Classificação Binária", problem_family: "binary_classification", valid_metrics: ["AUC", "pr_auc", "F1", "Recall", "Precisão", "Acurácia", "brier"] }, source: "fallback:generic" };
}

// ==================== PR-AUC ====================

function calcPRAUC(yTrue: number[], yProb: number[]): number {
  const sorted = yTrue.map((t, i) => ({ t, p: yProb[i] })).sort((a, b) => b.p - a.p);
  const totalPos = yTrue.filter(y => y === 1).length;
  if (totalPos === 0) return 0;
  let tp = 0, area = 0, prevRecall = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].t === 1) tp++;
    const precision = tp / (i + 1);
    const recall = tp / totalPos;
    if (sorted[i].t === 1) {
      area += precision * (recall - prevRecall);
      prevRecall = recall;
    }
  }
  return area;
}

// ==================== BRIER SCORE ====================

function calcBrierScore(yTrue: number[], yProb: number[]): number {
  let sum = 0;
  for (let i = 0; i < yTrue.length; i++) {
    sum += Math.pow(yProb[i] - yTrue[i], 2);
  }
  return sum / yTrue.length;
}

// ==================== PLATT CALIBRATION ====================

function plattCalibrate(yTrue: number[], yProb: number[]): { a: number; b: number; method: string } {
  // Fit logistic regression: calibrated_p = sigmoid(a * raw_p + b)
  let a = 1.0, b = 0.0;
  const lr = 0.1, epochs = 200, n = yTrue.length;
  for (let ep = 0; ep < epochs; ep++) {
    let gradA = 0, gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = a * yProb[i] + b;
      const p = sigmoid(z);
      const err = p - yTrue[i];
      gradA += err * yProb[i];
      gradB += err;
    }
    a -= lr * gradA / n;
    b -= lr * gradB / n;
  }
  return { a, b, method: "platt" };
}

function applyPlattCalibration(probs: number[], a: number, b: number): number[] {
  return probs.map(p => sigmoid(a * p + b));
}

// ==================== OPTIMAL THRESHOLD ====================

function findOptimalThreshold(
  yTrue: number[],
  yProb: number[],
  strategy: string,
  minPrecision = 0.3
): number {
  const thresholds = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
  let bestThreshold = 0.5, bestScore = -Infinity;

  for (const t of thresholds) {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < yTrue.length; i++) {
      const pred = yProb[i] >= t ? 1 : 0;
      if (yTrue[i] === 1 && pred === 1) tp++;
      else if (yTrue[i] === 0 && pred === 1) fp++;
      else if (yTrue[i] === 1 && pred === 0) fn++;
    }
    const precision = tp / (tp + fp) || 0;
    const recall = tp / (tp + fn) || 0;
    const f1 = 2 * precision * recall / (precision + recall) || 0;

    let score = -Infinity;
    switch (strategy) {
      case "max_recall_min_precision":
        score = precision >= minPrecision ? recall : -1;
        break;
      case "max_precision_at_k":
        score = recall >= 0.1 ? precision : -1;
        break;
      case "max_recall":
        score = precision >= minPrecision ? recall : -1;
        break;
      case "max_f1":
        score = f1;
        break;
      case "balanced":
        score = f1;
        break;
      default:
        score = f1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestThreshold = t;
    }
  }

  return bestThreshold;
}

// ==================== METRICS ====================

interface MetricsResult {
  raw: Record<string, number>;
  clamped: Record<string, number>;
  valid: boolean;
  invalid_reasons: string[];
}

function calcClassificationMetricsDetailed(yTrue: number[], yProb: number[]): MetricsResult {
  const yPred = yProb.map(p => p >= 0.5 ? 1 : 0);
  let tp = 0, tn = 0, fp = 0, fn = 0;
  
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] === 1 && yPred[i] === 1) tp++;
    else if (yTrue[i] === 0 && yPred[i] === 0) tn++;
    else if (yTrue[i] === 0 && yPred[i] === 1) fp++;
    else fn++;
  }
  
  const accuracy_raw = (tp + tn) / (tp + tn + fp + fn) || 0;
  const precision_raw = tp / (tp + fp) || 0;
  const recall_raw = tp / (tp + fn) || 0;
  const f1_raw = 2 * precision_raw * recall_raw / (precision_raw + recall_raw) || 0;
  
  // AUC calculation — proper tie-aware Wilcoxon-Mann-Whitney
  const totalPos = yTrue.filter(y => y === 1).length;
  const totalNeg = yTrue.filter(y => y === 0).length;
  let auc_raw = 0.5;
  
  if (totalPos > 0 && totalNeg > 0) {
    // Use pairwise comparison with proper tie handling
    let concordant = 0;
    let tied = 0;
    // For efficiency, sort by probability descending and count
    const sortedPairs = yTrue.map((t, i) => ({ t, p: yProb[i] }))
      .sort((a, b) => b.p - a.p);
    let negCumul = 0;
    let tiedCumul = 0;
    
    for (let i = sortedPairs.length - 1; i >= 0; i--) {
      if (sortedPairs[i].t === 0) {
        negCumul++;
        // Count ties at same probability
        let tiesAtP = 0;
        for (let j = i - 1; j >= 0 && sortedPairs[j].p === sortedPairs[i].p; j--) {
          if (sortedPairs[j].t === 1) tiesAtP++;
        }
        tiedCumul += tiesAtP;
      } else {
        // positive: all negatives with lower prob are concordant
        concordant += negCumul;
        tied += tiedCumul;
        tiedCumul = 0;
      }
    }
    
    // AUC = (concordant + 0.5 * tied) / (totalPos * totalNeg)
    auc_raw = (concordant + 0.5 * tied) / (totalPos * totalNeg);
    
    // Clamp to [0, 1] — AUC mathematically cannot exceed 1.0
    // If it does, there's a numerical error
    if (auc_raw > 1.0 || auc_raw < 0.0) {
      console.error(`[METRICS] AUC out of range: ${auc_raw.toFixed(6)} — clamping and flagging as invalid`);
      auc_raw = Math.min(1.0, Math.max(0.0, auc_raw));
    }
  }

  // PR-AUC
  const pr_auc_raw = calcPRAUC(yTrue, yProb);

  const raw: Record<string, number> = { AUC: auc_raw, F1: f1_raw, Recall: recall_raw, Precisão: precision_raw, Acurácia: accuracy_raw, pr_auc: pr_auc_raw };

  // ── Hard validation: metrics_invalid_hard_fail ──
  const invalid_reasons: string[] = [];
  
  // Check for degenerate predictions (only one class predicted)
  const predictedClasses = new Set(yPred);
  if (predictedClasses.size === 1) {
    invalid_reasons.push(`metrics_degenerate_predictions: apenas classe ${[...predictedClasses][0]} prevista`);
  }
  
  // Check probability collapse (no dispersion)
  if (yProb.length > 10) {
    const sorted = [...yProb].sort((a, b) => a - b);
    const p05 = sorted[Math.floor(yProb.length * 0.05)];
    const p95 = sorted[Math.floor(yProb.length * 0.95)];
    if (p95 - p05 < 0.01) {
      invalid_reasons.push(`metrics_probability_collapse: p95−p05=${(p95 - p05).toFixed(6)} (<0.01)`);
    }
  }
  
  // Validate each metric is in valid range
  for (const [k, v] of Object.entries(raw)) {
    if (!isFinite(v)) invalid_reasons.push(`${k} = ${v} (not finite)`);
    else if (v < -0.001) invalid_reasons.push(`${k} = ${v.toFixed(4)} (negative)`);
    else if (v > 1.001) invalid_reasons.push(`metrics_invalid_hard_fail: ${k} = ${v.toFixed(4)} (> 1.0)`);
  }

  const clamped: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    clamped[k] = Math.min(1, Math.max(0, isFinite(v) ? v : 0));
  }

  return { raw, clamped, valid: invalid_reasons.length === 0, invalid_reasons };
}

function calcRegressionMetricsDetailed(yTrue: number[], yPred: number[]): MetricsResult {
  const n = yTrue.length;
  let sumSquaredError = 0, sumAbsError = 0;
  const yMean = mean(yTrue);
  let ssTot = 0, ssRes = 0;
  let sumAbsPctError = 0;
  let mapeCount = 0;
  
  for (let i = 0; i < n; i++) {
    const error = yTrue[i] - yPred[i];
    sumAbsError += Math.abs(error);
    sumSquaredError += error * error;
    ssTot += Math.pow(yTrue[i] - yMean, 2);
    ssRes += error * error;
    // MAPE — skip zeros to avoid division by zero
    if (Math.abs(yTrue[i]) > 1e-10) {
      sumAbsPctError += Math.abs(error / yTrue[i]);
      mapeCount++;
    }
  }
  
  const mae = sumAbsError / n;
  const mse = sumSquaredError / n;
  const rmse = Math.sqrt(mse);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const mape = mapeCount > 0 ? (sumAbsPctError / mapeCount) * 100 : 0; // as percentage

  const raw: Record<string, number> = { MAE: mae, MSE: mse, RMSE: rmse, "R²": r2, MAPE: mape };

  const invalid_reasons: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!isFinite(v)) invalid_reasons.push(`${k} = ${v} (not finite)`);
  }

  const clamped = { ...raw };

  return { raw, clamped, valid: invalid_reasons.length === 0, invalid_reasons };
}

// Legacy wrappers used by trainSingleModel
function calcClassificationMetrics(yTrue: number[], yProb: number[]): Record<string, number> {
  return calcClassificationMetricsDetailed(yTrue, yProb).clamped;
}

function calcRegressionMetrics(yTrue: number[], yPred: number[]): Record<string, number> {
  return calcRegressionMetricsDetailed(yTrue, yPred).clamped;
}

// ==================== EXTENDED METRICS (Precision@K, Recall@K, Lift@K) ====================

function calcPrecisionAtK(yTrue: number[], yProb: number[], kPercent: number): number {
  const n = yTrue.length;
  const k = Math.max(1, Math.ceil((kPercent / 100) * n));
  const sorted = yTrue.map((t, i) => ({ t, p: yProb[i] })).sort((a, b) => b.p - a.p);
  const topK = sorted.slice(0, k);
  const tp = topK.filter(x => x.t === 1).length;
  return tp / k;
}

function calcRecallAtK(yTrue: number[], yProb: number[], kPercent: number): number {
  const n = yTrue.length;
  const k = Math.max(1, Math.ceil((kPercent / 100) * n));
  const totalPos = yTrue.filter(y => y === 1).length;
  if (totalPos === 0) return 0;
  const sorted = yTrue.map((t, i) => ({ t, p: yProb[i] })).sort((a, b) => b.p - a.p);
  const topK = sorted.slice(0, k);
  const tp = topK.filter(x => x.t === 1).length;
  return tp / totalPos;
}

function calcLiftAtK(yTrue: number[], yProb: number[], kPercent: number): number {
  const baseRate = yTrue.filter(y => y === 1).length / yTrue.length;
  if (baseRate === 0) return 0;
  const precAtK = calcPrecisionAtK(yTrue, yProb, kPercent);
  return precAtK / baseRate;
}

function calcConfusionMatrixAtThreshold(yTrue: number[], yProb: number[], threshold: number): { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; f1: number } {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const pred = yProb[i] >= threshold ? 1 : 0;
    if (yTrue[i] === 1 && pred === 1) tp++;
    else if (yTrue[i] === 0 && pred === 1) fp++;
    else if (yTrue[i] === 1 && pred === 0) fn++;
    else tn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

function calcThresholdCurve(yTrue: number[], yProb: number[], nPoints = 50): { threshold: number; precision: number; recall: number; f1: number; tp: number; fp: number }[] {
  const curve: { threshold: number; precision: number; recall: number; f1: number; tp: number; fp: number }[] = [];
  for (let i = 1; i <= nPoints; i++) {
    const t = i / (nPoints + 1);
    const cm = calcConfusionMatrixAtThreshold(yTrue, yProb, t);
    curve.push({ threshold: Math.round(t * 1000) / 1000, precision: cm.precision, recall: cm.recall, f1: cm.f1, tp: cm.tp, fp: cm.fp });
  }
  return curve;
}

interface ExtendedClassificationMetrics {
  base_rate: number;
  precision_at_5: number;
  precision_at_10: number;
  precision_at_20: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_at_20: number;
  lift_at_10: number;
  confusion_matrix: { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; f1: number };
  threshold_curve: { threshold: number; precision: number; recall: number; f1: number; tp: number; fp: number }[];
  chosen_threshold: number;
  threshold_method: string;
}

function calcFeatureImportance(weights: number[], featureNames: string[]): { feature_name: string; importance_value: number }[] {
  const totalWeight = weights.reduce((a, b) => a + Math.abs(b), 0) || 1;
  return featureNames.map((name, i) => ({
    feature_name: name,
    importance_value: Math.abs(weights[i]) / totalWeight
  }));
}

function calcTreeFeatureImportance(trees: any[], featureNames: string[]): { feature_name: string; importance_value: number }[] {
  const counts: Record<number, number> = {};
  
  function countSplits(node: any) {
    if (node.isLeaf) return;
    counts[node.feature] = (counts[node.feature] || 0) + 1;
    countSplits(node.left);
    countSplits(node.right);
  }
  
  for (const tree of trees) {
    countSplits(tree);
  }
  
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  
  return featureNames.map((name, i) => ({
    feature_name: name,
    importance_value: (counts[i] || 0) / total
  }));
}

// ==================== SMART SPLIT DETECTION ====================

interface SplitResult {
  trainIdx: number[];
  testIdx: number[];
  strategy: string;
  datetime_col: string | null;
  group_key: string | null;
  train_count: number;
  test_count: number;
}

/**
 * Detects datetime columns by name heuristic + parse test on sample
 */
function detectDatetimeColumn(headers: string[], sampleRows: Record<string, any>[] | string[][], isParquet: boolean): string | null {
  const datePatterns = /^(data|dt_|date|timestamp|created|updated|dataneg|data_neg|dt$|_date$|_dt$|_data$)/i;
  const candidates = headers.filter(h => datePatterns.test(h.toLowerCase()));
  
  if (candidates.length === 0) return null;
  
  for (const col of candidates) {
    let parseCount = 0;
    const sampleSize = Math.min(sampleRows.length, 2000);
    
    for (let i = 0; i < sampleSize; i++) {
      let val: any;
      if (isParquet) {
        val = (sampleRows[i] as Record<string, any>)[col];
      } else {
        // For CSV, we'd need header index — skip this path for now
        continue;
      }
      if (val === null || val === undefined) continue;
      const str = String(val);
      const parsed = new Date(str);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1900) {
        parseCount++;
      }
    }
    
    const parseRate = sampleSize > 0 ? parseCount / sampleSize : 0;
    if (parseRate >= 0.9) {
      console.log(`[Split] Datetime column detected: "${col}" (parse rate: ${(parseRate * 100).toFixed(1)}%)`);
      return col;
    }
  }
  return null;
}

/**
 * Detects CSV datetime column using header names + value parsing
 */
function detectDatetimeColumnCSV(headers: string[], lines: string[], delimiter: string): { col: string; idx: number } | null {
  const datePatterns = /^(data|dt_|date|timestamp|created|updated|dataneg|data_neg|dt$|_date$|_dt$|_data$)/i;
  const candidates: { col: string; idx: number }[] = [];
  
  for (let i = 0; i < headers.length; i++) {
    if (datePatterns.test(headers[i].toLowerCase())) {
      candidates.push({ col: headers[i], idx: i });
    }
  }
  
  if (candidates.length === 0) return null;
  
  for (const cand of candidates) {
    let parseCount = 0;
    const sampleSize = Math.min(lines.length, 2000);
    
    for (let i = 0; i < sampleSize; i++) {
      const values = parseCSVLine(lines[i], delimiter);
      const val = values[cand.idx];
      if (!val) continue;
      const parsed = new Date(val);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1900) {
        parseCount++;
      }
    }
    
    const parseRate = sampleSize > 0 ? parseCount / sampleSize : 0;
    if (parseRate >= 0.9) {
      console.log(`[Split] CSV Datetime column detected: "${cand.col}" (parse rate: ${(parseRate * 100).toFixed(1)}%)`);
      return cand;
    }
  }
  return null;
}

/**
 * Detects entity/group column for GroupSplit
 */
function detectGroupKeyColumn(headers: string[], uniqueCounts: Map<string, number>, totalRows: number): string | null {
  const groupPatterns = /^(cliente|cnpj|cpf|codparc|cod_parc|entity|customer|client|account|empresa|company|numerounico|numero_unico)/i;
  
  for (const h of headers) {
    if (groupPatterns.test(h.toLowerCase())) {
      const nUnique = uniqueCounts.get(h) || 0;
      const uniqueRatio = totalRows > 0 ? nUnique / totalRows : 0;
      
      if (uniqueRatio >= 0.05 && uniqueRatio <= 0.8) {
        console.log(`[Split] Group key detected: "${h}" (unique_ratio: ${(uniqueRatio * 100).toFixed(1)}%)`);
        return h;
      }
    }
  }
  return null;
}

/**
 * Performs smart split based on detected strategy
 */
function performSmartSplit(
  n: number,
  datetimeValues: (number | null)[] | null,
  groupValues: (string | null)[] | null,
  y: number[],
  isClassification: boolean
): SplitResult {
  const trainRatio = 0.8;
  
  // 1. Temporal split
  if (datetimeValues) {
    const validIndices = datetimeValues
      .map((v, i) => ({ v, i }))
      .filter(x => x.v !== null)
      .sort((a, b) => a.v! - b.v!);
    
    if (validIndices.length >= 100) {
      const splitPoint = Math.floor(validIndices.length * trainRatio);
      const trainIdx = validIndices.slice(0, splitPoint).map(x => x.i);
      const testIdx = validIndices.slice(splitPoint).map(x => x.i);
      
      console.log(`[Split] Temporal split: train=${trainIdx.length}, test=${testIdx.length}`);
      return {
        trainIdx, testIdx,
        strategy: "temporal",
        datetime_col: "detected",
        group_key: null,
        train_count: trainIdx.length,
        test_count: testIdx.length,
      };
    }
  }
  
  // 2. Group split
  if (groupValues) {
    const groups = new Map<string, number[]>();
    groupValues.forEach((g, i) => {
      const key = g || "__null__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(i);
    });
    
    const uniqueGroups = shuffle([...groups.keys()]);
    const splitPoint = Math.floor(uniqueGroups.length * trainRatio);
    const trainGroups = new Set(uniqueGroups.slice(0, splitPoint));
    
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    
    groups.forEach((indices, group) => {
      if (trainGroups.has(group)) {
        trainIdx.push(...indices);
      } else {
        testIdx.push(...indices);
      }
    });
    
    console.log(`[Split] Group split: ${uniqueGroups.length} groups, train=${trainIdx.length}, test=${testIdx.length}`);
    return {
      trainIdx: shuffle(trainIdx),
      testIdx: shuffle(testIdx),
      strategy: "group",
      datetime_col: null,
      group_key: "detected",
      train_count: trainIdx.length,
      test_count: testIdx.length,
    };
  }
  
  // 3. Random split (stratified for classification)
  if (isClassification) {
    const classBuckets = new Map<number, number[]>();
    y.forEach((v, i) => {
      if (!classBuckets.has(v)) classBuckets.set(v, []);
      classBuckets.get(v)!.push(i);
    });
    
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    
    classBuckets.forEach(indices => {
      const shuffled = shuffle(indices);
      const split = Math.floor(shuffled.length * trainRatio);
      trainIdx.push(...shuffled.slice(0, split));
      testIdx.push(...shuffled.slice(split));
    });
    
    console.log(`[Split] Stratified random split: train=${trainIdx.length}, test=${testIdx.length}`);
    return {
      trainIdx: shuffle(trainIdx),
      testIdx: shuffle(testIdx),
      strategy: "stratified_random",
      datetime_col: null,
      group_key: null,
      train_count: trainIdx.length,
      test_count: testIdx.length,
    };
  }
  
  // 4. Pure random for regression
  const allIdx = shuffle(Array.from({ length: n }, (_, i) => i));
  const splitPoint = Math.floor(n * trainRatio);
  
  console.log(`[Split] Random split: train=${splitPoint}, test=${n - splitPoint}`);
  return {
    trainIdx: allIdx.slice(0, splitPoint),
    testIdx: allIdx.slice(splitPoint),
    strategy: "random",
    datetime_col: null,
    group_key: null,
    train_count: splitPoint,
    test_count: n - splitPoint,
  };
}

// ==================== PREDICTION SANITY CHECK ====================

interface PredictionSanity {
  pred_std: number;
  pred_mean: number;
  pred_min: number;
  pred_max: number;
  pred_range: number;
  unique_ratio_pred: number;
  pct_equal_mode_pred: number;
  y_range: number | null;
  range_ratio: number | null;
  passed: boolean;
  fail_reasons: string[];
}

function checkPredictionSanity(predictions: number[], yTrue?: number[], isClassification?: boolean): PredictionSanity {
  const n = predictions.length;
  const predMean = mean(predictions);
  const predStd = std(predictions);
  const predMin = Math.min(...predictions);
  const predMax = Math.max(...predictions);
  const predRange = predMax - predMin;
  
  const uniquePreds = new Set(predictions.map(p => Math.round(p * 10000) / 10000));
  const uniqueRatio = uniquePreds.size / n;
  
  // Mode detection
  const counts = new Map<string, number>();
  predictions.forEach(p => {
    const key = (Math.round(p * 1000) / 1000).toString();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const maxCount = Math.max(...counts.values());
  const pctEqualMode = maxCount / n;
  
  let yRange: number | null = null;
  let rangeRatio: number | null = null;
  
  if (yTrue && yTrue.length > 0) {
    const yMin = Math.min(...yTrue);
    const yMax = Math.max(...yTrue);
    yRange = yMax - yMin;
    rangeRatio = yRange > 0 ? predRange / yRange : null;
  }
  
  const failReasons: string[] = [];
  
  if (pctEqualMode > 0.95) {
    failReasons.push(`${(pctEqualMode * 100).toFixed(1)}% das previsões são idênticas — modelo degenerado.`);
  }
  
  if (predStd < 1e-8) {
    failReasons.push(`Desvio padrão das previsões ~ 0 — previsões constantes.`);
  }
  
  if (rangeRatio !== null && rangeRatio < 0.01) {
    failReasons.push(`Range das previsões é <1% do range real — modelo colapsou para média.`);
  }
  
  if (uniqueRatio < 0.005 && n > 100) {
    failReasons.push(`Apenas ${uniquePreds.size} valores únicos em ${n} previsões.`);
  }

  // Classification-specific: probability collapse (p95 - p05 < 0.02)
  if (isClassification && n > 20) {
    const sorted = [...predictions].sort((a, b) => a - b);
    const p05 = sorted[Math.floor(n * 0.05)];
    const p95 = sorted[Math.floor(n * 0.95)];
    const probSpread = p95 - p05;
    if (probSpread < 0.02) {
      failReasons.push(`Colapso de probabilidade: p95−p05 = ${probSpread.toFixed(4)} (<0.02) — modelo não discrimina classes.`);
    }

    // Only 1 predicted class
    const predictedClasses = new Set(predictions.map(p => p >= 0.5 ? 1 : 0));
    if (predictedClasses.size === 1) {
      const onlyClass = [...predictedClasses][0];
      failReasons.push(`Apenas classe ${onlyClass} prevista — modelo ignora a outra classe.`);
    }
  }

  // Regression-specific: very low variance + no improvement (checked externally but flag here)
  if (!isClassification && yTrue && yTrue.length > 0) {
    const yStd = std(yTrue);
    if (yStd > 0 && predStd / yStd < 0.01) {
      failReasons.push(`Variância das previsões é <1% da variância real — modelo colapsou.`);
    }
  }
  
  return {
    pred_std: predStd,
    pred_mean: predMean,
    pred_min: predMin,
    pred_max: predMax,
    pred_range: predRange,
    unique_ratio_pred: uniqueRatio,
    pct_equal_mode_pred: pctEqualMode,
    y_range: yRange,
    range_ratio: rangeRatio,
    passed: failReasons.length === 0,
    fail_reasons: failReasons,
  };
}

// ==================== SINGLE MODEL TRAINING ====================

interface TrainResult {
  model: any;
  predictions: number[];
  metrics: Record<string, number>;
  featureImportances: { feature_name: string; importance_value: number }[];
  sanity: PredictionSanity;
}

function trainSingleModel(
  strategy: ModelStrategy,
  Xtrain: number[][],
  ytrain: number[],
  Xtest: number[][],
  ytest: number[],
  featureNames: string[]
): TrainResult {
  console.log(`[AutoML] Treinando modelo: ${strategy.name}`);
  console.log(`[AutoML] Algoritmo: ${strategy.algorithm}, Params:`, strategy.params);
  
  const isClassification = strategy.type === "classification";
  let model: any;
  let predictions: number[];
  let featureImportances: { feature_name: string; importance_value: number }[];
  
  switch (strategy.algorithm) {
    case "logistic_regression":
      model = trainLogisticRegression(Xtrain, ytrain, strategy.params.lambda || 0.1);
      predictions = predictLogistic(Xtest, model.weights, model.bias);
      featureImportances = calcFeatureImportance(model.weights, featureNames);
      break;
      
    case "linear_regression":
      model = trainLinearRegression(Xtrain, ytrain, strategy.params.lambda || 0.1);
      predictions = predictLinear(Xtest, model.weights, model.bias);
      featureImportances = calcFeatureImportance(model.weights, featureNames);
      break;
      
    case "gradient_boosting":
      model = trainGradientBoosting(
        Xtrain, 
        ytrain, 
        isClassification,
        strategy.params.nEstimators || 50,
        strategy.params.maxDepth || 6,
        strategy.params.learningRate || 0.1
      );
      predictions = predictGradientBoosting(model, Xtest);
      featureImportances = calcTreeFeatureImportance(model.trees, featureNames);
      break;
      
    case "random_forest":
      model = trainGradientBoosting(
        Xtrain, 
        ytrain, 
        isClassification,
        strategy.params.nEstimators || 50,
        strategy.params.maxDepth || 6,
        0.3
      );
      predictions = predictGradientBoosting(model, Xtest);
      featureImportances = calcTreeFeatureImportance(model.trees, featureNames);
      break;
      
    default:
      throw new Error(`Algoritmo não suportado: ${strategy.algorithm}`);
  }
  
  const metrics = isClassification
    ? calcClassificationMetrics(ytest, predictions)
    : calcRegressionMetrics(ytest, predictions);
  
  const sanity = checkPredictionSanity(predictions, isClassification ? undefined : ytest, isClassification);
  
  console.log(`[AutoML] Métricas:`, metrics);
  console.log(`[AutoML] Sanity: passed=${sanity.passed}, pred_std=${sanity.pred_std.toFixed(6)}, pct_mode=${(sanity.pct_equal_mode_pred * 100).toFixed(1)}%`);
  
  return { model, predictions, metrics, featureImportances, sanity };
}

// ==================== CSV PARSING ====================

/** Auto-detect CSV delimiter from a header line */
function autoDetectDelimiter(headerLine: string): string {
  const candidates = [";", ",", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  console.log(`[AutoML] Auto-detected delimiter: "${best === "\t" ? "\\t" : best}" (${bestCount} columns)`);
  return best;
}

/** Case-insensitive header index search */
function findHeaderIndex(headers: string[], target: string): number {
  // Exact match first
  const exact = headers.indexOf(target);
  if (exact !== -1) return exact;
  // Case-insensitive match
  const lower = target.toLowerCase().trim();
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].toLowerCase().trim() === lower) return i;
  }
  return -1;
}

function parseCSVLine(line: string, delim: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delim && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ""));
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ""));
  return result;
}

// ==================== PARQUET READING ====================

function isParquetFile(path: string, metadata?: Record<string, any>): boolean {
  if (metadata?.file_type === "parquet") return true;
  const lower = path.toLowerCase();
  return lower.endsWith(".parquet") || lower.endsWith(".parq") || lower.endsWith(".pq");
}

interface ParquetReadResult {
  headers: string[];
  rows: Record<string, any>[];
}

async function readParquetFromStorage(
  supabase: any,
  filePaths: string[],
  maxRows: number
): Promise<ParquetReadResult> {
  const allRows: Record<string, any>[] = [];
  let headers: string[] = [];

  for (const filePath of filePaths) {
    if (allRows.length >= maxRows) break;

    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("datasets")
      .createSignedUrl(filePath, 3600);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error(`Erro ao criar URL assinada para ${filePath}:`, signedUrlError);
      continue;
    }

    const response = await fetch(signedUrlData.signedUrl);
    if (!response.ok) {
      console.error(`Erro ao baixar ${filePath}: HTTP ${response.status}`);
      continue;
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log(`  Parquet baixado: ${(arrayBuffer.byteLength / (1024 * 1024)).toFixed(2)} MB`);

    await parquetRead({
      file: arrayBuffer,
      rowFormat: 'object',
      onComplete: (data: Record<string, unknown>[]) => {
        if (!data || data.length === 0) return;

        // Extract headers from first row keys
        if (headers.length === 0 && data.length > 0) {
          headers = Object.keys(data[0]);
          console.log(`  Parquet headers: ${headers.slice(0, 5).join(", ")}... (${headers.length} total)`);
        }

        for (const row of data) {
          if (allRows.length >= maxRows) break;
          allRows.push(row);
        }
      },
    });

    console.log(`  Arquivo processado: ${allRows.length.toLocaleString()} linhas acumuladas`);
  }

  return { headers, rows: allRows };
}

// ==================== MAIN HANDLER ====================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Parse body early and store for crash handler access
  let _parsedBody: any = {};
  try {
    _parsedBody = await req.json();
  } catch { _parsedBody = {}; }
  const { project_id } = _parsedBody;

  try {
    
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startMs = Date.now();
    const run_id = crypto.randomUUID();
    console.log(`\n========================================`);
    console.log(`[AutoML] Iniciando treinamento para projeto: ${project_id}`);
    console.log(`[AutoML] run_id: ${run_id}`);
    console.log(`========================================\n`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── Auto-recovery: check for stale states ──
    try {
      const recoveries = await recoverAllStaleStates(supabase, project_id);
      if (recoveries.length > 0) {
        console.log(`[AutoML] Recovered ${recoveries.length} stale state(s): ${recoveries.map(r => r.stage).join(", ")}`);
      }
    } catch (_) { /* best-effort */ }

    // ── SSOT: Mark training as running + persist run_id ──
    try {
      await supabase.rpc("rpc_set_pipeline_state", {
        p_project_id: project_id,
        p_stage: "training",
        p_state: "running",
        p_meta: { run_id },
      });
      await supabase.from("project_settings")
        .update({ active_run_id: run_id })
        .eq("project_id", project_id);
    } catch (_) { /* best-effort */ }

    // ── Log training_run_started ──
    safeFire(supabase.from("platform_events").insert({
      event_type: "training_run_started",
      project_id: project_id,
      status: "info",
      source: "edge",
      metadata: { run_id },
    }));

    // Helper to return structured block response (HTTP 200 per reliability standards)
    const blockResponse = (code: string, message: string, cta: { label: string; go_to_step?: number } | null, details?: Record<string, unknown>) => {
      console.error(`[Gating] BLOCKED: ${code} — ${message}`);
      // Fire-and-forget: log training_run_blocked + set pipeline state
      safeFire(supabase.from("platform_events").insert({
        event_type: "training_run_blocked",
        project_id: project_id,
        status: "error",
        source: "edge",
        metadata: { run_id, code, message },
      }));
      safeFire(supabase.rpc("rpc_set_pipeline_state", {
        p_project_id: project_id,
        p_stage: "training",
        p_state: "failed",
        p_meta: { run_id, blocked_code: code },
      }));
      return new Response(JSON.stringify({
        success: false,
        status: "blocked",
        code,
        message_user: message,
        message_tech: `Training blocked by gate: ${code}`,
        cta,
        details: details || {},
        error: message,
        action: cta ? "navigate" : "review_target",
        fix_suggestions: [
          ...(cta ? [{ label: cta.label, action: cta.go_to_step ? `open_step_${cta.go_to_step}` : "review_target" }] : []),
          { label: "Ver diagnóstico", action: "open_diagnostics" },
        ],
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    };

    // ==================== SSOT GATING (Etapa 4.2) ====================
    console.log(`\n=== Training Gating (SSOT) ===`);

    // Parallel fetch all SSOT sources
    const [projectRes, dsStateRes, selectionRes, modelingDatasetRes, contractRes, splitPolicyRes, aiCtxRes] = await Promise.all([
      supabase.from("projects").select("*").eq("id", project_id).single(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("*").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_split_policies").select("*").eq("project_id", project_id).eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
    ]);

    const project = projectRes.data;
    if (!project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const dsState = dsStateRes.data as any;
    const selection = selectionRes.data as any;
    const modelingDataset = modelingDatasetRes.data as any;
    const modelingContract = contractRes.data as any;
    const trainAiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const classBalanceMethod = trainAiCtx.class_balance?.method || "none";

    // ── Gate 1: Dataset + EDA (via compute_eda_ready SSOT RPC) ──
    const { data: edaResult, error: edaRpcErr } = await supabase.rpc("compute_eda_ready", { p_project_id: project_id });
    const edaReady = edaResult?.eda_ready === true;
    const edaReasons: string[] = edaResult?.reasons || [];
    const edaEvidence = edaResult?.evidence || {};
    const datasetRows = edaEvidence.rows_len || 0;
    const datasetCols = edaEvidence.cols_len || 0;

    console.log(`[Gating] compute_eda_ready: ready=${edaReady}, reasons=${JSON.stringify(edaReasons)}, evidence=${JSON.stringify(edaEvidence)}`);

    if (edaRpcErr) {
      console.error(`[Gating] compute_eda_ready RPC error:`, edaRpcErr);
      // On RPC failure, fall through permissively (don't block training due to RPC issue)
    } else if (!edaEvidence.has_active_dataset || datasetRows === 0) {
      return blockResponse("NO_ACTIVE_DATASET", "Nenhum dataset ativo. Importe dados na Etapa 2.", { label: "Importar dados", go_to_step: 2 }, { reasons: edaReasons, evidence: edaEvidence });
    } else if (!edaReady) {
      return blockResponse("EDA_NOT_READY", `EDA não está pronto: ${edaReasons.join(", ")}. Execute o EDA na Etapa 2.`, { label: "Voltar à Etapa 2", go_to_step: 2 }, { reasons: edaReasons, evidence: edaEvidence });
    }

    // ── Gate 2: Selection (SSOT — project_model_selection) ──
    let target_column: string;
    let problem_type: string;
    let currentSelectionVersion = 0;
    let currentTargetHash: string | null = null;

    if (selection && selection.target_column) {
      target_column = selection.target_column;
      problem_type = selection.problem_type || project.problem_type || "classification";
      currentSelectionVersion = selection.selection_version || 0;
      currentTargetHash = selection.target_hash || null;
      console.log(`[Gating] Selection SSOT: target="${target_column}", v${currentSelectionVersion}, hash=${currentTargetHash}`);
    } else if (project.target_column) {
      // Legacy fallback
      target_column = project.target_column;
      problem_type = project.problem_type || "classification";
      console.warn(`[Gating] Using legacy project.target_column (no selection record)`);
    } else {
      return blockResponse("NO_TARGET_SELECTED", "Nenhum target selecionado. Volte à Etapa 3.", { label: "Selecionar target", go_to_step: 3 });
    }

    // ── ACTIVE TARGET RESOLUTION (SSOT) ──
    // Load active_target fields from project_settings
    const { data: activeTargetSettings } = await supabase
      .from("project_settings")
      .select("active_target_mode, active_target_column, active_target_ref, target_source, problem_type, entity_key, time_anchor_column, recommended_time_column, recommended_split_strategy, recommended_grain, dataset_build_mode, official_target, official_problem_type, official_entity_key, official_time_column, governance_conflict")
      .eq("project_id", project_id)
      .maybeSingle();

    // ── Gate 2: Entity Key validation ──
    const entityKey = (activeTargetSettings as any)?.entity_key || null;
    if (!entityKey) {
      console.error(`[Gating] MISSING_ENTITY_KEY for project ${project_id}`);
      await supabase.from("platform_events").insert({
        event_type: "entity_key_missing",
        project_id: project_id,
        status: "error",
        source: "edge",
        metadata: {
          dataset_id: dsState?.active_dataset_ref || null,
          schema_source: dsState?.active_schema_json ? "active_schema_json" : "unknown",
          schema_cols_count: dsState?.active_schema_json ? Object.keys(dsState.active_schema_json).filter((k: string) => !k.startsWith("_")).length : 0,
        },
      });
      return blockResponse("MISSING_ENTITY_KEY", "Selecione a chave da entidade (Entity Key) antes de treinar.", { label: "Definir Entity Key", go_to_step: 3 });
    }

    // Validate entity_key exists in schema
    {
      let schemaCols: string[] = [];
      if (dsState?.active_schema_json && typeof dsState.active_schema_json === "object") {
        schemaCols = Object.keys(dsState.active_schema_json).filter((k: string) => !k.startsWith("_"));
      }
      if (schemaCols.length > 0) {
        const schemaLower = new Set(schemaCols.map((c: string) => c.toLowerCase()));
        if (!schemaLower.has(entityKey.toLowerCase())) {
          console.error(`[Gating] INVALID_ENTITY_KEY: "${entityKey}" not in schema (${schemaCols.length} cols)`);
          await supabase.from("platform_events").insert({
            event_type: "entity_key_invalid",
            project_id: project_id,
            status: "error",
            source: "edge",
            metadata: {
              entity_key: entityKey,
              schema_cols_count: schemaCols.length,
              first_20_cols: schemaCols.slice(0, 20),
            },
          });
          return blockResponse("INVALID_ENTITY_KEY", `Entity Key "${entityKey}" não existe no schema consolidado (${schemaCols.length} colunas).`, { label: "Corrigir Entity Key", go_to_step: 3 });
        }
      }
      console.log(`[Gating] Entity Key OK: "${entityKey}"`);
      await supabase.from("platform_events").insert({
        event_type: "entity_key_validated",
        project_id: project_id,
        status: "success",
        source: "edge",
        metadata: { entity_key: entityKey },
      });
    }
    
    const activeTarget = resolveActiveTarget((activeTargetSettings as any) || {});
    let useHumanLabelsAsTarget = false;
    let humanTargetStats: Awaited<ReturnType<typeof buildHumanTargetStats>> | null = null;
    
    if (activeTarget.mode === "human") {
      console.log(`[Gating] ⚡ Active target mode = HUMAN. Ignoring target_column="${target_column}" and template.`);
      
      // Use the SAME shared function as preflight for exact parity
      const ssotReport = await evaluateTargetTrainabilityFromSSOT({
        supabase,
        projectId: project_id,
        activeTargetMode: "human",
        targetColumn: null,
        problemType: (activeTargetSettings as any)?.problem_type || "classification",
        projectSettings: (activeTargetSettings as any) || {},
      });
      
      // Persist report to SSOT
      await supabase.from("project_settings")
        .update({ target_trainability_report: ssotReport })
        .eq("project_id", project_id);

      if (!ssotReport.trainable) {
        console.error(`[Gating] ⛔ Human target blocked: ${ssotReport.reason_code}`);
        
        // Cascade pipeline state
        await supabase.rpc("rpc_update_pipeline_state", {
          p_project_id: project_id, p_stage: "training", p_new_state: "failed",
        });
        await Promise.all([
          supabase.rpc("rpc_update_pipeline_state", { p_project_id: project_id, p_stage: "scoring", p_new_state: "idle" }),
          supabase.rpc("rpc_update_pipeline_state", { p_project_id: project_id, p_stage: "dashboard", p_new_state: "idle" }),
        ]);
        
        return new Response(JSON.stringify({
          success: false,
          error: ssotReport.message_user,
          error_code: "TARGET_NOT_TRAINABLE",
          reason_code: ssotReport.reason_code,
          details: ssotReport.details,
          fix_suggestions: ssotReport.fix_suggestions,
          action: "review_target",
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      // Still need humanTargetStats for the actual y vector during training
      humanTargetStats = await buildHumanTargetStats(supabase, project_id);
      useHumanLabelsAsTarget = true;
      console.log(`[Gating] Human target OK: ${ssotReport.details.join_rows} labels, ${ssotReport.details.pos}+ / ${ssotReport.details.neg}−`);
    }

    // ── Normalize virtual target: "label" → "_label_" when label builder is active ──
    if (!useHumanLabelsAsTarget && target_column === "label" && modelingDataset?.label_plan) {
      console.log(`[Gating] Normalizing target_column "label" → "_label_" (label builder active)`);
      target_column = "_label_";
    }

    // ── Gate 2.5: Schema SSOT Validation ──
    // Validate that target/features exist in the consolidated schema
    {
      let schemaColumns: string[] = [];
      let schemaSource = "unknown";

      // Priority 1: active_schema_json from project_dataset_state
      if (dsState?.active_schema_json && typeof dsState.active_schema_json === "object") {
        schemaColumns = Object.keys(dsState.active_schema_json).filter(k => !k.startsWith("_"));
        schemaSource = "active_schema_json";
      }

      // Priority 2: sample_json.columns from project_dataset_sample
      if (schemaColumns.length === 0) {
        const { data: sampleData } = await supabase
          .from("project_dataset_sample")
          .select("sample_json")
          .eq("project_id", project_id)
          .maybeSingle();
        if (sampleData?.sample_json) {
          const sj = sampleData.sample_json as Record<string, any>;
          if (Array.isArray(sj.columns) && sj.columns.length > 0) {
            schemaColumns = sj.columns.map((c: any) => typeof c === "string" ? c : c.name).filter(Boolean);
            schemaSource = "sample_json.columns";
          } else if (Array.isArray(sj.rows) && sj.rows.length > 0) {
            schemaColumns = Object.keys(sj.rows[0]);
            schemaSource = "sample_json.rows_keys";
          }
        }
      }

      if (schemaColumns.length > 0) {
        const schemaLower = new Set(schemaColumns.map(c => c.toLowerCase()));
        const missing: string[] = [];

        // Check target (skip virtual targets like "label", "_label_")
        if (!useHumanLabelsAsTarget && target_column !== "label" && target_column !== "_label_") {
          if (!schemaLower.has(target_column.toLowerCase())) {
            missing.push(`target: ${target_column}`);
          }
        }

        // Check selected features if available
        const selectedFeatures = selection?.selected_features;
        if (Array.isArray(selectedFeatures) && selectedFeatures.length > 0) {
          const featureList = selectedFeatures as string[];
          for (const f of featureList) {
            if (!schemaLower.has(f.toLowerCase())) {
              missing.push(`feature: ${f}`);
            }
          }
        }

        if (missing.length > 0) {
          console.error(`[Gating] Schema SSOT validation failed. Missing: ${missing.join(", ")}`);

          // Log observability event
          await supabase.from("platform_events").insert({
            event_type: "schema_ssot_validation_failed",
            project_id: project_id,
            status: "error",
            source: "edge",
            metadata: {
              missing,
              target: target_column,
              features_count: Array.isArray(selectedFeatures) ? selectedFeatures.length : 0,
              schema_columns_count: schemaColumns.length,
              source: schemaSource,
            },
          });

          return blockResponse(
            "INVALID_SCHEMA_SELECTION",
            `Target/Features não existem no schema consolidado: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`,
            { label: "Revisar seleção", go_to_step: 3 },
            { missing, schema_columns_count: schemaColumns.length, source: schemaSource }
          );
        }

        console.log(`[Gating] Schema SSOT validation OK (${schemaColumns.length} cols, source=${schemaSource})`);
      } else {
        console.warn(`[Gating] No schema SSOT available — skipping validation`);
      }
    }

    // ── Gate 3 prep: warnings accumulator ──
    const trainingWarningsGlobal: string[] = [];

    // ── MVP-Soft Prepare: training_prepare events + feature filter + sample plan ──
    {
      // Log training_prepare_started
      await supabase.from("platform_events").insert({
        event_type: "training_prepare_started",
        project_id: project_id,
        status: "info",
        source: "edge",
        metadata: { target_column, problem_type, entity_key: entityKey },
      });

      // Feature filtering (leakage tokens)
      const selectedFeatures = selection?.selected_features as string[] || [];
      if (selectedFeatures.length > 0) {
        let schemaCols = new Set<string>();
        if (dsState?.active_schema_json && typeof dsState.active_schema_json === "object") {
          schemaCols = new Set(Object.keys(dsState.active_schema_json).filter((k: string) => !k.startsWith("_")));
        }
        if (schemaCols.size > 0) {
          const filterResult = filterInvalidFeatures(selectedFeatures, schemaCols);
          if (filterResult.removed.length > 0) {
            console.log(`[MVP-Soft] Removed ${filterResult.removed.length} features: ${filterResult.removed.map(r => `${r.col}(${r.reason})`).join(", ")}`);
            trainingWarningsGlobal.push(`${filterResult.removed.length} feature(s) removida(s) por leakage/schema: ${filterResult.removed.slice(0, 5).map(r => r.col).join(", ")}`);
          }
          if (filterResult.valid.length < 3 && !useHumanLabelsAsTarget) {
            await supabase.from("platform_events").insert({
              event_type: "training_prepare_blocked",
              project_id: project_id,
              status: "error",
              source: "edge",
              metadata: { code: "NO_VALID_FEATURES", valid_count: filterResult.valid.length, removed: filterResult.removed.slice(0, 20) },
            });
            return blockResponse(
              "NO_VALID_FEATURES",
              `Apenas ${filterResult.valid.length} feature(s) válida(s) após filtro. Mínimo: 3. Re-selecione variáveis.`,
              { label: "Re-selecionar features", go_to_step: 3 },
              { valid_count: filterResult.valid.length, removed: filterResult.removed.slice(0, 20) }
            );
          }
        }
      }

      // Sample plan for large datasets
      const totalRows = dsState?.row_count || 0;
      if (totalRows > 0) {
        const plan = samplePlan(totalRows, problem_type);
        if (plan.shouldSample) {
          console.log(`[MVP-Soft] Sample plan: ${plan.sampleSize} rows (${plan.strategy}) from ${totalRows}`);
          await supabase.from("platform_events").insert({
            event_type: "training_prepare_sampled",
            project_id: project_id,
            status: "info",
            source: "edge",
            metadata: { total_rows: totalRows, sample_size: plan.sampleSize, strategy: plan.strategy },
          });
          trainingWarningsGlobal.push(`Amostra automática: ${plan.sampleSize.toLocaleString()} de ${totalRows.toLocaleString()} linhas (${plan.strategy})`);
        }
      }

      // Log training_prepare_passed
      await supabase.from("platform_events").insert({
        event_type: "training_prepare_passed",
        project_id: project_id,
        status: "success",
        source: "edge",
        metadata: { target_column, problem_type },
      });
    }

    // ══════ TRAINING COHERENCE AUDIT ══════
    // Log structured audit of contract_target vs selected_target vs target_used_in_training
    {
      const contractTargetDef = modelingContract?.target_definition as Record<string, any> | null;
      const contractTarget = contractTargetDef?.base_column || contractTargetDef?.derived_target || null;
      const contractProblemType = modelingContract?.problem_type || null;
      const selectedTarget = selection?.target_column || null;
      const selectedProblemType = selection?.problem_type || null;
      const settingsTarget = (activeTargetSettings as any)?.active_target_column || null;
      
      const coherenceAudit = {
        contract_target: contractTarget,
        contract_problem_type: contractProblemType,
        selected_target: selectedTarget,
        selected_problem_type: selectedProblemType,
        settings_target: settingsTarget,
        target_used_in_training: target_column,
        problem_type_used: problem_type,
        active_target_mode: activeTarget.mode,
        entity_key_used: entityKey,
        selection_version: currentSelectionVersion,
        target_hash: currentTargetHash,
        builder_dataset_id: modelingDataset?.id || null,
        builder_version_used: modelingDataset?.selection_version_used || null,
        metrics_profile_id: null as string | null, // will be set after profile resolution
        use_human_labels: useHumanLabelsAsTarget,
      };
      
      // Check for critical divergences
      const divergences: string[] = [];
      if (contractTarget && contractTarget !== target_column && !useHumanLabelsAsTarget) {
        divergences.push(`contract_target="${contractTarget}" ≠ target_used="${target_column}"`);
      }
      if (selectedTarget && selectedTarget !== target_column && !useHumanLabelsAsTarget) {
        divergences.push(`selected_target="${selectedTarget}" ≠ target_used="${target_column}"`);
      }
      if (contractProblemType && contractProblemType !== problem_type) {
        // Already blocked above, but log for audit
        divergences.push(`contract_problem_type="${contractProblemType}" ≠ problem_type_used="${problem_type}"`);
      }
      
      console.log(`\n=== Training Coherence Audit ===`);
      console.log(JSON.stringify(coherenceAudit, null, 2));
      if (divergences.length > 0) {
        console.warn(`[Coherence] Divergences detected: ${divergences.join("; ")}`);
      } else {
        console.log(`[Coherence] ✅ All targets/problem_types consistent`);
      }

      safeFire(supabase.from("platform_events").insert({
        event_type: "training_coherence_audit",
        project_id: project_id,
        status: divergences.length > 0 ? "warning" : "success",
        source: "edge",
        metadata: { ...coherenceAudit, divergences },
      }));
    }

    // ── Gate 3: Builder (must be current + matching selection_version) ──
    let builderDatasetId: string | null = null;

    if (modelingDataset) {
      const builderSelVersion = modelingDataset.selection_version_used || 0;
      const builderIsCurrent = modelingDataset.is_current !== false;

      if (!builderIsCurrent) {
        return blockResponse("BUILDER_OUTDATED", "O Builder está desatualizado (marcado como stale). Regere o dataset modelável.", { label: "Gerar Builder", go_to_step: 3 });
      }
      if (currentSelectionVersion > 0 && builderSelVersion < currentSelectionVersion) {
        return blockResponse("BUILDER_OUTDATED", `Builder (v${builderSelVersion}) desatualizado vs seleção (v${currentSelectionVersion}). Regere o dataset modelável.`, { label: "Regerar Builder", go_to_step: 3 });
      }

      const builderStatus = modelingDataset.status;
      if (builderStatus === "blocked" || builderStatus === "error") {
        const reasons = Array.isArray(modelingDataset.blocked_reasons) ? modelingDataset.blocked_reasons.join("; ") : String(modelingDataset.blocked_reasons || "");
        return blockResponse("BUILDER_BLOCKED", `Builder bloqueado: ${reasons}`, { label: "Revisar Target/Features", go_to_step: 3 });
      }

      // Check TrainingGateReport from builder
      const buildLog = modelingDataset.build_log as Record<string, any> | null;
      const tg = buildLog?.training_gate;
      if (tg && !tg.can_train) {
        const tgCode = tg.blocked_reason_code || "TRAINING_GATES_FAILED";
        return blockResponse(tgCode, `Gates de treino falharam: ${tg.blocked_reason_code || "Verifique o relatório do builder"}`, { label: "Revisar Builder", go_to_step: 3 }, { training_gate: tg });
      }
      if (tg && tg.status === "WARNING") {
        trainingWarningsGlobal.push(`Builder warning: ${tg.blocked_reason_code || "Veja relatório"}`);
      }

      builderDatasetId = modelingDataset.id;
      console.log(`[Gating] Builder OK: id=${builderDatasetId}, sel_v=${builderSelVersion}, status=${builderStatus}`);
    } else {
      // No builder — warn but don't block (legacy path allows direct training)
      trainingWarningsGlobal.push("Feature Builder não foi executado. Treinando com features brutas.");
      console.warn(`[Gating] No modeling_dataset found. Training with raw features (legacy path).`);
    }

    // ── Gate 4: Modeling Contract (guardrail only — NEVER overrides selection SSOT) ──
    // Contract is NOT required. If absent → continue. If outdated → WARN only.
    // Contract can only BLOCK for strong incompatibilities:
    //   (a) intent.problem_type != selection.problem_type
    //   (b) LabelGate fail (target invalid)
    //   (c) LeakageGate/SanityGate fail
    let contractUsed = false;
    let contractBlockedReason: string | null = null;
    let contractWarning: string | null = null;

    if (modelingContract) {
      contractUsed = true;
      console.log(`[Gating] Contract: status=${modelingContract.status}, version=${modelingContract.contract_version}`);

      // Check for strong incompatibilities only
      const contractTargetDef = modelingContract.target_definition as any;
      const contractProblemType = contractTargetDef?.problem_type;

      // (a) problem_type mismatch between contract and selection
      // GOVERNANCE FIX: If official_problem_type is set in project_settings, it takes priority.
      // The contract may be stale from initial intent, but the official problem_type is the user's confirmed choice.
      const officialProblemType = (activeTargetSettings as any)?.official_problem_type || null;
      
      const normalizeProblemType = (t: string) => {
        const lower = t.toLowerCase();
        if (lower === "binary" || lower === "classification" || lower === "binary_classification") return "classification";
        if (lower === "regression" || lower === "continuous") return "regression";
        return lower;
      };
      const normalizedContract = contractProblemType ? normalizeProblemType(contractProblemType) : null;
      const normalizedSelection = problem_type ? normalizeProblemType(problem_type) : null;
      const normalizedOfficial = officialProblemType ? normalizeProblemType(officialProblemType) : null;
      
      // If official_problem_type matches the selection, skip contract mismatch check
      // (the user explicitly confirmed this problem type via governance)
      if (normalizedOfficial && normalizedOfficial === normalizedSelection) {
        console.log(`[Gating] GOVERNANCE: official_problem_type="${officialProblemType}" matches selection="${problem_type}" — skipping contract mismatch check`);
        if (normalizedContract && normalizedContract !== normalizedSelection) {
          contractWarning = `Contrato diz "${contractProblemType}" mas alvo oficial é "${problem_type}" (confirmado pelo usuário).`;
        }
      } else if (normalizedContract && normalizedSelection && normalizedContract !== normalizedSelection) {
        // No official override — block as before
        contractBlockedReason = `CONTRACT_PROBLEM_TYPE_MISMATCH: contract=${contractProblemType}, selection=${problem_type}`;
        return blockResponse(
          "CONTRACT_PROBLEM_TYPE_MISMATCH",
          `Tipo de problema incompatível: contrato diz "${contractProblemType}" mas seleção diz "${problem_type}". Confirme na Etapa 3.`,
          { label: "Revisar Target", go_to_step: 3 },
          { contract_problem_type: contractProblemType, selection_problem_type: problem_type, hint: "Use o botão 'Migrar para novo alvo' na Etapa 3 para confirmar a mudança." }
        );
      }

      // (b)+(c) Check leakage_flags and blocked features from contract as guardrails
      // IMPORTANT: Only block if leakage columns are still in the active feature list
      const leakageFlags = (modelingContract.leakage_flags as any[]) || [];
      const selectedFeaturesList = (selection?.selected_features as string[]) || [];
      const excludedFeaturesList = (selection?.excluded_features as string[]) || [];
      const activeFeatureSet = new Set(selectedFeaturesList.filter(f => !excludedFeaturesList.includes(f)));
      
      const criticalLeakage = leakageFlags
        .filter((f: any) => f.reason?.toLowerCase().includes("critical") || f.reason?.toLowerCase().includes("leakage"))
        .filter((f: any) => activeFeatureSet.has(f.col)); // Only block if column is still active
      
      console.log(`[Gating] Leakage check: ${leakageFlags.length} flags total, ${criticalLeakage.length} still active in features`);
      
      if (criticalLeakage.length > 0) {
        contractBlockedReason = `CONTRACT_LEAKAGE_DETECTED: ${criticalLeakage.map((f: any) => f.col).join(", ")}`;
        return blockResponse(
          "CONTRACT_LEAKAGE_DETECTED",
          `Contrato detectou leakage crítico em: ${criticalLeakage.map((f: any) => f.col).join(", ")}. Remova essas features.`,
          { label: "Revisar Features", go_to_step: 3 },
          { leakage_flags: criticalLeakage }
        );
      }

      // If contract status is "blocked" but none of the above strong incompatibilities → WARN only
      if (modelingContract.status === "blocked") {
        const reasons = modelingContract.blocked_reasons as any;
        contractWarning = `Contrato com status=blocked (${JSON.stringify(reasons)}), mas sem incompatibilidade forte. Continuando com WARN.`;
        trainingWarningsGlobal.push(contractWarning);
        console.warn(`[Gating] Contract blocked but no strong incompatibility — downgrading to WARN`);
      }

      // Check if contract is outdated vs current selection
      const contractTargetCol = contractTargetDef?.base_column || contractTargetDef?.derived_target;
      if (contractTargetCol && contractTargetCol !== target_column) {
        contractWarning = `Contrato desatualizado: target do contrato="${contractTargetCol}" ≠ seleção="${target_column}". Usando seleção (SSOT).`;
        trainingWarningsGlobal.push(contractWarning);
        console.warn(`[Gating] Contract outdated target: ${contractTargetCol} vs selection: ${target_column}`);
      }
    } else {
      console.log(`[Gating] No modeling contract found — continuing without contract (not required).`);
    }

    // ── Compute deterministic seed ──
    const seedInput = `${project_id}|${currentSelectionVersion}|${builderDatasetId || "legacy"}`;
    let trainingSeed = 0;
    for (let i = 0; i < seedInput.length; i++) {
      trainingSeed = ((trainingSeed << 5) - trainingSeed) + seedInput.charCodeAt(i);
      trainingSeed |= 0;
    }
    trainingSeed = Math.abs(trainingSeed);
    console.log(`[AutoML] Deterministic seed: ${trainingSeed} (from sel_v=${currentSelectionVersion})`);

    // Legacy manifest check for model_ready warning
    const { data: manifest } = await supabase.from("import_manifests")
      .select("model_ready, blocked_reason_model").eq("project_id", project_id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (manifest?.model_ready === false) {
      trainingWarningsGlobal.push(`model_ready=false: ${manifest.blocked_reason_model || "Verifique importação"}`);
    }

    // (Contract gate already handled above in SSOT gating)

    // Get column info
    const { data: columns, error: colError } = await supabase
      .from("project_columns")
      .select("*")
      .eq("project_id", project_id)
      .order("column_index");

    if (colError || !columns) {
      console.error("Erro ao buscar colunas:", colError);
      return new Response(JSON.stringify({ error: "Erro ao buscar colunas" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch enabled project features for feature engineering
    const { data: projectFeaturesData } = await supabase
      .from("project_features")
      .select("*")
      .eq("project_id", project_id)
      .eq("enabled", true);
    
    const enabledFeatures: ProjectFeature[] = (projectFeaturesData || []).map(f => ({
      id: f.id,
      project_id: f.project_id,
      name: f.name,
      label: f.label,
      description: f.description || undefined,
      enabled: f.enabled,
      expression: f.expression as any
    }));
    
    console.log(`[AutoML] Features de engenharia habilitadas: ${enabledFeatures.length}`);

    // Get active dataset from project_datasets (use maybeSingle to handle no results)
    const { data: activeDataset, error: datasetError } = await supabase
      .from("project_datasets")
      .select("*")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .maybeSingle();

    // Determine dataset info - fallback to project.dataset_filename if no active dataset
    let totalDatasetRows: number;
    let sourceMetadata: Record<string, any>;
    let delimiter: string;
    let isBatchImport: boolean;
    let filePaths: string[] = [];

    if (activeDataset) {
      // Use project_datasets info
      totalDatasetRows = activeDataset.total_rows || project.total_rows || project.dataset_rows || 0;
      sourceMetadata = activeDataset.source_metadata as Record<string, any> || {};
      delimiter = sourceMetadata.delimiter || ",";
      isBatchImport = activeDataset.source_type === "batch_import";
      
      // CRITICAL FIX: For batch imports, use the storage_path (batch folder) and let
      // the folder expansion logic (below) discover actual files inside.
      // source_metadata.file_paths may contain logical names that don't map to real storage paths.
      // import_jobs.storage_path may also point to a different subfolder than the batch folder.
      if (isBatchImport) {
        // Use the batch folder as the primary path — folder expansion will list real files
        filePaths = [activeDataset.storage_path];
        console.log(`[AutoML] Batch import: using storage_path folder for expansion: ${activeDataset.storage_path}`);
        
        // Get delimiter from the actual import job (most reliable source)
        const { data: completedJobs } = await supabase
          .from("import_jobs")
          .select("delimiter, rows_processed, file_name")
          .eq("project_id", project_id)
          .eq("status", "completed")
          .order("batch_sequence");
        
        if (completedJobs && completedJobs.length > 0) {
          const jobDelimiter = completedJobs[0]?.delimiter;
          if (jobDelimiter) {
            delimiter = jobDelimiter;
            console.log(`[AutoML] Delimiter from import_jobs: "${delimiter}"`);
          }
        }
      } else {
        filePaths = [activeDataset.storage_path];
      }
      
      // Also try to get delimiter from import_jobs if not set in source_metadata
      if (delimiter === "," && !sourceMetadata.delimiter) {
        const { data: delimJob } = await supabase
          .from("import_jobs")
          .select("delimiter")
          .eq("project_id", project_id)
          .eq("status", "completed")
          .limit(1)
          .maybeSingle();
        if (delimJob?.delimiter && delimJob.delimiter !== ",") {
          delimiter = delimJob.delimiter;
          console.log(`[AutoML] Delimiter corrected from import_jobs: "${delimiter}"`);
        }
      }
      
      console.log(`[AutoML] Usando dataset ativo: ${activeDataset.name}, delimiter: "${delimiter}"`);
    } else {
      // Fallback: use project.dataset_filename directly
      console.log(`[AutoML] Sem dataset ativo, usando project.dataset_filename`);
      
      if (!project.dataset_filename) {
        return new Response(JSON.stringify({ error: "Nenhum dataset encontrado para o projeto" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      totalDatasetRows = project.total_rows || project.dataset_rows || 0;
      sourceMetadata = {};
      delimiter = ","; // Default delimiter
      isBatchImport = false;

      // Resolve actual storage path — files are stored as {user_id}/{project_id}/{filename}
      const bareFilename = project.dataset_filename;
      let resolvedPath = bareFilename;

      // Check if the bare filename exists in storage
      const { data: directCheck } = await supabase.storage
        .from("datasets")
        .createSignedUrl(bareFilename, 10);

      if (!directCheck?.signedUrl) {
        // Try user_id/project_id/filename pattern
        const userId = project.user_id;
        if (userId) {
          const folderPath = `${userId}/${project_id}`;
          const { data: files } = await supabase.storage
            .from("datasets")
            .list(folderPath, { limit: 100 });

          if (files && files.length > 0) {
            const match = files.find((f: any) => f.name === bareFilename);
            if (match) {
              resolvedPath = `${folderPath}/${bareFilename}`;
              console.log(`[AutoML] Resolved storage path: ${resolvedPath}`);
            } else {
              // Try to find any data file in the folder
              const dataFile = files.find((f: any) =>
                f.name && /\.(csv|parquet|parq|pq|xlsx|xls|json)$/i.test(f.name)
              );
              if (dataFile) {
                resolvedPath = `${folderPath}/${dataFile.name}`;
                console.log(`[AutoML] Found data file in folder: ${resolvedPath}`);
              }
            }
          }
        }
      }

      filePaths = [resolvedPath];
    }

    // ==================== VALIDATE MINIMUM ROWS ====================
    console.log(`\n=== Validação de tamanho do dataset ===`);
    console.log(`Total de linhas no dataset: ${totalDatasetRows.toLocaleString()}`);
    console.log(`Mínimo requerido: ${MIN_ROWS_FOR_TRAIN.toLocaleString()}`);
    console.log(`Target sample size: ${TARGET_SAMPLE_SIZE.toLocaleString()}`);
    console.log(`Max linhas para leitura: ${MAX_ROWS_TO_READ.toLocaleString()}`);

    if (totalDatasetRows < MIN_ROWS_FOR_TRAIN) {
      console.log(`[AutoML] Dataset muito pequeno (${totalDatasetRows} < ${MIN_ROWS_FOR_TRAIN})`);
      
      // Update project status to not_enough_data
      await supabase
        .from("projects")
        .update({ 
          status: "not_enough_data"
        })
        .eq("id", project_id);

      return new Response(JSON.stringify({ 
        error: `Dados insuficientes para treinamento`,
        details: `O dataset possui ${totalDatasetRows.toLocaleString()} linhas, mas são necessárias pelo menos ${MIN_ROWS_FOR_TRAIN.toLocaleString()} linhas para um modelo confiável.`,
        status: "not_enough_data",
        total_rows: totalDatasetRows,
        min_required: MIN_ROWS_FOR_TRAIN
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ==================== DETERMINE SAMPLING STRATEGY (resource_guard) ====================
    let useFullDataset = false;
    let effectiveMaxRowsToRead: number;
    let effectiveTargetSampleSize: number;
    let sampleStrategy = "full"; // full | stratified_quantile | stratified_class | random_sample

    if (totalDatasetRows <= TARGET_SAMPLE_SIZE) {
      useFullDataset = true;
      effectiveMaxRowsToRead = totalDatasetRows + 1000;
      effectiveTargetSampleSize = totalDatasetRows;
      sampleStrategy = "full";
      console.log(`[resource_guard] Dataset pequeno/médio (${totalDatasetRows.toLocaleString()} linhas) — treino em 100%`);
    } else {
      useFullDataset = false;
      effectiveMaxRowsToRead = MAX_ROWS_TO_READ;
      effectiveTargetSampleSize = TARGET_SAMPLE_SIZE;
      sampleStrategy = problem_type === "classification" ? "stratified_class" : "stratified_quantile";
      console.log(`[resource_guard] Dataset grande (${totalDatasetRows.toLocaleString()} linhas)`);
      console.log(`[resource_guard] Estratégia: ${sampleStrategy}, amostra ${TARGET_SAMPLE_SIZE.toLocaleString()}, seed fixa`);
    }

    // Update project status to training
    await supabase
      .from("projects")
      .update({ status: "training" })
      .eq("id", project_id);

    console.log(`Dataset path: ${filePaths[0]}, Batch: ${isBatchImport}`);

    if (filePaths.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum arquivo encontrado no dataset" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Arquivos para processar: ${filePaths.length}`);

    // Some ingestion flows store a *folder prefix* in storage_path (e.g. ".../uuid")
    // while the actual file lives inside that folder (e.g. ".../uuid/dataset.csv").
    // If we receive a folder, expand it into real object paths before streaming.
    const expandedFilePaths = (await Promise.all(
      filePaths.map(async (p) => {
        const { data: listed, error: listError } = await supabase.storage
          .from("datasets")
          .list(p, { limit: 1000 });

        if (!listError && listed && listed.length > 0) {
          const childPaths = listed
            .map((obj) => (obj as any)?.name)
            .filter((name): name is string => typeof name === "string" && name.length > 0)
            .map((name) => `${p}/${name}`);

          return childPaths.length > 0 ? childPaths : [p];
        }

        return [p];
      })
    )).flat();

    filePaths = expandedFilePaths;
    console.log(`Arquivos resolvidos para processar: ${filePaths.length}`);

    // ==================== VIRTUAL DATASET DETECTION (Power BI / External) ====================
    // Power BI materialized datasets have no real files in storage — data lives in project_dataset_sample.
    const isPowerBIMaterialized = activeDataset &&
      (sourceMetadata?.source_mode === "powerbi_materialized" ||
       activeDataset.storage_path?.startsWith("powerbi_materialized/") ||
       activeDataset.source_type === "powerbi");
    let useVirtualSample = false;
    let virtualHeaders: string[] = [];
    let virtualSampledLines: string[] = [];

    if (isPowerBIMaterialized) {
      console.log(`[AutoML] Power BI materialized dataset detected — reading from project_dataset_sample`);
      const { data: sampleData } = await supabase
        .from("project_dataset_sample")
        .select("sample_json, sample_rows")
        .eq("project_id", project_id)
        .maybeSingle();

      if (sampleData?.sample_json) {
        // sample_json can be either a plain array of rows OR an object { rows, columns, source }
        const rawJson = sampleData.sample_json as any;
        let sampleRows: Record<string, any>[] = Array.isArray(rawJson)
          ? rawJson
          : (Array.isArray(rawJson?.rows) ? rawJson.rows : []);

        // Detect multi-table stacked rows: rows from different __source_table values
        // only have their own table's columns. We need ALL columns in every row.
        const declaredColumns: string[] = Array.isArray(rawJson?.columns) ? rawJson.columns : [];
        if (sampleRows.length > 0 && declaredColumns.length > 0) {
          const sourceTables = new Set(sampleRows.map(r => r.__source_table).filter(Boolean));
          if (sourceTables.size > 1) {
            console.log(`[AutoML] Multi-table sample detected: ${sourceTables.size} tables (${[...sourceTables].join(", ")}). Merging rows with all ${declaredColumns.length} columns.`);
            // Each row needs all declared columns; fill missing with empty string
            sampleRows = sampleRows.map(row => {
              const merged: Record<string, any> = {};
              for (const col of declaredColumns) {
                merged[col] = row[col] !== undefined ? row[col] : "";
              }
              if (row.__source_table) merged.__source_table = row.__source_table;
              return merged;
            });
          }
        }

        console.log(`[AutoML] sample_json type=${typeof rawJson}, isArray=${Array.isArray(rawJson)}, extracted rows=${sampleRows.length}, declaredCols=${declaredColumns.length}`);
        if (sampleRows.length > 0) {
          // Use declared columns if available (covers all tables), otherwise fall back to first row keys
          virtualHeaders = declaredColumns.length > 0
            ? declaredColumns.filter(c => c !== "__source_table")
            : Object.keys(sampleRows[0]).filter(c => c !== "__source_table");

          // Convert JSON rows to CSV-like delimited lines
          const vDelimiter = ",";
          delimiter = vDelimiter;
          virtualSampledLines = sampleRows.map(row =>
            virtualHeaders.map(h => {
              const v = row[h];
              if (v === null || v === undefined) return "";
              const s = String(v);
              if (s.includes(vDelimiter) || s.includes('"') || s.includes('\n')) {
                return `"${s.replace(/"/g, '""')}"`;
              }
              return s;
            }).join(vDelimiter)
          );
          useVirtualSample = true;
          totalDatasetRows = Math.max(totalDatasetRows, virtualSampledLines.length);
          console.log(`[AutoML] Virtual sample loaded: ${virtualHeaders.length} cols, ${virtualSampledLines.length} rows`);
        }
      }

      if (!useVirtualSample) {
        console.error(`[AutoML] Power BI dataset detected but no sample data found in project_dataset_sample`);
        return new Response(JSON.stringify({
          error: "Dataset Power BI não possui dados de amostra. Rematerialize as tabelas no painel XMLA.",
          status: "NO_SAMPLE_DATA"
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ==================== TEMPORAL AGGREGATION (in-memory) ====================
    // When dataset_build_mode = temporal_aggregated, aggregate raw sample rows
    // into entity × month grain BEFORE training. This creates the virtual target
    // (agg_sacas_mes) and aggregated features from row-level data.
    const datasetBuildMode = (activeTargetSettings as any)?.dataset_build_mode || "original_row";
    const isTemporalAggregated = datasetBuildMode === "temporal_aggregated";

    if (isTemporalAggregated && !useVirtualSample) {
      // Need to load sample for aggregation even if not Power BI
      console.log(`[AutoML] temporal_aggregated mode — loading sample for in-memory aggregation`);
      const { data: sampleDataAgg } = await supabase
        .from("project_dataset_sample")
        .select("sample_json, sample_rows")
        .eq("project_id", project_id)
        .maybeSingle();

      if (sampleDataAgg?.sample_json) {
        const rawJsonAgg = sampleDataAgg.sample_json as any;
        const sampleRowsAgg: Record<string, any>[] = Array.isArray(rawJsonAgg)
          ? rawJsonAgg
          : (Array.isArray(rawJsonAgg?.rows) ? rawJsonAgg.rows : []);

        if (sampleRowsAgg.length > 0) {
          useVirtualSample = true; // Force virtual path with aggregated data
        }
      }
    }

    if (isTemporalAggregated && useVirtualSample) {
      console.log(`[AutoML] Applying temporal aggregation to virtual sample...`);
      const aggEntityKey = entityKey || (activeTargetSettings as any)?.entity_key || null;
      const aggTimeCol = (activeTargetSettings as any)?.time_anchor_column || null;

      if (aggEntityKey && aggTimeCol) {
        // Re-load raw sample rows (they might already be in virtualSampledLines as CSV)
        const { data: sampleDataAgg2 } = await supabase
          .from("project_dataset_sample")
          .select("sample_json")
          .eq("project_id", project_id)
          .maybeSingle();

        const rawJsonAgg2 = sampleDataAgg2?.sample_json as any;
        const rawRows: Record<string, any>[] = Array.isArray(rawJsonAgg2)
          ? rawJsonAgg2
          : (Array.isArray(rawJsonAgg2?.rows) ? rawJsonAgg2.rows : []);

        if (rawRows.length > 0) {
          // Aggregate by entity × month
          const aggMap = new Map<string, {
            count: number;
            codpes_set: Set<string>;
            codgre_vals: Map<string, number>;
            origem_vals: Map<string, number>;
            tipo_vals: Map<string, number>;
            year: number;
            monthNum: number;
            quarter: number;
          }>();

          for (const row of rawRows) {
            const entity = String(row[aggEntityKey] || "");
            const rawDate = String(row[aggTimeCol] || "");
            const month = rawDate.substring(0, 7); // "YYYY-MM"
            if (!entity || !month || month.length < 7) continue;

            const key = `${entity}|${month}`;
            if (!aggMap.has(key)) {
              const yr = parseInt(month.split("-")[0]) || 0;
              const mn = parseInt(month.split("-")[1]) || 0;
              const qt = Math.ceil(mn / 3);
              aggMap.set(key, {
                count: 0,
                codpes_set: new Set(),
                codgre_vals: new Map(),
                origem_vals: new Map(),
                tipo_vals: new Map(),
                year: yr,
                monthNum: mn,
                quarter: qt,
              });
            }
            const agg = aggMap.get(key)!;
            agg.count += 1; // each row = 1 saca

            // Track categorical modes
            const codgre = String(row["Detalhe Movimentação.CODGRE"] || row["CODGRE"] || "");
            if (codgre) agg.codgre_vals.set(codgre, (agg.codgre_vals.get(codgre) || 0) + 1);
            const origem = String(row["Detalhe Movimentação.Origem da Movimentação"] || "");
            if (origem) agg.origem_vals.set(origem, (agg.origem_vals.get(origem) || 0) + 1);
            const tipo = String(row["Detalhe Movimentação.Tipo do Movimento"] || "");
            if (tipo) agg.tipo_vals.set(tipo, (agg.tipo_vals.get(tipo) || 0) + 1);
            const codpes = String(row["Detalhe Movimentação.CODPES"] || row["CODPES"] || "");
            if (codpes) agg.codpes_set.add(codpes);

            // Calendar fields from row (fallback)
            if (agg.year === 0) {
              const calAno = row["Calendário.Ano"];
              if (calAno) agg.year = parseInt(String(calAno)) || 0;
            }
            if (agg.monthNum === 0) {
              const calMes = row["Calendário.Mês Número"];
              if (calMes) agg.monthNum = parseInt(String(calMes)) || 0;
            }
            if (agg.quarter === 0) {
              const calTri = row["Calendário.Trimestre"];
              if (calTri) agg.quarter = parseInt(String(calTri)) || Math.ceil(agg.monthNum / 3);
            }
          }

          // Helper: get mode (most frequent value) from a frequency map
          const getMode = (m: Map<string, number>): string => {
            let best = ""; let bestCount = 0;
            for (const [k, v] of m) { if (v > bestCount) { best = k; bestCount = v; } }
            return best;
          };

          // Build aggregated rows as CSV
          const aggHeaders = [
            "agg_sacas_mes",
            "Calendário.Ano",
            "Calendário.Mês Número",
            "Calendário.Trimestre",
            "Detalhe Movimentação.CODGRE",
            "Detalhe Movimentação.Origem da Movimentação",
            "Detalhe Movimentação.Tipo do Movimento",
          ];

          const aggLines: string[] = [];
          for (const [, v] of aggMap) {
            const vals = [
              String(v.count),
              String(v.year),
              String(v.monthNum),
              String(v.quarter),
              getMode(v.codgre_vals),
              getMode(v.origem_vals),
              getMode(v.tipo_vals),
            ];
            aggLines.push(vals.map(s => {
              if (s.includes(",") || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
              return s;
            }).join(","));
          }

          // Replace virtual sample with aggregated data
          virtualHeaders = aggHeaders;
          virtualSampledLines = aggLines;
          delimiter = ",";
          totalDatasetRows = aggLines.length;
          totalLinesRead = aggLines.length;

          console.log(`[AutoML] Temporal aggregation complete: ${aggMap.size} rows (entity×month), target=agg_sacas_mes, features=${aggHeaders.length - 1}`);
          console.log(`[AutoML] Aggregated target stats: min=${Math.min(...[...aggMap.values()].map(v => v.count))}, max=${Math.max(...[...aggMap.values()].map(v => v.count))}, mean=${([...aggMap.values()].reduce((a, v) => a + v.count, 0) / aggMap.size).toFixed(1)}`);
        }
      } else {
        console.warn(`[AutoML] temporal_aggregated mode but missing entity_key or time_anchor_column`);
      }
    }

    // Detect if files are Parquet
    const useParquet = !useVirtualSample && filePaths.some(p => isParquetFile(p, sourceMetadata));
    console.log(`[AutoML] Formato detectado: ${useVirtualSample ? "Virtual (Power BI)" : useParquet ? "Parquet" : "CSV"}`);

    // ==================== DATA READING (VIRTUAL vs PARQUET vs CSV) ====================
    let headers: string[] = [];
    const X: number[][] = [];
    const y: number[] = [];
    const labelMap: Map<string, number> = new Map();
    let totalLinesRead = 0;

    if (useVirtualSample) {
      // ========== VIRTUAL SAMPLE PATH (Power BI / External) ==========
      // Power BI materialized datasets have no files in storage.
      // Data was loaded from project_dataset_sample into virtualHeaders + virtualSampledLines.
      headers = virtualHeaders;
      totalLinesRead = virtualSampledLines.length;
      isBatchImport = false;

      console.log(`\n=== Resumo da leitura Virtual (Power BI) ===`);
      console.log(`Colunas: ${headers.length}`);
      console.log(`Linhas: ${totalLinesRead.toLocaleString()}`);

      if (headers.length === 0 || virtualSampledLines.length === 0) {
        return new Response(JSON.stringify({ error: "Não foi possível ler dados do dataset virtual Power BI. Rematerialize as tabelas." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Find target column index
      const targetIndex = useHumanLabelsAsTarget ? -1 : findHeaderIndex(headers, target_column);
      if (!useHumanLabelsAsTarget && targetIndex === -1) {
        console.error(`Coluna alvo "${target_column}" não encontrada. Colunas: ${headers.slice(0, 20).join(", ")}`);
        return new Response(JSON.stringify({
          error: `Coluna alvo "${target_column}" não encontrada no dataset.`,
          available_columns: headers.slice(0, 20)
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Get numeric feature columns
      const numericColumns = columns.filter(c =>
        (c.inferred_type === "numérico" || c.inferred_type === "numerico") && c.column_name !== target_column
      );
      const featureIndices = numericColumns.map(c => findHeaderIndex(headers, c.column_name)).filter(i => i !== -1);
      const baseFeatureNames = featureIndices.map(i => headers[i]);
      const engineeredFeatureNames = enabledFeatures.map(f => f.name);
      const allFeatureNames = [...baseFeatureNames, ...engineeredFeatureNames];

      if (baseFeatureNames.length === 0) {
        return new Response(JSON.stringify({ error: "Nenhuma feature numérica encontrada." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Check if target is categorical
      const targetColumnInfo = columns.find(c => c.column_name === target_column);
      const isTargetCategorical = targetColumnInfo?.inferred_type === "categórico" ||
                                    targetColumnInfo?.inferred_type === "categorico" ||
                                    targetColumnInfo?.inferred_type === "texto";

      console.log(`\nFeatures base: ${baseFeatureNames.length} colunas numéricas`);
      console.log(`Features engenharia: ${engineeredFeatureNames.length}`);
      console.log(`Target: ${target_column} (categorical: ${isTargetCategorical})`);

      // Parse CSV lines into X, y (same logic as CSV path)
      for (const line of virtualSampledLines) {
        const values = parseCSVLine(line, delimiter);

        // Build raw record for feature engineering
        const rawRecord: Record<string, string | number | null> = {};
        headers.forEach((h, idx) => { rawRecord[h] = values[idx] || null; });

        // Get base features
        const baseFeatures = featureIndices.map(idx => {
          const val = values[idx]?.replace(",", ".") || "";
          const parsed = parseFloat(val);
          return isNaN(parsed) ? 0 : parsed;
        });

        // Apply engineered features
        const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
        const engineeredFeatures = engineeredFeatureNames.map(name => {
          const val = engineeredValues[name];
          return typeof val === "number" ? val : 0;
        });

        const allFeatures = [...baseFeatures, ...engineeredFeatures];

        if (useHumanLabelsAsTarget) {
          X.push(allFeatures);
          y.push(0);
        } else {
          let targetNumeric: number;
          if (isTargetCategorical) {
            const targetVal = values[targetIndex]?.trim() || "";
            if (!labelMap.has(targetVal) && targetVal) labelMap.set(targetVal, labelMap.size);
            targetNumeric = labelMap.get(targetVal) ?? -1;
          } else {
            targetNumeric = parseFloat(values[targetIndex]?.replace(",", ".") || "");
          }
          const hasValidTarget = isTargetCategorical ? targetNumeric !== -1 : !isNaN(targetNumeric);
          if (hasValidTarget) {
            X.push(allFeatures);
            y.push(targetNumeric);
          }
        }
      }

      console.log(`Dados processados (virtual): ${X.length} linhas, ${X[0]?.length || 0} features`);

      // Store feature names for later use (same as CSV/Parquet branches)
      (globalThis as any).__featureNames = allFeatureNames;
      (globalThis as any).__isTargetCategorical = isTargetCategorical;

    } else if (useParquet) {
      // ========== PARQUET PATH ==========
      console.log(`[AutoML] Iniciando leitura Parquet...`);
      
      const parquetResult = await readParquetFromStorage(
        supabase,
        filePaths,
        useFullDataset ? totalDatasetRows + 1000 : effectiveMaxRowsToRead
      );
      
      headers = parquetResult.headers;
      totalLinesRead = parquetResult.rows.length;
      
      console.log(`\n=== Resumo da leitura Parquet ===`);
      console.log(`Total de arquivos: ${filePaths.length}`);
      console.log(`Linhas lidas: ${totalLinesRead.toLocaleString()}`);

      if (headers.length === 0 || totalLinesRead === 0) {
        console.error(`[AutoML] Parquet read failed. Paths tried: ${filePaths.join(", ")}`);
        return new Response(JSON.stringify({ error: "Não foi possível ler dados do arquivo Parquet. Verifique se o arquivo está acessível e bem formatado." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ── Materialize _label_ if target is derived via label builder ──
      if (target_column === "_label_") {
        const labelPlan = modelingDataset?.label_plan as Record<string, any> | null;
        const labelStrategy = labelPlan?.strategy || "unknown";
        console.log(`[AutoML] Materializing _label_ target (strategy: ${labelStrategy})`);

        // Load label builder for params
        const { data: lblBuilder } = await supabase
          .from("project_label_builders")
          .select("template_id, params")
          .eq("project_id", project_id)
          .eq("status", "ready")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const builderParams = (lblBuilder?.params as Record<string, any>) || {};
        const contractHintsCtx = ((await supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle()).data?.context as Record<string, any>)?.contract_hints || {};
        const entityKeyCol = contractHintsCtx.entity_key || modelingDataset?.entity_key || null;
        const timeAnchorCol = contractHintsCtx.time_anchor_column || modelingDataset?.anchor_time_col || null;
        const windowDays = builderParams.window_days || labelPlan?.window_days || 90;

        // Add _label_ to headers
        headers.push("_label_");

        if (labelStrategy === "state_change" && timeAnchorCol && entityKeyCol) {
          // Churn: _label_ = 1 if entity has no activity in last windowDays
          const timeIdx = findHeaderIndex(headers, timeAnchorCol);
          const entityIdx = findHeaderIndex(headers, entityKeyCol);

          if (timeIdx !== -1 && entityIdx !== -1) {
            // Find max date per entity
            const entityMaxDate = new Map<string, number>();
            let globalMaxDate = 0;
            for (const row of parquetResult.rows) {
              const eid = String(row[headers[entityIdx]] ?? "");
              const rawDate = row[headers[timeIdx]];
              const ts = rawDate instanceof Date ? rawDate.getTime() : new Date(String(rawDate)).getTime();
              if (!isNaN(ts)) {
                const prev = entityMaxDate.get(eid) || 0;
                if (ts > prev) entityMaxDate.set(eid, ts);
                if (ts > globalMaxDate) globalMaxDate = ts;
              }
            }

            const refDate = builderParams.reference_date_strategy === "today" ? Date.now() : globalMaxDate;
            const cutoffMs = windowDays * 24 * 60 * 60 * 1000;

            for (const row of parquetResult.rows) {
              const eid = String(row[headers[entityIdx]] ?? "");
              const lastActivity = entityMaxDate.get(eid) || 0;
              (row as any)["_label_"] = (refDate - lastActivity) > cutoffMs ? 1 : 0;
            }
            console.log(`[AutoML] _label_ materialized: state_change, window=${windowDays}d, entities=${entityMaxDate.size}`);
          } else {
            // Fallback: random label (shouldn't happen if gates worked)
            for (const row of parquetResult.rows) {
              (row as any)["_label_"] = Math.random() > 0.75 ? 1 : 0;
            }
            trainingWarningsGlobal.push("_label_ materialized with fallback (time/entity columns not found in parquet).");
          }
        } else if (labelStrategy === "direct") {
          // No-show: use status column directly
          const statusCol = builderParams.status_column || (labelPlan?.source_columns?.[0]) || null;
          const positiveValues: string[] = builderParams.positive_values || ["no_show", "missed", "faltou", "No-Show", "ausente"];

          if (statusCol) {
            const statusIdx = findHeaderIndex(headers, statusCol);
            if (statusIdx !== -1) {
              const actualStatus = headers[statusIdx];
              for (const row of parquetResult.rows) {
                const val = String(row[actualStatus] ?? "").toLowerCase();
                (row as any)["_label_"] = positiveValues.some(pv => val.includes(pv.toLowerCase())) ? 1 : 0;
              }
              console.log(`[AutoML] _label_ materialized: direct from "${statusCol}"`);
            }
          }

          // Fallback if no status resolved
          if (parquetResult.rows.length > 0 && (parquetResult.rows[0] as any)["_label_"] === undefined) {
            for (const row of parquetResult.rows) {
              (row as any)["_label_"] = 0;
            }
            trainingWarningsGlobal.push("_label_ materialized with fallback (status column not resolved).");
          }
        } else {
          // event_window or unknown: use simple heuristic
          for (const row of parquetResult.rows) {
            (row as any)["_label_"] = 0;
          }
          trainingWarningsGlobal.push(`_label_ strategy "${labelStrategy}" not fully supported at train-time. Using fallback.`);
        }
      }

      // Find target column index (case-insensitive fallback)
      // When using human labels, target column may not exist in dataset — skip validation
      const targetIndex = useHumanLabelsAsTarget ? -1 : findHeaderIndex(headers, target_column);
      if (!useHumanLabelsAsTarget && targetIndex === -1) {
        console.error(`Coluna alvo "${target_column}" não encontrada. Colunas disponíveis: ${headers.join(", ")}`);
        return new Response(JSON.stringify({ 
          error: `Coluna alvo "${target_column}" não encontrada no dataset.`,
          available_columns: headers.slice(0, 20)
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Use the actual header name from the file for row access (null for human mode)
      const actualTargetName = targetIndex !== -1 ? headers[targetIndex] : null;

      // Get numeric feature columns (case-insensitive matching)
      const numericColumns = columns.filter(c => 
        (c.inferred_type === "numérico" || c.inferred_type === "numerico") && c.column_name !== target_column
      );
      const baseFeatureNames = numericColumns
        .map(c => {
          const idx = findHeaderIndex(headers, c.column_name);
          return idx !== -1 ? headers[idx] : null;
        })
        .filter((n): n is string => n !== null);
      const engineeredFeatureNames = enabledFeatures.map(f => f.name);
      const allFeatureNames = [...baseFeatureNames, ...engineeredFeatureNames];

      if (baseFeatureNames.length === 0) {
        return new Response(JSON.stringify({ error: "Nenhuma feature numérica encontrada." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check if target is categorical
      const targetColumnInfo = columns.find(c => c.column_name === target_column);
      const isTargetCategorical = targetColumnInfo?.inferred_type === "categórico" || 
                                    targetColumnInfo?.inferred_type === "categorico" ||
                                    targetColumnInfo?.inferred_type === "texto";

      console.log(`Features base: ${baseFeatureNames.length}, Engenharia: ${engineeredFeatureNames.length}`);
      console.log(`Target: ${target_column} (categorical: ${isTargetCategorical})`);

      // Apply intelligent sampling if needed (resource_guard)
      let rowsToProcess = parquetResult.rows;
      if (!useFullDataset && rowsToProcess.length > effectiveTargetSampleSize) {
        console.log(`[resource_guard] Amostragem ${sampleStrategy}: ${rowsToProcess.length.toLocaleString()} → ${effectiveTargetSampleSize.toLocaleString()} linhas`);
        if (useHumanLabelsAsTarget) {
          // Human mode: no target column in dataset, just random sample
          rowsToProcess = shuffle(rowsToProcess).slice(0, effectiveTargetSampleSize);
        } else if (sampleStrategy === "stratified_quantile" && !isTargetCategorical) {
          // Stratify by target quantile bins (10 bins)
          const nBins = 10;
          const targetValues = rowsToProcess.map(r => {
            const v = r[target_column];
            return typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
          }).filter(v => !isNaN(v));
          const sorted = [...targetValues].sort((a, b) => a - b);
          const binEdges: number[] = [];
          for (let b = 1; b < nBins; b++) binEdges.push(sorted[Math.floor(sorted.length * b / nBins)]);
          
          const bins: Map<number, any[]> = new Map();
          for (let b = 0; b <= nBins; b++) bins.set(b, []);
          for (const row of rowsToProcess) {
            const v = typeof row[target_column] === "number" ? row[target_column] : parseFloat(String(row[target_column] ?? "").replace(",", "."));
            let bin = nBins - 1;
            for (let b = 0; b < binEdges.length; b++) {
              if (v <= binEdges[b]) { bin = b; break; }
            }
            bins.get(bin)!.push(row);
          }
          const perBin = Math.floor(effectiveTargetSampleSize / nBins);
          rowsToProcess = [];
          bins.forEach(rows => {
            const sampled = shuffle(rows).slice(0, Math.max(perBin, Math.min(rows.length, 50)));
            rowsToProcess.push(...sampled);
          });
          rowsToProcess = shuffle(rowsToProcess).slice(0, effectiveTargetSampleSize);
        } else if (sampleStrategy === "stratified_class" && isTargetCategorical) {
          // Stratify by class
          const classBins: Map<string, any[]> = new Map();
          for (const row of rowsToProcess) {
            const cls = String(row[target_column] ?? "");
            if (!classBins.has(cls)) classBins.set(cls, []);
            classBins.get(cls)!.push(row);
          }
          const perClass = Math.floor(effectiveTargetSampleSize / classBins.size);
          rowsToProcess = [];
          classBins.forEach(rows => {
            rowsToProcess.push(...shuffle(rows).slice(0, Math.max(perClass, Math.min(rows.length, 50))));
          });
          rowsToProcess = shuffle(rowsToProcess).slice(0, effectiveTargetSampleSize);
        } else {
          rowsToProcess = shuffle(rowsToProcess).slice(0, effectiveTargetSampleSize);
        }
      }

      // Parse rows into X and y
      for (const row of rowsToProcess) {
        // When using human labels, skip target extraction from dataset
        const targetVal = useHumanLabelsAsTarget ? null : (actualTargetName ? row[actualTargetName] : row[target_column]);
        
        if (!useHumanLabelsAsTarget && isTargetCategorical) {
          const tv = String(targetVal ?? "").trim();
          if (tv && !labelMap.has(tv)) {
            labelMap.set(tv, labelMap.size);
          }
        }

        // Build raw record for feature engineering
        const rawRecord: Record<string, string | number | null> = {};
        for (const h of headers) {
          rawRecord[h] = row[h] ?? null;
        }

        // Get base features - Parquet provides native types
        const baseFeatures = baseFeatureNames.map(name => {
          const val = row[name];
          if (val === null || val === undefined) return NaN;
          if (typeof val === "number") return val;
          if (typeof val === "bigint") return Number(val);
          const parsed = parseFloat(String(val).replace(",", "."));
          return parsed;
        });

        // Apply engineered features
        const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
        const engineeredFeatures = engineeredFeatureNames.map(name => {
          const val = engineeredValues[name];
          return typeof val === "number" ? val : 0;
        });

        const allFeatures = [...baseFeatures, ...engineeredFeatures];

        if (useHumanLabelsAsTarget) {
          // For human mode, just load features — y will be overridden later
          if (allFeatures.every(f => !isNaN(f))) {
            X.push(allFeatures);
            y.push(0); // placeholder, will be replaced by human labels
          }
        } else {
          let targetNumeric: number;
          if (isTargetCategorical) {
            const tv = String(targetVal ?? "").trim();
            targetNumeric = labelMap.get(tv) ?? -1;
          } else {
            if (typeof targetVal === "number") {
              targetNumeric = targetVal;
            } else if (typeof targetVal === "bigint") {
              targetNumeric = Number(targetVal);
            } else {
              targetNumeric = parseFloat(String(targetVal ?? "").replace(",", "."));
            }
          }

          if (allFeatures.every(f => !isNaN(f)) && targetNumeric !== -1 && !isNaN(targetNumeric)) {
            X.push(allFeatures);
            y.push(targetNumeric);
          }
        }
      }

      // Free memory
      parquetResult.rows.length = 0;

      // Detect datetime column for smart split (Parquet path)
      // PRIORITY 1: Use SSOT time_anchor_column if available
      {
        const ssotTimCol = (activeTargetSettings as any)?.time_anchor_column || (activeTargetSettings as any)?.recommended_time_column || null;
        let resolvedDtCol: string | null = null;
        
        if (ssotTimCol) {
          // Check if SSOT time column exists in headers
          const ssotIdx = headers.findIndex(h => h.toLowerCase() === ssotTimCol.toLowerCase());
          if (ssotIdx !== -1) {
            resolvedDtCol = headers[ssotIdx];
            console.log(`[Split] Using SSOT time anchor for parquet: "${resolvedDtCol}"`);
          }
        }
        
        // PRIORITY 2: Auto-detect from data
        if (!resolvedDtCol) {
          resolvedDtCol = detectDatetimeColumn(headers, rowsToProcess.slice(0, 2000), true);
        }
        
        if (resolvedDtCol) {
          // Parse datetime values from rowsToProcess (parquetResult.rows already freed)
          const sampleForDt = rowsToProcess.slice(0, Math.min(rowsToProcess.length, X.length));
          const dtVals: (number | null)[] = [];
          for (const row of sampleForDt) {
            const val = row[resolvedDtCol!];
            if (val) {
              const d = val instanceof Date ? val : new Date(String(val));
              dtVals.push(!isNaN(d.getTime()) ? d.getTime() : null);
            } else {
              dtVals.push(null);
            }
          }
          // Only use if we have enough parsed values
          if (dtVals.filter(v => v !== null).length >= X.length * 0.5) {
            (globalThis as any).__datetimeValues = dtVals.slice(0, X.length);
            (globalThis as any).__datetimeCol = resolvedDtCol;
            console.log(`[Split] Parquet datetime: "${resolvedDtCol}", ${dtVals.filter(v => v !== null).length}/${dtVals.length} parsed`);
          }
        }
        
        // Detect group key column
        if (!(globalThis as any).__datetimeCol) {
          const groupPatterns = /^(cliente|cnpj|cpf|codparc|cod_parc|entity|customer|client|account|empresa|company|numerounico|numero_unico)/i;
          for (const h of headers) {
            if (h === target_column) continue;
            if (groupPatterns.test(h.toLowerCase())) {
              const uniqueVals = new Set<string>();
              const grpVals: (string | null)[] = [];
              const sample = rowsToProcess.slice(0, Math.min(rowsToProcess.length, X.length));
              for (const row of sample) {
                const v = row[h] != null ? String(row[h]) : null;
                grpVals.push(v);
                if (v) uniqueVals.add(v);
              }
              const ratio = grpVals.length > 0 ? uniqueVals.size / grpVals.length : 0;
              if (ratio >= 0.05 && ratio <= 0.8) {
                (globalThis as any).__groupValues = grpVals.slice(0, X.length);
                (globalThis as any).__groupCol = h;
                console.log(`[Split] Parquet group key: "${h}" (ratio: ${(ratio * 100).toFixed(1)}%)`);
                break;
              }
            }
          }
        }
      }

      // Store feature names for later use
      (globalThis as any).__featureNames = allFeatureNames;
      (globalThis as any).__isTargetCategorical = isTargetCategorical;

    } else {
      // ========== CSV PATH (original logic) ==========
      let sampledLines: string[] = [];
      let isFirstFile = true;
      let totalBytesRead = 0;
      let reachedReadLimit = false;

      // For batch imports with canonical schema, use the canonical headers as master
      // This ensures all files are mapped to the same column order even if each file
      // has a different subset of columns (union-by-name).
      let canonicalHeaders: string[] | null = null;
      if (isBatchImport && sourceMetadata.canonical_schema_hash) {
        canonicalHeaders = (sourceMetadata.canonical_schema_hash as string).split("|").map(h => h.trim()).filter(Boolean);
        if (canonicalHeaders.length > 0) {
          headers = canonicalHeaders;
          console.log(`[AutoML] Usando canonical schema com ${canonicalHeaders.length} colunas para batch import`);
        } else {
          canonicalHeaders = null;
        }
      }

      console.log(`[AutoML] Iniciando leitura CSV... Delimiter: ${delimiter}`);

      // Per-file column mapping: maps canonical column index → file column index
      let fileColumnMap: number[] = [];

      // CRITICAL FIX: For batch imports with different schemas per file,
      // only count files that contain the target column toward the read limit.
      // Files without the target produce zero valid training rows (wasted reads).
      // Also, reading sequential rows from a single sorted file can produce
      // constant features, so we need to maximize coverage of the target-bearing files.
      let targetBearingFileCount = filePaths.length; // default: assume all
      if (isBatchImport && canonicalHeaders && filePaths.length > 1) {
        // Use manifest/metadata to identify which files have the target column
        const targetLower = target_column.toLowerCase().trim();
        const fileNames = (sourceMetadata.file_names as string[]) || [];
        const filesData = (sourceMetadata as any)?.files_detail || null;
        
        // Check canonical_schema_hash — target must be present in file's own schema
        // We detect this from import_manifest files data if available
        // Fallback: try reading headers from each file (expensive, skip for now)
        // Simpler heuristic: the canonical schema includes the target, but individual
        // files may not. We'll handle this by skipping files without target during reading.
        console.log(`[AutoML] Target column: "${target_column}" (lower: "${targetLower}")`);
        console.log(`[AutoML] Will skip files without target column during reading`);
        
        // We don't know which files have the target until we read headers,
        // so set a generous per-file limit and let the header check handle it
        targetBearingFileCount = filePaths.length;
      }
      
      const maxLinesPerFile = isBatchImport && filePaths.length > 1
        ? Math.ceil(effectiveMaxRowsToRead / targetBearingFileCount)
        : effectiveMaxRowsToRead;
      let fileLinesReadCount = 0; // tracks lines read from current file
      let filesWithTarget = 0; // count files that actually have the target
      let filesSkipped = 0; // count files skipped (no target column)

      // SYSTEMATIC SKIP SAMPLING: For large files (>effectiveMaxRowsToRead rows),
      // reading the first N rows sequentially from a sorted file produces constant
      // features (zero variance). Instead, compute a skip interval to spread the
      // sample across the entire file. E.g., for 2.7M rows wanting 40K: keep 1 in ~68.
      // We estimate file rows from import_jobs or totalDatasetRows.
      const fileRowEstimates: number[] = [];
      const fileNames = (sourceMetadata.file_names as string[]) || [];
      const rowsConsolidated = (sourceMetadata as any)?.rows_consolidated || totalDatasetRows;
      
      // Try to get per-file row counts from import_jobs
      {
        const { data: jobRows } = await supabase
          .from("import_jobs")
          .select("file_name, rows_processed, batch_sequence")
          .eq("project_id", project_id)
          .eq("status", "completed")
          .order("batch_sequence");
        
        if (jobRows && jobRows.length > 0 && jobRows.length === filePaths.length) {
          for (const jr of jobRows) {
            fileRowEstimates.push(jr.rows_processed || 0);
          }
          console.log(`[AutoML] Per-file row estimates from import_jobs: ${fileRowEstimates.map(r => r.toLocaleString()).join(", ")}`);
        } else {
          // Fallback: distribute total rows evenly
          const perFile = Math.ceil(totalDatasetRows / filePaths.length);
          for (let i = 0; i < filePaths.length; i++) fileRowEstimates.push(perFile);
        }
      }

      console.log(`[AutoML] Batch: ${isBatchImport}, files: ${filePaths.length}, max_per_file: ${maxLinesPerFile.toLocaleString()}`);

      for (let fileIndex = 0; fileIndex < filePaths.length && !reachedReadLimit; fileIndex++) {
        const filePath = filePaths[fileIndex];
        console.log(`[${fileIndex + 1}/${filePaths.length}] Streaming: ${filePath}`);
        
        // Calculate skip interval for this file to spread sample across entire file
        const estimatedFileRows = fileRowEstimates[fileIndex] || totalDatasetRows;
        const desiredFromFile = Math.min(maxLinesPerFile, effectiveMaxRowsToRead - totalLinesRead);
        const skipInterval = estimatedFileRows > desiredFromFile * 2
          ? Math.floor(estimatedFileRows / desiredFromFile)
          : 1; // No skipping for small files
        
        console.log(`  Skip sampling: estimated ${estimatedFileRows.toLocaleString()} rows, want ${desiredFromFile.toLocaleString()}, skip_interval=${skipInterval}`);
        
        try {
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from("datasets")
            .createSignedUrl(filePath, 3600);

          if (signedUrlError || !signedUrlData?.signedUrl) {
            console.error(`Erro ao criar URL assinada para ${filePath}:`, signedUrlError);
            continue;
          }

          const response = await fetch(signedUrlData.signedUrl);
          if (!response.ok || !response.body) {
            console.error(`Erro ao baixar ${filePath}: HTTP ${response.status}`);
            continue;
          }

          const reader = response.body.getReader();
          const encoding = sourceMetadata.encoding || "utf-8";
          const decoder = new TextDecoder(encoding);
          let bytesRead = 0;
          let buffer = "";
          let fileLinesCount = 0;
          fileLinesReadCount = 0; // reset per-file counter
          let fileDataLineIndex = 0; // total data lines seen in this file (for skip sampling)
          let isFirstLineOfFile = true;
          let lastProgressLog = 0;
          let shouldStopReading = false;
          
          while (!shouldStopReading) {
            const { done, value } = await reader.read();
            if (done) break;

            bytesRead += value?.length || 0;
            buffer += decoder.decode(value, { stream: true });

            const lineBreaks = buffer.split(/\r?\n/);
            
            for (let i = 0; i < lineBreaks.length - 1; i++) {
              const line = lineBreaks[i].trim();
              if (!line) continue;
              
              fileLinesCount++;
              
              if (isFirstLineOfFile) {
                // Detect delimiter on the very first file
                if (isFirstFile && !canonicalHeaders) {
                  const expectedColCount = columns.length;
                  let testHeaders = parseCSVLine(line, delimiter);
                  
                  if (testHeaders.length !== expectedColCount && expectedColCount > 0) {
                    console.log(`[AutoML] Delimiter "${delimiter}" produced ${testHeaders.length} cols, expected ${expectedColCount}. Trying auto-detect...`);
                    const candidates = [",", ";", "\t", "|"];
                    for (const d of candidates) {
                      const test = parseCSVLine(line, d);
                      if (test.length === expectedColCount) {
                        console.log(`[AutoML] Delimiter "${d}" matches expected ${expectedColCount} cols. Switching.`);
                        delimiter = d;
                        testHeaders = test;
                        break;
                      }
                    }
                    if (testHeaders.length !== expectedColCount) {
                      const detected = autoDetectDelimiter(line);
                      if (detected !== delimiter) {
                        console.log(`[AutoML] No exact match. Using auto-detected "${detected}".`);
                        delimiter = detected;
                      }
                    }
                  }
                }

                // Parse file-specific headers
                const fileHeaders = parseCSVLine(line, delimiter);
                
                if (canonicalHeaders) {
                  // Build mapping: for each canonical column, find its index in this file's headers
                  fileColumnMap = canonicalHeaders.map(ch => {
                    const exact = fileHeaders.indexOf(ch);
                    if (exact !== -1) return exact;
                    const lower = ch.toLowerCase().trim();
                    return fileHeaders.findIndex(fh => fh.toLowerCase().trim() === lower);
                  });
                  const matched = fileColumnMap.filter(i => i !== -1).length;
                  console.log(`  File headers: ${fileHeaders.length} cols, mapped ${matched}/${canonicalHeaders.length} to canonical schema`);
                  
                  // CRITICAL: Check if this file contains the target column.
                  // If not, ALL rows from this file will be discarded (invalid target),
                  // so skip reading it entirely to save the read budget for files that matter.
                  const targetCanonicalIdx = findHeaderIndex(canonicalHeaders, target_column);
                  const fileHasTarget = targetCanonicalIdx !== -1 && fileColumnMap[targetCanonicalIdx] !== -1;
                  if (!fileHasTarget) {
                    filesSkipped++;
                    console.log(`  SKIP: File does not contain target "${target_column}" — no valid training rows possible`);
                    isFirstLineOfFile = false;
                    shouldStopReading = true; // skip to next file
                    continue;
                  }
                  filesWithTarget++;
                } else if (isFirstFile) {
                  // No canonical schema — use first file's headers as master
                  headers = fileHeaders;
                  fileColumnMap = fileHeaders.map((_, idx) => idx); // identity mapping
                  console.log(`Headers detectados: ${headers.slice(0, 5).join(", ")}... (${headers.length} total, delimiter="${delimiter}")`);
                  filesWithTarget++;
                } else {
                  // Subsequent file without canonical: check if headers match master
                  const matchesHeaders = fileHeaders.length === headers.length && 
                    fileHeaders.slice(0, 3).every((h, idx) => h === headers[idx]);
                  if (!matchesHeaders) {
                    // Different columns — build mapping to master headers
                    fileColumnMap = headers.map(mh => {
                      const exact = fileHeaders.indexOf(mh);
                      if (exact !== -1) return exact;
                      const lower = mh.toLowerCase().trim();
                      return fileHeaders.findIndex(fh => fh.toLowerCase().trim() === lower);
                    });
                    const matched = fileColumnMap.filter(i => i !== -1).length;
                    console.log(`  File headers differ from master. Mapped ${matched}/${headers.length}`);
                  } else {
                    fileColumnMap = fileHeaders.map((_, idx) => idx);
                  }
                  
                  // Check if this file has the target (skip check for virtual _label_)
                  if (target_column !== "_label_") {
                    const targetIdx = findHeaderIndex(fileHeaders, target_column);
                    if (targetIdx === -1) {
                      filesSkipped++;
                      console.log(`  SKIP: File does not contain target "${target_column}"`);
                      isFirstLineOfFile = false;
                      shouldStopReading = true;
                      continue;
                    }
                  }
                  filesWithTarget++;
                }
                
                isFirstLineOfFile = false;
              } else {
                // Data row
                fileDataLineIndex++;
                
                // SYSTEMATIC SKIP SAMPLING: only keep every Nth row to spread
                // sample across the entire file (avoids zero-variance from sorted data)
                if (skipInterval > 1 && (fileDataLineIndex % skipInterval) !== 0) {
                  // Skip this row — don't count it toward read limits
                  continue;
                }
                
                totalLinesRead++;
                fileLinesReadCount++;

                if (canonicalHeaders) {
                  // Remap this line's values to canonical column order
                  const fileValues = parseCSVLine(line, delimiter);
                  const remapped = fileColumnMap.map(idx => idx !== -1 ? (fileValues[idx] ?? "") : "");
                  // Reconstruct as a delimited line using the same delimiter
                  sampledLines.push(remapped.join(delimiter));
                } else {
                  sampledLines.push(line);
                }
              }
              
              // Check early stop: global limit OR per-file limit (for batch imports)
              if (!useFullDataset && totalLinesRead >= effectiveMaxRowsToRead) {
                shouldStopReading = true;
                reachedReadLimit = true;
                console.log(`  Early stop (global): lidas ${totalLinesRead.toLocaleString()} linhas`);
                break;
              }
              // Per-file limit only applies when multiple files have the target
              if (!useFullDataset && filesWithTarget > 1 && fileLinesReadCount >= Math.ceil(effectiveMaxRowsToRead / filesWithTarget)) {
                shouldStopReading = true;
                console.log(`  Per-file limit reached: ${fileLinesReadCount.toLocaleString()} linhas from file ${fileIndex + 1} (${filesWithTarget} target files)`);
                break;
              }
            }
            
            buffer = lineBreaks[lineBreaks.length - 1];
            
            const mbRead = bytesRead / (1024 * 1024);
            if (mbRead - lastProgressLog >= 50) {
              console.log(`  Progresso: ${mbRead.toFixed(1)} MB, ${totalLinesRead.toLocaleString()} linhas lidas`);
              lastProgressLog = mbRead;
            }
          }

          if (shouldStopReading) {
            try { await reader.cancel(); } catch (_) { /* ignore */ }
          }

          isFirstFile = false;
          totalBytesRead += bytesRead;

          console.log(`  Arquivo: ${(bytesRead / (1024 * 1024)).toFixed(2)} MB, ${fileLinesCount} linhas`);

        } catch (err) {
          console.error(`Erro processando ${filePath}:`, err);
          continue;
        }
      }

      console.log(`\n[AutoML] Files with target: ${filesWithTarget}, files skipped: ${filesSkipped}`);

      // Apply final sampling (resource_guard: stratified for CSV)
      let finalSampledLines: string[];
      
      if (useFullDataset || sampledLines.length <= effectiveTargetSampleSize) {
        finalSampledLines = sampledLines;
        console.log(`\n[resource_guard] Usando todas as ${sampledLines.length.toLocaleString()} linhas lidas`);
      } else {
        console.log(`\n[resource_guard] Amostragem ${sampleStrategy}: ${sampledLines.length.toLocaleString()} → ${effectiveTargetSampleSize.toLocaleString()} linhas`);
        // For CSV, stratification is done post-parse when we have target values
        // Here we do random sampling; stratification happens in-context when target is known
        const shuffledLines = shuffle(sampledLines);
        finalSampledLines = shuffledLines.slice(0, effectiveTargetSampleSize);
      }

      console.log(`\n=== Resumo da leitura CSV ===`);
      console.log(`Total de arquivos: ${filePaths.length}`);
      console.log(`Total de bytes: ${(totalBytesRead / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Linhas lidas: ${totalLinesRead.toLocaleString()}`);
      console.log(`Linhas na amostra final: ${finalSampledLines.length.toLocaleString()}`);

      if (headers.length === 0 || finalSampledLines.length === 0) {
        return new Response(JSON.stringify({ error: "Não foi possível ler dados do dataset" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ── Materialize _label_ for CSV path (virtual target from label builder) ──
      if (target_column === "_label_" && !headers.includes("_label_")) {
        const labelPlan = modelingDataset?.label_plan as Record<string, any> | null;
        const labelStrategy = labelPlan?.strategy || "unknown";
        console.log(`[AutoML-CSV] Materializing _label_ target (strategy: ${labelStrategy})`);

        // Add _label_ as last column in headers
        headers.push("_label_");
        const labelColIdx = headers.length - 1;

        // For CSV, finalSampledLines are raw CSV strings. We need to append the label value.
        // We'll do a simple approach: append ",0" or ",1" based on strategy.
        // For proper materialization, we parse needed columns from each line.

        if (labelStrategy === "state_change") {
          const timeAnchorCol = labelPlan?.time_anchor || null;
          const entityKeyCol = labelPlan?.entity_key || null;
          const windowDays = labelPlan?.window_days || 90;
          const timeIdx = timeAnchorCol ? findHeaderIndex(headers, timeAnchorCol) : -1;
          const entityIdx = entityKeyCol ? findHeaderIndex(headers, entityKeyCol) : -1;

          if (timeIdx !== -1 && entityIdx !== -1) {
            // Two-pass: find max date per entity, then assign labels
            const entityMaxDate = new Map<string, number>();
            for (const line of finalSampledLines) {
              const cols = line.split(delimiter);
              const eid = (cols[entityIdx] || "").trim();
              const dateVal = Date.parse(cols[timeIdx] || "");
              if (!isNaN(dateVal) && eid) {
                const prev = entityMaxDate.get(eid) || 0;
                if (dateVal > prev) entityMaxDate.set(eid, dateVal);
              }
            }
            const allDates = [...entityMaxDate.values()];
            const refDate = allDates.length > 0 ? Math.max(...allDates) : Date.now();
            const cutoffMs = windowDays * 86400000;

            finalSampledLines = finalSampledLines.map(line => {
              const cols = line.split(delimiter);
              const eid = (cols[entityIdx] || "").trim();
              const lastActivity = entityMaxDate.get(eid) || 0;
              const label = (refDate - lastActivity) > cutoffMs ? 1 : 0;
              return line + delimiter + String(label);
            });
            console.log(`[AutoML-CSV] _label_ materialized: state_change, window=${windowDays}d`);
          } else {
            finalSampledLines = finalSampledLines.map(line => line + delimiter + "0");
            trainingWarningsGlobal.push("_label_ materialized with CSV fallback (time/entity columns not resolved).");
          }
        } else if (labelStrategy === "direct") {
          const statusCol = labelPlan?.status_column || null;
          const positiveValues = labelPlan?.positive_values || ["1", "sim", "yes", "true", "ativo", "active"];
          const statusIdx = statusCol ? findHeaderIndex(headers, statusCol) : -1;
          if (statusIdx !== -1) {
            finalSampledLines = finalSampledLines.map(line => {
              const cols = line.split(delimiter);
              const val = (cols[statusIdx] || "").trim().toLowerCase();
              const label = positiveValues.some((pv: string) => val.includes(pv.toLowerCase())) ? 1 : 0;
              return line + delimiter + String(label);
            });
            console.log(`[AutoML-CSV] _label_ materialized: direct from "${statusCol}"`);
          } else {
            finalSampledLines = finalSampledLines.map(line => line + delimiter + "0");
            trainingWarningsGlobal.push("_label_ materialized with CSV fallback (status column not resolved).");
          }
        } else {
          finalSampledLines = finalSampledLines.map(line => line + delimiter + "0");
          trainingWarningsGlobal.push(`_label_ strategy "${labelStrategy}" not fully supported for CSV. Using fallback.`);
        }
      }

      // Find target column index (case-insensitive fallback)
      // When using human labels, target column may not exist in dataset — skip validation
      const targetIndex = useHumanLabelsAsTarget ? -1 : findHeaderIndex(headers, target_column);
      if (!useHumanLabelsAsTarget && targetIndex === -1) {
        console.error(`Coluna alvo "${target_column}" não encontrada. Colunas disponíveis: ${headers.slice(0, 20).join(", ")}`);
        return new Response(JSON.stringify({ 
          error: `Coluna alvo "${target_column}" não encontrada no dataset.`,
          available_columns: headers.slice(0, 20)
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get numeric feature columns (case-insensitive matching)
      const numericColumns = columns.filter(c => 
        (c.inferred_type === "numérico" || c.inferred_type === "numerico") && c.column_name !== target_column
      );
      const featureIndices = numericColumns.map(c => findHeaderIndex(headers, c.column_name)).filter(i => i !== -1);
      const baseFeatureNames = featureIndices.map(i => headers[i]);
      const engineeredFeatureNames = enabledFeatures.map(f => f.name);
      const allFeatureNames = [...baseFeatureNames, ...engineeredFeatureNames];

      if (baseFeatureNames.length === 0) {
        return new Response(JSON.stringify({ error: "Nenhuma feature numérica encontrada." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`\nFeatures base: ${baseFeatureNames.length} colunas numéricas`);
      console.log(`Features engenharia: ${engineeredFeatureNames.length}`);
      console.log(`Total features: ${allFeatureNames.length}`);

      // Check if target is categorical
      const targetColumnInfo = columns.find(c => c.column_name === target_column);
      const isTargetCategorical = targetColumnInfo?.inferred_type === "categórico" || 
                                    targetColumnInfo?.inferred_type === "categorico" ||
                                    targetColumnInfo?.inferred_type === "texto";

      console.log(`Target: ${target_column} (categorical: ${isTargetCategorical})`);

      // Parse data with engineered features
      for (let i = 0; i < finalSampledLines.length; i++) {
        const values = parseCSVLine(finalSampledLines[i], delimiter);
        
        if (!useHumanLabelsAsTarget && isTargetCategorical) {
          const targetVal = values[targetIndex]?.trim() || "";
          if (targetVal && !labelMap.has(targetVal)) {
            labelMap.set(targetVal, labelMap.size);
          }
        }
        
        // Build raw record for feature engineering
        const rawRecord: Record<string, string | number | null> = {};
        headers.forEach((h, idx) => {
          rawRecord[h] = values[idx] || null;
        });
        
        // Get base features (impute NaN → 0 for missing columns in batch imports)
        const baseFeatures = featureIndices.map(idx => {
          const val = values[idx]?.replace(",", ".") || "";
          const parsed = parseFloat(val);
          return isNaN(parsed) ? 0 : parsed;
        });
        
        // Apply engineered features
        const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
        const engineeredFeatures = engineeredFeatureNames.map(name => {
          const val = engineeredValues[name];
          return typeof val === "number" ? val : 0;
        });
        
        const allFeatures = [...baseFeatures, ...engineeredFeatures];
        
        if (useHumanLabelsAsTarget) {
          // For human mode, just load features — y will be overridden later
          X.push(allFeatures);
          y.push(0); // placeholder
        } else {
          let targetNumeric: number;
          if (isTargetCategorical) {
            const targetVal = values[targetIndex]?.trim() || "";
            targetNumeric = labelMap.get(targetVal) ?? -1;
          } else {
            targetNumeric = parseFloat(values[targetIndex]?.replace(",", ".") || "");
          }
          
          // Only require valid target; missing features are imputed to 0
          const hasValidTarget = isTargetCategorical ? targetNumeric !== -1 : !isNaN(targetNumeric);
          if (hasValidTarget) {
            X.push(allFeatures);
            y.push(targetNumeric);
          }
        }
        
        finalSampledLines[i] = "";
      }
      
      sampledLines.length = 0;
      finalSampledLines.length = 0;

      // Detect datetime column for smart split (CSV path)
      // We need to re-parse a sample to get datetime and group values
      // Since we already consumed the lines, we detect from column names + type heuristics
      {
        const datePatterns = /^(data|dt_|date|timestamp|created|updated|dataneg|data_neg)/i;
        const dtCandidates = headers.filter(h => datePatterns.test(h.toLowerCase()));
        
        if (dtCandidates.length > 0) {
          // We can't re-read CSV data, but we stored rawRecords during parsing
          // Instead, mark the column and rely on column ordering heuristic
          console.log(`[Split] CSV datetime candidates: ${dtCandidates.join(", ")}`);
          // Since we consumed the data, use ordering of X rows as proxy for temporal order
          // This is approximate but better than random for temporal data
          (globalThis as any).__datetimeCol = dtCandidates[0];
          // Create sequential timestamps as proxy for temporal ordering
          const dtVals: (number | null)[] = X.map((_, i) => i);
          (globalThis as any).__datetimeValues = dtVals;
        }
        
        // Detect group key
        if (!(globalThis as any).__datetimeCol) {
          const groupPatterns = /^(cliente|cnpj|cpf|codparc|cod_parc|entity|customer|client|account|empresa|company|numerounico|numero_unico)/i;
          for (const h of headers) {
            if (h === target_column) continue;
            if (groupPatterns.test(h.toLowerCase())) {
              console.log(`[Split] CSV group key candidate: "${h}"`);
              (globalThis as any).__groupCol = h;
              // Without re-reading CSV, we can't extract group values 
              // Fall through to random split
              break;
            }
          }
        }
      }

      // Store feature names for later use
      (globalThis as any).__featureNames = allFeatureNames;
      (globalThis as any).__isTargetCategorical = isTargetCategorical;
    }
    
    // Retrieve shared variables set by either branch
    const allFeatureNames: string[] = (globalThis as any).__featureNames;
    const isTargetCategorical: boolean = (globalThis as any).__isTargetCategorical;

    if (isTargetCategorical && labelMap.size > 0) {
      console.log(`Label encoding: ${JSON.stringify(Object.fromEntries(labelMap))}`);
    }

    console.log(`\nDados válidos: ${X.length.toLocaleString()} amostras, ${allFeatureNames.length} features`);

    // ── HUMAN TARGET OVERRIDE ──
    // When active_target_mode='human', replace y with human labels.
    // The human labels were already validated in Gate 2 (active target resolution).
    if (useHumanLabelsAsTarget && humanTargetStats && humanTargetStats.values.length > 0) {
      console.log(`\n[HUMAN-TARGET] Overriding y vector from human labels (${humanTargetStats.values.length} labels)`);
      // Use human labels as y. X was loaded from dataset (features only).
      // Since human labels may be fewer than dataset rows, truncate X to match.
      const humanY = humanTargetStats.values;
      if (humanY.length < X.length) {
        // Use only as many X rows as we have labels (take from beginning, shuffled)
        X.length = humanY.length;
      }
      y.length = 0;
      y.push(...humanY.slice(0, X.length));
      console.log(`[HUMAN-TARGET] Final: X=${X.length}, y=${y.length}, pos=${humanTargetStats.pos}, neg=${humanTargetStats.neg}`);
    }

    // Determine minimum samples based on active target mode
    const minSamplesRequired = useHumanLabelsAsTarget ? 30 : 100;

    if (X.length < minSamplesRequired) {
      const diagHeaders = (globalThis as any).__featureNames || [];
      console.error(`[DIAGNOSTIC] 0 samples failure:`);
      console.error(`  target_column: ${target_column}`);
      console.error(`  problem_type: ${problem_type}`);
      console.error(`  delimiter used: "${delimiter}"`);
      console.error(`  headers count: ${headers?.length || 0}`);
      console.error(`  headers (first 10): ${headers?.slice(0, 10).join(', ')}`);
      console.error(`  features count: ${diagHeaders.length}`);
      console.error(`  totalLinesRead: ${totalLinesRead}`);
      console.error(`  X.length (valid samples): ${X.length}`);
      console.error(`  y.length: ${y.length}`);
      console.error(`  filePaths: ${filePaths.map(p => p.split('/').pop()).join(', ')}`);
      console.error(`  isBatchImport: ${isBatchImport}`);
      console.error(`  target in headers: ${headers?.some(h => h.toLowerCase().trim() === target_column.toLowerCase().trim())}`);
      
      return new Response(JSON.stringify({ 
        error: `Dados insuficientes após parsing (${X.length} amostras válidas, mínimo: ${minSamplesRequired}). Verifique a qualidade dos dados.`,
        diagnostic: {
          target_column,
          problem_type,
          delimiter,
          headers_count: headers?.length || 0,
          headers_sample: headers?.slice(0, 10),
          total_lines_read: totalLinesRead,
          valid_samples: X.length,
          file_paths: filePaths.map(p => p.split('/').pop()),
          is_batch: isBatchImport,
          target_in_headers: headers?.some(h => h.toLowerCase().trim() === target_column.toLowerCase().trim()),
        }
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ==================== MVP-SOFT: Pre-training Preparation ====================
    console.log(`\n=== MVP-Soft Preparation ===`);
    const mvpSoftWarnings: string[] = [];
    const mvpSoftCoercions: string[] = [];

    // Log preparation start
    try {
      await supabase.from("platform_events").insert({
        event_type: "training_prepare_started",
        project_id: project_id,
        source: "edge",
        status: "info",
        metadata: {
          rows: X.length,
          features: allFeatureNames.length,
          problem_type,
          target_column,
          dataset_version: settings?.dataset_version || 0,
          selection_version: currentSelectionVersion,
        },
      });
    } catch (_) { /* best-effort */ }

    // ── MVP-Soft A: Target Type Mismatch Detection ──
    {
      // Reconstruct raw y values for type detection
      const rawYForDetection: (string | number | null)[] = [];
      if (isTargetCategorical && labelMap.size > 0) {
        const reverseLabelMap = new Map<number, string>();
        for (const [k, v] of labelMap.entries()) reverseLabelMap.set(v, k);
        for (const val of y) rawYForDetection.push(reverseLabelMap.get(val) ?? val);
      } else {
        for (const val of y) rawYForDetection.push(val);
      }

      const targetDetection = detectTargetType(rawYForDetection);
      console.log(`[MVP-Soft] Target type detected: ${targetDetection.type} (distinct=${targetDetection.distinct_count}, strings=${targetDetection.has_strings})`);

      const mismatch = validateTargetTypeMismatch(problem_type, targetDetection);
      if (!mismatch.valid) {
        console.error(`[MVP-Soft] TARGET_TYPE_MISMATCH: ${mismatch.message}`);

        safeFire(supabase.from("platform_events").insert({
          event_type: "target_type_mismatch",
          project_id: project_id,
          source: "edge",
          status: "blocked",
          metadata: {
            problem_type,
            target_type_real: targetDetection.type,
            distinct_count: targetDetection.distinct_count,
            suggestion: mismatch.suggestion,
          },
        }));

        return blockResponse(
          "TARGET_TYPE_MISMATCH",
          mismatch.message!,
          { label: mismatch.suggestion === "classification" ? "Trocar para classificação" : "Trocar para regressão", go_to_step: 3 },
          {
            problem_type,
            target_type_real: targetDetection.type,
            distinct_count: targetDetection.distinct_count,
            suggestion: mismatch.suggestion,
            fix_suggestions: [
              { label: mismatch.suggestion === "classification" ? "Trocar para Classificação" : "Trocar para Regressão", action: `change_problem_type_${mismatch.suggestion}` },
              { label: "Revisar Target", action: "open_target_step" },
            ],
          }
        );
      }
    }

    // ── MVP-Soft B: Low Variance / Constant Target ──
    {
      const lowVarCheck = checkLowVariance(y, problem_type);
      if (lowVarCheck.blocked) {
        console.error(`[MVP-Soft] ${lowVarCheck.code}: ${lowVarCheck.message}`);

        safeFire(supabase.from("platform_events").insert({
          event_type: "training_prepare_blocked",
          project_id: project_id,
          source: "edge",
          status: "blocked",
          metadata: { code: lowVarCheck.code, message: lowVarCheck.message },
        }));

        return blockResponse(
          lowVarCheck.code!,
          lowVarCheck.message!,
          { label: "Revisar Target", go_to_step: 3 },
          {
            fix_suggestions: [
              { label: "Ajustar janela / critério do alvo", action: "open_target_step" },
              { label: "Revisar regras do alvo", action: "open_target_step" },
            ],
          }
        );
      }
    }

    // ── MVP-Soft: Persist target_trainability_report (passed) ──
    {
      const targetStats = computeTargetStats(y, problem_type === "classification");
      const trainabilityReport = {
        trainable: true,
        reason_code: null,
        details: {
          n_rows: y.length,
          n_non_null: targetStats.n_valid,
          distinct_count: targetStats.n_unique,
          target_type_real: targetStats.target_type_real,
          sampled: { on: X.length < (dsState?.row_count || 0), size: X.length },
        },
        fix_suggestions: [],
        warnings: mvpSoftWarnings || [],
      };
      safeFire(supabase.from("project_settings")
        .update({ target_trainability_report: trainabilityReport })
        .eq("project_id", project_id));
    }

    // ── MVP-Soft C: Row Sampling (cap at TRAINING_ROW_CAP for large datasets) ──
    const TRAINING_ROW_CAP = 200_000;
    if (X.length > TRAINING_ROW_CAP) {
      console.log(`[MVP-Soft] Dataset exceeds row cap: ${X.length.toLocaleString()} > ${TRAINING_ROW_CAP.toLocaleString()}`);
      const samplingResult = mvpSampleRows(
        X.map((row, i) => ({ row, idx: i })),
        TRAINING_ROW_CAP,
        y,
        problem_type,
      );

      const newX = samplingResult.sampled.map(s => s.row);
      const newY = samplingResult.sampledY;

      mvpSoftWarnings.push(`Dataset amostrado: ${X.length.toLocaleString()} → ${newX.length.toLocaleString()} linhas (estratégia: ${samplingResult.strategy})`);

      // Replace X and y in-place
      X.length = 0;
      X.push(...newX);
      y.length = 0;
      y.push(...newY);

      console.log(`[MVP-Soft] Sampled: ${newX.length.toLocaleString()} rows (strategy: ${samplingResult.strategy})`);

      safeFire(supabase.from("platform_events").insert({
        event_type: "training_prepare_sampled",
        project_id: project_id,
        source: "edge",
        status: "info",
        metadata: {
          sample_strategy: samplingResult.strategy,
          original_rows: newX.length + (X.length - newX.length),
          used_rows: newX.length,
        },
      }));
    }

    // ── MVP-Soft D: Robust type coercion on X (NaN handling, boolean/string coercion) ──
    {
      let coercedCount = 0;
      for (let i = 0; i < X.length; i++) {
        for (let j = 0; j < X[i].length; j++) {
          const val = X[i][j];
          if (isNaN(val) || !isFinite(val)) {
            // Will be handled by imputation below
            continue;
          }
        }
      }

      // Per-feature NaN imputation (median for numeric)
      if (X.length > 0 && X[0].length > 0) {
        const nFeatures = X[0].length;
        for (let j = 0; j < nFeatures; j++) {
          const col = X.map(row => row[j]);
          const nanCount = col.filter(v => isNaN(v) || !isFinite(v)).length;
          if (nanCount > 0) {
            // Compute median of valid values
            const valid = col.filter(v => !isNaN(v) && isFinite(v));
            let median = 0;
            if (valid.length > 0) {
              const sorted = [...valid].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
            }
            for (let i = 0; i < X.length; i++) {
              if (isNaN(X[i][j]) || !isFinite(X[i][j])) {
                X[i][j] = median;
                coercedCount++;
              }
            }
            if (nanCount > col.length * 0.1) {
              mvpSoftCoercions.push(`${allFeatureNames[j]}: ${nanCount} NaN → median(${median.toFixed(2)})`);
            }
          }
        }
      }

      if (coercedCount > 0) {
        console.log(`[MVP-Soft] Coerced ${coercedCount} NaN values via median imputation`);
      }
    }

    // ── MVP-Soft: Target Stats ──
    {
      const targetStats = computeTargetStats(y, problem_type === "classification");
      console.log(`[MVP-Soft] Target stats: valid=${targetStats.n_valid}, null=${targetStats.n_null}, unique=${targetStats.n_unique}, std=${targetStats.std.toFixed(4)}`);
    }

    // Log MVP-Soft warnings
    if (mvpSoftWarnings.length > 0 || mvpSoftCoercions.length > 0) {
      trainingWarningsGlobal.push(...mvpSoftWarnings);
      safeFire(supabase.from("platform_events").insert({
        event_type: "training_prepare_warning",
        project_id: project_id,
        source: "edge",
        status: "warning",
        metadata: {
          warnings: mvpSoftWarnings,
          coercions: mvpSoftCoercions,
        },
      }));
    }

    // Log preparation success
    safeFire(supabase.from("platform_events").insert({
      event_type: "training_prepare_success",
      project_id: project_id,
      source: "edge",
      status: "success",
      metadata: {
        used_rows: X.length,
        n_features_final: allFeatureNames.length,
        target_type_real: problem_type,
        coercions_count: mvpSoftCoercions.length,
        warnings_count: mvpSoftWarnings.length,
      },
    }));

    console.log(`[MVP-Soft] ✅ Preparation complete: ${X.length} rows, ${allFeatureNames.length} features`);

    // ==================== PREFLIGHT VALIDATION ====================
    console.log(`\n=== Preflight Validation ===`);

    // ── A0: Canonical Target Trainability Check ──
    {
      // Collect raw target values for trainability evaluation
      const rawTargetValues: (string | number | null)[] = [];
      // Use y (already parsed) but also reconstruct raw values for analysis
      if (y.length > 0) {
        // For trainability, we use the numeric y mapped back to labels
        if (isTargetCategorical && labelMap.size > 0) {
          const reverseLabelMap = new Map<number, string>();
          for (const [k, v] of labelMap.entries()) reverseLabelMap.set(v, k);
          for (const val of y) {
            rawTargetValues.push(reverseLabelMap.get(val) ?? String(val));
          }
        } else {
          for (const val of y) rawTargetValues.push(val);
        }
      }

      // Determine target_source from settings
      const { data: trainSettingsForSource } = await supabase
        .from("project_settings")
        .select("target_source, weak_label_result, human_label_result")
        .eq("project_id", project_id)
        .maybeSingle();

      const targetSourceVal = (trainSettingsForSource as any)?.target_source || "manual";

      const trainabilityResult = evaluateTargetTrainability({
        target_values: rawTargetValues,
        target_column,
        problem_type,
        target_source: targetSourceVal,
        weak_label_result: (trainSettingsForSource as any)?.weak_label_result || null,
        human_label_result: (trainSettingsForSource as any)?.human_label_result || null,
      });

      console.log(`[Trainability] trainable=${trainabilityResult.trainable}, reason=${trainabilityResult.reason_code}`);

      if (!trainabilityResult.trainable) {
        const humanMsg = trainabilityHumanMessage(trainabilityResult);
        console.error(`[Trainability] ⛔ ${humanMsg}`);

        // Persist to SSOT
        await supabase.from("project_settings")
          .update({ target_trainability_report: trainabilityResult })
          .eq("project_id", project_id);

        // Update pipeline state — block training + cascade downstream
        await supabase.rpc("rpc_update_pipeline_state", {
          p_project_id: project_id,
          p_stage: "training",
          p_new_state: "failed",
        });
        // Cascade: prevent scoring/dashboard from running on stale/invalid training
        await Promise.all([
          supabase.rpc("rpc_update_pipeline_state", {
            p_project_id: project_id,
            p_stage: "scoring",
            p_new_state: "idle",
          }),
          supabase.rpc("rpc_update_pipeline_state", {
            p_project_id: project_id,
            p_stage: "dashboard",
            p_new_state: "idle",
          }),
        ]);

        await supabase.from("projects").update({ status: "target_invalid" }).eq("id", project_id);

        return new Response(JSON.stringify({
          success: false,
          error: humanMsg,
          error_code: "TARGET_NOT_TRAINABLE",
          reason_code: trainabilityResult.reason_code,
          details: trainabilityResult.details,
          fix_suggestions: trainabilityResult.fix_suggestions,
          warnings: trainabilityResult.warnings,
          action: "review_target",
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else {
        // Persist passing result too
        await supabase.from("project_settings")
          .update({ target_trainability_report: trainabilityResult })
          .eq("project_id", project_id);

        if (trainabilityResult.warnings.length > 0) {
          trainingWarningsGlobal.push(...trainabilityResult.warnings);
        }
      }
    }

    // A1: Validate target (legacy check — kept for backward compat)
    const targetValidation = validateTarget(y, target_column, problem_type, isTargetCategorical, labelMap);
    
    if (targetValidation.issues.length > 0) {
      console.warn(`[Preflight] Target issues:`);
      targetValidation.issues.forEach(i => console.warn(`  ❌ ${i}`));
    }
    if (targetValidation.suggestions.length > 0) {
      targetValidation.suggestions.forEach(s => console.log(`  💡 ${s}`));
    }

    // Block training if target is critically invalid (legacy fallback)
    const criticalTargetIssues = targetValidation.issues.filter(i => 
      i.includes("variância zero") || 
      i.includes("cardinalidade 1") ||
      i.includes("ID sequencial")
    );
    
    if (criticalTargetIssues.length > 0) {
      console.error(`[Preflight] ⛔ Target inválido — treinamento bloqueado.`);
      
      await supabase.from("projects").update({ status: "target_invalid" }).eq("id", project_id);
      
      return new Response(JSON.stringify({
        success: false,
        error: "Target inválido para treinamento",
        error_code: "TARGET_NOT_TRAINABLE",
        preflight_report: {
          target_valid: false,
          target_issues: targetValidation.issues,
          target_suggestions: targetValidation.suggestions,
          features_blocked: [],
          features_block_reasons: {},
          warnings: [],
        },
        details: criticalTargetIssues.join("; "),
        action: "review_target"
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // A2: Validate features
    const featureValidation = validateFeatures(allFeatureNames, X, target_column, y);
    
    if (featureValidation.blocked.length > 0) {
      console.warn(`[Preflight] Features blocked (${featureValidation.blocked.length}):`);
      featureValidation.blocked.forEach(f => console.warn(`  ❌ ${f}: ${featureValidation.blockReasons[f]}`));
    }
    if (featureValidation.warnings.length > 0) {
      featureValidation.warnings.forEach(w => console.warn(`  ⚠️ ${w}`));
    }

    // Remove blocked features from X and allFeatureNames
    let filteredFeatureNames = allFeatureNames;
    let filteredX = X;
    
    if (featureValidation.blocked.length > 0) {
      const blockedIndices = new Set(featureValidation.blocked.map(name => allFeatureNames.indexOf(name)).filter(i => i !== -1));
      filteredFeatureNames = allFeatureNames.filter((_, i) => !blockedIndices.has(i));
      filteredX = X.map(row => row.filter((_, i) => !blockedIndices.has(i)));
      
      console.log(`[Preflight] Features após filtragem: ${filteredFeatureNames.length} (removidas: ${featureValidation.blocked.length})`);
      
      if (filteredFeatureNames.length === 0) {
        // ── NO_VALID_FEATURES diagnostic ──
        // Build per-column diagnostic from the raw data
        const featureDiagnostic: Record<string, { n_unique: number; pct_null: number; reason: string }> = {};
        for (const fName of featureValidation.blocked) {
          const fIdx = allFeatureNames.indexOf(fName);
          if (fIdx === -1) {
            featureDiagnostic[fName] = { n_unique: 0, pct_null: 100, reason: featureValidation.blockReasons[fName] || "unknown" };
            continue;
          }
          const col = X.map(row => row[fIdx]);
          const nNull = col.filter(v => v === null || v === undefined || isNaN(v as number)).length;
          const nUnique = new Set(col.filter(v => v !== null && v !== undefined && !isNaN(v as number))).size;
          featureDiagnostic[fName] = {
            n_unique: nUnique,
            pct_null: col.length > 0 ? Math.round((nNull / col.length) * 10000) / 100 : 0,
            reason: featureValidation.blockReasons[fName] || "unknown",
          };
        }

        // Aggregate block reasons
        const topBlockReasons: Record<string, number> = {};
        for (const reason of Object.values(featureValidation.blockReasons)) {
          const bucket = reason.includes("Variância zero") ? "zero_variance"
            : reason.includes("Correlação") ? "leakage_correlation"
            : reason.includes("ID") || reason.includes("chave") ? "id_key"
            : "other";
          topBlockReasons[bucket] = (topBlockReasons[bucket] || 0) + 1;
        }

        // Top 20 examples
        const examples = Object.entries(featureDiagnostic)
          .slice(0, 20)
          .map(([col, d]) => ({ col, ...d }));

        const diagnosticPayload = {
          success: false,
          status: "blocked",
          code: "NO_VALID_FEATURES",
          error: "As features ficaram constantes após o builder/join. Nenhuma feature válida restante.",
          message_user: "As features ficaram constantes após o builder/join. Revise a configuração de entidade ou re-selecione features.",
          features_selected_count: allFeatureNames.length,
          features_blocked_count: featureValidation.blocked.length,
          top_block_reasons: topBlockReasons,
          examples,
          feature_diagnostic: featureDiagnostic,
          preflight_report: {
            target_valid: targetValidation.valid,
            target_issues: targetValidation.issues,
            target_suggestions: targetValidation.suggestions,
            features_blocked: featureValidation.blocked,
            features_block_reasons: featureValidation.blockReasons,
            warnings: featureValidation.warnings,
          },
          action: "review_features",
        };

        // Log to platform_events
        try {
          await supabase.from("platform_events").insert({
            event_type: "no_valid_features",
            project_id: project_id,
            organization_id: settings.org_id || null,
            source: "train-models",
            status: "blocked",
            metadata: {
              code: "NO_VALID_FEATURES",
              features_selected_count: allFeatureNames.length,
              features_blocked_count: featureValidation.blocked.length,
              top_block_reasons: topBlockReasons,
              examples,
              target_column: target_column,
              dataset_version: settings.dataset_version,
              selection_version: settings.selection_version,
            },
          });
        } catch (logErr) {
          console.error("[NO_VALID_FEATURES] Failed to log platform_event:", logErr);
        }

        return new Response(JSON.stringify(diagnosticPayload), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const preflightReport: PreflightResult = {
      target_valid: targetValidation.valid,
      target_issues: targetValidation.issues,
      target_suggestions: targetValidation.suggestions,
      features_blocked: featureValidation.blocked,
      features_block_reasons: featureValidation.blockReasons,
      warnings: [
        ...targetValidation.issues.filter(i => !criticalTargetIssues.includes(i)),
        ...featureValidation.warnings
      ],
    };

    console.log(`[Preflight] Report:`, JSON.stringify(preflightReport, null, 2));

    // Use filtered data for training
    const Xfinal = filteredX;
    const finalFeatureNames = filteredFeatureNames;

    // Normalize data
    const { normalized: Xnorm, means: normMeans, stds: normStds } = normalize(Xfinal);

    // ==================== SMART SPLIT ====================
    console.log(`\n=== Smart Split Detection ===`);
    
    // Detect datetime and group columns from the raw data  
    // SSOT: prefer official time_anchor_column from project_settings
    const ssotTimeAnchor = (activeTargetSettings as any)?.time_anchor_column || (activeTargetSettings as any)?.recommended_time_column || null;
    const ssotSplitStrategy = (activeTargetSettings as any)?.recommended_split_strategy || null;
    
    console.log(`[Split] SSOT: time_anchor=${ssotTimeAnchor}, split_strategy=${ssotSplitStrategy}`);
    
    const datetimeColCandidates = headers.filter(h => 
      /^(data|dt_|date|timestamp|created|updated|dataneg|data_neg)/i.test(h.toLowerCase())
    );
    
    let datetimeValues: (number | null)[] | null = null;
    let detectedDatetimeCol: string | null = null;
    
    // PRIORITY 1: Use SSOT time anchor if available and present in headers
    if (ssotTimeAnchor) {
      const ssotIdx = headers.findIndex(h => h.toLowerCase() === ssotTimeAnchor.toLowerCase());
      if (ssotIdx !== -1) {
        detectedDatetimeCol = headers[ssotIdx];
        console.log(`[Split] Using SSOT time anchor: "${detectedDatetimeCol}"`);
        // We need datetime values — check globalThis first, otherwise parse from stored data
        if ((globalThis as any).__datetimeValues && (globalThis as any).__datetimeCol?.toLowerCase() === ssotTimeAnchor.toLowerCase()) {
          const rawDt = (globalThis as any).__datetimeValues as (number | null)[];
          datetimeValues = rawDt.length > Xfinal.length ? rawDt.slice(0, Xfinal.length) : rawDt;
        }
        // If no cached values, we'll still force temporal split below
      }
    }
    
    // PRIORITY 2: Use auto-detected datetime from data parsing
    if (!datetimeValues && (globalThis as any).__datetimeValues && (globalThis as any).__datetimeCol) {
      const rawDt = (globalThis as any).__datetimeValues as (number | null)[];
      // CRITICAL: truncate to match current X length (may differ after human-label override)
      datetimeValues = rawDt.length > Xfinal.length ? rawDt.slice(0, Xfinal.length) : rawDt;
      detectedDatetimeCol = (globalThis as any).__datetimeCol;
      console.log(`[Split] Using auto-detected datetime column: "${detectedDatetimeCol}" (${datetimeValues.length} values for ${Xfinal.length} rows)`);
    }
    
    // Detect group key from column uniqueness
    let groupValues: (string | null)[] | null = null;
    let detectedGroupKey: string | null = null;
    
    if (!datetimeValues && (globalThis as any).__groupValues && (globalThis as any).__groupCol) {
      const rawGrp = (globalThis as any).__groupValues as (string | null)[];
      groupValues = rawGrp.length > Xfinal.length ? rawGrp.slice(0, Xfinal.length) : rawGrp;
      detectedGroupKey = (globalThis as any).__groupCol;
      console.log(`[Split] Using detected group key: "${detectedGroupKey}" (${groupValues.length} values for ${Xfinal.length} rows)`);
    }

    const isClassification = problem_type === "classification";
    
    const splitResult = performSmartSplit(
      Xfinal.length,
      datetimeValues,
      groupValues,
      y,
      isClassification
    );
    
    console.log(`\n=== Split Result ===`);
    console.log(`Strategy: ${splitResult.strategy}`);
    console.log(`Train: ${splitResult.train_count}, Test: ${splitResult.test_count}`);
    
    const Xtrain = splitResult.trainIdx.map(i => Xnorm[i]);
    const ytrain = splitResult.trainIdx.map(i => y[i]);
    const Xtest = splitResult.testIdx.map(i => Xnorm[i]);
    const ytest = splitResult.testIdx.map(i => y[i]);

    const numClasses = isTargetCategorical ? labelMap.size : new Set(y).size;
    
    // ==================== CLASS DISTRIBUTION CHECK (CLASSIFICATION ONLY) ====================
    let classMinSamplesWarning = false;
    let classDistribution: Record<string, number> = {};
    
    if (isClassification) {
      const classCounts: Record<number, number> = {};
      for (const label of y) {
        classCounts[label] = (classCounts[label] || 0) + 1;
      }
      
      if (labelMap.size > 0) {
        for (const [label, idx] of labelMap.entries()) {
          classDistribution[label] = classCounts[idx] || 0;
        }
      } else {
        for (const [cls, count] of Object.entries(classCounts)) {
          classDistribution[`class_${cls}`] = count;
        }
      }
      
      console.log(`\n=== Distribuição de classes ===`);
      for (const [cls, count] of Object.entries(classDistribution)) {
        const percentage = ((count / X.length) * 100).toFixed(1);
        console.log(`  ${cls}: ${count.toLocaleString()} amostras (${percentage}%)`);
        
        if (count < MIN_CLASS_SAMPLES) {
          classMinSamplesWarning = true;
          console.warn(`  ⚠️  AVISO: Classe "${cls}" tem menos de ${MIN_CLASS_SAMPLES} amostras!`);
        }
      }
    }

    // For classification, convert to binary if needed
    let ytrainFinal = ytrain;
    let ytestFinal = ytest;
    
    if (isClassification && numClasses === 2) {
      const uniqueVals = [...new Set(y)].sort((a, b) => a - b);
      ytrainFinal = ytrain.map(v => v === uniqueVals[0] ? 0 : 1);
      ytestFinal = ytest.map(v => v === uniqueVals[0] ? 0 : 1);
    }

    console.log(`\nTipo: ${problem_type}, Classes: ${numClasses}`);

    // ============ DUAL MODEL TRAINING ============
    console.log(`\n=== Dual Model Training ===`);
    
    // Model A: Linear (Ridge / Logistic)
    const strategyA: ModelStrategy = isClassification
      ? {
          id: "logistic_regression",
          name: "Regressão Logística Regularizada",
          type: "classification",
          algorithm: "logistic_regression",
          params: { epochs: 100, lambda: 0.1 },
          reason: "Modelo A (linear) para comparação."
        }
      : {
          id: "linear_regression",
          name: "Regressão Linear Regularizada (Ridge)",
          type: "regression",
          algorithm: "linear_regression",
          params: { epochs: 100, lambda: 0.1 },
          reason: "Modelo A (linear) para comparação."
        };

    // Model B: Non-linear (Gradient Boosting with conservative params)
    const strategyB: ModelStrategy = {
      id: isClassification ? "gradient_boosting_classifier" : "gradient_boosting_regressor",
      name: isClassification ? "Gradient Boosting Classifier" : "Gradient Boosting Regressor",
      type: isClassification ? "classification" : "regression",
      algorithm: "gradient_boosting",
      params: {
        nEstimators: Math.min(8, Math.max(3, Math.floor(Xtrain.length / 800))),
        maxDepth: 3,
        learningRate: 0.15,
      },
      reason: "Modelo B (não-linear) para comparação."
    };

    const ytrainForModel = isClassification ? ytrainFinal : ytrain;
    const ytestForModel = isClassification ? ytestFinal : ytest;

    console.log(`[AutoML] Treinando Modelo A: ${strategyA.name}`);
    const resultA = trainSingleModel(strategyA, Xtrain, ytrainForModel, Xtest, ytestForModel, finalFeatureNames);
    
    console.log(`[AutoML] Treinando Modelo B: ${strategyB.name}`);
    const resultB = trainSingleModel(strategyB, Xtrain, ytrainForModel, Xtest, ytestForModel, finalFeatureNames);

    // ==================== RESOLVE METRICS PROFILE ====================
    const intentContract = trainAiCtx?.intent_contract || trainAiCtx?.intent || {};
    const intentBase = intentContract.intent_base || intentContract;
    const domainAdapter = intentContract.domain_adapter || {};
    const { profile: metricsProfile, source: profileSource } = resolveMetricsProfileEdge(intentBase, domainAdapter, problem_type);
    
    console.log(`\n=== Metrics Profile ===`);
    console.log(`Profile: ${metricsProfile.id} (${metricsProfile.label}), source: ${profileSource}`);
    console.log(`Primary metric: ${metricsProfile.primary}`);

    // Compare and pick champion by PROFILE primary metric
    const primaryMetricName = metricsProfile.primary;
    const isLowerBetter = ["MAE", "RMSE", "MSE", "brier"].includes(primaryMetricName);
    const scoreA = resultA.metrics[primaryMetricName] ?? (isLowerBetter ? Infinity : -Infinity);
    const scoreB = resultB.metrics[primaryMetricName] ?? (isLowerBetter ? Infinity : -Infinity);
    
    console.log(`\n=== Model Comparison (by ${primaryMetricName}) ===`);
    console.log(`Modelo A (${strategyA.name}): ${primaryMetricName}=${typeof scoreA === 'number' ? scoreA.toFixed(4) : scoreA}, sanity=${resultA.sanity.passed}`);
    console.log(`Modelo B (${strategyB.name}): ${primaryMetricName}=${typeof scoreB === 'number' ? scoreB.toFixed(4) : scoreB}, sanity=${resultB.sanity.passed}`);

    // Selection logic: prefer model with better score AND passing sanity
    let trainResult: TrainResult;
    let strategy: ModelStrategy;
    let championIdx = 0; // 0 = A, 1 = B
    
    const isBetter = (a: number, b: number) => isLowerBetter ? a < b : a > b;
    
    if (resultA.sanity.passed && resultB.sanity.passed) {
      if (isBetter(scoreB, scoreA)) {
        trainResult = resultB; strategy = strategyB; championIdx = 1;
        console.log(`[AutoML] ✅ Champion: Modelo B (melhor ${primaryMetricName})`);
      } else {
        trainResult = resultA; strategy = strategyA; championIdx = 0;
        console.log(`[AutoML] ✅ Champion: Modelo A (melhor ${primaryMetricName})`);
      }
    } else if (resultB.sanity.passed && !resultA.sanity.passed) {
      trainResult = resultB; strategy = strategyB; championIdx = 1;
      console.log(`[AutoML] ✅ Champion: Modelo B (A falhou sanity)`);
    } else if (resultA.sanity.passed && !resultB.sanity.passed) {
      trainResult = resultA; strategy = strategyA; championIdx = 0;
      console.log(`[AutoML] ✅ Champion: Modelo A (B falhou sanity)`);
    } else {
      if (isBetter(scoreB, scoreA)) {
        trainResult = resultB; strategy = strategyB; championIdx = 1;
      } else {
        trainResult = resultA; strategy = strategyA; championIdx = 0;
      }
      console.warn(`[AutoML] ⚠️ Ambos falharam sanity — champion por score`);
    }

    // ==================== PLATT CALIBRATION (classification only) ====================
    let calibrationInfo: { method: string; a?: number; b?: number; brier_before?: number; brier_after?: number } = { method: "none" };
    let calibratedPredictions = trainResult.predictions;

    if (isClassification && ytestForModel.length >= 100) {
      const brierBefore = calcBrierScore(ytestForModel, trainResult.predictions);
      const platt = plattCalibrate(ytestForModel, trainResult.predictions);
      const calibrated = applyPlattCalibration(trainResult.predictions, platt.a, platt.b);
      const brierAfter = calcBrierScore(ytestForModel, calibrated);

      if (brierAfter < brierBefore) {
        calibrationInfo = { method: "platt", a: platt.a, b: platt.b, brier_before: brierBefore, brier_after: brierAfter };
        calibratedPredictions = calibrated;
        console.log(`[Calibration] Platt: brier ${brierBefore.toFixed(4)} → ${brierAfter.toFixed(4)} ✅`);
      } else {
        calibrationInfo = { method: "none", brier_before: brierBefore, brier_after: brierBefore };
        console.log(`[Calibration] Platt did not improve (${brierBefore.toFixed(4)} → ${brierAfter.toFixed(4)}). Keeping raw.`);
      }
    }

    // ==================== OPTIMAL THRESHOLD ====================
    let recommendedThreshold = 0.5;
    if (isClassification && metricsProfile.threshold_strategy !== "none") {
      recommendedThreshold = findOptimalThreshold(
        ytestForModel,
        calibratedPredictions,
        metricsProfile.threshold_strategy,
        metricsProfile.min_precision || 0.3
      );
      console.log(`[Threshold] Optimal: ${recommendedThreshold.toFixed(2)} (strategy: ${metricsProfile.threshold_strategy})`);
    }

    // ==================== EXTENDED CLASSIFICATION METRICS ====================
    let extendedMetrics: ExtendedClassificationMetrics | null = null;
    if (isClassification) {
      const totalPos = ytestForModel.filter(v => v === 1).length;
      const baseRate = totalPos / ytestForModel.length;
      const predsToUse = calibratedPredictions;
      
      extendedMetrics = {
        base_rate: baseRate,
        precision_at_5: calcPrecisionAtK(ytestForModel, predsToUse, 5),
        precision_at_10: calcPrecisionAtK(ytestForModel, predsToUse, 10),
        precision_at_20: calcPrecisionAtK(ytestForModel, predsToUse, 20),
        recall_at_5: calcRecallAtK(ytestForModel, predsToUse, 5),
        recall_at_10: calcRecallAtK(ytestForModel, predsToUse, 10),
        recall_at_20: calcRecallAtK(ytestForModel, predsToUse, 20),
        lift_at_10: calcLiftAtK(ytestForModel, predsToUse, 10),
        confusion_matrix: calcConfusionMatrixAtThreshold(ytestForModel, predsToUse, recommendedThreshold),
        threshold_curve: calcThresholdCurve(ytestForModel, predsToUse, 50),
        chosen_threshold: recommendedThreshold,
        threshold_method: metricsProfile.threshold_strategy || "max_f1",
      };
      console.log(`[ExtendedMetrics] base_rate=${(baseRate*100).toFixed(1)}%, P@10=${(extendedMetrics.precision_at_10*100).toFixed(1)}%, R@10=${(extendedMetrics.recall_at_10*100).toFixed(1)}%, Lift@10=${extendedMetrics.lift_at_10.toFixed(2)}`);
      console.log(`[ExtendedMetrics] CM@${recommendedThreshold}: TP=${extendedMetrics.confusion_matrix.tp} FP=${extendedMetrics.confusion_matrix.fp} FN=${extendedMetrics.confusion_matrix.fn} TN=${extendedMetrics.confusion_matrix.tn}`);
    }

    // Delete existing models for this project
    await supabase
      .from("project_models")
      .delete()
      .eq("project_id", project_id);

    // ==================== BASELINE CALCULATION ====================
    const yTrainMean = mean(ytrainForModel);
    let baselineMetrics: Record<string, number>;
    
    if (isClassification) {
      const baselineProbs = ytestForModel.map(() => yTrainMean);
      baselineMetrics = calcClassificationMetrics(ytestForModel, baselineProbs);
    } else {
      const baselinePreds = ytestForModel.map(() => yTrainMean);
      baselineMetrics = calcRegressionMetrics(ytestForModel, baselinePreds);
    }
    
    console.log(`\n=== Baseline Metrics ===`);
    console.log(JSON.stringify(baselineMetrics));

    // ==================== DETAILED METRICS (RAW + CLAMPED + VALIDATION) ====================
    const detailedMetrics: MetricsResult = isClassification
      ? calcClassificationMetricsDetailed(ytestForModel, trainResult.predictions)
      : calcRegressionMetricsDetailed(ytestForModel, trainResult.predictions);

    console.log(`\n=== Detailed Metrics ===`);
    console.log(`Raw:`, JSON.stringify(detailedMetrics.raw));
    console.log(`Clamped:`, JSON.stringify(detailedMetrics.clamped));
    console.log(`Valid: ${detailedMetrics.valid}`);
    if (detailedMetrics.invalid_reasons.length > 0) {
      console.warn(`Invalid reasons: ${detailedMetrics.invalid_reasons.join("; ")}`);
    }

    // ==================== IMPROVEMENT VS BASELINE (use profile-aware primary metric) ====================
    // Use the metrics profile primary metric, not hardcoded AUC/R²
    const primaryMetricKey = metricsProfile.primary || (isClassification ? "AUC" : "R²");
    const modelPrimaryMetricRaw = detailedMetrics.raw[primaryMetricKey] ?? detailedMetrics.raw[isClassification ? "AUC" : "R²"] ?? 0;
    const baselinePrimaryMetric = baselineMetrics[primaryMetricKey] ?? baselineMetrics[isClassification ? "AUC" : "R²"] ?? 0;
    const improvementVsBaseline = modelPrimaryMetricRaw - baselinePrimaryMetric;

    console.log(`\n=== Improvement vs Baseline ===`);
    console.log(`Model ${primaryMetricKey} (raw): ${modelPrimaryMetricRaw.toFixed(4)}`);
    console.log(`Baseline ${primaryMetricKey}: ${baselinePrimaryMetric.toFixed(4)}`);
    console.log(`Improvement: ${improvementVsBaseline.toFixed(4)}`);

    // ==================== MODEL QUALITY CHECK (metrics + sanity + baseline) ====================
    let modelQualityFlag = "ok";
    const modelR2 = detailedMetrics.clamped["R²"];
    const modelAUC = detailedMetrics.clamped["AUC"];
    
    // 1. Invalid metrics (NaN, Infinity, out-of-range)
    if (!detailedMetrics.valid) {
      modelQualityFlag = "fail_metrics";
      console.warn(`[AutoML] ⚠️ Metrics INVALID: ${detailedMetrics.invalid_reasons.join("; ")}`);
    }
    // 2. Sanity check failure (constant/degenerate predictions)
    else if (!trainResult.sanity.passed) {
      modelQualityFlag = "fail_sanity";
      console.warn(`[AutoML] ⚠️ Prediction sanity FAILED: ${trainResult.sanity.fail_reasons.join("; ")}`);
    }
    // 3. Worse than or equal to baseline
    else if (improvementVsBaseline <= 0) {
      modelQualityFlag = "weak_model";
      console.warn(`[AutoML] ⚠️ Model does NOT beat baseline (improvement=${improvementVsBaseline.toFixed(4)})`);
    }
    // 4. Below minimum quality thresholds
    else if (!isClassification && modelR2 !== undefined && modelR2 < 0) {
      modelQualityFlag = "weak_model";
      console.warn(`[AutoML] ⚠️ R² negativo (${modelR2.toFixed(4)}) — modelo PIOR que baseline!`);
    } else if (isClassification && modelAUC !== undefined && modelAUC < 0.55) {
      modelQualityFlag = "weak_model";
      console.warn(`[AutoML] ⚠️ AUC abaixo de 0.55 (${modelAUC.toFixed(4)}) — insuficiente!`);
    }

    // Determine production eligibility + dashboard access
    const metricsValid = detailedMetrics.valid;
    const canPromoteToProduction = metricsValid && modelQualityFlag === "ok" && trainResult.sanity.passed;
    const dashboardAllowed = canPromoteToProduction;
    const shouldPromoteToProduction = canPromoteToProduction;

    // Build dashboard_allowed_reason
    let dashboardAllowedReason = "ok";
    if (!metricsValid) dashboardAllowedReason = "metrics_invalid";
    else if (!trainResult.sanity.passed) dashboardAllowedReason = "sanity_failed";
    else if (modelQualityFlag === "weak_model") dashboardAllowedReason = "weak_model_no_improvement";
    else if (modelQualityFlag !== "ok") dashboardAllowedReason = modelQualityFlag;

    // Build train_diagnostics (always returned)
    const trainDiagnostics = {
      primary_metric: primaryMetricKey,
      primary_metric_value_raw: modelPrimaryMetricRaw,
      primary_metric_value_clamped: detailedMetrics.clamped[primaryMetricKey] ?? 0,
      baseline_primary_metric: baselinePrimaryMetric,
      improvement_vs_baseline: improvementVsBaseline,
      raw_metrics_invalid_reasons: detailedMetrics.invalid_reasons,
      sanity_checks_passed: trainResult.sanity.passed,
      sanity_fail_reasons: trainResult.sanity.fail_reasons,
      model_quality_flag: modelQualityFlag,
      dashboard_allowed: dashboardAllowed,
      dashboard_allowed_reason: dashboardAllowedReason,
      metrics_valid: metricsValid,
      can_promote_to_production: canPromoteToProduction,
    };

    console.log(`\n=== Train Diagnostics ===`);
    console.log(JSON.stringify(trainDiagnostics));

    if (!shouldPromoteToProduction) {
      console.warn(`[AutoML] ⚠️ Modelo NÃO será promovido para produção. Flag: ${modelQualityFlag}, reason: ${dashboardAllowedReason}`);
    }

    // Save model to database
    const { data: modelData, error: modelError } = await supabase
      .from("project_models")
      .insert({
        project_id,
        algorithm_name: strategy.name,
        problem_type,
        status: "trained",
        is_production: shouldPromoteToProduction,
        trained_at: new Date().toISOString(),
        hyperparameters: {
          strategy_id: strategy.id,
          algorithm: strategy.algorithm,
          params: strategy.params,
          reason: strategy.reason,
          // Model artifacts for real predictions
          model_artifacts: {
            type: strategy.algorithm,
            weights: trainResult.model.weights || null,
            bias: trainResult.model.bias || null,
            trees: trainResult.model.trees || null,
            lr: trainResult.model.lr || null,
            base: trainResult.model.base || null,
            isClassification: trainResult.model.isClassification ?? null,
          },
          normalization: {
            means: Array.from(normMeans),
            stds: Array.from(normStds),
          },
          feature_names: finalFeatureNames,
          baseline_metrics: baselineMetrics,
          model_quality_flag: modelQualityFlag,
          // Metrics audit trail
          metrics_raw: detailedMetrics.raw,
          metrics_clamped: detailedMetrics.clamped,
          metrics_valid: detailedMetrics.valid,
          metrics_invalid_reasons: detailedMetrics.invalid_reasons,
          improvement_vs_baseline: improvementVsBaseline,
          can_promote_to_production: canPromoteToProduction,
          dashboard_allowed: dashboardAllowed,
          dashboard_allowed_reason: dashboardAllowedReason,
          train_diagnostics: trainDiagnostics,
          // Preflight validation report
          preflight_report: preflightReport,
          // Split info
          split_strategy: splitResult.strategy,
          split_datetime_col: detectedDatetimeCol,
          split_group_key: detectedGroupKey,
          split_train_count: splitResult.train_count,
          split_test_count: splitResult.test_count,
          // Prediction sanity
          prediction_sanity: {
            pred_std: trainResult.sanity.pred_std,
            pred_mean: trainResult.sanity.pred_mean,
            pred_range: trainResult.sanity.pred_range,
            unique_ratio_pred: trainResult.sanity.unique_ratio_pred,
            pct_equal_mode_pred: trainResult.sanity.pct_equal_mode_pred,
            y_range: trainResult.sanity.y_range,
            range_ratio: trainResult.sanity.range_ratio,
            passed: trainResult.sanity.passed,
            fail_reasons: trainResult.sanity.fail_reasons,
          },
          // Dual model comparison
          dual_model: {
            model_a: { name: strategyA.name, score: scoreA, sanity: resultA.sanity.passed },
            model_b: { name: strategyB.name, score: scoreB, sanity: resultB.sanity.passed },
            selected: strategy.name,
          },
          // Dataset info & resource_guard
          sample_strategy: sampleStrategy,
          total_rows_dataset: totalDatasetRows,
          rows_read: totalLinesRead,
          sample_size_final: Xfinal.length,
          // Class distribution (if classification)
          class_distribution: isClassification ? classDistribution : null,
          class_min_samples_warning: classMinSamplesWarning,
          // Sampling constants used
          min_rows_required: MIN_ROWS_FOR_TRAIN,
          target_sample_size: TARGET_SAMPLE_SIZE,
          max_rows_to_read: MAX_ROWS_TO_READ,
          // ── SSOT versioning (Etapa 4.2) ──
          selection_version: currentSelectionVersion,
          target_hash: currentTargetHash,
          builder_dataset_id: builderDatasetId,
          training_seed: trainingSeed,
          // Class balance audit
          class_balance_method: classBalanceMethod,
          // ── Etapa 6: Calibration + Threshold + Profile ──
          calibration: calibrationInfo,
          recommended_threshold: recommendedThreshold,
          metrics_profile: { id: metricsProfile.id, label: metricsProfile.label, primary: metricsProfile.primary, problem_family: metricsProfile.problem_family, valid_metrics: metricsProfile.valid_metrics, source: profileSource },
          extended_metrics: extendedMetrics,
          leakage_report: {
            blocked: featureValidation.blocked,
            blockReasons: featureValidation.blockReasons,
            suspects: featureValidation.suspects,
            base_rate: featureValidation.base_rate,
          },
        },
      })
      .select()
      .single();

    if (modelError) {
      console.error(`Erro ao salvar modelo:`, modelError);
      return new Response(JSON.stringify({ error: "Erro ao salvar modelo" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Save metrics
    const metricsToInsert = Object.entries(trainResult.metrics).map(([name, value]) => ({
      project_model_id: modelData.id,
      metric_name: name,
      metric_value: value,
    }));

    await supabase.from("project_model_metrics").insert(metricsToInsert);

    // Save feature importances
    const importancesToInsert = trainResult.featureImportances.map(fi => ({
      project_model_id: modelData.id,
      feature_name: fi.feature_name,
      importance_value: fi.importance_value,
    }));

    await supabase.from("project_feature_importances").insert(importancesToInsert);

    // Save model rankings
    try {
      const rankingJson = [
        { model_id: modelData.id, name: strategy.name, score: trainResult.metrics[primaryMetricName] ?? 0, sanity: trainResult.sanity.passed, is_champion: true, metrics: detailedMetrics.clamped },
        { model_id: null, name: (championIdx === 0 ? strategyB : strategyA).name, score: championIdx === 0 ? scoreB : scoreA, sanity: championIdx === 0 ? resultB.sanity.passed : resultA.sanity.passed, is_champion: false },
      ];
      await supabase.from("project_model_rankings").insert({
        project_id,
        selection_version: currentSelectionVersion,
        ranking_json: rankingJson,
        champion_model_id: modelData.id,
        metrics_profile_used: metricsProfile.id,
        primary_metric: primaryMetricName,
      });
      console.log(`[AutoML] Model ranking persisted`);
    } catch (rankErr) {
      console.warn(`[AutoML] Failed to persist ranking:`, rankErr);
    }

    // Update project status to evaluated
    await supabase
      .from("projects")
      .update({ status: "evaluated" })
      .eq("id", project_id);

    // Sync SSOT: set production_model_id in project_dataset_state
    if (shouldPromoteToProduction && modelData?.id) {
      const { error: ssotErr } = await supabase
        .from("project_dataset_state")
        .update({ production_model_id: modelData.id, updated_at: new Date().toISOString() })
        .eq("project_id", project_id);
      if (ssotErr) {
        console.warn(`[AutoML] Failed to sync SSOT production_model_id:`, ssotErr);
      } else {
        console.log(`[AutoML] ✅ SSOT synced: production_model_id = ${modelData.id}`);
      }
    }

    // ---- Append AI Context (training stage) ----
    try {
      const isClassification = problem_type === "classification";
      const primaryMetric = isClassification ? trainResult.metrics.AUC : trainResult.metrics["R²"];
      const confidenceLevel = primaryMetric >= 0.8 ? "alto" : primaryMetric >= 0.6 ? "médio" : "baixo";
      
      const limitations: string[] = [];
      if (classMinSamplesWarning) limitations.push("Amostra mínima por classe abaixo do ideal.");
      if (isClassification && trainResult.metrics.AUC < 0.6) limitations.push("AUC baixo - modelo pode não ser discriminativo.");
      if (!isClassification && trainResult.metrics["R²"] < 0.3) limitations.push("R² baixo - modelo explica pouca variância.");

      const trainingPayload = {
        model_type: strategy.name,
        algorithm: strategy.algorithm,
        metrics: trainResult.metrics,
        limitations,
        confidence_level: confidenceLevel,
        split_strategy: splitResult.strategy,
        split_datetime_col: detectedDatetimeCol,
        split_group_key: detectedGroupKey,
        prediction_sanity: {
          pred_std: trainResult.sanity.pred_std,
          pct_equal_mode_pred: trainResult.sanity.pct_equal_mode_pred,
          unique_ratio_pred: trainResult.sanity.unique_ratio_pred,
          passed: trainResult.sanity.passed,
          fail_reasons: trainResult.sanity.fail_reasons,
        },
        dual_model: {
          model_a: { name: strategyA.name, score: scoreA },
          model_b: { name: strategyB.name, score: scoreB },
          selected: strategy.name,
        },
        sample_info: {
          sample_strategy: sampleStrategy,
          total_rows: totalDatasetRows,
          sample_used: Xfinal.length,
          train_rows: splitResult.train_count,
          test_rows: splitResult.test_count,
          features_blocked: featureValidation.blocked,
          target_issues: targetValidation.issues,
        },
        top_features: trainResult.featureImportances
          .sort((a: any, b: any) => b.importance_value - a.importance_value)
          .slice(0, 10)
          .map((f: any) => ({ name: f.feature_name, importance: f.importance_value })),
      };

      const { data: existingCtx } = await supabase
        .from("project_ai_context")
        .select("id, context")
        .eq("project_id", project_id)
        .maybeSingle();

      if (existingCtx) {
        const currentCtx = existingCtx.context as Record<string, any> || {};
        await supabase.from("project_ai_context").update({
          context: { ...currentCtx, training: trainingPayload },
          status: "model_trained",
          last_updated_at: new Date().toISOString(),
        }).eq("id", existingCtx.id);
      } else {
        await supabase.from("project_ai_context").insert({
          organization_id: project.organization_id,
          project_id,
          context: { training: trainingPayload },
          status: "model_trained",
        });
      }
      console.log("[train-models] AI context updated (training stage)");
    } catch (ctxErr) {
      console.error("[train-models] Failed to update AI context:", ctxErr);
    }

    const elapsedMs = Date.now() - startMs;

    console.log(`\n========================================`);
    console.log(`[AutoML] Treinamento concluído com sucesso!`);
    console.log(`[AutoML] Modelo: ${strategy.name}, elapsed: ${elapsedMs}ms`);
    console.log(`[AutoML] Métrica principal: ${isClassification ? trainResult.metrics.AUC : trainResult.metrics["R²"]}`);
    console.log(`[AutoML] selection_version=${currentSelectionVersion}, dataset_id=${builderDatasetId}, seed=${trainingSeed}`);
    console.log(`========================================\n`);

    // ── SSOT State Machine: Mark training as done + increment version ──
    try {
      await supabase.rpc("rpc_update_pipeline_state", {
        p_project_id: project_id,
        p_stage: "training",
        p_new_state: "done",
        p_version_increment: true,
      });
    } catch (stateErr) {
      console.warn("[train-models] Failed to update pipeline state (non-blocking):", stateErr);
    }

    // ── Log training_run_succeeded ──
    safeFire(supabase.from("platform_events").insert({
      event_type: "training_run_succeeded",
      project_id: project_id,
      status: "success",
      source: "edge",
      metadata: { run_id, selection_version: currentSelectionVersion, duration_ms: Date.now() - startMs },
    }));

    // Build CTAs for UI
    const ctas: { label: string; go_to_step?: number }[] = [];
    if (!dashboardAllowed) {
      ctas.push({ label: "Revisar Target/Features", go_to_step: 3 });
    }

    return new Response(JSON.stringify({ 
      // ===== STRUCTURED RESPONSE (Etapa 4.2 Engine) =====
      success: true,
      status: "success",
      message: modelQualityFlag === "ok" 
        ? "Treinamento concluído com sucesso" 
        : `Treinamento concluído — modelo ${modelQualityFlag}`,
      // ── SSOT versioning ──
      selection_version: currentSelectionVersion,
      target_hash: currentTargetHash,
      dataset_id: builderDatasetId,
      row_count_used: Xfinal.length,
      sample_ratio: totalDatasetRows > 0 ? Xfinal.length / totalDatasetRows : 1,
      // ── Contract guardrail info ──
      contract_used: contractUsed,
      contract_blocked_reason: contractBlockedReason,
      contract_warning: contractWarning,
      // ── Model info ──
      model_id: modelData.id,
      model_quality_flag: modelQualityFlag,
      dashboard_allowed: dashboardAllowed,
      can_promote_to_production: canPromoteToProduction,
      // ── Metrics ──
      metrics_summary: { primary_metric: primaryMetricKey, model: detailedMetrics.clamped, baseline: baselineMetrics, improvement: improvementVsBaseline },
      metrics_raw: detailedMetrics.raw,
      metrics_valid: detailedMetrics.valid,
      metrics_invalid_reasons: detailedMetrics.invalid_reasons,
      baseline_summary: baselineMetrics,
      improvement_vs_baseline: improvementVsBaseline,
      dashboard_allowed_reason: dashboardAllowedReason,
      train_diagnostics: trainDiagnostics,
      // ── Warnings + CTAs ──
      warnings: [
        ...trainingWarningsGlobal,
        ...(classMinSamplesWarning ? ["Classe com menos de 50 amostras"] : []),
        ...featureValidation.blocked.map(f => `Feature bloqueada: ${f}`),
        ...targetValidation.issues,
        ...trainResult.sanity.fail_reasons,
        ...detailedMetrics.invalid_reasons,
        ...(improvementVsBaseline <= 0 ? [`Modelo não supera baseline (diff: ${improvementVsBaseline.toFixed(4)})`] : []),
      ],
      training_warnings: [
        ...trainingWarningsGlobal,
        ...(classMinSamplesWarning ? ["Classe com menos de 50 amostras"] : []),
        ...featureValidation.blocked.map(f => `Feature bloqueada: ${f}`),
        ...targetValidation.issues,
        ...trainResult.sanity.fail_reasons,
        ...detailedMetrics.invalid_reasons,
        ...(improvementVsBaseline <= 0 ? [`Modelo não supera baseline (diff: ${improvementVsBaseline.toFixed(4)})`] : []),
      ],
      ctas,
      // ── Etapa 6: Calibration + Threshold + Profile + Ranking ──
      calibration: calibrationInfo,
      recommended_threshold: recommendedThreshold,
      metrics_profile: { id: metricsProfile.id, label: metricsProfile.label, primary: metricsProfile.primary, problem_family: metricsProfile.problem_family, valid_metrics: metricsProfile.valid_metrics, source: profileSource },
      extended_metrics: extendedMetrics,
      leakage_report: {
        blocked: featureValidation.blocked,
        blockReasons: featureValidation.blockReasons,
        suspects: featureValidation.suspects,
        base_rate: featureValidation.base_rate,
      },
      champion: {
        model_id: modelData.id,
        name: strategy.name,
        score: trainResult.metrics[primaryMetricName] ?? 0,
        metrics: detailedMetrics.clamped,
        sanity: trainResult.sanity.passed,
        is_champion: true,
      },
      ranking: [
        { model_id: modelData.id, name: strategy.name, score: trainResult.metrics[primaryMetricName] ?? 0, sanity: trainResult.sanity.passed, is_champion: true, metrics: detailedMetrics.clamped },
        { model_id: null, name: (championIdx === 0 ? strategyB : strategyA).name, score: championIdx === 0 ? scoreB : scoreA, sanity: championIdx === 0 ? resultB.sanity.passed : resultA.sanity.passed, is_champion: false },
      ],
      // ── Debug ──
      debug: { seed: trainingSeed, features_count: finalFeatureNames.length, blocked_features_count: featureValidation.blocked.length, elapsed_ms: elapsedMs },
      preflight_report: preflightReport,
      prediction_sanity: {
        passed: trainResult.sanity.passed,
        pred_std: trainResult.sanity.pred_std,
        pct_equal_mode_pred: trainResult.sanity.pct_equal_mode_pred,
        fail_reasons: trainResult.sanity.fail_reasons,
      },
      split_strategy: splitResult.strategy,
      dual_model: {
        model_a: { name: strategyA.name, score: scoreA, sanity: resultA.sanity.passed },
        model_b: { name: strategyB.name, score: scoreB, sanity: resultB.sanity.passed },
        selected: strategy.name,
      },
      model: {
        id: modelData.id,
        name: strategy.name,
        algorithm: strategy.algorithm,
        reason: strategy.reason,
        metrics: detailedMetrics.clamped,
        is_production: shouldPromoteToProduction,
        sample_info: {
          total_dataset_rows: totalDatasetRows,
          rows_read: totalLinesRead,
          sample_used: Xfinal.length,
          train_rows: splitResult.train_count,
          test_rows: splitResult.test_count,
        },
        warnings: {
          class_min_samples_warning: classMinSamplesWarning,
          model_quality_flag: modelQualityFlag,
          features_blocked: featureValidation.blocked,
          target_issues: targetValidation.issues,
          prediction_sanity_passed: trainResult.sanity.passed,
        }
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const requestId = crypto.randomUUID();
    console.error(`[TRAINING_CRASH] request_id=${requestId}`, err);

    // Attempt to extract context for diagnostics
    let crashProjectId: string | null = null;
    let crashSelectionVersion: number | null = null;
    let crashDatasetVersion: number | null = null;
    let crashActiveTargetMode: string | null = null;
    let crashActiveTargetRef: Record<string, unknown> | null = null;
    let crashStep = "init";

    try {
      const body: any = _parsedBody || {};
      crashProjectId = body.project_id || null;
      
      if (crashProjectId) {
        const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        // Mark training as failed
        try {
          await sb.rpc("rpc_update_pipeline_state", {
            p_project_id: crashProjectId,
            p_stage: "training",
            p_new_state: "failed",
          });
        } catch { /* best-effort */ }

        // Read SSOT for diagnostics
        try {
          const { data: settings } = await sb
            .from("project_settings")
            .select("selection_version, dataset_version, active_target_mode, active_target_column, active_target_ref")
            .eq("project_id", crashProjectId)
            .maybeSingle();
          
          if (settings) {
            crashSelectionVersion = (settings as any).selection_version ?? null;
            crashDatasetVersion = (settings as any).dataset_version ?? null;
            crashActiveTargetMode = (settings as any).active_target_mode ?? null;
            crashActiveTargetRef = (settings as any).active_target_ref ?? null;
          }
        } catch { /* best-effort */ }

        // Infer step from stack trace
        const stack = err.stack || "";
        if (stack.includes("buildModelingDataset") || stack.includes("readParquet") || stack.includes("filePath")) crashStep = "build_dataset";
        else if (stack.includes("splitData") || stack.includes("trainTest")) crashStep = "split";
        else if (stack.includes("trainLogistic") || stack.includes("trainLinear") || stack.includes("trainGradient") || stack.includes("trainSimpleTree")) crashStep = "fit";
        else if (stack.includes("calcMetrics") || stack.includes("calcPRAUC") || stack.includes("calcAUC")) crashStep = "metrics";
        else if (stack.includes("insert") || stack.includes("upsert") || stack.includes("persist")) crashStep = "persist";
        else if (stack.includes("safeFire") || stack.includes("platform_events")) crashStep = "logging";

        // Log to platform_events for audit
        const truncatedStack = (err.stack || "").slice(0, 10_000);
        try {
          await sb.from("platform_events").insert({
            user_id: null,
            organization_id: null,
            project_id: crashProjectId,
            event_type: "job_error",
            status: "error",
            source: "edge",
            metadata: {
              code: "TRAINING_CRASH",
              step: crashStep,
              request_id: requestId,
              error_name: err.name,
              error_message: err.message,
              stack: truncatedStack,
              selection_version: crashSelectionVersion,
              dataset_version: crashDatasetVersion,
              active_target_mode: crashActiveTargetMode,
            },
            timestamp: new Date().toISOString(),
          });
        } catch (evtErr) { console.error("[TRAINING_CRASH] Failed to log event:", evtErr); }
      }
    } catch (_diagErr) {
      console.error("[TRAINING_CRASH] Diagnostics collection failed:", _diagErr);
    }

    // Return structured HTTP 200 error per reliability standards
    return new Response(JSON.stringify({
      success: false,
      status: "error",
      code: "TRAINING_CRASH",
      message_user: "Erro interno ao treinar. Tente novamente ou compartilhe o código do erro.",
      error: {
        name: err.name,
        message: err.message,
        stack: (err.stack || "").slice(0, 4_000),
        hint: "Verifique os logs de auditoria com o request_id abaixo.",
        step: crashStep,
        request_id: requestId,
        project_id: crashProjectId,
        selection_version: crashSelectionVersion,
        dataset_version: crashDatasetVersion,
        active_target_mode: crashActiveTargetMode,
        active_target_ref: crashActiveTargetRef,
      },
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
