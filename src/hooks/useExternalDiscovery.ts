import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface DiscoveryObject {
  id: string;
  object_name: string;
  object_type: string;
  object_schema: string | null;
  estimated_columns: number | null;
  estimated_rows: number | null;
  last_updated_at: string | null;
  classification: string | null;
  column_preview: any[] | null;
  sample_rows: any[] | null;
  is_selected: boolean;
  metadata: Record<string, any>;
}

export interface DiscoveryRun {
  id: string;
  status: string;
  objects_found: number;
  error_message: string | null;
  created_at: string;
  reasons?: string[] | null;
  evidence?: Record<string, any> | null;
}

export interface DiscoveryFallback {
  reason_code: string;
  discovery_method: string;
  fallback_used: boolean;
  user_message: string;
  fix_suggestion: string;
}

export interface ExternalConnection {
  id: string;
  connector_type: string;
  connection_name: string;
  connection_status: string;
  data_source_id: string | null;
  last_validated_at: string | null;
  validation_message: string | null;
}

export function useExternalDiscovery(projectId: string | undefined) {
  const { toast } = useToast();
  const [connections, setConnections] = useState<ExternalConnection[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [discoveryRun, setDiscoveryRun] = useState<DiscoveryRun | null>(null);
  const [objects, setObjects] = useState<DiscoveryObject[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [discoveryFallback, setDiscoveryFallback] = useState<DiscoveryFallback | null>(null);
  const [inspectingObjectId, setInspectingObjectId] = useState<string | null>(null);
  const [inspectionData, setInspectionData] = useState<{ columns: any[]; rows: any[] } | null>(null);
  const [selectedObjectIds, setSelectedObjectIds] = useState<Set<string>>(new Set());

  // Load connections for this project
  const loadConnections = useCallback(async () => {
    if (!projectId) return;
    const { data } = await supabase
      .from("external_connections")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (data) setConnections(data as ExternalConnection[]);
  }, [projectId]);

  // Load latest discovery run + objects
  const loadDiscoveryState = useCallback(async (connectionId: string) => {
    if (!projectId) return;

    const { data: runs } = await supabase
      .from("external_discovery_runs")
      .select("*")
      .eq("connection_id", connectionId)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (runs && runs.length > 0) {
      setDiscoveryRun(runs[0] as DiscoveryRun);

      const { data: objs } = await supabase
        .from("external_discovery_objects")
        .select("*")
        .eq("discovery_run_id", runs[0].id)
        .eq("project_id", projectId)
        .order("object_name");

      if (objs) {
        setObjects(objs as DiscoveryObject[]);
        const selected = new Set(objs.filter((o: any) => o.is_selected).map((o: any) => o.id));
        setSelectedObjectIds(selected);
      }
    } else {
      setDiscoveryRun(null);
      setObjects([]);
      setSelectedObjectIds(new Set());
    }
  }, [projectId]);

  useEffect(() => { loadConnections(); }, [loadConnections]);

  useEffect(() => {
    if (activeConnectionId) loadDiscoveryState(activeConnectionId);
  }, [activeConnectionId, loadDiscoveryState]);

  // Create external connection + run discovery via edge function (service role)
  const createConnectionAndDiscover = useCallback(async (
    dataSourceId: string, connectorType: string, connectionName: string, organizationId: string
  ) => {
    if (!projectId) return null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    setIsDiscovering(true);

    try {
      const { data, error } = await supabase.functions.invoke("discover-external-objects", {
        body: {
          project_id: projectId,
          create_connection: true,
          data_source_id: dataSourceId,
          connector_type: connectorType,
          connection_name: connectionName,
          organization_id: organizationId,
          user_id: user.id,
        }
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Discovery failed");

      // Handle fallback info from Power BI
      if (data.fallback) {
        setDiscoveryFallback(data.fallback as DiscoveryFallback);
      } else {
        setDiscoveryFallback(null);
      }

      const connId = data.connection_id;
      const toastDesc = data.fallback
        ? data.fallback.user_message
        : `${data.objects_found} objetos encontrados`;
      toast({
        title: data.fallback ? "Discovery parcial" : "Discovery concluído",
        description: toastDesc,
        variant: data.fallback ? "default" : "default",
      });

      // Reload connections and discovery state
      await loadConnections();
      setActiveConnectionId(connId);
      await loadDiscoveryState(connId);

      return connId;
    } catch (err: any) {
      toast({
        title: "Erro no Discovery",
        description: err.message?.includes("row-level security")
          ? "Você não tem permissão para acessar esta conexão externa. Verifique se a conexão pertence à sua organização."
          : err.message,
        variant: "destructive"
      });
      return null;
    } finally {
      setIsDiscovering(false);
    }
  }, [projectId, toast, loadConnections, loadDiscoveryState, setActiveConnectionId]);

  // Run discovery on existing connection
  const runDiscovery = useCallback(async (connectionId: string) => {
    if (!projectId) return;
    setIsDiscovering(true);
    setActiveConnectionId(connectionId);

    try {
      const { data, error } = await supabase.functions.invoke("discover-external-objects", {
        body: { connection_id: connectionId, project_id: projectId }
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Discovery failed");

      if (data.fallback) {
        setDiscoveryFallback(data.fallback as DiscoveryFallback);
      } else {
        setDiscoveryFallback(null);
      }

      toast({
        title: data.fallback ? "Discovery parcial" : "Discovery concluído",
        description: data.fallback ? data.fallback.user_message : `${data.objects_found} objetos encontrados`,
      });
      await loadDiscoveryState(connectionId);
    } catch (err: any) {
      toast({ title: "Erro no Discovery", description: err.message, variant: "destructive" });
    } finally {
      setIsDiscovering(false);
    }
  }, [projectId, toast, loadDiscoveryState]);

  // Inspect object
  const inspectObject = useCallback(async (objectId: string) => {
    setInspectingObjectId(objectId);
    setInspectionData(null);

    try {
      const { data, error } = await supabase.functions.invoke("inspect-external-object", {
        body: { object_id: objectId }
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Inspection failed");

      setInspectionData({ columns: data.columns, rows: data.rows });
    } catch (err: any) {
      toast({ title: "Erro na inspeção", description: err.message, variant: "destructive" });
      setInspectingObjectId(null);
    }
  }, [toast]);

  // Toggle selection
  const toggleSelection = useCallback((objectId: string) => {
    setSelectedObjectIds(prev => {
      const next = new Set(prev);
      if (next.has(objectId)) next.delete(objectId);
      else next.add(objectId);
      return next;
    });
  }, []);

  // Import selected objects
  const importSelected = useCallback(async (promote: boolean = true) => {
    if (!projectId || selectedObjectIds.size === 0) return;
    setIsImporting(true);

    try {
      const { data, error } = await supabase.functions.invoke("import-external-objects", {
        body: { project_id: projectId, object_ids: Array.from(selectedObjectIds), promote }
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Import failed");

      toast({
        title: "Importação concluída",
        description: `${data.completed} objeto(s) importado(s) com sucesso${data.failed > 0 ? `, ${data.failed} falharam` : ''}`
      });

      if (activeConnectionId) await loadDiscoveryState(activeConnectionId);
      return data;
    } catch (err: any) {
      toast({ title: "Erro na importação", description: err.message, variant: "destructive" });
      return null;
    } finally {
      setIsImporting(false);
    }
  }, [projectId, selectedObjectIds, activeConnectionId, toast, loadDiscoveryState]);

  return {
    connections,
    activeConnectionId,
    setActiveConnectionId,
    discoveryRun,
    discoveryFallback,
    objects,
    isDiscovering,
    isImporting,
    inspectingObjectId,
    inspectionData,
    selectedObjectIds,
    createConnectionAndDiscover,
    runDiscovery,
    inspectObject,
    toggleSelection,
    importSelected,
    setInspectingObjectId,
    loadConnections,
    loadDiscoveryState,
  };
}
