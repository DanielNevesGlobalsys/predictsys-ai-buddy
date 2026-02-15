import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { TemplateFeedbackWidget } from '@/components/feedback/TemplateFeedbackWidget';
import { supabase } from '@/integrations/supabase/client';

interface DashboardFeedbackWidgetProps {
  projectId: string;
}

export function DashboardFeedbackWidget({ projectId }: DashboardFeedbackWidgetProps) {
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [industry, setIndustry] = useState<string | undefined>(undefined);

  useEffect(() => {
    async function resolveTemplate() {
      const { data: aiCtx } = await supabase
        .from('project_ai_context')
        .select('context')
        .eq('project_id', projectId)
        .maybeSingle();

      if (aiCtx?.context) {
        const ctx = aiCtx.context as any;
        const tId = ctx?.intent_contract?.domain_adapter?.recommended_templates?.[0]?.template_id
          || ctx?.intent_contract?.template_id
          || 'unknown';
        setTemplateId(tId);
        const ind = ctx?.intent_contract?.domain_adapter?.industry
          || ctx?.intent_contract?.industry_hint;
        if (ind) setIndustry(ind);
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
        industry={industry}
      />
    </Card>
  );
}
