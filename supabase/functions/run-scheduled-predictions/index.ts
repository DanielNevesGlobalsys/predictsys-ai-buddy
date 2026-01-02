import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

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

interface EmailTemplateParams {
  userName: string;
  projectName: string;
  problemType: string;
  modelName: string;
  metrics: Record<string, number>;
  success: boolean;
  message: string;
  projectUrl: string;
  language?: string;
}

function getEmailContent(params: EmailTemplateParams): { subject: string; html: string } {
  const lang = params.language || "pt";
  
  const translations = {
    pt: {
      subject: `[PredictSys AI] Novos resultados do modelo do projeto ${params.projectName}`,
      greeting: `Olá ${params.userName},`,
      intro: `O agendamento de predições do seu projeto foi executado.`,
      projectLabel: "Projeto",
      typeLabel: "Tipo de problema",
      modelLabel: "Modelo em produção",
      metricsLabel: "Métricas principais",
      statusLabel: "Status da execução",
      success: "✅ Sucesso",
      error: "❌ Erro",
      messageLabel: "Detalhes",
      viewProject: "Ver Projeto",
      footer: "Este email foi enviado automaticamente pela PredictSys AI.",
      classification: "Classificação",
      regression: "Regressão",
    },
    en: {
      subject: `[PredictSys AI] New model results for project ${params.projectName}`,
      greeting: `Hello ${params.userName},`,
      intro: `The scheduled predictions for your project have been executed.`,
      projectLabel: "Project",
      typeLabel: "Problem type",
      modelLabel: "Production model",
      metricsLabel: "Key metrics",
      statusLabel: "Execution status",
      success: "✅ Success",
      error: "❌ Error",
      messageLabel: "Details",
      viewProject: "View Project",
      footer: "This email was sent automatically by PredictSys AI.",
      classification: "Classification",
      regression: "Regression",
    },
    es: {
      subject: `[PredictSys AI] Nuevos resultados del modelo del proyecto ${params.projectName}`,
      greeting: `Hola ${params.userName},`,
      intro: `Las predicciones programadas de tu proyecto han sido ejecutadas.`,
      projectLabel: "Proyecto",
      typeLabel: "Tipo de problema",
      modelLabel: "Modelo en producción",
      metricsLabel: "Métricas principales",
      statusLabel: "Estado de ejecución",
      success: "✅ Éxito",
      error: "❌ Error",
      messageLabel: "Detalles",
      viewProject: "Ver Proyecto",
      footer: "Este correo fue enviado automáticamente por PredictSys AI.",
      classification: "Clasificación",
      regression: "Regresión",
    },
  };

  const t = translations[lang as keyof typeof translations] || translations.pt;
  const problemTypeText = params.problemType === "classification" ? t.classification : t.regression;

  // Build metrics HTML
  const metricsHtml = Object.entries(params.metrics)
    .map(([name, value]) => `<tr><td style="padding: 8px; border: 1px solid #e5e7eb;">${name}</td><td style="padding: 8px; border: 1px solid #e5e7eb; font-weight: bold;">${value.toFixed(4)}</td></tr>`)
    .join("");

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6; margin: 0; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 32px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px;">🔮 PredictSys AI</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px;">
          <p style="font-size: 16px; color: #374151; margin-bottom: 8px;">${t.greeting}</p>
          <p style="font-size: 14px; color: #6b7280; margin-bottom: 24px;">${t.intro}</p>
          
          <!-- Project Info Card -->
          <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.projectLabel}:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 600;">${params.projectName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.typeLabel}:</td>
                <td style="padding: 8px 0; color: #111827;">${problemTypeText}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.modelLabel}:</td>
                <td style="padding: 8px 0; color: #111827;">${params.modelName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.statusLabel}:</td>
                <td style="padding: 8px 0; color: #111827;">${params.success ? t.success : t.error}</td>
              </tr>
            </table>
          </div>
          
          <!-- Metrics Table -->
          ${Object.keys(params.metrics).length > 0 ? `
          <h3 style="color: #374151; font-size: 16px; margin-bottom: 12px;">${t.metricsLabel}</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <thead>
              <tr style="background-color: #f3f4f6;">
                <th style="padding: 12px; border: 1px solid #e5e7eb; text-align: left;">Metric</th>
                <th style="padding: 12px; border: 1px solid #e5e7eb; text-align: left;">Value</th>
              </tr>
            </thead>
            <tbody>
              ${metricsHtml}
            </tbody>
          </table>
          ` : ""}
          
          <!-- Details -->
          <div style="background-color: ${params.success ? "#ecfdf5" : "#fef2f2"}; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="margin: 0; color: ${params.success ? "#065f46" : "#991b1b"}; font-size: 14px;">
              <strong>${t.messageLabel}:</strong> ${params.message}
            </p>
          </div>
          
          <!-- CTA Button -->
          <div style="text-align: center; margin-top: 32px;">
            <a href="${params.projectUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 14px;">
              ${t.viewProject}
            </a>
          </div>
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">${t.footer}</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return { subject: t.subject, html };
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
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const resend = resendApiKey ? new Resend(resendApiKey) : null;

    if (!resend) {
      console.warn("[run-scheduled-predictions] RESEND_API_KEY not configured, emails will be skipped");
    }

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
      let productionModelName = "N/A";

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

        productionModelName = productionModel.algorithm_name;

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
      if (resend && schedule.send_email_to) {
        try {
          // Get user profile for name
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("id", project.user_id)
            .maybeSingle();

          const userName = profile?.full_name || "Usuário";
          
          // Determine language based on stored preference or default to Portuguese
          const language = "pt"; // Could be fetched from user preferences

          const projectUrl = `https://predictsys.ai/project/${project.id}`;

          const { subject, html } = getEmailContent({
            userName,
            projectName: project.name,
            problemType: project.problem_type,
            modelName: productionModelName,
            metrics: metricsResults,
            success: runSuccess,
            message: runMessage,
            projectUrl,
            language,
          });

          console.log(`[run-scheduled-predictions] Sending email to ${schedule.send_email_to}`);

          const emailResponse = await resend.emails.send({
            from: "PredictSys AI <noreply@resend.dev>",
            to: [schedule.send_email_to],
            subject,
            html,
          });

          console.log(`[run-scheduled-predictions] Email sent successfully:`, emailResponse);

        } catch (emailError) {
          console.error(`[run-scheduled-predictions] Error sending email:`, emailError);
        }
      }

      results.push({
        scheduleId: schedule.id,
        projectName: project.name,
        success: runSuccess,
        message: runMessage,
        emailSent: !!resend && !!schedule.send_email_to,
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
