UPDATE project_settings 
SET dataset_build_mode = 'temporal_aggregated',
    training_state = 'idle',
    updated_at = now()
WHERE project_id = '4493f864-9688-45a3-b953-65d1ba3b5677';