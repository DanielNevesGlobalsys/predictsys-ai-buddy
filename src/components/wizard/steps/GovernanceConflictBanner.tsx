import { AlertTriangle, ShieldCheck, ArrowRight, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface GovernanceConflictBannerProps {
  projectId: string;
  officialTarget: string | null;
  officialProblemType: string | null;
  recommendedTarget: string | null;
  recommendedProblemType: string | null;
  recommendedReasoning: string | null;
  recommendedConfidence: number | null;
  hasConflict: boolean;
  onMigrated: () => void;
  onKeptOfficial: () => void;
}

export default function GovernanceConflictBanner({
  projectId,
  officialTarget,
  officialProblemType,
  recommendedTarget,
  recommendedProblemType,
  recommendedReasoning,
  recommendedConfidence,
  hasConflict,
  onMigrated,
  onKeptOfficial,
}: GovernanceConflictBannerProps) {
  const { toast } = useToast();
  const [migrating, setMigrating] = useState(false);

  if (!hasConflict || !officialTarget || !recommendedTarget) return null;

  const handleKeepOfficial = async () => {
    await supabase.from("project_settings").update({
      governance_conflict: false,
      governance_conflict_details: null,
      recommended_target: null,
      recommended_problem_type: null,
      last_governance_action: "kept_official",
      last_governance_action_at: new Date().toISOString(),
    } as any).eq("project_id", projectId);
    onKeptOfficial();
    toast({ title: "Alvo oficial mantido", description: `O projeto continua com "${officialTarget}" (${officialProblemType}).` });
  };

  const handleMigrate = async () => {
    setMigrating(true);
    try {
      // 1. Update official fields
      await supabase.from("project_settings").update({
        official_target: recommendedTarget,
        official_problem_type: recommendedProblemType,
        target_column: recommendedTarget,
        active_target_column: recommendedTarget,
        problem_type: recommendedProblemType,
        governance_conflict: false,
        governance_conflict_details: null,
        recommended_target: null,
        recommended_problem_type: null,
        last_governance_action: "migrated_to_recommended",
        last_governance_action_at: new Date().toISOString(),
        // Reset downstream
        builder_state: "draft",
        training_state: "idle",
        scoring_state: "idle",
        dashboard_state: "idle",
      } as any).eq("project_id", projectId);

      // 2. Update model selection with new target/problem
      await supabase.functions.invoke("upsert-model-selection", {
        body: {
          project_id: projectId,
          target_column: recommendedTarget,
          problem_type: recommendedProblemType,
        },
      });

      toast({ title: "Projeto migrado", description: `Alvo alterado para "${recommendedTarget}" (${recommendedProblemType}). Rebuilde o pipeline.` });
      onMigrated();
    } catch (err) {
      console.error("[GovernanceConflictBanner] Migration failed:", err);
      toast({ title: "Erro na migração", variant: "destructive" });
    } finally {
      setMigrating(false);
    }
  };

  const formatProblem = (p: string | null) => {
    if (!p) return "—";
    if (p === "classification") return "Classificação";
    if (p === "regression") return "Regressão";
    return p;
  };

  return (
    <Alert className="border-yellow-500/40 bg-yellow-500/5">
      <AlertTriangle className="h-5 w-5 text-yellow-600" />
      <AlertDescription className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-yellow-700">Conflito de governança detectado</p>
          <p className="text-xs text-muted-foreground mt-1">
            Nova inferência sugere um alvo diferente do alvo oficial do projeto. O pipeline usa apenas o alvo oficial.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-primary" />
              <span className="font-semibold text-primary">Alvo oficial (atual)</span>
            </div>
            <div><span className="text-muted-foreground">Target:</span> <span className="font-medium">{officialTarget}</span></div>
            <div><span className="text-muted-foreground">Problema:</span> <span className="font-medium">{formatProblem(officialProblemType)}</span></div>
          </div>

          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 space-y-1">
            <div className="flex items-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5 text-yellow-600" />
              <span className="font-semibold text-yellow-700">Sugestão da IA</span>
              {recommendedConfidence != null && (
                <Badge variant="outline" className="text-[9px] py-0">{Math.round(recommendedConfidence * 100)}%</Badge>
              )}
            </div>
            <div><span className="text-muted-foreground">Target:</span> <span className="font-medium">{recommendedTarget}</span></div>
            <div><span className="text-muted-foreground">Problema:</span> <span className="font-medium">{formatProblem(recommendedProblemType)}</span></div>
            {recommendedReasoning && (
              <p className="text-[10px] text-muted-foreground mt-1 italic">{recommendedReasoning}</p>
            )}
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={handleKeepOfficial}>
            <ShieldCheck className="w-3 h-3 mr-1" /> Manter alvo oficial
          </Button>
          <Button variant="default" size="sm" className="text-xs h-7" onClick={handleMigrate} disabled={migrating}>
            {migrating ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ArrowRight className="w-3 h-3 mr-1" />}
            Migrar para novo alvo
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
