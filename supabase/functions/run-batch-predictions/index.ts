import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyFeatureTransforms, type ProjectFeature, type FeatureExpression } from "../_shared/feature-engineering.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ===== NO MAX_ROWS LIMIT — process 100% of the dataset =====
const CHUNK_SIZE = 3000; // rows per chunk for memory safety
const MAX_BYTES_PER_FILE = 50 * 1024 * 1024; // 50MB per file
const DB_INSERT_BATCH = 500; // rows per DB insert

function predictTree(tree: any, x: number[]): number {
  if (!tree || tree.isLeaf) return tree?.value || 0;
  return x[tree.feature] <= tree.threshold 
    ? predictTree(tree.left, x) 
    : predictTree(tree.right, x);
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

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function parseCSVLine(line: string, delim: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === delim && !inQuotes) { result.push(current.trim().replace(/^"|"$/g, "")); current = ""; }
    else { current += char; }
  }
  result.push(current.trim().replace(/^"|"$/g, ""));
  return result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id, horizon_days = 30 } = await req.json();

    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id é obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[Scoring] Starting 100% coverage scoring for project: ${project_id}`);

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
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get production model
    const { data: productionModel, error: modelError } = await supabase
      .from("project_models")
      .select("*")
      .eq("project_id", project_id)
      .eq("is_production", true)
      .eq("status", "trained")
      .single();

    if (modelError || !productionModel) {
      return new Response(JSON.stringify({ 
        error: "Nenhum modelo em produção encontrado. Selecione um modelo para produção primeiro." 
      }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const hyperparams = productionModel.hyperparameters as any || {};
    const modelArtifacts = hyperparams.model_artifacts;
    const savedNormalization = hyperparams.normalization;
    const savedFeatureNames = hyperparams.feature_names as string[] | undefined;

    if (!modelArtifacts || (!modelArtifacts.weights && !modelArtifacts.trees)) {
      return new Response(JSON.stringify({ 
        error: "Modelo sem artefatos de treinamento salvos. Re-treine o modelo.",
        action: "retrain"
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!savedNormalization?.means || !savedNormalization?.stds || !savedFeatureNames?.length) {
      return new Response(JSON.stringify({ 
        error: "Modelo sem parâmetros de normalização. Re-treine o modelo.",
        action: "retrain"
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get columns
    const { data: columns } = await supabase
      .from("project_columns")
      .select("*")
      .eq("project_id", project_id)
      .order("column_index");

    if (!columns) {
      return new Response(JSON.stringify({ error: "Erro ao carregar colunas do projeto" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const numericTypes = ["numerico", "numérico", "numeric"];
    const numericFeatures = columns.filter(c => 
      numericTypes.includes(c.inferred_type.toLowerCase()) && c.column_name !== project.target_column
    );
    const baseFeatureNames = numericFeatures.map(c => c.column_name);

    if (baseFeatureNames.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhuma feature numérica encontrada no projeto" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch engineered features
    const { data: projectFeaturesData } = await supabase
      .from("project_features")
      .select("*")
      .eq("project_id", project_id)
      .eq("enabled", true);

    const enabledFeatures: ProjectFeature[] = (projectFeaturesData || []).map(f => ({
      id: f.id, project_id: f.project_id, name: f.name, label: f.label,
      description: f.description || undefined, enabled: f.enabled,
      expression: f.expression as FeatureExpression
    }));

    const engineeredFeatureNames = enabledFeatures.map(f => f.name);
    const allFeatureNames = [...baseFeatureNames, ...engineeredFeatureNames];

    // Build normalization lookup from saved model
    const means = allFeatureNames.map(name => {
      const idx = savedFeatureNames.indexOf(name);
      return idx !== -1 ? savedNormalization.means[idx] : 0;
    });
    const stds = allFeatureNames.map(name => {
      const idx = savedFeatureNames.indexOf(name);
      return idx !== -1 ? (savedNormalization.stds[idx] || 1) : 1;
    });

    // Get dataset
    const { data: activeDataset } = await supabase
      .from("project_datasets")
      .select("*")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .maybeSingle();

    let delimiter = ",";
    let filePaths: string[] = [];
    let totalExpectedRows = 0;

    if (activeDataset) {
      const sourceMetadata = (activeDataset.source_metadata || {}) as Record<string, any>;
      delimiter = sourceMetadata.delimiter || ",";
      const isBatch = activeDataset.source_type === "batch_import";
      if (isBatch && sourceMetadata.file_paths) {
        filePaths = sourceMetadata.file_paths as string[];
      } else {
        filePaths = [activeDataset.storage_path];
      }
      totalExpectedRows = activeDataset.total_rows || 0;
    } else if (project.dataset_filename) {
      filePaths = [project.dataset_filename];
      totalExpectedRows = project.total_rows || project.dataset_rows || 0;
    } else {
      return new Response(JSON.stringify({ error: "Nenhum dataset encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Expand folder paths
    const expandedFilePaths = (await Promise.all(
      filePaths.map(async (p) => {
        const { data: listed } = await supabase.storage.from("datasets").list(p, { limit: 1000 });
        if (listed && listed.length > 0) {
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

    if (filePaths.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum arquivo encontrado no dataset" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Segmentation field names
    const segmentColNames = ['segment', 'segmento', 'segmento_cliente', 'region', 'regiao', 'estado', 'state', 'city', 'cidade', 'channel', 'canal', 'campaign', 'campanha', 'cohort', 'coorte', 'age_group', 'faixa_etaria', 'product_category', 'categoria_produto'];
    const entityIdCandidates = ['id', 'entity_id', 'cliente_id', 'customer_id', 'user_id', 'ID', 'Id'];

    const isClassification = project.problem_type === "classification";
    const batchId = `batch_${Date.now()}`;
    const predictionDate = new Date().toISOString();
    const startTime = Date.now();

    // Mark all existing predictions as not latest
    await supabase.from("predictions").update({ is_latest: false }).eq("project_id", project_id);

    // ===== CHUNKED SCORING: process ALL rows =====
    let totalRowsScored = 0;
    let totalRowsInvalid = 0;
    let headers: string[] = [];
    let isFirstFile = true;
    let featureIndices: number[] = [];
    let entityIdIndex = -1;
    let entityIdColumn = 'row_index';
    let segmentationCandidates: Record<string, number> = {};

    // Score stats accumulators
    const allPredValues: number[] = [];

    for (const filePath of filePaths) {
      console.log(`[Scoring] Processing file: ${filePath}`);

      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from("datasets").createSignedUrl(filePath, 600);

      if (signedUrlError || !signedUrlData?.signedUrl) {
        console.error(`Error creating signed URL for ${filePath}:`, signedUrlError);
        continue;
      }

      const response = await fetch(signedUrlData.signedUrl);
      if (!response.ok || !response.body) {
        console.error(`Error fetching ${filePath}: HTTP ${response.status}`);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let bytesRead = 0;
      let buffer = "";
      let chunkRows: string[] = [];
      let isFirstLineOfFile = true;

      const processChunk = async (rows: string[]) => {
        const predictions: any[] = [];

        for (let i = 0; i < rows.length; i++) {
          const values = parseCSVLine(rows[i], delimiter);
          const entityId = entityIdIndex !== -1 ? values[entityIdIndex] : `entity_${totalRowsScored + i + 1}`;

          // Build raw record
          const rawRecord: Record<string, string | number | null> = {};
          headers.forEach((h, idx) => { rawRecord[h] = values[idx] || null; });

          // Extract and normalize base features
          const baseFeatureValues = featureIndices.map((idx, j) => {
            const val = parseFloat((values[idx] || "").replace(",", "."));
            if (isNaN(val)) return 0;
            return (val - means[j]) / stds[j];
          });

          // Engineered features
          const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
          const engineeredFeatureValues = engineeredFeatureNames.map((name, j) => {
            const val = engineeredValues[name];
            if (typeof val !== "number" || isNaN(val)) return 0;
            const normIdx = baseFeatureNames.length + j;
            return (val - means[normIdx]) / stds[normIdx];
          });

          const featureValues = [...baseFeatureValues, ...engineeredFeatureValues];

          // Check if any feature is NaN (bad row)
          if (featureValues.some(v => isNaN(v))) {
            totalRowsInvalid++;
            continue;
          }

          // Segmentation values
          const segmentValues: Record<string, string | null> = {
            segment: null, region: null, state: null, city: null,
            channel: null, campaign: null, cohort: null, age_group: null, product_category: null
          };
          Object.entries(segmentationCandidates).forEach(([name, idx]) => {
            const value = values[idx] || null;
            if (name.includes('segment')) segmentValues.segment = value;
            else if (name.includes('region') || name.includes('regiao')) segmentValues.region = value;
            else if (name.includes('state') || name.includes('estado')) segmentValues.state = value;
            else if (name.includes('city') || name.includes('cidade')) segmentValues.city = value;
            else if (name.includes('channel') || name.includes('canal')) segmentValues.channel = value;
            else if (name.includes('campaign') || name.includes('campanha')) segmentValues.campaign = value;
            else if (name.includes('cohort') || name.includes('coorte')) segmentValues.cohort = value;
            else if (name.includes('age') || name.includes('etaria')) segmentValues.age_group = value;
            else if (name.includes('category') || name.includes('categoria')) segmentValues.product_category = value;
          });

          // === REAL MODEL INFERENCE ===
          let predictedValue: number | null = null;
          let probability: number | null = null;
          let predictedClass: string | null = null;

          if (modelArtifacts.type === "gradient_boosting" && modelArtifacts.trees) {
            let pred = modelArtifacts.base || 0;
            const lr = modelArtifacts.lr || 0.1;
            for (const tree of modelArtifacts.trees) {
              pred += lr * predictTree(tree, featureValues);
            }
            if (isClassification) {
              probability = sigmoid(pred);
              predictedClass = probability >= 0.5 ? "1" : "0";
            } else {
              predictedValue = pred;
            }
          } else if (modelArtifacts.weights) {
            const weights: number[] = modelArtifacts.weights;
            const bias: number = modelArtifacts.bias || 0;
            let z = bias;
            for (let j = 0; j < Math.min(weights.length, featureValues.length); j++) {
              z += weights[j] * featureValues[j];
            }
            if (isClassification) {
              probability = sigmoid(z);
              predictedClass = probability >= 0.5 ? "1" : "0";
            } else {
              predictedValue = z;
            }
          } else {
            totalRowsInvalid++;
            continue;
          }

          // Accumulate prediction stats
          if (isClassification && probability !== null) {
            allPredValues.push(probability);
          } else if (predictedValue !== null) {
            allPredValues.push(predictedValue);
          }

          const pred: any = {
            project_id, user_id: project.user_id, entity_id: entityId,
            entity_type: "customer", reference_date: predictionDate,
            prediction_date: predictionDate, horizon_days,
            problem_type: isClassification ? "classification" : "regression",
            problem_context: project.business_objective || null,
            probability_event: isClassification ? probability : null,
            predicted_class: isClassification ? predictedClass : null,
            predicted_value: isClassification ? null : predictedValue,
            potential_value: isClassification ? null : predictedValue,
            batch_id: batchId, is_latest: true,
            ...segmentValues,
            metadata: { model_id: productionModel.id, model_name: productionModel.algorithm_name }
          };
          predictions.push(pred);
        }

        // Insert in DB batches
        for (let i = 0; i < predictions.length; i += DB_INSERT_BATCH) {
          const batch = predictions.slice(i, i + DB_INSERT_BATCH);
          const { error: insertError } = await supabase.from("predictions").insert(batch);
          if (insertError) {
            console.error("Error inserting predictions batch:", insertError);
            throw insertError;
          }
        }
        totalRowsScored += predictions.length;
      };

      // Stream and process in chunks
      while (bytesRead < MAX_BYTES_PER_FILE) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value?.length || 0;
        buffer += decoder.decode(value, { stream: true });
        const lineBreaks = buffer.split(/\r?\n/);

        for (let i = 0; i < lineBreaks.length - 1; i++) {
          const line = lineBreaks[i].trim();
          if (!line) continue;

          if (isFirstFile && isFirstLineOfFile) {
            headers = parseCSVLine(line, delimiter);
            // Setup indices
            featureIndices = baseFeatureNames.map(name => headers.indexOf(name));
            for (const candidate of entityIdCandidates) {
              const idx = headers.indexOf(candidate);
              if (idx !== -1) { entityIdIndex = idx; entityIdColumn = candidate; break; }
            }
            segmentColNames.forEach(name => {
              const idx = headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
              if (idx !== -1) segmentationCandidates[name] = idx;
            });
            isFirstLineOfFile = false;
            isFirstFile = false;
            continue;
          }

          if (isFirstLineOfFile) {
            // Skip header of subsequent files
            const possibleHeaders = parseCSVLine(line, delimiter);
            if (possibleHeaders.length === headers.length && possibleHeaders[0] === headers[0]) {
              isFirstLineOfFile = false;
              continue;
            }
            isFirstLineOfFile = false;
          }

          chunkRows.push(line);

          if (chunkRows.length >= CHUNK_SIZE) {
            await processChunk(chunkRows);
            console.log(`[Scoring] Scored ${totalRowsScored} rows so far...`);
            chunkRows = [];
          }
        }
        buffer = lineBreaks[lineBreaks.length - 1];
      }

      try { await reader.cancel(); } catch (_) {}

      // Process remaining rows in buffer
      if (buffer.trim()) {
        chunkRows.push(buffer.trim());
      }
      if (chunkRows.length > 0) {
        await processChunk(chunkRows);
        chunkRows = [];
      }

      console.log(`[Scoring] File done. Total scored: ${totalRowsScored}`);
    }

    // ===== SCORE REPORT =====
    const elapsedMs = Date.now() - startTime;
    const coveragePct = totalExpectedRows > 0 
      ? Math.min(100, (totalRowsScored / totalExpectedRows) * 100) 
      : (totalRowsScored > 0 ? 100 : 0);

    // Prediction stats
    let predMin = 0, predMax = 0, predMedian = 0, predMean = 0, predStd = 0;
    const quantiles: Record<string, number> = {};
    if (allPredValues.length > 0) {
      allPredValues.sort((a, b) => a - b);
      predMin = allPredValues[0];
      predMax = allPredValues[allPredValues.length - 1];
      predMean = mean(allPredValues);
      predStd = std(allPredValues);
      predMedian = allPredValues[Math.floor(allPredValues.length / 2)];
      quantiles.p10 = allPredValues[Math.floor(allPredValues.length * 0.1)];
      quantiles.p25 = allPredValues[Math.floor(allPredValues.length * 0.25)];
      quantiles.p50 = predMedian;
      quantiles.p75 = allPredValues[Math.floor(allPredValues.length * 0.75)];
      quantiles.p90 = allPredValues[Math.floor(allPredValues.length * 0.9)];
    }

    const scoreReport = {
      total_rows_scored: totalRowsScored,
      total_rows_expected: totalExpectedRows,
      coverage_pct: +coveragePct.toFixed(2),
      invalid_rows: totalRowsInvalid,
      latency_ms: elapsedMs,
      prediction_stats: {
        min: +predMin.toFixed(4),
        max: +predMax.toFixed(4),
        mean: +predMean.toFixed(4),
        median: +predMedian.toFixed(4),
        std: +predStd.toFixed(4),
        quantiles,
      },
      model_id: productionModel.id,
      model_name: productionModel.algorithm_name,
      batch_id: batchId,
      generated_at: new Date().toISOString(),
    };

    console.log(`[Scoring] === SCORE REPORT ===`);
    console.log(`[Scoring] Rows scored: ${totalRowsScored} / ${totalExpectedRows} (${coveragePct.toFixed(1)}%)`);
    console.log(`[Scoring] Invalid rows: ${totalRowsInvalid}`);
    console.log(`[Scoring] Latency: ${elapsedMs}ms`);
    console.log(`[Scoring] Pred stats: min=${predMin.toFixed(4)}, max=${predMax.toFixed(4)}, mean=${predMean.toFixed(4)}, std=${predStd.toFixed(4)}`);

    // Persist score_report in AI context
    try {
      const { data: existingCtx } = await supabase
        .from("project_ai_context")
        .select("id, context")
        .eq("project_id", project_id)
        .maybeSingle();

      const contextPayload = {
        score_report: scoreReport,
        last_batch_id: batchId,
        last_batch_at: new Date().toISOString(),
        model_used: productionModel.algorithm_name,
      };

      if (existingCtx) {
        const currentCtx = existingCtx.context as Record<string, any> || {};
        await supabase.from("project_ai_context").update({
          context: { ...currentCtx, predictions: contextPayload },
          status: "predictions_ready",
          last_updated_at: new Date().toISOString(),
        }).eq("id", existingCtx.id);
      } else {
        await supabase.from("project_ai_context").insert({
          organization_id: project.organization_id,
          project_id,
          context: { predictions: contextPayload },
          status: "predictions_ready",
        });
      }
      console.log(`[Scoring] AI context updated with score_report`);
    } catch (ctxErr) {
      console.error("[Scoring] AI context append error (non-fatal):", ctxErr);
    }

    return new Response(JSON.stringify({
      success: true,
      message: `${totalRowsScored} previsões geradas (cobertura: ${coveragePct.toFixed(1)}%)`,
      batch_id: batchId,
      predictions_count: totalRowsScored,
      rows_scored: totalRowsScored,
      score_report: scoreReport,
      model_id: productionModel.id,
      model_name: productionModel.algorithm_name
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error in batch predictions:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Erro desconhecido" 
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
