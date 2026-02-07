import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Stage = "eda" | "targeting" | "training" | "predictions" | "business" | "storyline";

const VALID_STAGES: Stage[] = ["eda", "targeting", "training", "predictions", "business", "storyline"];

const STATUS_MAP: Record<Stage, string> = {
  eda: "eda_ready",
  targeting: "target_defined",
  training: "model_trained",
  predictions: "predictions_ready",
  business: "business_ready",
  storyline: "business_ready",
};

const DEFAULT_CONTEXT = {
  eda: {
    summary: "",
    column_profile: {},
    warnings: [],
    hypotheses: [],
  },
  targeting: {
    suggested_problems: [],
    selected_problem: "",
    selected_target: "",
    recommended_features: [],
    excluded_features: [],
    justification: "",
  },
  training: {
    model_type: "",
    metrics: {},
    limitations: [],
    confidence_level: "",
  },
  predictions: {
    horizons: {},
    segment_insights: [],
  },
  business: {
    kpis: {},
    risks: [],
    opportunities: [],
    campaigns_summary: [],
  },
  storyline: {
    executive_summary: "",
    last_update_reason: "",
  },
};

/**
 * Deep merge two objects. Arrays are replaced, not concatenated.
 * Only merges objects; primitives and arrays from `source` overwrite `target`.
 */
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key]) &&
      result[key] !== null
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      organization_id,
      project_id,
      stage,
      payload,
      status_update,
    } = await req.json();

    // Validate inputs
    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!stage || !VALID_STAGES.includes(stage)) {
      return new Response(
        JSON.stringify({ error: `stage inválido. Use: ${VALID_STAGES.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!payload || typeof payload !== "object") {
      return new Response(
        JSON.stringify({ error: "payload é obrigatório e deve ser um objeto" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[append-project-context] project=${project_id} stage=${stage}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch existing context
    const { data: existing, error: fetchErr } = await supabase
      .from("project_ai_context")
      .select("id, context, status")
      .eq("project_id", project_id)
      .maybeSingle();

    if (fetchErr) {
      console.error("[append-project-context] Fetch error:", fetchErr);
      return new Response(
        JSON.stringify({ error: "Erro ao buscar contexto existente" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const currentContext = existing?.context as Record<string, any> || { ...DEFAULT_CONTEXT };

    // Deep merge: only update the stage block, preserve everything else
    const stageBlock = currentContext[stage] || {};
    const mergedStage = deepMerge(stageBlock, payload);
    const updatedContext = { ...currentContext, [stage]: mergedStage };

    // Determine status
    const newStatus = status_update || STATUS_MAP[stage as Stage] || existing?.status || "draft";

    if (existing) {
      // Update existing record
      const { error: updateErr } = await supabase
        .from("project_ai_context")
        .update({
          context: updatedContext,
          status: newStatus,
          last_updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (updateErr) {
        console.error("[append-project-context] Update error:", updateErr);
        return new Response(
          JSON.stringify({ error: "Erro ao atualizar contexto" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[append-project-context] Updated stage=${stage} status=${newStatus}`);
    } else {
      // Resolve organization_id if not provided
      let orgId = organization_id;
      if (!orgId) {
        const { data: proj } = await supabase
          .from("projects")
          .select("organization_id")
          .eq("id", project_id)
          .single();
        orgId = proj?.organization_id;
      }

      if (!orgId) {
        return new Response(
          JSON.stringify({ error: "organization_id não encontrado para o projeto" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Insert new record
      const { error: insertErr } = await supabase
        .from("project_ai_context")
        .insert({
          organization_id: orgId,
          project_id,
          context: updatedContext,
          status: newStatus,
        });

      if (insertErr) {
        console.error("[append-project-context] Insert error:", insertErr);
        return new Response(
          JSON.stringify({ error: "Erro ao criar contexto" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[append-project-context] Created new context stage=${stage} status=${newStatus}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        stage,
        status: newStatus,
        context: updatedContext,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[append-project-context] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
