import { useState } from "react";
import { Shield, FlaskConical, Database, Cpu, TrendingUp, Loader2, Play } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { LisAgentExecution, LisStage } from "@/types/lisAgents";
import { LIS_AGENTS_META } from "@/types/lisAgents";
import { STAGE_ORCHESTRATION_MAP } from "@/types/lisOrchestration";
import AgentDecisionSummaryCard from "./AgentDecisionSummaryCard";
import AgentBlockingBanner from "./AgentBlockingBanner";
import AgentAuditAccordion from "./AgentAuditAccordion";

interface LisAgentPanelProps {
  executions: LisAgentExecution[];
  loading?: boolean;
  currentStage?: LisStage;
  onRunStage?: (stage: LisStage) => void;
  runLoading?: boolean;
}

export default function LisAgentPanel({
  executions,
  loading,
  currentStage,
  onRunStage,
  runLoading,
}: LisAgentPanelProps) {
  const stageConfig = currentStage ? STAGE_ORCHESTRATION_MAP[currentStage] : null;

  // Separate latest from history
  const latestByAgent = new Map<string, LisAgentExecution>();
  const stageExecutions: LisAgentExecution[] = [];

  for (const exec of executions) {
    if (currentStage && exec.stage === currentStage) {
      stageExecutions.push(exec);
    }
    const key = `${exec.agent_name}_${exec.stage}`;
    if (!latestByAgent.has(key)) {
      latestByAgent.set(key, exec);
    }
  }

  const latestForStage = currentStage
    ? Array.from(latestByAgent.values()).filter((e) => e.stage === currentStage)
    : [];

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mr-2" />
          <span className="text-sm text-muted-foreground">Carregando LIS AI OS...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">LIS AI OS</CardTitle>
            {stageConfig && (
              <p className="text-xs text-muted-foreground mt-1">
                {stageConfig.description} •{" "}
                <span className="font-medium">
                  {LIS_AGENTS_META.find((a) => a.name === stageConfig.primary_agent)?.label}
                </span>
                {" → "}
                <span className="font-medium">
                  {LIS_AGENTS_META.find((a) => a.name === stageConfig.validator_agent)?.label}
                </span>
              </p>
            )}
          </div>
          {currentStage && onRunStage && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRunStage(currentStage)}
              disabled={runLoading}
            >
              {runLoading ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Play className="w-4 h-4 mr-1" />
              )}
              Analisar
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Blocking banner */}
        <AgentBlockingBanner executions={latestForStage} stage={currentStage} />

        {!executions.length && !currentStage ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            Nenhuma execução de agente registrada ainda.
          </p>
        ) : (
          <Tabs defaultValue="summary" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="summary">Resumo</TabsTrigger>
              <TabsTrigger value="audit">Auditoria</TabsTrigger>
            </TabsList>

            <TabsContent value="summary" className="space-y-2 mt-2">
              {latestForStage.length > 0 ? (
                latestForStage.map((exec) => (
                  <AgentDecisionSummaryCard
                    key={exec.id}
                    execution={exec}
                    stage={currentStage}
                    compact
                  />
                ))
              ) : (
                // Show latest across all stages
                Array.from(latestByAgent.values())
                  .slice(0, 5)
                  .map((exec) => (
                    <AgentDecisionSummaryCard
                      key={exec.id}
                      execution={exec}
                      compact
                    />
                  ))
              )}
            </TabsContent>

            <TabsContent value="audit" className="mt-2">
              <AgentAuditAccordion
                executions={currentStage ? stageExecutions : executions.slice(0, 20)}
                title={currentStage ? `Histórico — ${currentStage}` : "Histórico geral"}
              />
            </TabsContent>
          </Tabs>
        )}

        {/* Orchestration info */}
        {stageConfig && (
          <div className="flex flex-wrap gap-1 pt-2 border-t">
            <Badge variant="outline" className="text-[10px]">
              Modo: {stageConfig.default_mode}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              Política: {stageConfig.application_policy}
            </Badge>
            {stageConfig.auto_apply_allowed && (
              <Badge variant="secondary" className="text-[10px]">
                Auto-apply habilitado
              </Badge>
            )}
            {stageConfig.secondary_agents.length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                +{stageConfig.secondary_agents.length} agente(s) secundário(s)
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
