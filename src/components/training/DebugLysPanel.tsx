import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bug, ChevronDown, ChevronUp, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
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

  return (
    <Card className="border-dashed border-yellow-500/40 bg-yellow-500/5 p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <Bug className="w-4 h-4 text-yellow-600" />
          <span className="text-sm font-mono font-semibold text-yellow-700 dark:text-yellow-400">
            Debug LYS
          </span>
          {debugInfo && (
            <Badge
              variant={debugInfo.fallback_reason ? "destructive" : "secondary"}
              className="text-xs"
            >
              {debugInfo.fallback_reason ? "FALLBACK" : "CUMULATIVE"}
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
