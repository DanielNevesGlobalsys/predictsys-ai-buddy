import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parquetRead } from "npm:hyparquet@1.24.1";
import { applyFeatureTransforms, type ProjectFeature } from "../_shared/feature-engineering.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ==================== SAMPLING CONSTANTS ====================
// Minimum absolute rows required for reliable training
const MIN_ROWS_FOR_TRAIN = 5_000;
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

// ==================== METRICS ====================

function calcClassificationMetrics(yTrue: number[], yProb: number[]): Record<string, number> {
  const yPred = yProb.map(p => p >= 0.5 ? 1 : 0);
  let tp = 0, tn = 0, fp = 0, fn = 0;
  
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] === 1 && yPred[i] === 1) tp++;
    else if (yTrue[i] === 0 && yPred[i] === 0) tn++;
    else if (yTrue[i] === 0 && yPred[i] === 1) fp++;
    else fn++;
  }
  
  const accuracy = (tp + tn) / (tp + tn + fp + fn) || 0;
  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const f1 = 2 * precision * recall / (precision + recall) || 0;
  
  // AUC calculation
  const sortedPairs = yTrue.map((t, i) => ({ t, p: yProb[i] }))
    .sort((a, b) => b.p - a.p);
  let auc = 0;
  let posSum = 0;
  const totalPos = yTrue.filter(y => y === 1).length;
  const totalNeg = yTrue.filter(y => y === 0).length;
  
  for (const pair of sortedPairs) {
    if (pair.t === 0) {
      auc += posSum;
    } else {
      posSum++;
    }
  }
  auc = totalPos * totalNeg > 0 ? auc / (totalPos * totalNeg) : 0.5;
  
  return { AUC: auc, F1: f1, Recall: recall, Precisão: precision, Acurácia: accuracy };
}

function calcRegressionMetrics(yTrue: number[], yPred: number[]): Record<string, number> {
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
  
  return { MAE: mae, MSE: mse, RMSE: rmse, "R²": r2 };
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

function checkPredictionSanity(predictions: number[], yTrue?: number[]): PredictionSanity {
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
  
  const sanity = checkPredictionSanity(predictions, isClassification ? undefined : ytest);
  
  console.log(`[AutoML] Métricas:`, metrics);
  console.log(`[AutoML] Sanity: passed=${sanity.passed}, pred_std=${sanity.pred_std.toFixed(6)}, pct_mode=${(sanity.pct_equal_mode_pred * 100).toFixed(1)}%`);
  
  return { model, predictions, metrics, featureImportances, sanity };
}

// ==================== CSV PARSING ====================

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

    console.log(`\n========================================`);
    console.log(`[AutoML] Iniciando treinamento para projeto: ${project_id}`);
    console.log(`========================================\n`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get project info
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      console.error("Projeto não encontrado:", projectError);
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { target_column, problem_type } = project;

    if (!target_column) {
      return new Response(JSON.stringify({ error: "Coluna alvo não definida" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
      filePaths = [project.dataset_filename];
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
        return new Response(JSON.stringify({ error: "Não foi possível ler dados do arquivo Parquet" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Find target column index
      const targetIndex = headers.indexOf(target_column);
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

      // Get numeric feature columns
      const numericColumns = columns.filter(c => 
        (c.inferred_type === "numérico" || c.inferred_type === "numerico") && c.column_name !== target_column
      );
      const baseFeatureNames = numericColumns.map(c => c.column_name).filter(n => headers.includes(n));
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

      console.log(`[AutoML] Iniciando leitura CSV... Delimiter: ${delimiter}`);

      for (let fileIndex = 0; fileIndex < filePaths.length && !reachedReadLimit; fileIndex++) {
        const filePath = filePaths[fileIndex];
        console.log(`[${fileIndex + 1}/${filePaths.length}] Streaming: ${filePath}`);
        
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
              
              if (isFirstFile && isFirstLineOfFile) {
                headers = parseCSVLine(line, delimiter);
                console.log(`Headers detectados: ${headers.slice(0, 5).join(", ")}... (${headers.length} total)`);
                isFirstLineOfFile = false;
              } else if (!isFirstFile && isFirstLineOfFile) {
                const possibleHeaders = parseCSVLine(line, delimiter);
                const matchesHeaders = possibleHeaders.length === headers.length && 
                  possibleHeaders.slice(0, 3).every((h, idx) => h === headers[idx]);
                
                if (matchesHeaders) {
                  isFirstLineOfFile = false;
                  continue;
                }
                isFirstLineOfFile = false;
                
                totalLinesRead++;
                sampledLines.push(line);
              } else {
                totalLinesRead++;
                sampledLines.push(line);
              }
              
              // Check early stop for large datasets
              if (!useFullDataset && totalLinesRead >= effectiveMaxRowsToRead) {
                shouldStopReading = true;
                reachedReadLimit = true;
                console.log(`  Early stop: lidas ${totalLinesRead.toLocaleString()} linhas`);
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

      // Find target column index
      const targetIndex = headers.indexOf(target_column);
      if (targetIndex === -1) {
        console.error(`Coluna alvo "${target_column}" não encontrada.`);
        return new Response(JSON.stringify({ 
          error: `Coluna alvo "${target_column}" não encontrada no dataset.` 
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get numeric feature columns
      const numericColumns = columns.filter(c => 
        (c.inferred_type === "numérico" || c.inferred_type === "numerico") && c.column_name !== target_column
      );
      const featureIndices = numericColumns.map(c => headers.indexOf(c.column_name)).filter(i => i !== -1);
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
        
        // Get base features
        const baseFeatures = featureIndices.map(idx => {
          const val = values[idx]?.replace(",", ".") || "";
          return parseFloat(val);
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
        
        if (allFeatures.every(f => !isNaN(f)) && targetNumeric !== -1 && !isNaN(targetNumeric)) {
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

    if (X.length < 100) {
      return new Response(JSON.stringify({ 
        error: `Dados insuficientes após parsing (${X.length} amostras válidas). Verifique a qualidade dos dados.` 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ==================== PREFLIGHT VALIDATION ====================
    console.log(`\n=== Preflight Validation ===`);

    // A1: Validate target
    const targetValidation = validateTarget(y, target_column, problem_type, isTargetCategorical, labelMap);
    
    if (targetValidation.issues.length > 0) {
      console.warn(`[Preflight] Target issues:`);
      targetValidation.issues.forEach(i => console.warn(`  ❌ ${i}`));
    }
    if (targetValidation.suggestions.length > 0) {
      targetValidation.suggestions.forEach(s => console.log(`  💡 ${s}`));
    }

    // Block training if target is critically invalid
    const criticalTargetIssues = targetValidation.issues.filter(i => 
      i.includes("variância zero") || 
      i.includes("cardinalidade 1") ||
      i.includes("ID sequencial")
    );
    
    if (criticalTargetIssues.length > 0) {
      console.error(`[Preflight] ⛔ Target inválido — treinamento bloqueado.`);
      
      await supabase.from("projects").update({ status: "target_invalid" }).eq("id", project_id);
      
      return new Response(JSON.stringify({
        error: "Target inválido para treinamento",
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
        status: 400,
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

    // Compare and pick best
    const primaryMetricName = isClassification ? "AUC" : "R²";
    const scoreA = resultA.metrics[primaryMetricName] ?? -Infinity;
    const scoreB = resultB.metrics[primaryMetricName] ?? -Infinity;
    
    console.log(`\n=== Model Comparison ===`);
    console.log(`Modelo A (${strategyA.name}): ${primaryMetricName}=${scoreA.toFixed(4)}, sanity=${resultA.sanity.passed}`);
    console.log(`Modelo B (${strategyB.name}): ${primaryMetricName}=${scoreB.toFixed(4)}, sanity=${resultB.sanity.passed}`);

    // Selection logic: prefer model with better score AND passing sanity
    let trainResult: TrainResult;
    let strategy: ModelStrategy;
    
    if (resultA.sanity.passed && resultB.sanity.passed) {
      // Both pass sanity — pick by score
      if (scoreB > scoreA) {
        trainResult = resultB;
        strategy = strategyB;
        console.log(`[AutoML] ✅ Selecionado Modelo B (melhor score)`);
      } else {
        trainResult = resultA;
        strategy = strategyA;
        console.log(`[AutoML] ✅ Selecionado Modelo A (melhor score)`);
      }
    } else if (resultB.sanity.passed && !resultA.sanity.passed) {
      trainResult = resultB;
      strategy = strategyB;
      console.log(`[AutoML] ✅ Selecionado Modelo B (Modelo A falhou sanity)`);
    } else if (resultA.sanity.passed && !resultB.sanity.passed) {
      trainResult = resultA;
      strategy = strategyA;
      console.log(`[AutoML] ✅ Selecionado Modelo A (Modelo B falhou sanity)`);
    } else {
      // Both fail sanity — pick the one with higher score anyway
      trainResult = scoreB > scoreA ? resultB : resultA;
      strategy = scoreB > scoreA ? strategyB : strategyA;
      console.warn(`[AutoML] ⚠️ Ambos modelos falharam sanity check — selecionado melhor score`);
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

    // ==================== MODEL QUALITY CHECK (metrics + sanity) ====================
    let modelQualityFlag = "ok";
    const modelR2 = trainResult.metrics["R²"];
    const modelAUC = trainResult.metrics["AUC"];
    
    if (!isClassification && modelR2 !== undefined && modelR2 < 0) {
      modelQualityFlag = "fail";
      console.warn(`[AutoML] ⚠️ R² negativo (${modelR2.toFixed(4)}) — modelo PIOR que baseline!`);
    } else if (isClassification && modelAUC !== undefined && modelAUC < 0.55) {
      modelQualityFlag = "fail";
      console.warn(`[AutoML] ⚠️ AUC abaixo de 0.55 (${modelAUC.toFixed(4)}) — insuficiente!`);
    }
    
    // Sanity check override
    if (!trainResult.sanity.passed) {
      modelQualityFlag = "fail";
      console.warn(`[AutoML] ⚠️ Prediction sanity FAILED: ${trainResult.sanity.fail_reasons.join("; ")}`);
    }
    
    const shouldPromoteToProduction = modelQualityFlag === "ok";
    
    if (!shouldPromoteToProduction) {
      console.warn(`[AutoML] ⚠️ Modelo NÃO será promovido para produção automaticamente.`);
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

    // Update project status to evaluated
    await supabase
      .from("projects")
      .update({ status: "evaluated" })
      .eq("id", project_id);

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

    console.log(`\n========================================`);
    console.log(`[AutoML] Treinamento concluído com sucesso!`);
    console.log(`[AutoML] Modelo: ${strategy.name}`);
    console.log(`[AutoML] Métrica principal: ${isClassification ? trainResult.metrics.AUC : trainResult.metrics["R²"]}`);
    console.log(`========================================\n`);

    return new Response(JSON.stringify({ 
      success: true, 
      message: modelQualityFlag === "ok" 
        ? "Treinamento concluído" 
        : "Treinamento concluído — modelo abaixo do baseline",
      model_quality_flag: modelQualityFlag,
      baseline_metrics: baselineMetrics,
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
        metrics: trainResult.metrics,
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
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Erro desconhecido" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
