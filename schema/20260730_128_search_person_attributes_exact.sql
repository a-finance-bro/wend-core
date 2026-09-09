-- 128: exact-match mode for attribute lookup.
--
-- `company ILIKE '%Meta%'` also matches Metabase and Metagenomi. On prod those
-- outranked the person who actually works at Meta, because a structural hit
-- carries similarity 1 regardless of how loose the match was. The caller now
-- tries exact first and only widens to substring when exact finds nothing.

drop function if exists public.search_person_attributes(text[], text, uuid, integer);

create or replace function public.search_person_attributes(
  p_keys text[],
  p_value text,
  p_user_id uuid default null,
  p_limit integer default 10,
  p_exact boolean default false
)
returns table (
  id uuid,
  display_name text,
  node_type_name text,
  attribute text,
  attribute_value text
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (n.id)
    n.id,
    n.display_name,
    nt.name as node_type_name,
    dd.name as attribute,
    (d.value #>> '{}') as attribute_value
  from public.node_details d
  join public.detail_definitions dd on dd.id = d.detail_definition_id
  join public.nodes n on n.id = d.node_id
  join public.node_types nt on nt.id = n.node_type_id
  where n.user_id = coalesce((select auth.uid()), p_user_id)
    and d.deleted_at is null
    and n.deleted_at is null
    and nt.name = 'Person'
    and dd.name = any(p_keys)
    and case
      -- Exact is case-insensitive equality, not identity: users type "meta".
      when p_exact then lower(d.value #>> '{}') = lower(p_value)
      else (d.value #>> '{}') ilike '%' || p_value || '%'
    end
  order by n.id, dd.name
  limit p_limit;
$$;

comment on function public.search_person_attributes(text[], text, uuid, integer, boolean) is
  'Find people by a typed detail value (company, school, location...). Powers structure-first recall for questions like "who works at Meta", where the fact lives in a detail rather than an edge. p_exact does case-insensitive equality; callers should try it first, since a substring match on "Meta" also hits Metabase. jsonb is unwrapped with #>> so callers match plain text.';
