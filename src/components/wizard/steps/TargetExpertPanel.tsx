import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, Settings2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface Props {
  advancedMode: boolean;
  children: React.ReactNode;
}

export default function TargetExpertPanel({ advancedMode, children }: Props) {
  const [open, setOpen] = useState(false);

  if (!advancedMode) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between h-10 text-sm border-border/50 bg-muted/20"
        >
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            <span>Ferramentas avançadas</span>
            <Badge className="bg-accent/20 text-accent border-accent/30 text-[9px]">Especialista</Badge>
          </div>
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
