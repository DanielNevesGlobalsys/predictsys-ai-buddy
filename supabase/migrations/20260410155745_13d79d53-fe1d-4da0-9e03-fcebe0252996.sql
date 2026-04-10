
UPDATE public.project_settings
SET active_target_column = 'agg_sacas_mes',
    active_target_mode = 'column',
    updated_at = now()
WHERE project_id = '4493f864-9688-45a3-b953-65d1ba3b5677'
  AND active_target_column = 'Detalhe Movimentação.QTDPES';
