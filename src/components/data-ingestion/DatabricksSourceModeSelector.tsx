import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AlertCircle, Table2, Code2, Loader2, Eye, Info, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface DatabricksSourceModeSelectorProps {
  formData: Record<string, string>;
  onFormDataChange: (field: string, value: string) => void;
  isLocked?: boolean;
  lockedReason?: string;
}

interface CatalogItem {
  name: string;
}

interface SchemaItem {
  name: string;
}

interface TableItem {
  name: string;
  type: string;
}

const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP',
  'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE',
  'EXECUTE', 'EXEC'
];

const DEFAULT_SQL_PLACEHOLDER = `SELECT
  *
FROM catalog.schema.table
WHERE status = 'ATIVO'
  AND dt_ref >= current_date() - interval 12 months`;

const DatabricksSourceModeSelector = ({
  formData,
  onFormDataChange,
  isLocked = false,
  lockedReason
}: DatabricksSourceModeSelectorProps) => {
  const { t } = useTranslation();
  
  const sourceMode = formData.source_mode || "table";
  const [catalogs, setCatalogs] = useState<CatalogItem[]>([]);
  const [schemas, setSchemas] = useState<SchemaItem[]>([]);
  const [tables, setTables] = useState<TableItem[]>([]);
  const [isLoadingCatalogs, setIsLoadingCatalogs] = useState(false);
  const [isLoadingSchemas, setIsLoadingSchemas] = useState(false);
  const [isLoadingTables, setIsLoadingTables] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [isPreviewingSQL, setIsPreviewingSQL] = useState(false);
  const [sqlPreviewData, setSqlPreviewData] = useState<{ columns: string[]; rows: any[][]; rowCount: number } | null>(null);

  // Validate SQL when it changes
  useEffect(() => {
    if (sourceMode === "sql" && formData.source_sql) {
      validateSQL(formData.source_sql);
    } else {
      setSqlError(null);
    }
  }, [formData.source_sql, sourceMode]);

  const validateSQL = (sql: string): boolean => {
    const trimmedSQL = sql.trim().toUpperCase();
    
    // Must start with SELECT
    if (!trimmedSQL.startsWith("SELECT")) {
      setSqlError(t("dataIngestion.databricksSource.errors.mustStartWithSelect"));
      return false;
    }
    
    // Check for forbidden keywords
    for (const keyword of FORBIDDEN_KEYWORDS) {
      // Look for keyword as a separate word (not part of another word)
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(sql)) {
        setSqlError(t("dataIngestion.databricksSource.errors.forbiddenKeyword", { keyword }));
        return false;
      }
    }
    
    setSqlError(null);
    return true;
  };

  const handleModeChange = (value: string) => {
    if (isLocked) return;
    onFormDataChange("source_mode", value);
    // Clear the other mode's data
    if (value === "table") {
      onFormDataChange("source_sql", "");
    } else {
      onFormDataChange("table_name", "");
    }
  };

  const loadCatalogs = async () => {
    if (!formData.host || !formData.http_path || !formData.access_token) return;
    
    setIsLoadingCatalogs(true);
    try {
      const { data, error } = await supabase.functions.invoke("test-databricks-connection", {
        body: {
          connector_type: "databricks",
          connection_config: {
            host: formData.host,
            http_path: formData.http_path,
            access_token: formData.access_token
          },
          list_catalogs: true
        }
      });

      if (error) throw error;
      if (data.catalogs) {
        setCatalogs(data.catalogs.map((c: string) => ({ name: c })));
      }
    } catch (error) {
      console.error("Error loading catalogs:", error);
    } finally {
      setIsLoadingCatalogs(false);
    }
  };

  const loadSchemas = async (catalog: string) => {
    if (!formData.host || !formData.http_path || !formData.access_token) return;
    
    setIsLoadingSchemas(true);
    try {
      const { data, error } = await supabase.functions.invoke("test-databricks-connection", {
        body: {
          connector_type: "databricks",
          connection_config: {
            host: formData.host,
            http_path: formData.http_path,
            access_token: formData.access_token,
            catalog
          },
          list_schemas: true
        }
      });

      if (error) throw error;
      if (data.schemas) {
        setSchemas(data.schemas.map((s: string) => ({ name: s })));
      }
    } catch (error) {
      console.error("Error loading schemas:", error);
    } finally {
      setIsLoadingSchemas(false);
    }
  };

  const loadTables = async (catalog: string, schema: string) => {
    if (!formData.host || !formData.http_path || !formData.access_token) return;
    
    setIsLoadingTables(true);
    try {
      const { data, error } = await supabase.functions.invoke("test-databricks-connection", {
        body: {
          connector_type: "databricks",
          connection_config: {
            host: formData.host,
            http_path: formData.http_path,
            access_token: formData.access_token,
            catalog,
            schema
          },
          list_tables: true
        }
      });

      if (error) throw error;
      if (data.tables) {
        setTables(data.tables.map((t: any) => typeof t === 'string' ? { name: t, type: 'table' } : t));
      }
    } catch (error) {
      console.error("Error loading tables:", error);
    } finally {
      setIsLoadingTables(false);
    }
  };

  const handleCatalogChange = (catalog: string) => {
    onFormDataChange("catalog", catalog);
    onFormDataChange("schema", "");
    onFormDataChange("table_name", "");
    setSchemas([]);
    setTables([]);
    loadSchemas(catalog);
  };

  const handleSchemaChange = (schema: string) => {
    onFormDataChange("schema", schema);
    onFormDataChange("table_name", "");
    setTables([]);
    loadTables(formData.catalog, schema);
  };

  const handleTableChange = (tableName: string) => {
    onFormDataChange("table_name", tableName);
    // Build full table name
    const fullName = formData.catalog && formData.schema 
      ? `${formData.catalog}.${formData.schema}.${tableName}`
      : tableName;
    onFormDataChange("source_table_full_name", fullName);
  };

  const handlePreviewSQL = async () => {
    if (!formData.source_sql || sqlError) return;
    
    setIsPreviewingSQL(true);
    setSqlPreviewData(null);
    
    try {
      const { data, error } = await supabase.functions.invoke("test-databricks-connection", {
        body: {
          connector_type: "databricks",
          connection_config: {
            host: formData.host,
            http_path: formData.http_path,
            access_token: formData.access_token,
            catalog: formData.catalog,
            schema: formData.schema
          },
          preview_sql: formData.source_sql,
          preview_limit: 10
        }
      });

      if (error) throw error;
      if (data.preview) {
        setSqlPreviewData(data.preview);
      } else if (data.error) {
        setSqlError(data.error);
      }
    } catch (error: any) {
      setSqlError(error.message || "Erro ao executar preview");
    } finally {
      setIsPreviewingSQL(false);
    }
  };

  // Auto-load catalogs when connection info is available
  useEffect(() => {
    if (formData.host && formData.http_path && formData.access_token && catalogs.length === 0) {
      loadCatalogs();
    }
  }, [formData.host, formData.http_path, formData.access_token]);

  const canLoadMetadata = formData.host && formData.http_path && formData.access_token;

  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-primary mb-1">
            {t("dataIngestion.databricksSource.title")}
          </p>
          <p className="text-muted-foreground">
            {t("dataIngestion.databricksSource.description")}
          </p>
        </div>
      </div>

      {/* Locked Warning */}
      {isLocked && (
        <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <Lock className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-400 mb-1">
              {t("dataIngestion.databricksSource.locked")}
            </p>
            <p className="text-amber-600 dark:text-amber-500">
              {lockedReason || t("dataIngestion.databricksSource.lockedReason")}
            </p>
          </div>
        </div>
      )}

      {/* Source Mode Selector */}
      <div className="space-y-3">
        <Label className="text-base font-semibold">
          {t("dataIngestion.databricksSource.sourceMode")}
        </Label>
        
        <RadioGroup
          value={sourceMode}
          onValueChange={handleModeChange}
          disabled={isLocked}
          className="grid grid-cols-2 gap-4"
        >
          <label
            className={`flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-all ${
              sourceMode === "table"
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            } ${isLocked ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            <RadioGroupItem value="table" id="mode-table" className="mt-1" />
            <div className="flex-1">
              <div className="flex items-center gap-2 font-medium">
                <Table2 className="w-4 h-4" />
                {t("dataIngestion.databricksSource.modeTable")}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("dataIngestion.databricksSource.modeTableDesc")}
              </p>
            </div>
          </label>

          <label
            className={`flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-all ${
              sourceMode === "sql"
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            } ${isLocked ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            <RadioGroupItem value="sql" id="mode-sql" className="mt-1" />
            <div className="flex-1">
              <div className="flex items-center gap-2 font-medium">
                <Code2 className="w-4 h-4" />
                {t("dataIngestion.databricksSource.modeSQL")}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("dataIngestion.databricksSource.modeSQLDesc")}
              </p>
            </div>
          </label>
        </RadioGroup>
      </div>

      {/* Table Mode */}
      {sourceMode === "table" && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Catalog Selector */}
          <div className="space-y-2">
            <Label>{t("dataIngestion.databricksSource.catalog")}</Label>
            <div className="flex gap-2">
              <Select
                value={formData.catalog || ""}
                onValueChange={handleCatalogChange}
                disabled={isLocked || !canLoadMetadata}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={t("dataIngestion.databricksSource.selectCatalog")} />
                </SelectTrigger>
                <SelectContent>
                  {catalogs.map((cat) => (
                    <SelectItem key={cat.name} value={cat.name}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isLoadingCatalogs && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
              {!isLoadingCatalogs && canLoadMetadata && catalogs.length === 0 && (
                <Button variant="outline" size="sm" onClick={loadCatalogs}>
                  {t("common.refresh")}
                </Button>
              )}
            </div>
          </div>

          {/* Schema Selector */}
          <div className="space-y-2">
            <Label>{t("dataIngestion.databricksSource.schema")}</Label>
            <div className="flex gap-2">
              <Select
                value={formData.schema || ""}
                onValueChange={handleSchemaChange}
                disabled={isLocked || !formData.catalog}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={t("dataIngestion.databricksSource.selectSchema")} />
                </SelectTrigger>
                <SelectContent>
                  {schemas.map((sch) => (
                    <SelectItem key={sch.name} value={sch.name}>
                      {sch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isLoadingSchemas && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
            </div>
          </div>

          {/* Table Selector */}
          <div className="space-y-2">
            <Label>{t("dataIngestion.databricksSource.table")}</Label>
            <div className="flex gap-2">
              <Select
                value={formData.table_name || ""}
                onValueChange={handleTableChange}
                disabled={isLocked || !formData.schema}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={t("dataIngestion.databricksSource.selectTable")} />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((tbl) => (
                    <SelectItem key={tbl.name} value={tbl.name}>
                      {tbl.name} {tbl.type === 'view' && '(view)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isLoadingTables && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
            </div>
          </div>

          {/* Generated Query Preview */}
          {formData.table_name && (
            <div className="p-3 bg-muted/50 rounded-lg border">
              <p className="text-xs text-muted-foreground mb-1">
                {t("dataIngestion.databricksSource.generatedQuery")}
              </p>
              <code className="text-xs font-mono text-foreground">
                SELECT * FROM {formData.source_table_full_name || formData.table_name}
              </code>
            </div>
          )}
        </div>
      )}

      {/* SQL Mode */}
      {sourceMode === "sql" && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* SQL Editor */}
          <div className="space-y-2">
            <Label>{t("dataIngestion.databricksSource.sqlQuery")}</Label>
            <Textarea
              value={formData.source_sql || ""}
              onChange={(e) => onFormDataChange("source_sql", e.target.value)}
              placeholder={DEFAULT_SQL_PLACEHOLDER}
              className="font-mono text-sm min-h-[200px] resize-y"
              disabled={isLocked}
            />
          </div>

          {/* SQL Warnings */}
          <div className="space-y-2">
            <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{t("dataIngestion.databricksSource.sqlOnlySelect")}</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{t("dataIngestion.databricksSource.sqlDefinesDataset")}</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{t("dataIngestion.databricksSource.sqlImpactWarning")}</span>
            </div>
          </div>

          {/* SQL Error */}
          {sqlError && (
            <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{sqlError}</span>
            </div>
          )}

          {/* Preview Button */}
          <Button
            variant="outline"
            onClick={handlePreviewSQL}
            disabled={!formData.source_sql || !!sqlError || isPreviewingSQL || !canLoadMetadata}
            className="w-full"
          >
            {isPreviewingSQL ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Eye className="w-4 h-4 mr-2" />
            )}
            {t("dataIngestion.databricksSource.previewSQL")}
          </Button>

          {/* SQL Preview Results */}
          {sqlPreviewData && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("dataIngestion.databricksSource.previewResults", { count: sqlPreviewData.rowCount })}
              </p>
              <div className="border rounded-lg overflow-auto max-h-[300px]">
                <table className="w-full text-xs">
                  <thead className="bg-muted sticky top-0">
                    <tr>
                      {sqlPreviewData.columns.map((col, i) => (
                        <th key={i} className="px-2 py-1 text-left font-medium border-b">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sqlPreviewData.rows.slice(0, 10).map((row, rowIdx) => (
                      <tr key={rowIdx} className="border-b last:border-0">
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx} className="px-2 py-1 truncate max-w-[200px]">
                            {cell === null ? <span className="text-muted-foreground italic">null</span> : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DatabricksSourceModeSelector;
