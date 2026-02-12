-- Atomic + idempotent model selection upsert (prevents infinite OUTDATED loop)
-- Creates RPC: public.rpc_upsert_model_selection

create or replace function public.rpc_upsert_model_selection(
  p_project_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_target_column text,
  p_problem_type text,
  p_selected_features text[],
  p_excluded_features text[]
)
returns table (
  success boolean,
  selection_version integer,
  target_hash text,
  did_change boolean
)
language plpgsql
security definer
as $$
declare
  v_existing record;
  v_new_version integer;
  v_hash_input text;
  v_hash int := 0;
  v_target_hash text;
  v_did_change boolean := true;
begin
  -- Lock row for this project to make version bump atomic
  select
    project_id,
    selection_version,
    target_column,
    coalesce(problem_type, '') as problem_type,
    coalesce(selected_features, array[]::text[]) as selected_features,
    coalesce(excluded_features, array[]::text[]) as excluded_features
  into v_existing
  from public.project_model_selection
  where project_id = p_project_id
  for update;

  if not found then
    v_new_version := 1;
    v_did_change := true;
  else
    -- Detect no-op (no real change) => DO NOT bump version
    v_did_change :=
      (coalesce(v_existing.target_column,'') <> coalesce(p_target_column,'')) or
      (coalesce(v_existing.problem_type,'') <> coalesce(p_problem_type,'')) or
      (coalesce(v_existing.selected_features, array[]::text[]) <> coalesce(p_selected_features, array[]::text[])) or
      (coalesce(v_existing.excluded_features, array[]::text[]) <> coalesce(p_excluded_features, array[]::text[]));

    if v_did_change then
      v_new_version := coalesce(v_existing.selection_version, 0) + 1;
    else
      v_new_version := coalesce(v_existing.selection_version, 0);
    end if;
  end if;

  -- Create a deterministic hash tied to the version
  v_hash_input := p_project_id::text || '|' || coalesce(p_target_column,'') || '|' || v_new_version::text;
  for i in 1..length(v_hash_input) loop
    v_hash := ((v_hash << 5) - v_hash) + ascii(substr(v_hash_input, i, 1));
  end loop;
  v_target_hash := 'th_' || to_char(abs(v_hash), 'FM999999999999999999');

  -- Upsert selection (version bumped only if did_change)
  insert into public.project_model_selection (
    project_id,
    organization_id,
    target_column,
    problem_type,
    selected_features,
    excluded_features,
    selection_version,
    target_hash,
    updated_at,
    updated_by
  )
  values (
    p_project_id,
    p_organization_id,
    p_target_column,
    nullif(p_problem_type,''),
    coalesce(p_selected_features, array[]::text[]),
    coalesce(p_excluded_features, array[]::text[]),
    v_new_version,
    v_target_hash,
    now(),
    p_user_id
  )
  on conflict (project_id)
  do update set
    organization_id   = excluded.organization_id,
    target_column     = excluded.target_column,
    problem_type      = excluded.problem_type,
    selected_features = excluded.selected_features,
    excluded_features = excluded.excluded_features,
    selection_version = case when v_did_change then excluded.selection_version else public.project_model_selection.selection_version end,
    target_hash       = case when v_did_change then excluded.target_hash else public.project_model_selection.target_hash end,
    updated_at        = now(),
    updated_by        = p_user_id;

  return query
  select true, v_new_version, (select target_hash from public.project_model_selection where project_id = p_project_id), v_did_change;
end;
$$;

revoke all on function public.rpc_upsert_model_selection(uuid,uuid,uuid,text,text,text[],text[]) from public;