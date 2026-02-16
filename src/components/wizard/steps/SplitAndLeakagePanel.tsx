import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Loader2,
  SplitSquareVertical,
  ShieldAlert,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ChevronDown,
  Scale,
  Eye,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

interface SplitPreview {
  train_rows: number;
  valid_rows: number;
  test_rows: number;
  time_ranges?: { split: string; from: string; to: string }[];
  notes: string[];
}

interface SplitAndLeakagePanelProps {
  projectId: string;
  leakageRemovals?: { column: string; reason: string; source: string }[];
  leakageReasons?: string[];
}

const SplitAndLeakagePanel = ({
  projectId,
  leakageRemovals = [],
  leakageReasons = [],
}: SplitAndLeakagePanelProps) => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [strategy, setStrategy] = useState<string>("temporal");
  const [preview, setPreview] = useState<SplitPreview | null>(null);
  const [gates, setGates] = useState<GateResult[]>([]);
  const [policyStatus, setPolicyStatus] = useState<string | null>(null);
  const [classBalance, setClassBalance] = useState<{ method: string; threshold: number } | null>(null);
  const [timeAnchor, setTimeAnchor] = useState<string | null>(null);
  const [entityKey, setEntityKey] = useState<string | null>(null);
  const [leakageOpen, setLeakageOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Load existing policy on mount
  useEffect(() => {
    loadExistingPolicy();
  }, [projectId]);

  const loadExistingPolicy = async () => {
    const { data } = await supabase
      .from("project_split_policies" as any)
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      const d = data as any;
      setStrategy(d.strategy || "temporal");
      setTimeAnchor(d.time_anchor_column);
      setEntityKey(d.entity_key_column);
      setPolicyStatus(d.status);
      if (d.preview) {
        setPreview({
          train_rows: d.preview.train_rows || 0,
          valid_rows: d.preview.valid_rows || 0,
          test_rows: d.preview.test_rows || 0,
          time_ranges: d.preview.time_ranges,
          notes: d.preview.notes || [],
        });
        setGates(d.preview.gates || []);
      }
      setHasLoaded(true);
    }
  };

  const handlePreview = async () => {
    setLoading(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;

      const res = await supabase.functions.invoke("preview-split-policy", {
        body: { project_id: projectId, strategy },
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (res.error) throw new Error(res.error.message);
      const result = res.data;

      setPreview(result.preview);
      setGates(result.gates || []);
      setPolicyStatus(result.gates?.some((g: GateResult) => g.status === "BLOCK") ? "blocked" : "ready");
      setTimeAnchor(result.policy?.time_anchor_column || null);
      setEntityKey(result.policy?.entity_key_column || null);
      setClassBalance(result.class_balance || null);
      setHasLoaded(true);

      toast({
        title: "Split Policy Preview",
        description: `Estratégia ${result.policy?.strategy}: treino=${result.preview?.train_rows}, teste=${result.preview?.test_rows}`,
      });
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
    setLoading(false);
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "PASS": return <CheckCircle className="w-3.5 h-3.5 text-accent" />;
      case "WARN": return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
      case "BLOCK": return <XCircle className="w-3.5 h-3.5 text-destructive" />;
      default: return null;
    }
  };

  return (
    <Card className="p-5 space-y-4 border-border">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-secondary/10 rounded-xl flex items-center justify-center">
          <SplitSquareVertical className="w-5 h-5 text-secondary" />
        </div>
        <div>
          <h3 className="font-semibold text-sm">Split & Leakage Guard</h3>
          <p className="text-xs text-muted-foreground">Estratégia de divisão, proteção contra vazamento e balanceamento</p>
        </div>
        {policyStatus && (
          <Badge
            variant={policyStatus === "ready" ? "default" : "destructive"}
            className="ml-auto text-xs"
          >
            {policyStatus === "ready" ? "READY" : "BLOCKED"}
          </Badge>
        )}
      </div>

      {/* Strategy selector */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Estratégia de Split</Label>
          <Select value={strategy} onValueChange={setStrategy}>
            <SelectTrigger className="bg-background h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-popover">
              <SelectItem value="temporal">Temporal (recomendado)</SelectItem>
              <SelectItem value="grouped">Agrupado (entity_key)</SelectItem>
              <SelectItem value="random">Aleatório</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button onClick={handlePreview} disabled={loading} size="sm" variant="outline" className="w-full">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Eye className="w-4 h-4 mr-1.5" />}
            Preview Split
          </Button>
        </div>
      </div>

      {/* Detected columns */}
      {hasLoaded && (
        <div className="flex flex-wrap gap-2 text-xs">
          {timeAnchor && (
            <Badge variant="outline" className="text-xs">⏱ {timeAnchor}</Badge>
          )}
          {entityKey && (
            <Badge variant="outline" className="text-xs">👤 {entityKey}</Badge>
          )}
        </div>
      )}

      {/* Preview results */}
      {preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="p-2.5 bg-accent/5 border border-accent/20 rounded-lg text-center">
              <p className="text-lg font-bold">{preview.train_rows.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">Treino</p>
            </div>
            <div className="p-2.5 bg-secondary/5 border border-secondary/20 rounded-lg text-center">
              <p className="text-lg font-bold">{preview.valid_rows.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">Validação</p>
            </div>
            <div className="p-2.5 bg-primary/5 border border-primary/20 rounded-lg text-center">
              <p className="text-lg font-bold">{preview.test_rows.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">Teste</p>
            </div>
          </div>

          {/* Time ranges */}
          {preview.time_ranges && preview.time_ranges.length > 0 ? (
            <div className="text-xs space-y-1 p-2 bg-muted/30 rounded">
              {preview.time_ranges.map((r, i) => (
                <div key={i} className="flex justify-between">
                  <span className="font-medium capitalize">{r.split}</span>
                  <span className="text-muted-foreground font-mono">{r.from} → {r.to}</span>
                </div>
              ))}
            </div>
          ) : strategy === "temporal" && hasLoaded ? (
            <div className="text-xs p-2 bg-amber-500/5 border border-amber-500/20 rounded flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>Datas indisponíveis — coluna temporal não contém datas válidas. Selecione outra coluna de data na Etapa 2.</span>
            </div>
          ) : null}
        </div>
      )}

      {/* Gates */}
      {gates.length > 0 && (
        <div className="space-y-1.5">
          {gates.map((g, i) => (
            <div key={i} className={`flex items-start gap-2 text-xs p-2 rounded border ${
              g.status === "BLOCK" ? "bg-destructive/5 border-destructive/20" :
              g.status === "WARN" ? "bg-amber-500/5 border-amber-500/20" :
              "bg-accent/5 border-accent/20"
            }`}>
              {statusIcon(g.status)}
              <span>{g.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Leakage removals */}
      {leakageRemovals.length > 0 && (
        <Collapsible open={leakageOpen} onOpenChange={setLeakageOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm w-full p-2 rounded hover:bg-muted/30 transition-colors">
            <ShieldAlert className="w-4 h-4 text-amber-500" />
            <span className="font-medium">Removemos {leakageRemovals.length} colunas por risco de vazamento</span>
            <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${leakageOpen ? "rotate-180" : ""}`} />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-1">
            {leakageRemovals.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-xs p-1.5 bg-muted/20 rounded">
                <span className="font-mono">{r.column}</span>
                <Badge variant="outline" className="text-[10px]">{r.source}</Badge>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Class balance */}
      {classBalance && (
        <div className="flex items-center gap-2 text-xs p-2 bg-amber-500/5 border border-amber-500/20 rounded">
          <Scale className="w-4 h-4 text-amber-500" />
          <span>
            Desbalanceamento detectado ({(classBalance.threshold * 100).toFixed(0)}% classe dominante).
            Método aplicado: <strong>{classBalance.method}</strong>
          </span>
        </div>
      )}
    </Card>
  );
};

export default SplitAndLeakagePanel;
