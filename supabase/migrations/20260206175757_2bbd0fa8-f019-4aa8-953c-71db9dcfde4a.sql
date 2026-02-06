
-- Add UPDATE policy for datasets storage bucket (needed for upsert)
CREATE POLICY "Users can update their own datasets"
ON storage.objects
FOR UPDATE
USING (
  bucket_id = 'datasets'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);
