import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface AuditLogPayload {
  action: string;
  resource_type: string;
  resource_name?: string;
  project_id?: string;
  organization_id?: string;
  metadata?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Client with user context for auth validation
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Validate JWT and get user
    const token = authHeader.replace("Bearer ", "");
    const { data: claims, error: claimsError } = await supabaseUser.auth.getClaims(token);
    
    if (claimsError || !claims?.claims) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claims.claims.sub;
    
    // Parse request body
    const payload: AuditLogPayload = await req.json();
    
    if (!payload.action || !payload.resource_type) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: action, resource_type" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use service role for insert (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // If organization_id not provided, try to get it from the project
    let organizationId = payload.organization_id;
    
    if (!organizationId && payload.project_id) {
      const { data: project } = await supabaseAdmin
        .from("projects")
        .select("organization_id")
        .eq("id", payload.project_id)
        .maybeSingle();
      
      organizationId = project?.organization_id;
    }

    // If still no org_id, get from user's organizations
    if (!organizationId) {
      const { data: userOrgs } = await supabaseAdmin
        .from("organization_users")
        .select("organization_id")
        .eq("user_id", userId)
        .limit(1);
      
      organizationId = userOrgs?.[0]?.organization_id;
    }

    if (!organizationId) {
      return new Response(
        JSON.stringify({ error: "Could not determine organization_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify user belongs to this organization
    const { data: belongsToOrg } = await supabaseAdmin.rpc("user_belongs_to_org", {
      _user_id: userId,
      _org_id: organizationId,
    });

    if (!belongsToOrg) {
      return new Response(
        JSON.stringify({ error: "User does not belong to this organization" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract client info
    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || 
                      req.headers.get("x-real-ip") || 
                      null;
    const userAgent = req.headers.get("user-agent") || null;

    // Insert audit log
    const { data: auditLog, error: insertError } = await supabaseAdmin
      .from("audit_logs")
      .insert({
        user_id: userId,
        organization_id: organizationId,
        project_id: payload.project_id || null,
        action: payload.action,
        resource_type: payload.resource_type,
        resource_name: payload.resource_name || null,
        metadata: payload.metadata || {},
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("Error inserting audit log:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to create audit log", details: insertError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Audit log created: ${payload.action} for org ${organizationId}`);

    return new Response(
      JSON.stringify({ success: true, id: auditLog.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Audit log error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: "Internal server error", details: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
