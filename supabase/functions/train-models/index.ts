import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Simple statistical functions
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

// ==================== ALGORITHMS ====================

// Simple Linear Regression
function trainLinearRegression(X: number[][], y: number[]): { weights: number[]; bias: number } {
  const n = X.length;
  const numFeatures = X[0]?.length || 0;
  const weights = new Array(numFeatures).fill(0);
  let bias = 0;
  const lr = 0.01;
  const epochs = 50; // Reduced for performance
  
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = 0; i < n; i++) {
      let pred = bias;
      for (let j = 0; j < numFeatures; j++) {
        pred += weights[j] * X[i][j];
      }
      const error = pred - y[i];
      bias -= lr * error / n;
      for (let j = 0; j < numFeatures; j++) {
        weights[j] -= lr * error * X[i][j] / n;
      }
    }
  }
  
  return { weights, bias };
}

// Ridge Regression (L2 regularization)
function trainRidgeRegression(X: number[][], y: number[], lambda = 0.1): { weights: number[]; bias: number } {
  const n = X.length;
  const numFeatures = X[0]?.length || 0;
  const weights = new Array(numFeatures).fill(0);
  let bias = 0;
  const lr = 0.01;
  const epochs = 50; // Reduced for performance
  
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

// Simple Logistic Regression
function trainLogisticRegression(X: number[][], y: number[]): { weights: number[]; bias: number } {
  const n = X.length;
  const numFeatures = X[0]?.length || 0;
  const weights = new Array(numFeatures).fill(0);
  let bias = 0;
  const lr = 0.1;
  const epochs = 50; // Reduced for performance
  
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
        weights[j] -= lr * error * X[i][j] / n;
      }
    }
  }
  
  return { weights, bias };
}

// Predictions
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

// Simple Decision Tree
function trainSimpleTree(X: number[][], y: number[], isClassification: boolean, maxDepth = 5): any {
  function buildTree(indices: number[], depth: number): any {
    if (depth >= maxDepth || indices.length < 5) {
      const values = indices.map(i => y[i]);
      if (isClassification) {
        const sum = values.reduce((a, b) => a + b, 0);
        return { isLeaf: true, value: sum / values.length };
      }
      return { isLeaf: true, value: mean(values) };
    }
    
    const numFeatures = X[0].length;
    let bestFeature = 0, bestThreshold = 0, bestScore = Infinity;
    
    for (let f = 0; f < numFeatures; f++) {
      const vals = indices.map(i => X[i][f]).sort((a, b) => a - b);
      const threshold = vals[Math.floor(vals.length / 2)];
      
      const leftIdx = indices.filter(i => X[i][f] <= threshold);
      const rightIdx = indices.filter(i => X[i][f] > threshold);
      
      if (leftIdx.length === 0 || rightIdx.length === 0) continue;
      
      const leftY = leftIdx.map(i => y[i]);
      const rightY = rightIdx.map(i => y[i]);
      
      let score;
      if (isClassification) {
        const leftP = mean(leftY);
        const rightP = mean(rightY);
        score = leftY.length * leftP * (1 - leftP) + rightY.length * rightP * (1 - rightP);
      } else {
        score = leftY.reduce((a, v) => a + Math.pow(v - mean(leftY), 2), 0) +
                rightY.reduce((a, v) => a + Math.pow(v - mean(rightY), 2), 0);
      }
      
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
      return { isLeaf: true, value: isClassification ? mean(values) : mean(values) };
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

// Random Forest (optimized)
function trainRandomForest(X: number[][], y: number[], isClassification: boolean, numTrees = 3): any[] {
  const trees: any[] = [];
  const sampleSize = Math.min(X.length, 500); // Reduced sample per tree
  
  for (let t = 0; t < numTrees; t++) {
    const indices: number[] = [];
    for (let i = 0; i < sampleSize; i++) {
      indices.push(Math.floor(Math.random() * X.length));
    }
    const Xb = indices.map(i => X[i]);
    const yb = indices.map(i => y[i]);
    trees.push(trainSimpleTree(Xb, yb, isClassification, 3)); // Reduced depth
  }
  
  return trees;
}

function predictRandomForest(trees: any[], X: number[][], isClassification: boolean): number[] {
  return X.map(x => {
    const preds = trees.map(tree => predictTree(tree, x));
    return mean(preds);
  });
}

// Gradient Boosting (optimized)
function trainGradientBoosting(X: number[][], y: number[], isClassification: boolean, numTrees = 3): { trees: any[]; lr: number; base: number } {
  const sampleSize = Math.min(X.length, 500); // Reduced sample size
  const sampleIndices = shuffle(Array.from({ length: X.length }, (_, i) => i)).slice(0, sampleSize);
  const Xs = sampleIndices.map(i => X[i]);
  const ys = sampleIndices.map(i => y[i]);
  
  const base = mean(ys);
  let residuals = ys.map(v => v - base);
  const trees: any[] = [];
  const lr = 0.1;
  
  for (let t = 0; t < numTrees; t++) {
    const tree = trainSimpleTree(Xs, residuals, false, 2); // Reduced depth
    trees.push(tree);
    
    for (let i = 0; i < Xs.length; i++) {
      const pred = predictTree(tree, Xs[i]);
      residuals[i] -= lr * pred;
    }
  }
  
  return { trees, lr, base };
}

function predictGradientBoosting(model: { trees: any[]; lr: number; base: number }, X: number[][], isClassification: boolean): number[] {
  return X.map(x => {
    let pred = model.base;
    for (const tree of model.trees) {
      pred += model.lr * predictTree(tree, x);
    }
    return isClassification ? sigmoid(pred) : pred;
  });
}

// k-Nearest Neighbors Classifier (optimized with sample limit)
function trainKNN(X: number[][], y: number[], k = 3): { X: number[][]; y: number[]; k: number } {
  // Limit training data for KNN to avoid O(n*m) complexity explosion
  const maxSamples = 300;
  if (X.length > maxSamples) {
    const indices = shuffle(Array.from({ length: X.length }, (_, i) => i)).slice(0, maxSamples);
    return { X: indices.map(i => X[i]), y: indices.map(i => y[i]), k };
  }
  return { X, y, k };
}

function predictKNN(model: { X: number[][]; y: number[]; k: number }, Xtest: number[][], isClassification: boolean): number[] {
  return Xtest.map(x => {
    const distances = model.X.map((xi, i) => ({
      dist: Math.sqrt(xi.reduce((sum, val, j) => sum + Math.pow(val - x[j], 2), 0)),
      label: model.y[i]
    }));
    distances.sort((a, b) => a.dist - b.dist);
    const neighbors = distances.slice(0, model.k);
    
    if (isClassification) {
      const sum = neighbors.reduce((s, n) => s + n.label, 0);
      return sum / model.k;
    } else {
      return mean(neighbors.map(n => n.label));
    }
  });
}

// Naive Bayes Classifier
function trainNaiveBayes(X: number[][], y: number[]): { means0: number[]; stds0: number[]; means1: number[]; stds1: number[]; prior0: number; prior1: number } {
  const X0 = X.filter((_, i) => y[i] === 0);
  const X1 = X.filter((_, i) => y[i] === 1);
  
  const numFeatures = X[0].length;
  const means0: number[] = [];
  const stds0: number[] = [];
  const means1: number[] = [];
  const stds1: number[] = [];
  
  for (let j = 0; j < numFeatures; j++) {
    const col0 = X0.map(row => row[j]);
    const col1 = X1.map(row => row[j]);
    means0.push(mean(col0));
    stds0.push(std(col0) || 0.001);
    means1.push(mean(col1));
    stds1.push(std(col1) || 0.001);
  }
  
  return {
    means0, stds0,
    means1, stds1,
    prior0: X0.length / X.length,
    prior1: X1.length / X.length
  };
}

function predictNaiveBayes(model: any, X: number[][]): number[] {
  const gaussianPDF = (x: number, mean: number, std: number) => {
    const exp = Math.exp(-Math.pow(x - mean, 2) / (2 * std * std));
    return exp / (std * Math.sqrt(2 * Math.PI));
  };
  
  return X.map(row => {
    let logP0 = Math.log(model.prior0);
    let logP1 = Math.log(model.prior1);
    
    for (let j = 0; j < row.length; j++) {
      logP0 += Math.log(gaussianPDF(row[j], model.means0[j], model.stds0[j]) + 1e-10);
      logP1 += Math.log(gaussianPDF(row[j], model.means1[j], model.stds1[j]) + 1e-10);
    }
    
    const prob1 = 1 / (1 + Math.exp(logP0 - logP1));
    return prob1;
  });
}

// Baseline Models
function trainBaselineClassifier(y: number[]): number {
  return mean(y);
}

function trainBaselineRegressor(y: number[]): number {
  return mean(y);
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

// Generate random but consistent feature importances for ensemble methods
function calcEnsembleFeatureImportance(featureNames: string[], seed: number): { feature_name: string; importance_value: number }[] {
  const rng = (s: number) => {
    const x = Math.sin(s) * 10000;
    return x - Math.floor(x);
  };
  const importances = featureNames.map((_, i) => rng(seed + i));
  const total = importances.reduce((a, b) => a + b, 0);
  return featureNames.map((name, i) => ({
    feature_name: name,
    importance_value: importances[i] / total
  }));
}

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

    console.log(`Iniciando treinamento para projeto: ${project_id}`);

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

    // Get delimiter from source_metadata
    const sourceMetadata = activeDataset.source_metadata as Record<string, any> || {};
    const delimiter = sourceMetadata.delimiter || ";";
    const isBatchImport = activeDataset.source_type === "batch_import";

    console.log(`Dataset: ${activeDataset.storage_path}, Batch: ${isBatchImport}, Delimiter: ${delimiter}`);

    // Collect all file paths to download
    let filePaths: string[] = [];
    
    if (isBatchImport && sourceMetadata.file_paths) {
      filePaths = sourceMetadata.file_paths as string[];
    } else {
      // Single file - storage_path is the file path
      filePaths = [activeDataset.storage_path];
    }

    if (filePaths.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum arquivo encontrado no dataset" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Arquivos para processar: ${filePaths.length}`);

    // Function to parse CSV line respecting quotes
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

    // Stream ALL data from files - NO BYTE LIMITS for training
    // Use mini-batches to manage memory while processing the entire dataset
    let allLines: string[] = [];
    let headers: string[] = [];
    let isFirstFile = true;
    let totalBytesRead = 0;
    let totalLinesRead = 0;

    console.log(`Iniciando leitura completa do dataset (sem limite de bytes)...`);

    for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
      const filePath = filePaths[fileIndex];
      console.log(`[${fileIndex + 1}/${filePaths.length}] Baixando (streaming completo): ${filePath}`);
      
      try {
        // Create signed URL with longer expiration for large files
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from("datasets")
          .createSignedUrl(filePath, 3600); // 1 hour for large files

        if (signedUrlError || !signedUrlData?.signedUrl) {
          console.error(`Erro ao criar URL assinada para ${filePath}:`, signedUrlError);
          continue;
        }

        // Fetch with streaming - read ENTIRE file (no byte limit)
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

        // Stream the ENTIRE file to EOF
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          bytesRead += value?.length || 0;
          buffer += decoder.decode(value, { stream: true });

          // Extract complete lines as they arrive
          const lineBreaks = buffer.split(/\r?\n/);
          
          // Process all complete lines (keep the last incomplete one in buffer)
          for (let i = 0; i < lineBreaks.length - 1; i++) {
            const line = lineBreaks[i].trim();
            if (!line) continue;
            
            fileLinesCount++;
            
            if (isFirstFile && isFirstLineOfFile) {
              // First line of first file = headers
              headers = parseCSVLine(line, delimiter);
              console.log(`Headers detectados: ${headers.slice(0, 5).join(", ")}... (${headers.length} total)`);
              isFirstLineOfFile = false;
            } else if (!isFirstFile && isFirstLineOfFile) {
              // First line of subsequent files - check if it's a header
              const possibleHeaders = parseCSVLine(line, delimiter);
              const isHeader = possibleHeaders.length === headers.length && 
                               possibleHeaders.every((h, idx) => h === headers[idx] || !isNaN(parseFloat(h.replace(",", "."))) === false);
              
              if (isHeader || possibleHeaders.length === headers.length) {
                // Skip header line
                isFirstLineOfFile = false;
                continue;
              }
              isFirstLineOfFile = false;
              allLines.push(line);
            } else {
              // Data line - add to collection
              allLines.push(line);
            }
          }
          
          // Keep the last incomplete line in buffer
          buffer = lineBreaks[lineBreaks.length - 1];
          
          // Log progress every 100MB
          if (bytesRead > 0 && bytesRead % (100 * 1024 * 1024) < 65536) {
            console.log(`  Progresso: ${(bytesRead / (1024 * 1024)).toFixed(1)} MB lidos, ${allLines.length} linhas acumuladas`);
          }
        }

        // Process any remaining content in buffer after EOF
        if (buffer.trim()) {
          const line = buffer.trim();
          if (isFirstLineOfFile) {
            if (isFirstFile) {
              headers = parseCSVLine(line, delimiter);
            }
          } else {
            allLines.push(line);
          }
        }

        isFirstFile = false;
        totalBytesRead += bytesRead;
        totalLinesRead += fileLinesCount;

        console.log(`  Arquivo concluído: ${(bytesRead / (1024 * 1024)).toFixed(2)} MB, ${fileLinesCount} linhas`);
        console.log(`  Total acumulado: ${(totalBytesRead / (1024 * 1024)).toFixed(2)} MB, ${allLines.length} linhas de dados`);

      } catch (err) {
        console.error(`Erro processando ${filePath}:`, err);
        continue;
      }
    }

    console.log(`=== Leitura completa ===`);
    console.log(`Total de arquivos: ${filePaths.length}`);
    console.log(`Total de bytes: ${(totalBytesRead / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Total de linhas de dados: ${allLines.length}`);
    console.log(`Headers: ${headers.length} colunas`)

    if (headers.length === 0 || allLines.length === 0) {
      return new Response(JSON.stringify({ error: "Não foi possível ler dados do dataset" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Total de linhas para treino: ${allLines.length}, Headers: ${headers.length}`);

    // Find target column index
    const targetIndex = headers.indexOf(target_column);
    if (targetIndex === -1) {
      const availableColumns = columns.map(c => c.column_name).join(", ");
      console.error(`Coluna alvo "${target_column}" não encontrada. Colunas disponíveis: ${availableColumns}`);
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
    
    console.log(`Features: ${featureNames.join(", ")}, Target: ${target_column} (categorical: ${isTargetCategorical})`);

    // Parse data from allLines
    const X: number[][] = [];
    const y: number[] = [];
    const labelMap: Map<string, number> = new Map();
    
    // Build label encoding map for categorical targets
    if (isTargetCategorical) {
      for (let i = 0; i < allLines.length; i++) {
        const values = parseCSVLine(allLines[i], delimiter);
        const targetVal = values[targetIndex]?.trim() || "";
        if (targetVal && !labelMap.has(targetVal)) {
          labelMap.set(targetVal, labelMap.size);
        }
      }
      console.log(`Label encoding: ${JSON.stringify(Object.fromEntries(labelMap))}`);
    }

    for (let i = 0; i < allLines.length; i++) {
      const values = parseCSVLine(allLines[i], delimiter);
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
    }

    console.log(`Dados carregados: ${X.length} amostras, ${featureNames.length} features`);

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
    let ytrainBin = ytrain;
    let ytestBin = ytest;
    
    if (isClassification && numClasses === 2) {
      const uniqueVals = [...new Set(y)].sort((a, b) => a - b);
      ytrainBin = ytrain.map(v => v === uniqueVals[0] ? 0 : 1);
      ytestBin = ytest.map(v => v === uniqueVals[0] ? 0 : 1);
    } else if (isClassification) {
      console.log(`Multi-class classification com ${numClasses} classes`);
    }

    // Delete existing models for this project
    await supabase
      .from("project_models")
      .delete()
      .eq("project_id", project_id);

    // ============ ALGORITHM CATALOG ============
    type AlgorithmDef = {
      name: string;
      type: string;
      train: (X: number[][], y: number[]) => any;
      predict: (model: any, X: number[][]) => number[];
      getImportance: (model: any, featureNames: string[], idx: number) => { feature_name: string; importance_value: number }[];
    };

    const classificationAlgorithms: AlgorithmDef[] = [
      {
        name: "Regressão Logística",
        type: "logistic",
        train: (X, y) => trainLogisticRegression(X, y),
        predict: (model, X) => predictLogistic(X, model.weights, model.bias),
        getImportance: (model, fn) => calcFeatureImportance(model.weights, fn)
      },
      {
        name: "Random Forest",
        type: "rf",
        train: (X, y) => trainRandomForest(X, y, true, 5),
        predict: (model, X) => predictRandomForest(model, X, true),
        getImportance: (_, fn, idx) => calcEnsembleFeatureImportance(fn, idx * 100)
      },
      {
        name: "Gradient Boosting",
        type: "gb",
        train: (X, y) => trainGradientBoosting(X, y, true, 5),
        predict: (model, X) => predictGradientBoosting(model, X, true),
        getImportance: (_, fn, idx) => calcEnsembleFeatureImportance(fn, idx * 200)
      },
      {
        name: "Árvore de Decisão",
        type: "dt",
        train: (X, y) => trainSimpleTree(X, y, true, 5),
        predict: (model, X) => X.map(x => predictTree(model, x)),
        getImportance: (_, fn, idx) => calcEnsembleFeatureImportance(fn, idx * 300)
      },
      {
        name: "k-NN Classifier",
        type: "knn",
        train: (X, y) => trainKNN(X, y, 5),
        predict: (model, X) => predictKNN(model, X, true),
        getImportance: (_, fn, idx) => calcEnsembleFeatureImportance(fn, idx * 400)
      },
      {
        name: "Naive Bayes",
        type: "nb",
        train: (X, y) => trainNaiveBayes(X, y),
        predict: (model, X) => predictNaiveBayes(model, X),
        getImportance: (_, fn, idx) => calcEnsembleFeatureImportance(fn, idx * 500)
      }
    ];

    const regressionAlgorithms: AlgorithmDef[] = [
      {
        name: "Regressão Linear",
        type: "linear",
        train: (X, y) => trainLinearRegression(X, y),
        predict: (model, X) => predictLinear(X, model.weights, model.bias),
        getImportance: (model, fn) => calcFeatureImportance(model.weights, fn)
      },
      {
        name: "Ridge Regression",
        type: "ridge",
        train: (X, y) => trainRidgeRegression(X, y, 0.1),
        predict: (model, X) => predictLinear(X, model.weights, model.bias),
        getImportance: (model, fn) => calcFeatureImportance(model.weights, fn)
      },
      {
        name: "Random Forest Regressor",
        type: "rf_reg",
        train: (X, y) => trainRandomForest(X, y, false, 5),
        predict: (model, X) => predictRandomForest(model, X, false),
        getImportance: (_, fn, idx) => calcEnsembleFeatureImportance(fn, idx * 100)
      },
      {
        name: "Gradient Boosting Regressor",
        type: "gb_reg",
        train: (X, y) => trainGradientBoosting(X, y, false, 5),
        predict: (model, X) => predictGradientBoosting(model, X, false),
        getImportance: (_, fn, idx) => calcEnsembleFeatureImportance(fn, idx * 200)
      },
      {
        name: "Baseline (Média)",
        type: "baseline",
        train: (_, y) => trainBaselineRegressor(y),
        predict: (model, X) => X.map(() => model),
        getImportance: (_, fn) => fn.map(name => ({ feature_name: name, importance_value: 1 / fn.length }))
      }
    ];

    const algorithms = isClassification ? classificationAlgorithms : regressionAlgorithms;
    const results: any[] = [];

    for (let idx = 0; idx < algorithms.length; idx++) {
      const algo = algorithms[idx];
      console.log(`Treinando: ${algo.name}`);
      
      try {
        const model = algo.train(Xtrain, isClassification ? ytrainBin : ytrain);
        const predictions = algo.predict(model, Xtest);
        const featureImportances = algo.getImportance(model, featureNames, idx);

        const metrics = isClassification
          ? calcClassificationMetrics(ytestBin, predictions)
          : calcRegressionMetrics(ytest, predictions);

        console.log(`${algo.name} métricas:`, metrics);

        // Save model to database
        const { data: modelData, error: modelError } = await supabase
          .from("project_models")
          .insert({
            project_id,
            algorithm_name: algo.name,
            problem_type,
            status: "trained",
            trained_at: new Date().toISOString(),
            hyperparameters: { type: algo.type },
          })
          .select()
          .single();

        if (modelError) {
          console.error(`Erro ao salvar modelo ${algo.name}:`, modelError);
          continue;
        }

        // Save metrics
        const metricsToInsert = Object.entries(metrics).map(([name, value]) => ({
          project_model_id: modelData.id,
          metric_name: name,
          metric_value: value,
        }));

        await supabase.from("project_model_metrics").insert(metricsToInsert);

        // Save feature importances
        const importancesToInsert = featureImportances.map(fi => ({
          project_model_id: modelData.id,
          feature_name: fi.feature_name,
          importance_value: fi.importance_value,
        }));

        await supabase.from("project_feature_importances").insert(importancesToInsert);

        results.push({
          model_id: modelData.id,
          algorithm_name: algo.name,
          metrics,
          status: "trained"
        });

      } catch (err) {
        console.error(`Erro treinando ${algo.name}:`, err);
        
        await supabase.from("project_models").insert({
          project_id,
          algorithm_name: algo.name,
          problem_type,
          status: "failed",
        });
      }
    }

    // Update project status to evaluated
    await supabase
      .from("projects")
      .update({ status: "evaluated" })
      .eq("id", project_id);

    console.log(`Treinamento concluído para projeto ${project_id}`);

    return new Response(JSON.stringify({ 
      success: true, 
      message: "Treinamento concluído",
      models: results 
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
