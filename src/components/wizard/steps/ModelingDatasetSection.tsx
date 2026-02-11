import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  Database, Loader2, CheckCircle, XCircle, AlertTriangle, 
  Package, Sparkles, Target, Clock, Users, Layers
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface ModelingDatasetResult {
  status: string;
  modeling_dataset_id?: string;
  target?: {
    column: string;
    type: string;
    source: string;
    label_plan?: any;
    window_days?: number | null;
  };
  entity_key?: string | null;
  anchor_time_col?: string | null;
  split_strategy?: string;
  features?: {
    final_count: number;
    generated_count: number;
    blocked_count: number;
    final: string[];
    generated: { name: string; type: string; description: string }[];
    blocked: { name: string; reason: string }[];
  };
  leakage_report?: { column: string; reason: string }[];
  dataset_stats?: {
    row_count: number;
    column_count: number;
    coverage_pct: number;
  };
  blocked_reasons?: string[];
}

interface PersistedDataset {
  id: string;
  status: string;
  target_column: string;
  target_type: string;
  target_source: string;
  entity_key: string | null;
  anchor_time_col: string | null;
  split_strategy: string;
  row_count: number;
  column_count: number;
  coverage_pct: number;
  features_final: any;
  features_generated: any;
  features_blocked: any;
  leakage_report: any;
  blocked_reasons: any;
  label_plan: any;
  window_days: number | null;
  updated_at: string;
}

interface Props {
  projectId: string | undefined;
  targetColumn: string;
}

const ModelingDatasetSection = ({ projectId, targetColumn }: Props) => {
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<ModelingDatasetResult | null>(null);
  const [persisted, setPersisted] = useState<PersistedDataset | null>(null);
  const [loadingPersisted, setLoadingPersisted] = useState(true);

  // Load existing modeling dataset on mount
  useEffect(() => {
    if (projectId) loadPersisted();
  }, [projectId]);

  const loadPersisted = async () => {
    if (!projectId) return;
    setLoadingPersisted(true);
    const { data } = await supabase
      .from("project_modeling_datasets")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      setPersisted(data as unknown as PersistedDataset);
    }
    setLoadingPersisted(false);
  };

  const handleBuild = useCallback(async () => {
    if (!projectId) return;
    setBuilding(true);
    setResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Sessão expirada. Faça login novamente.");
        return;
      }

      const response = await supabase.functions.invoke("build-modeling-dataset", {
        body: { project_id: projectId },
      });

      if (response.error) {
        toast.error("Erro ao construir dataset: " + response.error.message);
        return;
      }

      const data = response.data as ModelingDatasetResult;
      setResult(data);

      if (data.status === "READY") {
        toast.success("Dataset modelável construído com sucesso!");
        await loadPersisted();
      } else if (data.status === "BLOCKED") {
        toast.warning("Dataset bloqueado — veja os motivos abaixo.");
        await loadPersisted();
      }
    } catch (err) {
      console.error("Build error:", err);
      toast.error("Erro inesperado ao construir dataset.");
    } finally {
      setBuilding(false);
    }
  }, [projectId]);

  const displayData = result || (persisted ? {
    status: persisted.status.toUpperCase(),
    target: {
      column: persisted.target_column,
      type: persisted.target_type,
      source: persisted.target_source,
      label_plan: persisted.label_plan,
      window_days: persisted.window_days,
    },
    entity_key: persisted.entity_key,
    anchor_time_col: persisted.anchor_time_col,
    split_strategy: persisted.split_strategy,
    features: {
      final_count: Array.isArray(persisted.features_final) ? persisted.features_final.length : 0,
      generated_count: Array.isArray(persisted.features_generated) ? persisted.features_generated.length : 0,
      blocked_count: Array.isArray(persisted.features_blocked) ? persisted.features_blocked.length : 0,
      final: Array.isArray(persisted.features_final) ? persisted.features_final : [],
      generated: Array.isArray(persisted.features_generated) ? persisted.features_generated : [],
      blocked: Array.isArray(persisted.features_blocked) ? persisted.features_blocked : [],
    },
    leakage_report: Array.isArray(persisted.leakage_report) ? persisted.leakage_report : [],
    dataset_stats: {
      row_count: persisted.row_count,
      column_count: persisted.column_count,
      coverage_pct: persisted.coverage_pct,
    },
    blocked_reasons: Array.isArray(persisted.blocked_reasons) ? persisted.blocked_reasons : [],
  } : null);

  const isReady = displayData?.status === "READY";
  const isBlocked = displayData?.status === "BLOCKED";

  return (
    <div className="p-4 rounded-lg border border-border bg-muted/5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="w-5 h-5 text-primary" />
          <h4 className="text-sm font-semibold">📦 Dataset Modelável</h4>
        </div>
        <div className="flex items-center gap-2">
          {displayData && (
            <Badge className={
              isReady 
                ? "bg-accent/20 text-accent border-accent/30 text-[10px]"
                : isBlocked
                ? "bg-destructive/20 text-destructive border-destructive/30 text-[10px]"
                : "bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]"
            }>
              {isReady ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
              {displayData.status}
            </Badge>
          )}
          <Button
            size="sm"
            variant={displayData ? "outline" : "default"}
            onClick={handleBuild}
            disabled={building || !targetColumn}
          >
            {building ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Construindo...
              </>
            ) : displayData ? (
              <>
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                Reconstruir
              </>
            ) : (
              <>
                <Database className="w-3.5 h-3.5 mr-1.5" />
                Construir dataset
              </>
            )}
          </Button>
        </div>
      </div>

      {!targetColumn && !displayData && (
        <p className="text-xs text-muted-foreground">
          Selecione um target acima antes de construir o dataset modelável.
        </p>
      )}

      {/* Results display */}
      {displayData && (
        <div className="space-y-3">
          {/* Summary grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="p-2 bg-muted/30 rounded text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Target className="w-3 h-3 text-primary" />
                <p className="text-[10px] text-muted-foreground">Target</p>
              </div>
              <p className="text-xs font-semibold truncate" title={displayData.target?.column}>
                {displayData.target?.column || "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {displayData.target?.type} • {displayData.target?.source === "label_builder" ? "derivado" : "direto"}
              </p>
            </div>
            <div className="p-2 bg-muted/30 rounded text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Users className="w-3 h-3 text-primary" />
                <p className="text-[10px] text-muted-foreground">Entity Key</p>
              </div>
              <p className="text-xs font-semibold truncate">
                {displayData.entity_key || "—"}
              </p>
            </div>
            <div className="p-2 bg-muted/30 rounded text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Clock className="w-3 h-3 text-primary" />
                <p className="text-[10px] text-muted-foreground">Tempo</p>
              </div>
              <p className="text-xs font-semibold truncate">
                {displayData.anchor_time_col || "—"}
              </p>
              {displayData.target?.window_days && (
                <p className="text-[10px] text-muted-foreground">Janela: {displayData.target.window_days}d</p>
              )}
            </div>
            <div className="p-2 bg-muted/30 rounded text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Layers className="w-3 h-3 text-primary" />
                <p className="text-[10px] text-muted-foreground">Features</p>
              </div>
              <p className="text-xs font-semibold">
                {(displayData.features?.final_count || 0) + (displayData.features?.generated_count || 0)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {displayData.features?.final_count || 0} dir + {displayData.features?.generated_count || 0} gen
              </p>
            </div>
          </div>

          {/* Dataset stats */}
          {displayData.dataset_stats && (
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span>{displayData.dataset_stats.row_count.toLocaleString()} linhas</span>
              <span>{displayData.dataset_stats.column_count} colunas</span>
              <span>Coverage: {displayData.dataset_stats.coverage_pct}%</span>
              <span>Split: {displayData.split_strategy}</span>
            </div>
          )}

          {/* Label builder plan */}
          {displayData.target?.source === "label_builder" && displayData.target?.label_plan && (
            <div className="p-2 bg-accent/5 border border-accent/20 rounded text-xs">
              <p className="font-medium text-accent mb-1">🏷️ Label Builder</p>
              <p>{displayData.target.label_plan.condition || "Label derivado automaticamente."}</p>
            </div>
          )}

          {/* Generated features */}
          {displayData.features && displayData.features.generated_count > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">Features geradas automaticamente:</p>
              <div className="flex flex-wrap gap-1">
                {displayData.features.generated.slice(0, 8).map((f: any, i: number) => (
                  <Badge key={i} variant="secondary" className="text-[10px]">
                    <Sparkles className="w-2.5 h-2.5 mr-1" />
                    {f.name || f}
                  </Badge>
                ))}
                {displayData.features.generated.length > 8 && (
                  <Badge variant="outline" className="text-[10px]">
                    +{displayData.features.generated.length - 8} mais
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Blocked features */}
          {displayData.features && displayData.features.blocked_count > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">Features bloqueadas:</p>
              <div className="flex flex-wrap gap-1">
                {displayData.features.blocked.slice(0, 5).map((f: any, i: number) => (
                  <Badge key={i} variant="destructive" className="text-[10px]">
                    {f.name}: {f.reason}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Leakage report */}
          {displayData.leakage_report && displayData.leakage_report.length > 0 && (
            <Alert className="bg-amber-500/5 border-amber-500/20">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <AlertDescription className="text-xs">
                <strong>Leakage detectado:</strong>{" "}
                {displayData.leakage_report.map((l: any) => `${l.column} (${l.reason})`).join(", ")}
              </AlertDescription>
            </Alert>
          )}

          {/* Blocked reasons */}
          {isBlocked && displayData.blocked_reasons && displayData.blocked_reasons.length > 0 && (
            <Alert className="bg-destructive/5 border-destructive/20">
              <XCircle className="w-4 h-4 text-destructive" />
              <AlertDescription className="text-xs space-y-1">
                <p className="font-medium">Dataset bloqueado — próximos passos:</p>
                {displayData.blocked_reasons.map((r: string, i: number) => (
                  <p key={i}>• {r}</p>
                ))}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelingDatasetSection;
