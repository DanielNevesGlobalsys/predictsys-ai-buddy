import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface OrgUsage {
  organization_id: string;
  organization_name: string;
  plan: string;
  projects_created: number;
  datasets_connected: number;
  models_trained: number;
  predictions_run: number;
  segments_exported: number;
  jobs_error_count: number;
  active_users: number;
  total_users: number;
  last_event_at: string | null;
}

interface PlatformEvent {
  event_type: string;
  status: string;
  user_id: string;
  organization_id: string | null;
  project_id: string | null;
  duration_ms: number | null;
  timestamp: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Validate auth and check super_admin
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

    // Check if user is super_admin using service role
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    const { data: roleData, error: roleError } = await supabase
      .from("organization_users")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "super_admin")
      .limit(1);

    if (roleError || !roleData || roleData.length === 0) {
      return new Response(
        JSON.stringify({ error: "Forbidden: Super admin access required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse body params
    let dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    let dateTo = new Date().toISOString().split("T")[0];
    let orgId: string | null = null;

    try {
      const body = await req.json();
      if (body.date_from) dateFrom = body.date_from;
      if (body.date_to) dateTo = body.date_to;
      if (body.organization_id) orgId = body.organization_id;
    } catch {
      // If no body or invalid JSON, use defaults
    }

    console.log(`[analytics-data] Fetching data from ${dateFrom} to ${dateTo}, org: ${orgId || "all"}`);

    // Fetch organizations
    const { data: organizations, error: orgsError } = await supabase
      .from("organizations")
      .select("id, name, plan, created_at");

    if (orgsError) {
      console.error("[analytics-data] Error fetching organizations:", orgsError);
      throw orgsError;
    }

    // Build a map of project_id -> organization_id for resolving null org_ids in events
    const { data: projectsData } = await supabase
      .from("projects")
      .select("id, organization_id");
    
    const projectOrgMap = new Map<string, string>();
    for (const p of projectsData || []) {
      if (p.organization_id) {
        projectOrgMap.set(p.id, p.organization_id);
      }
    }

    // Fetch raw events for the period - this is our source of truth
    const startTimestamp = `${dateFrom}T00:00:00.000Z`;
    const endTimestamp = `${dateTo}T23:59:59.999Z`;

    const { data: eventsData, error: eventsError } = await supabase
      .from("platform_events")
      .select("event_type, status, user_id, organization_id, project_id, duration_ms, timestamp")
      .gte("timestamp", startTimestamp)
      .lte("timestamp", endTimestamp)
      .order("timestamp", { ascending: false });

    if (eventsError) {
      console.error("[analytics-data] Error fetching events:", eventsError);
      throw eventsError;
    }

    const events = (eventsData || []) as PlatformEvent[];
    console.log(`[analytics-data] Found ${events.length} events in period`);

    // Resolve organization_id for events where it's null but project_id exists
    const resolvedEvents = events.map(e => ({
      ...e,
      resolved_org_id: e.organization_id || (e.project_id ? projectOrgMap.get(e.project_id) : null) || null
    }));

    // Calculate global KPIs from events
    const globalKPIs = {
      projects_created: resolvedEvents.filter(e => e.event_type === "project_created").length,
      datasets_connected: resolvedEvents.filter(e => 
        e.event_type === "dataset_connected" || e.event_type === "dataset_uploaded"
      ).length,
      models_trained: resolvedEvents.filter(e => e.event_type === "model_trained").length,
      predictions_run: resolvedEvents.filter(e => e.event_type === "prediction_run").length,
      segments_exported: resolvedEvents.filter(e => e.event_type === "segment_exported").length,
      jobs_error_count: resolvedEvents.filter(e => 
        e.event_type === "job_error" || e.status === "error"
      ).length,
      active_organizations: 0,
      total_organizations: organizations?.length || 0,
    };

    // Calculate health metrics (average durations)
    const importEvents = resolvedEvents.filter(e => 
      (e.event_type === "dataset_connected" || e.event_type === "dataset_uploaded") && e.duration_ms
    );
    const edaEvents = resolvedEvents.filter(e => e.event_type === "dataset_profiled" && e.duration_ms);
    const trainEvents = resolvedEvents.filter(e => e.event_type === "model_trained" && e.duration_ms);
    const predictEvents = resolvedEvents.filter(e => e.event_type === "prediction_run" && e.duration_ms);

    const healthMetrics = {
      avg_import_ms: importEvents.length > 0 
        ? Math.round(importEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / importEvents.length)
        : 0,
      avg_eda_ms: edaEvents.length > 0
        ? Math.round(edaEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / edaEvents.length)
        : 0,
      avg_train_ms: trainEvents.length > 0
        ? Math.round(trainEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / trainEvents.length)
        : 0,
      avg_predict_ms: predictEvents.length > 0
        ? Math.round(predictEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / predictEvents.length)
        : 0,
      total_errors: globalKPIs.jobs_error_count,
    };

    // Calculate per-organization usage
    const orgUsage: OrgUsage[] = [];
    const activeOrgIds = new Set<string>();

    for (const org of organizations || []) {
      const orgEvents = resolvedEvents.filter(e => e.resolved_org_id === org.id);
      
      if (orgEvents.length > 0) {
        activeOrgIds.add(org.id);
      }

      // Sum up totals for this org
      const totals = {
        projects_created: orgEvents.filter(e => e.event_type === "project_created").length,
        datasets_connected: orgEvents.filter(e => 
          e.event_type === "dataset_connected" || e.event_type === "dataset_uploaded"
        ).length,
        models_trained: orgEvents.filter(e => e.event_type === "model_trained").length,
        predictions_run: orgEvents.filter(e => e.event_type === "prediction_run").length,
        segments_exported: orgEvents.filter(e => e.event_type === "segment_exported").length,
        jobs_error_count: orgEvents.filter(e => 
          e.event_type === "job_error" || e.status === "error"
        ).length,
      };

      // Get distinct active users for this org
      const activeUsers = new Set(orgEvents.map(e => e.user_id)).size;

      // Get total user count for org
      const { count: userCount } = await supabase
        .from("organization_users")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);

      // Get last event timestamp
      const lastEventAt = orgEvents.length > 0 ? orgEvents[0].timestamp : null;

      orgUsage.push({
        organization_id: org.id,
        organization_name: org.name,
        plan: org.plan,
        ...totals,
        active_users: activeUsers,
        total_users: userCount || 0,
        last_event_at: lastEventAt,
      });
    }

    globalKPIs.active_organizations = activeOrgIds.size;

    // Build daily trend from events
    const dailyMap = new Map<string, { models_trained: number; predictions_run: number; jobs_error_count: number }>();
    
    for (const e of resolvedEvents) {
      const day = e.timestamp.split("T")[0];
      if (!dailyMap.has(day)) {
        dailyMap.set(day, { models_trained: 0, predictions_run: 0, jobs_error_count: 0 });
      }
      const dayData = dailyMap.get(day)!;
      
      if (e.event_type === "model_trained") dayData.models_trained++;
      if (e.event_type === "prediction_run") dayData.predictions_run++;
      if (e.event_type === "job_error" || e.status === "error") dayData.jobs_error_count++;
    }

    const dailyTrend = Array.from(dailyMap.entries())
      .map(([day, data]) => ({ day, ...data }))
      .sort((a, b) => a.day.localeCompare(b.day));

    console.log(`[analytics-data] Returning KPIs: projects=${globalKPIs.projects_created}, models=${globalKPIs.models_trained}, predictions=${globalKPIs.predictions_run}`);

    return new Response(
      JSON.stringify({
        success: true,
        date_range: { from: dateFrom, to: dateTo },
        global_kpis: globalKPIs,
        health_metrics: healthMetrics,
        organization_usage: orgUsage,
        daily_trend: dailyTrend,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const error = err as Error;
    console.error("[analytics-data] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
