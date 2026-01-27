import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    console.log("Starting data retention enforcement...");

    // Get all organization data policies
    const { data: policies, error: policiesError } = await supabase
      .from("organization_data_policy")
      .select(`
        id,
        organization_id,
        data_retention_months,
        log_retention_months,
        organizations!inner(name)
      `);

    if (policiesError) {
      console.error("Error fetching policies:", policiesError);
      throw policiesError;
    }

    const results: Array<{
      organization_id: string;
      org_name: string;
      datasets_deleted: number;
      logs_deleted: number;
    }> = [];

    for (const policy of policies || []) {
      const orgId = policy.organization_id;
      const orgName = (policy.organizations as any)?.name || "Unknown";
      
      console.log(`Processing org: ${orgName} (${orgId})`);

      let datasetsDeleted = 0;
      let logsDeleted = 0;

      // Calculate cutoff dates
      const dataRetentionDate = new Date();
      dataRetentionDate.setMonth(dataRetentionDate.getMonth() - policy.data_retention_months);
      
      const logRetentionDate = new Date();
      logRetentionDate.setMonth(logRetentionDate.getMonth() - policy.log_retention_months);

      // 1. Delete old datasets for projects in this organization
      const { data: orgProjects } = await supabase
        .from("projects")
        .select("id")
        .eq("organization_id", orgId);

      if (orgProjects && orgProjects.length > 0) {
        const projectIds = orgProjects.map(p => p.id);

        // Delete old project_datasets
        const { data: deletedDatasets, error: datasetsError } = await supabase
          .from("project_datasets")
          .delete()
          .in("project_id", projectIds)
          .lt("created_at", dataRetentionDate.toISOString())
          .select("id");

        if (datasetsError) {
          console.error(`Error deleting datasets for org ${orgId}:`, datasetsError);
        } else {
          datasetsDeleted = deletedDatasets?.length || 0;
        }
      }

      // 2. Delete old audit logs for this organization
      const { data: deletedLogs, error: logsError } = await supabase
        .from("audit_logs")
        .delete()
        .eq("organization_id", orgId)
        .lt("timestamp", logRetentionDate.toISOString())
        .select("id");

      if (logsError) {
        console.error(`Error deleting logs for org ${orgId}:`, logsError);
      } else {
        logsDeleted = deletedLogs?.length || 0;
      }

      // 3. Create audit log entry for the cleanup
      if (datasetsDeleted > 0 || logsDeleted > 0) {
        await supabase.from("audit_logs").insert({
          organization_id: orgId,
          user_id: null, // System action
          action: "data_retention_cleanup",
          resource_type: "system",
          metadata: {
            datasets_deleted: datasetsDeleted,
            logs_deleted: logsDeleted,
            data_retention_months: policy.data_retention_months,
            log_retention_months: policy.log_retention_months,
            execution_date: new Date().toISOString(),
          },
        });

        console.log(`Org ${orgName}: deleted ${datasetsDeleted} datasets, ${logsDeleted} logs`);
      }

      results.push({
        organization_id: orgId,
        org_name: orgName,
        datasets_deleted: datasetsDeleted,
        logs_deleted: logsDeleted,
      });
    }

    console.log("Data retention enforcement completed");

    return new Response(
      JSON.stringify({
        success: true,
        processed_organizations: results.length,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Data retention enforcement error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: "Internal server error", details: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
