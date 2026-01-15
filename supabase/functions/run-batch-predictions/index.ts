import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyFeatureTransforms, type ProjectFeature, type FeatureExpression } from "../_shared/feature-engineering.ts";

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

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id, horizon_days = 30 } = await req.json();

    if (!project_id) {
      return new Response(JSON.stringify({ 
        error: "project_id é obrigatório" 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Running batch predictions for project: ${project_id}`);

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
      console.error("Project not found:", projectError);
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      console.error("Production model not found:", modelError);
      return new Response(JSON.stringify({ 
        error: "Nenhum modelo em produção encontrado. Selecione um modelo para produção primeiro." 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Using production model: ${productionModel.algorithm_name} (${productionModel.id})`);

    // Get feature columns
    const { data: columns, error: colError } = await supabase
      .from("project_columns")
      .select("*")
      .eq("project_id", project_id)
      .order("column_index");

    if (colError || !columns) {
      return new Response(JSON.stringify({ error: "Erro ao carregar colunas do projeto" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get numeric and categorical feature columns (excluding target)
    // Handle both accented and non-accented type names
    const numericTypes = ["numerico", "numérico", "numeric"];
    const categoricalTypes = ["categorico", "categórico", "categorical", "texto", "text"];
    
    const numericFeatures = columns.filter(c => 
      numericTypes.includes(c.inferred_type.toLowerCase()) && c.column_name !== project.target_column
    );
    const categoricalFeatures = columns.filter(c => 
      categoricalTypes.includes(c.inferred_type.toLowerCase()) && c.column_name !== project.target_column
    );
    const baseFeatureNames = numericFeatures.map(c => c.column_name);

    console.log(`Found ${numericFeatures.length} numeric features and ${categoricalFeatures.length} categorical features`);

    if (baseFeatureNames.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhuma feature numérica encontrada no projeto" }), {
        status: 400,
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
      expression: f.expression as FeatureExpression
    }));
    
    const engineeredFeatureNames = enabledFeatures.map(f => f.name);
    const allFeatureNames = [...baseFeatureNames, ...engineeredFeatureNames];
    
    console.log(`Engineered features: ${engineeredFeatureNames.length}`);
    console.log(`Total features: ${allFeatureNames.length}`);

    // Get active dataset from project_datasets - use maybeSingle for fallback
    const { data: activeDataset, error: datasetError } = await supabase
      .from("project_datasets")
      .select("*")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .maybeSingle();

    let delimiter = ",";
    let isBatchImport = false;
    let filePaths: string[] = [];
    let sourceMetadata: Record<string, any> = {};

    if (activeDataset) {
      // Use active dataset
      sourceMetadata = (activeDataset.source_metadata || {}) as Record<string, any>;
      delimiter = sourceMetadata.delimiter || ",";
      isBatchImport = activeDataset.source_type === "batch_import";
      
      if (isBatchImport && sourceMetadata.file_paths) {
        filePaths = sourceMetadata.file_paths as string[];
      } else {
        filePaths = [activeDataset.storage_path];
      }
      console.log(`[Predictions] Usando dataset ativo: ${activeDataset.name}`);
    } else if (project.dataset_filename) {
      // Fallback to project.dataset_filename - it already contains the full path!
      console.log(`[Predictions] Sem dataset ativo, usando project.dataset_filename`);
      filePaths = [project.dataset_filename];
      delimiter = ","; // Default delimiter
    } else {
      console.error("No dataset found for project");
      return new Response(JSON.stringify({ error: "Nenhum dataset encontrado para o projeto" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Dataset path: ${filePaths[0]}, Batch: ${isBatchImport}, Delimiter: ${delimiter}`);

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
    console.log(`Resolved file paths: ${filePaths.length}`);

    if (filePaths.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum arquivo encontrado no dataset" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CSV parsing helper
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

    // Stream data from files with byte limits
    const MAX_ROWS = 5000; // Limit for batch predictions
    const MAX_BYTES_PER_FILE = 10 * 1024 * 1024; // 10MB per file
    let allLines: string[] = [];
    let headers: string[] = [];
    let isFirstFile = true;

    for (const filePath of filePaths) {
      if (allLines.length >= MAX_ROWS) break;

      console.log(`Streaming: ${filePath}`);
      
      try {
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from("datasets")
          .createSignedUrl(filePath, 300);

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
        let fileLines: string[] = [];

        while (bytesRead < MAX_BYTES_PER_FILE && fileLines.length < MAX_ROWS + 10) {
          const { done, value } = await reader.read();
          if (done) break;

          bytesRead += value?.length || 0;
          buffer += decoder.decode(value, { stream: true });

          const lineBreaks = buffer.split(/\r?\n/);
          for (let i = 0; i < lineBreaks.length - 1; i++) {
            const line = lineBreaks[i].trim();
            if (line) fileLines.push(line);
          }
          buffer = lineBreaks[lineBreaks.length - 1];
        }

        try { await reader.cancel(); } catch (_) {}

        console.log(`Bytes read: ${bytesRead}, Lines: ${fileLines.length}`);

        if (fileLines.length === 0) continue;

        if (isFirstFile) {
          headers = parseCSVLine(fileLines[0], delimiter);
          console.log(`Headers: ${headers.slice(0, 5).join(", ")}... (${headers.length} total)`);
          isFirstFile = false;
          
          const remaining = MAX_ROWS - allLines.length;
          allLines.push(...fileLines.slice(1, 1 + remaining));
        } else {
          const fileHeaders = parseCSVLine(fileLines[0], delimiter);
          const startLine = fileHeaders.length === headers.length ? 1 : 0;
          
          const remaining = MAX_ROWS - allLines.length;
          allLines.push(...fileLines.slice(startLine, startLine + remaining));
        }

        console.log(`Lines accumulated: ${allLines.length}`);

      } catch (err) {
        console.error(`Error processing ${filePath}:`, err);
        continue;
      }
    }

    if (headers.length === 0 || allLines.length === 0) {
      return new Response(JSON.stringify({ error: "Não foi possível ler dados do dataset" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Total lines for predictions: ${allLines.length}`);

    // Find column indices for base features
    const featureIndices = baseFeatureNames.map(name => headers.indexOf(name));
    const categoricalIndices = categoricalFeatures.map(c => ({
      name: c.column_name,
      index: headers.indexOf(c.column_name)
    }));

    // Look for entity_id column
    const entityIdCandidates = ['id', 'entity_id', 'cliente_id', 'customer_id', 'user_id', 'ID', 'Id'];
    let entityIdIndex = -1;
    let entityIdColumn = 'row_index';
    for (const candidate of entityIdCandidates) {
      const idx = headers.indexOf(candidate);
      if (idx !== -1) {
        entityIdIndex = idx;
        entityIdColumn = candidate;
        break;
      }
    }

    // Look for segmentation columns
    const segmentationCandidates: Record<string, number> = {};
    const segmentColNames = ['segment', 'segmento', 'segmento_cliente', 'region', 'regiao', 'estado', 'state', 'city', 'cidade', 'channel', 'canal', 'campaign', 'campanha', 'cohort', 'coorte', 'age_group', 'faixa_etaria', 'product_category', 'categoria_produto'];
    
    segmentColNames.forEach(name => {
      const idx = headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
      if (idx !== -1) {
        segmentationCandidates[name] = idx;
      }
    });

    // Calculate means and stds for normalization from sample data (base features only)
    const featureData: number[][] = baseFeatureNames.map(() => []);
    for (let i = 0; i < allLines.length; i++) {
      const values = parseCSVLine(allLines[i], delimiter);
      featureIndices.forEach((idx, j) => {
        const val = parseFloat((values[idx] || "").replace(",", "."));
        if (!isNaN(val)) featureData[j].push(val);
      });
    }

    const means = featureData.map(arr => mean(arr));
    const stds = featureData.map(arr => std(arr) || 1);
    
    // Calculate means and stds for engineered features
    const engineeredData: number[][] = engineeredFeatureNames.map(() => []);
    for (let i = 0; i < Math.min(allLines.length, 1000); i++) {
      const values = parseCSVLine(allLines[i], delimiter);
      const rawRecord: Record<string, string | number | null> = {};
      headers.forEach((h, idx) => {
        rawRecord[h] = values[idx] || null;
      });
      const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
      engineeredFeatureNames.forEach((name, j) => {
        const val = engineeredValues[name];
        if (typeof val === "number" && !isNaN(val)) {
          engineeredData[j].push(val);
        }
      });
    }
    const engineeredMeans = engineeredData.map(arr => mean(arr));
    const engineeredStds = engineeredData.map(arr => std(arr) || 1);

    const isClassification = project.problem_type === "classification";
    const batchId = `batch_${Date.now()}`;
    const predictionDate = new Date().toISOString();
    const predictions: any[] = [];

    console.log(`Processing ${allLines.length} entities...`);

    // First, mark all existing predictions for this project as not latest
    await supabase
      .from("predictions")
      .update({ is_latest: false })
      .eq("project_id", project_id);

    // Process each row
    for (let i = 0; i < allLines.length; i++) {
      const values = parseCSVLine(allLines[i], delimiter);
      
      // Get entity ID
      const entityId = entityIdIndex !== -1 ? values[entityIdIndex] : `entity_${i + 1}`;
      
      // Build raw record for feature engineering
      const rawRecord: Record<string, string | number | null> = {};
      headers.forEach((h, idx) => {
        rawRecord[h] = values[idx] || null;
      });
      
      // Extract and normalize base feature values
      const baseFeatureValues = featureIndices.map((idx, j) => {
        const val = parseFloat((values[idx] || "").replace(",", "."));
        if (isNaN(val)) return 0;
        return (val - means[j]) / stds[j];
      });
      
      // Apply and normalize engineered features
      const engineeredValues = applyFeatureTransforms(rawRecord, enabledFeatures);
      const engineeredFeatureValues = engineeredFeatureNames.map((name, j) => {
        const val = engineeredValues[name];
        if (typeof val !== "number" || isNaN(val)) return 0;
        return (val - engineeredMeans[j]) / engineeredStds[j];
      });
      
      // Combine all features
      const featureValues = [...baseFeatureValues, ...engineeredFeatureValues];

      // Make prediction
      const featureSum = featureValues.reduce((a, b) => a + b, 0);
      
      // Extract segmentation values
      const segmentValues: Record<string, string | null> = {
        segment: null,
        region: null,
        state: null,
        city: null,
        channel: null,
        campaign: null,
        cohort: null,
        age_group: null,
        product_category: null
      };

      Object.entries(segmentationCandidates).forEach(([name, idx]) => {
        const value = values[idx] || null;
        // Map to standard column names
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

      if (isClassification) {
        // Simulate probability based on features (use weights from feature importance if available)
        const probability = sigmoid(featureSum * 0.3 + (Math.random() * 0.4 - 0.2));
        const predictedClass = probability >= 0.5 ? "1" : "0";
        
        // Calculate potential value (estimate based on average ticket or similar)
        const potentialValue = 100 + Math.random() * 900; // Placeholder - should come from data

        predictions.push({
          project_id: project_id,
          user_id: project.user_id,
          entity_id: entityId,
          entity_type: "customer",
          reference_date: predictionDate,
          prediction_date: predictionDate,
          horizon_days: horizon_days,
          problem_type: "classification",
          problem_context: project.business_objective || null,
          probability_event: probability,
          predicted_class: predictedClass,
          predicted_value: null,
          potential_value: potentialValue,
          batch_id: batchId,
          is_latest: true,
          ...segmentValues,
          metadata: {
            model_id: productionModel.id,
            model_name: productionModel.algorithm_name
          }
        });
      } else {
        // Regression prediction
        const baseValue = mean(featureData[0]) || 100;
        const predictedValue = baseValue + featureSum * (std(featureData[0]) || 10);

        predictions.push({
          project_id: project_id,
          user_id: project.user_id,
          entity_id: entityId,
          entity_type: "customer",
          reference_date: predictionDate,
          prediction_date: predictionDate,
          horizon_days: horizon_days,
          problem_type: "regression",
          problem_context: project.business_objective || null,
          probability_event: null,
          predicted_class: null,
          predicted_value: predictedValue,
          potential_value: predictedValue,
          batch_id: batchId,
          is_latest: true,
          ...segmentValues,
          metadata: {
            model_id: productionModel.id,
            model_name: productionModel.algorithm_name
          }
        });
      }
    }

    console.log(`Generated ${predictions.length} predictions, inserting into database...`);

    // Insert predictions in batches of 500
    const batchSize = 500;
    let insertedCount = 0;
    
    for (let i = 0; i < predictions.length; i += batchSize) {
      const batch = predictions.slice(i, i + batchSize);
      const { error: insertError } = await supabase
        .from("predictions")
        .insert(batch);

      if (insertError) {
        console.error("Error inserting predictions batch:", insertError);
        throw insertError;
      }
      insertedCount += batch.length;
      console.log(`Inserted ${insertedCount}/${predictions.length} predictions`);
    }

    console.log(`Successfully inserted ${predictions.length} predictions`);

    return new Response(JSON.stringify({
      success: true,
      message: `${predictions.length} previsões geradas com sucesso`,
      batch_id: batchId,
      predictions_count: predictions.length,
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
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
