import { supabase } from "@/integrations/supabase/client";

/**
 * Fetches the latest_batch_id from project_prediction_state (SSOT).
 * Returns null if no batch has been promoted yet.
 */
export async function getLatestBatchId(projectId: string): Promise<string | null> {
  const { data } = await supabase
    .from("project_prediction_state")
    .select("latest_batch_id")
    .eq("project_id", projectId)
    .maybeSingle();
  return data?.latest_batch_id ?? null;
}
