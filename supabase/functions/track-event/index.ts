import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_EVENT_TYPES = [
  "project_created",
  "dataset_connected",
  "dataset_uploaded",
  "dataset_profiled",
  "model_trained",
  "prediction_run",
  "segment_exported",
  "dashboard_viewed",
  "api_called",
  "job_error",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = user.id;

    const body = await req.json();
    let {
      event_type,
      organization_id,
      project_id,
      status = "success",
      duration_ms,
      metadata = {},
      source = "app",
    } = body;

    if (!event_type) {
      // Best-effort: don't break UX
      return new Response(
        JSON.stringify({ success: true, warning: "missing_event_type" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Map unknown event types to api_called instead of returning 400
    let warning: string | undefined;
    if (!ALLOWED_EVENT_TYPES.includes(event_type)) {
      console.warn(`[track-event] Unknown event_type "${event_type}", mapping to "api_called"`);
      metadata = {
        ...metadata,
        original_event_type: event_type,
        original_payload: body,
      };
      event_type = "api_called";
      warning = "event_type_mapped";
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { error: insertError } = await serviceClient
      .from("platform_events")
      .insert({
        user_id: userId,
        organization_id: organization_id || null,
        project_id: project_id || null,
        event_type,
        status,
        duration_ms: duration_ms || null,
        metadata,
        source,
        timestamp: new Date().toISOString(),
      });

    if (insertError) {
      console.error("[track-event] Insert error:", insertError);
      // Still return 200 — tracking should not break UX
      return new Response(
        JSON.stringify({ success: true, warning: "insert_failed" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[track-event] Event tracked: ${event_type} by user ${userId}`);

    return new Response(
      JSON.stringify({ success: true, ...(warning ? { warning } : {}) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const error = err as Error;
    console.error("[track-event] Error:", error);
    // Best-effort: always return 200
    return new Response(
      JSON.stringify({ success: true, warning: "internal_tracking_error" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
