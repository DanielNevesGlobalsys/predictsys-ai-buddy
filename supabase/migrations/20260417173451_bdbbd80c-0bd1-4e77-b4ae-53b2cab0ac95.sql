UPDATE public.project_settings
SET builder_state = 'draft',
    training_state = 'idle',
    updated_at = now()
WHERE project_id = 'aad62592-1394-4606-9b2e-a7b9d8e5a1cc'
  AND (builder_state = 'building' OR training_state = 'running');

UPDATE public.project_dataset_state
SET row_count = 397937,
    col_count = GREATEST(col_count, 114),
    diagnostics = COALESCE(diagnostics, '{}'::jsonb) || jsonb_build_object(
      'auto_repaired_from', 'manual_unstuck',
      'repaired_at', now()::text
    ),
    updated_at = now()
WHERE project_id = 'aad62592-1394-4606-9b2e-a7b9d8e5a1cc'
  AND row_count = 0;