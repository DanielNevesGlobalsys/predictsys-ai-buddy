
-- Fix overly-permissive service role policy to only allow service_role
DROP POLICY "Service role full access on column inference" ON public.project_column_inference;

CREATE POLICY "Service role can manage column inference"
  ON public.project_column_inference
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
