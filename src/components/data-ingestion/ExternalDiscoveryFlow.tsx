import { useState, useCallback, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle, AlertCircle, Plug, AlertTriangle, Upload, Database, RefreshCw, Link2, Server, ArrowRight } from "lucide-react";
import { useExternalDiscovery } from "@/hooks/useExternalDiscovery";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import DiscoveryGrid from "./DiscoveryGrid";
import ObjectInspectionModal from "./ObjectInspectionModal";
import SourceConnectionModal, { mapSourceToConnector } from "./SourceConnectionModal";
import PowerBIManualAssistedPanel from "./PowerBIManualAssistedPanel";
import type { ProjectData } from "../wizard/WizardContainer";

interface ExternalDiscoveryFlowProps {
  projectData: ProjectData;
  dataSourceId: string;
  connectorType: string;
  connectionName: string;
  onDataReady: () => void;
}

const ExternalDiscoveryFlow = ({
  projectData,
  dataSourceId,
  connectorType,
  connectionName,
  onDataReady,
}: ExternalDiscoveryFlowProps) => {
  const { currentOrganization } = useOrganization();
  const { toast } = useToast();
  const [hasInitialized, setHasInitialized] = useState(false);
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [manualTableName, setManualTableName] = useState("");
  const [manualSubmissionStatus, setManualSubmissionStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [manualSubmissionError, setManualSubmissionError] = useState<string | null>(null);
  const [autoMaterializing, setAutoMaterializing] = useState(false);
  const [connectionConfig, setConnectionConfig] = useState<Record<string, any> | null>(null);

  const {
    connections,
    activeConnectionId,
    setActiveConnectionId,
    discoveryRun,
    discoveryFallback,
    sourceTrace,
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
  } = useExternalDiscovery(projectData.id);

  useEffect(() => {
    if (hasInitialized || !projectData.id || !currentOrganization?.id) return;
    setHasInitialized(true);
    const init = async () => {
      const existing = connections.find(c => c.data_source_id === dataSourceId);
      if (existing) { setActiveConnectionId(existing.id); return; }
      await createConnectionAndDiscover(dataSourceId, connectorType, connectionName, currentOrganization.id);
    };
    init();
  }, [hasInitialized, projectData.id, currentOrganization?.id, connections, dataSourceId, connectorType, connectionName, createConnectionAndDiscover, setActiveConnectionId]);

  // Load connection_config to get workspace_id and dataset_id for XMLA panel
  useEffect(() => {
    if (!dataSourceId) return;
    supabase
      .from("data_sources")
      .select("connection_config")
      .eq("id", dataSourceId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.connection_config) {
          setConnectionConfig(data.connection_config as Record<string, any>);
        }
      });
  }, [dataSourceId]);

  const pbiWorkspaceId = connectionConfig?.workspace_id || undefined;
  const pbiDatasetId = connectionConfig?.dataset_id || undefined;

  const handleImport = useCallback(async () => {
    const result = await importSelected(true);
    if (result?.completed > 0) onDataReady();
  }, [importSelected, onDataReady]);

  // Auto-materialize via XMLA when user clicks "Continue" and tables were discovered
  const handleAutoMaterialize = useCallback(async () => {
    if (!projectData.id || !activeConnectionId) {
      onDataReady();
      return;
    }

    // Check if already materialized
    const { data: existing } = await supabase
      .from("project_datasets")
      .select("id")
      .eq("project_id", projectData.id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    
    if (existing) {
      onDataReady();
      return;
    }

    // Get discovered table names from objects
    const tableNames = objects.map(o => o.object_name).filter(Boolean);
    if (tableNames.length === 0 && !pbiWorkspaceId) {
      onDataReady();
      return;
    }

    setAutoMaterializing(true);
    try {
      const { data, error } = await supabase.functions.invoke("debug-powerbi-xmla", {
        body: {
          project_id: projectData.id,
          connection_id: activeConnectionId,
          workspace_id: pbiWorkspaceId,
          dataset_id: pbiDatasetId,
          materialize: true,
          selected_tables: tableNames.length > 0 ? tableNames : undefined,
        },
      });

      if (error) throw error;
      if (data?.materialized) {
        toast({
          title: "Dataset materializado com sucesso",
          description: "Os dados do Power BI foram persistidos. Avançando...",
        });
        setTimeout(() => onDataReady(), 500);
      } else {
        toast({
          title: "Materialização não concluída",
          description: data?.diagnostic?.steps?.find((s: any) => s.status === "fail")?.detail || "Verifique o diagnóstico XMLA.",
          variant: "destructive",
        });
      }
    } catch (err: any) {
      toast({
        title: "Erro na materialização automática",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setAutoMaterializing(false);
    }
  }, [projectData.id, activeConnectionId, objects, pbiWorkspaceId, pbiDatasetId, toast, onDataReady]);

  const effectiveSourceTrace = sourceTrace || (discoveryRun?.evidence as any)?.source_trace || null;
  const sourceDetected = effectiveSourceTrace?.detected === true;
  const handleRediscover = useCallback(() => {
    if (activeConnectionId) runDiscovery(activeConnectionId);
  }, [activeConnectionId, runDiscovery]);

  const handleSourceCTAClick = useCallback(() => {
    // Log event (best-effort)
    try {
      Promise.resolve(supabase.from("platform_events").insert({
        event_type: "source_detected_cta_clicked",
        project_id: projectData.id,
        source: "connector_powerbi",
        status: "info",
        metadata: {
          datasource_type: effectiveSourceTrace?.datasource_type,
          datasource_server: effectiveSourceTrace?.datasource_server,
        },
      }));
    } catch { /* best-effort */ }

    setShowSourceModal(true);
  }, [projectData.id]);

  const handleConnectionCreated = useCallback(async (newDataSourceId: string) => {
    if (!currentOrganization?.id) return;
    const derivedName = `Derivada — ${effectiveSourceTrace?.datasource_type || 'fonte detectada'}`;
    const mapped = effectiveSourceTrace?.datasource_type
      ? mapSourceToConnector(effectiveSourceTrace.datasource_type)
      : null;
    const cType = mapped?.connectorType || 'database';

    // Log derived connection creation
    try {
      await Promise.resolve(supabase.from("platform_events").insert({
        event_type: "derived_connection_created",
        project_id: projectData.id,
        source: "connector_powerbi",
        status: "info",
        metadata: {
          data_source_id: newDataSourceId,
          connector_type: cType,
          datasource_type: effectiveSourceTrace?.datasource_type,
        },
      }));
    } catch { /* best-effort */ }

    // Trigger discovery on the newly created data source
    const connId = await createConnectionAndDiscover(
      newDataSourceId, cType, derivedName, currentOrganization.id
    );

    if (connId) {
      // Log discovery started
      try {
        await Promise.resolve(supabase.from("platform_events").insert({
          event_type: "derived_connection_discovery_started",
          project_id: projectData.id,
          source: "connector_powerbi",
          status: "info",
          metadata: { connection_id: connId, data_source_id: newDataSourceId },
        }));
      } catch { /* best-effort */ }
    }
  }, [currentOrganization?.id, effectiveSourceTrace, projectData.id, createConnectionAndDiscover]);

  const handleFallbackAction = useCallback((action: "upload" | "manual_sql") => {
    onDataReady();
  }, [onDataReady]);

  const inspectedObject = objects.find(o => o.id === inspectingObjectId);

  const isDiscoveryFallbackFailure = discoveryFallback && objects.length === 0;
  const isDiscoveryRunFallback = discoveryRun?.status === 'failed_with_fallback';
  const showFallbackUI = isDiscoveryFallbackFailure || isDiscoveryRunFallback;




  return (
    <div className="space-y-4">
      {/* Status header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">{connectionName}</span>
          <Badge variant="outline" className="text-xs">{connectorType}</Badge>
        </div>
        {discoveryRun && (
          <Badge
            variant={
              discoveryRun.status === 'done' ? 'default' :
              discoveryRun.status === 'failed_with_fallback' ? 'secondary' :
              discoveryRun.status === 'failed' ? 'destructive' : 'secondary'
            }
            className="text-xs"
          >
            {discoveryRun.status === 'done' && <CheckCircle className="w-3 h-3 mr-1" />}
            {discoveryRun.status === 'failed' && <AlertCircle className="w-3 h-3 mr-1" />}
            {discoveryRun.status === 'failed_with_fallback' && <AlertTriangle className="w-3 h-3 mr-1" />}
            {discoveryRun.status === 'running' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {discoveryRun.status === 'failed_with_fallback' ? 'fallback' : `${discoveryRun.objects_found} objetos`}
          </Badge>
        )}
      </div>

      {/* Discovery error (standard) */}
      {discoveryRun?.status === 'failed' && !isDiscoveryRunFallback && discoveryRun.error_message && (
        <Card className="p-4 bg-destructive/5 border-destructive/20">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-destructive mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-destructive">Erro no Discovery</p>
              <p className="text-muted-foreground mt-1">{discoveryRun.error_message}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Power BI Manual Assisted Selection Mode */}
      {showFallbackUI && connectorType === 'powerbi' && (
        <PowerBIManualAssistedPanel
          connectionStatus="connected_partial_discovery"
          message={
            'Conexão com Power BI estabelecida. O dataset foi acessado com sucesso, porém o modelo semântico não permitiu listar automaticamente todas as tabelas. Selecione uma tabela manualmente ou escolha uma das tabelas detectadas.'
          }
          discoveryAvailable={false}
          semanticModelType={effectiveSourceTrace?.semantic_model_type || undefined}
          sourceTrace={sourceDetected && effectiveSourceTrace ? {
            datasource_type: effectiveSourceTrace.datasource_type,
            datasource_server: effectiveSourceTrace.datasource_server,
            datasource_database: effectiveSourceTrace.datasource_database,
            source_role: effectiveSourceTrace.source_role || undefined,
            confidence: effectiveSourceTrace.confidence || undefined,
          } : null}
          discoveredTables={
            objects.length > 0 ? objects.map(o => o.object_name).filter(Boolean) : undefined
          }
          manualTableName={manualTableName}
          onManualTableNameChange={setManualTableName}
          onRetryDiscovery={handleRediscover}
          onUseDetectedSource={handleSourceCTAClick}
          onImportFile={onDataReady}
          onContinuePartial={handleAutoMaterialize}
          onSelectTableManually={async () => {
            if (!manualTableName.trim()) return;
            setManualSubmissionStatus("submitting");
            setManualSubmissionError(null);
            try {
              const { data, error } = await supabase.functions.invoke("select-manual-powerbi-table", {
                body: {
                  project_id: projectData.id,
                  connection_id: activeConnectionId,
                  workspace_id: null,
                  dataset_id: null,
                  manual_table_name: manualTableName,
                  organization_id: currentOrganization?.id || null,
                },
              });
              if (error) throw error;
              if (!data?.success) {
                throw new Error(data?.message || "Falha ao salvar seleção manual.");
              }

              // Verify dataset materialization in SSOT before showing success
              const { data: verifyData } = await supabase
                .from("project_datasets")
                .select("id")
                .eq("project_id", projectData.id)
                .eq("is_active", true)
                .limit(1)
                .maybeSingle();

              if (!verifyData) {
                // Fallback: check project_settings
                const { data: settingsData } = await supabase
                  .from("project_settings")
                  .select("ingestion_state")
                  .eq("project_id", projectData.id)
                  .maybeSingle();

                if ((settingsData as any)?.ingestion_state !== 'done') {
                  console.warn("[ExternalDiscoveryFlow] Dataset not found in SSOT after manual selection");
                  throw new Error("A tabela foi validada, mas o dataset não foi ativado corretamente para a etapa de análise.");
                }
              }

              setManualSubmissionStatus("success");
              toast({
                title: "Dataset manual ativo registrado com sucesso",
                description: "Você pode avançar para a análise.",
              });
              setTimeout(() => onDataReady(), 1500);
            } catch (err: any) {
              setManualSubmissionStatus("error");
              setManualSubmissionError(err.message || "Erro ao salvar seleção manual.");
              toast({
                title: "Erro",
                description: err.message || "A tabela manual foi informada, mas não foi possível registrar o dataset ativo. Tente novamente.",
                variant: "destructive",
              });
            }
          }}
          isRetrying={isDiscovering || autoMaterializing}
          submissionStatus={manualSubmissionStatus}
          submissionError={manualSubmissionError}
          projectId={projectData.id}
          connectionId={activeConnectionId || undefined}
          workspaceId={pbiWorkspaceId}
          datasetId={pbiDatasetId}
        />
      )}

      {/* Discovery fallback state (non-Power BI connectors) */}
      {showFallbackUI && connectorType !== 'powerbi' && (
        <Card className="p-5 border-yellow-500/30 bg-yellow-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" />
            <div className="space-y-3 flex-1">
              <div>
                <p className="font-medium text-sm">
                  {sourceDetected
                    ? 'Fonte analítica subjacente detectada'
                    : 'Discovery parcial — método automático indisponível'}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {sourceDetected
                    ? 'Foi possível estabelecer conexão com o dataset, mas o discovery automático não está disponível para este caso. Detectamos uma possível fonte analítica subjacente e recomendamos conectar diretamente essa fonte para uma ingestão mais estável no PredictSys.'
                    : discoveryFallback?.user_message || discoveryRun?.error_message || 'O dataset foi localizado, mas a inspeção automática não pôde ser concluída. Você pode usar um arquivo exportado ou conectar manualmente a fonte analítica de origem.'
                  }
                </p>
              </div>

              {/* Source trace detected card */}
              {sourceDetected && effectiveSourceTrace && (
                <Card className="p-4 border-primary/20 bg-primary/5">
                  <div className="flex items-start gap-3">
                    <Server className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium">Fonte detectada</p>
                        <Badge variant="default" className="text-xs">{effectiveSourceTrace.datasource_type}</Badge>
                        {effectiveSourceTrace.confidence && (
                          <Badge variant="outline" className="text-xs">
                            Confiança: {effectiveSourceTrace.confidence === 'high' ? 'Alta' : effectiveSourceTrace.confidence === 'medium' ? 'Média' : 'Baixa'}
                          </Badge>
                        )}
                        {effectiveSourceTrace.semantic_model_type && (
                          <Badge variant="secondary" className="text-xs">
                            Modelo: {effectiveSourceTrace.semantic_model_type}
                          </Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {effectiveSourceTrace.datasource_server && (
                          <div><span className="font-medium text-foreground">Servidor:</span> {effectiveSourceTrace.datasource_server}</div>
                        )}
                        {effectiveSourceTrace.datasource_database && (
                          <div><span className="font-medium text-foreground">Banco:</span> {effectiveSourceTrace.datasource_database}</div>
                        )}
                        {effectiveSourceTrace.datasource_path && (
                          <div className="col-span-full"><span className="font-medium text-foreground">Caminho:</span> {effectiveSourceTrace.datasource_path}</div>
                        )}
                      </div>
                      <Button variant="default" size="sm" className="mt-2" onClick={handleSourceCTAClick}>
                        <Link2 className="w-3 h-3 mr-1" />
                        Conectar fonte detectada
                        <ArrowRight className="w-3 h-3 ml-1" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )}

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={handleRediscover} disabled={isDiscovering}>
                  {isDiscovering ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                  Tentar novamente
                </Button>
                <Button variant="outline" size="sm" onClick={onDataReady}>
                  <Upload className="w-3 h-3 mr-1" />
                  Importar arquivo exportado
                </Button>
                {!sourceDetected && (
                  <Button variant="outline" size="sm" onClick={onDataReady}>
                    <Database className="w-3 h-3 mr-1" />
                    Conectar fonte SQL/Lake
                  </Button>
                )}
              </div>

              {discoveryFallback?.fix_suggestion && (
                <p className="text-xs text-muted-foreground border-t border-border pt-2 mt-2">
                  💡 {discoveryFallback.fix_suggestion}
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Discovery grid */}
      {!isDiscoveryFallbackFailure && !isDiscoveryRunFallback && (
        <DiscoveryGrid
          objects={objects}
          selectedIds={selectedObjectIds}
          isDiscovering={isDiscovering}
          isImporting={isImporting}
          onToggleSelection={toggleSelection}
          onInspect={inspectObject}
          onImport={handleImport}
          onRediscover={handleRediscover}
        />
      )}

      {/* Inspection modal */}
      <ObjectInspectionModal
        open={!!inspectingObjectId}
        onClose={() => setInspectingObjectId(null)}
        objectName={inspectedObject?.object_name || ''}
        columns={inspectionData?.columns || inspectedObject?.column_preview || null}
        rows={inspectionData?.rows || inspectedObject?.sample_rows || null}
        isLoading={!!inspectingObjectId && !inspectionData && !inspectedObject?.column_preview}
      />

      {/* Source connection modal */}
      {effectiveSourceTrace && (
        <SourceConnectionModal
          open={showSourceModal}
          onClose={() => setShowSourceModal(false)}
          sourceTrace={effectiveSourceTrace as any}
          projectId={projectData.id}
          onConnectionCreated={handleConnectionCreated}
          onFallbackAction={handleFallbackAction}
        />
      )}
    </div>
  );
};

export default ExternalDiscoveryFlow;
