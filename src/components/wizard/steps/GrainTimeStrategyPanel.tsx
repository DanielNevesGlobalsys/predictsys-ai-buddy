import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { CheckCircle, AlertTriangle, XCircle, Clock, Layers, GitBranch, Database, Wand2, Info } from "lucide-react";
import type { GrainTimeResolution } from "@/types/grainResolution";

interface GrainTimeStrategyPanelProps {
  resolution: GrainTimeResolution | null;
  loading?: boolean;
}

const GRAIN_LABELS: Record<string, string> = {
  original_row: "Linha original",
  entity: "Entidade",
  entity_time: "Entidade × Tempo",
  entity_event: "Entidade × Evento",
  entity_product_time: "Entidade × Produto × Tempo",
  custom_aggregated: "Agregação customizada",
};

const TEMPORAL_MODE_LABELS: Record<string, string> = {
  snapshot_supervised: "Snapshot supervisionado",
  event_supervised: "Supervisão por evento",
  time_series: "Série temporal",
  atemporal: "Atemporal",
};

const SPLIT_LABELS: Record<string, string> = {
  temporal: "Temporal",
  stratified: "Estratificado",
  random: "Aleatório",
  grouped_by_entity: "Agrupado por entidade",
  blocked_temporal: "Temporal bloqueado",
};

export default function GrainTimeStrategyPanel({ resolution, loading }: GrainTimeStrategyPanelProps) {
  if (loading || !resolution) return null;

  const { grain, time, split, build_plan, temporal_readiness, overall_confidence, auto_fixes_applied } = resolution;

  const confidenceColor = overall_confidence >= 0.7 ? "text-green-600" : overall_confidence >= 0.5 ? "text-yellow-600" : "text-destructive";
  const confidenceBg = overall_confidence >= 0.7 ? "bg-green-500/10 border-green-500/20" : overall_confidence >= 0.5 ? "bg-yellow-500/10 border-yellow-500/20" : "bg-destructive/10 border-destructive/20";

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Layers className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold">Estratégia Temporal & Grain</h3>
        <Badge variant="outline" className={`text-[10px] py-0 ${confidenceBg} ${confidenceColor}`}>
          {Math.round(overall_confidence * 100)}% confiança
        </Badge>
      </div>

      {/* Summary grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SummaryItem
          icon={<Layers className="w-4 h-4" />}
          label="Grain"
          value={GRAIN_LABELS[grain.recommended_grain] || grain.recommended_grain}
          ok={grain.confidence >= 0.6}
        />
        <SummaryItem
          icon={<Clock className="w-4 h-4" />}
          label="Tempo"
          value={time.time_column || "Não detectado"}
          ok={time.time_valid}
          warn={time.time_required && !time.time_valid}
        />
        <SummaryItem
          icon={<GitBranch className="w-4 h-4" />}
          label="Split"
          value={SPLIT_LABELS[split.recommended_split] || split.recommended_split}
          ok={split.confidence >= 0.6}
        />
        <SummaryItem
          icon={<Database className="w-4 h-4" />}
          label="Modo builder"
          value={build_plan.builder_mode.replace(/_/g, " ")}
          ok={true}
        />
        <SummaryItem
          icon={<Layers className="w-4 h-4" />}
          label="Agregação"
          value={build_plan.requires_aggregation ? "Necessária" : "Não"}
          ok={true}
        />
        <SummaryItem
          icon={<Clock className="w-4 h-4" />}
          label="Snapshot"
          value={build_plan.requires_snapshots ? "Necessário" : "Não"}
          ok={true}
        />
      </div>

      {/* Auto-fixes */}
      {auto_fixes_applied.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {auto_fixes_applied.map((fix, i) => (
            <Badge key={i} variant="outline" className="text-[10px] py-0">
              <Wand2 className="w-3 h-3 mr-1" /> {fix.replace(/_/g, " ").toLowerCase()}
            </Badge>
          ))}
        </div>
      )}

      {/* Temporal readiness warning */}
      {temporal_readiness.status === "unavailable" && time.time_required && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs">
          <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-yellow-700 dark:text-yellow-400">Problema temporal sem coluna de tempo válida</p>
            <p className="text-muted-foreground mt-0.5">O split será estratificado como fallback. Considere adicionar uma coluna temporal ao dataset.</p>
          </div>
        </div>
      )}

      {/* Detailed accordion */}
      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="details" className="border-border/50">
          <AccordionTrigger className="text-xs text-muted-foreground py-2">
            <div className="flex items-center gap-1.5">
              <Info className="w-3 h-3" />
              Detalhes técnicos
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 text-xs">
            {/* Grain reasoning */}
            <DetailSection title="Grain" items={grain.grain_reasoning} confidence={grain.confidence} />

            {/* Time reasoning */}
            <DetailSection title="Tempo" items={time.time_reasoning} confidence={time.confidence}>
              {time.time_column && (
                <div className="text-muted-foreground">
                  Tipo: <span className="font-medium">{TEMPORAL_MODE_LABELS[time.temporal_mode] || time.temporal_mode}</span>
                  {time.window_days && <> · Janela: <span className="font-medium">{time.window_days} dias</span></>}
                </div>
              )}
            </DetailSection>

            {/* Split reasoning */}
            <DetailSection title="Split" items={split.split_reasoning} confidence={split.confidence}>
              {split.fallback_split && (
                <div className="text-muted-foreground">
                  Fallback: <span className="font-medium">{SPLIT_LABELS[split.fallback_split]}</span>
                  {split.fallback_reason && <> — {split.fallback_reason}</>}
                </div>
              )}
            </DetailSection>

            {/* Builder */}
            <DetailSection title="Builder" items={build_plan.builder_reasoning} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function SummaryItem({ icon, label, value, ok, warn }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok: boolean;
  warn?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 p-2.5 rounded-lg text-xs border ${
      warn ? "bg-yellow-500/5 border-yellow-500/20" :
      ok ? "bg-green-500/5 border-green-500/20" :
      "bg-muted/30 border-border/50"
    }`}>
      <span className={warn ? "text-yellow-500" : ok ? "text-green-500" : "text-muted-foreground"}>{icon}</span>
      <div className="min-w-0">
        <div className="text-muted-foreground">{label}</div>
        <div className="font-medium truncate">{value}</div>
      </div>
    </div>
  );
}

function DetailSection({ title, items, confidence, children }: {
  title: string;
  items: string[];
  confidence?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{title}</span>
        {confidence !== undefined && (
          <Badge variant="outline" className="text-[9px] py-0">
            {Math.round(confidence * 100)}%
          </Badge>
        )}
      </div>
      <ul className="space-y-0.5 ml-3">
        {items.map((item, i) => (
          <li key={i} className={`flex items-start gap-1.5 ${item.startsWith("⚠") || item.startsWith("Auto-fix") ? "text-yellow-600" : "text-muted-foreground"}`}>
            <span className="mt-1">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}
