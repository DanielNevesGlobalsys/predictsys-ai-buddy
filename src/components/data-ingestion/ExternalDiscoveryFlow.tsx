import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Radar, CheckCircle, AlertCircle, Plug, AlertTriangle, Upload, Database, RefreshCw } from "lucide-react";
import { useExternalDiscovery } from "@/hooks/useExternalDiscovery";
import { useOrganization } from "@/contexts/OrganizationContext";
import DiscoveryGrid from "./DiscoveryGrid";
import ObjectInspectionModal from "./ObjectInspectionModal";
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
  const [hasInitialized, setHasInitialized] = useState(false);

  const {
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
    loadDiscoveryState,
  } = useExternalDiscovery(projectData.id);

  // Auto-create connection and run discovery on first mount
  useEffect(() => {
    if (hasInitialized || !projectData.id || !currentOrganization?.id) return;
    setHasInitialized(true);

    const init = async () => {
      const existing = connections.find(c => c.data_source_id === dataSourceId);
      if (existing) {
        setActiveConnectionId(existing.id);
        return;
      }
      await createConnectionAndDiscover(dataSourceId, connectorType, connectionName, currentOrganization.id);
    };
    init();
  }, [hasInitialized, projectData.id, currentOrganization?.id, connections, dataSourceId, connectorType, connectionName, createConnectionAndDiscover, setActiveConnectionId]);

  const handleImport = useCallback(async () => {
    const result = await importSelected(true);
    if (result?.completed > 0) {
      onDataReady();
    }
  }, [importSelected, onDataReady]);

  const handleRediscover = useCallback(() => {
    if (activeConnectionId) {
      runDiscovery(activeConnectionId);
    }
  }, [activeConnectionId, runDiscovery]);

  const inspectedObject = objects.find(o => o.id === inspectingObjectId);

  // Determine if we're in a fallback failure state (DAX failed, no objects)
  const isDiscoveryFallbackFailure = discoveryFallback && objects.length === 0;
  const isDiscoveryRunFallback = discoveryRun?.status === 'failed_with_fallback';

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

      {/* Discovery fallback state (Power BI DAX failure) */}
      {(isDiscoveryFallbackFailure || isDiscoveryRunFallback) && (
        <Card className="p-5 border-yellow-500/30 bg-yellow-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" />
            <div className="space-y-3 flex-1">
              <div>
                <p className="font-medium text-sm">Discovery parcial — método automático indisponível</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {discoveryFallback?.user_message || discoveryRun?.error_message || 'O discovery automático não conseguiu listar os objetos do dataset.'}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={handleRediscover} disabled={isDiscovering}>
                  {isDiscovering ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                  Tentar novamente
                </Button>
                <Button variant="outline" size="sm" onClick={onDataReady}>
                  <Upload className="w-3 h-3 mr-1" />
                  Importar arquivo exportado
                </Button>
                <Button variant="outline" size="sm" onClick={onDataReady}>
                  <Database className="w-3 h-3 mr-1" />
                  Conectar fonte SQL/Lake
                </Button>
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

      {/* Discovery grid — only show when NOT in fallback failure state */}
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
    </div>
  );
};

export default ExternalDiscoveryFlow;
