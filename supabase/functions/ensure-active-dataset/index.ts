import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ success: false, error: "project_id required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // 1. Check for existing active dataset
    const { data: activeDataset, error: fetchErr } = await supabase
      .from("project_datasets")
      .select("id, total_rows, columns_count, is_active")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr) {
      console.error("[ensure-active-dataset] fetch error:", fetchErr);
      return new Response(JSON.stringify({ success: false, error: "DB_FETCH_ERROR", message: fetchErr.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    if (activeDataset) {
      return new Response(JSON.stringify({
        success: true,
        dataset_id: activeDataset.id,
        total_rows: activeDataset.total_rows,
        columns_count: activeDataset.columns_count,
        created: false,
        reason: null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    // 2. No active dataset — try to repair from project data
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("user_id, dataset_filename, total_rows, dataset_rows, dataset_columns, status")
      .eq("id", project_id)
      .maybeSingle();

    if (projErr || !project) {
      return new Response(JSON.stringify({
        success: false, dataset_id: null, created: false,
        reason: "PROJECT_NOT_FOUND",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    const totalRows = project.total_rows || project.dataset_rows || 0;
    const colsCount = project.dataset_columns || 0;

    if (!project.dataset_filename || totalRows <= 0 || colsCount <= 0) {
      return new Response(JSON.stringify({
        success: false, dataset_id: null, created: false,
        reason: "NO_FALLBACK_DATA",
        message: "Nenhum dataset ativo e sem dados suficientes no projeto para reparo automático.",
        details: { dataset_filename: project.dataset_filename, total_rows: totalRows, columns_count: colsCount },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    // 3. Create repair dataset
    const userId = project.user_id || "00000000-0000-0000-0000-000000000000";
    const storagePath = `${userId}/${project_id}/${project.dataset_filename}`;

    const { data: inserted, error: insertErr } = await supabase
      .from("project_datasets")
      .insert({
        project_id,
        user_id: userId,
        name: project.dataset_filename,
        storage_path: storagePath,
        file_size_bytes: 0,
        total_rows: totalRows,
        sample_rows: Math.min(500, totalRows),
        columns_count: colsCount,
        is_active: true,
        source_type: "upload",
        source_metadata: { ingested_at: new Date().toISOString(), repaired: true },
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[ensure-active-dataset] insert error:", insertErr);
      return new Response(JSON.stringify({
        success: false, dataset_id: null, created: false,
        reason: "REPAIR_INSERT_FAILED",
        message: insertErr.message,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    // 4. Update project
    await supabase
      .from("projects")
      .update({
        dataset_ready_for_modeling: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", project_id);

    // 5. Log
    try {
      await supabase.from("platform_events").insert({
        project_id,
        event_type: "dataset_uploaded",
        status: "success",
        source: "edge",
        metadata: { action: "auto_repair", dataset_id: inserted.id, total_rows: totalRows, columns_count: colsCount },
      });
    } catch { /* non-blocking */ }

    console.log(`[ensure-active-dataset] Repaired dataset for project ${project_id}: ${inserted.id}`);

    return new Response(JSON.stringify({
      success: true,
      dataset_id: inserted.id,
      total_rows: totalRows,
      columns_count: colsCount,
      created: true,
      reason: null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });

  } catch (error) {
    console.error("[ensure-active-dataset] Error:", error);
    return new Response(JSON.stringify({
      success: false, error: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  }
});
