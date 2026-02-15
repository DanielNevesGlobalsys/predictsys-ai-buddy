import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ShieldCheck, ShieldAlert, ShieldX, ChevronDown, RefreshCw, Loader2, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface AuditGate {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

interface AuditAction {
  label: string;
  go_to_step?: number;
  code?: string;
}

interface AuditResult {
  success: boolean;
  status: "pass" | "warn" | "block";
  selection_version: number;
  gates: AuditGate[];
  predictability_score: number;
  actions: AuditAction[];
  summary: {
    what_is_good: string[];
    what_is_risky: string[];
    next_best_actions: string[];
    predictability_score: number;
  };
}

interface AuditContractPanelProps {
  projectId: string;
  selectionVersion: number | null;
  onNavigateStep?: (step: number) => void;
}

const gateLabels: Record<string, string> = {
  CONTRACT_MIN_FIELDS: "Contrato Mínimo",
  TARGET_SANITY: "Sanidade do Target",
  SPLIT_SANITY: "Split Policy",
  LEAKAGE_GUARD: "Leakage Guard",
  CLASS_BALANCE: "Balanceamento de Classes",
  DATA_QUALITY_MIN: "Qualidade de Dados",
  SCORING_READY: "Prontidão do Scoring",
};

export default function AuditContractPanel({ projectId, selectionVersion, onNavigateStep }: AuditContractPanelProps) {
  const [result, setResult] = useState<AuditResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const runAudit = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("audit-contract", {
        body: { project_id: projectId, selection_version: selectionVersion },
      });
      if (error) throw error;
      if (data?.success) setResult(data as AuditResult);
    } catch (err) {
      console.error("[AuditContractPanel]", err);
    } finally {
      setLoading(false);
    }
  }, [projectId, selectionVersion]);

  const scoreColor = (s: number) =>
    s >= 80 ? "text-accent" : s >= 50 ? "text-amber-500" : "text-destructive";

  const statusIcon = (status: string) => {
    if (status === "pass") return <ShieldCheck className="w-5 h-5 text-accent" />;
    if (status === "warn") return <ShieldAlert className="w-5 h-5 text-amber-500" />;
    return <ShieldX className="w-5 h-5 text-destructive" />;
  };

  const gateBadge = (status: "PASS" | "WARN" | "BLOCK") => {
    if (status === "PASS") return <Badge variant="outline" className="text-[10px] bg-accent/10 text-accent border-accent/30">PASS</Badge>;
    if (status === "WARN") return <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-500 border-amber-500/30">WARN</Badge>;
    return <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/30">BLOCK</Badge>;
  };

  return (
    <Card className="p-4 space-y-3 border-primary/20 bg-primary/5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h4 className="text-sm font-semibold">Auditoria do Contrato</h4>
          {result && (
            <span className={`text-xl font-bold ${scoreColor(result.predictability_score)}`}>
              {result.predictability_score}/100
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={runAudit} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="ml-1.5 text-xs">{result ? "Reanalisar" : "Analisar"}</span>
        </Button>
      </div>

      {result && (
        <>
          {/* Score bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Predictability Score</span>
              <span className={scoreColor(result.predictability_score)}>{result.predictability_score}%</span>
            </div>
            <Progress value={result.predictability_score} className="h-2" />
          </div>

          {/* Status */}
          <div className="flex items-center gap-2">
            {statusIcon(result.status)}
            <span className="text-sm font-medium capitalize">{result.status === "pass" ? "Aprovado" : result.status === "warn" ? "Atenção" : "Bloqueado"}</span>
          </div>

          {/* Gates collapsible */}
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between text-xs h-7">
                <span>{result.gates.length} gates avaliados</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-1 pt-1">
              {result.gates.map((g, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-background/50">
                  <div className="flex items-center gap-2">
                    {gateBadge(g.status)}
                    <span className="font-medium">{gateLabels[g.gate] || g.gate}</span>
                  </div>
                  <span className="text-muted-foreground truncate max-w-[250px]">{g.message}</span>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>

          {/* Actions */}
          {result.actions.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <p className="text-xs text-muted-foreground font-medium">Ações recomendadas:</p>
              {result.actions.map((a, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant="outline"
                  className="w-full justify-between text-xs h-7"
                  onClick={() => a.go_to_step && onNavigateStep?.(a.go_to_step)}
                >
                  <span>{a.label}</span>
                  <ArrowRight className="w-3 h-3" />
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
