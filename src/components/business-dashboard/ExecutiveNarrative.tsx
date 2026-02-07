import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BookOpen, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ExecutiveNarrativeProps {
  projectId: string;
  executiveSummary: string;
  lastUpdateReason: string;
  generatedAt: string | null;
  contextStatus: string;
  onRefresh: () => void;
}

export function ExecutiveNarrative({
  projectId,
  executiveSummary,
  lastUpdateReason,
  generatedAt,
  contextStatus,
  onRefresh,
}: ExecutiveNarrativeProps) {
  const { t } = useTranslation();
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-executive-summary', {
        body: {
          project_id: projectId,
          trigger_reason: 'Gerado manualmente pelo usuário',
        },
      });

      if (error) throw error;

      toast.success('Narrativa executiva atualizada');
      onRefresh();
    } catch (err) {
      console.error('Error generating executive summary:', err);
      toast.error('Erro ao gerar narrativa executiva');
    } finally {
      setGenerating(false);
    }
  };

  const statusLabel = contextStatus === 'predictions_ready'
    ? 'Predições prontas'
    : contextStatus === 'model_trained'
    ? 'Modelo treinado'
    : contextStatus === 'business_ready'
    ? 'Negócio configurado'
    : contextStatus;

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              Narrativa Executiva — Lys
            </CardTitle>
            <CardDescription>
              Resumo inteligente baseado em todas as etapas do projeto
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {contextStatus && (
              <Badge variant="outline" className="text-xs">
                {statusLabel}
              </Badge>
            )}
            <Button
              variant={executiveSummary ? 'outline' : 'default'}
              size="sm"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Gerando...
                </>
              ) : executiveSummary ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Atualizar
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Gerar Narrativa
                </>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {executiveSummary ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed whitespace-pre-line">
              {executiveSummary}
            </p>
            {(lastUpdateReason || generatedAt) && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground pt-2 border-t border-border">
                {lastUpdateReason && (
                  <span>Motivo: {lastUpdateReason}</span>
                )}
                {generatedAt && (
                  <span>
                    Atualizado em: {new Date(generatedAt).toLocaleString('pt-BR')}
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-6">
            <Sparkles className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">
              Clique em "Gerar Narrativa" para que a Lys crie um resumo executivo com base em todo o contexto acumulado do projeto.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
