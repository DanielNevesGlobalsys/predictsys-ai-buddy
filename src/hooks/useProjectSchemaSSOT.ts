import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getProjectSchemaSSOT, type SchemaSSOTResult, type SchemaColumn } from "@/lib/schemaSSOT";

export type { SchemaColumn, SchemaSSOTResult };

export function useProjectSchemaSSOT(projectId: string | undefined) {
  const [result, setResult] = useState<SchemaSSOTResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!projectId) return null;
    setLoading(true);
    setError(null);
    try {
      const r = await getProjectSchemaSSOT(supabase, projectId);
      setResult(r);
      loadedRef.current = true;

      // Fire observability event (fire & forget)
      supabase.functions.invoke("track-event", {
        body: {
          event_type: "schema_ssot_loaded",
          project_id: projectId,
          status: "success",
          metadata: {
            source: r.source,
            schema_columns_count: r.schema_columns_count,
            detected_columns_count: r.detected_columns_count ?? null,
          },
        },
      }).catch(() => {});

      return r;
    } catch (err: any) {
      console.error("[useProjectSchemaSSOT]", err);
      setError(err?.message || "Erro ao carregar schema SSOT");
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const reload = load;

  return {
    columns: result?.columns ?? [],
    source: result?.source ?? "unknown",
    schema_columns_count: result?.schema_columns_count ?? 0,
    detected_columns_count: result?.detected_columns_count,
    loading,
    error,
    loaded: loadedRef.current,
    load,
    reload,
  };
}
