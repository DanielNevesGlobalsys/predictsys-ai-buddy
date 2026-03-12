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
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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

  const runDiagnostic = useCallback(
    async (doMaterialize = false) => {
      if (doMaterialize) setMaterializing(true);
      else setRunning(true);

      try {
        const { data, error } = await supabase.functions.invoke("debug-powerbi-xmla", {
          body: {
            project_id: projectId,
            connection_id: connectionId,
            workspace_id: workspaceId,
            dataset_id: datasetId,
            table_name: selectedTable || tableName,
            materialize: doMaterialize,
          },
        });

        if (error) throw error;

        if (data?.diagnostic) {
          setResult(data.diagnostic);
          setCanMaterialize(data.can_materialize || false);
          setMaterialized(data.materialized || false);

          if (data.materialized) {
            toast.success("Dataset materializado com schema real.");
            onMaterializationSuccess?.();
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
    [projectId, connectionId, workspaceId, datasetId, tableName, onMaterializationSuccess],
  );

  const toggleStep = (step: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      next.has(step) ? next.delete(step) : next.add(step);
      return next;
    });
  };

  return (
    <Card className="p-4 border-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <p className="text-sm font-medium">Diagnóstico XMLA</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => runDiagnostic(false)} disabled={running || materializing}>
            {running ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
            {running ? "Executando..." : "Executar diagnóstico"}
          </Button>
          {canMaterialize && !materialized && (
            <Button variant="default" size="sm" onClick={() => runDiagnostic(true)} disabled={running || materializing}>
              {materializing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
              {materializing ? "Materializando..." : "Materializar dataset"}
            </Button>
          )}
        </div>
      </div>

      {!result && !running && (
        <p className="text-xs text-muted-foreground">Executa validação real: Auth → Workspace → Dataset → Tabelas reais → Colunas → Amostra → Row count.</p>
      )}

      {result && (
        <div className="space-y-3 mt-2">
          <div className="flex flex-wrap gap-2">
            <SummaryBadge ok={result.summary.auth_ok} label="Auth" />
            <SummaryBadge ok={result.summary.workspace_ok} label="Workspace" />
            <SummaryBadge ok={result.summary.dataset_ok} label="Dataset" />
            <SummaryBadge ok={result.summary.tables_found > 0} label={`${result.summary.tables_found} tabelas`} />
            <SummaryBadge ok={result.summary.columns_found > 0} label={`${result.summary.columns_found} colunas`} />
            <SummaryBadge ok={result.summary.sample_ok} label="Amostra" />
            <SummaryBadge ok={result.summary.row_count > 0} label={`RowCount ${result.summary.row_count || 0}`} />
            {materialized && <Badge className="bg-accent text-accent-foreground text-xs">Materializado ✔</Badge>}
          </div>

          {result.xmla_endpoint && (
            <div className="text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1 break-all">{result.xmla_endpoint}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            <div className="rounded border border-border p-2 bg-muted/20">
              <p className="text-muted-foreground mb-1">Tabela descoberta</p>
              <p className="font-medium break-all">{result.discovered_table_name || "-"}</p>
            </div>
            <div className="rounded border border-border p-2 bg-muted/20">
              <p className="text-muted-foreground mb-1">Tabela usada na query</p>
              <p className="font-medium break-all">{result.effective_query_table_name || "-"}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Source método: {result.table_source_method || "-"}</Badge>
            <Badge variant="outline">Colunas: {result.columns_method || "-"}</Badge>
            <Badge variant="outline">Amostra: {result.sample_method || "-"}</Badge>
            <Badge variant="outline">Row count: {result.row_count_method || "-"}</Badge>
          </div>

          {!!result.ignored_internal_tables?.length && (
            <div className="rounded border border-border p-2 bg-muted/20 text-xs">
              <p className="font-medium mb-1">Tabelas internas ignoradas</p>
              <pre className="overflow-x-auto max-h-40 overflow-y-auto text-[11px] text-muted-foreground">
                {JSON.stringify(result.ignored_internal_tables, null, 2)}
              </pre>
            </div>
          )}

          {!!result.candidate_tables?.length && (
            <div className="rounded border border-border p-2 bg-muted/20 text-xs">
              <p className="font-medium mb-1">Tabelas reais candidatas</p>
              <pre className="overflow-x-auto max-h-40 overflow-y-auto text-[11px] text-muted-foreground">
                {JSON.stringify(result.candidate_tables, null, 2)}
              </pre>
            </div>
          )}

          {(result.raw_errors?.columns || result.raw_errors?.sample || result.raw_errors?.row_count) && (
            <div className="rounded border border-destructive/40 p-2 bg-destructive/5 text-xs">
              <p className="font-medium mb-1 text-destructive">Erros brutos</p>
              <pre className="overflow-x-auto max-h-48 overflow-y-auto text-[11px] text-muted-foreground">
                {JSON.stringify(result.raw_errors, null, 2)}
              </pre>
            </div>
          )}

          <div className="space-y-1">
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

          {result.tables.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Tabelas candidatas: </span>
              {result.tables.join(", ")}
            </div>
          )}
        </div>
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
