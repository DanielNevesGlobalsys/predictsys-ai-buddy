import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Whitelist de tipos de evento permitidos
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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Validate auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create client with user token to verify
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

    // Parse body
    const body = await req.json();
    const {
      event_type,
      organization_id,
      project_id,
      status = "success",
      duration_ms,
      metadata = {},
      source = "app",
    } = body;

    // Validate event_type
    if (!event_type) {
      return new Response(
        JSON.stringify({ error: "event_type is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!ALLOWED_EVENT_TYPES.includes(event_type)) {
      return new Response(
        JSON.stringify({ error: `Invalid event_type. Allowed: ${ALLOWED_EVENT_TYPES.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use service role to insert (bypasses RLS)
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
      return new Response(
        JSON.stringify({ error: "Failed to track event" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[track-event] Event tracked: ${event_type} by user ${userId}`);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const error = err as Error;
    console.error("[track-event] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
