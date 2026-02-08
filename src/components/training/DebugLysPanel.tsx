import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bug, ChevronDown, ChevronUp, CheckCircle2, XCircle, AlertTriangle, ShieldCheck, ShieldX } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { DebugInfo, ContextFlags } from "@/hooks/useTrainingInsightContext";

interface DebugLysPanelProps {
  debugInfo: DebugInfo | null;
  onRefresh: () => void;
  loading: boolean;
}

const FLAG_LABELS: Record<keyof ContextFlags, string> = {
  used_eda_summary: "EDA Summary",
  used_business_inference: "Business Inference",
  used_selected_target: "Selected Target",
  used_selected_features: "Selected Features",
  used_model_metrics: "Model Metrics",
  used_feature_importance: "Feature Importance",
};

const DebugLysPanel = ({ debugInfo, onRefresh, loading }: DebugLysPanelProps) => {
  const { t } = useTranslation();
  const [isAdmin, setIsAdmin] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    checkAdminStatus();
  }, []);

  const checkAdminStatus = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("organization_users")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["super_admin", "org_admin"]);

    if (data && data.length > 0) {
      const isSuperAdmin = data.some(d => d.role === "super_admin");
      setIsAdmin(isSuperAdmin);
    }
  };

  if (!isAdmin) return null;

  const qi = debugInfo?.quality_info;
  const qFlag = qi?.model_quality_flag;

  return (
    <Card className="border-dashed border-yellow-500/40 bg-yellow-500/5 p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <Bug className="w-4 h-4 text-yellow-600" />
          <span className="text-sm font-mono font-semibold text-yellow-700 dark:text-yellow-400">
            Debug LYS CUMULATIVE
          </span>
          {debugInfo && (
            <Badge
              variant={debugInfo.fallback_reason ? "destructive" : "secondary"}
              className="text-xs"
            >
              {debugInfo.fallback_reason ? "FALLBACK" : "CUMULATIVE"}
            </Badge>
          )}
          {qFlag && (
            <Badge
              variant={qFlag === "ok" ? "secondary" : "destructive"}
              className="text-xs"
            >
              {qFlag === "ok" ? "QUALITY OK" : "QUALITY FAIL"}
            </Badge>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="mt-4 space-y-4 text-xs font-mono">
          {!debugInfo ? (
            <div className="text-muted-foreground">
              Gere os insights para ver o debug do contexto.
              <Button variant="outline" size="sm" className="ml-2" onClick={onRefresh} disabled={loading}>
                Carregar
              </Button>
            </div>
          ) : (
            <>
              {/* State version */}
              <div>
                <span className="text-muted-foreground">project_state_version:</span>{" "}
                <span className="text-foreground">
                  {new Date(debugInfo.project_state_version).toLocaleString()}
                </span>
              </div>

              {/* Context flags */}
              <div>
                <span className="text-muted-foreground block mb-2">context_flags:</span>
                <div className="grid grid-cols-2 gap-1.5 pl-2">
                  {Object.entries(debugInfo.context_flags).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-1.5">
                      {value ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500" />
                      )}
                      <span className={value ? "text-foreground" : "text-red-400"}>
                        {FLAG_LABELS[key as keyof ContextFlags] || key}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Model Quality Info */}
              {qi && (
                <div className="space-y-2">
                  <span className="text-muted-foreground block mb-1">quality_info:</span>
                  <div className="pl-2 space-y-1.5">
                    {/* model_quality_flag */}
                    <div className="flex items-center gap-1.5">
                      {qFlag === "ok" ? (
                        <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
                      ) : qFlag === "fail" ? (
                        <ShieldX className="w-3.5 h-3.5 text-red-500" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                      )}
                      <span className={qFlag === "fail" ? "text-red-400" : "text-foreground"}>
                        model_quality_flag: {qFlag || "N/A"}
                      </span>
                    </div>

                    {/* split_strategy */}
                    {qi.split_strategy && (
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
                        <span className="text-foreground">
                          split_strategy: {qi.split_strategy}
                          {qi.split_datetime_col ? ` (col: ${qi.split_datetime_col})` : ""}
                          {qi.split_group_key ? ` (group: ${qi.split_group_key})` : ""}
                        </span>
                      </div>
                    )}

                    {/* prediction_sanity */}
                    {qi.prediction_sanity && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          {qi.prediction_sanity.passed ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                          ) : (
                            <ShieldX className="w-3.5 h-3.5 text-red-500" />
                          )}
                          <span className={qi.prediction_sanity.passed ? "text-foreground" : "text-red-400"}>
                            prediction_sanity: {qi.prediction_sanity.passed ? "PASSED" : "FAILED"}
                          </span>
                        </div>
                        <div className="pl-4 grid grid-cols-2 gap-1 text-[10px]">
                          <span>pred_std: {qi.prediction_sanity.pred_std?.toFixed(4) ?? "N/A"}</span>
                          <span>pct_equal_mode: {qi.prediction_sanity.pct_equal_mode_pred != null ? (qi.prediction_sanity.pct_equal_mode_pred * 100).toFixed(1) + "%" : "N/A"}</span>
                          <span>unique_ratio: {qi.prediction_sanity.unique_ratio_pred?.toFixed(4) ?? "N/A"}</span>
                        </div>
                        {qi.prediction_sanity.fail_reasons && qi.prediction_sanity.fail_reasons.length > 0 && (
                          <div className="flex flex-wrap gap-1 pl-4">
                            {qi.prediction_sanity.fail_reasons.map((r, idx) => (
                              <Badge key={idx} variant="outline" className="text-[10px] text-red-500 border-red-500/30">
                                {r}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* dual_model */}
                    {qi.dual_model && (
                      <div className="space-y-1">
                        <span className="text-muted-foreground block">dual_model:</span>
                        <div className="pl-4 text-[10px] space-y-0.5">
                          <span className="block">A: {qi.dual_model.model_a?.name} (score: {qi.dual_model.model_a?.score?.toFixed(4)})</span>
                          <span className="block">B: {qi.dual_model.model_b?.name} (score: {qi.dual_model.model_b?.score?.toFixed(4)})</span>
                          <span className="block font-semibold">→ selected: {qi.dual_model.selected}</span>
                        </div>
                      </div>
                    )}

                    {/* predictions_count */}
                    <div className="flex items-center gap-1.5">
                      {(qi.predictions_count ?? 0) > 0 ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500" />
                      )}
                      <span className={(qi.predictions_count ?? 0) === 0 ? "text-red-400" : "text-foreground"}>
                        predictions_count: {qi.predictions_count ?? "N/A"}
                      </span>
                    </div>

                    {/* coverage_pct */}
                    {qi.coverage_pct !== null && qi.coverage_pct !== undefined && (
                      <div className="flex items-center gap-1.5">
                        {qi.coverage_pct >= 95 ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                        )}
                        <span className={qi.coverage_pct < 95 ? "text-yellow-500" : "text-foreground"}>
                          coverage_pct: {qi.coverage_pct.toFixed(1)}%
                        </span>
                      </div>
                    )}

                    {/* sample_strategy + train_rows_used / total_rows */}
                    {qi.sample_strategy && (
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
                        <span className="text-foreground">
                          sample_strategy: {qi.sample_strategy}
                          {qi.train_rows_used && qi.total_rows_dataset ? ` (${qi.train_rows_used.toLocaleString()} / ${qi.total_rows_dataset.toLocaleString()})` : ""}
                        </span>
                      </div>
                    )}

                    {/* baseline_metrics */}
                    {qi.baseline_metrics && (
                      <div>
                        <span className="text-muted-foreground block mb-1">baseline_metrics:</span>
                        <div className="pl-2 grid grid-cols-2 gap-1">
                          {Object.entries(qi.baseline_metrics).map(([key, value]) => (
                            <span key={key} className="text-foreground">
                              {key}: {typeof value === "number" ? value.toFixed(4) : String(value)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* preflight_report */}
                    {qi.preflight_report && (
                      <div>
                        <span className="text-muted-foreground block mb-1">preflight_report:</span>
                        <div className="pl-2 space-y-1">
                          <div className="flex items-center gap-1.5">
                            {qi.preflight_report.target_valid ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5 text-red-500" />
                            )}
                            <span className={qi.preflight_report.target_valid ? "text-foreground" : "text-red-400"}>
                              target_validity: {qi.preflight_report.target_valid ? "VALID" : "INVALID"}
                            </span>
                          </div>
                          
                          {qi.preflight_report.target_issues.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {qi.preflight_report.target_issues.map((issue, idx) => (
                                <Badge key={idx} variant="outline" className="text-[10px] text-orange-500 border-orange-500/30">
                                  {issue}
                                </Badge>
                              ))}
                            </div>
                          )}

                          <div className="flex items-center gap-1.5">
                            {qi.preflight_report.features_blocked.length === 0 ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                            ) : (
                              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                            )}
                            <span className="text-foreground">
                              feature_validity: {qi.preflight_report.features_blocked.length} features bloqueadas
                            </span>
                          </div>

                          {qi.preflight_report.features_blocked.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {qi.preflight_report.features_blocked.map((f, idx) => (
                                <Badge key={idx} variant="outline" className="text-[10px] text-red-500 border-red-500/30">
                                  {f}: {qi.preflight_report!.features_block_reasons[f] || "blocked"}
                                </Badge>
                              ))}
                            </div>
                          )}

                          {qi.preflight_report.warnings.length > 0 && (
                            <div>
                              <span className="text-yellow-600">warnings ({qi.preflight_report.warnings.length}):</span>
                              {qi.preflight_report.warnings.map((w, idx) => (
                                <div key={idx} className="text-yellow-600/80 pl-2">⚠ {w}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Missing fields */}
              {debugInfo.missing_fields.length > 0 && (
                <div>
                  <span className="text-muted-foreground block mb-1">missing_fields:</span>
                  <div className="flex flex-wrap gap-1 pl-2">
                    {debugInfo.missing_fields.map((field) => (
                      <Badge key={field} variant="outline" className="text-xs text-orange-500 border-orange-500/30">
                        {field}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Fallback reason */}
              {debugInfo.fallback_reason && (
                <div className="flex items-start gap-2 p-2 bg-destructive/10 rounded border border-destructive/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-destructive mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="text-destructive font-semibold block">fallback_reason:</span>
                    <span className="text-destructive/80">{debugInfo.fallback_reason}</span>
                  </div>
                </div>
              )}

              {/* Payload preview */}
              <div>
                <span className="text-muted-foreground block mb-1">payload_preview:</span>
                <pre className="bg-muted/50 p-2 rounded text-[10px] overflow-x-auto">
                  {JSON.stringify(debugInfo.payload_preview, null, 2)}
                </pre>
              </div>

              <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="text-xs">
                Atualizar Debug
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
};

export default DebugLysPanel;
