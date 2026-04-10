
UPDATE project_dataset_state 
SET active_schema_json = active_schema_json || '{"agg_sacas_mes": "numeric", "agg_movimentacoes": "numeric", "agg_codpes_distintos": "numeric"}'::jsonb,
    updated_at = now()
WHERE project_id = '4493f864-9688-45a3-b953-65d1ba3b5677';
