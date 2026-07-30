-- 127: exact attribute lookup over people, for structure-first recall.
--
-- WHY: an evaluation on a real real graph showed "people who work at
-- Acme" returning the Acme ORG node and no people, while Priya Raman sat there
-- with company="Acme". She has no `employee` edge to a Acme node (the
-- org-linking worker never reached her), so graph traversal cannot find her
-- either. The fact is perfectly structured, it is simply a typed detail rather
-- than an edge, and a relationship product should be able to answer "who works
-- at X" from it.
--
-- This cannot be expressed through PostgREST: `node_details.value` is jsonb and
-- Postgres has no `jsonb ILIKE text` operator, so the filter errored and the
-- caller silently saw zero rows. Doing it in SQL with an explicit `#>>` also
-- lets the match be indexed rather than a scan.
--
-- Scope follows the same rule as recall_nodes: auth.uid() when present, else
-- p_user_id, so an authenticated caller can never widen its own scope and a
-- service-role caller (the MCP route) can scope explicitly.

create or replace function public.search_person_attributes(
  p_keys text[],
  p_value text,
  p_user_id uuid default null,
  p_limit integer default 10
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
    -- #>> '{}' unwraps a scalar jsonb to text without the surrounding quotes,
    -- so "Acme" matches Acme rather than needing the caller to guess at quoting.
    and (d.value #>> '{}') ilike '%' || p_value || '%'
  order by n.id, dd.name
  limit p_limit;
$$;

comment on function public.search_person_attributes(text[], text, uuid, integer) is
  'Find people by a typed detail value (company, school, location...). Powers structure-first recall for questions like "who works at Acme", where the fact lives in a detail rather than an edge. jsonb is unwrapped with #>> so callers match plain text.';

create extension if not exists pg_trgm;

create index if not exists node_details_value_trgm_idx
  on public.node_details using gin ((value #>> '{}') gin_trgm_ops);

comment on index public.node_details_value_trgm_idx is
  'Trigram index on the unwrapped detail value, so "who works at X" style attribute lookups stay fast as graphs grow past a few thousand details.';
