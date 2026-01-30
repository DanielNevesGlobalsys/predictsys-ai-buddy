import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface OrgUser {
  id: string;
  user_id: string;
  organization_id: string;
  role: string;
  status: string;
  created_at: string;
  profile: { full_name: string } | null;
  email: string | null;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify the user is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create client with user's auth token to check permissions
    const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get request body
    const { organization_id } = await req.json();
    if (!organization_id) {
      return new Response(JSON.stringify({ error: "organization_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create admin client for privileged operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user is super_admin or belongs to the organization as org_admin
    const { data: userOrgRole } = await supabaseAdmin
      .from("organization_users")
      .select("role")
      .eq("user_id", user.id)
      .eq("organization_id", organization_id)
      .single();

    const { data: isSuperAdmin } = await supabaseAdmin
      .from("organization_users")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "super_admin")
      .maybeSingle();

    const hasAccess = isSuperAdmin || (userOrgRole?.role === "org_admin") || (userOrgRole?.role === "super_admin");

    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch organization users
    const { data: orgUsers, error: orgUsersError } = await supabaseAdmin
      .from("organization_users")
      .select("*")
      .eq("organization_id", organization_id)
      .order("created_at", { ascending: false });

    if (orgUsersError) {
      throw orgUsersError;
    }

    // Fetch profiles and auth users for each org user
    const usersWithDetails: OrgUser[] = [];
    
    for (const orgUser of orgUsers || []) {
      // Get profile
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("full_name")
        .eq("id", orgUser.user_id)
        .single();

      // Get email from auth.users using admin API
      const { data: authUserData } = await supabaseAdmin.auth.admin.getUserById(orgUser.user_id);

      usersWithDetails.push({
        id: orgUser.id,
        user_id: orgUser.user_id,
        organization_id: orgUser.organization_id,
        role: orgUser.role,
        status: orgUser.status || "active",
        created_at: orgUser.created_at,
        profile: profile,
        email: authUserData?.user?.email || null,
      });
    }

    return new Response(JSON.stringify({ users: usersWithDetails }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Error in get-org-users:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
