import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { LysSynthesisResult } from "@/hooks/useLysSynthesis";

interface Props {
  synthesis: LysSynthesisResult;
  loaded: boolean;
}

export default function TargetLysSuggestion({ synthesis, loaded }: Props) {
  if (!loaded || !synthesis.narrative) return null;

  const rec = synthesis.recommendation;
  const confidence = synthesis.confidence_score;

  return (
    <div className="p-4 rounded-xl border border-secondary/20 bg-secondary/5 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-secondary" />
        <h4 className="text-sm font-semibold">Sugestão da Liz</h4>
        {confidence != null && confidence > 0 && (
          <Badge variant="outline" className="text-[10px]">
            {Math.round(confidence * 100)}% confiança
          </Badge>
        )}
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed">
        {synthesis.narrative}
      </p>

      {rec?.alternative_target_candidates && rec.alternative_target_candidates.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-[10px] text-muted-foreground">Alternativas:</span>
          {rec.alternative_target_candidates.slice(0, 3).map((alt, i) => (
            <Badge key={i} variant="outline" className="text-[10px]">
              {alt.column}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
