import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bug, RefreshCw, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  projectId: string | undefined;
}

interface PipelineSnapshot {
  // Contract
  industry: string | null;
  objective: string | null;
  business_intent_contract: any | null;
  active_intent_contract_id: string | null;
  // Target
  target_column: string | null;
  active_target_column: string | null;
  active_target_mode: string | null;
  target_source: string | null;
  target_state: string | null;
  problem_type: string | null;
  // Structural
  entity_key: string | null;
  time_anchor_column: string | null;
  // Versions
  selection_version: number;
  dataset_version: number;
  training_version: number;
  scoring_version: number;
  dashboard_version: number;
  // Pipeline states
  ingestion_state: string | null;
  eda_state: string | null;
  builder_state: string | null;
  split_state: string | null;
  training_state: string | null;
  scoring_state: string | null;
  dashboard_state: string | null;
  // Staleness
  staleness_flags: Record<string, boolean> | null;
  // Model selection
  model_selection_target: string | null;
  model_selection_version: number | null;
  model_selection_features_count: number | null;
  // Intent resolution
  intent_resolution_target: string | null;
  intent_resolution_confidence: number | null;
  intent_resolution_entity: string | null;
  intent_resolution_time: string | null;
}

export default function PipelineStateDebugPanel({ projectId }: Props) {
  const [snapshot, setSnapshot] = useState<PipelineSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [{ data: settings }, { data: selection }] = await Promise.all([
        supabase
          .from("project_settings")
          .select("industry, objective, business_intent_contract, active_intent_contract_id, target_column, active_target_column, active_target_mode, target_source, target_state, problem_type, entity_key, time_anchor_column, selection_version, dataset_version, training_version, scoring_version, dashboard_version, ingestion_state, eda_state, builder_state, split_state, training_state, scoring_state, dashboard_state, staleness_flags, target_intent_resolution")
          .eq("project_id", projectId)
          .maybeSingle(),
        supabase
          .from("project_model_selection" as any)
          .select("target_column, selection_version, selected_features")
          .eq("project_id", projectId)
          .maybeSingle(),
      ]);

      const s = (settings || {}) as Record<string, any>;
      const sel = (selection || {}) as Record<string, any>;
      const tir = (s.target_intent_resolution || {}) as Record<string, any>;

      setSnapshot({
        industry: s.industry || null,
        objective: s.objective || null,
        business_intent_contract: s.business_intent_contract || null,
        active_intent_contract_id: s.active_intent_contract_id || null,
        target_column: s.target_column || null,
        active_target_column: s.active_target_column || null,
        active_target_mode: s.active_target_mode || null,
        target_source: s.target_source || null,
        target_state: s.target_state || null,
        problem_type: s.problem_type || null,
        entity_key: s.entity_key || null,
        time_anchor_column: s.time_anchor_column || null,
        selection_version: s.selection_version || 0,
        dataset_version: s.dataset_version || 0,
        training_version: s.training_version || 0,
        scoring_version: s.scoring_version || 0,
        dashboard_version: s.dashboard_version || 0,
        ingestion_state: s.ingestion_state || null,
        eda_state: s.eda_state || null,
        builder_state: s.builder_state || null,
        split_state: s.split_state || null,
        training_state: s.training_state || null,
        scoring_state: s.scoring_state || null,
        dashboard_state: s.dashboard_state || null,
        staleness_flags: s.staleness_flags || null,
        model_selection_target: sel.target_column || null,
        model_selection_version: sel.selection_version || null,
        model_selection_features_count: Array.isArray(sel.selected_features) ? sel.selected_features.length : null,
        intent_resolution_target: tir.target_main_candidate?.column || null,
        intent_resolution_confidence: tir.target_confidence_score || null,
        intent_resolution_entity: tir.suggested_entity_key || null,
        intent_resolution_time: tir.suggested_time_anchor || null,
      });
    } catch (err) {
      console.error("[PipelineStateDebugPanel] Error:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (expanded && !snapshot) load();
  }, [expanded, snapshot, load]);

  const divergences: string[] = [];
  if (snapshot) {
    if (snapshot.target_column && snapshot.model_selection_target && snapshot.target_column !== snapshot.model_selection_target) {
      divergences.push(`Target diverge: settings="${snapshot.target_column}" vs selection="${snapshot.model_selection_target}"`);
    }
    if (snapshot.target_column && !snapshot.model_selection_target) {
      divergences.push(`Target em settings mas AUSENTE em model_selection`);
    }
    if (snapshot.intent_resolution_time && !snapshot.time_anchor_column) {
      divergences.push(`Time anchor resolvida="${snapshot.intent_resolution_time}" mas NÃO persistida em settings`);
    }
    if (snapshot.staleness_flags?.builder_stale) {
      divergences.push(`Builder stale: selection_version=${snapshot.selection_version} > dataset_version=${snapshot.dataset_version}`);
    }
  }

  const Row = ({ label, value, warn }: { label: string; value: any; warn?: boolean }) => (
    <div className="flex justify-between items-center py-1 text-xs border-b border-border/30 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${warn ? "text-destructive font-semibold" : "text-foreground"}`}>
        {value === null || value === undefined ? <span className="text-muted-foreground/50">null</span> : String(value)}
      </span>
    </div>
  );

  return (
    <div className="border border-border/50 rounded-lg bg-muted/5">
      <button
        className="w-full flex items-center justify-between p-3 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Bug className="w-3.5 h-3.5" />
          <span className="font-medium">Pipeline State Debug</span>
          {divergences.length > 0 && (
            <Badge variant="destructive" className="text-[9px] py-0">{divergences.length} divergência(s)</Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Reload
          </Button>

          {divergences.length > 0 && (
            <div className="p-2 rounded bg-destructive/10 border border-destructive/20 space-y-1">
              {divergences.map((d, i) => (
                <p key={i} className="text-[10px] text-destructive">⚠ {d}</p>
              ))}
            </div>
          )}

          {snapshot && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Contrato</p>
                <Row label="industry" value={snapshot.industry} />
                <Row label="objective" value={snapshot.objective} />
                <Row label="intent_contract_id" value={snapshot.active_intent_contract_id} />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Target (settings)</p>
                <Row label="target_column" value={snapshot.target_column} />
                <Row label="active_target_column" value={snapshot.active_target_column} />
                <Row label="active_target_mode" value={snapshot.active_target_mode} />
                <Row label="target_source" value={snapshot.target_source} />
                <Row label="target_state" value={snapshot.target_state} />
                <Row label="problem_type" value={snapshot.problem_type} />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Estrutural</p>
                <Row label="entity_key" value={snapshot.entity_key} />
                <Row label="time_anchor_column" value={snapshot.time_anchor_column} />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Model Selection</p>
                <Row label="target" value={snapshot.model_selection_target} warn={!!snapshot.target_column && !snapshot.model_selection_target} />
                <Row label="version" value={snapshot.model_selection_version} />
                <Row label="features" value={snapshot.model_selection_features_count} />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Versões</p>
                <Row label="selection_version" value={snapshot.selection_version} />
                <Row label="dataset_version" value={snapshot.dataset_version} />
                <Row label="training_version" value={snapshot.training_version} />
                <Row label="builder_state" value={snapshot.builder_state} />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Intent Resolution</p>
                <Row label="target" value={snapshot.intent_resolution_target} />
                <Row label="confidence" value={snapshot.intent_resolution_confidence != null ? `${Math.round(snapshot.intent_resolution_confidence * 100)}%` : null} />
                <Row label="entity" value={snapshot.intent_resolution_entity} />
                <Row label="time" value={snapshot.intent_resolution_time} />
              </div>
              <div className="sm:col-span-2">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Pipeline States</p>
                <div className="flex flex-wrap gap-1">
                  {["ingestion", "eda", "builder", "split", "training", "scoring", "dashboard"].map(stage => {
                    const state = (snapshot as any)[`${stage}_state`];
                    return (
                      <Badge key={stage} variant="outline" className="text-[9px]">
                        {stage}: {state || "—"}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
