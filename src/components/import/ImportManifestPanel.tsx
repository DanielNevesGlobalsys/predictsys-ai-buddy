import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  ChevronDown,
  FileSpreadsheet,
  Layers,
  AlertCircle,
  Info,
} from "lucide-react";

interface ManifestFile {
  file_id: string;
  file_name: string;
  format: string;
  size_mb: number;
  rows_detected: number;
  rows_loaded: number;
  cols_detected: number;
  schema_detected: Record<string, string>;
  null_pct_by_col: { col: string; pct: number }[];
  parse_warnings: string[];
  status: "ok" | "warn" | "fail";
  missing_cols: string[];
}

interface NullDiagnostic {
  column: string;
  null_pct: number;
  severity?: "ok" | "warning" | "critical";
  probable_cause: string;
  files_with_data: string[];
  is_critical_column?: boolean;
  critical_reason?: string;
}

interface ColumnMapping {
  canonical: string;
  type: string;
  sources: { file: string; original_col: string }[];
}

interface CoverageStats {
  critical_columns_pct: number;
  global_null_pct: number;
  top_10_null_columns: { column: string; null_pct: number }[];
  file_contribution: { file: string; rows: number; data_cols: number; null_only_cols: number; contribution_type: "data" | "mostly_null" }[];
}

interface CriticalColumnTag {
  column: string;
  reason: string;
  source: "intent_contract" | "heuristic";
}

interface ImportManifest {
  id: string;
  project_id: string;
  batch_id: string | null;
  created_at: string;
  total_files: number;
  files_ok: number;
  files_warn: number;
  files_fail: number;
  rows_sum: number;
  rows_consolidated: number;
  rows_difference: number;
  columns_final: number;
  canonical_schema: Record<string, string> & { _coverage_stats?: CoverageStats; _critical_columns?: CriticalColumnTag[] };
  column_mapping_report: ColumnMapping[];
  null_diagnostic: NullDiagnostic[];
  files: ManifestFile[];
  status: "ok" | "warn" | "fail" | "blocked";
  status_reason: string | null;
  eda_ready?: boolean;
  model_ready?: boolean;
  eda_strategy?: string;
  eda_scope?: string | null;
  blocked_reason_eda?: string | null;
  blocked_reason_model?: string | null;
}

interface ImportManifestPanelProps {
  projectId: string;
}

const ImportManifestPanel = ({ projectId }: ImportManifestPanelProps) => {
  const { t } = useTranslation();
  const [manifest, setManifest] = useState<ImportManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);

  useEffect(() => {
    loadManifest();
  }, [projectId]);

  const loadManifest = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("import_manifests")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!error && data) {
        setManifest(data as unknown as ImportManifest);
      }
    } catch {
      // No manifest yet
    }
    setLoading(false);
  };

  if (loading || !manifest) return null;

  const statusIcon = (s: string) => {
    if (s === "ok") return <CheckCircle className="w-4 h-4 text-accent" />;
    if (s === "warn") return <AlertTriangle className="w-4 h-4 text-amber-500" />;
    return <XCircle className="w-4 h-4 text-destructive" />;
  };

  const statusBadge = (s: string) => {
    if (s === "ok") return <Badge className="bg-accent/20 text-accent border-accent/30">APPROVED</Badge>;
    if (s === "warn") return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">APPROVED</Badge>;
    if (s === "blocked") return <Badge variant="destructive">BLOCKED</Badge>;
    return <Badge variant="destructive">FAIL</Badge>;
  };

  const edaBadge = () => {
    if (manifest!.eda_ready === false) return <Badge variant="destructive">EDA: BLOCKED</Badge>;
    if (manifest!.status === "warn") return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">EDA: WARN</Badge>;
    return <Badge className="bg-accent/20 text-accent border-accent/30">EDA: OK</Badge>;
  };

  const modelBadge = () => {
    if (manifest!.model_ready === false) return <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">MODEL: BLOCKED</Badge>;
    return <Badge className="bg-accent/20 text-accent border-accent/30">MODEL: OK</Badge>;
  };

  const nullSeverityIcon = (severity?: string) => {
    if (severity === "critical") return <span title=">50% NULL" className="text-destructive">🔴</span>;
    if (severity === "warning") return <span title="30-50% NULL" className="text-amber-500">🟡</span>;
    return <span title="<30% NULL" className="text-accent">🟢</span>;
  };

  const files = (manifest.files || []) as ManifestFile[];
  const nullDiag = (manifest.null_diagnostic || []) as NullDiagnostic[];
  const colMapping = (manifest.column_mapping_report || []) as ColumnMapping[];
  const rawSchema = manifest.canonical_schema || {};
  const coverageStats = (rawSchema as any)._coverage_stats as CoverageStats | undefined;
  const criticalColumns = (rawSchema as any)._critical_columns as CriticalColumnTag[] | undefined;
  const schema = Object.fromEntries(Object.entries(rawSchema).filter(([k]) => !k.startsWith("_"))) as Record<string, string>;

  return (
    <Card className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-sm">
            {t("dataIngestion.manifest.title", { defaultValue: "Resumo de Importação" })}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {edaBadge()}
          {modelBadge()}
          <span className="text-xs text-muted-foreground">
            {new Date(manifest.created_at).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Status reason */}
      {manifest.status !== "ok" && manifest.status_reason && (
        <div className={`flex items-start gap-2 p-3 border rounded-lg text-sm ${
          manifest.status === "blocked"
            ? "bg-destructive/10 border-destructive/30"
            : "bg-destructive/10 border-destructive/30"
        }`}>
          <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <span className="text-destructive">{manifest.status_reason}</span>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 bg-muted/30 rounded-lg text-center">
          <p className="text-2xl font-bold">{manifest.total_files}</p>
          <p className="text-xs text-muted-foreground">
            {t("dataIngestion.manifest.files", { defaultValue: "Arquivos" })}
          </p>
        </div>
        <div className="p-3 bg-muted/30 rounded-lg text-center">
          <p className="text-2xl font-bold">{manifest.rows_sum.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">
            {t("dataIngestion.manifest.rowsSum", { defaultValue: "Σ Linhas" })}
          </p>
        </div>
        <div className="p-3 bg-muted/30 rounded-lg text-center">
          <p className="text-2xl font-bold">{manifest.rows_consolidated.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">
            {t("dataIngestion.manifest.rowsConsolidated", { defaultValue: "Linhas consolidadas" })}
          </p>
        </div>
        <div className="p-3 bg-muted/30 rounded-lg text-center">
          <p className="text-2xl font-bold">{manifest.columns_final}</p>
          <p className="text-xs text-muted-foreground">
            {t("dataIngestion.manifest.columns", { defaultValue: "Colunas finais" })}
          </p>
        </div>
      </div>

      {/* Coverage Stats */}
      {coverageStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 bg-muted/30 rounded-lg text-center">
            <p className={`text-2xl font-bold ${coverageStats.critical_columns_pct > 30 ? "text-destructive" : coverageStats.critical_columns_pct > 10 ? "text-amber-500" : ""}`}>
              {coverageStats.critical_columns_pct}%
            </p>
            <p className="text-xs text-muted-foreground">Colunas 🔴</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg text-center">
            <p className={`text-2xl font-bold ${coverageStats.global_null_pct > 30 ? "text-destructive" : coverageStats.global_null_pct > 15 ? "text-amber-500" : ""}`}>
              {coverageStats.global_null_pct}%
            </p>
            <p className="text-xs text-muted-foreground">Nulos global</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg text-center col-span-2">
            <div className="flex flex-wrap gap-1 justify-center">
              {coverageStats.file_contribution.map((fc, i) => (
                <Badge key={i} variant={fc.contribution_type === "data" ? "default" : "outline"} className="text-[10px]">
                  {fc.file.length > 15 ? fc.file.slice(0, 15) + "…" : fc.file}
                  {fc.contribution_type === "mostly_null" && " ⚠️"}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Contribuição por arquivo</p>
          </div>
        </div>
      )}

      {/* Top 10 Null Columns */}
      {coverageStats && coverageStats.top_10_null_columns.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors w-full">
            <ChevronDown className="w-4 h-4" />
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Top 10 colunas mais nulas
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="space-y-1">
              {coverageStats.top_10_null_columns.map((c, i) => {
                const critTag = criticalColumns?.find(ct => ct.column === c.column);
                return (
                  <div key={i} className="flex items-center justify-between p-1.5 bg-muted/30 rounded text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono truncate max-w-[150px]">{c.column}</span>
                      {critTag && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600">
                          {critTag.source === "intent_contract" ? "📋" : "🔍"} {critTag.reason}
                        </Badge>
                      )}
                    </div>
                    <span className={`font-mono ${c.null_pct > 50 ? "text-destructive" : c.null_pct >= 30 ? "text-amber-500" : "text-muted-foreground"}`}>
                      {c.null_pct}%
                    </span>
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Row difference warning */}
      {manifest.rows_difference > 0 && (
        <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <span>
            {t("dataIngestion.manifest.rowDifference", {
              diff: manifest.rows_difference.toLocaleString(),
              defaultValue: `Diferença de ${manifest.rows_difference.toLocaleString()} linhas entre somatório e consolidado (esperado em datasets com schemas divergentes).`,
            })}
          </span>
        </div>
      )}

      {/* Files table */}
      <ScrollArea className="max-h-[300px]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">
                {t("dataIngestion.manifest.file", { defaultValue: "Arquivo" })}
              </TableHead>
              <TableHead className="text-xs text-center">Status</TableHead>
              <TableHead className="text-xs text-right">
                {t("dataIngestion.manifest.rows", { defaultValue: "Linhas" })}
              </TableHead>
              <TableHead className="text-xs text-right">
                {t("dataIngestion.manifest.cols", { defaultValue: "Colunas" })}
              </TableHead>
              <TableHead className="text-xs text-right">%Nulos</TableHead>
              <TableHead className="text-xs">Warnings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((f, i) => {
              const avgNull = f.null_pct_by_col.length > 0
                ? (f.null_pct_by_col.reduce((s, c) => s + c.pct, 0) / f.null_pct_by_col.length).toFixed(1)
                : "0.0";
              return (
                <TableRow key={i}>
                  <TableCell className="text-xs font-medium">
                    <div className="flex items-center gap-1.5">
                      <FileSpreadsheet className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      <span className="truncate max-w-[150px]">{f.file_name}</span>
                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                        {f.format}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">{statusIcon(f.status)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {f.rows_loaded.toLocaleString()}
                    {f.rows_detected !== f.rows_loaded && (
                      <span className="text-muted-foreground"> / {f.rows_detected.toLocaleString()}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{f.cols_detected}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{avgNull}%</TableCell>
                  <TableCell className="text-xs">
                    {f.parse_warnings.length > 0 ? (
                      <span className="text-amber-600">{f.parse_warnings.length} aviso(s)</span>
                    ) : f.missing_cols.length > 0 ? (
                      <span className="text-muted-foreground">{f.missing_cols.length} col. ausente(s)</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ScrollArea>

      {/* NULL Diagnostics */}
      {nullDiag.length > 0 && (
        <Collapsible open={diagnosticOpen} onOpenChange={setDiagnosticOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors w-full">
            <ChevronDown className={`w-4 h-4 transition-transform ${diagnosticOpen ? "rotate-180" : ""}`} />
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            {t("dataIngestion.manifest.nullDiagnostic", {
              count: nullDiag.length,
              defaultValue: `Diagnóstico de NULLs (${nullDiag.length} colunas)`,
            })}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="space-y-2">
              {nullDiag.map((d, i) => (
                <div key={i} className={`p-2 border rounded text-xs space-y-1 ${
                  d.severity === "critical"
                    ? "bg-destructive/5 border-destructive/20"
                    : "bg-amber-500/5 border-amber-500/20"
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {nullSeverityIcon(d.severity)}
                      <span className="font-medium">{d.column}</span>
                      {d.is_critical_column && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600">
                          {d.critical_reason}
                        </Badge>
                      )}
                    </div>
                    <Badge variant="outline" className="text-[10px]">{d.null_pct.toFixed(1)}% null</Badge>
                  </div>
                  <p className="text-muted-foreground">{d.probable_cause}</p>
                  {d.files_with_data.length > 0 && (
                    <p className="text-muted-foreground">
                      Dados em: {d.files_with_data.join(", ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Schema report */}
      {Object.keys(schema).length > 0 && (
        <Collapsible open={schemaOpen} onOpenChange={setSchemaOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors w-full">
            <ChevronDown className={`w-4 h-4 transition-transform ${schemaOpen ? "rotate-180" : ""}`} />
            <Info className="w-4 h-4 text-primary" />
            {t("dataIngestion.manifest.schemaReport", {
              count: Object.keys(schema).length,
              defaultValue: `Schema consolidado (${Object.keys(schema).length} colunas)`,
            })}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
              {Object.entries(schema).map(([col, type]) => (
                <div key={col} className="flex items-center justify-between p-1.5 bg-muted/30 rounded text-xs">
                  <span className="truncate font-mono">{col}</span>
                  <Badge variant="outline" className="text-[10px] ml-1">{type}</Badge>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Column mapping report */}
      {colMapping.length > 0 && (
        <Collapsible open={mappingOpen} onOpenChange={setMappingOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors w-full">
            <ChevronDown className={`w-4 h-4 transition-transform ${mappingOpen ? "rotate-180" : ""}`} />
            <Layers className="w-4 h-4 text-primary" />
            {t("dataIngestion.manifest.columnMapping", {
              defaultValue: "Mapeamento de colunas equivalentes",
            })}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="space-y-1">
              {colMapping
                .filter((m) => m.sources.some((s) => s.original_col !== m.canonical))
                .map((m, i) => (
                  <div key={i} className="p-2 bg-muted/30 rounded text-xs">
                    <span className="font-mono font-medium">{m.canonical}</span>
                    <span className="text-muted-foreground"> ← </span>
                    {m.sources
                      .filter((s) => s.original_col !== m.canonical)
                      .map((s, j) => (
                        <span key={j}>
                          <span className="font-mono text-primary">{s.original_col}</span>
                          <span className="text-muted-foreground"> ({s.file})</span>
                          {j < m.sources.filter((s2) => s2.original_col !== m.canonical).length - 1 && ", "}
                        </span>
                      ))}
                  </div>
                ))}
              {colMapping.filter((m) => m.sources.some((s) => s.original_col !== m.canonical)).length === 0 && (
                <p className="text-xs text-muted-foreground p-2">
                  Todas as colunas possuem nomes idênticos entre os arquivos.
                </p>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Card>
  );
};

export default ImportManifestPanel;
