import { useEffect } from 'react';
import { useProjectAIContext } from '@/hooks/useProjectAIContext';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Brain, Check } from 'lucide-react';

interface WizardContextProgressProps {
  projectId: string | undefined;
}

interface StageInfo {
  key: 'eda' | 'targeting' | 'training' | 'predictions' | 'business' | 'storyline';
  label: string;
  check: (ctx: any) => boolean;
}

const STAGES: StageInfo[] = [
  {
    key: 'eda',
    label: 'EDA',
    check: (ctx) => !!(ctx.eda?.summary || (ctx.eda?.warnings && ctx.eda.warnings.length > 0)),
  },
  {
    key: 'targeting',
    label: 'Target',
    check: (ctx) => !!ctx.targeting?.selected_target,
  },
  {
    key: 'training',
    label: 'Treino',
    check: (ctx) => !!ctx.training?.model_type,
  },
  {
    key: 'predictions',
    label: 'Predições',
    check: (ctx) => !!(ctx.predictions?.horizons && Object.keys(ctx.predictions.horizons).length > 0),
  },
  {
    key: 'storyline',
    label: 'Narrativa',
    check: (ctx) => !!ctx.storyline?.executive_summary,
  },
];

export function WizardContextProgress({ projectId }: WizardContextProgressProps) {
  const { context, loading, loaded, loadContext } = useProjectAIContext(projectId);

  useEffect(() => {
    if (projectId && !loaded) {
      loadContext();
    }
  }, [projectId, loaded, loadContext]);

  if (!projectId || loading || !loaded) return null;

  const completedCount = STAGES.filter((s) => s.check(context)).length;

  if (completedCount === 0) return null;

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2 px-4 py-2 bg-card/50 rounded-lg border border-border/40">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 cursor-help">
              <Brain className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium text-muted-foreground">
                Lys: {completedCount}/{STAGES.length}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p className="font-semibold mb-2">O que a Lys já sabe sobre o projeto:</p>
            <ul className="space-y-1">
              {STAGES.map((stage) => {
                const done = stage.check(context);
                return (
                  <li key={stage.key} className="flex items-center gap-2 text-xs">
                    {done ? (
                      <Check className="w-3 h-3 text-green-500" />
                    ) : (
                      <div className="w-3 h-3 rounded-full border border-muted-foreground/30" />
                    )}
                    <span className={done ? 'text-foreground' : 'text-muted-foreground'}>
                      {stage.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </TooltipContent>
        </Tooltip>

        <div className="flex gap-0.5">
          {STAGES.map((stage) => {
            const done = stage.check(context);
            return (
              <div
                key={stage.key}
                className={`w-5 h-1.5 rounded-full transition-colors ${
                  done ? 'bg-primary' : 'bg-muted'
                }`}
              />
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
