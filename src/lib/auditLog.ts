import { supabase } from "@/integrations/supabase/client";

export type AuditAction =
  | "dataset_uploaded"
  | "dataset_deleted"
  | "model_trained"
  | "prediction_executed"
  | "segment_exported"
  | "project_created"
  | "project_deleted"
  | "retention_policy_updated"
  | "anonymization_enabled"
  | "anonymization_disabled"
  | "data_retention_cleanup"
  | "config_updated";

export type ResourceType =
  | "dataset"
  | "model"
  | "prediction"
  | "export"
  | "project"
  | "config"
  | "system";

interface AuditLogPayload {
  action: AuditAction;
  resource_type: ResourceType;
  resource_name?: string;
  project_id?: string;
  organization_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log an audit event for LGPD compliance
 * This function calls the audit-log edge function to record sensitive actions
 */
export async function logAuditEvent(payload: AuditLogPayload): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.debug("[auditLog] No session, skipping audit log");
      return;
    }

    const response = await supabase.functions.invoke("audit-log", {
      body: {
        action: payload.action,
        resource_type: payload.resource_type,
        resource_name: payload.resource_name || null,
        project_id: payload.project_id || null,
        organization_id: payload.organization_id || null,
        metadata: payload.metadata || {},
      },
    });

    if (response.error) {
      console.error("[auditLog] Error logging audit event:", response.error);
    } else {
      console.debug(`[auditLog] Event logged: ${payload.action}`);
    }
  } catch (error) {
    // Silent fail - audit logging should not break the app
    console.error("[auditLog] Error:", error);
  }
}

/**
 * Helper to log with project context
 */
export async function logProjectAuditEvent(
  projectId: string,
  action: AuditAction,
  resourceType: ResourceType,
  resourceName?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await logAuditEvent({
    action,
    resource_type: resourceType,
    resource_name: resourceName,
    project_id: projectId,
    metadata,
  });
}

/**
 * Helper to log organization-level events
 */
export async function logOrgAuditEvent(
  organizationId: string,
  action: AuditAction,
  resourceType: ResourceType,
  resourceName?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await logAuditEvent({
    action,
    resource_type: resourceType,
    resource_name: resourceName,
    organization_id: organizationId,
    metadata,
  });
}
