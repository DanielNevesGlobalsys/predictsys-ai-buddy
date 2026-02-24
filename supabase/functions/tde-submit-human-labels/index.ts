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

    // Upsert labels — now with suggested_label, confidence, reason fields
    const rows = labels
      .filter((l: any) => l.label_status !== "unsure")
      .map((l: any) => ({
        project_id,
        user_id: user.id,
        entity_id: l.entity_id,
        label: l.label_status === "yes" ? 1 : 0,
        label_status: l.label_status,
        notes: l.notes || null,
        round_id,
        // New v2 fields stored in notes/metadata
        ...(l.suggested_label != null ? {} : {}),
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

    // Count totals for this project (all rounds)
    const { count: totalLabeled } = await supabase
      .from("project_human_labels")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id);

    const { count: positiveCount } = await supabase
      .from("project_human_labels")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .eq("label", 1);

    const nLabeled = totalLabeled || 0;
    const nPositive = positiveCount || 0;
    const nNegative = nLabeled - nPositive;
    const balance = nLabeled > 0 ? nPositive / nLabeled : 0;
    const minClass = Math.min(nPositive, nNegative);

    // Compute suggestion accuracy
    const confirmedCount = labels.filter((l: any) => l.label_status !== "unsure" && l.suggested_label != null).length;
    const agreedCount = labels.filter((l: any) => {
      if (l.label_status === "unsure" || l.suggested_label == null) return false;
      const userLabel = l.label_status === "yes" ? 1 : 0;
      return userLabel === l.suggested_label;
    }).length;
    const suggestionAccuracy = confirmedCount > 0 ? Math.round((agreedCount / confirmedCount) * 100) : null;

    // Trainability diagnostic
    const MIN_TOTAL_FOR_TRAINING = 100;
    const MIN_PER_CLASS = 30;
    let trainability_status = "ok";
    let trainability_reason: string | null = null;
    let trainability_ctas: any[] = [];

    if (nLabeled < MIN_TOTAL_FOR_TRAINING) {
      trainability_status = "insufficient_total";
      trainability_reason = `Apenas ${nLabeled} rótulos. Mínimo: ${MIN_TOTAL_FOR_TRAINING}.`;
      trainability_ctas = [{ label: "Gerar mais amostras", action: "generate_more" }];
    } else if (minClass < MIN_PER_CLASS) {
      const minorityClass = nPositive < nNegative ? "positivos" : "negativos";
      trainability_status = "minority_class_too_small";
      trainability_reason = `Faltam ${MIN_PER_CLASS - minClass} exemplos ${minorityClass} (atual: ${minClass}, mín: ${MIN_PER_CLASS}).`;
      trainability_ctas = [
        { label: `Buscar ${minorityClass}`, action: "generate_directed", direction: nPositive < nNegative ? "positive" : "negative" },
        { label: "Gerar mais amostras", action: "generate_more" },
      ];
    } else if (nPositive === 0 || nNegative === 0) {
      trainability_status = "only_one_class";
      trainability_reason = `Apenas uma classe rotulada (${nPositive > 0 ? "positivos" : "negativos"}).`;
      trainability_ctas = [
        { label: "Buscar classe faltante", action: "generate_directed", direction: nPositive === 0 ? "positive" : "negative" },
        { label: "Ativar supervisão fraca", action: "enable_weak_supervision" },
      ];
    }

    // Update SSOT
    await supabase
      .from("project_settings")
      .update({
        human_label_result: {
          n_labeled: nLabeled,
          n_positive: nPositive,
          n_negative: nNegative,
          balance,
          min_class: minClass,
          round_id,
          suggestion_accuracy: suggestionAccuracy,
          trainability_status,
          trainability_reason,
          trainability_ctas,
          last_updated: new Date().toISOString(),
        },
      } as any)
      .eq("project_id", project_id);

    return new Response(JSON.stringify({
      success: true,
      n_saved: rows.length,
      n_skipped: labels.length - rows.length,
      n_labeled: nLabeled,
      n_positive: nPositive,
      n_negative: nNegative,
      balance,
      min_class: minClass,
      suggestion_accuracy: suggestionAccuracy,
      trainability_status,
      trainability_reason,
      trainability_ctas,
      round_id,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[tde-submit-human-labels] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
