-- Location node type: physical places (venues, buildings, military bases,
-- stadiums, campuses, offices, properties, addresses). Extraction kept
-- mistyping these as Organizations ("Travis AFB" as an employer). Locations
-- render as attribute-flavored entities in review and are HIDDEN in the
-- graph by default (toggle to show).
--
-- Additive seeding lives in its own function so we don't have to transcribe
-- the whole seed_user_graph body; handle_new_user now calls both, and this
-- migration backfills every existing user.

create or replace function public.seed_location_taxonomy(uid uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  person_id uuid;
  org_id uuid;
  city_id uuid;
  event_id uuid;
  location_id uuid;
begin
  insert into public.node_types (user_id, name, description, icon, color, is_builtin)
  values
    (uid, 'Location', 'A physical place — venue, building, base, stadium, campus, office, property, or address', '📍', '#C6AC8F', true)
  on conflict (user_id, name) do nothing;

  select id into person_id   from public.node_types where user_id = uid and name = 'Person';
  select id into org_id      from public.node_types where user_id = uid and name = 'Organization';
  select id into city_id     from public.node_types where user_id = uid and name = 'City';
  select id into event_id    from public.node_types where user_id = uid and name = 'Event';
  select id into location_id from public.node_types where user_id = uid and name = 'Location';
  if location_id is null then return; end if;

  insert into public.link_types (user_id, name, direction, inverse_name, applies_to_source_type_id, applies_to_target_type_id, is_builtin)
  values
    (uid, 'based_at',    'directed', 'base_of',            person_id,   location_id, true),
    (uid, 'located_at',  'directed', 'location_of',        org_id,      location_id, true),
    (uid, 'held_at',     'directed', 'venue_of',           event_id,    location_id, true),
    (uid, 'in_city',     'directed', 'contains_location',  location_id, city_id,     true),
    (uid, 'operated_by', 'directed', 'operates',           location_id, org_id,      true)
  on conflict (user_id, name) do nothing;

  insert into public.detail_definitions (user_id, name, value_type, value_config, applies_to_node_type_id, is_default, is_builtin, multi_value)
  values
    (uid, 'location_kind', 'enum', '{"options":["venue","office","building","base","campus","stadium","residence","property","landmark","other"]}'::jsonb, location_id, true,  true, false),
    (uid, 'address',       'text', null, location_id, true,  true, false),
    (uid, 'city_name',     'text', null, location_id, false, true, false),
    (uid, 'website',       'url',  null, location_id, false, true, false),
    (uid, 'description',   'text', null, location_id, false, true, false)
  on conflict (user_id, name) do nothing;
end;
$$;

-- New signups get the Location taxonomy too.
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
    -- Bad explicit value — still raise. Defaulting null to 'us' is one
    -- thing; accepting nonsense like 'apac' silently is another.
    raise exception 'profiles.region invalid in user_metadata (got %)', user_region;
  end if;

  insert into public.profiles (user_id, region, country_code)
  values (new.id, user_region, user_country);

  perform public.seed_user_graph(new.id);
  perform public.seed_location_taxonomy(new.id);

  return new;
end;
$$;

-- Backfill every existing user.
do $$
declare u record;
begin
  for u in select distinct user_id from public.node_types loop
    perform public.seed_location_taxonomy(u.user_id);
  end loop;
end;
$$;
