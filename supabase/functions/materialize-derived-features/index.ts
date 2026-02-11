import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[materialize] Starting for project ${project_id}`);

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
      console.log(`[materialize] No enabled features`);
      return new Response(JSON.stringify({
        success: true, materialized_count: 0,
        message: "Nenhuma feature derivada ativa para materializar.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fetch existing project_columns
    const { data: existingCols } = await supabase
      .from("project_columns")
      .select("id, column_name, column_index")
      .eq("project_id", project_id)
      .order("column_index");

    const colsByLowerName = new Map<string, { id: string; column_name: string; column_index: number }>();
    for (const c of (existingCols || [])) {
      colsByLowerName.set(c.column_name.toLowerCase(), c);
    }
    const maxIndex = (existingCols || []).reduce((max: number, c: any) => Math.max(max, c.column_index), -1);

    // ── IDEMPOTENT UPSERT: check each feature ──
    let newlyCreated = 0;
    let alreadyExisted = 0;
    let skipped = 0;
    let nextIndex = maxIndex + 1;
    const materializedNames: string[] = [];

    for (const feat of features) {
      if (!feat.expression || !feat.expression.type) {
        skipped++;
        continue;
      }

      const lowerName = feat.name.toLowerCase();
      const existing = colsByLowerName.get(lowerName);

      // Validate source columns exist
      const sourceCols = getExpressionColumns(feat.expression);
      const allSourcesExist = sourceCols.every(sc => colsByLowerName.has(sc.toLowerCase()));
      if (!allSourcesExist) {
        const missing = sourceCols.filter(sc => !colsByLowerName.has(sc.toLowerCase()));
        console.warn(`[materialize] Feature "${feat.name}" skipped: missing source columns: ${missing.join(", ")}`);
        skipped++;
        continue;
      }

      if (existing) {
        // Column already exists — mark feature as materialized, don't create duplicate
        alreadyExisted++;
        await supabase.from("project_features").update({
          is_materialized: true,
          materialized_column_id: existing.id,
        }).eq("id", feat.id);
      } else {
        // Create new column — use upsert with ON CONFLICT to be safe
        const { data: inserted, error: insertErr } = await supabase
          .from("project_columns")
          .insert({
            project_id,
            column_name: feat.name,
            column_index: nextIndex,
            inferred_type: "numérico",
          })
          .select("id")
          .single();

        if (insertErr) {
          // If unique constraint violation, fetch existing
          if (insertErr.code === "23505") {
            console.log(`[materialize] Duplicate key for "${feat.name}", fetching existing`);
            const { data: dup } = await supabase
              .from("project_columns")
              .select("id")
              .eq("project_id", project_id)
              .ilike("column_name", feat.name)
              .single();
            if (dup) {
              await supabase.from("project_features").update({
                is_materialized: true,
                materialized_column_id: dup.id,
              }).eq("id", feat.id);
              alreadyExisted++;
            }
          } else {
            console.error(`[materialize] Failed to insert column "${feat.name}":`, insertErr);
          }
          continue;
        }

        nextIndex++;
        newlyCreated++;

        // Link feature to column
        if (inserted) {
          await supabase.from("project_features").update({
            is_materialized: true,
            materialized_column_id: inserted.id,
          }).eq("id", feat.id);
          colsByLowerName.set(lowerName, { id: inserted.id, column_name: feat.name, column_index: nextIndex - 1 });
        }
      }

      materializedNames.push(feat.name);
    }

    console.log(`[materialize] Created: ${newlyCreated}, existing: ${alreadyExisted}, skipped: ${skipped}`);

    // ── Update SSOT ──
    const newColCount = (existingCols?.length || 0) + newlyCreated;
    const { data: dsState } = await supabase
      .from("project_dataset_state")
      .select("*")
      .eq("project_id", project_id)
      .maybeSingle();

    if (dsState) {
      const currentDiag = (dsState.diagnostics as Record<string, any>) || {};
      const schemaVersion = (currentDiag.schema_version || 0) + (newlyCreated > 0 ? 1 : 0);

      await supabase.from("project_dataset_state").update({
        col_count: newColCount,
        model_ready: false,
        diagnostics: {
          ...currentDiag,
          schema_version: schemaVersion,
          last_materialization_at: new Date().toISOString(),
          materialized_features_count: materializedNames.length,
          materialized_feature_names: materializedNames,
        },
        updated_at: new Date().toISOString(),
      }).eq("project_id", project_id);
    }

    // ── Check if target is a derived feature → increment selection_version ──
    const { data: selectionData } = await supabase
      .from("project_model_selection")
      .select("target_column, selection_version")
      .eq("project_id", project_id)
      .maybeSingle();

    let selectionVersionIncremented = false;
    const matSet = new Set(materializedNames.map(n => n.toLowerCase()));

    if (selectionData?.target_column && matSet.has(selectionData.target_column.toLowerCase())) {
      const newVersion = ((selectionData as any).selection_version || 0) + 1;
      await supabase.from("project_model_selection").update({
        selection_version: newVersion,
      }).eq("project_id", project_id);
      selectionVersionIncremented = true;
      console.log(`[materialize] Target "${selectionData.target_column}" is derived — selection_version → ${newVersion}`);
    }

    // ── Mark modeling datasets as outdated ──
    if (newlyCreated > 0) {
      await supabase.from("project_modeling_datasets").update({
        is_current: false,
        stale_reason: "TARGET_OR_FEATURE_CHANGED",
      }).eq("project_id", project_id).eq("is_current", true);
    }

    // Update projects table for backward compat
    await supabase.from("projects").update({
      dataset_columns: newColCount,
      dataset_ready_for_modeling: false,
    }).eq("id", project_id);

    const result = {
      success: true,
      materialized_count: newlyCreated,
      already_materialized: alreadyExisted,
      skipped,
      total_features: materializedNames.length,
      new_col_count: newColCount,
      selection_version_incremented: selectionVersionIncremented,
      modeling_datasets_invalidated: newlyCreated > 0,
      message: newlyCreated > 0
        ? `${newlyCreated} feature(s) materializada(s). Dataset atualizado.`
        : `Todas as ${alreadyExisted} features já estavam materializadas.`,
    };

    console.log(`[materialize] Done:`, result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[materialize] Error:`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
