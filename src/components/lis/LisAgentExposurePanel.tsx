import { Eye, EyeOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { VisibilityPolicy } from "@/lib/lisRollout";

interface LisAgentExposurePanelProps {
  visibility: VisibilityPolicy;
  roleName: string;
}

const FIELD_LABELS: Record<keyof VisibilityPolicy, string> = {
  show_agent_name: "Nome do agente",
  show_confidence: "Confiança",
  show_reasoning: "Raciocínio",
  show_warnings: "Warnings",
  show_blocks: "Bloqueios",
  show_audit_history: "Histórico de auditoria",
  show_raw_output: "Output bruto",
  show_feature_flags: "Feature flags",
  show_mode_badge: "Badge de modo",
  show_execution_metadata: "Metadata de execução",
};

export default function LisAgentExposurePanel({ visibility, roleName }: LisAgentExposurePanelProps) {
  const entries = Object.entries(visibility) as [keyof VisibilityPolicy, boolean][];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Eye className="w-4 h-4 text-muted-foreground" />
          Visibilidade — {roleName}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-1.5">
          {entries.map(([key, enabled]) => (
            <div key={key} className="flex items-center gap-1.5 text-xs">
              {enabled ? (
                <Eye className="w-3 h-3 text-primary" />
              ) : (
                <EyeOff className="w-3 h-3 text-muted-foreground" />
              )}
              <span className={enabled ? "text-foreground" : "text-muted-foreground"}>
                {FIELD_LABELS[key]}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
