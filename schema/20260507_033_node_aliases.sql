-- Aliases for nodes. The graph treats display_name as canonical, but
-- a person can have a nickname, a maiden name, a Slack handle, an
-- email handle, or a "the chess guy" colloquial reference. The
-- chat agent + recall queries match against these as well as
-- display_name so the user never has to remember which token they
-- used last time.
--
-- Aliases are user-scoped (this is a private graph). Source can be
-- 'user' (typed in directly), 'agent' (the chat agent extracted it
-- and the user confirmed), or 'extension' (browser-extension capture).
-- Multiple aliases per node are fine; a uniqueness constraint on
-- (user_id, node_id, lower(alias_text)) prevents exact duplicates.

create table public.node_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid not null references public.nodes (id) on delete cascade,
  alias_text text not null,
  source text not null default 'user'
    check (source in ('user', 'agent', 'extension', 'enrichment')),
  created_at timestamptz not null default now(),
  -- Soft-delete so an undo is possible.
  deleted_at timestamptz
);

create unique index node_aliases_user_node_alias_idx
  on public.node_aliases (user_id, node_id, lower(alias_text))
  where deleted_at is null;

create index node_aliases_user_idx
  on public.node_aliases (user_id)
  where deleted_at is null;

-- Trigram index so ilike searches across the alias_text are fast.
create index node_aliases_alias_trgm_idx
  on public.node_aliases using gin (alias_text gin_trgm_ops);

alter table public.node_aliases enable row level security;

create policy "node_aliases self-select"
  on public.node_aliases for select
  using (auth.uid() = user_id);

create policy "node_aliases self-insert"
  on public.node_aliases for insert
  with check (auth.uid() = user_id);

create policy "node_aliases self-update"
  on public.node_aliases for update
  using (auth.uid() = user_id);

create policy "node_aliases self-delete"
  on public.node_aliases for delete
  using (auth.uid() = user_id);

comment on table public.node_aliases is
  'Alternative names + handles for a node. Recall + chat agent match '
  'against these in addition to nodes.display_name.';
