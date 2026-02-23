import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, round_id, labels } = await req.json();
    if (!project_id || !round_id || !Array.isArray(labels) || labels.length === 0) {
      return new Response(JSON.stringify({ error: "project_id, round_id e labels[] são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[tde-submit-human-labels] project=${project_id}, round=${round_id}, labels=${labels.length}`);

    // Upsert labels
    const rows = labels
      .filter((l: any) => l.label_status !== "unsure") // Skip "Não sei"
      .map((l: any) => ({
        project_id,
        user_id: user.id,
        entity_id: l.entity_id,
        label: l.label_status === "yes" ? 1 : 0,
        label_status: l.label_status,
        notes: l.notes || null,
        round_id,
      }));

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from("project_human_labels")
        .upsert(rows, { onConflict: "project_id,entity_id,round_id" });

      if (upsertError) {
        console.error("[tde-submit-human-labels] Upsert error:", upsertError);
        return new Response(JSON.stringify({ error: upsertError.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Count totals for this round
    const { count: totalLabeled } = await supabase
      .from("project_human_labels")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .eq("round_id", round_id);

    const { count: positiveCount } = await supabase
      .from("project_human_labels")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .eq("round_id", round_id)
      .eq("label", 1);

    const nLabeled = totalLabeled || 0;
    const nPositive = positiveCount || 0;
    const balance = nLabeled > 0 ? nPositive / nLabeled : 0;

    // Update SSOT
    await supabase
      .from("project_settings")
      .update({
        human_label_result: {
          n_labeled: nLabeled,
          n_positive: nPositive,
          balance,
          round_id,
          last_updated: new Date().toISOString(),
        },
      } as any)
      .eq("project_id", project_id);

    return new Response(JSON.stringify({
      success: true,
      n_saved: rows.length,
      n_skipped: labels.length - rows.length,
      n_labeled: nLabeled,
      balance,
      round_id,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[tde-submit-human-labels] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
