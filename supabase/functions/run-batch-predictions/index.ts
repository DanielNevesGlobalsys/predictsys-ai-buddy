import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyFeatureTransforms, type ProjectFeature, type FeatureExpression } from "../_shared/feature-engineering.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ===== Multi-pass constants =====
const MAX_ROWS_PER_PASS = 40000;
const CHUNK_SIZE = 3000;
const DB_INSERT_BATCH = 500;

// ===== Running statistics (Welford) =====
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
      count: this.count, mean: this._mean, m2: this._m2,
      min: this.min, max: this.max, reservoir: this._reservoir,
    };
  }
}

function predictTree(tree: any, x: number[]): number {
  if (!tree || tree.isLeaf) return tree?.value || 0;
  return x[tree.feature] <= tree.threshold
    ? predictTree(tree.left, x) : predictTree(tree.right, x);
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

// ===== Gate helpers =====
interface ScoringGate {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
}

function blockResponse(
  gates: ScoringGate[],
  errorCode: string,
  errorFriendly: string,
  ctas: { label: string; go_to_step?: number; action?: string }[],
  projectId?: string,
  modelId?: string,
) {
  return new Response(JSON.stringify({
    status: "BLOCKED",
    project_id: projectId,
    model_id: modelId,
    batch_id: null,
    error_code: errorCode,
    error_friendly: errorFriendly,
    gates,
    ctas,
  }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const {
      project_id,
      horizon_days = 30,
      pass_offset = 0,
      batch_id: existingBatchId,
      running_stats: prevStats,
      total_scored_prev = 0,
      total_invalid_prev = 0,
      job_id: existingJobId,
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

    // ===== LOAD SSOT + SELECTION + MODEL IN PARALLEL =====
    const [projectRes, dsStateRes, selectionRes] = await Promise.all([
      supabase.from("projects").select("*").eq("id", project_id).single(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
    ]);

    const project = projectRes.data as any;
    const dsState = dsStateRes.data as any;
    const selection = selectionRes.data as any;

    if (!project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gates: ScoringGate[] = [];
    const currentSelVersion = selection?.selection_version || 0;

    // ===== GATE 1: production_model_id exists in SSOT =====
    const productionModelId = dsState?.production_model_id;
    if (!productionModelId) {
      gates.push({ gate: "production_model", status: "BLOCK", message: "Nenhum modelo em produção no SSOT." });
      return blockResponse(gates, "NO_PRODUCTION_MODEL", "Nenhum modelo em produção. Faça o deploy de um modelo primeiro.", [
        { label: "Ir para Deploy", go_to_step: 5 }
      ], project_id);
    }
    gates.push({ gate: "production_model", status: "PASS", message: `production_model_id=${productionModelId}` });

    // Load model
    const { data: productionModel } = await supabase
      .from("project_models").select("*")
      .eq("id", productionModelId).eq("project_id", project_id).single();

    if (!productionModel) {
      gates.push({ gate: "model_exists", status: "BLOCK", message: "Modelo de produção não encontrado na tabela." });
      return blockResponse(gates, "MODEL_NOT_FOUND", "Modelo de produção não encontrado. Faça deploy novamente.", [
        { label: "Ir para Deploy", go_to_step: 5 }
      ], project_id);
    }

    const hyperparams = (productionModel.hyperparameters || {}) as any;

    // ===== GATE 2: model_quality_flag and dashboard_allowed =====
    const mqf = hyperparams.model_quality_flag || productionModel.status;
    const dashAllowed = hyperparams.dashboard_allowed !== false;
    const canPromote = hyperparams.can_promote_to_production !== false;

    if (mqf !== "ok" && mqf !== "trained") {
      gates.push({ gate: "model_quality", status: "BLOCK", message: `quality=${mqf}` });
      return blockResponse(gates, "MODEL_QUALITY_FAILED", `Modelo reprovado (quality=${mqf}). Retreine com dados melhores.`, [
        { label: "Voltar ao Treino", go_to_step: 4 }
      ], project_id, productionModelId);
    }
    if (!dashAllowed) {
      gates.push({ gate: "model_quality", status: "BLOCK", message: "dashboard_allowed=false" });
      return blockResponse(gates, "DASHBOARD_NOT_ALLOWED", "Modelo sem permissão para dashboard. Retreine.", [
        { label: "Voltar ao Treino", go_to_step: 4 }
      ], project_id, productionModelId);
    }
    gates.push({ gate: "model_quality", status: "PASS", message: `quality=${mqf}, dashboard=${dashAllowed}` });

    // ===== GATE 3: selection_version match =====
    const modelSelVersion = hyperparams.selection_version || 0;
    if (currentSelVersion > 0 && modelSelVersion > 0 && modelSelVersion !== currentSelVersion) {
      gates.push({ gate: "version_match", status: "BLOCK", message: `model=v${modelSelVersion}, selection=v${currentSelVersion}` });
      return blockResponse(gates, "VERSION_MISMATCH", `Modelo desatualizado (v${modelSelVersion} vs v${currentSelVersion}). Re-deploy necessário.`, [
        { label: "Retreinar e Re-deploy", go_to_step: 4 }
      ], project_id, productionModelId);
    }
    gates.push({ gate: "version_match", status: "PASS", message: `v${modelSelVersion}` });

    // ===== GATE 4: builder dataset current =====
    const { data: builderDataset } = await supabase
      .from("project_modeling_datasets").select("*")
      .eq("project_id", project_id).eq("is_current", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (builderDataset) {
      const builderSelV = (builderDataset as any).selection_version_used || 0;
      if (currentSelVersion > 0 && builderSelV < currentSelVersion) {
        gates.push({ gate: "builder_current", status: "BLOCK", message: `builder v${builderSelV} < selection v${currentSelVersion}` });
        return blockResponse(gates, "BUILDER_OUTDATED", "Dataset modelável desatualizado. Rode Builder + Redeploy.", [
          { label: "Regerar Builder", go_to_step: 3 }
        ], project_id, productionModelId);
      }
      gates.push({ gate: "builder_current", status: "PASS", message: `builder_id=${builderDataset.id}` });
    } else {
      gates.push({ gate: "builder_current", status: "WARN", message: "Sem builder dataset (legacy path)." });
    }

    // ===== GATE 5: dataset ativo no SSOT =====
    const ssotRowCount = dsState?.row_count || 0;
    const ssotColCount = dsState?.col_count || 0;
    if (ssotRowCount === 0 || ssotColCount === 0) {
      gates.push({ gate: "dataset_active", status: "BLOCK", message: `SSOT row_count=${ssotRowCount}, col_count=${ssotColCount}` });
      return blockResponse(gates, "NO_ACTIVE_DATASET", "Nenhum dataset ativo. Faça upload ou conecte um dataset.", [
        { label: "Ir para Upload", go_to_step: 1 }
      ], project_id, productionModelId);
    }
    gates.push({ gate: "dataset_active", status: "PASS", message: `rows=${ssotRowCount}, cols=${ssotColCount}` });

    console.log(`[Scoring] All gates PASS. Proceeding with scoring.`);

    // ===== MODEL ARTIFACTS =====
    const modelArtifacts = hyperparams.model_artifacts;
    const savedNormalization = hyperparams.normalization;
    const savedFeatureNames = hyperparams.feature_names as string[] | undefined;

    if (!modelArtifacts || (!modelArtifacts.weights && !modelArtifacts.trees)) {
      return blockResponse(gates, "NO_MODEL_ARTIFACTS", "Modelo sem artefatos de treinamento. Re-treine.", [
        { label: "Voltar ao Treino", go_to_step: 4 }
      ], project_id, productionModelId);
    }
    if (!savedNormalization?.means || !savedNormalization?.stds || !savedFeatureNames?.length) {
      return blockResponse(gates, "NO_NORMALIZATION", "Modelo sem normalização. Re-treine.", [
        { label: "Voltar ao Treino", go_to_step: 4 }
      ], project_id, productionModelId);
    }

    // ===== LOAD COLUMNS + FEATURES =====
    const [columnsRes, featuresRes] = await Promise.all([
      supabase.from("project_columns").select("*").eq("project_id", project_id).order("column_index"),
      supabase.from("project_features").select("*").eq("project_id", project_id).eq("enabled", true),
    ]);

    const columns = columnsRes.data;
    if (!columns) {
      return new Response(JSON.stringify({ error: "Erro ao carregar colunas" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const targetCol = selection?.target_column || project.target_column;
    const numericTypes = ["numerico", "numérico", "numeric"];
    const numericFeatures = columns.filter(c =>
      numericTypes.includes(c.inferred_type.toLowerCase()) && c.column_name !== targetCol
    );
    const baseFeatureNames = numericFeatures.map(c => c.column_name);

    if (baseFeatureNames.length === 0) {
      return blockResponse(gates, "NO_FEATURES", "Nenhuma feature numérica encontrada.", [
        { label: "Revisar Features", go_to_step: 3 }
      ], project_id, productionModelId);
    }

    const enabledFeatures: ProjectFeature[] = (featuresRes.data || []).map(f => ({
      id: f.id, project_id: f.project_id, name: f.name, label: f.label,
      description: f.description || undefined, enabled: f.enabled,
      expression: f.expression as FeatureExpression
    }));

    const engineeredFeatureNames = enabledFeatures.map(f => f.name);
    const allFeatureNames = [...baseFeatureNames, ...engineeredFeatureNames];
    const hasEngineeredFeatures = enabledFeatures.length > 0;

    // Pre-compute normalization lookup
    const means = allFeatureNames.map(name => {
      const idx = savedFeatureNames.indexOf(name);
      return idx !== -1 ? savedNormalization.means[idx] : 0;
    });
    const stdsArr = allFeatureNames.map(name => {
      const idx = savedFeatureNames.indexOf(name);
      return idx !== -1 ? (savedNormalization.stds[idx] || 1) : 1;
    });

    // Track missing features
    let missingFeatureCount = 0;
    for (const name of savedFeatureNames) {
      if (!allFeatureNames.includes(name)) missingFeatureCount++;
    }
    const missingFeaturePct = savedFeatureNames.length > 0 ? (missingFeatureCount / savedFeatureNames.length) * 100 : 0;

    // Model params
    const isGBModel = modelArtifacts.type === "gradient_boosting" && modelArtifacts.trees;
    const gbBase = modelArtifacts.base || 0;
    const gbLR = modelArtifacts.lr || 0.1;
    const gbTrees = modelArtifacts.trees || [];
    const lrWeights: number[] = modelArtifacts.weights || [];
    const lrBias: number = modelArtifacts.bias || 0;
    const baseLen = baseFeatureNames.length;
    const totalFeatures = allFeatureNames.length;

    // ===== DATASET FILES =====
    const { data: activeDataset } = await supabase
      .from("project_datasets").select("*")
      .eq("project_id", project_id).eq("is_active", true).maybeSingle();

    let delimiter = ",";
    let filePaths: string[] = [];
    let totalExpectedRows = dsState?.row_count || 0;

    if (activeDataset) {
      const sourceMetadata = (activeDataset.source_metadata || {}) as Record<string, any>;
      delimiter = sourceMetadata.delimiter || ",";
      const isBatch = activeDataset.source_type === "batch_import";
      if (isBatch && sourceMetadata.file_paths) {
        filePaths = sourceMetadata.file_paths as string[];
      } else {
        filePaths = [activeDataset.storage_path];
      }
      if (!totalExpectedRows) totalExpectedRows = activeDataset.total_rows || 0;
    } else if (project.dataset_filename) {
      filePaths = [project.dataset_filename];
      if (!totalExpectedRows) totalExpectedRows = project.total_rows || project.dataset_rows || 0;
    } else {
      return blockResponse(gates, "NO_DATASET", "Nenhum dataset encontrado.", [
        { label: "Ir para Upload", go_to_step: 1 }
      ], project_id, productionModelId);
    }

    // Expand folder paths + sort for determinism
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
    filePaths = expandedFilePaths.sort();

    if (filePaths.length === 0) {
      return blockResponse(gates, "NO_FILES", "Nenhum arquivo no dataset.", [
        { label: "Ir para Upload", go_to_step: 1 }
      ], project_id, productionModelId);
    }

    // ===== SEGMENT + ENTITY MAPPING =====
    const segmentColNames = ['segment', 'segmento', 'region', 'regiao', 'estado', 'state', 'city', 'cidade', 'channel', 'canal', 'campaign', 'campanha', 'cohort', 'coorte', 'age_group', 'faixa_etaria', 'product_category', 'categoria_produto'];
    const entityIdCandidates = ['id', 'entity_id', 'cliente_id', 'customer_id', 'user_id', 'id_cliente', 'customer', 'cliente', 'cnpj', 'cpf'];

    const isClassification = (selection?.problem_type || project.problem_type) === "classification";
    const batchId = existingBatchId || `batch_${Date.now()}_${project_id.substring(0, 8)}`;
    const predictionDate = new Date().toISOString();

    // ===== CREATE / UPDATE SCORING JOB =====
    let jobId = existingJobId;
    if (isFirstPass) {
      // Mark previous jobs as not latest
      await supabase.from("project_scoring_jobs")
        .update({ is_latest_job: false })
        .eq("project_id", project_id);

      const { data: newJob } = await supabase.from("project_scoring_jobs").insert({
        project_id,
        model_id: productionModelId,
        selection_version: currentSelVersion,
        dataset_id: builderDataset?.id || null,
        source_type: dsState?.source_type || "upload",
        status: "running",
        batch_id: batchId,
        is_latest_job: true,
        total_rows_estimated: totalExpectedRows,
        diagnostics: { gates: gates.map(g => ({ gate: g.gate, status: g.status })) },
      }).select("id").single();
      jobId = newJob?.id;

      // Idempotency: insert new predictions with is_latest=false, promote at end
      // Clean old non-latest predictions to prevent bloat
      await supabase.from("predictions").delete()
        .eq("project_id", project_id).eq("is_latest", false);
    }

    // ===== SCORING STATE =====
    let totalRowsScored = 0;
    let totalRowsInvalid = 0;
    let globalRowIndex = 0;
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

        if (!entityId || entityId.trim() === "") {
          totalRowsInvalid++;
          continue;
        }

        const featureValues = new Array(totalFeatures);

        for (let j = 0; j < baseLen; j++) {
          const raw = values[featureIndices[j]];
          const val = raw ? +raw.replace(",", ".") : NaN;
          featureValues[j] = isNaN(val) ? (0 - means[j]) / stdsArr[j] : (val - means[j]) / stdsArr[j];
        }

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
              ? (val - means[normIdx]) / stdsArr[normIdx] : 0;
          }
        }

        // MODEL INFERENCE
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

        const scoreVal = isClassification ? probability! : predictedValue!;
        if (scoreVal === null || scoreVal === undefined || !isFinite(scoreVal)) {
          totalRowsInvalid++;
          continue;
        }

        stats.add(scoreVal);

        // Segmentation
        const segmentValues: Record<string, string | null> = {
          segment: null, region: null, state: null, city: null,
          channel: null, campaign: null, cohort: null, age_group: null, product_category: null
        };
        for (const [name, idx] of Object.entries(segmentationCandidates)) {
          const key = segmentKeyMap[name];
          if (key) segmentValues[key] = values[idx] || null;
        }

        // Insert with is_latest=false; promote at end for idempotency
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
          batch_id: batchId, is_latest: false,
          ...segmentValues,
          metadata: { model_id: productionModelId, model_name: productionModel.algorithm_name, selection_version: currentSelVersion }
        });
      }

      // DB inserts in batches
      for (let i = 0; i < predictions.length; i += DB_INSERT_BATCH) {
        const batch = predictions.slice(i, i + DB_INSERT_BATCH);
        const { error: insertError } = await supabase.from("predictions").insert(batch);
        if (insertError) {
          console.error("[Scoring] Insert error:", insertError);
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
        console.error(`[Scoring] Signed URL error for ${filePath}:`, signedUrlError);
        continue;
      }

      const response = await fetch(signedUrlData.signedUrl);
      if (!response.ok || !response.body) {
        console.error(`[Scoring] HTTP error for ${filePath}: ${response.status}`);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let chunkRows: string[] = [];
      let isFirstLineOfFile = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lineBreaks = buffer.split(/\r?\n/);

        for (let i = 0; i < lineBreaks.length - 1; i++) {
          const line = lineBreaks[i].trim();
          if (!line) continue;

          if (isFirstFile && isFirstLineOfFile) {
            headers = parseCSVLine(line, delimiter);
            const headersLower = headers.map(h => h.toLowerCase().trim());

            // Case-insensitive feature matching
            featureIndices = baseFeatureNames.map(name => {
              const exact = headers.indexOf(name);
              if (exact !== -1) return exact;
              return headersLower.indexOf(name.toLowerCase());
            });

            // Case-insensitive entity_id detection
            let detectedEntityIdCol: string | null = null;
            for (const candidate of entityIdCandidates) {
              const idx = headersLower.indexOf(candidate.toLowerCase());
              if (idx !== -1) {
                entityIdIndex = idx;
                detectedEntityIdCol = headers[idx];
                break;
              }
            }

            // === GATE: Validate feature coverage ===
            const baseMissing = baseFeatureNames.filter(f => headersLower.indexOf(f.toLowerCase()) === -1);
            const modelMissing = savedFeatureNames!.filter(f => !allFeatureNames.includes(f));
            const modelMissingPct = savedFeatureNames!.length > 0 ? (modelMissing.length / savedFeatureNames!.length) * 100 : 0;

            if (modelMissingPct > 20 || baseMissing.length > 0) {
              const missingList = [...new Set([...baseMissing, ...modelMissing])].slice(0, 10);
              gates.push({
                gate: "feature_validation",
                status: "BLOCK",
                message: `Features ausentes: ${missingList.join(", ")}${missingList.length < baseMissing.length + modelMissing.length ? "..." : ""} (base_missing=${baseMissing.length}, model_missing_pct=${modelMissingPct.toFixed(1)}%)`
              });
              return blockResponse(
                gates,
                "MISSING_FEATURES",
                "Features do modelo não existem no dataset atual. Regerar Builder e Re-deploy.",
                [
                  { label: "Regerar Builder", go_to_step: 3 },
                  { label: "Retreinar", go_to_step: 4 },
                ],
                project_id,
                productionModelId,
              );
            }
            gates.push({
              gate: "feature_validation",
              status: modelMissing.length > 0 ? "WARN" : "PASS",
              message: `base_missing=${baseMissing.length}, model_missing=${modelMissing.length} (${modelMissingPct.toFixed(1)}%), entity_id_col=${detectedEntityIdCol || "auto-generated"}`
            });

            // Segmentation: already case-insensitive
            segmentColNames.forEach(name => {
              const idx = headersLower.indexOf(name.toLowerCase());
              if (idx !== -1) segmentationCandidates[name] = idx;
            });
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

            console.log(`[Scoring] Headers parsed: ${headers.length} cols, entity_id=${detectedEntityIdCol || "auto"}, base_missing=${baseMissing.length}, model_missing=${modelMissing.length}`);
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

          if (globalRowIndex < pass_offset) {
            globalRowIndex++;
            continue;
          }

          if (totalRowsScored + totalRowsInvalid >= MAX_ROWS_PER_PASS) {
            reachedLimit = true;
            break;
          }

          globalRowIndex++;
          chunkRows.push(line);

          if (chunkRows.length >= CHUNK_SIZE) {
            await processChunk(chunkRows);
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
    }

    // ===== POST-PASS DIAGNOSTICS =====
    const cumulativeScored = total_scored_prev + totalRowsScored;
    const cumulativeInvalid = total_invalid_prev + totalRowsInvalid;
    const nextOffset = pass_offset + totalRowsScored + totalRowsInvalid;
    const hasMore = reachedLimit;
    const elapsedMs = Date.now() - startTime;

    const { count: countBatch } = await supabase
      .from("predictions").select("id", { count: "exact", head: true })
      .eq("project_id", project_id).eq("batch_id", batchId);

    const passDiag = {
      project_id, model_id: productionModelId, batch_id: batchId,
      selection_version: currentSelVersion,
      offset: pass_offset, limit: MAX_ROWS_PER_PASS,
      continue: hasMore, next_offset: hasMore ? nextOffset : null,
      rows_fetched: totalRowsScored + totalRowsInvalid,
      predictions_generated: totalRowsScored,
      db_count_batch: countBatch ?? -1,
      elapsed_ms: elapsedMs,
      missing_feature_pct: +missingFeaturePct.toFixed(2),
    };

    console.log(`[Scoring][DIAG] ${JSON.stringify(passDiag)}`);

    // Update job
    if (jobId) {
      await supabase.from("project_scoring_jobs").update({
        offset: nextOffset,
        rows_fetched_total: cumulativeScored + cumulativeInvalid,
        rows_scored_total: cumulativeScored,
        rows_inserted_total: countBatch ?? cumulativeScored,
        status: hasMore ? "running" : "finalizing",
        diagnostics: passDiag,
      }).eq("id", jobId);
    }

    if (hasMore) {
      return new Response(JSON.stringify({
        status: "CONTINUE",
        project_id, model_id: productionModelId, batch_id: batchId,
        continue: true, next_offset: nextOffset,
        offset: pass_offset, limit: MAX_ROWS_PER_PASS,
        rows_fetched: totalRowsScored + totalRowsInvalid,
        predictions_generated: totalRowsScored, predictions_inserted: totalRowsScored,
        totals: { rows_scored_total: cumulativeScored, rows_inserted_total: countBatch ?? cumulativeScored },
        diagnostics: passDiag,
        score_report_partial: { predictions_count: cumulativeScored, invalid_rows: cumulativeInvalid, missing_feature_pct: +missingFeaturePct.toFixed(2) },
        running_stats: stats.toJSON(),
        total_scored_prev: cumulativeScored,
        total_invalid_prev: cumulativeInvalid,
        job_id: jobId,
        pass_rows_scored: totalRowsScored,
        message: `Processadas ${cumulativeScored} linhas... continuando`,
        error_code: null, error_friendly: null, ctas: [],
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== FINAL PASS: PROMOTE BATCH =====
    console.log(`[Scoring] Final pass complete. Promoting batch ${batchId} to is_latest=true`);

    // Mark old predictions as not latest
    await supabase.from("predictions").update({ is_latest: false })
      .eq("project_id", project_id).neq("batch_id", batchId);

    // Promote new batch
    await supabase.from("predictions").update({ is_latest: true })
      .eq("project_id", project_id).eq("batch_id", batchId);

    // Verify
    const { count: finalLatestCount } = await supabase
      .from("predictions").select("id", { count: "exact", head: true })
      .eq("project_id", project_id).eq("is_latest", true);

    // ===== SANITY CHECK + SCORING_OUTPUT_SANITY =====
    const isSanityFail = stats.count > 10 && stats.std < 0.0001;
    const warnings: string[] = [];
    if (cumulativeScored === 0) warnings.push("SCORING_OUTPUT_BLOCK: nenhuma previsão gerada.");
    if (isSanityFail) warnings.push("SANITY_FAIL: previsões degeneradas (std≈0). Revise target/features.");
    if (missingFeaturePct > 20) warnings.push(`MISSING_FEATURES: ${missingFeaturePct.toFixed(0)}% das features do modelo estão ausentes.`);
    if (coveragePct < 30 && cumulativeScored > 0) warnings.push(`LOW_COVERAGE: cobertura de apenas ${coveragePct.toFixed(1)}%.`);

    // ===== COVERAGE =====
    const coveragePct = totalExpectedRows > 0
      ? Math.min(100, (cumulativeScored / totalExpectedRows) * 100) : (cumulativeScored > 0 ? 100 : 0);

    // ===== PERSIST SCORE REPORT =====
    const quantiles = stats.quantiles();
    const statsSum = {
      min: +(stats.min === Infinity ? 0 : stats.min).toFixed(4),
      max: +(stats.max === -Infinity ? 0 : stats.max).toFixed(4),
      mean: +stats.mean.toFixed(4), median: +stats.median.toFixed(4),
      std: +stats.std.toFixed(4), quantiles,
    };

    await supabase.from("project_score_reports").insert({
      project_id, model_id: productionModelId, batch_id: batchId,
      selection_version: currentSelVersion,
      dataset_id: builderDataset?.id || null,
      coverage_pct: +coveragePct.toFixed(2),
      predictions_count: cumulativeScored,
      invalid_rows: cumulativeInvalid,
      missing_feature_pct: +missingFeaturePct.toFixed(2),
      stats_summary: statsSum,
      warnings,
      gates_snapshot: gates,
    });

    // Update job to done
    if (jobId) {
      await supabase.from("project_scoring_jobs").update({
        status: isSanityFail ? "sanity_fail" : "done",
        finished_at: new Date().toISOString(),
        rows_scored_total: cumulativeScored,
        rows_inserted_total: finalLatestCount ?? cumulativeScored,
        diagnostics: { ...passDiag, final_latest_count: finalLatestCount, sanity_fail: isSanityFail, warnings },
      }).eq("id", jobId);
    }

    // Persist in AI context
    try {
      const { data: existingCtx } = await supabase.from("project_ai_context")
        .select("id, context").eq("project_id", project_id).maybeSingle();
      const contextPayload = {
        score_report: { coverage_pct: +coveragePct.toFixed(2), predictions_count: cumulativeScored, invalid_rows: cumulativeInvalid, stats: statsSum, warnings },
        last_batch_id: batchId, last_batch_at: new Date().toISOString(),
        model_used: productionModel.algorithm_name,
      };
      if (existingCtx) {
        const cur = existingCtx.context as Record<string, any> || {};
        await supabase.from("project_ai_context").update({
          context: { ...cur, predictions: contextPayload },
          status: "predictions_ready", last_updated_at: new Date().toISOString(),
        }).eq("id", existingCtx.id);
      } else {
        await supabase.from("project_ai_context").insert({
          organization_id: project.organization_id, project_id,
          context: { predictions: contextPayload }, status: "predictions_ready",
        });
      }
    } catch (_) {}

    // Audit log
    try {
      await supabase.from("audit_logs").insert({
        organization_id: project.organization_id, project_id,
        action: "scoring_job_completed", resource_type: "scoring",
        resource_name: batchId,
        metadata: { model_id: productionModelId, selection_version: currentSelVersion, predictions_count: cumulativeScored, coverage_pct: +coveragePct.toFixed(2), warnings },
      });
    } catch (_) {}

    console.log(`[Scoring] DONE: ${cumulativeScored} predictions, coverage=${coveragePct.toFixed(1)}%, latest_count=${finalLatestCount}`);

    return new Response(JSON.stringify({
      status: isSanityFail ? "ERROR" : "DONE",
      project_id, model_id: productionModelId, batch_id: batchId,
      continue: false, next_offset: null,
      offset: pass_offset, limit: MAX_ROWS_PER_PASS,
      rows_fetched: totalRowsScored + totalRowsInvalid,
      predictions_generated: cumulativeScored, predictions_inserted: finalLatestCount ?? cumulativeScored,
      totals: { rows_scored_total: cumulativeScored, rows_inserted_total: finalLatestCount ?? cumulativeScored },
      diagnostics: { ...passDiag, final_latest_count: finalLatestCount, coverage_pct: +coveragePct.toFixed(2) },
      score_report_partial: { predictions_count: cumulativeScored, invalid_rows: cumulativeInvalid, missing_feature_pct: +missingFeaturePct.toFixed(2) },
      error_code: isSanityFail ? "SANITY_FAIL" : null,
      error_friendly: isSanityFail ? "Previsões degeneradas (constantes). Revise target e features." : null,
      ctas: isSanityFail ? [{ label: "Revisar Target/Features", go_to_step: 3 }] : [],
      // Legacy compat
      success: !isSanityFail,
      rows_scored: cumulativeScored,
      predictions_count: cumulativeScored,
      score_report: { total_rows_scored: cumulativeScored, total_rows_expected: totalExpectedRows, coverage_pct: +coveragePct.toFixed(2), invalid_rows: cumulativeInvalid, prediction_stats: statsSum, model_id: productionModelId, model_name: productionModel.algorithm_name, batch_id: batchId },
      model_name: productionModel.algorithm_name,
      job_id: jobId,
      warnings,
      message: isSanityFail
        ? `⚠️ Sanity check falhou: ${cumulativeScored} previsões constantes.`
        : `✅ ${cumulativeScored} previsões geradas (cobertura: ${coveragePct.toFixed(1)}%)`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    const errorStack = error instanceof Error ? error.stack || error.message : "Erro desconhecido";
    console.error(`[Scoring][DIAG] error_stack: ${errorStack}`);
    return new Response(JSON.stringify({
      status: "ERROR",
      error: error instanceof Error ? error.message : "Erro desconhecido",
      error_code: "INTERNAL_ERROR",
      error_friendly: "Erro interno no scoring. Tente novamente.",
      error_stack: errorStack,
      ctas: [{ label: "Tentar Novamente", action: "retry" }],
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
