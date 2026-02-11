import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Feature expression types (mirror of shared types) ──
type FeatureExpression =
  | { type: "ratio"; numerator: string; denominator: string; eps?: number }
  | { type: "difference"; minuend: string; subtrahend: string }
  | { type: "sum"; columns: string[] }
  | { type: "binary_flag"; column: string; op: ">" | ">=" | "<" | "<=" | "==" | "!="; value: number }
  | { type: "log1p"; column: string };

interface ProjectFeature {
  id: string;
  name: string;
  label: string;
  enabled: boolean;
  expression: FeatureExpression;
}

function getExpressionColumns(expr: FeatureExpression): string[] {
  switch (expr.type) {
    case "ratio": return [expr.numerator, expr.denominator];
    case "difference": return [expr.minuend, expr.subtrahend];
    case "sum": return expr.columns;
    case "binary_flag":
    case "log1p": return [expr.column];
    default: return [];
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[materialize-derived-features] Starting for project ${project_id}`);

    // Fetch project
    const { data: project, error: projErr } = await supabase
      .from("projects").select("id, organization_id").eq("id", project_id).single();
    if (projErr || !project) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all enabled derived features
    const { data: featuresRaw, error: featErr } = await supabase
      .from("project_features")
      .select("id, name, label, enabled, expression")
      .eq("project_id", project_id)
      .eq("enabled", true);

    if (featErr) throw featErr;

    const features: ProjectFeature[] = (featuresRaw || []).map((f: any) => ({
      ...f,
      expression: f.expression as FeatureExpression,
    }));

    if (features.length === 0) {
      console.log(`[materialize-derived-features] No enabled features to materialize`);
      return new Response(JSON.stringify({
        success: true,
        materialized_count: 0,
        message: "Nenhuma feature derivada ativa para materializar.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fetch existing project_columns
    const { data: existingCols } = await supabase
      .from("project_columns")
      .select("column_name, column_index")
      .eq("project_id", project_id)
      .order("column_index");

    const existingColNames = new Set((existingCols || []).map((c: any) => c.column_name));
    const maxIndex = (existingCols || []).reduce((max: number, c: any) => Math.max(max, c.column_index), -1);

    // Determine which features need to be materialized (not yet in project_columns)
    const toMaterialize: ProjectFeature[] = [];
    const alreadyMaterialized: string[] = [];

    for (const feat of features) {
      if (!feat.expression || !feat.expression.type) continue;
      if (existingColNames.has(feat.name)) {
        alreadyMaterialized.push(feat.name);
      } else {
        // Validate source columns exist
        const sourceCols = getExpressionColumns(feat.expression);
        const allSourcesExist = sourceCols.every(sc => existingColNames.has(sc));
        if (allSourcesExist) {
          toMaterialize.push(feat);
        } else {
          const missing = sourceCols.filter(sc => !existingColNames.has(sc));
          console.warn(`[materialize-derived-features] Feature "${feat.name}" skipped: missing source columns: ${missing.join(", ")}`);
        }
      }
    }

    console.log(`[materialize-derived-features] To materialize: ${toMaterialize.length}, already materialized: ${alreadyMaterialized.length}`);

    // Insert new columns into project_columns
    if (toMaterialize.length > 0) {
      const newColInserts = toMaterialize.map((feat, i) => ({
        project_id,
        column_name: feat.name,
        column_index: maxIndex + 1 + i,
        inferred_type: "numérico", // All derived features are numeric
      }));

      const { error: insertErr } = await supabase
        .from("project_columns")
        .insert(newColInserts);

      if (insertErr) {
        console.error(`[materialize-derived-features] Failed to insert columns:`, insertErr);
        throw insertErr;
      }

      console.log(`[materialize-derived-features] Inserted ${newColInserts.length} new columns into project_columns`);
    }

    // Update SSOT (project_dataset_state)
    const totalMaterialized = toMaterialize.length + alreadyMaterialized.length;
    const newColCount = (existingCols?.length || 0) + toMaterialize.length;

    // Read current dataset state
    const { data: dsState } = await supabase
      .from("project_dataset_state")
      .select("*")
      .eq("project_id", project_id)
      .maybeSingle();

    if (dsState) {
      const currentDiag = (dsState.diagnostics as Record<string, any>) || {};
      const schemaVersion = (currentDiag.schema_version || 0) + 1;

      await supabase.from("project_dataset_state").update({
        col_count: newColCount,
        model_ready: false, // Force rebuild
        diagnostics: {
          ...currentDiag,
          schema_version: schemaVersion,
          last_materialization_at: new Date().toISOString(),
          materialized_features_count: totalMaterialized,
          materialized_feature_names: [...alreadyMaterialized, ...toMaterialize.map(f => f.name)],
        },
        updated_at: new Date().toISOString(),
      }).eq("project_id", project_id);

      console.log(`[materialize-derived-features] SSOT updated: col_count=${newColCount}, model_ready=false, schema_v=${schemaVersion}`);
    }

    // Check if any materialized feature is the current target → increment selection_version
    const { data: selectionData } = await supabase
      .from("project_model_selection")
      .select("target_column, selection_version")
      .eq("project_id", project_id)
      .maybeSingle();

    const materializedNames = new Set([...alreadyMaterialized, ...toMaterialize.map(f => f.name)]);
    let selectionVersionIncremented = false;

    if (selectionData && selectionData.target_column && materializedNames.has(selectionData.target_column)) {
      const newVersion = ((selectionData as any).selection_version || 0) + 1;
      await supabase.from("project_model_selection").update({
        selection_version: newVersion,
      }).eq("project_id", project_id);
      selectionVersionIncremented = true;
      console.log(`[materialize-derived-features] Target "${selectionData.target_column}" is a derived feature — selection_version incremented to ${newVersion}`);
    }

    // Mark all existing modeling datasets as outdated
    await supabase.from("project_modeling_datasets").update({
      is_current: false,
      stale_reason: "TARGET_OR_FEATURE_CHANGED",
    }).eq("project_id", project_id).eq("is_current", true);

    console.log(`[materialize-derived-features] Marked existing modeling datasets as outdated`);

    // Also update projects table col count for backward compat
    await supabase.from("projects").update({
      dataset_columns: newColCount,
      dataset_ready_for_modeling: false,
    }).eq("id", project_id);

    const result = {
      success: true,
      materialized_count: toMaterialize.length,
      already_materialized: alreadyMaterialized.length,
      total_features: totalMaterialized,
      new_col_count: newColCount,
      selection_version_incremented: selectionVersionIncremented,
      modeling_datasets_invalidated: true,
      message: toMaterialize.length > 0
        ? `${toMaterialize.length} feature(s) materializada(s). Dataset atualizado.`
        : `Todas as ${alreadyMaterialized.length} features já estavam materializadas.`,
    };

    console.log(`[materialize-derived-features] Done:`, result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[materialize-derived-features] Error:`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
