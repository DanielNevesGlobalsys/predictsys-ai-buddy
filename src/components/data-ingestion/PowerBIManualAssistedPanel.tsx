import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CheckCircle, AlertTriangle, RefreshCw, Upload,
  Server, ArrowRight, Loader2, TableProperties, Link2, FileDown,
  ShieldCheck, Globe, Database as DatabaseIcon,
} from "lucide-react";
import PowerBIXMLADiagnosticPanel from "./PowerBIXMLADiagnosticPanel";

interface SourceTraceInfo {
  datasource_type: string | null;
  datasource_server: string | null;
  datasource_database: string | null;
  source_role?: "primary" | "auxiliary";
  confidence?: "high" | "medium" | "low";
}

type SubmissionStatus = "idle" | "submitting" | "success" | "error";

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
  onSelectTableManually: () => Promise<void> | void;
  isRetrying: boolean;
  submissionStatus?: SubmissionStatus;
  submissionError?: string | null;
  discoveredTables?: string[];
  authValid?: boolean;
  workspaceValid?: boolean;
  datasetValid?: boolean;
  projectId?: string;
  connectionId?: string;
  workspaceId?: string;
  datasetId?: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
}

const confidenceLabel: Record<string, string> = {
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

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
  submissionStatus = "idle",
  submissionError,
  discoveredTables,
  authValid = true,
  workspaceValid = true,
  datasetValid = true,
  projectId,
  connectionId,
  workspaceId,
  datasetId,
  clientId,
  clientSecret,
  tenantId,
}: PowerBIManualAssistedPanelProps) => {
  const isPartial = connectionStatus === "connected_partial_discovery";
  const isFull = connectionStatus === "connected_full_discovery";
  const hasSourceTrace = sourceTrace && sourceTrace.datasource_type;
  const isSubmitting = submissionStatus === "submitting";
  const isSuccess = submissionStatus === "success";
  const hasDetectedTables = discoveredTables && discoveredTables.length > 0;
  const isPrimary = sourceTrace?.source_role === "primary";

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
      {/* Section 1: Connection status checklist */}
      <Card className="p-4 border-border">
        <p className="text-sm font-medium mb-3">Status da conexão</p>
        <div className="space-y-1.5">
          <StatusLine ok={authValid} label="Azure AD conectado" />
          <StatusLine ok={workspaceValid} label="Workspace acessível" />
          <StatusLine ok={datasetValid} label="Dataset encontrado" />
          <StatusLine ok={discoveryAvailable} label="Discovery automático completo" warn />
        </div>
        {semanticModelType && (
          <Badge variant="secondary" className="mt-3 text-xs">Modelo semântico: {semanticModelType}</Badge>
        )}
      </Card>

      {/* Section 2: Source trace */}
      {hasSourceTrace && (
        <Card className={`p-4 ${isPrimary ? 'border-primary/20 bg-primary/5' : 'border-muted bg-muted/30'}`}>
          <div className="flex items-start gap-3">
            <Server className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium">
                  {isPrimary ? 'Fonte principal detectada' : 'Fonte auxiliar detectada'}
                </p>
                <Badge variant="default" className="text-xs">{sourceTrace!.datasource_type}</Badge>
                {sourceTrace!.confidence && (
                  <Badge variant="outline" className="text-xs">
                    Confiança: {confidenceLabel[sourceTrace!.confidence] || sourceTrace!.confidence}
                  </Badge>
                )}
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

      {/* Success banner */}
      {isSuccess && (
        <Card className="p-4 bg-accent/10 border-accent/30">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-accent mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-sm text-accent">Tabela manual selecionada com sucesso</p>
              <p className="text-sm text-muted-foreground mt-1">
                Dataset ativo registrado para o projeto. Você pode avançar para a próxima etapa.
              </p>
              <Badge variant="default" className="mt-2 text-xs">Dataset manual ativo</Badge>
            </div>
          </div>
        </Card>
      )}

      {/* Section 3: Table selection - 3 modes */}
      <Card className="p-4">
        <div className="space-y-3">
          <Label className="text-sm font-medium">Seleção da tabela</Label>
          <p className="text-xs text-muted-foreground">{message}</p>

          {/* Mode 1: Detected tables dropdown */}
          {hasDetectedTables && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Tabelas detectadas no semantic model</Label>
              <Select
                value={manualTableName}
                onValueChange={onManualTableNameChange}
                disabled={isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione uma tabela detectada" />
                </SelectTrigger>
                <SelectContent>
                  {discoveredTables!.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5">
                <DatabaseIcon className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {discoveredTables!.length} tabela(s) detectada(s)
                </span>
              </div>
            </div>
          )}

          {/* Mode 2: Manual text input */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              {hasDetectedTables ? 'Ou informe manualmente' : 'Informe o nome da tabela do semantic model'}
            </Label>
            <Input
              value={manualTableName}
              onChange={(e) => onManualTableNameChange(e.target.value)}
              placeholder="Ex: FactSales, DimCustomer, vw_churn_base"
              disabled={isSubmitting}
            />
          </div>

          {/* Inline error */}
          {submissionStatus === "error" && submissionError && (
            <p className="text-xs text-destructive font-medium">
              {submissionError}
            </p>
          )}
          {submissionStatus === "error" && !submissionError && (
            <p className="text-xs text-destructive font-medium">
              Informe o nome da tabela manualmente antes de continuar.
            </p>
          )}
        </div>
      </Card>

      {/* Connection status badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-xs">
          Conexão parcial utilizável
        </Badge>
        {isSuccess && (
          <Badge variant="default" className="text-xs bg-accent text-accent-foreground">
            Dataset manual ativo
          </Badge>
        )}
      </div>

      {/* XMLA Diagnostic Panel */}
      {projectId && (
        <PowerBIXMLADiagnosticPanel
          projectId={projectId}
          connectionId={connectionId}
          workspaceId={workspaceId}
          datasetId={datasetId}
          clientId={clientId}
          clientSecret={clientSecret}
          tenantId={tenantId}
          tableName={manualTableName || undefined}
          onMaterializationSuccess={onContinuePartial}
        />
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={onSelectTableManually}
          disabled={!manualTableName.trim() || isSubmitting}
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <TableProperties className="w-4 h-4 mr-1" />
          )}
          {isSubmitting ? "Salvando..." : "Selecionar tabela manualmente"}
        </Button>

        <Button variant="outline" size="sm" onClick={onRetryDiscovery} disabled={isRetrying || isSubmitting}>
          {isRetrying ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
          Tentar discovery novamente
        </Button>

        {hasSourceTrace && (
          <Button variant="outline" size="sm" onClick={onUseDetectedSource} disabled={isSubmitting}>
            <Link2 className="w-4 h-4 mr-1" />
            Usar fonte detectada
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={onImportFile} disabled={isSubmitting}>
          <FileDown className="w-4 h-4 mr-1" />
          Importar metadados/exportação
        </Button>

        <Button variant="default" size="sm" onClick={onContinuePartial} disabled={isSubmitting || isRetrying}>
          {isRetrying ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-1" />}
          {isRetrying ? "Materializando dados..." : "Materializar e continuar"}
        </Button>
      </div>
    </div>
  );
};

/* Small status line component */
function StatusLine({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle className="w-4 h-4 text-accent flex-shrink-0" />
      ) : warn ? (
        <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
      ) : (
        <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />
      )}
      <span className={ok ? "text-foreground" : warn ? "text-yellow-600" : "text-destructive"}>
        {ok ? '✔' : '⚠'} {label}
      </span>
    </div>
  );
}

export default PowerBIManualAssistedPanel;
