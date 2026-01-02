import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Database, Server, Key, Eye, EyeOff, TestTube, Loader2, CheckCircle, AlertCircle, Info, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../wizard/WizardContainer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface DatabaseConnectorSectionProps {
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
}

const DATABASE_TYPES = [
  { value: "postgresql", label: "PostgreSQL", icon: "🐘", defaultPort: 5432 },
  { value: "mysql", label: "MySQL", icon: "🐬", defaultPort: 3306 },
  { value: "sqlserver", label: "SQL Server", icon: "🔷", defaultPort: 1433 },
  { value: "oracle", label: "Oracle", icon: "🔴", defaultPort: 1521 },
];

const DatabaseConnectorSection = ({ projectData, saveProject, onDataReady }: DatabaseConnectorSectionProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  
  const [existingConnections, setExistingConnections] = useState<DataSource[]>([]);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  
  // Form state
  const [connectionName, setConnectionName] = useState("");
  const [dbType, setDbType] = useState("postgresql");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [useConnectionString, setUseConnectionString] = useState(false);
  const [isContinuous, setIsContinuous] = useState(false);
  const [incrementalKey, setIncrementalKey] = useState("");
  const [customQuery, setCustomQuery] = useState("");
  
  // Status
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadExistingConnections();
  }, []);

  useEffect(() => {
    const dbInfo = DATABASE_TYPES.find(db => db.value === dbType);
    if (dbInfo) {
      setPort(String(dbInfo.defaultPort));
    }
  }, [dbType]);

  const loadExistingConnections = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("data_sources")
      .select("*")
      .eq("user_id", user.id)
      .eq("source_type", "database")
      .order("created_at", { ascending: false });

    if (data) {
      setExistingConnections(data as DataSource[]);
    }
  };

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestMessage("");

    try {
      const { data, error } = await supabase.functions.invoke("test-db-connection", {
        body: {
          connector_type: dbType,
          connection_config: useConnectionString
            ? { connection_string: connectionString }
            : { host, port: parseInt(port), database, username, password }
        }
      });

      if (error) throw error;

      if (data.success) {
        setTestStatus("success");
        setTestMessage(t("dataIngestion.database.testSuccess"));
      } else {
        setTestStatus("error");
        setTestMessage(data.message || t("dataIngestion.database.testFailed"));
      }
    } catch (error: any) {
      setTestStatus("error");
      setTestMessage(error.message || t("dataIngestion.database.testFailed"));
    }
  };

  const handleSaveConnection = async () => {
    if (!connectionName.trim()) {
      toast({
        title: t("common.error"),
        description: t("dataIngestion.database.errors.nameRequired"),
        variant: "destructive"
      });
      return;
    }

    setIsSaving(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const connectionConfig = useConnectionString
        ? { connection_string: connectionString }
        : { host, port: parseInt(port), database, username, password };

      const { data, error } = await supabase
        .from("data_sources")
        .insert({
          user_id: user.id,
          name: connectionName,
          source_type: "database",
          connector_type: dbType,
          connection_config: connectionConfig,
          is_continuous: isContinuous,
          incremental_key: incrementalKey || null
        })
        .select()
        .single();

      if (error) throw error;

      toast({
        title: t("common.success"),
        description: t("dataIngestion.database.connectionSaved")
      });

      resetForm();
      setIsCreatingNew(false);
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

  const handleSelectConnection = async (connection: DataSource) => {
    if (!projectData.id) return;

    try {
      // Trigger data ingestion from this connection
      const { data, error } = await supabase.functions.invoke("ingest-database", {
        body: {
          project_id: projectData.id,
          data_source_id: connection.id,
          custom_query: customQuery || null
        }
      });

      if (error) throw error;

      await saveProject({
        data_source_id: connection.id as any,
        status: "data_uploaded"
      });

      toast({
        title: t("common.success"),
        description: t("dataIngestion.database.ingestionStarted")
      });

      onDataReady();
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive"
      });
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
        description: t("dataIngestion.database.connectionDeleted")
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

  const resetForm = () => {
    setConnectionName("");
    setDbType("postgresql");
    setHost("");
    setPort("5432");
    setDatabase("");
    setUsername("");
    setPassword("");
    setConnectionString("");
    setUseConnectionString(false);
    setIsContinuous(false);
    setIncrementalKey("");
    setTestStatus("idle");
    setTestMessage("");
  };

  const dbInfo = DATABASE_TYPES.find(db => db.value === dbType);

  return (
    <div className="space-y-6">
      {/* Info box */}
      <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-primary mb-1">{t("dataIngestion.database.title")}</p>
          <p className="text-muted-foreground">{t("dataIngestion.database.description")}</p>
        </div>
      </div>

      {/* Database type selector cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {DATABASE_TYPES.map((db) => (
          <button
            key={db.value}
            onClick={() => {
              setDbType(db.value);
              setIsCreatingNew(true);
            }}
            className={`p-4 rounded-lg border-2 transition-all text-left ${
              dbType === db.value && isCreatingNew
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/50"
            }`}
          >
            <span className="text-2xl mb-2 block">{db.icon}</span>
            <span className="font-medium text-sm">{db.label}</span>
          </button>
        ))}
      </div>

      {/* Existing connections */}
      {existingConnections.length > 0 && !isCreatingNew && (
        <div className="space-y-3">
          <h3 className="font-semibold">{t("dataIngestion.database.existingConnections")}</h3>
          <div className="space-y-2">
            {existingConnections.map((conn) => (
              <Card key={conn.id} className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Database className="w-5 h-5 text-primary" />
                  <div>
                    <p className="font-medium">{conn.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {DATABASE_TYPES.find(db => db.value === conn.connector_type)?.label || conn.connector_type}
                      {conn.is_continuous && ` • ${t("dataIngestion.database.continuous")}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleSelectConnection(conn)}
                  >
                    {t("dataIngestion.database.useConnection")}
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
            ))}
          </div>
        </div>
      )}

      {/* Connection form */}
      {isCreatingNew && (
        <Card className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <span className="text-xl">{dbInfo?.icon}</span>
              {t("dataIngestion.database.newConnection", { type: dbInfo?.label })}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => { setIsCreatingNew(false); resetForm(); }}>
              {t("common.cancel")}
            </Button>
          </div>

          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="connectionName">{t("dataIngestion.database.connectionName")}</Label>
              <Input
                id="connectionName"
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder={t("dataIngestion.database.connectionNamePlaceholder")}
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="useConnectionString"
                checked={useConnectionString}
                onCheckedChange={setUseConnectionString}
              />
              <Label htmlFor="useConnectionString">{t("dataIngestion.database.useConnectionString")}</Label>
            </div>

            {useConnectionString ? (
              <div className="space-y-2">
                <Label htmlFor="connectionString">{t("dataIngestion.database.connectionString")}</Label>
                <Input
                  id="connectionString"
                  type="password"
                  value={connectionString}
                  onChange={(e) => setConnectionString(e.target.value)}
                  placeholder="postgresql://user:password@host:5432/database"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="host">{t("dataIngestion.database.host")}</Label>
                  <div className="relative">
                    <Server className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="host"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="localhost"
                      className="pl-10"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="port">{t("dataIngestion.database.port")}</Label>
                  <Input
                    id="port"
                    type="number"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder={String(dbInfo?.defaultPort || 5432)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="database">{t("dataIngestion.database.databaseName")}</Label>
                  <Input
                    id="database"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="my_database"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="username">{t("dataIngestion.database.username")}</Label>
                  <Input
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="db_user"
                  />
                </div>

                <div className="col-span-2 space-y-2">
                  <Label htmlFor="password">{t("dataIngestion.database.password")}</Label>
                  <div className="relative">
                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="pl-10 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Advanced options */}
            <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-between">
                  {t("dataIngestion.database.advancedOptions")}
                  {isAdvancedOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-4">
                <div className="flex items-center gap-2">
                  <Switch
                    id="isContinuous"
                    checked={isContinuous}
                    onCheckedChange={setIsContinuous}
                  />
                  <Label htmlFor="isContinuous">{t("dataIngestion.database.continuousConnection")}</Label>
                </div>

                {isContinuous && (
                  <div className="space-y-2">
                    <Label htmlFor="incrementalKey">{t("dataIngestion.database.incrementalKey")}</Label>
                    <Input
                      id="incrementalKey"
                      value={incrementalKey}
                      onChange={(e) => setIncrementalKey(e.target.value)}
                      placeholder="updated_at"
                    />
                    <p className="text-xs text-muted-foreground">{t("dataIngestion.database.incrementalKeyHint")}</p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="customQuery">{t("dataIngestion.database.customQuery")}</Label>
                  <Textarea
                    id="customQuery"
                    value={customQuery}
                    onChange={(e) => setCustomQuery(e.target.value)}
                    placeholder="SELECT * FROM customers WHERE active = true"
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">{t("dataIngestion.database.customQueryHint")}</p>
                </div>
              </CollapsibleContent>
            </Collapsible>

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
                {t("dataIngestion.database.testConnection")}
              </Button>
              <Button
                onClick={handleSaveConnection}
                disabled={isSaving}
                className="flex-1"
              >
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t("dataIngestion.database.saveAndConnect")}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Empty state */}
      {existingConnections.length === 0 && !isCreatingNew && (
        <div className="text-center py-8 text-muted-foreground">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>{t("dataIngestion.database.noConnections")}</p>
          <p className="text-sm">{t("dataIngestion.database.selectTypeToStart")}</p>
        </div>
      )}
    </div>
  );
};

export default DatabaseConnectorSection;
