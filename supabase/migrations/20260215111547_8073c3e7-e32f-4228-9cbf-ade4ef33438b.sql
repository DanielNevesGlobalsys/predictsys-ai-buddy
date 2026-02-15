
-- 1) Add 'source' column to track manual vs recommended
ALTER TABLE public.project_template_feedback
ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- 2) Add 'recommendation_id' to track which recommendation was followed
ALTER TABLE public.project_template_feedback
ADD COLUMN IF NOT EXISTS recommendation_id text DEFAULT NULL;

-- 3) Unique constraint for implicit feedback dedup per batch
CREATE UNIQUE INDEX IF NOT EXISTS uq_implicit_feedback_per_batch
ON public.project_template_feedback (project_id, batch_id, template_id, feedback_type)
WHERE feedback_type = 'implicit' AND batch_id IS NOT NULL;
