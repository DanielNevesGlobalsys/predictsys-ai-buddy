import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyFeatureTransforms, type ProjectFeature, type FeatureExpression } from "../_shared/feature-engineering.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ===== Multi-pass constants =====
const MAX_ROWS_PER_PASS = 40000; // rows per invocation (safe for CPU limit)
const CHUNK_SIZE = 3000;         // rows per processing chunk
const DB_INSERT_BATCH = 500;     // rows per DB insert (smaller = less CPU for serialization)

// ===== Running statistics =====
class RunningStats {
  count = 0;
  private _mean = 0;
  private _m2 = 0;
  min = Infinity;
  max = -Infinity;
  private _reservoir: number[] = [];
  private _reservoirSize = 5000;

  add(x: number) {
    this.count++;
    const delta = x - this._mean;
    this._mean += delta / this.count;
    this._m2 += delta * (x - this._mean);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
    if (this._reservoir.length < this._reservoirSize) {
      this._reservoir.push(x);
    } else {
      const j = Math.floor(Math.random() * this.count);
      if (j < this._reservoirSize) this._reservoir[j] = x;
    }
  }

  get mean() { return this._mean; }
  get std() { return this.count > 1 ? Math.sqrt(this._m2 / this.count) : 0; }

  quantiles() {
    if (this._reservoir.length === 0) return {};
    this._reservoir.sort((a, b) => a - b);
    const q = (p: number) => this._reservoir[Math.floor(this._reservoir.length * p)] ?? 0;
    return { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };
  }

  get median() {
    if (this._reservoir.length === 0) return 0;
    this._reservoir.sort((a, b) => a - b);
    return this._reservoir[Math.floor(this._reservoir.length / 2)];
  }

  // Merge stats from a previous pass
  static fromJSON(json: any): RunningStats {
    const s = new RunningStats();
    if (!json) return s;
    s.count = json.count || 0;
    s._mean = json.mean || 0;
    s._m2 = json.m2 || 0;
    s.min = json.min ?? Infinity;
    s.max = json.max ?? -Infinity;
    s._reservoir = json.reservoir || [];
    return s;
  }

  toJSON() {
    return {
      count: this.count,
      mean: this._mean,
      m2: this._m2,
      min: this.min,
      max: this.max,
      reservoir: this._reservoir,
    };
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
    const {
      project_id,
      horizon_days = 30,
      // Multi-pass params
      pass_offset = 0,        // row offset to start from
      batch_id: existingBatchId,  // reuse batch_id across passes
      running_stats: prevStats,   // accumulated stats from previous passes
      total_scored_prev = 0,      // total scored in previous passes
      total_invalid_prev = 0,     // total invalid in previous passes
    } = await req.json();

    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id é obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isFirstPass = pass_offset === 0;
    console.log(`[Scoring] Pass starting at offset ${pass_offset} for project: ${project_id}`);

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

    // Pre-compute normalization lookup
    const means = allFeatureNames.map(name => {
      const idx = savedFeatureNames.indexOf(name);
      return idx !== -1 ? savedNormalization.means[idx] : 0;
    });
    const stdsArr = allFeatureNames.map(name => {
      const idx = savedFeatureNames.indexOf(name);
      return idx !== -1 ? (savedNormalization.stds[idx] || 1) : 1;
    });

    // Pre-extract model params
    const isGBModel = modelArtifacts.type === "gradient_boosting" && modelArtifacts.trees;
    const gbBase = modelArtifacts.base || 0;
    const gbLR = modelArtifacts.lr || 0.1;
    const gbTrees = modelArtifacts.trees || [];
    const lrWeights: number[] = modelArtifacts.weights || [];
    const lrBias: number = modelArtifacts.bias || 0;
    const baseLen = baseFeatureNames.length;
    const totalFeatures = allFeatureNames.length;

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

    // Expand folder paths and sort for deterministic ordering across passes
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
    // DETERMINISTIC: sort file paths alphabetically to guarantee same order across passes
    filePaths = expandedFilePaths.sort();

    if (filePaths.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum arquivo encontrado no dataset" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Segmentation field names
    const segmentColNames = ['segment', 'segmento', 'segmento_cliente', 'region', 'regiao', 'estado', 'state', 'city', 'cidade', 'channel', 'canal', 'campaign', 'campanha', 'cohort', 'coorte', 'age_group', 'faixa_etaria', 'product_category', 'categoria_produto'];
    const entityIdCandidates = ['id', 'entity_id', 'cliente_id', 'customer_id', 'user_id', 'ID', 'Id'];

    const isClassification = project.problem_type === "classification";
    const batchId = existingBatchId || `batch_${Date.now()}`;
    const predictionDate = new Date().toISOString();
    const startTime = Date.now();

    // On first pass: clean up old predictions to avoid data bloat, then mark remaining as not-latest
    if (isFirstPass) {
      // Delete old non-latest predictions (accumulated from previous runs) to prevent bloat
      const { error: deleteError } = await supabase
        .from("predictions")
        .delete()
        .eq("project_id", project_id)
        .eq("is_latest", false);
      
      if (deleteError) {
        console.warn("[Scoring] Non-fatal: failed to clean old predictions:", deleteError.message);
      }
      
      // Mark current latest predictions as not-latest (they'll be replaced by new ones)
      await supabase.from("predictions").update({ is_latest: false }).eq("project_id", project_id);
    }

    // ===== SCORING STATE =====
    let totalRowsScored = 0;
    let totalRowsInvalid = 0;
    let globalRowIndex = 0; // counts ALL rows across the file (to implement offset)
    let headers: string[] = [];
    let isFirstFile = true;
    let featureIndices: number[] = [];
    let entityIdIndex = -1;
    let segmentationCandidates: Record<string, number> = {};
    let segmentKeyMap: Record<string, string> = {};
    let reachedLimit = false;

    const stats = RunningStats.fromJSON(prevStats);

    const processChunk = async (rows: string[]) => {
      const predictions: any[] = [];

      for (let i = 0; i < rows.length; i++) {
        const values = parseCSVLine(rows[i], delimiter);
        const entityId = entityIdIndex !== -1 ? values[entityIdIndex] : `entity_${pass_offset + totalRowsScored + i + 1}`;

        // Extract and normalize base features
        const featureValues = new Array(totalFeatures);
        let hasNaN = false;

        for (let j = 0; j < baseLen; j++) {
          const raw = values[featureIndices[j]];
          const val = raw ? +raw.replace(",", ".") : NaN;
          if (isNaN(val)) { hasNaN = true; break; }
          featureValues[j] = (val - means[j]) / stdsArr[j];
        }

        if (hasNaN) { totalRowsInvalid++; continue; }

        // Engineered features
        if (hasEngineeredFeatures) {
          const rawRecord: Record<string, string | number | null> = {};
          for (let h = 0; h < headers.length; h++) {
            rawRecord[headers[h]] = values[h] || null;
          }
          const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
          for (let j = 0; j < engineeredFeatureNames.length; j++) {
            const val = engineeredValues[engineeredFeatureNames[j]];
            const normIdx = baseLen + j;
            featureValues[normIdx] = (typeof val === "number" && !isNaN(val))
              ? (val - means[normIdx]) / stdsArr[normIdx]
              : 0;
          }
        }

        // === MODEL INFERENCE ===
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

        stats.add(isClassification ? probability! : predictedValue!);

        // Segmentation
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

      // DB inserts
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
      if (reachedLimit) break;

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

      while (bytesRead < 50 * 1024 * 1024) {
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
            // Build segment key map
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

          // Skip rows until we reach the offset
          if (globalRowIndex < pass_offset) {
            globalRowIndex++;
            continue;
          }

          // Check if we've reached the limit for this pass
          if (totalRowsScored + totalRowsInvalid >= MAX_ROWS_PER_PASS) {
            reachedLimit = true;
            break;
          }

          globalRowIndex++;
          chunkRows.push(line);

          if (chunkRows.length >= CHUNK_SIZE) {
            await processChunk(chunkRows);
            console.log(`[Scoring] Pass offset=${pass_offset}: scored ${totalRowsScored} rows so far...`);
            chunkRows = [];
          }
        }

        if (reachedLimit) break;
        buffer = lineBreaks[lineBreaks.length - 1];
      }

      try { await reader.cancel(); } catch (_) {}

      if (!reachedLimit) {
        if (buffer.trim()) chunkRows.push(buffer.trim());
        if (chunkRows.length > 0) {
          await processChunk(chunkRows);
          chunkRows = [];
        }
      }

      console.log(`[Scoring] File done (pass). Scored this pass: ${totalRowsScored}`);
    }

    // ===== DETERMINE IF MORE PASSES NEEDED =====
    const cumulativeScored = total_scored_prev + totalRowsScored;
    const cumulativeInvalid = total_invalid_prev + totalRowsInvalid;
    const nextOffset = pass_offset + totalRowsScored + totalRowsInvalid;
    const hasMore = reachedLimit;
    const elapsedMs = Date.now() - startTime;

    console.log(`[Scoring] Pass complete: scored=${totalRowsScored}, cumulative=${cumulativeScored}, hasMore=${hasMore}`);

    if (hasMore) {
      // Return continuation - client should call again
      return new Response(JSON.stringify({
        success: true,
        continue: true,
        next_offset: nextOffset,
        batch_id: batchId,
        running_stats: stats.toJSON(),
        total_scored_prev: cumulativeScored,
        total_invalid_prev: cumulativeInvalid,
        pass_rows_scored: totalRowsScored,
        message: `Processadas ${cumulativeScored} linhas até agora... continuando`,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ===== FINAL PASS: Generate score report =====
    const coveragePct = totalExpectedRows > 0
      ? Math.min(100, (cumulativeScored / totalExpectedRows) * 100)
      : (cumulativeScored > 0 ? 100 : 0);

    const quantiles = stats.quantiles();

    const scoreReport = {
      total_rows_scored: cumulativeScored,
      total_rows_expected: totalExpectedRows,
      coverage_pct: +coveragePct.toFixed(2),
      invalid_rows: cumulativeInvalid,
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

    console.log(`[Scoring] === FINAL SCORE REPORT ===`);
    console.log(`[Scoring] Rows scored: ${cumulativeScored} / ${totalExpectedRows} (${coveragePct.toFixed(1)}%)`);
    console.log(`[Scoring] Invalid rows: ${cumulativeInvalid}`);

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
    } catch (ctxErr) {
      console.error("[Scoring] AI context append error (non-fatal):", ctxErr);
    }

    return new Response(JSON.stringify({
      success: true,
      continue: false,
      message: `${cumulativeScored} previsões geradas (cobertura: ${coveragePct.toFixed(1)}%)`,
      batch_id: batchId,
      predictions_count: cumulativeScored,
      rows_scored: cumulativeScored,
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
