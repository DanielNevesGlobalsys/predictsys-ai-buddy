import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Server, Database, Upload, Link2, Copy, ArrowRight, AlertTriangle, Info, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { SourceTrace } from "@/hooks/useExternalDiscovery";

interface SourceConnectionModalProps {
  open: boolean;
  onClose: () => void;
  sourceTrace: SourceTrace;
  projectId: string;
  onConnectionCreated: (connectionId: string) => void;
  onFallbackAction: (action: "upload" | "manual_sql") => void;
}

/** Maps datasource_type to a supported connector_type, or null if not directly ingestible */
function mapSourceToConnector(datasourceType: string | null): {
  connectorType: string | null;
  actionType: "auto_connect" | "manual_assist" | "not_supported";
  label: string;
} {
  if (!datasourceType) return { connectorType: null, actionType: "not_supported", label: "Desconhecido" };

  const t = datasourceType.toLowerCase();

  if (t.includes("databricks")) return { connectorType: "databricks", actionType: "auto_connect", label: "Databricks" };
  if (t.includes("azure_sql") || t.includes("azuresql")) return { connectorType: "sqlserver", actionType: "auto_connect", label: "Azure SQL" };
  if (t.includes("sql_server") || t.includes("sqlserver") || t === "sql") return { connectorType: "sqlserver", actionType: "auto_connect", label: "SQL Server" };
  if (t.includes("postgresql") || t.includes("postgres")) return { connectorType: "postgresql", actionType: "auto_connect", label: "PostgreSQL" };
  if (t.includes("mysql")) return { connectorType: "mysql", actionType: "auto_connect", label: "MySQL" };
  if (t.includes("snowflake")) return { connectorType: "snowflake", actionType: "auto_connect", label: "Snowflake" };
  if (t.includes("oracle")) return { connectorType: "oracle", actionType: "auto_connect", label: "Oracle" };
  if (t.includes("blob") || t.includes("s3") || t.includes("lake") || t.includes("adls") || t.includes("gcs")) {
    return { connectorType: "storage", actionType: "manual_assist", label: "Storage / Lake" };
  }
  if (t.includes("synapse") || t.includes("fabric")) return { connectorType: "sqlserver", actionType: "auto_connect", label: "Synapse / Fabric" };

  // Non-tabular / semantic layers
  if (t.includes("analysis_services") || t.includes("xmla") || t.includes("powerbi://") || t.includes("semantic")) {
    return { connectorType: null, actionType: "not_supported", label: "Camada analítica (Analysis Services)" };
  }

  return { connectorType: null, actionType: "manual_assist", label: datasourceType };
}

const SourceConnectionModal = ({
  open,
  onClose,
  sourceTrace,
  projectId,
  onConnectionCreated,
  onFallbackAction,
}: SourceConnectionModalProps) => {
  const { toast } = useToast();
  const mapping = mapSourceToConnector(sourceTrace.datasource_type);

  const [host, setHost] = useState(sourceTrace.datasource_server || "");
  const [database, setDatabase] = useState(sourceTrace.datasource_database || "");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const logEvent = async (eventType: string, metadata: Record<string, any> = {}) => {
    try {
      await Promise.resolve(
        supabase.from("platform_events").insert({
          event_type: eventType,
          project_id: projectId,
          source: "connector_powerbi",
          status: "info",
          metadata: {
            datasource_type: sourceTrace.datasource_type,
            mapped_connector: mapping.connectorType,
            action_type: mapping.actionType,
            ...metadata,
          },
        })
      );
    } catch { /* best-effort */ }
  };

  const handleAutoConnect = async () => {
    if (!host || !database) {
      toast({ title: "Preencha servidor e banco", variant: "destructive" });
      return;
    }

    setIsCreating(true);
    await logEvent("source_detected_connection_started");

    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Não autenticado");

      // Create the data source with pre-filled config
      const { data: ds, error: dsError } = await supabase.from("data_sources").insert({
        name: `${mapping.label} — ${database}`,
        source_type: "database",
        connector_type: mapping.connectorType!,
        user_id: userData.user.id,
        connection_config: {
          host,
          port: port ? parseInt(port, 10) : undefined,
          database,
          username,
          password,
          ssl: true,
          _origin: "powerbi_source_trace",
          _original_datasource_type: sourceTrace.datasource_type,
        },
      }).select("id").single();

      if (dsError) throw dsError;

      toast({ title: "Fonte criada com sucesso", description: `${mapping.label} — ${database}` });
      await logEvent("source_detected_connection_autofill_opened", { data_source_id: ds.id });
      onConnectionCreated(ds.id);
      onClose();
    } catch (err: any) {
      toast({ title: "Erro ao criar conexão", description: err.message, variant: "destructive" });
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyMetadata = () => {
    const text = [
      `Tipo: ${sourceTrace.datasource_type || "N/A"}`,
      `Servidor: ${sourceTrace.datasource_server || "N/A"}`,
      `Banco: ${sourceTrace.datasource_database || "N/A"}`,
      `Caminho: ${sourceTrace.datasource_path || "N/A"}`,
      `Modelo semântico: ${sourceTrace.semantic_model_type || "N/A"}`,
    ].join("\n");
    navigator.clipboard.writeText(text);
    toast({ title: "Metadados copiados" });
    logEvent("source_detected_manual_assist_opened", { action: "copy_metadata" });
  };

  // ─── AUTO-CONNECT UI ───
  if (mapping.actionType === "auto_connect") {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="w-5 h-5 text-primary" />
              Conectar {mapping.label}
            </DialogTitle>
            <DialogDescription>
              Dados detectados a partir do dataset Power BI. Complete as credenciais para conectar diretamente.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 mb-2">
            <Badge variant="default" className="text-xs">{mapping.label}</Badge>
            {sourceTrace.confidence && (
              <Badge variant="outline" className="text-xs">
                Confiança: {sourceTrace.confidence === "high" ? "Alta" : sourceTrace.confidence === "medium" ? "Média" : "Baixa"}
              </Badge>
            )}
          </div>

          <div className="grid gap-3">
            <div>
              <Label>Servidor / Host</Label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ex: myserver.database.windows.net" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Banco / Catálogo</Label>
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="ex: analytics_db" />
              </div>
              <div>
                <Label>Porta (opcional)</Label>
                <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="1433" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Usuário</Label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="user" />
              </div>
              <div>
                <Label>Senha</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button onClick={handleAutoConnect} disabled={isCreating}>
              {isCreating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-1" />}
              Criar conexão e descobrir
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── NOT SUPPORTED / MANUAL ASSIST UI ───
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-600" />
            Fonte não conectável diretamente
          </DialogTitle>
          <DialogDescription>
            {mapping.actionType === "not_supported"
              ? "Detectamos uma camada analítica (Analysis Services / semantic model). Para ingestão estável no PredictSys, conecte a fonte SQL/Lake subjacente ou importe um arquivo exportado."
              : `A fonte detectada (${mapping.label}) requer configuração manual. Use os metadados abaixo para conectar.`}
          </DialogDescription>
        </DialogHeader>

        {/* Detected metadata card */}
        <Card className="p-4 bg-muted/30">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div className="grid gap-1 text-sm text-muted-foreground">
              {sourceTrace.datasource_type && <div><span className="font-medium text-foreground">Tipo:</span> {sourceTrace.datasource_type}</div>}
              {sourceTrace.datasource_server && <div><span className="font-medium text-foreground">Servidor:</span> {sourceTrace.datasource_server}</div>}
              {sourceTrace.datasource_database && <div><span className="font-medium text-foreground">Banco:</span> {sourceTrace.datasource_database}</div>}
              {sourceTrace.datasource_path && <div><span className="font-medium text-foreground">Caminho:</span> {sourceTrace.datasource_path}</div>}
              {sourceTrace.semantic_model_type && <div><span className="font-medium text-foreground">Modelo:</span> {sourceTrace.semantic_model_type}</div>}
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-2 mt-2">
          <Button variant="outline" size="sm" onClick={() => { logEvent("source_detected_manual_assist_opened", { action: "manual_sql" }); onFallbackAction("manual_sql"); onClose(); }}>
            <Database className="w-3 h-3 mr-1" />
            Conectar fonte SQL/Lake manualmente
          </Button>
          <Button variant="outline" size="sm" onClick={() => { logEvent("source_detected_manual_assist_opened", { action: "upload" }); onFallbackAction("upload"); onClose(); }}>
            <Upload className="w-3 h-3 mr-1" />
            Importar arquivo exportado
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCopyMetadata}>
            <Copy className="w-3 h-3 mr-1" />
            Copiar metadados detectados
          </Button>
        </div>

        <div className="flex justify-end mt-2">
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export { mapSourceToConnector };
export default SourceConnectionModal;
