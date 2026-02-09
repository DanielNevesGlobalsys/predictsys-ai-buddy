-- Allow authenticated users to read their own import manifests
CREATE POLICY "Users can read their own import manifests"
  ON public.import_manifests FOR SELECT
  USING (auth.uid() = user_id);
