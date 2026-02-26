ALTER TABLE public.project_settings 
ADD COLUMN IF NOT EXISTS objective text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS business_intent_contract jsonb DEFAULT NULL;