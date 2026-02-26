import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
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
    const sb = createClient(supabaseUrl, serviceKey);

    // 1. Project info
    const { data: project } = await sb
      .from("projects")
      .select("id, name, problem_type, business_objective, status, dataset_filename, dataset_rows, dataset_columns, total_rows")
      .eq("id", project_id)
      .maybeSingle();

    if (!project) {
      return new Response(JSON.stringify({
        success: false, error: "PROJECT_NOT_FOUND",
        project: null, active_dataset: null, eda: { status: "missing" }, schema: { columns: [] },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // 2. Active dataset
    const { data: activeDataset } = await sb
      .from("project_datasets")
      .select("id, storage_path, total_rows, columns_count, sample_rows, is_active, created_at")
      .eq("project_id", project_id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // 3. EDA status — via compute_eda_ready SSOT RPC
    let edaStatus: "ok" | "blocked" | "missing" = "missing";
    let edaMeta: Record<string, unknown> = {};

    if (!activeDataset) {
      edaStatus = "missing";
    } else {
      const { data: edaResult, error: edaRpcErr } = await sb.rpc("compute_eda_ready", { p_project_id: project_id });
      if (!edaRpcErr && edaResult) {
        const r = edaResult as Record<string, unknown>;
        edaStatus = r.eda_ready === true ? "ok" : "blocked";
        const evidence = r.evidence as Record<string, unknown> || {};
        edaMeta = {
          ...evidence,
          reasons: r.reasons,
          source: "compute_eda_ready",
        };
      } else {
        // Fallback if RPC fails
        edaStatus = "blocked";
        edaMeta = { rpc_error: edaRpcErr?.message || "unknown" };
      }
    }

    // 4. Schema columns - priority resolution
    let schemaColumns: { name: string; type: string | null }[] = [];
    let schemaSource = "none";

    // 4a. Try active_schema_json from project_dataset_state
    const { data: dsStateSchema } = await sb
      .from("project_dataset_state")
      .select("active_schema_json")
      .eq("project_id", project_id)
      .maybeSingle();

    if (dsStateSchema) {
      const schemaJson = (dsStateSchema as Record<string, unknown>).active_schema_json;
      if (schemaJson && typeof schemaJson === "object") {
        const entries = Object.entries(schemaJson as Record<string, unknown>).filter(([k]) => !k.startsWith("_"));
        if (entries.length > 0) {
          schemaColumns = entries.map(([name, type]) => ({ name, type: typeof type === "string" ? type : null }));
          schemaSource = "active_schema_json";
        }
      }
    }

    // 4b. Fallback: project_columns
    if (schemaColumns.length === 0) {
      const { data: projCols } = await sb
        .from("project_columns")
        .select("column_name, inferred_type")
        .eq("project_id", project_id)
        .order("column_index");
      if (projCols && projCols.length > 0) {
        schemaColumns = projCols.map(c => ({ name: c.column_name, type: c.inferred_type }));
        schemaSource = "project_columns";
      }
    }

    // 4c. Fallback: sample_json.columns
    if (schemaColumns.length === 0) {
      const { data: sampleData } = await sb
        .from("project_dataset_sample")
        .select("sample_json")
        .eq("project_id", project_id)
        .maybeSingle();
      if (sampleData) {
        const sj = (sampleData as Record<string, unknown>).sample_json as Record<string, unknown> | null;
        if (sj && Array.isArray(sj.columns)) {
          schemaColumns = (sj.columns as unknown[]).map((item: unknown) => {
            if (typeof item === "string") return { name: item, type: null };
            if (item && typeof item === "object" && "name" in (item as Record<string, unknown>)) {
              const obj = item as Record<string, unknown>;
              return { name: String(obj.name), type: obj.type ? String(obj.type) : null };
            }
            return null;
          }).filter(Boolean) as { name: string; type: string | null }[];
          schemaSource = "sample_json.columns";
        }
      }
    }

    // 5. Problem type inference
    const { data: problemInference } = await sb
      .from("project_problem_inference")
      .select("detected_problem_type")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // 6. Dataset readiness
    const datasetReady = !!(
      activeDataset &&
      (activeDataset.total_rows || 0) > 0 &&
      (activeDataset.columns_count || 0) >= 2
    );

    const result = {
      success: true,
      project: {
        id: project.id,
        name: project.name,
        problem_type: project.problem_type,
        business_objective: project.business_objective || null,
        dataset_ready_for_modeling: datasetReady,
        dataset_blocked_reason: !activeDataset
          ? "Nenhum dataset ativo registrado"
          : (activeDataset.total_rows || 0) <= 0
          ? "Dataset com 0 linhas"
          : (activeDataset.columns_count || 0) < 2
          ? "Dataset com menos de 2 colunas"
          : null,
        detected_problem_type: (problemInference as Record<string, unknown>)?.detected_problem_type ?? null,
      },
      active_dataset: activeDataset
        ? {
            id: activeDataset.id,
            storage_path: activeDataset.storage_path,
            total_rows: activeDataset.total_rows,
            columns_count: activeDataset.columns_count,
            sample_rows: activeDataset.sample_rows,
          }
        : null,
      eda: {
        status: edaStatus,
        ...edaMeta,
      },
      schema: {
        columns: schemaColumns,
        source: schemaSource,
        count: schemaColumns.length,
      },
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  } catch (error) {
    console.error("[get-project-modeling-state] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
      project: null, active_dataset: null,
      eda: { status: "missing" },
      schema: { columns: [], source: "none", count: 0 },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  }
});
