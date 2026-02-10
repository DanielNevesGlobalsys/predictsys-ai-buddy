
-- Composite index for dashboard metric queries (partial index on is_latest=true)
CREATE INDEX IF NOT EXISTS idx_predictions_dashboard_lookup
ON public.predictions (project_id, horizon_days, probability_event)
WHERE is_latest = true;

-- Server-side aggregation function to avoid fetching all rows over HTTP
CREATE OR REPLACE FUNCTION public.calculate_dashboard_kpis(
  p_project_id uuid,
  p_horizon int DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $$
DECLARE
  v_result jsonb;
  v_problem_type text;
BEGIN
  -- Detect problem type
  SELECT problem_type INTO v_problem_type
  FROM predictions
  WHERE project_id = p_project_id AND is_latest = true
  LIMIT 1;

  v_problem_type := COALESCE(v_problem_type, 'classification');

  -- Build full aggregation in a single scan
  SELECT jsonb_build_object(
    'problem_type', v_problem_type,
    'entities_with_prediction', COUNT(DISTINCT entity_id),
    'total_rows', COUNT(*),
    'high_risk_or_opportunity', COUNT(*) FILTER (WHERE probability_event >= 0.7),
    'sum_probability', COALESCE(SUM(probability_event), 0),
    'financial_impact_class', COALESCE(SUM(probability_event * COALESCE(potential_value, predicted_value, 0)), 0),
    'total_predicted_value', COALESCE(SUM(predicted_value), 0),
    'avg_predicted_value', COALESCE(AVG(predicted_value), 0),
    'last_update', MAX(prediction_date),
    'total_latest', (
      SELECT COUNT(*) FROM predictions
      WHERE project_id = p_project_id AND is_latest = true
    ),
    'classification_buckets', CASE WHEN v_problem_type = 'classification' THEN (
      SELECT COALESCE(jsonb_agg(b ORDER BY b.bucket_order), '[]'::jsonb)
      FROM (
        SELECT
          CASE
            WHEN probability_event < 0.2 THEN '0-20%'
            WHEN probability_event < 0.4 THEN '20-40%'
            WHEN probability_event < 0.6 THEN '40-60%'
            WHEN probability_event < 0.8 THEN '60-80%'
            ELSE '80-100%'
          END as bucket,
          CASE
            WHEN probability_event < 0.2 THEN 1
            WHEN probability_event < 0.4 THEN 2
            WHEN probability_event < 0.6 THEN 3
            WHEN probability_event < 0.8 THEN 4
            ELSE 5
          END as bucket_order,
          COUNT(*) as count,
          COALESCE(AVG(COALESCE(potential_value, predicted_value, 0)), 0) as avg_value,
          COALESCE(SUM(COALESCE(potential_value, predicted_value, 0)), 0) as total_value,
          COALESCE(SUM(probability_event), 0) as expected_events
        FROM predictions
        WHERE project_id = p_project_id AND is_latest = true AND horizon_days <= p_horizon
        GROUP BY 1, 2
      ) b
    ) ELSE '[]'::jsonb END,
    'regression_stats', CASE WHEN v_problem_type != 'classification' THEN (
      SELECT jsonb_build_object(
        'p25', percentile_cont(0.25) WITHIN GROUP (ORDER BY predicted_value),
        'p50', percentile_cont(0.50) WITHIN GROUP (ORDER BY predicted_value),
        'p75', percentile_cont(0.75) WITHIN GROUP (ORDER BY predicted_value),
        'p90', percentile_cont(0.90) WITHIN GROUP (ORDER BY predicted_value),
        'min_val', MIN(predicted_value),
        'max_val', MAX(predicted_value),
        'total_count', COUNT(*)
      )
      FROM predictions
      WHERE project_id = p_project_id AND is_latest = true AND horizon_days <= p_horizon
        AND predicted_value IS NOT NULL
    ) ELSE NULL END
  )
  INTO v_result
  FROM predictions
  WHERE project_id = p_project_id
    AND is_latest = true
    AND horizon_days <= p_horizon;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;
