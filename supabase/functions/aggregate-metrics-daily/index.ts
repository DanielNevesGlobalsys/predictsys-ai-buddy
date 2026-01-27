import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("[aggregate-metrics-daily] Starting daily aggregation...");

    // Get date range - process yesterday by default
    const body = await req.json().catch(() => ({}));
    const targetDate = body.date ? new Date(body.date) : new Date();
    targetDate.setDate(targetDate.getDate() - 1); // Yesterday
    const dayStr = targetDate.toISOString().split("T")[0];

    const startOfDay = `${dayStr}T00:00:00.000Z`;
    const endOfDay = `${dayStr}T23:59:59.999Z`;

    console.log(`[aggregate-metrics-daily] Processing day: ${dayStr}`);

    // Get all organizations
    const { data: orgs, error: orgsError } = await supabase
      .from("organizations")
      .select("id");

    if (orgsError) {
      console.error("[aggregate-metrics-daily] Error fetching orgs:", orgsError);
      throw orgsError;
    }

    const orgIds = [...(orgs || []).map((o: { id: string }) => o.id), null]; // null for global

    for (const orgId of orgIds) {
      try {
        // Build base query filter
        let eventsQuery = supabase
          .from("platform_events")
          .select("*")
          .gte("timestamp", startOfDay)
          .lte("timestamp", endOfDay);

        if (orgId) {
          eventsQuery = eventsQuery.eq("organization_id", orgId);
        }

        const { data: events, error: eventsError } = await eventsQuery;

        if (eventsError) {
          console.error(`[aggregate-metrics-daily] Error fetching events for org ${orgId}:`, eventsError);
          continue;
        }

        interface PlatformEvent {
          event_type: string;
          status: string;
          user_id: string;
          duration_ms?: number;
        }

        const eventsList = (events || []) as PlatformEvent[];

        // Calculate metrics
        const projectsCreated = eventsList.filter((e) => e.event_type === "project_created").length;
        const datasetsConnected = eventsList.filter((e) => 
          e.event_type === "dataset_connected" || e.event_type === "dataset_uploaded"
        ).length;
        const modelsTrained = eventsList.filter((e) => e.event_type === "model_trained").length;
        const predictionsRun = eventsList.filter((e) => e.event_type === "prediction_run").length;
        const segmentsExported = eventsList.filter((e) => e.event_type === "segment_exported").length;
        
        // Active users (distinct user_ids)
        const activeUsers1d = new Set(eventsList.map((e) => e.user_id)).size;

        // Jobs with errors
        const jobsErrorCount = eventsList.filter((e) => 
          e.event_type === "job_error" || e.status === "error"
        ).length;

        // Average durations
        const importEvents = eventsList.filter((e) => 
          (e.event_type === "dataset_connected" || e.event_type === "dataset_uploaded") && e.duration_ms
        );
        const avgImportMs = importEvents.length > 0 
          ? Math.round(importEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / importEvents.length)
          : 0;

        const edaEvents = eventsList.filter((e) => e.event_type === "dataset_profiled" && e.duration_ms);
        const avgEdaMs = edaEvents.length > 0
          ? Math.round(edaEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / edaEvents.length)
          : 0;

        const trainEvents = eventsList.filter((e) => e.event_type === "model_trained" && e.duration_ms);
        const avgTrainMs = trainEvents.length > 0
          ? Math.round(trainEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / trainEvents.length)
          : 0;

        const predictEvents = eventsList.filter((e) => e.event_type === "prediction_run" && e.duration_ms);
        const avgPredictMs = predictEvents.length > 0
          ? Math.round(predictEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / predictEvents.length)
          : 0;

        // Upsert metrics
        const { error: upsertError } = await supabase
          .from("platform_metrics_daily")
          .upsert(
            {
              day: dayStr,
              organization_id: orgId,
              projects_created: projectsCreated,
              datasets_connected: datasetsConnected,
              models_trained: modelsTrained,
              predictions_run: predictionsRun,
              segments_exported: segmentsExported,
              active_users_1d: activeUsers1d,
              active_users_7d: 0,
              active_users_30d: 0,
              jobs_error_count: jobsErrorCount,
              avg_import_ms: avgImportMs,
              avg_eda_ms: avgEdaMs,
              avg_train_ms: avgTrainMs,
              avg_predict_ms: avgPredictMs,
            },
            { onConflict: "day,organization_id" }
          );

        if (upsertError) {
          console.error(`[aggregate-metrics-daily] Upsert error for org ${orgId}:`, upsertError);
        } else {
          console.log(`[aggregate-metrics-daily] Metrics saved for org ${orgId || "global"}: projects=${projectsCreated}, models=${modelsTrained}`);
        }
      } catch (orgError) {
        console.error(`[aggregate-metrics-daily] Error processing org ${orgId}:`, orgError);
      }
    }

    console.log("[aggregate-metrics-daily] Aggregation complete");

    return new Response(
      JSON.stringify({ success: true, day: dayStr }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const error = err as Error;
    console.error("[aggregate-metrics-daily] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
