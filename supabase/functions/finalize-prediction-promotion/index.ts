import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { project_id, batch_id } = await req.json();
    if (!project_id || !batch_id) {
      return new Response(JSON.stringify({ error: "project_id and batch_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Read prediction state to get counts
    const { data: state } = await supabase
      .from("project_prediction_state")
      .select("predictions_count, coverage_pct, latest_model_id, latest_selection_version, latest_job_id")
      .eq("project_id", project_id)
      .maybeSingle();

    // Update heartbeat before attempting promotion
    await supabase.from("project_prediction_state").update({
      status: "finalizing",
      last_heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("project_id", project_id);

    const { data: result, error } = await supabase.rpc("rpc_promote_prediction_batch", {
      p_project_id: project_id,
      p_batch_id: batch_id,
      p_model_id: state?.latest_model_id || null,
      p_selection_version: state?.latest_selection_version || null,
      p_job_id: state?.latest_job_id || null,
      p_predictions_count: state?.predictions_count || 0,
      p_coverage_pct: state?.coverage_pct || 0,
    });

    if (error) {
      console.error("[finalize-prediction-promotion] RPC error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[finalize-prediction-promotion] Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
