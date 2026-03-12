import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  CheckCircle, XCircle, SkipForward, Loader2, ChevronDown,
  Activity, Database, Table2, Columns3, FileSpreadsheet, Hash,
  Download, Zap,
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

interface DiagnosticResult {
  xmla_endpoint: string | null;
  steps: DiagnosticStep[];
  summary: DiagnosticSummary;
  tables: string[];
  columns_by_table: Record<string, Array<{ name: string; type: string }>>;
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
  projectId, connectionId, workspaceId, datasetId, tableName,
  onMaterializationSuccess,
}: Props) {
  const [running, setRunning] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [canMaterialize, setCanMaterialize] = useState(false);
  const [materialized, setMaterialized] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const runDiagnostic = useCallback(async (doMaterialize = false) => {
    if (doMaterialize) setMaterializing(true);
    else setRunning(true);

    try {
      const { data, error } = await supabase.functions.invoke("debug-powerbi-xmla", {
        body: {
          project_id: projectId,
          connection_id: connectionId,
          workspace_id: workspaceId,
          dataset_id: datasetId,
          table_name: tableName,
          materialize: doMaterialize,
        },
      });

      if (error) throw error;

      if (data?.diagnostic) {
        setResult(data.diagnostic);
        setCanMaterialize(data.can_materialize || false);
        setMaterialized(data.materialized || false);

        if (data.materialized) {
          toast.success("Dataset materializado com sucesso via XMLA!");
          onMaterializationSuccess?.();
        }
      } else if (!data?.success) {
        toast.error(data?.error || "Diagnóstico falhou");
        if (data?.steps) {
          setResult({ xmla_endpoint: null, steps: data.steps, summary: {} as DiagnosticSummary, tables: [], columns_by_table: {} });
        }
      }
    } catch (err) {
      console.error("[xmla-diagnostic]", err);
      toast.error("Erro ao executar diagnóstico XMLA");
    } finally {
      setRunning(false);
      setMaterializing(false);
    }
  }, [projectId, connectionId, workspaceId, datasetId, tableName, onMaterializationSuccess]);

  const toggleStep = (step: string) => {
    setExpandedSteps(prev => {
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
          <Button
            variant="outline" size="sm"
            onClick={() => runDiagnostic(false)}
            disabled={running || materializing}
          >
            {running ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
            {running ? "Executando..." : "Executar diagnóstico"}
          </Button>
          {canMaterialize && !materialized && (
            <Button
              variant="default" size="sm"
              onClick={() => runDiagnostic(true)}
              disabled={running || materializing}
            >
              {materializing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
              {materializing ? "Materializando..." : "Materializar dataset"}
            </Button>
          )}
        </div>
      </div>

      {!result && !running && (
        <p className="text-xs text-muted-foreground">
          Execute o diagnóstico para validar conectividade XMLA, tabelas, colunas e amostra de dados.
        </p>
      )}

      {result && (
        <div className="space-y-3 mt-2">
          {/* Summary badges */}
          <div className="flex flex-wrap gap-2">
            <SummaryBadge ok={result.summary.auth_ok} label="Auth" />
            <SummaryBadge ok={result.summary.workspace_ok} label="Workspace" />
            <SummaryBadge ok={result.summary.dataset_ok} label="Dataset" />
            <SummaryBadge ok={result.summary.tables_found > 0} label={`${result.summary.tables_found} tabelas`} />
            <SummaryBadge ok={result.summary.columns_found > 0} label={`${result.summary.columns_found} colunas`} />
            <SummaryBadge ok={result.summary.sample_ok} label="Amostra" />
            {materialized && <Badge className="bg-accent text-accent-foreground text-xs">Materializado ✔</Badge>}
          </div>

          {/* XMLA endpoint */}
          {result.xmla_endpoint && (
            <div className="text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1 break-all">
              {result.xmla_endpoint}
            </div>
          )}

          {/* Step details */}
          <div className="space-y-1">
            {result.steps.map((step) => (
              <Collapsible
                key={step.step}
                open={expandedSteps.has(step.step)}
                onOpenChange={() => toggleStep(step.step)}
              >
                <CollapsibleTrigger className="w-full">
                  <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 transition-colors cursor-pointer w-full">
                    <span className={statusColors[step.status]}>
                      {step.status === 'ok' ? <CheckCircle className="w-4 h-4" /> :
                       step.status === 'fail' ? <XCircle className="w-4 h-4" /> :
                       <SkipForward className="w-4 h-4" />}
                    </span>
                    <span className="text-muted-foreground">{stepIconMap[step.step]}</span>
                    <span className="text-xs font-medium flex-1 text-left">{step.label}</span>
                    {step.duration_ms !== undefined && (
                      <span className="text-xs text-muted-foreground">{step.duration_ms}ms</span>
                    )}
                    <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${expandedSteps.has(step.step) ? 'rotate-180' : ''}`} />
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

          {/* Tables list */}
          {result.tables.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Tabelas: </span>
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
