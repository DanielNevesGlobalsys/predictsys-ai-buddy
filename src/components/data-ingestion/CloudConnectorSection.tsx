import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Cloud, Zap, Key, Eye, EyeOff, TestTube, Loader2, CheckCircle, AlertCircle, Info, Trash2, ExternalLink, Pencil, Radar } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../wizard/WizardContainer";
import DatabricksSourceModeSelector from "./DatabricksSourceModeSelector";
import ExternalDiscoveryFlow from "./ExternalDiscoveryFlow";

interface CloudConnectorSectionProps {
  projectData: ProjectData;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onDataReady: () => void;
}

interface DataSource {
  id: string;
  name: string;
  source_type: string;
  connector_type: string;
  is_continuous: boolean;
  sync_status: string;
  last_sync_at: string | null;
  connection_config?: Record<string, any>;
}

const CLOUD_CONNECTORS = [
  { 
    category: "microsoft",
    label: "Microsoft",
    connectors: [
      { value: "powerbi", label: "Power BI", icon: "📊", description: "Connect to Power BI datasets" },
      { value: "azure_sql", label: "Azure SQL Database", icon: "🔷", description: "Azure-hosted SQL Server" },
      { value: "azure_synapse", label: "Azure Synapse", icon: "⚡", description: "Azure data warehouse" },
      { value: "azure_blob", label: "Azure Blob Storage", icon: "☁️", description: "Files in Azure Storage" },
    ]
  },
  { 
    category: "aws",
    label: "Amazon Web Services",
    connectors: [
      { value: "aws_rds", label: "Amazon RDS", icon: "🗄️", description: "Managed relational database" },
      { value: "aws_redshift", label: "Amazon Redshift", icon: "🔴", description: "Cloud data warehouse" },
      { value: "aws_s3", label: "Amazon S3", icon: "📦", description: "Files in S3 buckets" },
      { value: "aws_athena", label: "Amazon Athena", icon: "🔍", description: "Query S3 with SQL" },
    ]
  },
  { 
    category: "other",
    label: "Other Platforms",
    connectors: [
      { value: "databricks", label: "Databricks", icon: "🧱", description: "Lakehouse & SQL Analytics" },
      { value: "bigquery", label: "Google BigQuery", icon: "🔵", description: "Coming soon", disabled: true },
      { value: "snowflake", label: "Snowflake", icon: "❄️", description: "Coming soon", disabled: true },
    ]
  },
];

const CloudConnectorSection = ({ projectData, saveProject, onDataReady }: CloudConnectorSectionProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  
  const [existingConnections, setExistingConnections] = useState<DataSource[]>([]);
  const [selectedConnector, setSelectedConnector] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  
  // Form state - varies by connector
  const [connectionName, setConnectionName] = useState("");
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [isContinuous, setIsContinuous] = useState(false);
  
  // Status
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadExistingConnections();
  }, []);

  const loadExistingConnections = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("data_sources")
      .select("*")
      .eq("user_id", user.id)
      .eq("source_type", "cloud")
      .order("created_at", { ascending: false });

    if (data) {
      setExistingConnections(data as DataSource[]);
    }
  };

  const getConnectorInfo = (value: string) => {
    for (const category of CLOUD_CONNECTORS) {
      const connector = category.connectors.find(c => c.value === value);
      if (connector) return connector;
    }
    return null;
  };

  const handleSelectConnector = (value: string) => {
    setSelectedConnector(value);
    setFormData({});
    setConnectionName("");
    setEditingConnectionId(null);
    setTestStatus("idle");
    setTestMessage("");
  };

  const handleEditConnection = (conn: DataSource) => {
    setEditingConnectionId(conn.id);
    setSelectedConnector(conn.connector_type);
    setConnectionName(conn.name);
    setIsContinuous(conn.is_continuous);
    // Load connection_config into formData
    const config = conn.connection_config || {};
    const stringConfig: Record<string, string> = {};
    for (const [key, val] of Object.entries(config)) {
      stringConfig[key] = val != null ? String(val) : "";
    }
    setFormData(stringConfig);
    setTestStatus("idle");
    setTestMessage("");
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // Power BI partial discovery state
  const [pbiTestResult, setPbiTestResult] = useState<any>(null);
  const [manualTableName, setManualTableName] = useState("");

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestMessage("");
    setPbiTestResult(null);

    try {
      // Use specific function for Databricks
      const functionName = selectedConnector === "databricks" 
        ? "test-databricks-connection" 
        : "test-cloud-connection";
      
      const { data, error } = await supabase.functions.invoke(functionName, {
        body: {
          connector_type: selectedConnector,
          connection_config: formData
        }
      });

      if (error) throw error;

      // Power BI returns granular connection_status
      if (selectedConnector === "powerbi" && data.connection_status) {
        setPbiTestResult(data);
        if (data.success) {
          setTestStatus("success");
          setTestMessage(data.message);
          // Store manual table name if provided
          if (manualTableName.trim()) {
            setFormData(prev => ({ ...prev, table_name: manualTableName }));
          }
        } else {
          setTestStatus("error");
          setTestMessage(data.message);
        }
        return;
      }

      if (data.success) {
        setTestStatus("success");
        setTestMessage(t("dataIngestion.cloud.testSuccess"));
      } else {
        setTestStatus("error");
        setTestMessage(data.message || t("dataIngestion.cloud.testFailed"));
      }
    } catch (error: any) {
      setTestStatus("error");
      setTestMessage(error.message || t("dataIngestion.cloud.testFailed"));
    }
  };

  const handleSaveConnection = async () => {
    if (!connectionName.trim() || !selectedConnector) {
      toast({
        title: t("common.error"),
        description: t("dataIngestion.cloud.errors.nameRequired"),
        variant: "destructive"
      });
      return;
    }

    setIsSaving(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      if (editingConnectionId) {
        // Update existing connection
        const { error } = await supabase
          .from("data_sources")
          .update({
            name: connectionName,
            connector_type: selectedConnector,
            connection_config: formData,
            is_continuous: isContinuous
          })
          .eq("id", editingConnectionId);

        if (error) throw error;
      } else {
        // Insert new connection
        const { error } = await supabase
          .from("data_sources")
          .insert({
            user_id: user.id,
            name: connectionName,
            source_type: "cloud",
            connector_type: selectedConnector,
            connection_config: formData,
            is_continuous: isContinuous
          })
          .select()
          .single();

        if (error) throw error;
      }

      toast({
        title: t("common.success"),
        description: t("dataIngestion.cloud.connectionSaved")
      });

      setSelectedConnector(null);
      setEditingConnectionId(null);
      setFormData({});
      setConnectionName("");
      loadExistingConnections();
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive"
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Discovery flow state
  const [discoveryConnection, setDiscoveryConnection] = useState<DataSource | null>(null);

  const handleSelectConnection = async (connection: DataSource) => {
    if (!projectData.id) return;
    // Launch discovery flow instead of direct ingestion
    setDiscoveryConnection(connection);
  };

  const handleDirectImport = async (connection: DataSource) => {
    if (!projectData.id) return;
    try {
      const functionName = connection.connector_type === "databricks" ? "ingest-databricks" : "ingest-cloud-data";
      const { data, error } = await supabase.functions.invoke(functionName, {
        body: { project_id: projectData.id, data_source_id: connection.id }
      });
      if (error) throw error;
      await saveProject({ data_source_id: connection.id as any, status: "data_uploaded" });
      toast({ title: t("common.success"), description: t("dataIngestion.cloud.ingestionStarted") });
      onDataReady();
    } catch (error: any) {
      toast({ title: t("common.error"), description: error.message, variant: "destructive" });
    }
  };

  const handleDeleteConnection = async (id: string) => {
    try {
      const { error } = await supabase
        .from("data_sources")
        .delete()
        .eq("id", id);

      if (error) throw error;

      toast({
        title: t("common.success"),
        description: t("dataIngestion.cloud.connectionDeleted")
      });

      loadExistingConnections();
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const renderFormFields = () => {
    if (!selectedConnector) return null;

    switch (selectedConnector) {
      case "powerbi":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.powerbi.workspaceId")}</Label>
              <Input
                value={formData.workspace_id || ""}
                onChange={(e) => handleInputChange("workspace_id", e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.powerbi.datasetId")}</Label>
              <Input
                value={formData.dataset_id || ""}
                onChange={(e) => handleInputChange("dataset_id", e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.powerbi.tableName")}</Label>
              <Input
                value={formData.table_name || ""}
                onChange={(e) => handleInputChange("table_name", e.target.value)}
                placeholder={t("dataIngestion.cloud.powerbi.tableNamePlaceholder")}
              />
              <p className="text-xs text-muted-foreground">
                {t("dataIngestion.cloud.powerbi.tableNameHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.powerbi.clientId")}</Label>
              <Input
                value={formData.client_id || ""}
                onChange={(e) => handleInputChange("client_id", e.target.value)}
                placeholder={t("dataIngestion.cloud.powerbi.clientIdPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.powerbi.clientSecret")}</Label>
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.client_secret || ""}
                onChange={(e) => handleInputChange("client_secret", e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.powerbi.tenantId")}</Label>
              <Input
                value={formData.tenant_id || ""}
                onChange={(e) => handleInputChange("tenant_id", e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </div>
          </>
        );

      case "azure_sql":
      case "azure_synapse":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.serverName")}</Label>
              <Input
                value={formData.server || ""}
                onChange={(e) => handleInputChange("server", e.target.value)}
                placeholder="myserver.database.windows.net"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.database")}</Label>
              <Input
                value={formData.database || ""}
                onChange={(e) => handleInputChange("database", e.target.value)}
                placeholder="my_database"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.username")}</Label>
              <Input
                value={formData.username || ""}
                onChange={(e) => handleInputChange("username", e.target.value)}
                placeholder="db_user"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.password")}</Label>
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.password || ""}
                onChange={(e) => handleInputChange("password", e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </>
        );

      case "azure_blob":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.accountName")}</Label>
              <Input
                value={formData.account_name || ""}
                onChange={(e) => handleInputChange("account_name", e.target.value)}
                placeholder="mystorageaccount"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.containerName")}</Label>
              <Input
                value={formData.container || ""}
                onChange={(e) => handleInputChange("container", e.target.value)}
                placeholder="my-container"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.blobPath")}</Label>
              <Input
                value={formData.blob_path || ""}
                onChange={(e) => handleInputChange("blob_path", e.target.value)}
                placeholder="data/myfile.csv"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.azure.sasToken")}</Label>
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.sas_token || ""}
                onChange={(e) => handleInputChange("sas_token", e.target.value)}
                placeholder="sv=2021-06-08&ss=..."
              />
            </div>
          </>
        );

      case "aws_s3":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.bucketName")}</Label>
              <Input
                value={formData.bucket || ""}
                onChange={(e) => handleInputChange("bucket", e.target.value)}
                placeholder="my-bucket"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.objectKey")}</Label>
              <Input
                value={formData.key || ""}
                onChange={(e) => handleInputChange("key", e.target.value)}
                placeholder="path/to/file.csv"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.region")}</Label>
              <Input
                value={formData.region || ""}
                onChange={(e) => handleInputChange("region", e.target.value)}
                placeholder="us-east-1"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.accessKeyId")}</Label>
              <Input
                value={formData.access_key_id || ""}
                onChange={(e) => handleInputChange("access_key_id", e.target.value)}
                placeholder="AKIAIOSFODNN7EXAMPLE"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.secretAccessKey")}</Label>
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.secret_access_key || ""}
                onChange={(e) => handleInputChange("secret_access_key", e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </>
        );

      case "aws_rds":
      case "aws_redshift":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.endpoint")}</Label>
              <Input
                value={formData.endpoint || ""}
                onChange={(e) => handleInputChange("endpoint", e.target.value)}
                placeholder="myinstance.xxxx.region.rds.amazonaws.com"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.port")}</Label>
              <Input
                type="number"
                value={formData.port || "5432"}
                onChange={(e) => handleInputChange("port", e.target.value)}
                placeholder="5432"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.database")}</Label>
              <Input
                value={formData.database || ""}
                onChange={(e) => handleInputChange("database", e.target.value)}
                placeholder="my_database"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.username")}</Label>
              <Input
                value={formData.username || ""}
                onChange={(e) => handleInputChange("username", e.target.value)}
                placeholder="db_user"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.password")}</Label>
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.password || ""}
                onChange={(e) => handleInputChange("password", e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </>
        );

      case "aws_athena":
        return (
          <>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.region")}</Label>
              <Input
                value={formData.region || ""}
                onChange={(e) => handleInputChange("region", e.target.value)}
                placeholder="us-east-1"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.database")}</Label>
              <Input
                value={formData.database || ""}
                onChange={(e) => handleInputChange("database", e.target.value)}
                placeholder="my_database"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.s3OutputLocation")}</Label>
              <Input
                value={formData.s3_output || ""}
                onChange={(e) => handleInputChange("s3_output", e.target.value)}
                placeholder="s3://my-bucket/athena-results/"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.accessKeyId")}</Label>
              <Input
                value={formData.access_key_id || ""}
                onChange={(e) => handleInputChange("access_key_id", e.target.value)}
                placeholder="AKIAIOSFODNN7EXAMPLE"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.aws.secretAccessKey")}</Label>
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.secret_access_key || ""}
                onChange={(e) => handleInputChange("secret_access_key", e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </>
        );

      case "databricks":
        return (
          <>
            {/* Connection Settings */}
            <div className="space-y-4 pb-4 border-b border-border">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                {t("dataIngestion.cloud.databricks.connectionSettings")}
              </h4>
              <div className="space-y-2">
                <Label>{t("dataIngestion.cloud.databricks.host")}</Label>
                <Input
                  value={formData.host || ""}
                  onChange={(e) => handleInputChange("host", e.target.value)}
                  placeholder={t("dataIngestion.cloud.databricks.hostPlaceholder")}
                />
                <p className="text-xs text-muted-foreground">
                  {t("dataIngestion.cloud.databricks.hostHint")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t("dataIngestion.cloud.databricks.httpPath")}</Label>
                <Input
                  value={formData.http_path || ""}
                  onChange={(e) => handleInputChange("http_path", e.target.value)}
                  placeholder={t("dataIngestion.cloud.databricks.httpPathPlaceholder")}
                />
                <p className="text-xs text-muted-foreground">
                  {t("dataIngestion.cloud.databricks.httpPathHint")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t("dataIngestion.cloud.databricks.accessToken")}</Label>
                <Input
                  type={showPassword ? "text" : "password"}
                  value={formData.access_token || ""}
                  onChange={(e) => handleInputChange("access_token", e.target.value)}
                  placeholder="dapi..."
                />
                <p className="text-xs text-muted-foreground">
                  {t("dataIngestion.cloud.databricks.accessTokenHint")}
                </p>
              </div>
            </div>

            {/* Source Mode Selector */}
            <div className="pt-4">
              <DatabricksSourceModeSelector
                formData={formData}
                onFormDataChange={handleInputChange}
              />
            </div>
          </>
        );

      default:
        return (
          <div className="text-center py-4 text-muted-foreground">
            {t("dataIngestion.cloud.connectorNotYetImplemented")}
          </div>
        );
    }
  };

  const connectorInfo = selectedConnector ? getConnectorInfo(selectedConnector) : null;

  return (
    <div className="space-y-6">
      {/* Info box */}
      <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-primary mb-1">{t("dataIngestion.cloud.title")}</p>
          <p className="text-muted-foreground">{t("dataIngestion.cloud.description")}</p>
        </div>
      </div>

      {/* Connector categories */}
      {!selectedConnector && (
        <div className="space-y-6">
          {CLOUD_CONNECTORS.map((category) => (
            <div key={category.category} className="space-y-3">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                {category.label}
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {category.connectors.map((connector) => (
                  <button
                    key={connector.value}
                    onClick={() => !connector.disabled && handleSelectConnector(connector.value)}
                    disabled={connector.disabled}
                    className={`p-4 rounded-lg border-2 transition-all text-left ${
                      connector.disabled
                        ? "border-border bg-muted/30 opacity-50 cursor-not-allowed"
                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                    }`}
                  >
                    <span className="text-2xl mb-2 block">{connector.icon}</span>
                    <span className="font-medium text-sm block">{connector.label}</span>
                    <span className="text-xs text-muted-foreground">{connector.description}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Existing connections */}
      {existingConnections.length > 0 && !selectedConnector && (
        <div className="space-y-3">
          <h3 className="font-semibold">{t("dataIngestion.cloud.existingConnections")}</h3>
          <div className="space-y-2">
            {existingConnections.map((conn) => {
              const info = getConnectorInfo(conn.connector_type);
              return (
                <Card key={conn.id} className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{info?.icon || "☁️"}</span>
                    <div>
                      <p className="font-medium">{conn.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {info?.label || conn.connector_type}
                        {conn.is_continuous && ` • ${t("dataIngestion.cloud.continuous")}`}
                      </p>
                    </div>
                  </div>
                    <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleSelectConnection(conn)}
                    >
                      <Radar className="w-4 h-4 mr-1" />
                      Descobrir Objetos
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEditConnection(conn)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteConnection(conn.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Discovery Flow */}
      {discoveryConnection && projectData.id && (
        <ExternalDiscoveryFlow
          projectData={projectData}
          dataSourceId={discoveryConnection.id}
          connectorType={discoveryConnection.connector_type}
          connectionName={discoveryConnection.name}
          onDataReady={onDataReady}
        />
      )}

      {/* Connection form */}
      {selectedConnector && (
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <span className="text-xl">{connectorInfo?.icon}</span>
              {editingConnectionId 
                ? t("dataIngestion.cloud.editConnection", { type: connectorInfo?.label })
                : t("dataIngestion.cloud.newConnection", { type: connectorInfo?.label })}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => { setSelectedConnector(null); setEditingConnectionId(null); }}>
              {t("common.cancel")}
            </Button>
          </div>

          <div className="grid gap-4">
            <div className="space-y-2">
              <Label>{t("dataIngestion.cloud.connectionName")}</Label>
              <Input
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder={t("dataIngestion.cloud.connectionNamePlaceholder")}
              />
            </div>

            {renderFormFields()}

            <div className="flex items-center gap-2">
              <Switch
                id="showPassword"
                checked={showPassword}
                onCheckedChange={setShowPassword}
              />
              <Label htmlFor="showPassword">{t("dataIngestion.cloud.showSecrets")}</Label>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="isContinuous"
                checked={isContinuous}
                onCheckedChange={setIsContinuous}
              />
              <Label htmlFor="isContinuous">{t("dataIngestion.cloud.continuousConnection")}</Label>
            </div>

            {/* Test connection status */}
            {testMessage && (
              <div className={`flex items-start gap-3 p-3 rounded-lg ${
                testStatus === "success" 
                  ? "bg-accent/10 border border-accent/30" 
                  : "bg-destructive/10 border border-destructive/30"
              }`}>
                {testStatus === "success" ? (
                  <CheckCircle className="w-5 h-5 text-accent flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
                )}
                <p className={`text-sm ${testStatus === "success" ? "text-accent" : "text-destructive"}`}>
                  {testMessage}
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <Button
                variant="outline"
                onClick={handleTestConnection}
                disabled={testStatus === "testing"}
                className="flex-1"
              >
                {testStatus === "testing" ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <TestTube className="w-4 h-4 mr-2" />
                )}
                {t("dataIngestion.cloud.testConnection")}
              </Button>
              <Button
                onClick={handleSaveConnection}
                disabled={isSaving}
                className="flex-1"
              >
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t("dataIngestion.cloud.saveAndConnect")}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default CloudConnectorSection;
