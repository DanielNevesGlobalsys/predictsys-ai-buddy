import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PlatformEvent {
  event_type: string;
  project_id: string | null;
  organization_id: string | null;
  timestamp: string;
}

interface ProjectMilestones {
  project_id: string;
  org_id: string | null;
  org_name: string;
  project_created_at: string | null;
  first_dataset_at: string | null;
  first_training_at: string | null;
  first_prediction_at: string | null;
  first_export_at: string | null;
}

interface TimeToValueByOrg {
  organization_id: string;
  organization_name: string;
  avg_project_to_dataset_hours: number | null;
  avg_dataset_to_training_hours: number | null;
  avg_training_to_prediction_hours: number | null;
  avg_prediction_to_export_hours: number | null;
  avg_total_time_to_value_hours: number | null;
  projects_with_dataset_pct: number;
  projects_with_training_pct: number;
  projects_with_prediction_pct: number;
  projects_with_export_pct: number;
  total_projects: number;
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

    // Check if user is super_admin
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
    let dateFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let dateTo = new Date().toISOString();
    let orgId: string | null = null;

    try {
      const body = await req.json();
      if (body.date_from) dateFrom = body.date_from;
      if (body.date_to) dateTo = body.date_to;
      if (body.organization_id) orgId = body.organization_id;
    } catch {
      // If no body or invalid JSON, use defaults
    }

    console.log(`[analytics-time-to-value] Calculating TTV from ${dateFrom} to ${dateTo}`);

    // Fetch organizations
    const { data: organizations } = await supabase
      .from("organizations")
      .select("id, name");
    
    const orgMap = new Map<string, string>();
    for (const org of organizations || []) {
      orgMap.set(org.id, org.name);
    }

    // Fetch projects with their org_id
    const { data: projectsData } = await supabase
      .from("projects")
      .select("id, organization_id, created_at");
    
    const projectOrgMap = new Map<string, string | null>();
    const projectCreatedMap = new Map<string, string>();
    for (const p of projectsData || []) {
      projectOrgMap.set(p.id, p.organization_id);
      projectCreatedMap.set(p.id, p.created_at);
    }

    // Fetch all events
    const { data: eventsData, error: eventsError } = await supabase
      .from("platform_events")
      .select("event_type, project_id, organization_id, timestamp")
      .gte("timestamp", dateFrom)
      .lte("timestamp", dateTo)
      .not("project_id", "is", null)
      .order("timestamp", { ascending: true });

    if (eventsError) {
      console.error("[analytics-time-to-value] Error fetching events:", eventsError);
      throw eventsError;
    }

    const events = (eventsData || []) as PlatformEvent[];
    console.log(`[analytics-time-to-value] Found ${events.length} events with project_id`);

    // Build project milestones
    const milestonesMap = new Map<string, ProjectMilestones>();

    for (const e of events) {
      if (!e.project_id) continue;

      const resolvedOrgId = e.organization_id || projectOrgMap.get(e.project_id) || null;
      const orgName = resolvedOrgId ? (orgMap.get(resolvedOrgId) || "Unknown") : "Unknown";

      if (!milestonesMap.has(e.project_id)) {
        milestonesMap.set(e.project_id, {
          project_id: e.project_id,
          org_id: resolvedOrgId,
          org_name: orgName,
          project_created_at: projectCreatedMap.get(e.project_id) || null,
          first_dataset_at: null,
          first_training_at: null,
          first_prediction_at: null,
          first_export_at: null,
        });
      }

      const pm = milestonesMap.get(e.project_id)!;

      if (e.event_type === "project_created" && !pm.project_created_at) {
        pm.project_created_at = e.timestamp;
      }
      if ((e.event_type === "dataset_connected" || e.event_type === "dataset_uploaded") && !pm.first_dataset_at) {
        pm.first_dataset_at = e.timestamp;
      }
      if (e.event_type === "model_trained" && !pm.first_training_at) {
        pm.first_training_at = e.timestamp;
      }
      if (e.event_type === "prediction_run" && !pm.first_prediction_at) {
        pm.first_prediction_at = e.timestamp;
      }
      if (e.event_type === "segment_exported" && !pm.first_export_at) {
        pm.first_export_at = e.timestamp;
      }
    }

    const milestones = Array.from(milestonesMap.values());

    // Calculate TTV by organization
    const orgStats = new Map<string, {
      org_name: string;
      projects: ProjectMilestones[];
    }>();

    for (const pm of milestones) {
      const key = pm.org_id || "unknown";
      if (!orgStats.has(key)) {
        orgStats.set(key, { org_name: pm.org_name, projects: [] });
      }
      orgStats.get(key)!.projects.push(pm);
    }

    const byOrganization: TimeToValueByOrg[] = [];

    for (const [orgId, stats] of orgStats.entries()) {
      if (orgId === "unknown") continue;

      const projects = stats.projects;
      const total = projects.length;

      // Calculate averages
      const p2dHours: number[] = [];
      const d2tHours: number[] = [];
      const t2pHours: number[] = [];
      const p2eHours: number[] = [];
      const totalHours: number[] = [];

      let withDataset = 0;
      let withTraining = 0;
      let withPrediction = 0;
      let withExport = 0;

      for (const pm of projects) {
        if (pm.first_dataset_at) withDataset++;
        if (pm.first_training_at) withTraining++;
        if (pm.first_prediction_at) withPrediction++;
        if (pm.first_export_at) withExport++;

        if (pm.project_created_at && pm.first_dataset_at) {
          const hours = (new Date(pm.first_dataset_at).getTime() - new Date(pm.project_created_at).getTime()) / (1000 * 60 * 60);
          if (hours >= 0) p2dHours.push(hours);
        }
        if (pm.first_dataset_at && pm.first_training_at) {
          const hours = (new Date(pm.first_training_at).getTime() - new Date(pm.first_dataset_at).getTime()) / (1000 * 60 * 60);
          if (hours >= 0) d2tHours.push(hours);
        }
        if (pm.first_training_at && pm.first_prediction_at) {
          const hours = (new Date(pm.first_prediction_at).getTime() - new Date(pm.first_training_at).getTime()) / (1000 * 60 * 60);
          if (hours >= 0) t2pHours.push(hours);
        }
        if (pm.first_prediction_at && pm.first_export_at) {
          const hours = (new Date(pm.first_export_at).getTime() - new Date(pm.first_prediction_at).getTime()) / (1000 * 60 * 60);
          if (hours >= 0) p2eHours.push(hours);
        }
        if (pm.project_created_at && pm.first_export_at) {
          const hours = (new Date(pm.first_export_at).getTime() - new Date(pm.project_created_at).getTime()) / (1000 * 60 * 60);
          if (hours >= 0) totalHours.push(hours);
        }
      }

      const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100 : null;

      byOrganization.push({
        organization_id: orgId,
        organization_name: stats.org_name,
        avg_project_to_dataset_hours: avg(p2dHours),
        avg_dataset_to_training_hours: avg(d2tHours),
        avg_training_to_prediction_hours: avg(t2pHours),
        avg_prediction_to_export_hours: avg(p2eHours),
        avg_total_time_to_value_hours: avg(totalHours),
        projects_with_dataset_pct: total > 0 ? Math.round(withDataset / total * 1000) / 10 : 0,
        projects_with_training_pct: total > 0 ? Math.round(withTraining / total * 1000) / 10 : 0,
        projects_with_prediction_pct: total > 0 ? Math.round(withPrediction / total * 1000) / 10 : 0,
        projects_with_export_pct: total > 0 ? Math.round(withExport / total * 1000) / 10 : 0,
        total_projects: total,
      });
    }

    // Calculate global averages
    const allProjects = milestones;
    const totalProjects = allProjects.length;

    const allP2d: number[] = [];
    const allD2t: number[] = [];
    const allT2p: number[] = [];
    const allP2e: number[] = [];
    const allTotal: number[] = [];

    let globalWithDataset = 0;
    let globalWithTraining = 0;
    let globalWithPrediction = 0;
    let globalWithExport = 0;

    for (const pm of allProjects) {
      if (pm.first_dataset_at) globalWithDataset++;
      if (pm.first_training_at) globalWithTraining++;
      if (pm.first_prediction_at) globalWithPrediction++;
      if (pm.first_export_at) globalWithExport++;

      if (pm.project_created_at && pm.first_dataset_at) {
        const hours = (new Date(pm.first_dataset_at).getTime() - new Date(pm.project_created_at).getTime()) / (1000 * 60 * 60);
        if (hours >= 0) allP2d.push(hours);
      }
      if (pm.first_dataset_at && pm.first_training_at) {
        const hours = (new Date(pm.first_training_at).getTime() - new Date(pm.first_dataset_at).getTime()) / (1000 * 60 * 60);
        if (hours >= 0) allD2t.push(hours);
      }
      if (pm.first_training_at && pm.first_prediction_at) {
        const hours = (new Date(pm.first_prediction_at).getTime() - new Date(pm.first_training_at).getTime()) / (1000 * 60 * 60);
        if (hours >= 0) allT2p.push(hours);
      }
      if (pm.first_prediction_at && pm.first_export_at) {
        const hours = (new Date(pm.first_export_at).getTime() - new Date(pm.first_prediction_at).getTime()) / (1000 * 60 * 60);
        if (hours >= 0) allP2e.push(hours);
      }
      if (pm.project_created_at && pm.first_export_at) {
        const hours = (new Date(pm.first_export_at).getTime() - new Date(pm.project_created_at).getTime()) / (1000 * 60 * 60);
        if (hours >= 0) allTotal.push(hours);
      }
    }

    const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100 : 0;

    const globalAverages = {
      avg_project_to_dataset_hours: avg(allP2d),
      avg_dataset_to_training_hours: avg(allD2t),
      avg_training_to_prediction_hours: avg(allT2p),
      avg_prediction_to_export_hours: avg(allP2e),
      avg_total_time_to_value_hours: avg(allTotal),
      projects_with_dataset_pct: totalProjects > 0 ? Math.round(globalWithDataset / totalProjects * 1000) / 10 : 0,
      projects_with_training_pct: totalProjects > 0 ? Math.round(globalWithTraining / totalProjects * 1000) / 10 : 0,
      projects_with_prediction_pct: totalProjects > 0 ? Math.round(globalWithPrediction / totalProjects * 1000) / 10 : 0,
      projects_with_export_pct: totalProjects > 0 ? Math.round(globalWithExport / totalProjects * 1000) / 10 : 0,
      total_projects: totalProjects,
    };

    console.log(`[analytics-time-to-value] Calculated TTV for ${totalProjects} projects, ${byOrganization.length} orgs`);

    return new Response(
      JSON.stringify({
        success: true,
        date_range: { from: dateFrom, to: dateTo },
        global_averages: globalAverages,
        by_organization: byOrganization,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const error = err as Error;
    console.error("[analytics-time-to-value] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
