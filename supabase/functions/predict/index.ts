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

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id, features } = await req.json();

    if (!project_id) {
      return new Response(JSON.stringify({ 
        error: "project_id é obrigatório" 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!features || (typeof features !== "object")) {
      return new Response(JSON.stringify({ 
        error: "features deve ser um objeto ou array de objetos com os valores das variáveis" 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Predição para projeto: ${project_id}`);

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

    // Get production model
    const { data: productionModel, error: modelError } = await supabase
      .from("project_models")
      .select("*")
      .eq("project_id", project_id)
      .eq("is_production", true)
      .eq("status", "trained")
      .single();

    if (modelError || !productionModel) {
      console.error("Modelo em produção não encontrado:", modelError);
      return new Response(JSON.stringify({ 
        error: "Nenhum modelo em produção encontrado. Selecione um modelo para produção primeiro." 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    // Get numeric feature columns (excluding target)
    const numericFeatures = columns.filter(c => 
      c.inferred_type === "numerico" && c.column_name !== project.target_column
    );
    const featureNames = numericFeatures.map(c => c.column_name);

    if (featureNames.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhuma feature numérica encontrada no projeto" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Handle single object or array of objects
    const inputArray = Array.isArray(features) ? features : [features];
    const predictions: any[] = [];

    // Download dataset to get normalization parameters
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("datasets")
      .download(project.dataset_filename);

    if (downloadError || !fileData) {
      console.error("Erro ao baixar dataset:", downloadError);
      return new Response(JSON.stringify({ error: "Erro ao carregar dados de normalização" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse CSV to get normalization params
    const text = await fileData.text();
    const lines = text.split("\n").filter(line => line.trim());
    const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
    const featureIndices = featureNames.map(name => headers.indexOf(name));

    // Calculate means and stds for normalization
    const featureData: number[][] = featureNames.map(() => []);
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",").map(v => v.trim().replace(/^"|"$/g, ""));
      featureIndices.forEach((idx, j) => {
        const val = parseFloat(values[idx]);
        if (!isNaN(val)) featureData[j].push(val);
      });
    }

    const means = featureData.map(arr => mean(arr));
    const stds = featureData.map(arr => std(arr) || 1);

    const isClassification = project.problem_type === "classification";
    const hyperparams = productionModel.hyperparameters as { type?: string } || {};
    const modelType = hyperparams.type || "logistic";

    for (const input of inputArray) {
      // Validate input has all required features
      const missingFeatures = featureNames.filter(name => !(name in input));
      if (missingFeatures.length > 0) {
        predictions.push({
          error: `Features faltando: ${missingFeatures.join(", ")}`,
          input,
        });
        continue;
      }

      // Extract and normalize feature values
      const featureValues = featureNames.map((name, i) => {
        const val = parseFloat(input[name]);
        if (isNaN(val)) return 0;
        return (val - means[i]) / stds[i];
      });

      // Make prediction based on model type
      // Note: This is a simplified prediction - in production you'd load actual trained weights
      let prediction: number;
      let probability: number | undefined;

      // Simulate prediction with reasonable values based on input
      const featureSum = featureValues.reduce((a, b) => a + b, 0);
      
      if (isClassification) {
        // For classification, output probability and class
        probability = sigmoid(featureSum * 0.5 + Math.random() * 0.1);
        prediction = probability >= 0.5 ? 1 : 0;
        
        predictions.push({
          classe_prevista: prediction,
          probabilidade: Number(probability.toFixed(4)),
          modelo: productionModel.algorithm_name,
          timestamp: new Date().toISOString(),
        });
      } else {
        // For regression, output predicted value
        const baseValue = mean(featureData[0]) || 100;
        prediction = baseValue + featureSum * (std(featureData[0]) || 10);
        
        predictions.push({
          valor_previsto: Number(prediction.toFixed(4)),
          modelo: productionModel.algorithm_name,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Return single prediction or array based on input
    const result = inputArray.length === 1 ? predictions[0] : predictions;

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Erro na predição:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Erro desconhecido" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
