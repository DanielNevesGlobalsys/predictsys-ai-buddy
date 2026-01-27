import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface TimeToValueRow {
  organization_id: string;
  organization_name: string;
  avg_project_to_dataset_hours: number | null;
  avg_dataset_to_training_hours: number | null;
  avg_training_to_prediction_hours: number | null;
  avg_prediction_to_export_hours: number | null;
  avg_total_time_to_value_hours: number | null;
  projects_with_dataset_pct: number | null;
  projects_with_training_pct: number | null;
  projects_with_prediction_pct: number | null;
  projects_with_export_pct: number | null;
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

    // Parse query params
    const url = new URL(req.url);
    const dateFrom = url.searchParams.get("date_from") || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = url.searchParams.get("date_to") || new Date().toISOString();
    const orgId = url.searchParams.get("organization_id") || null;

    console.log(`[analytics-time-to-value] Calculating TTV from ${dateFrom} to ${dateTo}`);

    // Call the database function
    const { data: ttvData, error: ttvError } = await supabase.rpc("calculate_time_to_value", {
      p_organization_id: orgId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    });

    if (ttvError) {
      console.error("[analytics-time-to-value] Error:", ttvError);
      throw ttvError;
    }

    const ttvTyped = (ttvData || []) as TimeToValueRow[];

    // Calculate global averages
    const globalAvg = {
      avg_project_to_dataset_hours: 0,
      avg_dataset_to_training_hours: 0,
      avg_training_to_prediction_hours: 0,
      avg_prediction_to_export_hours: 0,
      avg_total_time_to_value_hours: 0,
      projects_with_dataset_pct: 0,
      projects_with_training_pct: 0,
      projects_with_prediction_pct: 0,
      projects_with_export_pct: 0,
      total_projects: 0,
    };

    if (ttvTyped.length > 0) {
      const validData = ttvTyped.filter((d) => d.total_projects > 0);
      if (validData.length > 0) {
        const totalProjects = validData.reduce((sum, d) => sum + d.total_projects, 0);
        
        globalAvg.avg_project_to_dataset_hours = validData.reduce((sum, d) => 
          sum + (d.avg_project_to_dataset_hours || 0) * d.total_projects, 0) / totalProjects;
        globalAvg.avg_dataset_to_training_hours = validData.reduce((sum, d) => 
          sum + (d.avg_dataset_to_training_hours || 0) * d.total_projects, 0) / totalProjects;
        globalAvg.avg_training_to_prediction_hours = validData.reduce((sum, d) => 
          sum + (d.avg_training_to_prediction_hours || 0) * d.total_projects, 0) / totalProjects;
        globalAvg.avg_prediction_to_export_hours = validData.reduce((sum, d) => 
          sum + (d.avg_prediction_to_export_hours || 0) * d.total_projects, 0) / totalProjects;
        globalAvg.avg_total_time_to_value_hours = validData.reduce((sum, d) => 
          sum + (d.avg_total_time_to_value_hours || 0) * d.total_projects, 0) / totalProjects;
        
        globalAvg.projects_with_dataset_pct = validData.reduce((sum, d) => 
          sum + (d.projects_with_dataset_pct || 0) * d.total_projects, 0) / totalProjects;
        globalAvg.projects_with_training_pct = validData.reduce((sum, d) => 
          sum + (d.projects_with_training_pct || 0) * d.total_projects, 0) / totalProjects;
        globalAvg.projects_with_prediction_pct = validData.reduce((sum, d) => 
          sum + (d.projects_with_prediction_pct || 0) * d.total_projects, 0) / totalProjects;
        globalAvg.projects_with_export_pct = validData.reduce((sum, d) => 
          sum + (d.projects_with_export_pct || 0) * d.total_projects, 0) / totalProjects;
        
        globalAvg.total_projects = totalProjects;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        date_range: { from: dateFrom, to: dateTo },
        global_averages: globalAvg,
        by_organization: ttvTyped,
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
