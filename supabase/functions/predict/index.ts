import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function predictTree(tree: any, x: number[]): number {
  if (!tree || tree.isLeaf) return tree?.value || 0;
  return x[tree.feature] <= tree.threshold 
    ? predictTree(tree.left, x) 
    : predictTree(tree.right, x);
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
      return new Response(JSON.stringify({ 
        error: "Nenhum modelo em produção encontrado." 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Extract model artifacts
    const hyperparams = (productionModel.hyperparameters as any) || {};
    const modelArtifacts = hyperparams.model_artifacts;
    const savedNormalization = hyperparams.normalization;
    const savedFeatureNames: string[] = hyperparams.feature_names || [];

    if (!modelArtifacts || (!modelArtifacts.weights && !modelArtifacts.trees)) {
      return new Response(JSON.stringify({ 
        error: "Modelo sem artefatos de treinamento salvos. Re-treine o modelo." 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!savedNormalization?.means || !savedNormalization?.stds || savedFeatureNames.length === 0) {
      return new Response(JSON.stringify({ 
        error: "Modelo sem parâmetros de normalização. Re-treine o modelo." 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isClassification = project.problem_type === "classification";
    const inputArray = Array.isArray(features) ? features : [features];
    const predictions: any[] = [];

    for (const input of inputArray) {
      // Validate input has required features
      const missingFeatures = savedFeatureNames.filter(name => !(name in input));
      if (missingFeatures.length > 0) {
        predictions.push({
          error: `Features faltando: ${missingFeatures.join(", ")}`,
          input,
        });
        continue;
      }

      // Normalize features using saved training params
      const featureValues = savedFeatureNames.map((name, i) => {
        const val = parseFloat(input[name]);
        if (isNaN(val)) return 0;
        return (val - savedNormalization.means[i]) / (savedNormalization.stds[i] || 1);
      });

      // Real model inference
      let prediction: number;
      let probability: number | undefined;

      if (modelArtifacts.type === "gradient_boosting" && modelArtifacts.trees) {
        let pred = modelArtifacts.base || 0;
        const lr = modelArtifacts.lr || 0.1;
        for (const tree of modelArtifacts.trees) {
          pred += lr * predictTree(tree, featureValues);
        }
        if (isClassification) {
          probability = sigmoid(pred);
          prediction = probability >= 0.5 ? 1 : 0;
        } else {
          prediction = pred;
        }
      } else {
        // Linear / Logistic regression
        const weights: number[] = modelArtifacts.weights;
        const bias: number = modelArtifacts.bias || 0;
        let z = bias;
        for (let j = 0; j < Math.min(weights.length, featureValues.length); j++) {
          z += weights[j] * featureValues[j];
        }
        if (isClassification) {
          probability = sigmoid(z);
          prediction = probability >= 0.5 ? 1 : 0;
        } else {
          prediction = z;
        }
      }

      if (isClassification) {
        predictions.push({
          classe_prevista: prediction,
          probabilidade: Number((probability ?? 0).toFixed(4)),
          modelo: productionModel.algorithm_name,
          timestamp: new Date().toISOString(),
        });
      } else {
        predictions.push({
          valor_previsto: Number(prediction.toFixed(4)),
          modelo: productionModel.algorithm_name,
          timestamp: new Date().toISOString(),
        });
      }
    }

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
