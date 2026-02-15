import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Layers, Info } from "lucide-react";
import type { DomainAdapter } from "@/types/intentContract";

interface DomainAdapterBadgeProps {
  adapter: DomainAdapter;
}

const DomainAdapterBadge = ({ adapter }: DomainAdapterBadgeProps) => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="gap-1.5 px-2.5 py-1 text-xs border-accent/40 bg-accent/10 text-accent-foreground cursor-help"
          >
            <Layers className="w-3 h-3" />
            Adapter: {adapter.display_name}
            <Info className="w-3 h-3 text-muted-foreground" />
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1.5 text-xs">
            <p className="font-medium">Adaptador de Indústria ({adapter.display_name})</p>
            <p>
              <span className="text-muted-foreground">Entidades: </span>
              {adapter.entity_candidates.slice(0, 4).join(", ")}
            </p>
            <p>
              <span className="text-muted-foreground">Templates: </span>
              {adapter.recommended_templates.map(t => t.display_name).join(", ")}
            </p>
            <p>
              <span className="text-muted-foreground">Leakage watchlist: </span>
              {adapter.leakage_watchlist.slice(0, 3).join(", ")}
              {adapter.leakage_watchlist.length > 3 && ` +${adapter.leakage_watchlist.length - 3}`}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default DomainAdapterBadge;
