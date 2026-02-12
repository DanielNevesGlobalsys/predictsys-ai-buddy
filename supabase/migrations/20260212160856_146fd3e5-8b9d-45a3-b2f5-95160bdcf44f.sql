-- Fix ambiguous column reference in rpc_upsert_model_selection
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
set search_path = public
as $$
declare
  v_existing record;
  v_new_version integer;
  v_hash_input text;
  v_hash int := 0;
  v_target_hash text;
  v_did_change boolean := true;
begin
  select
    pms.project_id,
    pms.selection_version,
    pms.target_column,
    coalesce(pms.problem_type, '') as problem_type,
    coalesce(pms.selected_features, '[]'::jsonb) as selected_features,
    coalesce(pms.excluded_features, '[]'::jsonb) as excluded_features
  into v_existing
  from public.project_model_selection pms
  where pms.project_id = p_project_id
  for update;

  if not found then
    v_new_version := 1;
    v_did_change := true;
  else
    v_did_change :=
      (coalesce(v_existing.target_column,'') <> coalesce(p_target_column,'')) or
      (coalesce(v_existing.problem_type,'') <> coalesce(p_problem_type,'')) or
      (v_existing.selected_features::text <> to_jsonb(coalesce(p_selected_features, array[]::text[]))::text) or
      (v_existing.excluded_features::text <> to_jsonb(coalesce(p_excluded_features, array[]::text[]))::text);

    if v_did_change then
      v_new_version := coalesce(v_existing.selection_version, 0) + 1;
    else
      v_new_version := coalesce(v_existing.selection_version, 0);
    end if;
  end if;

  v_hash_input := p_project_id::text || '|' || coalesce(p_target_column,'') || '|' || v_new_version::text;
  for i in 1..length(v_hash_input) loop
    v_hash := ((v_hash << 5) - v_hash) + ascii(substr(v_hash_input, i, 1));
  end loop;
  v_target_hash := 'th_' || to_char(abs(v_hash), 'FM999999999999999999');

  insert into public.project_model_selection as pms (
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
    to_jsonb(coalesce(p_selected_features, array[]::text[])),
    to_jsonb(coalesce(p_excluded_features, array[]::text[])),
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
    selection_version = case when v_did_change then excluded.selection_version else pms.selection_version end,
    target_hash       = case when v_did_change then excluded.target_hash else pms.target_hash end,
    updated_at        = now(),
    updated_by        = p_user_id;

  return query
  select true, v_new_version, (select pms2.target_hash from public.project_model_selection pms2 where pms2.project_id = p_project_id), v_did_change;
end;
$$;