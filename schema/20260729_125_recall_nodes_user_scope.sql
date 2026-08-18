-- 125: scope recall_nodes explicitly, so a service-role caller is safe.
--
-- THE RULE THIS ENCODES. A SECURITY DEFINER function bypasses row-level
-- security, so it must resolve its own tenant and must never be reachable by a
-- caller who has not proved one. Two things follow, and both are required:
--
-- 1. SCOPE. `auth.uid()` is the tenant when a request carries a user session.
--    A server-side caller using the service key has no session, so the function
--    also accepts an explicit `p_user_id` and the caller is responsible for
--    having authenticated that user itself.
--
-- 2. GRANTS. EXECUTE is revoked from `public` and `anon` and granted to
--    `authenticated` and `service_role`. This is per SIGNATURE, not per name:
--    a new overload does not inherit an earlier one's grants, so every added
--    signature repeats both statements in the migration that creates it.
--
-- `p_user_id` is consulted ONLY when there is no authenticated user, so an
-- authenticated caller can never pass someone else's id and read their graph:
-- auth.uid() always wins when present. Callers holding the service key could
-- already read anything, so accepting the id from them grants nothing new.
--
-- The application half ships alongside: recallNodes now takes userId as a
-- REQUIRED second positional and filters every query on it, so omitting the
-- scope is a compile error rather than a query that runs without a tenant.

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
