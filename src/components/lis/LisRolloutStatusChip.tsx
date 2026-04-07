import { Badge } from "@/components/ui/badge";
import { Shield, Eye, Zap } from "lucide-react";
import type { RolloutPhase } from "@/lib/lisRollout";

interface LisRolloutStatusChipProps {
  phase: RolloutPhase;
  enabled: boolean;
}

const PHASE_CONFIG: Record<RolloutPhase, { label: string; icon: typeof Shield; className: string }> = {
  phase1_observability: {
    label: "Fase 1 — Observabilidade",
    icon: Eye,
    className: "bg-muted text-muted-foreground border-muted",
  },
  phase2_assisted: {
    label: "Fase 2 — Assistida",
    icon: Shield,
    className: "bg-primary/10 text-primary border-primary/20",
  },
  phase3_auto: {
    label: "Fase 3 — Auto",
    icon: Zap,
    className: "bg-accent/20 text-accent-foreground border-accent/30",
  },
};

export default function LisRolloutStatusChip({ phase, enabled }: LisRolloutStatusChipProps) {
  if (!enabled) {
    return (
      <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/20">
        LIS Desabilitada
      </Badge>
    );
  }

  const cfg = PHASE_CONFIG[phase];
  const Icon = cfg.icon;

  return (
    <Badge variant="outline" className={`text-[10px] gap-1 ${cfg.className}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </Badge>
  );
}
