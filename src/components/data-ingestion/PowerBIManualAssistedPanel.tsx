import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle, AlertTriangle, RefreshCw, Upload, Database,
  Server, ArrowRight, Loader2, TableProperties, Link2, FileDown,
} from "lucide-react";

interface SourceTraceInfo {
  datasource_type: string | null;
  datasource_server: string | null;
  datasource_database: string | null;
}

interface PowerBIManualAssistedPanelProps {
  connectionStatus: string;
  message: string;
  discoveryAvailable: boolean;
  semanticModelType?: string;
  sourceTrace?: SourceTraceInfo | null;
  manualTableName: string;
  onManualTableNameChange: (value: string) => void;
  onRetryDiscovery: () => void;
  onUseDetectedSource: () => void;
  onImportFile: () => void;
  onContinuePartial: () => void;
  onSelectTableManually: () => void;
  isRetrying: boolean;
}

const PowerBIManualAssistedPanel = ({
  connectionStatus,
  message,
  discoveryAvailable,
  semanticModelType,
  sourceTrace,
  manualTableName,
  onManualTableNameChange,
  onRetryDiscovery,
  onUseDetectedSource,
  onImportFile,
  onContinuePartial,
  onSelectTableManually,
  isRetrying,
}: PowerBIManualAssistedPanelProps) => {
  const isPartial = connectionStatus === "connected_partial_discovery";
  const isFull = connectionStatus === "connected_full_discovery";
  const hasSourceTrace = sourceTrace && sourceTrace.datasource_type;

  if (!isPartial && !isFull) return null;

  // Full discovery — show simple success
  if (isFull) {
    return (
      <Card className="p-4 bg-accent/5 border-accent/20">
        <div className="flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-accent mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium text-sm text-accent">Conexão validada — Discovery automático disponível</p>
            <p className="text-sm text-muted-foreground mt-1">{message}</p>
            {semanticModelType && (
              <Badge variant="secondary" className="mt-2 text-xs">Modelo: {semanticModelType}</Badge>
            )}
          </div>
        </div>
      </Card>
    );
  }

  // Partial discovery — Manual Assisted Selection Mode
  return (
    <div className="space-y-4">
      {/* Status message */}
      <Card className="p-5 border-yellow-500/30 bg-yellow-500/5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-2 flex-1">
            <p className="font-medium text-sm">Conexão validada — Seleção manual disponível</p>
            <p className="text-sm text-muted-foreground">{message}</p>
            {semanticModelType && (
              <Badge variant="secondary" className="text-xs">Modelo semântico: {semanticModelType}</Badge>
            )}
          </div>
        </div>
      </Card>

      {/* Source trace card */}
      {hasSourceTrace && (
        <Card className="p-4 border-primary/20 bg-primary/5">
          <div className="flex items-start gap-3">
            <Server className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium">Fonte analítica detectada</p>
                <Badge variant="default" className="text-xs">{sourceTrace!.datasource_type}</Badge>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {sourceTrace!.datasource_server && (
                  <div><span className="font-medium text-foreground">Servidor:</span> {sourceTrace!.datasource_server}</div>
                )}
                {sourceTrace!.datasource_database && (
                  <div><span className="font-medium text-foreground">Banco:</span> {sourceTrace!.datasource_database}</div>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Manual table name input */}
      <Card className="p-4">
        <div className="space-y-3">
          <Label className="text-sm font-medium">Nome da tabela (seleção manual)</Label>
          <Input
            value={manualTableName}
            onChange={(e) => onManualTableNameChange(e.target.value)}
            placeholder="Ex: FactSales, DimCustomer, vw_churn_base"
          />
          <p className="text-xs text-muted-foreground">
            Informe o nome da tabela ou view que deseja usar do dataset Power BI. Este nome será usado para tentar extrair dados via DAX ou como referência para importação.
          </p>
        </div>
      </Card>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={onSelectTableManually}
          disabled={!manualTableName.trim()}
        >
          <TableProperties className="w-4 h-4 mr-1" />
          Selecionar tabela manualmente
        </Button>

        <Button variant="outline" size="sm" onClick={onRetryDiscovery} disabled={isRetrying}>
          {isRetrying ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
          Tentar discovery novamente
        </Button>

        {hasSourceTrace && (
          <Button variant="outline" size="sm" onClick={onUseDetectedSource}>
            <Link2 className="w-4 h-4 mr-1" />
            Usar fonte detectada
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={onImportFile}>
          <FileDown className="w-4 h-4 mr-1" />
          Importar metadados/exportação
        </Button>

        <Button variant="ghost" size="sm" onClick={onContinuePartial}>
          <ArrowRight className="w-4 h-4 mr-1" />
          Continuar com conexão parcial
        </Button>
      </div>
    </div>
  );
};

export default PowerBIManualAssistedPanel;
