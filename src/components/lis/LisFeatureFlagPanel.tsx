import { useState } from "react";
import { Settings2, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import LisModeBadge from "./LisModeBadge";
import LisRolloutStatusChip from "./LisRolloutStatusChip";
import type { RolloutConfig } from "@/lib/lisRollout";
import type { ExecutionMode } from "@/types/lisOrchestration";

interface LisFeatureFlagPanelProps {
  config: RolloutConfig;
}

export default function LisFeatureFlagPanel({ config }: LisFeatureFlagPanelProps) {
  const [open, setOpen] = useState(false);

  const stages = Object.entries(config.stage_flags);

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="pb-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between p-0 h-auto">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-muted-foreground" />
                <CardTitle className="text-sm">Feature Flags — LIS AI OS</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <LisRolloutStatusChip phase={config.phase} enabled={config.enabled} />
                {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            </Button>
          </CollapsibleTrigger>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="pt-0 space-y-2">
            <div className="flex gap-2 flex-wrap text-[10px]">
              <Badge variant="outline">Env: {config.environment}</Badge>
              <Badge variant="outline">Fallback: {config.fallback_mode}</Badge>
              <Badge variant="outline">
                Degradação graciosa: {config.graceful_degradation ? "Sim" : "Não"}
              </Badge>
            </div>

            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left px-3 py-1.5 font-medium">Etapa</th>
                    <th className="text-center px-2 py-1.5 font-medium">Ativo</th>
                    <th className="text-center px-2 py-1.5 font-medium">Modo</th>
                    <th className="text-center px-2 py-1.5 font-medium">Auto-Apply</th>
                    <th className="text-left px-2 py-1.5 font-medium">Agentes</th>
                  </tr>
                </thead>
                <tbody>
                  {stages.map(([stage, flag]) => (
                    <tr key={stage} className="border-b last:border-b-0">
                      <td className="px-3 py-1.5 font-mono">{stage}</td>
                      <td className="text-center px-2 py-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${flag.enabled ? "bg-green-500" : "bg-destructive"}`} />
                      </td>
                      <td className="text-center px-2 py-1.5">
                        <LisModeBadge mode={flag.mode as ExecutionMode} />
                      </td>
                      <td className="text-center px-2 py-1.5 text-muted-foreground">
                        {flag.auto_apply_allowed ? "✓" : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-wrap gap-0.5">
                          {flag.agents.map((a) => (
                            <Badge key={a} variant="secondary" className="text-[9px] px-1 py-0">
                              {a.replace("_agent", "")}
                            </Badge>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
