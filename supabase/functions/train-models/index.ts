import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
  const isLargeDataset = nRows > 200_000;
  const hasHighDimensionality = nFeatures > 100;
  const shouldUseLinearModel = isLargeDataset || hasHighDimensionality;

  console.log(`[AutoML] Dataset: ${nRows} linhas, ${nFeatures} features`);
  console.log(`[AutoML] Tipo: ${problemType}, Grande: ${isLargeDataset}, Alta dim: ${hasHighDimensionality}`);

  if (problemType === "classification") {
    if (shouldUseLinearModel) {
      return {
        id: "logistic_regression",
        name: "Regressão Logística Regularizada",
        type: "classification",
        algorithm: "logistic_regression",
        params: {
          epochs: 100,
          lambda: 0.1,
        },
        reason: `Dataset grande (${nRows.toLocaleString()} linhas) ou alta dimensionalidade (${nFeatures} features). Modelo linear é mais eficiente e generaliza bem.`,
      };
    } else {
      // For smaller datasets, use Gradient Boosting with conservative params
      return {
        id: "gradient_boosting_classifier",
        name: "Gradient Boosting Classifier",
        type: "classification",
        algorithm: "gradient_boosting",
        params: {
          nEstimators: 50,
          maxDepth: 6,
          learningRate: 0.1,
        },
        reason: `Dataset de tamanho moderado (${nRows.toLocaleString()} linhas). Gradient Boosting oferece excelente performance e interpretabilidade.`,
      };
    }
  } else {
    // Regression
    if (shouldUseLinearModel) {
      return {
        id: "linear_regression",
        name: "Regressão Linear Regularizada (Ridge)",
        type: "regression",
        algorithm: "linear_regression",
        params: {
          epochs: 100,
          lambda: 0.1,
        },
        reason: `Dataset grande (${nRows.toLocaleString()} linhas) ou alta dimensionalidade (${nFeatures} features). Modelo linear regularizado é robusto e escalável.`,
      };
    } else {
      return {
        id: "gradient_boosting_regressor",
        name: "Gradient Boosting Regressor",
        type: "regression",
        algorithm: "gradient_boosting",
        params: {
          nEstimators: 50,
          maxDepth: 6,
          learningRate: 0.1,
        },
        reason: `Dataset de tamanho moderado (${nRows.toLocaleString()} linhas). Gradient Boosting captura padrões não-lineares mantendo bom desempenho.`,
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

// Simple Decision Tree for Gradient Boosting
function trainSimpleTree(X: number[][], y: number[], maxDepth = 6): any {
  function buildTree(indices: number[], depth: number): any {
    if (depth >= maxDepth || indices.length < 5) {
      const values = indices.map(i => y[i]);
      return { isLeaf: true, value: mean(values) };
    }
    
    const numFeatures = X[0].length;
    let bestFeature = 0, bestThreshold = 0, bestScore = Infinity;
    
    // Sample features for faster training
    const featuresToCheck = Math.min(numFeatures, Math.max(5, Math.floor(Math.sqrt(numFeatures))));
    const featureIndices = shuffle(Array.from({ length: numFeatures }, (_, i) => i)).slice(0, featuresToCheck);
    
    for (const f of featureIndices) {
      const vals = indices.map(i => X[i][f]).sort((a, b) => a - b);
      const threshold = vals[Math.floor(vals.length / 2)];
      
      const leftIdx = indices.filter(i => X[i][f] <= threshold);
      const rightIdx = indices.filter(i => X[i][f] > threshold);
      
      if (leftIdx.length === 0 || rightIdx.length === 0) continue;
      
      const leftY = leftIdx.map(i => y[i]);
      const rightY = rightIdx.map(i => y[i]);
      
      // MSE for split quality
      const score = leftY.reduce((a, v) => a + Math.pow(v - mean(leftY), 2), 0) +
                    rightY.reduce((a, v) => a + Math.pow(v - mean(rightY), 2), 0);
      
      if (score < bestScore) {
        bestScore = score;
        bestFeature = f;
        bestThreshold = threshold;
      }
    }
    
    const leftIdx = indices.filter(i => X[i][bestFeature] <= bestThreshold);
    const rightIdx = indices.filter(i => X[i][bestFeature] > bestThreshold);
    
    if (leftIdx.length === 0 || rightIdx.length === 0) {
      const values = indices.map(i => y[i]);
      return { isLeaf: true, value: mean(values) };
    }
    
    return {
      isLeaf: false,
      feature: bestFeature,
      threshold: bestThreshold,
      left: buildTree(leftIdx, depth + 1),
      right: buildTree(rightIdx, depth + 1)
    };
  }
  
  return buildTree(Array.from({ length: X.length }, (_, i) => i), 0);
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
  // Subsample for faster training
  const maxSamples = Math.min(X.length, 5000);
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

// ==================== SINGLE MODEL TRAINING ====================

interface TrainResult {
  model: any;
  predictions: number[];
  metrics: Record<string, number>;
  featureImportances: { feature_name: string; importance_value: number }[];
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
      // Use Gradient Boosting as fallback (similar performance, more stable)
      model = trainGradientBoosting(
        Xtrain, 
        ytrain, 
        isClassification,
        strategy.params.nEstimators || 50,
        strategy.params.maxDepth || 6,
        0.3 // Higher learning rate for RF-like behavior
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
  
  console.log(`[AutoML] Métricas:`, metrics);
  
  return { model, predictions, metrics, featureImportances };
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

    // Update project status to training
    await supabase
      .from("projects")
      .update({ status: "training" })
      .eq("id", project_id);

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

    // Get active dataset from project_datasets
    const { data: activeDataset, error: datasetError } = await supabase
      .from("project_datasets")
      .select("*")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .single();

    if (datasetError || !activeDataset) {
      console.error("Erro ao buscar dataset ativo:", datasetError);
      return new Response(JSON.stringify({ error: "Dataset ativo não encontrado" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Determine sampling strategy based on dataset size
    const totalDatasetRows = activeDataset.total_rows || 0;
    const sourceMetadata = activeDataset.source_metadata as Record<string, any> || {};
    const delimiter = sourceMetadata.delimiter || ";";
    const isBatchImport = activeDataset.source_type === "batch_import";

    // SAMPLING STRATEGY:
    // - Small datasets (≤ 100k): Use 100% of data
    // - Medium datasets (100k-300k): Sample up to 50k
    // - Large datasets (> 300k): Sample up to 30k with early stop
    let MAX_SAMPLE_SIZE: number;
    let MAX_LINES_TO_READ: number;
    let useFullDataset = false;

    if (totalDatasetRows <= 100_000) {
      MAX_SAMPLE_SIZE = 100_000;
      MAX_LINES_TO_READ = 150_000;
      useFullDataset = true;
      console.log(`[AutoML] Dataset pequeno (${totalDatasetRows} linhas) - usando 100% dos dados`);
    } else if (totalDatasetRows <= 300_000) {
      MAX_SAMPLE_SIZE = 50_000;
      MAX_LINES_TO_READ = 150_000;
      console.log(`[AutoML] Dataset médio (${totalDatasetRows} linhas) - amostrando até ${MAX_SAMPLE_SIZE} linhas`);
    } else {
      MAX_SAMPLE_SIZE = 30_000;
      MAX_LINES_TO_READ = 90_000;
      console.log(`[AutoML] Dataset grande (${totalDatasetRows} linhas) - amostrando até ${MAX_SAMPLE_SIZE} linhas com early stop`);
    }

    console.log(`Dataset: ${activeDataset.storage_path}, Batch: ${isBatchImport}, Delimiter: ${delimiter}`);

    // Collect all file paths to download
    let filePaths: string[] = [];
    
    if (isBatchImport && sourceMetadata.file_paths) {
      filePaths = sourceMetadata.file_paths as string[];
    } else {
      filePaths = [activeDataset.storage_path];
    }

    if (filePaths.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum arquivo encontrado no dataset" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Arquivos para processar: ${filePaths.length}`);

    // Stream data from files with stratified sampling
    let sampledLines: string[] = [];
    let headers: string[] = [];
    let isFirstFile = true;
    let totalBytesRead = 0;
    let totalLinesProcessed = 0;
    let reachedSampleLimit = false;

    console.log(`[AutoML] Iniciando leitura (máx ${MAX_SAMPLE_SIZE} linhas, early stop após ${MAX_LINES_TO_READ})...`);

    for (let fileIndex = 0; fileIndex < filePaths.length && !reachedSampleLimit; fileIndex++) {
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
              
              totalLinesProcessed++;
              if (sampledLines.length < MAX_SAMPLE_SIZE) {
                sampledLines.push(line);
              } else if (!useFullDataset) {
                // Reservoir sampling for diversity
                const replaceIdx = Math.floor(Math.random() * MAX_SAMPLE_SIZE);
                if (Math.random() < 0.1) {
                  sampledLines[replaceIdx] = line;
                }
              }
            } else {
              totalLinesProcessed++;
              if (sampledLines.length < MAX_SAMPLE_SIZE) {
                sampledLines.push(line);
              } else if (!useFullDataset) {
                const replaceIdx = Math.floor(Math.random() * MAX_SAMPLE_SIZE);
                if (Math.random() < 0.1) {
                  sampledLines[replaceIdx] = line;
                }
              }
            }
            
            if (totalLinesProcessed >= MAX_LINES_TO_READ) {
              shouldStopReading = true;
              reachedSampleLimit = true;
              console.log(`  Early stop: lidas ${totalLinesProcessed} linhas, amostra de ${sampledLines.length} linhas`);
              break;
            }
          }
          
          buffer = lineBreaks[lineBreaks.length - 1];
          
          const mbRead = bytesRead / (1024 * 1024);
          if (mbRead - lastProgressLog >= 50) {
            console.log(`  Progresso: ${mbRead.toFixed(1)} MB, ${totalLinesProcessed} linhas lidas`);
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

    console.log(`\n=== Leitura completa ===`);
    console.log(`Total de arquivos: ${filePaths.length}`);
    console.log(`Total de bytes: ${(totalBytesRead / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Linhas lidas: ${totalLinesProcessed}`);
    console.log(`Linhas amostradas: ${sampledLines.length}`);
    
    const allLines = sampledLines;

    if (headers.length === 0 || allLines.length === 0) {
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
    const featureNames = featureIndices.map(i => headers[i]);

    if (featureNames.length === 0) {
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
    
    console.log(`\nFeatures: ${featureNames.length} colunas numéricas`);
    console.log(`Target: ${target_column} (categorical: ${isTargetCategorical})`);

    // Parse data
    const X: number[][] = [];
    const y: number[] = [];
    const labelMap: Map<string, number> = new Map();
    
    for (let i = 0; i < allLines.length; i++) {
      const values = parseCSVLine(allLines[i], delimiter);
      
      if (isTargetCategorical) {
        const targetVal = values[targetIndex]?.trim() || "";
        if (targetVal && !labelMap.has(targetVal)) {
          labelMap.set(targetVal, labelMap.size);
        }
      }
      
      const features = featureIndices.map(idx => {
        const val = values[idx]?.replace(",", ".") || "";
        return parseFloat(val);
      });
      
      let targetNumeric: number;
      if (isTargetCategorical) {
        const targetVal = values[targetIndex]?.trim() || "";
        targetNumeric = labelMap.get(targetVal) ?? -1;
      } else {
        targetNumeric = parseFloat(values[targetIndex]?.replace(",", ".") || "");
      }
      
      if (features.every(f => !isNaN(f)) && targetNumeric !== -1 && !isNaN(targetNumeric)) {
        X.push(features);
        y.push(targetNumeric);
      }
      
      allLines[i] = "";
    }
    
    sampledLines.length = 0;
    
    if (isTargetCategorical && labelMap.size > 0) {
      console.log(`Label encoding: ${JSON.stringify(Object.fromEntries(labelMap))}`);
    }

    console.log(`\nDados válidos: ${X.length} amostras, ${featureNames.length} features`);

    if (X.length < 10) {
      return new Response(JSON.stringify({ 
        error: `Dados insuficientes para treinamento (${X.length} amostras válidas).` 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Normalize data
    const { normalized: Xnorm } = normalize(X);

    // Split train/test (80/20)
    const shuffledIndices = shuffle(Array.from({ length: X.length }, (_, i) => i));
    const splitIdx = Math.floor(X.length * 0.8);
    const trainIdx = shuffledIndices.slice(0, splitIdx);
    const testIdx = shuffledIndices.slice(splitIdx);

    const Xtrain = trainIdx.map(i => Xnorm[i]);
    const ytrain = trainIdx.map(i => y[i]);
    const Xtest = testIdx.map(i => Xnorm[i]);
    const ytest = testIdx.map(i => y[i]);

    const isClassification = problem_type === "classification";
    const numClasses = isTargetCategorical ? labelMap.size : new Set(y).size;
    
    // For classification, convert to binary if needed
    let ytrainFinal = ytrain;
    let ytestFinal = ytest;
    
    if (isClassification && numClasses === 2) {
      const uniqueVals = [...new Set(y)].sort((a, b) => a - b);
      ytrainFinal = ytrain.map(v => v === uniqueVals[0] ? 0 : 1);
      ytestFinal = ytest.map(v => v === uniqueVals[0] ? 0 : 1);
    }

    console.log(`\nTreino: ${Xtrain.length} amostras, Teste: ${Xtest.length} amostras`);
    console.log(`Tipo: ${problem_type}, Classes: ${numClasses}`);

    // ============ SELECT BEST MODEL ============
    const strategy = selectBestModelStrategy(
      problem_type as "classification" | "regression",
      totalDatasetRows,
      featureNames.length
    );

    console.log(`\n[AutoML] Modelo selecionado: ${strategy.name}`);
    console.log(`[AutoML] Razão: ${strategy.reason}`);

    // Delete existing models for this project
    await supabase
      .from("project_models")
      .delete()
      .eq("project_id", project_id);

    // ============ TRAIN SINGLE MODEL ============
    const trainResult = trainSingleModel(
      strategy,
      Xtrain,
      isClassification ? ytrainFinal : ytrain,
      Xtest,
      isClassification ? ytestFinal : ytest,
      featureNames
    );

    // Save model to database
    const { data: modelData, error: modelError } = await supabase
      .from("project_models")
      .insert({
        project_id,
        algorithm_name: strategy.name,
        problem_type,
        status: "trained",
        is_production: true, // Auto-set as production since it's the only model
        trained_at: new Date().toISOString(),
        hyperparameters: {
          strategy_id: strategy.id,
          algorithm: strategy.algorithm,
          params: strategy.params,
          reason: strategy.reason,
          n_train_rows: Xtrain.length,
          n_test_rows: Xtest.length,
          sample_size_used: X.length,
          total_rows_dataset: totalDatasetRows,
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

    console.log(`\n========================================`);
    console.log(`[AutoML] Treinamento concluído com sucesso!`);
    console.log(`[AutoML] Modelo: ${strategy.name}`);
    console.log(`[AutoML] Métrica principal: ${isClassification ? trainResult.metrics.AUC : trainResult.metrics["R²"]}`);
    console.log(`========================================\n`);

    return new Response(JSON.stringify({ 
      success: true, 
      message: "Treinamento concluído",
      model: {
        id: modelData.id,
        name: strategy.name,
        algorithm: strategy.algorithm,
        reason: strategy.reason,
        metrics: trainResult.metrics,
        sample_info: {
          total_dataset_rows: totalDatasetRows,
          sample_used: X.length,
          train_rows: Xtrain.length,
          test_rows: Xtest.length,
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
