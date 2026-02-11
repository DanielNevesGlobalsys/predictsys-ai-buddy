import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CheckCircle, XCircle, AlertTriangle, Shield, Target,
  SplitSquareVertical, Activity, BarChart3, ChevronDown, ChevronUp
} from "lucide-react";
import { useState } from "react";

export interface TrainingGateData {
  can_train: boolean;
  status: "READY" | "WARNING" | "BLOCKED";
  blocked_reason_code: string | null;
  label_report: {
    target_col: string;
    problem_type: string;
    n_rows: number;
    n_classes: number | null;
    positive_rate: number | null;
    dominant_class_rate: number | null;
    unique_ratio: number | null;
    warnings: string[];
  };
  leakage_report: {
    leakage_detected: boolean;
    leakage_columns: { column: string; reason: string }[];
    notes: string[];
  };
  split_plan: {
    strategy: string;
    anchor_time_col: string | null;
    train_frac: number;
    val_frac: number;
    test_frac: number;
  };
  sanity_report: {
    min_rows_ok: boolean;
    min_features_ok: boolean;
    missing_global_pct: number;
    overfit_risk_score: number;
    warnings: string[];
  };
  dashboard_allowed_precheck: boolean;
  next_action: string;
}

interface Props {
  gate: TrainingGateData;
}

function GateIcon({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle className="w-3.5 h-3.5 text-accent shrink-0" />
    : <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />;
}

function GateSection({ title, icon, ok, children }: { title: string; icon: React.ReactNode; ok: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!ok);
  return (
    <div className="border border-border/50 rounded p-2 space-y-1">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left text-xs font-medium">
        {icon}
        <span className="flex-1">{title}</span>
        <GateIcon ok={ok} />
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && <div className="pl-5 text-[11px] text-muted-foreground space-y-1">{children}</div>}
    </div>
  );
}

export default function TrainingGateReport({ gate }: Props) {
  const { label_report: lr, leakage_report: lk, split_plan: sp, sanity_report: sr } = gate;

  const statusColor = gate.status === "READY"
    ? "bg-accent/20 text-accent border-accent/30"
    : gate.status === "WARNING"
    ? "bg-amber-500/20 text-amber-600 border-amber-500/30"
    : "bg-destructive/20 text-destructive border-destructive/30";

  const labelOk = lr.warnings.length === 0;
  const leakageOk = !lk.leakage_detected && lk.notes.length === 0;
  const splitOk = sr.warnings.filter(w => w.includes("Split")).length === 0;
  const sanityOk = sr.min_rows_ok && sr.min_features_ok && sr.missing_global_pct < 50;

  return (
    <div className="p-3 rounded-lg border border-border bg-muted/5 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-primary" />
          <h4 className="text-xs font-semibold">🛡️ Training Gate Report (4.3)</h4>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={`${statusColor} text-[10px]`}>
            {gate.status === "READY" ? <CheckCircle className="w-3 h-3 mr-1" /> : gate.status === "WARNING" ? <AlertTriangle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
            {gate.can_train ? "can_train=true" : "can_train=false"}
          </Badge>
          {gate.blocked_reason_code && (
            <Badge variant="destructive" className="text-[10px]">{gate.blocked_reason_code}</Badge>
          )}
        </div>
      </div>

      {/* Gate sections */}
      <div className="space-y-2">
        {/* Label Gate */}
        <GateSection title="LabelGate — Target Validation" icon={<Target className="w-3.5 h-3.5 text-primary" />} ok={labelOk}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span>Target: <strong>{lr.target_col}</strong></span>
            <span>Tipo: <strong>{lr.problem_type}</strong></span>
            <span>Linhas: <strong>{lr.n_rows.toLocaleString()}</strong></span>
            <span>Classes: <strong>{lr.n_classes ?? "N/A"}</strong></span>
            {lr.positive_rate !== null && <span>Taxa positiva: <strong>{(lr.positive_rate * 100).toFixed(1)}%</strong></span>}
            {lr.dominant_class_rate !== null && <span>Classe dominante: <strong>{(lr.dominant_class_rate * 100).toFixed(1)}%</strong></span>}
            {lr.unique_ratio !== null && <span>Unique ratio: <strong>{(lr.unique_ratio * 100).toFixed(1)}%</strong></span>}
          </div>
          {lr.warnings.map((w, i) => (
            <p key={i} className="text-destructive text-[11px]">⚠ {w}</p>
          ))}
          {labelOk && <p className="text-accent">✓ Target válido para treino.</p>}
        </GateSection>

        {/* Leakage Gate */}
        <GateSection title="LeakageGate — Vazamento de dados" icon={<Shield className="w-3.5 h-3.5 text-primary" />} ok={leakageOk}>
          {lk.leakage_columns.length > 0 ? (
            <div className="space-y-0.5">
              {lk.leakage_columns.map((lc, i) => (
                <p key={i} className="text-destructive">🔴 {lc.column}: {lc.reason}</p>
              ))}
            </div>
          ) : (
            <p className="text-accent">✓ Nenhum leakage detectado.</p>
          )}
          {lk.notes.map((n, i) => (
            <p key={i} className={n.startsWith("BLOCKED") ? "text-destructive" : "text-amber-600"}>• {n}</p>
          ))}
        </GateSection>

        {/* Split Gate */}
        <GateSection title="SplitGate — Estratégia de divisão" icon={<SplitSquareVertical className="w-3.5 h-3.5 text-primary" />} ok={splitOk}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span>Estratégia: <strong>{sp.strategy}</strong></span>
            <span>Tempo: <strong>{sp.anchor_time_col || "—"}</strong></span>
            <span>Train: <strong>{Math.round(sp.train_frac * 100)}%</strong></span>
            <span>Val: <strong>{Math.round(sp.val_frac * 100)}%</strong> / Test: <strong>{Math.round(sp.test_frac * 100)}%</strong></span>
          </div>
          {sr.warnings.filter(w => w.includes("Split") || w.includes("split") || w.includes("temporal")).map((w, i) => (
            <p key={i} className="text-amber-600">⚠ {w}</p>
          ))}
        </GateSection>

        {/* Sanity Gate */}
        <GateSection title="SanityGate — Saúde do dataset" icon={<Activity className="w-3.5 h-3.5 text-primary" />} ok={sanityOk}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span>Linhas ≥ 500: <GateIcon ok={sr.min_rows_ok} /></span>
            <span>Features ≥ 3: <GateIcon ok={sr.min_features_ok} /></span>
            <span>Missing global: <strong>{sr.missing_global_pct}%</strong></span>
            <span>Overfit risk: <strong>{Math.round(sr.overfit_risk_score * 100)}%</strong></span>
          </div>
          {sr.warnings.map((w, i) => (
            <p key={i} className={w.includes("BLOCKED") || w.includes("excessivo") ? "text-destructive" : "text-amber-600"}>⚠ {w}</p>
          ))}
          {sanityOk && sr.warnings.length === 0 && <p className="text-accent">✓ Dataset saudável para treino.</p>}
        </GateSection>
      </div>

      {/* Dashboard precheck */}
      <div className="flex items-center gap-2 text-[11px] border-t border-border/50 pt-2">
        <BarChart3 className="w-3 h-3" />
        <span>Dashboard precheck: </span>
        {gate.dashboard_allowed_precheck
          ? <Badge variant="outline" className="text-[10px] border-accent/30 text-accent">Permitido</Badge>
          : <Badge variant="outline" className="text-[10px] border-destructive/30 text-destructive">Bloqueado</Badge>
        }
        <span className="ml-auto text-muted-foreground">→ {gate.next_action}</span>
      </div>
    </div>
  );
}
