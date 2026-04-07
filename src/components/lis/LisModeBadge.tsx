import { Badge } from "@/components/ui/badge";
import type { ExecutionMode } from "@/types/lisOrchestration";

interface LisModeBadgeProps {
  mode: ExecutionMode;
  size?: "sm" | "md";
}

const MODE_CONFIG: Record<ExecutionMode, { label: string; className: string }> = {
  shadow: {
    label: "Shadow",
    className: "bg-muted text-muted-foreground border-muted",
  },
  assisted: {
    label: "Assistido",
    className: "bg-primary/10 text-primary border-primary/20",
  },
  auto: {
    label: "Auto",
    className: "bg-accent/20 text-accent-foreground border-accent/30",
  },
};

export default function LisModeBadge({ mode, size = "sm" }: LisModeBadgeProps) {
  const cfg = MODE_CONFIG[mode] || MODE_CONFIG.shadow;
  return (
    <Badge
      variant="outline"
      className={`${cfg.className} ${size === "sm" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5"}`}
    >
      {cfg.label}
    </Badge>
  );
}
