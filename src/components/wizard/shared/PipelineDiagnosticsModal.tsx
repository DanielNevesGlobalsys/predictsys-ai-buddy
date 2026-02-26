import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Activity, RefreshCw, Loader2, Filter } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface PipelineEvent {
  id: string;
  event_type: string;
  status: string;
  source: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const FILTER_PREFIXES = [
  { label: "Todos", value: "" },
  { label: "Treino", value: "training" },
  { label: "Builder", value: "builder" },
  { label: "Pipeline", value: "pipeline" },
  { label: "Scoring", value: "scoring" },
  { label: "Dataset", value: "dataset" },
  { label: "Erros", value: "job_error" },
];

const STATUS_COLORS: Record<string, string> = {
  success: "bg-accent/20 text-accent border-accent/30",
  info: "bg-primary/20 text-primary border-primary/30",
  warning: "bg-amber-500/20 text-amber-600 border-amber-500/30",
  error: "bg-destructive/20 text-destructive border-destructive/30",
};

interface Props {
  projectId: string | undefined;
}

const PipelineDiagnosticsModal = ({ projectId }: Props) => {
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState("");
  const [open, setOpen] = useState(false);

  const loadEvents = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("get-project-events", {
        body: { project_id: projectId, limit: 30, prefix: activeFilter || undefined },
      });
      if (!error && data?.events) {
        setEvents(data.events);
      }
    } catch (err) {
      console.error("[PipelineDiagnostics] Error:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId, activeFilter]);

  const handleOpen = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) loadEvents();
  };

  const filteredEvents = activeFilter
    ? events.filter((e) => e.event_type.startsWith(activeFilter))
    : events;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground" disabled={!projectId}>
          <Activity className="w-3.5 h-3.5" />
          Diagnóstico
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Diagnóstico do Pipeline
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 flex-wrap">
          {FILTER_PREFIXES.map((f) => (
            <Button
              key={f.value}
              variant={activeFilter === f.value ? "default" : "outline"}
              size="sm"
              className="text-[10px] h-6 px-2"
              onClick={() => {
                setActiveFilter(f.value);
                setTimeout(loadEvents, 50);
              }}
            >
              {f.label}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6"
            onClick={loadEvents}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-1.5 mt-2">
          {filteredEvents.length === 0 && !loading && (
            <p className="text-xs text-muted-foreground text-center py-8">
              Nenhum evento encontrado.
            </p>
          )}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {filteredEvents.map((event) => (
            <div
              key={event.id}
              className="p-2.5 rounded-md border border-border/50 bg-muted/20 space-y-1"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className={`text-[9px] ${STATUS_COLORS[event.status] || "bg-muted text-muted-foreground"}`}
                >
                  {event.status}
                </Badge>
                <span className="text-[11px] font-mono font-medium text-foreground">
                  {event.event_type}
                </span>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {new Date(event.created_at).toLocaleString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    day: "2-digit",
                    month: "2-digit",
                  })}
                </span>
              </div>
              {event.metadata && Object.keys(event.metadata).length > 0 && (
                <details className="text-[10px]">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    metadata
                  </summary>
                  <pre className="mt-1 p-1.5 bg-muted/50 rounded text-[9px] overflow-x-auto max-h-32 whitespace-pre-wrap">
                    {JSON.stringify(event.metadata, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PipelineDiagnosticsModal;
