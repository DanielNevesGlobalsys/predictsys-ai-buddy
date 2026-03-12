import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  CheckCircle,
  XCircle,
  SkipForward,
  Loader2,
  ChevronDown,
  Activity,
  Database,
  Table2,
  Columns3,
  FileSpreadsheet,
  Hash,
  Download,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

/* ── Types ── */

interface DiagnosticStep {
  step: string;
  label: string;
  status: "ok" | "fail" | "skip";
  detail: string;
  data?: unknown;
  duration_ms?: number;
}

interface DiagnosticSummary {
  auth_ok: boolean;
  workspace_ok: boolean;
  dataset_ok: boolean;
  tables_found: number;
  columns_found: number;
  sample_ok: boolean;
  row_count: number;
  all_ok: boolean;
}

interface IgnoredTable {
  name: string;
  reason: string;
  source_method: string;
}

interface CandidateTable {
  discovered_name: string;
  effective_name: string;
  source_method: string;
  business_score?: number;
}

interface TableDetail {
  columns_count: number;
  row_count: number;
  columns?: Array<{ name: string; type: string }>;
}

interface DiagnosticResult {
  xmla_endpoint: string | null;
  steps: DiagnosticStep[];
  summary: DiagnosticSummary;
  tables: string[];
  columns_by_table: Record<string, Array<{ name: string; type: string }>>;
  ignored_internal_tables?: IgnoredTable[];
  candidate_tables?: CandidateTable[];
  tables_detail?: Record<string, TableDetail>;
  discovered_table_name?: string | null;
  effective_query_table_name?: string | null;
  table_source_method?: string;
  columns_method?: string;
  sample_method?: string;
  row_count_method?: string;
  source_type_persisted?: string;
  raw_errors?: {
    columns?: unknown;
    sample?: unknown;
    row_count?: unknown;
  };
}

interface Props {
  projectId: string;
  connectionId?: string;
  workspaceId?: string;
  datasetId?: string;
  tableName?: string;
  onMaterializationSuccess?: () => void;
}

const stepIconMap: Record<string, React.ReactNode> = {
  A: <Zap className="w-4 h-4" />,
  B1: <Database className="w-4 h-4" />,
  B2: <Database className="w-4 h-4" />,
  C1: <Table2 className="w-4 h-4" />,
  C2: <Columns3 className="w-4 h-4" />,
  C2_MULTI: <Columns3 className="w-4 h-4" />,
  D: <FileSpreadsheet className="w-4 h-4" />,
  E: <Hash className="w-4 h-4" />,
  F: <Download className="w-4 h-4" />,
};

const statusColors = {
  ok: "text-accent",
  fail: "text-destructive",
  skip: "text-muted-foreground",
};

const classifyTable = (score?: number): { label: string; color: string } => {
  if (score == null) return { label: "table", color: "bg-muted text-muted-foreground" };
  if (score >= 15) return { label: "fact", color: "bg-primary/15 text-primary" };
  if (score >= 5) return { label: "dimension", color: "bg-secondary text-secondary-foreground" };
  if (score < 0) return { label: "calendar", color: "bg-muted text-muted-foreground" };
  return { label: "table", color: "bg-muted text-muted-foreground" };
};

/* ── Main Component ── */

export default function PowerBIXMLADiagnosticPanel({
  projectId,
  connectionId,
  workspaceId,
  datasetId,
  tableName,
  onMaterializationSuccess,
}: Props) {
  const [running, setRunning] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [canMaterialize, setCanMaterialize] = useState(false);
  const [materialized, setMaterialized] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"idle" | "discovered" | "validated" | "materialized">("idle");

  const toggleTable = (name: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    // Reset validation when selection changes
    if (phase === "validated") {
      setPhase("discovered");
      setCanMaterialize(false);
    }
  };

  const selectAll = (candidates: CandidateTable[]) => {
    const businessTables = candidates.filter((t) => (t.business_score ?? 0) > 0);
    setSelectedTables(new Set(businessTables.map((t) => t.effective_name)));
  };

  const deselectAll = () => setSelectedTables(new Set());

  const runDiagnostic = useCallback(
    async (overrideTables?: string[], doMaterialize = false) => {
      const tablesToUse = overrideTables || Array.from(selectedTables);

      if (doMaterialize && tablesToUse.length === 0) {
        toast.error("Selecione ao menos uma tabela antes de materializar.");
        return;
      }

      if (doMaterialize) setMaterializing(true);
      else setRunning(true);

      try {
        const body: Record<string, unknown> = {
          project_id: projectId,
          connection_id: connectionId,
          workspace_id: workspaceId,
          dataset_id: datasetId,
          materialize: doMaterialize,
        };

        // Send table_names for multi-table, table_name for single (backward compat)
        if (tablesToUse.length === 1) {
          body.table_name = tablesToUse[0];
        } else if (tablesToUse.length > 1) {
          body.table_names = tablesToUse;
        } else if (tableName) {
          body.table_name = tableName;
        }

        const { data, error } = await supabase.functions.invoke("debug-powerbi-xmla", { body });

        if (error) throw error;

        if (data?.diagnostic) {
          setResult(data.diagnostic);
          setCanMaterialize(data.can_materialize || false);
          setMaterialized(data.materialized || false);

          if (data.materialized) {
            setPhase("materialized");
            toast.success("Dataset materializado com schema real.");
            onMaterializationSuccess?.();
          } else if (
            (data.diagnostic.tables_detail && Object.keys(data.diagnostic.tables_detail).length > 0) ||
            (data.diagnostic.summary?.columns_found > 0 && data.diagnostic.summary?.row_count > 0)
          ) {
            setPhase("validated");
          } else if ((data.diagnostic.candidate_tables?.length ?? 0) > 0) {
            setPhase("discovered");
            // Auto-select business tables if nothing selected
            if (selectedTables.size === 0 && data.diagnostic.candidate_tables?.length) {
              const autoSelect = data.diagnostic.candidate_tables
                .filter((t: CandidateTable) => (t.business_score ?? 0) > 0)
                .map((t: CandidateTable) => t.effective_name);
              if (autoSelect.length > 0) {
                setSelectedTables(new Set(autoSelect));
              }
            }
          }
        } else if (!data?.success) {
          toast.error(data?.error || "Diagnóstico falhou");
          if (data?.steps) {
            setResult({
              xmla_endpoint: null,
              steps: data.steps,
              summary: {} as DiagnosticSummary,
              tables: [],
              columns_by_table: {},
            });
          }
        }
      } catch (err) {
        console.error("[xmla-diagnostic]", err);
        toast.error("Erro ao executar diagnóstico XMLA");
      } finally {
        setRunning(false);
        setMaterializing(false);
      }
    },
    [projectId, connectionId, workspaceId, datasetId, tableName, selectedTables, onMaterializationSuccess],
  );

  const toggleStep = (step: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      next.has(step) ? next.delete(step) : next.add(step);
      return next;
    });
  };

  const candidates = result?.candidate_tables ?? [];
  const hasCandidates = candidates.length > 0;
  const tablesDetail = result?.tables_detail ?? {};
  const selectedCount = selectedTables.size;

  return (
    <Card className="p-4 border-border space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <p className="text-sm font-medium">Diagnóstico XMLA</p>
          {phase === "materialized" && (
            <Badge className="bg-accent text-accent-foreground text-xs ml-2">Materializado ✔</Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => runDiagnostic(undefined, false)}
          disabled={running || materializing}
        >
          {running ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
          {phase === "idle" ? "Descobrir tabelas" : "Re-executar diagnóstico"}
        </Button>
      </div>

      {/* Idle state */}
      {phase === "idle" && !running && (
        <p className="text-xs text-muted-foreground">
          Clique em "Descobrir tabelas" para listar as tabelas reais do modelo semântico.
          Tabelas técnicas, de calendário e medidas serão filtradas automaticamente.
        </p>
      )}

      {/* Summary badges */}
      {result && (
        <div className="flex flex-wrap gap-2">
          <SummaryBadge ok={result.summary.auth_ok} label="Auth" />
          <SummaryBadge ok={result.summary.workspace_ok} label="Workspace" />
          <SummaryBadge ok={result.summary.dataset_ok} label="Dataset" />
          <SummaryBadge ok={result.summary.tables_found > 0} label={`${result.summary.tables_found} tabelas`} />
          {phase === "validated" && (
            <>
              <SummaryBadge ok={result.summary.columns_found > 0} label={`${result.summary.columns_found} colunas`} />
              <SummaryBadge ok={result.summary.sample_ok} label="Amostra" />
              <SummaryBadge ok={result.summary.row_count > 0} label={`${result.summary.row_count} linhas`} />
            </>
          )}
        </div>
      )}

      {/* ── MULTI-TABLE SELECTOR ── */}
      {hasCandidates && phase !== "materialized" && (
        <div className="rounded-lg border-2 border-primary/30 p-4 bg-primary/5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Table2 className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold">Selecione as tabelas de negócio</p>
              <Badge variant="outline" className="text-xs">{selectedCount} selecionada(s)</Badge>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => selectAll(candidates)}>
                Selecionar negócio
              </Button>
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={deselectAll}>
                Limpar
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {candidates.length} tabela(s) real(is) encontrada(s). Selecione uma ou mais tabelas para materializar no dataset.
          </p>

          {/* Table list with checkboxes */}
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {candidates.map((t) => {
              const isSelected = selectedTables.has(t.effective_name);
              const classification = classifyTable(t.business_score);
              const detail = tablesDetail[t.effective_name];

              return (
                <label
                  key={t.effective_name}
                  className={`flex items-center gap-3 py-2 px-3 rounded-md cursor-pointer transition-colors ${
                    isSelected ? "bg-primary/10 border border-primary/30" : "hover:bg-muted/50 border border-transparent"
                  }`}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleTable(t.effective_name)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{t.effective_name}</span>
                      <Badge className={`text-[10px] px-1.5 py-0 ${classification.color}`}>
                        {classification.label}
                      </Badge>
                    </div>
                    {detail && (
                      <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
                        <span>{detail.columns_count ?? detail.columns?.length ?? "?"} colunas</span>
                        <span>{detail.row_count?.toLocaleString() ?? "?"} linhas</span>
                      </div>
                    )}
                  </div>
                  {t.business_score != null && (
                    <span className="text-muted-foreground text-[10px] whitespace-nowrap">
                      score: {t.business_score}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          {/* Action buttons */}
          {selectedCount > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {phase === "discovered" && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => runDiagnostic(Array.from(selectedTables), false)}
                  disabled={running || materializing}
                >
                  {running ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Columns3 className="w-4 h-4 mr-1" />}
                  Validar {selectedCount} tabela(s)
                </Button>
              )}
              {phase === "validated" && canMaterialize && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => runDiagnostic(Array.from(selectedTables), true)}
                  disabled={running || materializing}
                >
                  {materializing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
                  {materializing ? "Materializando..." : `Materializar ${selectedCount} tabela(s)`}
                </Button>
              )}
            </div>
          )}

          {selectedCount === 0 && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="w-3.5 h-3.5" />
              Selecione ao menos uma tabela para continuar.
            </div>
          )}
        </div>
      )}

      {/* ── MATERIALIZATION SUCCESS CARD ── */}
      {phase === "materialized" && (
        <div className="rounded-lg border-2 border-accent/40 p-4 bg-accent/5 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-accent" />
            <p className="text-sm font-semibold text-accent">Materialização concluída</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">Tabelas</p>
              <p className="font-semibold">{selectedCount || 1}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Colunas</p>
              <p className="font-semibold">{result?.summary.columns_found ?? 0}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Linhas</p>
              <p className="font-semibold">{result?.summary.row_count ?? 0}</p>
            </div>
            <div>
              <p className="text-muted-foreground">source_type</p>
              <p className="font-semibold">{result?.source_type_persisted ?? "powerbi"}</p>
            </div>
          </div>
          {/* Per-table detail */}
          {Object.keys(tablesDetail).length > 1 && (
            <div className="mt-2 space-y-1">
              {Object.entries(tablesDetail).map(([name, detail]) => (
                <div key={name} className="flex items-center gap-2 text-xs">
                  <CheckCircle className="w-3 h-3 text-accent" />
                  <span className="font-medium">{name}</span>
                  <span className="text-muted-foreground">
                    {detail.columns_count ?? detail.columns?.length ?? 0} cols · {detail.row_count?.toLocaleString()} rows
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Badge variant="default" className="text-xs">project_datasets ✔</Badge>
            <Badge variant="default" className="text-xs">project_columns ✔</Badge>
            <Badge variant="default" className="text-xs">dataset_state ✔</Badge>
            <Badge variant="default" className="text-xs">schema_json ✔</Badge>
            <Badge variant="default" className="text-xs">EDA liberado ✔</Badge>
          </div>
        </div>
      )}

      {/* ── VALIDATED TABLE DETAILS ── */}
      {phase === "validated" && Object.keys(tablesDetail).length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Detalhes da validação:</p>
          {Object.entries(tablesDetail).map(([name, detail]) => (
            <div key={name} className="flex items-center gap-2 rounded border border-border p-2 text-xs bg-muted/20">
              <CheckCircle className="w-3.5 h-3.5 text-accent" />
              <span className="font-medium">{name}</span>
              <Badge variant="outline" className="text-[10px]">{detail.columns_count ?? detail.columns?.length ?? 0} colunas</Badge>
              <Badge variant="outline" className="text-[10px]">{detail.row_count?.toLocaleString()} linhas</Badge>
            </div>
          ))}
        </div>
      )}

      {/* Method badges */}
      {result && phase !== "idle" && result.columns_method && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline">Tabelas: {result.table_source_method || "-"}</Badge>
          <Badge variant="outline">Colunas: {result.columns_method || "-"}</Badge>
          <Badge variant="outline">Amostra: {result.sample_method || "-"}</Badge>
          <Badge variant="outline">Row count: {result.row_count_method || "-"}</Badge>
          {result.source_type_persisted && (
            <Badge variant="default" className="text-xs">source_type: {result.source_type_persisted}</Badge>
          )}
        </div>
      )}

      {/* Ignored tables */}
      {!!result?.ignored_internal_tables?.length && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className="w-3 h-3" />
            {result.ignored_internal_tables.length} tabela(s) interna(s) ocultada(s)
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="rounded border border-border p-2 bg-muted/20 text-xs mt-1">
              {result.ignored_internal_tables.map((t) => (
                <div key={t.name} className="flex items-center gap-2 py-0.5">
                  <span className="text-muted-foreground font-mono">{t.name}</span>
                  <Badge variant="outline" className="text-[10px]">{t.reason}</Badge>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Errors */}
      {result && (result.raw_errors?.columns || result.raw_errors?.sample || result.raw_errors?.row_count) && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-destructive hover:text-destructive/80">
            <ChevronDown className="w-3 h-3" />
            Erros brutos
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="rounded border border-destructive/40 p-2 bg-destructive/5 text-xs mt-1">
              <pre className="overflow-x-auto max-h-48 overflow-y-auto text-[11px] text-muted-foreground">
                {JSON.stringify(result.raw_errors, null, 2)}
              </pre>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Step accordion */}
      {result && result.steps.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className="w-3 h-3" />
            {result.steps.length} etapas do diagnóstico
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-1 mt-1">
              {result.steps.map((step) => (
                <Collapsible key={step.step} open={expandedSteps.has(step.step)} onOpenChange={() => toggleStep(step.step)}>
                  <CollapsibleTrigger className="w-full">
                    <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 transition-colors cursor-pointer w-full">
                      <span className={statusColors[step.status]}>
                        {step.status === "ok" ? (
                          <CheckCircle className="w-4 h-4" />
                        ) : step.status === "fail" ? (
                          <XCircle className="w-4 h-4" />
                        ) : (
                          <SkipForward className="w-4 h-4" />
                        )}
                      </span>
                      <span className="text-muted-foreground">{stepIconMap[step.step] || stepIconMap[step.step.replace(/_MULTI$/, "")]}</span>
                      <span className="text-xs font-medium flex-1 text-left">{step.label}</span>
                      {step.duration_ms !== undefined && <span className="text-xs text-muted-foreground">{step.duration_ms}ms</span>}
                      <ChevronDown
                        className={`w-3 h-3 text-muted-foreground transition-transform ${expandedSteps.has(step.step) ? "rotate-180" : ""}`}
                      />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-10 mb-2 text-xs text-muted-foreground space-y-1">
                      <p>{step.detail}</p>
                      {step.data && (
                        <pre className="bg-muted/30 rounded p-2 overflow-x-auto text-[11px] max-h-48 overflow-y-auto">
                          {JSON.stringify(step.data, null, 2)}
                        </pre>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Card>
  );
}

function SummaryBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? "default" : "destructive"} className="text-xs">
      {ok ? "✔" : "✖"} {label}
    </Badge>
  );
}
