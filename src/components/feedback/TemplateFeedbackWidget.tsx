import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThumbsUp, ThumbsDown, Minus, Loader2, MessageSquare } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface TemplateFeedbackWidgetProps {
  projectId: string;
  templateId: string;
  context?: 'target_builder' | 'dashboard';
}

const QUICK_TAGS_TARGET = ['confuso', 'bom', 'métricas fracas', 'dados ruins', 'parâmetros errados'];
const QUICK_TAGS_DASHBOARD = ['ações úteis', 'confuso', 'não confio', 'irrelevante', 'preciso'];

export function TemplateFeedbackWidget({ projectId, templateId, context = 'target_builder' }: TemplateFeedbackWidgetProps) {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showTags, setShowTags] = useState(false);

  const quickTags = context === 'dashboard' ? QUICK_TAGS_DASHBOARD : QUICK_TAGS_TARGET;

  const submitFeedback = useCallback(async (rating: number) => {
    setSelectedRating(rating);

    // If negative, show tags first
    if (rating <= 2 && !showTags) {
      setShowTags(true);
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke('submit-template-feedback', {
        body: {
          project_id: projectId,
          template_id: templateId,
          rating,
          tags: selectedTags,
        },
      });
      if (error) throw error;
      setSubmitted(true);
      toast.success('Feedback registrado!');
    } catch (err) {
      console.error('Feedback error:', err);
      toast.error('Erro ao enviar feedback');
    } finally {
      setSubmitting(false);
    }
  }, [projectId, templateId, selectedTags, showTags]);

  const confirmWithTags = useCallback(async () => {
    setSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke('submit-template-feedback', {
        body: {
          project_id: projectId,
          template_id: templateId,
          rating: selectedRating,
          tags: selectedTags,
        },
      });
      if (error) throw error;
      setSubmitted(true);
      toast.success('Feedback registrado!');
    } catch (err) {
      toast.error('Erro ao enviar feedback');
    } finally {
      setSubmitting(false);
    }
  }, [projectId, templateId, selectedRating, selectedTags]);

  const toggleTag = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  if (submitted) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <MessageSquare className="w-3 h-3" />
        <span>Obrigado pelo feedback!</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {context === 'dashboard' ? 'Este resultado ajudou?' : 'Este template faz sentido?'}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 w-7 p-0 ${selectedRating === 5 ? 'bg-emerald-500/20 text-emerald-600' : ''}`}
            onClick={() => submitFeedback(5)}
            disabled={submitting}
          >
            {submitting && selectedRating === 5 ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsUp className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 w-7 p-0 ${selectedRating === 3 ? 'bg-amber-500/20 text-amber-600' : ''}`}
            onClick={() => submitFeedback(3)}
            disabled={submitting}
          >
            <Minus className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 w-7 p-0 ${selectedRating === 1 ? 'bg-destructive/20 text-destructive' : ''}`}
            onClick={() => submitFeedback(1)}
            disabled={submitting}
          >
            <ThumbsDown className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {showTags && (
        <div className="space-y-2 p-2 bg-muted/30 rounded-lg border border-border">
          <p className="text-xs text-muted-foreground">O que poderia melhorar?</p>
          <div className="flex flex-wrap gap-1.5">
            {quickTags.map(tag => (
              <Badge
                key={tag}
                variant={selectedTags.includes(tag) ? 'default' : 'outline'}
                className="cursor-pointer text-xs"
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </Badge>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="text-xs mt-1"
            onClick={confirmWithTags}
            disabled={submitting}
          >
            {submitting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Enviar feedback
          </Button>
        </div>
      )}
    </div>
  );
}
