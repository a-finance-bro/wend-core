-- Subsystem #5 (chat agent output / retrieval).
--
-- Vector-similarity search over the user's nodes. Supabase-js doesn't
-- expose raw SQL for vector ops, so we wrap the cosine-distance query
-- as an RPC. RLS-style scoping happens via auth.uid() inside the
-- function body — same security guarantee as the table policies.
--
-- The function self-excludes nodes without embeddings (NULL embedding
-- column means "not yet embedded by Subsystem #2.2", so they can't
-- contribute to retrieval anyway). Excluding the Self Node from
-- `who-do-I-know`-shaped queries is left to the caller (the agent's
-- system prompt instructs it to filter); enforcing here would block
-- legitimate "tell me about myself" queries.

create or replace function public.recall_nodes(
  query_embedding vector(1024),
  match_count int default 8
)
returns table (
  id uuid,
  display_name text,
  node_type_name text,
  similarity float
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
  where n.user_id = (select auth.uid())
    and n.embedding is not null
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

comment on function public.recall_nodes is
  'Top-N user nodes by cosine similarity to query_embedding. RLS-equivalent via auth.uid() inside the function body.';

-- Restrict execute to authenticated role only.
revoke all on function public.recall_nodes(vector, int) from public;
grant execute on function public.recall_nodes(vector, int) to authenticated;
