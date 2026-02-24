import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parquetRead } from "npm:hyparquet@1.24.1";
import { applyFeatureTransforms, type ProjectFeature } from "../_shared/feature-engineering.ts";
import { evaluateTargetTrainability, trainabilityHumanMessage } from "../_shared/evaluate-target-trainability.ts";
import { resolveActiveTarget, buildHumanTargetStats, buildTrainabilityReport } from "../_shared/resolve-active-target.ts";

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
function validateFeatures(
  featureNames: string[],
  X: number[][],
  targetName: string,
  y: number[]
): { blocked: string[]; blockReasons: Record<string, string>; warnings: string[] } {
  const blocked: string[] = [];
  const blockReasons: Record<string, string> = {};
  const warnings: string[] = [];

  const idPatterns = /^(id|_id|codigo|cod_|numero|num_|chave|key|uuid|pk|fk|idx|index)/i;
  const idSuffixPatterns = /(_id|_key|_code|_cod|_numero|_num|_uuid)$/i;

  for (let j = 0; j < featureNames.length; j++) {
    const name = featureNames[j];
    const nameLower = name.toLowerCase();

    // 1. ID/Key pattern detection
    if (idPatterns.test(nameLower) || idSuffixPatterns.test(nameLower)) {
      // Check if it actually has high cardinality
      const col = X.map(row => row[j]);
      const uniqueCount = new Set(col).size;
      const uniqueRatio = uniqueCount / col.length;
      
      if (uniqueRatio > 0.5) {
        blocked.push(name);
        blockReasons[name] = `Parece ser ID/chave (${uniqueCount} valores únicos em ${col.length} linhas).`;
        continue;
      } else {
        warnings.push(`Feature "${name}" tem nome de ID mas baixa cardinalidade (${uniqueCount} únicos) — mantida.`);
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

    // 3. Leakage: feature contains target name
    if (nameLower.includes(targetName.toLowerCase()) && nameLower !== targetName.toLowerCase()) {
      warnings.push(`Feature "${name}" contém o nome do target "${targetName}" — possível vazamento.`);
    }

    // 4. Leakage: extremely high correlation with target
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
          blockReasons[name] = `Correlação com target = ${corr.toFixed(4)} — provável vazamento de dados.`;
          continue;
        } else if (corr > 0.9) {
          warnings.push(`Feature "${name}" tem alta correlação com target (${corr.toFixed(3)}) — verifique vazamento.`);
        }
      }
    }
  }

  return { blocked, blockReasons, warnings };
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
}

function resolveMetricsProfileEdge(
  intentBase: Record<string, any>,
  domainAdapter: Record<string, any>,
  problemType: string
): { profile: MetricsProfileDef; source: string } {
  const objective = String(intentBase?.declared_objective || "").toLowerCase();
  const industry = String(domainAdapter?.industry || "").toLowerCase();

  if (objective.includes("churn") || objective.includes("retenção") || objective.includes("cancelamento")) {
    return { profile: { id: "churn", primary: "pr_auc", secondary: ["AUC", "F1", "Recall"], calibration: "brier", threshold_strategy: "max_recall_min_precision", min_precision: 0.3, label: "Churn" }, source: "objective:churn" };
  }
  if (objective.includes("conversão") || objective.includes("conversion") || objective.includes("lead")) {
    return { profile: { id: "conversao", primary: "Precisão", secondary: ["AUC", "pr_auc"], calibration: "brier", threshold_strategy: "max_precision_at_k", min_precision: 0.5, label: "Conversão" }, source: "objective:conversao" };
  }
  if ((objective.includes("receita") || objective.includes("revenue") || objective.includes("valor")) && problemType === "regression") {
    return { profile: { id: "receita", primary: "MAE", secondary: ["RMSE", "R²"], threshold_strategy: "none", label: "Receita" }, source: "objective:receita" };
  }
  if (objective.includes("no-show") || objective.includes("adesão") || objective.includes("falta")) {
    return { profile: { id: "health", primary: "Recall", secondary: ["F1", "pr_auc"], calibration: "brier", threshold_strategy: "max_recall", min_precision: 0.2, label: "Saúde" }, source: "objective:health" };
  }
  if (industry.includes("saúde") || industry.includes("health")) {
    return { profile: { id: "health", primary: "Recall", secondary: ["F1", "pr_auc"], calibration: "brier", threshold_strategy: "max_recall", min_precision: 0.2, label: "Saúde" }, source: "industry:health" };
  }
  if (problemType === "regression") {
    return { profile: { id: "generic_regression", primary: "R²", secondary: ["MAE", "RMSE"], threshold_strategy: "none", label: "Regressão" }, source: "fallback:regression" };
  }
  return { profile: { id: "generic", primary: "AUC", secondary: ["F1", "Recall", "Precisão"], calibration: "brier", threshold_strategy: "max_f1", label: "Genérico" }, source: "fallback:generic" };
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
  
  // AUC calculation
  const sortedPairs = yTrue.map((t, i) => ({ t, p: yProb[i] }))
    .sort((a, b) => b.p - a.p);
  let auc_raw = 0;
  let posSum = 0;
  const totalPos = yTrue.filter(y => y === 1).length;
  const totalNeg = yTrue.filter(y => y === 0).length;
  
  for (const pair of sortedPairs) {
    if (pair.t === 0) {
      auc_raw += posSum;
    } else {
      posSum++;
    }
  }
  auc_raw = totalPos * totalNeg > 0 ? auc_raw / (totalPos * totalNeg) : 0.5;

  // PR-AUC
  const pr_auc_raw = calcPRAUC(yTrue, yProb);

  const raw: Record<string, number> = { AUC: auc_raw, F1: f1_raw, Recall: recall_raw, Precisão: precision_raw, Acurácia: accuracy_raw, pr_auc: pr_auc_raw };

  // Validate raw metrics
  const invalid_reasons: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!isFinite(v)) invalid_reasons.push(`${k} = ${v} (not finite)`);
    else if (v < 0) invalid_reasons.push(`${k} = ${v.toFixed(4)} (negative)`);
    else if (v > 1.001) invalid_reasons.push(`${k} = ${v.toFixed(4)} (> 1.0)`);
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
  
  for (let i = 0; i < n; i++) {
    const error = yTrue[i] - yPred[i];
    sumAbsError += Math.abs(error);
    sumSquaredError += error * error;
    ssTot += Math.pow(yTrue[i] - yMean, 2);
    ssRes += error * error;
  }
  
  const mae = sumAbsError / n;
  const mse = sumSquaredError / n;
  const rmse = Math.sqrt(mse);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const raw: Record<string, number> = { MAE: mae, MSE: mse, RMSE: rmse, "R²": r2 };

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

  try {
    const { project_id } = await req.json();
    
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startMs = Date.now();
    console.log(`\n========================================`);
    console.log(`[AutoML] Iniciando treinamento para projeto: ${project_id}`);
    console.log(`========================================\n`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── SSOT: Mark training as running ──
    try {
      await supabase.rpc("rpc_update_pipeline_state", {
        p_project_id: project_id,
        p_stage: "training",
        p_new_state: "running",
      });
    } catch (_) { /* best-effort */ }

    // Helper to return structured block response
    const blockResponse = (code: string, message: string, cta: { label: string; go_to_step?: number } | null, details?: Record<string, unknown>) => {
      console.error(`[Gating] BLOCKED: ${code} — ${message}`);
      return new Response(JSON.stringify({
        status: "blocked",
        code,
        message_user: message,
        message_tech: `Training blocked by gate: ${code}`,
        cta,
        details: details || {},
        error: message,
        action: cta ? "navigate" : "review_target",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

    // ── Gate 1: Dataset (SSOT) ──
    if (dsState && (dsState.row_count > 0) && (dsState.col_count > 0)) {
      console.log(`[Gating] Dataset SSOT: ${dsState.row_count} rows, ${dsState.col_count} cols, virtual=${dsState.virtual_manifest}`);
      if (dsState.eda_ready === false) {
        return blockResponse("EDA_NOT_READY", "Dataset não está pronto para análise (EDA bloqueado).", { label: "Voltar à Etapa 2", go_to_step: 2 });
      }
    } else {
      // Fallback: check manifest
      const { data: manifest } = await supabase.from("import_manifests")
        .select("eda_ready, rows_consolidated").eq("project_id", project_id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!manifest || manifest.rows_consolidated === 0) {
        return blockResponse("NO_ACTIVE_DATASET", "Nenhum dataset ativo. Importe dados na Etapa 2.", { label: "Importar dados", go_to_step: 2 });
      }
      if (manifest.eda_ready === false) {
        return blockResponse("EDA_NOT_READY", "Dataset não está pronto para análise.", { label: "Voltar à Etapa 2", go_to_step: 2 });
      }
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
      .select("active_target_mode, active_target_column, active_target_ref, target_source, problem_type")
      .eq("project_id", project_id)
      .maybeSingle();
    
    const activeTarget = resolveActiveTarget((activeTargetSettings as any) || {});
    let useHumanLabelsAsTarget = false;
    let humanTargetStats: Awaited<ReturnType<typeof buildHumanTargetStats>> | null = null;
    
    if (activeTarget.mode === "human") {
      console.log(`[Gating] ⚡ Active target mode = HUMAN. Ignoring target_column="${target_column}" and template.`);
      
      // Validate human labels BEFORE proceeding
      humanTargetStats = await buildHumanTargetStats(supabase, project_id);
      
      // Persist trainability report
      const trainReport = buildTrainabilityReport(activeTarget, humanTargetStats);
      await supabase.from("project_settings")
        .update({ target_trainability_report: trainReport })
        .eq("project_id", project_id);
      
      if (humanTargetStats.reason_code) {
        console.error(`[Gating] ⛔ Human target blocked: ${humanTargetStats.reason_code}`);
        
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
          error: humanTargetStats.error_message,
          error_code: "TARGET_NOT_TRAINABLE",
          reason_code: humanTargetStats.reason_code,
          details: {
            active_target_mode: "human",
            join_rows: humanTargetStats.join_rows,
            distinct_y: humanTargetStats.distinct_y,
            pos: humanTargetStats.pos,
            neg: humanTargetStats.neg,
          },
          fix_suggestions: [
            { label: "Gerar nova amostra estratificada", action: "open_human_labeling" },
            { label: "Buscar classe faltante", action: "open_human_labeling" },
            { label: "Voltar para Variável Alvo", action: "go_to_step_3" },
          ],
          action: "review_target",
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      // Check minimum per class (30)
      const MIN_PER_CLASS_HUMAN = 30;
      const minClass = Math.min(humanTargetStats.pos, humanTargetStats.neg);
      if (minClass < MIN_PER_CLASS_HUMAN) {
        const minorityLabel = humanTargetStats.pos < humanTargetStats.neg ? "positivos" : "negativos";
        console.error(`[Gating] ⛔ Minority class too small: ${minClass} < ${MIN_PER_CLASS_HUMAN}`);
        
        await supabase.rpc("rpc_update_pipeline_state", {
          p_project_id: project_id, p_stage: "training", p_new_state: "failed",
        });
        
        return new Response(JSON.stringify({
          success: false,
          error: `Classe minoritária (${minorityLabel}) com apenas ${minClass} exemplos. Mínimo: ${MIN_PER_CLASS_HUMAN}.`,
          error_code: "TARGET_NOT_TRAINABLE",
          reason_code: "MINORITY_CLASS_TOO_SMALL",
          details: {
            active_target_mode: "human",
            join_rows: humanTargetStats.join_rows,
            distinct_y: humanTargetStats.distinct_y,
            pos: humanTargetStats.pos,
            neg: humanTargetStats.neg,
            min_per_class: MIN_PER_CLASS_HUMAN,
          },
          fix_suggestions: [
            { label: `Buscar ${minorityLabel}`, action: "open_human_labeling" },
            { label: "Gerar mais amostras", action: "open_human_labeling" },
          ],
          action: "review_target",
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      useHumanLabelsAsTarget = true;
      // For human mode, we still need a "target_column" reference for the CSV/Parquet path
      // but the actual y values will be overridden from human labels after data load
      console.log(`[Gating] Human target OK: ${humanTargetStats.join_rows} labels, ${humanTargetStats.pos}+ / ${humanTargetStats.neg}−`);
    }

    // ── Normalize virtual target: "label" → "_label_" when label builder is active ──
    if (!useHumanLabelsAsTarget && target_column === "label" && modelingDataset?.label_plan) {
      console.log(`[Gating] Normalizing target_column "label" → "_label_" (label builder active)`);
      target_column = "_label_";
    }

    // ── Gate 3: Builder (must be current + matching selection_version) ──
    const trainingWarningsGlobal: string[] = [];
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
      // Normalize: "binary" and "classification" are equivalent
      const normalizeProblemType = (t: string) => {
        const lower = t.toLowerCase();
        if (lower === "binary" || lower === "classification" || lower === "binary_classification") return "classification";
        if (lower === "regression" || lower === "continuous") return "regression";
        return lower;
      };
      const normalizedContract = contractProblemType ? normalizeProblemType(contractProblemType) : null;
      const normalizedSelection = problem_type ? normalizeProblemType(problem_type) : null;
      if (normalizedContract && normalizedSelection && normalizedContract !== normalizedSelection) {
        contractBlockedReason = `CONTRACT_PROBLEM_TYPE_MISMATCH: contract=${contractProblemType}, selection=${problem_type}`;
        return blockResponse(
          "CONTRACT_PROBLEM_TYPE_MISMATCH",
          `Tipo de problema incompatível: contrato diz "${contractProblemType}" mas seleção diz "${problem_type}". Corrija na Etapa 3.`,
          { label: "Revisar Target", go_to_step: 3 },
          { contract_problem_type: contractProblemType, selection_problem_type: problem_type }
        );
      }

      // (b)+(c) Check leakage_flags and blocked features from contract as guardrails
      const leakageFlags = (modelingContract.leakage_flags as any[]) || [];
      const criticalLeakage = leakageFlags.filter((f: any) => f.reason?.toLowerCase().includes("critical") || f.reason?.toLowerCase().includes("leakage"));
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
      
      if (isBatchImport && sourceMetadata.file_paths) {
        filePaths = sourceMetadata.file_paths as string[];
      } else {
        filePaths = [activeDataset.storage_path];
      }
      
      console.log(`[AutoML] Usando dataset ativo: ${activeDataset.name}`);
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

    // Detect if files are Parquet
    const useParquet = filePaths.some(p => isParquetFile(p, sourceMetadata));
    console.log(`[AutoML] Formato detectado: ${useParquet ? "Parquet" : "CSV"}`);

    // ==================== DATA READING (PARQUET vs CSV) ====================
    let headers: string[] = [];
    const X: number[][] = [];
    const y: number[] = [];
    const labelMap: Map<string, number> = new Map();
    let totalLinesRead = 0;

    if (useParquet) {
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
      const targetIndex = findHeaderIndex(headers, target_column);
      if (targetIndex === -1) {
        console.error(`Coluna alvo "${target_column}" não encontrada. Colunas disponíveis: ${headers.join(", ")}`);
        return new Response(JSON.stringify({ 
          error: `Coluna alvo "${target_column}" não encontrada no dataset.`,
          available_columns: headers.slice(0, 20)
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Use the actual header name from the file for row access
      const actualTargetName = headers[targetIndex];

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
        if (sampleStrategy === "stratified_quantile" && !isTargetCategorical) {
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
        const targetVal = row[target_column];
        
        if (isTargetCategorical) {
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

      // Free memory
      parquetResult.rows.length = 0;

      // Detect datetime column for smart split (Parquet path)
      {
        const dtCol = detectDatetimeColumn(headers, parquetResult.rows.length > 0 ? parquetResult.rows : rowsToProcess.slice(0, 2000), true);
        if (dtCol) {
          const dtValues: (number | null)[] = [];
          for (let i = 0; i < X.length; i++) {
            // We need to reconstruct from the sample — use a simpler approach
            // Parse the datetime from the original row order
          }
          // For Parquet, re-parse datetime from a small subset  
          const sampleForDt = rowsToProcess.slice(0, Math.min(rowsToProcess.length, X.length));
          const dtVals: (number | null)[] = [];
          for (const row of sampleForDt) {
            const val = row[dtCol];
            if (val) {
              const d = new Date(String(val));
              dtVals.push(!isNaN(d.getTime()) ? d.getTime() : null);
            } else {
              dtVals.push(null);
            }
          }
          // Only use if we have enough parsed values
          if (dtVals.filter(v => v !== null).length >= X.length * 0.8) {
            (globalThis as any).__datetimeValues = dtVals.slice(0, X.length);
            (globalThis as any).__datetimeCol = dtCol;
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
      const targetIndex = findHeaderIndex(headers, target_column);
      if (targetIndex === -1) {
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
        
        if (isTargetCategorical) {
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
      return new Response(JSON.stringify({ 
        error: `Dados insuficientes após parsing (${X.length} amostras válidas, mínimo: ${minSamplesRequired}). Verifique a qualidade dos dados.` 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
        return new Response(JSON.stringify({
          error: "Todas as features foram bloqueadas pela validação. Revise as colunas do dataset.",
          preflight_report: {
            target_valid: targetValidation.valid,
            target_issues: targetValidation.issues,
            target_suggestions: targetValidation.suggestions,
            features_blocked: featureValidation.blocked,
            features_block_reasons: featureValidation.blockReasons,
            warnings: featureValidation.warnings,
          },
          action: "review_features"
        }), {
          status: 400,
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
    // We need to detect these from the original headers/data
    // For now, use the column metadata we already have
    const datetimeColCandidates = headers.filter(h => 
      /^(data|dt_|date|timestamp|created|updated|dataneg|data_neg)/i.test(h.toLowerCase())
    );
    
    let datetimeValues: (number | null)[] | null = null;
    let detectedDatetimeCol: string | null = null;
    
    // Check if any datetime column was detected during data reading
    // We store raw datetime values during parsing for split
    if ((globalThis as any).__datetimeValues && (globalThis as any).__datetimeCol) {
      datetimeValues = (globalThis as any).__datetimeValues;
      detectedDatetimeCol = (globalThis as any).__datetimeCol;
      console.log(`[Split] Using detected datetime column: "${detectedDatetimeCol}"`);
    }
    
    // Detect group key from column uniqueness
    let groupValues: (string | null)[] | null = null;
    let detectedGroupKey: string | null = null;
    
    if (!datetimeValues && (globalThis as any).__groupValues && (globalThis as any).__groupCol) {
      groupValues = (globalThis as any).__groupValues;
      detectedGroupKey = (globalThis as any).__groupCol;
      console.log(`[Split] Using detected group key: "${detectedGroupKey}"`);
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

    // ==================== IMPROVEMENT VS BASELINE (use RAW metrics) ====================
    const primaryMetricKey = isClassification ? "AUC" : "R²";
    const modelPrimaryMetricRaw = detailedMetrics.raw[primaryMetricKey] ?? 0;
    const baselinePrimaryMetric = baselineMetrics[primaryMetricKey] ?? 0;
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
          metrics_profile: { id: metricsProfile.id, label: metricsProfile.label, primary: metricsProfile.primary, source: profileSource },
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
      metrics_profile: { id: metricsProfile.id, label: metricsProfile.label, primary: metricsProfile.primary, source: profileSource },
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
    console.error("Erro no treinamento:", error);

    // ── SSOT: Mark training as failed (best-effort) ──
    try {
      const body = await req.clone().json().catch(() => ({}));
      if (body.project_id) {
        const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await sb.rpc("rpc_update_pipeline_state", {
          p_project_id: body.project_id,
          p_stage: "training",
          p_new_state: "failed",
        });
      }
    } catch (_) { /* best-effort */ }

    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Erro desconhecido" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
