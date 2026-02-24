/**
 * Enterprise project access validation for Edge Functions.
 * 
 * Validates that:
 * 1. JWT is present and valid
 * 2. User belongs to the org that owns the project
 * 3. Logs mismatch if body contains a different project_id than the validated one
 * 
 * Usage:
 *   const ctx = await validateProjectAccess(req, supabaseAdmin, projectId);
 *   if (ctx.error) return ctx.error; // returns a Response
 *   // ctx.userId, ctx.organizationId are safe to use
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export interface ProjectAccessContext {
  userId: string;
  organizationId: string;
  error?: Response;
}

/**
 * Validate that the authenticated user can access a given project.
 * Uses the security-definer function user_can_access_project() for org-level isolation.
 */
export async function validateProjectAccess(
  supabaseAdmin: any,
  authHeader: string | null,
  projectId: string,
  endpoint: string,
  bodyProjectId?: string | null,
): Promise<ProjectAccessContext> {
  // 1. Validate JWT
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      userId: "",
      organizationId: "",
      error: new Response(
        JSON.stringify({ error: "Unauthorized", code: "NO_AUTH" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      ),
    };
  }

  const token = authHeader.replace("Bearer ", "");

  // Get user from token
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) {
    return {
      userId: "",
      organizationId: "",
      error: new Response(
        JSON.stringify({ error: "Invalid token", code: "INVALID_TOKEN" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      ),
    };
  }

  const userId = user.id;

  // 2. Get project and validate ownership
  const { data: project, error: projectError } = await supabaseAdmin
    .from("projects")
    .select("id, organization_id")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError || !project) {
    return {
      userId,
      organizationId: "",
      error: new Response(
        JSON.stringify({ error: "Project not found", code: "PROJECT_NOT_FOUND" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      ),
    };
  }

  // 3. Check org membership via security definer function
  const { data: canAccess } = await supabaseAdmin.rpc("user_can_access_project", {
    _user_id: userId,
    _project_id: projectId,
  });

  if (!canAccess) {
    return {
      userId,
      organizationId: project.organization_id,
      error: new Response(
        JSON.stringify({ error: "Access denied to this project", code: "ACCESS_DENIED" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      ),
    };
  }

  // 4. Audit mismatch if body contained a different project_id
  if (bodyProjectId && bodyProjectId !== projectId) {
    try {
      await supabaseAdmin.from("audit_project_mismatch").insert({
        user_id: userId,
        route_project_id: projectId,
        body_project_id: bodyProjectId,
        resolved_project_id: projectId,
        endpoint,
        metadata: { detected_at: new Date().toISOString() },
      });
      console.warn(
        `[validate-project-access] MISMATCH: user=${userId} endpoint=${endpoint} ` +
        `route=${projectId} body=${bodyProjectId} → resolved to route`,
      );
    } catch (e) {
      console.warn("[validate-project-access] Failed to log mismatch:", e);
    }
  }

  return {
    userId,
    organizationId: project.organization_id,
  };
}
