-- Wend Subsystem #2.1: RLS policies for the graph layer.
--
-- Every graph table is locked: a user can only see / mutate rows where
-- user_id = auth.uid(). Service role bypasses RLS for jobs (RTBF
-- purges, cross-region admin).
--
-- The pattern here is intentionally uniform — same four policies on
-- every table. Less surface area = fewer ways to get this wrong.

-- Helper: a function that returns the current user_id, used in `using`
-- clauses. Subselect via `(select auth.uid())` is faster than calling
-- auth.uid() directly in a policy because Postgres caches it per-query.
-- We just inline `(select auth.uid())` for clarity.

-- ─────────────────────────────────────────────────────────────────────
-- Schema layer
-- ─────────────────────────────────────────────────────────────────────
alter table public.node_types enable row level security;
create policy "node_types_self_select" on public.node_types
  for select to authenticated using (user_id = (select auth.uid()));
create policy "node_types_self_insert" on public.node_types
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "node_types_self_update" on public.node_types
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "node_types_self_delete" on public.node_types
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.link_types enable row level security;
create policy "link_types_self_select" on public.link_types
  for select to authenticated using (user_id = (select auth.uid()));
create policy "link_types_self_insert" on public.link_types
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "link_types_self_update" on public.link_types
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "link_types_self_delete" on public.link_types
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.detail_definitions enable row level security;
create policy "detail_definitions_self_select" on public.detail_definitions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "detail_definitions_self_insert" on public.detail_definitions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "detail_definitions_self_update" on public.detail_definitions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "detail_definitions_self_delete" on public.detail_definitions
  for delete to authenticated using (user_id = (select auth.uid()));

-- ─────────────────────────────────────────────────────────────────────
-- Instance layer
-- ─────────────────────────────────────────────────────────────────────
alter table public.nodes enable row level security;
create policy "nodes_self_select" on public.nodes
  for select to authenticated using (user_id = (select auth.uid()));
create policy "nodes_self_insert" on public.nodes
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "nodes_self_update" on public.nodes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "nodes_self_delete" on public.nodes
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.links enable row level security;
create policy "links_self_select" on public.links
  for select to authenticated using (user_id = (select auth.uid()));
create policy "links_self_insert" on public.links
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "links_self_update" on public.links
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "links_self_delete" on public.links
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.node_details enable row level security;
create policy "node_details_self_select" on public.node_details
  for select to authenticated using (user_id = (select auth.uid()));
create policy "node_details_self_insert" on public.node_details
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "node_details_self_update" on public.node_details
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "node_details_self_delete" on public.node_details
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.link_details enable row level security;
create policy "link_details_self_select" on public.link_details
  for select to authenticated using (user_id = (select auth.uid()));
create policy "link_details_self_insert" on public.link_details
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "link_details_self_update" on public.link_details
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "link_details_self_delete" on public.link_details
  for delete to authenticated using (user_id = (select auth.uid()));

-- ─────────────────────────────────────────────────────────────────────
-- Sources + tags + tag joins
-- ─────────────────────────────────────────────────────────────────────
alter table public.sources enable row level security;
create policy "sources_self_select" on public.sources
  for select to authenticated using (user_id = (select auth.uid()));
create policy "sources_self_insert" on public.sources
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "sources_self_update" on public.sources
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "sources_self_delete" on public.sources
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.tags enable row level security;
create policy "tags_self_select" on public.tags
  for select to authenticated using (user_id = (select auth.uid()));
create policy "tags_self_insert" on public.tags
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "tags_self_update" on public.tags
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "tags_self_delete" on public.tags
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.node_tags enable row level security;
create policy "node_tags_self_select" on public.node_tags
  for select to authenticated using (user_id = (select auth.uid()));
create policy "node_tags_self_insert" on public.node_tags
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "node_tags_self_delete" on public.node_tags
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.link_tags enable row level security;
create policy "link_tags_self_select" on public.link_tags
  for select to authenticated using (user_id = (select auth.uid()));
create policy "link_tags_self_insert" on public.link_tags
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "link_tags_self_delete" on public.link_tags
  for delete to authenticated using (user_id = (select auth.uid()));

-- ─────────────────────────────────────────────────────────────────────
-- Schema proposals + conflicts
-- ─────────────────────────────────────────────────────────────────────
alter table public.schema_proposals enable row level security;
create policy "schema_proposals_self_select" on public.schema_proposals
  for select to authenticated using (user_id = (select auth.uid()));
create policy "schema_proposals_self_insert" on public.schema_proposals
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "schema_proposals_self_update" on public.schema_proposals
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- No DELETE policy — proposals are kept for audit even after rejection.

alter table public.conflicts enable row level security;
create policy "conflicts_self_select" on public.conflicts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "conflicts_self_insert" on public.conflicts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "conflicts_self_update" on public.conflicts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- No DELETE policy — resolved/ignored conflicts are kept for audit.
