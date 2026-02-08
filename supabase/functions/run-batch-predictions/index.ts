import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyFeatureTransforms, type ProjectFeature, type FeatureExpression } from "../_shared/feature-engineering.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ===== Optimized constants =====
const CHUNK_SIZE = 5000;
const MAX_BYTES_PER_FILE = 50 * 1024 * 1024;
const DB_INSERT_BATCH = 3000; // ← was 500, reduced DB calls by 6x

// ===== Running statistics (avoids accumulating all values + sorting) =====
class RunningStats {
  count = 0;
  private _mean = 0;
  private _m2 = 0;
  min = Infinity;
  max = -Infinity;
  private _sorted: number[] = [];
  private _reservoirSize = 10000;

  add(x: number) {
    this.count++;
    const delta = x - this._mean;
    this._mean += delta / this.count;
    this._m2 += delta * (x - this._mean);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
    // Reservoir sampling for quantiles
    if (this._sorted.length < this._reservoirSize) {
      this._sorted.push(x);
    } else {
      const j = Math.floor(Math.random() * this.count);
      if (j < this._reservoirSize) this._sorted[j] = x;
    }
  }

  get mean() { return this._mean; }
  get std() { return this.count > 1 ? Math.sqrt(this._m2 / this.count) : 0; }

  quantiles() {
    if (this._sorted.length === 0) return {};
    this._sorted.sort((a, b) => a - b);
    const q = (p: number) => this._sorted[Math.floor(this._sorted.length * p)] ?? 0;
    return { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };
  }

  get median() {
    if (this._sorted.length === 0) return 0;
    this._sorted.sort((a, b) => a - b);
    return this._sorted[Math.floor(this._sorted.length / 2)];
  }
}

function predictTree(tree: any, x: number[]): number {
  if (!tree || tree.isLeaf) return tree?.value || 0;
  return x[tree.feature] <= tree.threshold
    ? predictTree(tree.left, x)
    : predictTree(tree.right, x);
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

    console.log(`[Scoring] Starting optimized scoring for project: ${project_id}`);

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

    // Get columns + features in parallel
    const [columnsRes, featuresRes] = await Promise.all([
      supabase.from("project_columns").select("*").eq("project_id", project_id).order("column_index"),
      supabase.from("project_features").select("*").eq("project_id", project_id).eq("enabled", true),
    ]);

    const columns = columnsRes.data;
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

    const enabledFeatures: ProjectFeature[] = (featuresRes.data || []).map(f => ({
      id: f.id, project_id: f.project_id, name: f.name, label: f.label,
      description: f.description || undefined, enabled: f.enabled,
      expression: f.expression as FeatureExpression
    }));

    const hasEngineeredFeatures = enabledFeatures.length > 0;
    const engineeredFeatureNames = enabledFeatures.map(f => f.name);
    const allFeatureNames = [...baseFeatureNames, ...engineeredFeatureNames];

    // Pre-compute normalization lookup (avoid repeated indexOf per row)
    const means = new Float64Array(allFeatureNames.length);
    const stds = new Float64Array(allFeatureNames.length);
    for (let i = 0; i < allFeatureNames.length; i++) {
      const idx = savedFeatureNames.indexOf(allFeatureNames[i]);
      means[i] = idx !== -1 ? savedNormalization.means[idx] : 0;
      stds[i] = idx !== -1 ? (savedNormalization.stds[idx] || 1) : 1;
    }

    // Pre-extract model params for hot loop
    const isGBModel = modelArtifacts.type === "gradient_boosting" && modelArtifacts.trees;
    const gbBase = modelArtifacts.base || 0;
    const gbLR = modelArtifacts.lr || 0.1;
    const gbTrees = modelArtifacts.trees || [];
    const lrWeights: number[] = modelArtifacts.weights || [];
    const lrBias: number = modelArtifacts.bias || 0;

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

    // ===== SCORING STATE =====
    let totalRowsScored = 0;
    let totalRowsInvalid = 0;
    let headers: string[] = [];
    let isFirstFile = true;
    let featureIndices: number[] = [];
    let entityIdIndex = -1;
    let segmentationCandidates: Record<string, number> = {};

    const stats = new RunningStats();

    // ===== Segmentation mapping helper =====
    const segmentKeyMap: Record<string, string> = {};
    const initSegmentKeyMap = () => {
      for (const [name] of Object.entries(segmentationCandidates)) {
        if (name.includes('segment')) segmentKeyMap[name] = 'segment';
        else if (name.includes('region') || name.includes('regiao')) segmentKeyMap[name] = 'region';
        else if (name.includes('state') || name.includes('estado')) segmentKeyMap[name] = 'state';
        else if (name.includes('city') || name.includes('cidade')) segmentKeyMap[name] = 'city';
        else if (name.includes('channel') || name.includes('canal')) segmentKeyMap[name] = 'channel';
        else if (name.includes('campaign') || name.includes('campanha')) segmentKeyMap[name] = 'campaign';
        else if (name.includes('cohort') || name.includes('coorte')) segmentKeyMap[name] = 'cohort';
        else if (name.includes('age') || name.includes('etaria')) segmentKeyMap[name] = 'age_group';
        else if (name.includes('category') || name.includes('categoria')) segmentKeyMap[name] = 'product_category';
      }
    };

    // ===== Optimized processChunk =====
    const processChunk = async (rows: string[]) => {
      const predictions: any[] = [];
      const baseLen = baseFeatureNames.length;
      const totalFeatures = allFeatureNames.length;

      for (let i = 0; i < rows.length; i++) {
        const values = parseCSVLine(rows[i], delimiter);
        const entityId = entityIdIndex !== -1 ? values[entityIdIndex] : `entity_${totalRowsScored + i + 1}`;

        // Extract and normalize base features (inline, no intermediate arrays)
        const featureValues = new Array(totalFeatures);
        let hasNaN = false;

        for (let j = 0; j < baseLen; j++) {
          const raw = values[featureIndices[j]];
          const val = raw ? +raw.replace(",", ".") : NaN;
          if (isNaN(val)) { hasNaN = true; break; }
          featureValues[j] = (val - means[j]) / stds[j];
        }

        if (hasNaN) { totalRowsInvalid++; continue; }

        // Engineered features (only if they exist)
        if (hasEngineeredFeatures) {
          const rawRecord: Record<string, string | number | null> = {};
          for (let h = 0; h < headers.length; h++) {
            rawRecord[headers[h]] = values[h] || null;
          }
          const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
          for (let j = 0; j < engineeredFeatureNames.length; j++) {
            const val = engineeredValues[engineeredFeatureNames[j]];
            const normIdx = baseLen + j;
            if (typeof val !== "number" || isNaN(val)) {
              featureValues[normIdx] = 0;
            } else {
              featureValues[normIdx] = (val - means[normIdx]) / stds[normIdx];
            }
          }
        }

        // === MODEL INFERENCE (inlined for speed) ===
        let predictedValue: number | null = null;
        let probability: number | null = null;
        let predictedClass: string | null = null;

        if (isGBModel) {
          let pred = gbBase;
          for (let t = 0; t < gbTrees.length; t++) {
            pred += gbLR * predictTree(gbTrees[t], featureValues);
          }
          if (isClassification) {
            probability = sigmoid(pred);
            predictedClass = probability >= 0.5 ? "1" : "0";
          } else {
            predictedValue = pred;
          }
        } else {
          let z = lrBias;
          const wLen = Math.min(lrWeights.length, totalFeatures);
          for (let j = 0; j < wLen; j++) {
            z += lrWeights[j] * featureValues[j];
          }
          if (isClassification) {
            probability = sigmoid(z);
            predictedClass = probability >= 0.5 ? "1" : "0";
          } else {
            predictedValue = z;
          }
        }

        // Running stats
        const statVal = isClassification ? probability! : predictedValue!;
        stats.add(statVal);

        // Segmentation values (lightweight)
        const segmentValues: Record<string, string | null> = {
          segment: null, region: null, state: null, city: null,
          channel: null, campaign: null, cohort: null, age_group: null, product_category: null
        };
        for (const [name, idx] of Object.entries(segmentationCandidates)) {
          const key = segmentKeyMap[name];
          if (key) segmentValues[key] = values[idx] || null;
        }

        predictions.push({
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
        });
      }

      // Insert in large DB batches (3000 rows each → far fewer round-trips)
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

    // ===== STREAM AND PROCESS FILES =====
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
            featureIndices = baseFeatureNames.map(name => headers.indexOf(name));
            for (const candidate of entityIdCandidates) {
              const idx = headers.indexOf(candidate);
              if (idx !== -1) { entityIdIndex = idx; break; }
            }
            segmentColNames.forEach(name => {
              const idx = headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
              if (idx !== -1) segmentationCandidates[name] = idx;
            });
            initSegmentKeyMap();
            isFirstLineOfFile = false;
            isFirstFile = false;
            continue;
          }

          if (isFirstLineOfFile) {
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

      if (buffer.trim()) {
        chunkRows.push(buffer.trim());
      }
      if (chunkRows.length > 0) {
        await processChunk(chunkRows);
        chunkRows = [];
      }

      console.log(`[Scoring] File done. Total scored: ${totalRowsScored}`);
    }

    // ===== SCORE REPORT (using running stats, no sort of full array) =====
    const elapsedMs = Date.now() - startTime;
    const coveragePct = totalExpectedRows > 0
      ? Math.min(100, (totalRowsScored / totalExpectedRows) * 100)
      : (totalRowsScored > 0 ? 100 : 0);

    const quantiles = stats.quantiles();

    const scoreReport = {
      total_rows_scored: totalRowsScored,
      total_rows_expected: totalExpectedRows,
      coverage_pct: +coveragePct.toFixed(2),
      invalid_rows: totalRowsInvalid,
      latency_ms: elapsedMs,
      prediction_stats: {
        min: +(stats.min === Infinity ? 0 : stats.min).toFixed(4),
        max: +(stats.max === -Infinity ? 0 : stats.max).toFixed(4),
        mean: +stats.mean.toFixed(4),
        median: +stats.median.toFixed(4),
        std: +stats.std.toFixed(4),
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

    // Persist score_report in AI context (fire-and-forget style)
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
