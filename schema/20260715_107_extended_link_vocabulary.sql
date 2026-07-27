-- Extended link vocabulary: the specific relationship types extraction kept
-- cramming into `employee` (a Forbes CONTRIBUTOR, an HONORARY Commander,
-- military service, a co-authored white paper, a podcast appearance, a
-- conference panel). Seeded per user like the rest of the taxonomy; new
-- signups get them via handle_new_user.
--
-- Companion code change: applyCreateLink now AUTO-CREATES unknown link
-- types (created_by_ai=true) instead of silently failing, so the agent can
-- mint precise vocabulary as it goes (evolving schema, per vision).

create or replace function public.seed_extended_link_types(uid uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  person_id uuid;
  org_id uuid;
  event_id uuid;
begin
  select id into person_id from public.node_types where user_id = uid and name = 'Person';
  select id into org_id    from public.node_types where user_id = uid and name = 'Organization';
  select id into event_id  from public.node_types where user_id = uid and name = 'Event';

  insert into public.link_types (user_id, name, direction, inverse_name, applies_to_source_type_id, applies_to_target_type_id, is_builtin)
  values
    (uid, 'contributor',       'directed', 'has_contributor', person_id, org_id,   true),
    (uid, 'honorary_role',     'directed', 'has_honorary',    person_id, org_id,   true),
    (uid, 'served_in',         'directed', 'has_veteran',     person_id, org_id,   true),
    (uid, 'collaborated_with', 'directed', 'collaborator',    person_id, org_id,   true),
    (uid, 'guest_on',          'directed', 'has_guest',       person_id, org_id,   true),
    (uid, 'spoke_at',          'directed', 'speaker',         person_id, event_id, true)
  on conflict (user_id, name) do nothing;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  user_region text;
  user_country text;
begin
  user_region := coalesce(new.raw_user_meta_data->>'region', 'us');
  user_country := new.raw_user_meta_data->>'country_code';

  if user_region not in ('us', 'eu') then
    raise exception 'profiles.region invalid in user_metadata (got %)', user_region;
  end if;

  insert into public.profiles (user_id, region, country_code)
  values (new.id, user_region, user_country);

  perform public.seed_user_graph(new.id);
  perform public.seed_location_taxonomy(new.id);
  perform public.seed_extended_link_types(new.id);

  return new;
end;
$$;

do $$
declare u record;
begin
  for u in select distinct user_id from public.node_types loop
    perform public.seed_extended_link_types(u.user_id);
  end loop;
end;
$$;
