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

const ALLOWED_EVENT_TYPES: EventType[] = [
  "project_created",
  "dataset_connected",
  "dataset_uploaded",
  "dataset_profiled",
  "model_trained",
  "prediction_run",
  "segment_exported",
  "dashboard_viewed",
  "api_called",
  "job_error",
];

interface TrackEventPayload {
  event_type: string; // Accept any string, will be mapped if invalid
  organization_id?: string | null;
  project_id?: string | null;
  status?: "success" | "error";
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  source?: "app" | "edge" | "cron" | "api";
}

/**
 * Track platform events for analytics.
 * Unknown event_type values are mapped to 'api_called' with original_event_type in metadata.
 */
export async function trackEvent(payload: TrackEventPayload): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.debug("[platformTracking] No session, skipping event tracking");
      return;
    }

    let organizationId = payload.organization_id || null;

    if (!organizationId && payload.project_id) {
      try {
        const { data: project } = await supabase
          .from("projects")
          .select("organization_id")
          .eq("id", payload.project_id)
          .maybeSingle();
        
        if (project?.organization_id) {
          organizationId = project.organization_id;
        }
      } catch (e) {
        console.debug("[platformTracking] Could not resolve org_id from project:", e);
      }
    }

    // Map unknown event types client-side as well
    let eventType: EventType = "api_called";
    let metadata = payload.metadata || {};

    if (ALLOWED_EVENT_TYPES.includes(payload.event_type as EventType)) {
      eventType = payload.event_type as EventType;
    } else {
      eventType = "api_called";
      metadata = { ...metadata, original_event_type: payload.event_type };
    }

    const response = await supabase.functions.invoke("track-event", {
      body: {
        event_type: eventType,
        organization_id: organizationId,
        project_id: payload.project_id || null,
        status: payload.status || "success",
        duration_ms: payload.duration_ms || null,
        metadata,
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
 */
export async function trackEventWithTiming(
  payload: Omit<TrackEventPayload, "duration_ms">,
  startTime: number
): Promise<void> {
  const duration_ms = Date.now() - startTime;
  await trackEvent({ ...payload, duration_ms });
}
