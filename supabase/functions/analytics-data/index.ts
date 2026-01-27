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

interface MetricRow {
  day: string;
  organization_id: string | null;
  projects_created: number;
  datasets_connected: number;
  models_trained: number;
  predictions_run: number;
  segments_exported: number;
  jobs_error_count: number;
  avg_import_ms: number;
  avg_eda_ms: number;
  avg_train_ms: number;
  avg_predict_ms: number;
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

    // Fetch daily metrics
    let metricsQuery = supabase
      .from("platform_metrics_daily")
      .select("*")
      .gte("day", dateFrom)
      .lte("day", dateTo)
      .order("day", { ascending: false });

    if (orgId) {
      metricsQuery = metricsQuery.eq("organization_id", orgId);
    }

    const { data: metrics, error: metricsError } = await metricsQuery;

    if (metricsError) {
      console.error("[analytics-data] Error fetching metrics:", metricsError);
      throw metricsError;
    }

    const metricsTyped = (metrics || []) as MetricRow[];

    // Fetch organizations with stats
    const { data: organizations, error: orgsError } = await supabase
      .from("organizations")
      .select("id, name, plan, created_at");

    if (orgsError) {
      console.error("[analytics-data] Error fetching organizations:", orgsError);
      throw orgsError;
    }

    // Fetch per-org usage summary
    const orgUsage: OrgUsage[] = [];
    for (const org of organizations || []) {
      // Get metrics for this org
      const orgMetrics = metricsTyped.filter((m) => m.organization_id === org.id);
      
      // Sum up totals
      const totals = orgMetrics.reduce((acc, m) => ({
        projects_created: acc.projects_created + (m.projects_created || 0),
        datasets_connected: acc.datasets_connected + (m.datasets_connected || 0),
        models_trained: acc.models_trained + (m.models_trained || 0),
        predictions_run: acc.predictions_run + (m.predictions_run || 0),
        segments_exported: acc.segments_exported + (m.segments_exported || 0),
        jobs_error_count: acc.jobs_error_count + (m.jobs_error_count || 0),
      }), {
        projects_created: 0,
        datasets_connected: 0,
        models_trained: 0,
        predictions_run: 0,
        segments_exported: 0,
        jobs_error_count: 0,
      });

      // Get last event timestamp
      const { data: lastEvent } = await supabase
        .from("platform_events")
        .select("timestamp")
        .eq("organization_id", org.id)
        .order("timestamp", { ascending: false })
        .limit(1);

      // Get active users count (distinct users in period)
      const { data: activeUsersData } = await supabase
        .from("platform_events")
        .select("user_id")
        .eq("organization_id", org.id)
        .gte("timestamp", `${dateFrom}T00:00:00.000Z`)
        .lte("timestamp", `${dateTo}T23:59:59.999Z`);

      const activeUsers = new Set((activeUsersData || []).map((e: { user_id: string }) => e.user_id)).size;

      // Get user count
      const { count: userCount } = await supabase
        .from("organization_users")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);

      orgUsage.push({
        organization_id: org.id,
        organization_name: org.name,
        plan: org.plan,
        ...totals,
        active_users: activeUsers,
        total_users: userCount || 0,
        last_event_at: (lastEvent as { timestamp: string }[] | null)?.[0]?.timestamp || null,
      });
    }

    // Calculate global KPIs
    const globalMetrics = metricsTyped.filter((m) => m.organization_id === null);
    const globalTotals = globalMetrics.reduce((acc, m) => ({
      projects_created: acc.projects_created + (m.projects_created || 0),
      datasets_connected: acc.datasets_connected + (m.datasets_connected || 0),
      models_trained: acc.models_trained + (m.models_trained || 0),
      predictions_run: acc.predictions_run + (m.predictions_run || 0),
      segments_exported: acc.segments_exported + (m.segments_exported || 0),
      jobs_error_count: acc.jobs_error_count + (m.jobs_error_count || 0),
    }), {
      projects_created: 0,
      datasets_connected: 0,
      models_trained: 0,
      predictions_run: 0,
      segments_exported: 0,
      jobs_error_count: 0,
    });

    // Calculate health metrics (averages)
    const nonZeroMetrics = globalMetrics.filter(m => 
      m.avg_import_ms > 0 || m.avg_eda_ms > 0 || m.avg_train_ms > 0 || m.avg_predict_ms > 0
    );
    const healthMetrics = nonZeroMetrics.length > 0 
      ? {
          avg_import_ms: Math.round(nonZeroMetrics.reduce((sum, m) => sum + (m.avg_import_ms || 0), 0) / nonZeroMetrics.length),
          avg_eda_ms: Math.round(nonZeroMetrics.reduce((sum, m) => sum + (m.avg_eda_ms || 0), 0) / nonZeroMetrics.length),
          avg_train_ms: Math.round(nonZeroMetrics.reduce((sum, m) => sum + (m.avg_train_ms || 0), 0) / nonZeroMetrics.length),
          avg_predict_ms: Math.round(nonZeroMetrics.reduce((sum, m) => sum + (m.avg_predict_ms || 0), 0) / nonZeroMetrics.length),
        }
      : { avg_import_ms: 0, avg_eda_ms: 0, avg_train_ms: 0, avg_predict_ms: 0 };

    // Daily trend data
    const dailyTrend = globalMetrics.map((m) => ({
      day: m.day,
      models_trained: m.models_trained || 0,
      predictions_run: m.predictions_run || 0,
      jobs_error_count: m.jobs_error_count || 0,
    })).sort((a, b) => a.day.localeCompare(b.day));

    return new Response(
      JSON.stringify({
        success: true,
        date_range: { from: dateFrom, to: dateTo },
        global_kpis: {
          ...globalTotals,
          active_organizations: orgUsage.filter((o) => o.last_event_at).length,
          total_organizations: organizations?.length || 0,
        },
        health_metrics: {
          ...healthMetrics,
          total_errors: globalTotals.jobs_error_count,
        },
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
