import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  Database, Loader2, CheckCircle, XCircle, AlertTriangle, 
  Package, Sparkles, Target, Clock, Users, Layers, Trash2, 
  Shield, BarChart3, FileWarning
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import TrainingGateReport, { type TrainingGateData } from "./TrainingGateReport";

interface ModelingDatasetResult {
  status: string;
  modeling_dataset_id?: string;
  modeling_dataset_ready?: boolean;
  target?: {
    column: string;
    type: string;
    source: string;
    label_plan?: any;
    window_days?: number | null;
  };
  target_hash?: string;
  contract_version?: string;
  entity_key?: string | null;
  anchor_time_col?: string | null;
  split_strategy?: string;
  features?: {
    final_count: number;
    generated_count: number;
    blocked_count: number;
    removed_count?: number;
    final: string[];
    generated: { name: string; type: string; description: string }[];
    blocked: { name: string; reason: string }[];
    removed?: { col: string; reason: string }[];
  };
  feature_report?: {
    temporal_features_created: string[];
    aggregation_features_created: string[];
    missing_flags_created: string[];
    imputation_applied: { numeric: string; categorical: string };
    overfit_risk_score: number;
    overfit_warning: string | null;
  };
  leakage_check?: {
    leakage_detected: boolean;
    leakage_columns: { column: string; reason: string }[];
  };
  training_gate?: TrainingGateData;
  dataset_stats?: {
    total_linhas: number;
    total_features_final: number;
    features_geradas_auto: number;
    features_removidas: number;
    flags_missing_criadas: number;
    features_temporais_criadas: number;
    agregacoes_criadas: number;
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
  build_log: any;
  updated_at: string;
}

interface Props {
  projectId: string | undefined;
  targetColumn: string;
  /** Must persist the current target/settings to DB before build starts */
  onSaveBeforeBuild?: () => Promise<boolean>;
}

const ModelingDatasetSection = ({ projectId, targetColumn, onSaveBeforeBuild }: Props) => {
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<ModelingDatasetResult | null>(null);
  const [persisted, setPersisted] = useState<PersistedDataset | null>(null);
  const [loadingPersisted, setLoadingPersisted] = useState(true);
  const [expandRemoved, setExpandRemoved] = useState(false);

  // Track if the current target differs from the last built target
  const lastBuiltTarget = persisted?.target_column;
  const buildTargetHash = (persisted?.build_log as any)?.target_hash || null;
  const isStale = !!lastBuiltTarget && lastBuiltTarget !== "__none__" && lastBuiltTarget !== targetColumn;

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

    if (data) setPersisted(data as unknown as PersistedDataset);
    setLoadingPersisted(false);
  };

  const handleBuild = useCallback(async () => {
    if (!projectId) return;

    // CRITICAL: Save current target/settings to DB BEFORE building
    // This prevents the race condition where the builder reads stale settings
    if (onSaveBeforeBuild) {
      const saved = await onSaveBeforeBuild();
      if (!saved) {
        toast.error("Falha ao salvar configurações. Tente novamente.");
        return;
      }
    }

    setBuilding(true);
    setResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Sessão expirada. Faça login novamente.");
        return;
      }

      // Only pass project_id — builder reads target from DB (SSOT)
      const response = await supabase.functions.invoke("build-modeling-dataset", {
        body: { project_id: projectId },
      });

      if (response.error) {
        toast.error("Erro ao construir dataset: " + response.error.message);
        return;
      }

      const data = response.data as ModelingDatasetResult;
      setResult(data);

      if (data.status === "READY" || data.status === "WARNING") {
        toast.success(`Dataset construído! Target: ${data.target?.column || targetColumn}`);
        await loadPersisted();
      } else if (data.status === "BLOCKED" || data.status === "BLOCKED_FEATURE_BUILDER") {
        toast.warning("Dataset bloqueado — veja os motivos abaixo.");
        await loadPersisted();
      }
    } catch (err) {
      console.error("Build error:", err);
      toast.error("Erro inesperado ao construir dataset.");
    } finally {
      setBuilding(false);
    }
  }, [projectId, onSaveBeforeBuild, targetColumn]);

  // Build display data from result or persisted
  const buildLog = persisted?.build_log as Record<string, any> | null;
  const featureReportFromLog = buildLog?.feature_report || null;
  const trainingGateFromLog = buildLog?.training_gate as TrainingGateData | null;

  const displayData: ModelingDatasetResult | null = result || (persisted ? {
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
      removed_count: featureReportFromLog?.features_removed?.length || 0,
      final: Array.isArray(persisted.features_final) ? persisted.features_final : [],
      generated: Array.isArray(persisted.features_generated) ? persisted.features_generated : [],
      blocked: Array.isArray(persisted.features_blocked) ? persisted.features_blocked : [],
      removed: featureReportFromLog?.features_removed || [],
    },
    feature_report: featureReportFromLog ? {
      temporal_features_created: featureReportFromLog.temporal_features_created || [],
      aggregation_features_created: featureReportFromLog.aggregation_features_created || [],
      missing_flags_created: featureReportFromLog.missing_flags_created || [],
      imputation_applied: featureReportFromLog.imputation_applied || { numeric: "median", categorical: "missing" },
      overfit_risk_score: featureReportFromLog.overfit_risk_score || 0,
      overfit_warning: featureReportFromLog.overfit_warning || null,
    } : undefined,
    leakage_check: {
      leakage_detected: Array.isArray(persisted.leakage_report) && persisted.leakage_report.length > 0,
      leakage_columns: Array.isArray(persisted.leakage_report) ? persisted.leakage_report : [],
    },
    dataset_stats: {
      total_linhas: persisted.row_count,
      total_features_final: (Array.isArray(persisted.features_final) ? persisted.features_final.length : 0) + (Array.isArray(persisted.features_generated) ? persisted.features_generated.length : 0),
      features_geradas_auto: Array.isArray(persisted.features_generated) ? persisted.features_generated.length : 0,
      features_removidas: featureReportFromLog?.features_removed?.length || 0,
      flags_missing_criadas: featureReportFromLog?.missing_flags_created?.length || 0,
      features_temporais_criadas: featureReportFromLog?.temporal_features_created?.length || 0,
      agregacoes_criadas: featureReportFromLog?.aggregation_features_created?.length || 0,
      column_count: persisted.column_count,
      coverage_pct: persisted.coverage_pct,
    },
    blocked_reasons: Array.isArray(persisted.blocked_reasons) ? persisted.blocked_reasons : [],
  } : null);

  const isReady = displayData?.status === "READY";
  const isWarning = displayData?.status === "WARNING";
  const isBlocked = displayData?.status === "BLOCKED" || displayData?.status === "BLOCKED_FEATURE_BUILDER";

  const statusBadgeClass = isReady
    ? "bg-accent/20 text-accent border-accent/30"
    : isWarning
    ? "bg-amber-500/20 text-amber-600 border-amber-500/30"
    : "bg-destructive/20 text-destructive border-destructive/30";

  const stats = displayData?.dataset_stats;
  const report = displayData?.feature_report;

  return (
    <div className="p-4 rounded-lg border border-border bg-muted/5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="w-5 h-5 text-primary" />
          <h4 className="text-sm font-semibold">📦 Dataset Modelável (Feature Builder)</h4>
        </div>
        <div className="flex items-center gap-2">
          {displayData && (
            <Badge className={`${statusBadgeClass} text-[10px]`}>
              {isReady ? <CheckCircle className="w-3 h-3 mr-1" /> : isWarning ? <AlertTriangle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
              {displayData.status}
            </Badge>
          )}
          <Button size="sm" variant={isStale ? "default" : displayData ? "outline" : "default"} onClick={handleBuild} disabled={building || !targetColumn}>
            {building ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Construindo...</>
            ) : isStale ? (
              <><Sparkles className="w-3.5 h-3.5 mr-1.5" />Reconstruir (target mudou)</>
            ) : displayData ? (
              <><Sparkles className="w-3.5 h-3.5 mr-1.5" />Reconstruir</>
            ) : (
              <><Database className="w-3.5 h-3.5 mr-1.5" />Construir dataset</>
            )}
          </Button>
        </div>
      </div>

      {/* Stale warning: target changed since last build */}
      {isStale && displayData && (
        <Alert className="bg-amber-500/5 border-amber-500/20">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <AlertDescription className="text-xs">
            <strong>Dataset desatualizado:</strong> Target mudou de <code className="px-1 py-0.5 bg-muted rounded text-[10px]">{lastBuiltTarget}</code> para <code className="px-1 py-0.5 bg-muted rounded text-[10px]">{targetColumn}</code>. Clique em "Reconstruir" para atualizar.
          </AlertDescription>
        </Alert>
      )}

      {/* Target used in last build */}
      {displayData?.target?.column && !isStale && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Target className="w-3 h-3" />
          <span>Target usado no builder: <strong>{displayData.target.column}</strong></span>
          {(displayData as any).target_hash && <span className="font-mono text-[10px]">({(displayData as any).target_hash})</span>}
          {(displayData as any).contract_version && <span>v{(displayData as any).contract_version}</span>}
        </div>
      )}

      {!targetColumn && !displayData && (
        <p className="text-xs text-muted-foreground">Selecione um target acima antes de construir o dataset modelável.</p>
      )}

      {displayData && (
        <div className="space-y-3">
          {/* Summary grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryCell icon={<Target className="w-3 h-3 text-primary" />} label="Target" value={displayData.target?.column || "—"} sub={`${displayData.target?.type} • ${displayData.target?.source === "label_builder" ? "derivado" : "direto"}`} />
            <SummaryCell icon={<Users className="w-3 h-3 text-primary" />} label="Entity Key" value={displayData.entity_key || "—"} />
            <SummaryCell icon={<Clock className="w-3 h-3 text-primary" />} label="Tempo" value={displayData.anchor_time_col || "—"} sub={displayData.target?.window_days ? `Janela: ${displayData.target.window_days}d` : undefined} />
            <SummaryCell icon={<Layers className="w-3 h-3 text-primary" />} label="Features" value={String(stats?.total_features_final || 0)} sub={`${displayData.features?.final_count || 0} dir + ${displayData.features?.generated_count || 0} gen`} />
          </div>

          {/* Dataset stats bar */}
          {stats && (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground border-t border-border/50 pt-2">
              <span>{stats.total_linhas.toLocaleString()} linhas</span>
              <span>{stats.column_count} colunas</span>
              <span>Coverage: {stats.coverage_pct}%</span>
              <span>Split: {displayData.split_strategy}</span>
              {stats.features_removidas > 0 && <span className="text-destructive">🗑 {stats.features_removidas} removidas</span>}
              {stats.features_temporais_criadas > 0 && <span className="text-accent">⏱ {stats.features_temporais_criadas} temporais</span>}
              {stats.agregacoes_criadas > 0 && <span className="text-accent">📊 {stats.agregacoes_criadas} agregações</span>}
              {stats.flags_missing_criadas > 0 && <span>🚩 {stats.flags_missing_criadas} missing flags</span>}
            </div>
          )}

          {/* Overfit warning */}
          {report?.overfit_warning && (
            <Alert className="bg-amber-500/5 border-amber-500/20">
              <BarChart3 className="w-4 h-4 text-amber-500" />
              <AlertDescription className="text-xs">
                <strong>Risco de Overfitting ({Math.round(report.overfit_risk_score * 100)}%):</strong> {report.overfit_warning}
              </AlertDescription>
            </Alert>
          )}

          {/* Label builder plan */}
          {displayData.target?.source === "label_builder" && displayData.target?.label_plan && (
            <div className="p-2 bg-accent/5 border border-accent/20 rounded text-xs">
              <p className="font-medium text-accent mb-1">🏷️ Label Builder</p>
              <p>{displayData.target.label_plan.condition || "Label derivado automaticamente."}</p>
            </div>
          )}

          {/* Imputation info */}
          {report?.imputation_applied && (
            <div className="p-2 bg-muted/30 rounded text-[11px] flex flex-wrap gap-4">
              <span><strong>Imputação numérica:</strong> {report.imputation_applied.numeric}</span>
              <span><strong>Imputação categórica:</strong> {report.imputation_applied.categorical}</span>
            </div>
          )}

          {/* Generated features by category */}
          {displayData.features && displayData.features.generated_count > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">Features geradas automaticamente ({displayData.features.generated_count}):</p>
              <div className="flex flex-wrap gap-1">
                {displayData.features.generated.slice(0, 10).map((f: any, i: number) => (
                  <Badge key={i} variant="secondary" className="text-[10px]" title={f.description}>
                    {f.type === "temporal" ? "⏱" : f.type === "aggregation" ? "📊" : f.type === "missing_flag" ? "🚩" : f.type === "one_hot" ? "🔢" : f.type === "frequency_encoding" ? "📈" : "✨"}{" "}
                    {f.name || f}
                  </Badge>
                ))}
                {displayData.features.generated.length > 10 && (
                  <Badge variant="outline" className="text-[10px]">+{displayData.features.generated.length - 10} mais</Badge>
                )}
              </div>
            </div>
          )}

          {/* Removed features */}
          {displayData.features?.removed && displayData.features.removed.length > 0 && (
            <div className="space-y-1">
              <button onClick={() => setExpandRemoved(!expandRemoved)} className="text-[11px] font-medium text-destructive/80 hover:text-destructive flex items-center gap-1">
                <Trash2 className="w-3 h-3" />
                {displayData.features.removed.length} features removidas (hard-block)
                <span className="text-[9px]">{expandRemoved ? "▲" : "▼"}</span>
              </button>
              {expandRemoved && (
                <div className="flex flex-wrap gap-1">
                  {displayData.features.removed.map((f: any, i: number) => (
                    <Badge key={i} variant="destructive" className="text-[10px]" title={f.reason}>
                      {f.col}: {f.reason.split(":")[0]}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Blocked features */}
          {displayData.features && displayData.features.blocked_count > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">Features bloqueadas ({displayData.features.blocked_count}):</p>
              <div className="flex flex-wrap gap-1">
                {displayData.features.blocked.slice(0, 5).map((f: any, i: number) => (
                  <Badge key={i} variant="outline" className="text-[10px] border-destructive/30 text-destructive">
                    {f.name}: {f.reason}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Leakage report */}
          {displayData.leakage_check?.leakage_detected && !displayData.training_gate && (
            <Alert className="bg-destructive/5 border-destructive/20">
              <Shield className="w-4 h-4 text-destructive" />
              <AlertDescription className="text-xs">
                <strong>⚠️ Leakage detectado:</strong>{" "}
                {displayData.leakage_check.leakage_columns.map(l => `${l.column} (${l.reason})`).join(", ")}
              </AlertDescription>
            </Alert>
          )}

          {/* Training Gate Report (4.3) */}
          {(displayData.training_gate || trainingGateFromLog) && (
            <TrainingGateReport gate={displayData.training_gate || trainingGateFromLog!} />
          )}

          {/* Blocked reasons */}
          {isBlocked && displayData.blocked_reasons && displayData.blocked_reasons.length > 0 && (
            <Alert className="bg-destructive/5 border-destructive/20">
              <FileWarning className="w-4 h-4 text-destructive" />
              <AlertDescription className="text-xs space-y-1">
                <p className="font-medium">BLOCKED — próximos passos:</p>
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

// Small reusable summary cell
function SummaryCell({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="p-2 bg-muted/30 rounded text-center">
      <div className="flex items-center justify-center gap-1 mb-1">
        {icon}
        <p className="text-[10px] text-muted-foreground">{label}</p>
      </div>
      <p className="text-xs font-semibold truncate" title={value}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default ModelingDatasetSection;
