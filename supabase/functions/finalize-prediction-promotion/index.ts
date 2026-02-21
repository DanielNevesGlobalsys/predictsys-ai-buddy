import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Standard response shape — always HTTP 200
  const makeResponse = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { project_id, batch_id, predictions_count, coverage_pct } = await req.json();

    if (!project_id || !batch_id) {
      return makeResponse({
        success: false,
        status: "ERROR",
        error_code: "MISSING_PARAMS",
        error_friendly: "project_id and batch_id are required.",
        gates: [],
        ctas: [],
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Call O(1) RPC — new simplified signature
    const { data, error } = await supabase.rpc("rpc_promote_prediction_batch", {
      p_project_id: project_id,
      p_batch_id: batch_id,
      p_predictions_count: predictions_count ?? null,
      p_coverage_pct: coverage_pct ?? null,
    });

    if (error) {
      console.error("[finalize-prediction-promotion] RPC error:", error);

      // Best-effort: mark state as failed so UI doesn't stay stuck
      try {
        await supabase.from("project_prediction_state").upsert({
          project_id,
          status: "failed",
          last_error_code: error.code || "RPC_ERROR",
          last_error_message: error.message,
          updated_at: new Date().toISOString(),
          last_heartbeat_at: new Date().toISOString(),
        }, { onConflict: "project_id" });
      } catch (_) { /* best-effort */ }

      return makeResponse({
        success: false,
        status: "ERROR",
        project_id,
        batch_id,
        error_code: error.code || "RPC_ERROR",
        error_friendly: error.message || "Erro inesperado na promoção.",
        gates: [],
        ctas: [{ label: "Tentar novamente", action: "finalize_promotion" }],
      });
    }

    const result = data as Record<string, unknown> | null;

    return makeResponse({
      success: result?.success ?? true,
      status: result?.status ?? "PROMOTED",
      project_id: result?.project_id ?? project_id,
      batch_id: result?.batch_id ?? batch_id,
      error_code: null,
      error_friendly: null,
      gates: [],
      ctas: [],
    });
  } catch (err) {
    console.error("[finalize-prediction-promotion] Error:", err);
    return makeResponse({
      success: false,
      status: "ERROR",
      error_code: "EDGE_FUNCTION_ERROR",
      error_friendly: err instanceof Error ? err.message : "Erro desconhecido",
      gates: [],
      ctas: [],
    });
  }
});
