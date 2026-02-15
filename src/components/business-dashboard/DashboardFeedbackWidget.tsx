import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { TemplateFeedbackWidget } from '@/components/feedback/TemplateFeedbackWidget';
import { supabase } from '@/integrations/supabase/client';

interface DashboardFeedbackWidgetProps {
  projectId: string;
}

export function DashboardFeedbackWidget({ projectId }: DashboardFeedbackWidgetProps) {
  const [templateId, setTemplateId] = useState<string | null>(null);

  useEffect(() => {
    async function resolveTemplate() {
      const { data } = await supabase
        .from('project_ai_context')
        .select('context')
        .eq('project_id', projectId)
        .maybeSingle();

      if (data?.context) {
        const ctx = data.context as any;
        const tId = ctx?.intent_contract?.domain_adapter?.recommended_templates?.[0]?.template_id
          || ctx?.intent_contract?.template_id
          || 'unknown';
        setTemplateId(tId);
      }
    }
    resolveTemplate();
  }, [projectId]);

  if (!templateId) return null;

  return (
    <Card className="p-4 border-border/50">
      <TemplateFeedbackWidget
        projectId={projectId}
        templateId={templateId}
        context="dashboard"
      />
    </Card>
  );
}
