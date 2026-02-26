
CREATE OR REPLACE FUNCTION public.compute_eda_ready(p_project_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_active_dataset boolean := false;
  v_has_sample boolean := false;
  v_has_numeric_stats boolean := false;
  v_has_eda_profile boolean := false;
  v_eda_status text := 'unknown';
  v_eda_state text := 'unknown';
  v_rows_len int := 0;
  v_cols_len int := 0;
  v_eda_ready boolean := false;
  v_reasons text[] := '{}';
BEGIN
  -- 1. Check active dataset (project_datasets OR project_dataset_state)
  SELECT true, COALESCE(pd.total_rows, 0), COALESCE(pd.columns_count, 0)
  INTO v_has_active_dataset, v_rows_len, v_cols_len
  FROM public.project_datasets pd
  WHERE pd.project_id = p_project_id AND pd.is_active = true
  ORDER BY pd.created_at DESC
  LIMIT 1;

  IF NOT v_has_active_dataset THEN
    -- Fallback: project_dataset_state
    SELECT true, COALESCE(ds.row_count, 0), COALESCE(ds.col_count, 0)
    INTO v_has_active_dataset, v_rows_len, v_cols_len
    FROM public.project_dataset_state ds
    WHERE ds.project_id = p_project_id AND ds.row_count > 0;
  END IF;

  IF NOT COALESCE(v_has_active_dataset, false) THEN
    -- Fallback: project_settings ingestion
    SELECT true, COALESCE(ps.ingestion_rows_detected, 0), COALESCE(ps.ingestion_cols_detected, 0)
    INTO v_has_active_dataset, v_rows_len, v_cols_len
    FROM public.project_settings ps
    WHERE ps.project_id = p_project_id AND ps.ingestion_state = 'done' AND ps.ingestion_rows_detected > 0;
  END IF;

  v_has_active_dataset := COALESCE(v_has_active_dataset, false);

  -- 2. Check sample exists
  SELECT true INTO v_has_sample
  FROM public.project_dataset_sample
  WHERE project_id = p_project_id
  LIMIT 1;
  v_has_sample := COALESCE(v_has_sample, false);

  -- 3. Check numeric stats exist
  SELECT true INTO v_has_numeric_stats
  FROM public.project_numeric_stats
  WHERE project_id = p_project_id
  LIMIT 1;
  v_has_numeric_stats := COALESCE(v_has_numeric_stats, false);

  -- 4. Check EDA profile and status from project_settings
  SELECT
    COALESCE(ps.eda_profile_json IS NOT NULL, false),
    COALESCE(ps.eda_status, 'unknown'),
    COALESCE(ps.eda_state, 'unknown')
  INTO v_has_eda_profile, v_eda_status, v_eda_state
  FROM public.project_settings ps
  WHERE ps.project_id = p_project_id;

  v_has_eda_profile := COALESCE(v_has_eda_profile, false);
  v_eda_status := COALESCE(v_eda_status, 'unknown');
  v_eda_state := COALESCE(v_eda_state, 'unknown');

  -- 5. Compute eda_ready + reasons
  IF NOT v_has_active_dataset THEN
    v_reasons := array_append(v_reasons, 'no_active_dataset');
  END IF;
  IF v_rows_len <= 0 THEN
    v_reasons := array_append(v_reasons, 'zero_rows');
  END IF;
  IF v_cols_len < 2 THEN
    v_reasons := array_append(v_reasons, 'insufficient_columns');
  END IF;
  IF NOT v_has_sample THEN
    v_reasons := array_append(v_reasons, 'no_sample');
  END IF;

  -- EDA evidence check
  IF NOT (v_has_numeric_stats OR v_has_eda_profile OR v_eda_status = 'succeeded' OR v_eda_state = 'done') THEN
    v_reasons := array_append(v_reasons, 'no_eda_evidence');
  END IF;

  -- Final decision
  v_eda_ready := (
    v_has_active_dataset
    AND v_rows_len > 0
    AND v_cols_len >= 2
    AND (v_has_numeric_stats OR v_has_eda_profile OR v_eda_status = 'succeeded' OR v_eda_state = 'done')
  );

  RETURN jsonb_build_object(
    'eda_ready', v_eda_ready,
    'reasons', to_jsonb(v_reasons),
    'evidence', jsonb_build_object(
      'has_active_dataset', v_has_active_dataset,
      'has_sample', v_has_sample,
      'has_numeric_stats', v_has_numeric_stats,
      'has_eda_profile', v_has_eda_profile,
      'eda_status', v_eda_status,
      'eda_state', v_eda_state,
      'rows_len', v_rows_len,
      'cols_len', v_cols_len
    )
  );
END;
$function$;
