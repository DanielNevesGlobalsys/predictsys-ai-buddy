import { supabase } from "@/integrations/supabase/client";

export type EventType =
  | "project_created"
  | "dataset_connected"
  | "dataset_uploaded"
  | "dataset_profiled"
  | "model_trained"
  | "prediction_run"
  | "segment_exported"
  | "dashboard_viewed"
  | "api_called"
  | "job_error";

interface TrackEventPayload {
  event_type: EventType;
  organization_id?: string | null;
  project_id?: string | null;
  status?: "success" | "error";
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  source?: "app" | "edge" | "cron" | "api";
}

/**
 * Track platform events for analytics
 * Events are sent to the backend and stored for admin analytics
 */
export async function trackEvent(payload: TrackEventPayload): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.debug("[platformTracking] No session, skipping event tracking");
      return;
    }

    const response = await supabase.functions.invoke("track-event", {
      body: {
        event_type: payload.event_type,
        organization_id: payload.organization_id || null,
        project_id: payload.project_id || null,
        status: payload.status || "success",
        duration_ms: payload.duration_ms || null,
        metadata: payload.metadata || {},
        source: payload.source || "app",
      },
    });

    if (response.error) {
      console.error("[platformTracking] Error tracking event:", response.error);
    }
  } catch (error) {
    // Silent fail - tracking should not break the app
    console.error("[platformTracking] Error:", error);
  }
}

/**
 * Track event with timing
 * Automatically calculates duration_ms from start time
 */
export async function trackEventWithTiming(
  payload: Omit<TrackEventPayload, "duration_ms">,
  startTime: number
): Promise<void> {
  const duration_ms = Date.now() - startTime;
  await trackEvent({ ...payload, duration_ms });
}
