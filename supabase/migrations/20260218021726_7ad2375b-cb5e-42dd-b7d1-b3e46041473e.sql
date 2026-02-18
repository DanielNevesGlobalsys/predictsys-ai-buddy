-- Drop the OLD overload that has p_job_id as TEXT (the one created in the earlier O(1) migration)
DROP FUNCTION IF EXISTS public.rpc_promote_prediction_batch(uuid, text, uuid, integer, text, integer, numeric, boolean);
