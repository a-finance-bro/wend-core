-- Wend Subsystem #2.1: per-user graph seeding.
--
-- Extends handle_new_user() (defined in migration 001 for Subsystem
-- #1.1) to also seed each user's graph with built-in types, default
-- detail definitions, and the four built-in tags.
--
-- The seed runs inside the same trigger transaction as the profiles
-- INSERT, so a user is never half-set-up.

-- ─────────────────────────────────────────────────────────────────────
-- Per-user seed function. Idempotent — re-running on an already-seeded
-- user is a no-op thanks to the unique-on-(user_id, name) constraints
-- on the schema tables (we use ON CONFLICT DO NOTHING throughout).
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.seed_user_graph(uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Built-in node-type ids — captured during the inserts so we can
  -- reference them when seeding link_types + detail_definitions.
  person_id uuid;
  org_id uuid;
  country_id uuid;
  city_id uuid;
  -- Built-in link-type ids we need ON detail_definitions referencing.
  employee_link_id uuid;
  student_link_id uuid;
begin
  -- ── node_types ──────────────────────────────────────────────────
  insert into public.node_types (user_id, name, description, icon, color, is_builtin)
  values
    (uid, 'Person',       'A real human person',                                '👤', '#5E503F', true),
    (uid, 'Organization', 'A company, school, nonprofit, or other group',        '🏢', '#22333B', true),
    (uid, 'Country',      'A country',                                           '🌍', '#C6AC8F', true),
    (uid, 'City',         'A city, town, or neighborhood',                       '🏙', '#C6AC8F', true)
  on conflict (user_id, name) do nothing;

  select id into person_id  from public.node_types where user_id = uid and name = 'Person';
  select id into org_id     from public.node_types where user_id = uid and name = 'Organization';
  select id into country_id from public.node_types where user_id = uid and name = 'Country';
  select id into city_id    from public.node_types where user_id = uid and name = 'City';

  -- ── link_types ──────────────────────────────────────────────────
  insert into public.link_types (user_id, name, direction, inverse_name, applies_to_source_type_id, applies_to_target_type_id, is_builtin)
  values
    -- Person ↔ Person — undirected
    (uid, 'friend',       'undirected', null,            person_id, person_id, true),
    (uid, 'colleague',    'undirected', null,            person_id, person_id, true),
    (uid, 'classmate',    'undirected', null,            person_id, person_id, true),
    (uid, 'sibling',      'undirected', null,            person_id, person_id, true),
    (uid, 'spouse',       'undirected', null,            person_id, person_id, true),
    (uid, 'co_investor',  'undirected', null,            person_id, person_id, true),
    -- Person → Person — directed
    (uid, 'mentor',       'directed',   'mentee',        person_id, person_id, true),
    (uid, 'parent',       'directed',   'child',         person_id, person_id, true),
    -- Person → Organization — directed
    (uid, 'employee',     'directed',   'employer',      person_id, org_id,    true),
    (uid, 'student',      'directed',   'alumni_school', person_id, org_id,    true),
    (uid, 'advisor',      'directed',   'advisee',       person_id, org_id,    true),
    (uid, 'founder',      'directed',   'founded_by',    person_id, org_id,    true),
    (uid, 'customer',     'directed',   'customer_of',   person_id, org_id,    true),
    (uid, 'vendor',       'directed',   'vendor_of',     person_id, org_id,    true),
    -- Person → City
    (uid, 'lives_in',     'directed',   'resident',      person_id, city_id,   true),
    -- Organization → City
    (uid, 'located_in',   'directed',   'location_of',   org_id,    city_id,   true),
    -- City → Country
    (uid, 'city_in',      'directed',   'contains_city', city_id,   country_id, true)
  on conflict (user_id, name) do nothing;

  select id into employee_link_id from public.link_types where user_id = uid and name = 'employee';
  select id into student_link_id  from public.link_types where user_id = uid and name = 'student';

  -- ── detail_definitions for Person ───────────────────────────────
  -- ★ marked is_default=true → auto-attached as a placeholder when a
  --   new Person node is created.
  insert into public.detail_definitions (user_id, name, value_type, value_config, applies_to_node_type_id, is_default, is_builtin, multi_value)
  values
    (uid, 'email',                'text', null,                                                                                       person_id, true,  true, true),
    (uid, 'phone',                'text', null,                                                                                       person_id, true,  true, true),
    (uid, 'birthday',             'date', null,                                                                                       person_id, true,  true, false),
    (uid, 'location',             'text', null,                                                                                       person_id, true,  true, false),
    (uid, 'linkedin_url',         'url',  null,                                                                                       person_id, true,  true, false),
    (uid, 'photo_url',            'url',  null,                                                                                       person_id, true,  true, false),
    (uid, 'where_we_met',         'text', null,                                                                                       person_id, true,  true, false),
    (uid, 'pronouns',             'text', null,                                                                                       person_id, false, true, false),
    (uid, 'gender',               'text', null,                                                                                       person_id, false, true, false),
    (uid, 'twitter_handle',       'text', null,                                                                                       person_id, false, true, false),
    (uid, 'bio',                  'text', null,                                                                                       person_id, false, true, false),
    (uid, 'interests',            'text', null,                                                                                       person_id, false, true, true),
    (uid, 'current_focus',        'text', null,                                                                                       person_id, false, true, false),
    (uid, 'seeking_to_meet',      'text', null,                                                                                       person_id, false, true, false),
    (uid, 'communication_style',  'enum', '{"options":["formal","casual","witty","technical","warm","other"]}'::jsonb,                person_id, false, true, false),
    (uid, 'assistant_preferences','json', null,                                                                                       person_id, false, true, false);

  -- ── detail_definitions for Organization ─────────────────────────
  insert into public.detail_definitions (user_id, name, value_type, value_config, applies_to_node_type_id, is_default, is_builtin, multi_value)
  values
    (uid, 'kind',          'enum',   '{"options":["company","school","nonprofit","government","investor","accelerator","other"]}'::jsonb, org_id, true,  true, false),
    (uid, 'website',       'url',    null,                                                                                                org_id, true,  true, false),
    (uid, 'industry',      'text',   null,                                                                                                org_id, false, true, false),
    (uid, 'founded_year',  'number', null,                                                                                                org_id, false, true, false),
    (uid, 'headquarters',  'text',   null,                                                                                                org_id, false, true, false),
    (uid, 'size',          'enum',   '{"options":["1-10","11-50","51-200","201-1000","1001-5000","5000+"]}'::jsonb,                       org_id, false, true, false);

  -- ── detail_definitions for the employee + student link types ────
  insert into public.detail_definitions (user_id, name, value_type, value_config, applies_to_link_type_id, is_default, is_builtin, multi_value)
  values
    (uid, 'title',           'text',       null, employee_link_id, true,  true, false),
    (uid, 'employee_start',  'month_year', null, employee_link_id, true,  true, false),
    (uid, 'employee_end',    'month_year', null, employee_link_id, true,  true, false),
    (uid, 'department',      'text',       null, employee_link_id, false, true, false),
    (uid, 'claimed_salary',  'currency',   '{"currency":"USD"}'::jsonb, employee_link_id, false, true, false),
    (uid, 'student_start',   'month_year', null, student_link_id,  true,  true, false),
    (uid, 'student_end',     'month_year', null, student_link_id,  true,  true, false),
    (uid, 'degree',          'text',       null, student_link_id,  false, true, false),
    (uid, 'field_of_study',  'text',       null, student_link_id,  false, true, false);

  -- ── tags ────────────────────────────────────────────────────────
  insert into public.tags (user_id, name, color, is_builtin)
  values
    (uid, 'Personal',  '#5E503F', true),
    (uid, 'Work',      '#22333B', true),
    (uid, 'Family',    '#a84432', true),
    (uid, 'Investors', '#3a7a45', true)
  on conflict (user_id, name) do nothing;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- Replace handle_new_user() (originally from migration 001) so it ALSO
-- seeds the per-user graph after creating the profiles row.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_region text;
  user_country text;
begin
  user_region := new.raw_user_meta_data->>'region';
  user_country := new.raw_user_meta_data->>'country_code';

  if user_region is null or user_region not in ('us', 'eu') then
    raise exception 'profiles.region missing or invalid in user_metadata (got %)', user_region;
  end if;

  insert into public.profiles (user_id, region, country_code)
  values (new.id, user_region, user_country);

  perform public.seed_user_graph(new.id);

  return new;
end;
$$;
