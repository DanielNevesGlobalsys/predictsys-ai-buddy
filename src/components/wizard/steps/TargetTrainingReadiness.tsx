import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, AlertTriangle, Shield } from "lucide-react";

interface ReadinessCheck {
  label: string;
  ok: boolean;
  detail: string;
}

interface Props {
  checks: ReadinessCheck[];
}

export default function TargetTrainingReadiness({ checks }: Props) {
  const allOk = checks.every(c => c.ok);
  const hasFailure = checks.some(c => !c.ok);
  const failCount = checks.filter(c => !c.ok).length;

  return (
    <div className={`p-5 rounded-xl border space-y-3 ${
      allOk
        ? "border-accent/30 bg-accent/5"
        : hasFailure
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-border bg-muted/10"
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className={`w-5 h-5 ${allOk ? "text-accent" : "text-amber-500"}`} />
          <h3 className="text-base font-semibold">Prontidão do treino</h3>
        </div>
        {allOk ? (
          <Badge className="bg-accent/20 text-accent border-accent/30">Pronto</Badge>
        ) : (
          <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">
            {failCount} pendência{failCount > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      <div className="grid gap-1.5">
        {checks.map((check, i) => (
          <div key={i} className="flex items-center justify-between text-sm py-1">
            <div className="flex items-center gap-2">
              {check.ok ? (
                <CheckCircle className="w-4 h-4 text-accent" />
              ) : (
                <XCircle className="w-4 h-4 text-destructive" />
              )}
              <span className={check.ok ? "text-foreground" : "text-destructive"}>{check.label}</span>
            </div>
            <span className="text-xs text-muted-foreground truncate max-w-[180px]">{check.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
