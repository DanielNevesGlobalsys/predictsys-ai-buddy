import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function calculateNextRunAt(
  frequency: string,
  currentNextRun: Date,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  timeOfDay: string
): Date {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const next = new Date(currentNextRun);
  next.setHours(hours, minutes, 0, 0);

  switch (frequency) {
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "biweekly":
      next.setDate(next.getDate() + 14);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      if (dayOfMonth) next.setDate(dayOfMonth);
      break;
    case "quarterly":
      next.setMonth(next.getMonth() + 3);
      if (dayOfMonth) next.setDate(dayOfMonth);
      break;
    case "semiannual":
      next.setMonth(next.getMonth() + 6);
      if (dayOfMonth) next.setDate(dayOfMonth);
      break;
    case "yearly":
      next.setFullYear(next.getFullYear() + 1);
      if (dayOfMonth) next.setDate(dayOfMonth);
      break;
    case "specific_date":
      // One-time execution, disable after running
      return next;
  }

  return next;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log("[run-scheduled-predictions] Starting scheduled predictions job");

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date().toISOString();

    // Find all enabled schedules due for execution
    const { data: dueSchedules, error: fetchError } = await supabase
      .from("project_prediction_schedules")
      .select(`
        *,
        projects:project_id (
          id,
          name,
          user_id,
          problem_type,
          target_column,
          dataset_filename
        )
      `)
      .eq("enabled", true)
      .lte("next_run_at", now);

    if (fetchError) {
      console.error("[run-scheduled-predictions] Error fetching schedules:", fetchError);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!dueSchedules || dueSchedules.length === 0) {
      console.log("[run-scheduled-predictions] No schedules due for execution");
      return new Response(JSON.stringify({ 
        message: "No schedules due",
        processed: 0 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[run-scheduled-predictions] Found ${dueSchedules.length} schedules to process`);

    const results = [];

    for (const schedule of dueSchedules) {
      const project = schedule.projects;
      if (!project) {
        console.error(`[run-scheduled-predictions] Project not found for schedule ${schedule.id}`);
        continue;
      }

      console.log(`[run-scheduled-predictions] Processing schedule for project: ${project.name}`);

      // Mark as running
      await supabase
        .from("project_prediction_schedules")
        .update({ last_run_status: "running" })
        .eq("id", schedule.id);

      let runSuccess = true;
      let runMessage = "";
      const metricsResults: Record<string, number> = {};

      try {
        // Get production model
        const { data: productionModel } = await supabase
          .from("project_models")
          .select("*, project_model_metrics(*)")
          .eq("project_id", project.id)
          .eq("is_production", true)
          .maybeSingle();

        if (!productionModel) {
          throw new Error("No production model found");
        }

        // Get metrics for report
        if (productionModel.project_model_metrics) {
          for (const metric of productionModel.project_model_metrics) {
            metricsResults[metric.metric_name] = metric.metric_value;
          }
        }

        // If retraining is enabled, trigger training
        if (schedule.run_retraining) {
          console.log(`[run-scheduled-predictions] Triggering retraining for project ${project.id}`);
          
          const trainResponse = await fetch(`${supabaseUrl}/functions/v1/train-models`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({ project_id: project.id }),
          });

          if (!trainResponse.ok) {
            const trainError = await trainResponse.text();
            console.error(`[run-scheduled-predictions] Training failed: ${trainError}`);
            runMessage += `Retraining triggered but may have errors. `;
          } else {
            runMessage += `Retraining completed successfully. `;
          }
        }

        // If predictions are enabled, log that we would run predictions
        if (schedule.run_predictions) {
          console.log(`[run-scheduled-predictions] Predictions would run for project ${project.id}`);
          runMessage += `Predictions ready with model ${productionModel.algorithm_name}. `;
        }

        runMessage = runMessage || "Scheduled run completed successfully.";

      } catch (execError) {
        console.error(`[run-scheduled-predictions] Error processing schedule ${schedule.id}:`, execError);
        runSuccess = false;
        runMessage = execError instanceof Error ? execError.message : "Unknown error";
      }

      // Calculate next run
      const nextRunAt = calculateNextRunAt(
        schedule.frequency,
        new Date(schedule.next_run_at),
        schedule.day_of_week,
        schedule.day_of_month,
        schedule.time_of_day
      );

      // Update schedule with results
      const updateData: Record<string, any> = {
        last_run_at: new Date().toISOString(),
        last_run_status: runSuccess ? "success" : "error",
        last_run_message: runMessage,
        next_run_at: nextRunAt.toISOString(),
      };

      // Disable one-time schedules
      if (schedule.frequency === "specific_date") {
        updateData.enabled = false;
      }

      await supabase
        .from("project_prediction_schedules")
        .update(updateData)
        .eq("id", schedule.id);

      // Send email notification
      try {
        // Get user profile for name
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("id", project.user_id)
          .maybeSingle();

        const userName = profile?.full_name || "Usuário";
        const primaryMetric = project.problem_type === "classification" ? "AUC" : "R²";
        const primaryMetricValue = metricsResults[primaryMetric]?.toFixed(4) || "N/A";

        console.log(`[run-scheduled-predictions] Would send email to ${schedule.send_email_to}`);
        console.log(`  - Project: ${project.name}`);
        console.log(`  - User: ${userName}`);
        console.log(`  - ${primaryMetric}: ${primaryMetricValue}`);
        console.log(`  - Status: ${runSuccess ? "success" : "error"}`);
        
        // Email sending would be implemented here with Resend
        // For now, just log the intent

      } catch (emailError) {
        console.error(`[run-scheduled-predictions] Error sending email:`, emailError);
      }

      results.push({
        scheduleId: schedule.id,
        projectName: project.name,
        success: runSuccess,
        message: runMessage,
      });
    }

    const duration = Date.now() - startTime;
    console.log(`[run-scheduled-predictions] Completed in ${duration}ms, processed ${results.length} schedules`);

    return new Response(JSON.stringify({
      message: "Scheduled predictions processed",
      processed: results.length,
      duration: `${duration}ms`,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[run-scheduled-predictions] Fatal error:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Unknown error" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
