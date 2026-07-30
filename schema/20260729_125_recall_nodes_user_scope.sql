-- 125: make recall_nodes usable, and safe, from a service-role caller.
--
-- Found by pointing claude.ai at the live MCP server and asking a real question.
-- Two faults, both invisible from the web app:
--
-- 1. This function is SECURITY DEFINER and scoped by `auth.uid()`. The MCP route
--    authenticates the user itself and then queries with the SERVICE-ROLE client,
--    where `auth.uid()` is NULL. So `n.user_id = null` matched nothing and
--    semantic recall silently returned ZERO rows for every MCP request, always.
--    It looked like the Voyage rate limit. It was not.
--
-- 2. Because the semantic pass came back empty, the caller fell through to its
--    text fallback, which had no user filter of its own and relied on RLS. RLS
--    does not apply to the service-role client, so that fallback returned nodes
--    outside the intended scope. A recall on the founder's account returned a node
--    id owned by a test account. getNodeDetails refused to expand it (it filters
--    user_id explicitly), which is the only reason this surfaced as a 404 rather
--    than as one user reading another's graph.
--
-- `p_user_id` is consulted ONLY when there is no authenticated user, so an
-- authenticated caller can never pass someone else's id and read their graph:
-- auth.uid() always wins when present. Callers holding the service key could
-- already read anything, so accepting the id from them grants nothing new.
--
-- The application half ships alongside: recallNodes now takes userId as a
-- REQUIRED second positional and filters every query on it, so omitting the
-- scope is a compile error instead of a a query that runs without a tenant.

create or replace function public.recall_nodes(
  query_embedding vector,
  match_count integer default 8,
  p_user_id uuid default null
)
returns table (
  id uuid,
  display_name text,
  node_type_name text,
  similarity double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select
    n.id,
    n.display_name,
    nt.name as node_type_name,
    1 - (n.embedding <=> query_embedding) as similarity
  from public.nodes n
  join public.node_types nt on nt.id = n.node_type_id
  -- auth.uid() first, deliberately: an authenticated caller cannot widen its
  -- own scope by passing p_user_id. The parameter only takes effect for a
  -- service-role caller, where auth.uid() is null.
  where n.user_id = coalesce((select auth.uid()), p_user_id)
    and n.deleted_at is null
    and n.embedding is not null
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

comment on function public.recall_nodes(vector, integer, uuid) is
  'Semantic recall over a single user''s nodes. Scope is auth.uid() when present, else p_user_id, so an authenticated caller can never read another user''s graph while a service-role caller (the MCP route) can scope explicitly. Also excludes soft-deleted nodes, which the previous version returned.';
