import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

interface DiagnosticResult {
  xmla_endpoint: string | null;
  steps: DiagnosticStep[];
  summary: DiagnosticSummary;
  tables: string[];
  columns_by_table: Record<string, Array<{ name: string; type: string }>>;
  ignored_internal_tables?: IgnoredTable[];
  candidate_tables?: CandidateTable[];
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
  D: <FileSpreadsheet className="w-4 h-4" />,
  E: <Hash className="w-4 h-4" />,
  F: <Download className="w-4 h-4" />,
};

const statusColors = {
  ok: "text-accent",
  fail: "text-destructive",
  skip: "text-muted-foreground",
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
  const [selectedTable, setSelectedTable] = useState<string>("");
  const [phase, setPhase] = useState<"idle" | "discovered" | "validated" | "materialized">("idle");

  const runDiagnostic = useCallback(
    async (overrideTable?: string, doMaterialize = false) => {
      const tableToUse = overrideTable || selectedTable || tableName;

      if (doMaterialize && !tableToUse) {
        toast.error("Selecione uma tabela antes de materializar.");
        return;
      }

      if (doMaterialize) setMaterializing(true);
      else setRunning(true);

      try {
        const { data, error } = await supabase.functions.invoke("debug-powerbi-xmla", {
          body: {
            project_id: projectId,
            connection_id: connectionId,
            workspace_id: workspaceId,
            dataset_id: datasetId,
            table_name: tableToUse || undefined,
            materialize: doMaterialize,
          },
        });

        if (error) throw error;

        if (data?.diagnostic) {
          setResult(data.diagnostic);
          setCanMaterialize(data.can_materialize || false);
          setMaterialized(data.materialized || false);

          // Determine phase
          if (data.materialized) {
            setPhase("materialized");
            toast.success("Dataset materializado com schema real.");
            onMaterializationSuccess?.();
          } else if (data.diagnostic.summary?.columns_found > 0 && data.diagnostic.summary?.row_count > 0) {
            setPhase("validated");
          } else if ((data.diagnostic.candidate_tables?.length ?? 0) > 0) {
            setPhase("discovered");
            // Auto-select best table if not already selected
            if (!selectedTable && data.diagnostic.candidate_tables?.length) {
              setSelectedTable(data.diagnostic.candidate_tables[0].effective_name);
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
    [projectId, connectionId, workspaceId, datasetId, tableName, selectedTable, onMaterializationSuccess],
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
  const effectiveTable = result?.effective_query_table_name;

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
          {selectedTable && (
            <>
              <SummaryBadge ok={result.summary.columns_found > 0} label={`${result.summary.columns_found} colunas`} />
              <SummaryBadge ok={result.summary.sample_ok} label="Amostra" />
              <SummaryBadge ok={result.summary.row_count > 0} label={`${result.summary.row_count} linhas`} />
            </>
          )}
        </div>
      )}

      {/* ── TABLE SELECTOR (primary UI) ── */}
      {hasCandidates && phase !== "materialized" && (
        <div className="rounded-lg border-2 border-primary/30 p-4 bg-primary/5 space-y-3">
          <div className="flex items-center gap-2">
            <Table2 className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold">Selecione a tabela de negócio</p>
          </div>
          <p className="text-xs text-muted-foreground">
            {candidates.length} tabela(s) real(is) encontrada(s). Tabelas internas, de calendário e medidas foram ocultadas.
            Selecione exatamente 1 tabela para materializar.
          </p>
          <Select
            value={selectedTable}
            onValueChange={(v) => {
              setSelectedTable(v);
              setPhase("discovered"); // reset validation when table changes
              setCanMaterialize(false);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Escolha a tabela alvo" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((t) => (
                <SelectItem key={t.effective_name} value={t.effective_name}>
                  <div className="flex items-center gap-2">
                    <span>{t.effective_name}</span>
                    {t.business_score != null && (
                      <span className="text-muted-foreground text-[10px]">
                        (relevância: {t.business_score > 10 ? "alta" : t.business_score > 0 ? "média" : "baixa"})
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Action buttons for selected table */}
          {selectedTable && (
            <div className="flex flex-wrap gap-2 pt-1">
              {phase === "discovered" && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => runDiagnostic(selectedTable, false)}
                  disabled={running || materializing}
                >
                  {running ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Columns3 className="w-4 h-4 mr-1" />}
                  Validar "{selectedTable}"
                </Button>
              )}
              {phase === "validated" && canMaterialize && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => runDiagnostic(selectedTable, true)}
                  disabled={running || materializing}
                >
                  {materializing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
                  {materializing ? "Materializando..." : `Materializar "${selectedTable}"`}
                </Button>
              )}
            </div>
          )}

          {!selectedTable && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="w-3.5 h-3.5" />
              Selecione uma tabela para continuar.
            </div>
          )}
        </div>
      )}

      {/* ── MATERIALIZATION SUCCESS CARD ── */}
      {phase === "materialized" && effectiveTable && (
        <div className="rounded-lg border-2 border-accent/40 p-4 bg-accent/5 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-accent" />
            <p className="text-sm font-semibold text-accent">Materialização concluída</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">Tabela</p>
              <p className="font-semibold">{effectiveTable}</p>
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
          <div className="flex flex-wrap gap-2 pt-1">
            <Badge variant="default" className="text-xs">project_datasets ✔</Badge>
            <Badge variant="default" className="text-xs">project_columns ✔</Badge>
            <Badge variant="default" className="text-xs">dataset_state ✔</Badge>
            <Badge variant="default" className="text-xs">schema_json ✔</Badge>
            <Badge variant="default" className="text-xs">EDA liberado ✔</Badge>
          </div>
        </div>
      )}

      {/* ── TABLE INFO (after validation) ── */}
      {result && effectiveTable && phase !== "idle" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
          <div className="rounded border border-border p-2 bg-muted/20">
            <p className="text-muted-foreground mb-1">Tabela descoberta</p>
            <p className="font-medium break-all">{result.discovered_table_name || "-"}</p>
          </div>
          <div className="rounded border border-border p-2 bg-muted/20">
            <p className="text-muted-foreground mb-1">Tabela efetiva (query)</p>
            <p className="font-medium break-all">{effectiveTable}</p>
          </div>
        </div>
      )}

      {/* Method badges */}
      {result && phase !== "idle" && (
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

      {/* Ignored tables (collapsed by default) */}
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
                      <span className="text-muted-foreground">{stepIconMap[step.step]}</span>
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
