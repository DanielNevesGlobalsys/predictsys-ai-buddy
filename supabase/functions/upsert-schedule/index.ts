import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const {
      project_id, is_enabled, schedule_type, interval_hours,
      timezone, hour, minute, day_of_week, day_of_month,
      mode, pause_on_blocked,
    } = body;

    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate ranges
    if (hour < 0 || hour > 23) throw new Error("hour must be 0-23");
    if (minute < 0 || minute > 59) throw new Error("minute must be 0-59");
    if (schedule_type === "interval_hours" && (interval_hours < 1 || interval_hours > 24)) {
      throw new Error("interval_hours must be 1-24");
    }

    // Compute next_run_at
    const now = new Date();
    let next_run_at: string | null = null;

    if (is_enabled) {
      const next = new Date();
      next.setUTCHours(hour, minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);

      switch (schedule_type) {
        case "weekly":
          while (next.getDay() !== (day_of_week ?? 1)) next.setDate(next.getDate() + 1);
          break;
        case "monthly":
          next.setDate(day_of_month ?? 1);
          if (next <= now) next.setMonth(next.getMonth() + 1);
          break;
        case "interval_hours":
          const ih = interval_hours ?? 6;
          next.setTime(now.getTime() + ih * 60 * 60 * 1000);
          break;
      }
      next_run_at = next.toISOString();
    }

    const payload = {
      project_id,
      is_enabled: is_enabled ?? false,
      schedule_type: schedule_type ?? "daily",
      interval_hours: schedule_type === "interval_hours" ? interval_hours : null,
      timezone: timezone ?? "America/Sao_Paulo",
      hour: hour ?? 8,
      minute: minute ?? 0,
      day_of_week: schedule_type === "weekly" ? day_of_week : null,
      day_of_month: schedule_type === "monthly" ? day_of_month : null,
      mode: mode ?? "full",
      pause_on_blocked: pause_on_blocked ?? true,
      next_run_at,
    };

    const { error } = await supabase
      .from("project_schedules")
      .upsert(payload, { onConflict: "project_id" });

    if (error) throw error;

    // Audit log
    try {
      const { data: project } = await supabase
        .from("projects")
        .select("organization_id")
        .eq("id", project_id)
        .maybeSingle();

      if (project?.organization_id) {
        await supabase.from("audit_logs").insert({
          action: "schedule_updated",
          resource_type: "schedule",
          project_id,
          organization_id: project.organization_id,
          metadata: { schedule_type, is_enabled, mode },
        });
      }
    } catch (e) {
      console.warn("[upsert-schedule] Audit log failed:", e);
    }

    return new Response(JSON.stringify({ success: true, next_run_at }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[upsert-schedule] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
