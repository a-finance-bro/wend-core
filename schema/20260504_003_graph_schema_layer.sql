-- Wend Subsystem #2.1: Graph schema layer.
--
-- The "schema-as-data" half of the graph: per-user types of nodes,
-- types of relationships between nodes, and types of detail-fields
-- attached to either. Built-in types are seeded on signup; the AI may
-- later propose new types via schema_proposals (#2 spec §6).
--
-- Applied identically to BOTH region projects (wend-us + wend-eu).
-- See docs/specs/02-knowledge-graph-engine.md §4 for the full data model.

-- ─────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────
-- pgvector for RAG embeddings on every node.
create extension if not exists vector;
-- Trigram for fuzzy display_name search.
create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────────────
-- node_types — per-user kinds of things in the graph.
-- ─────────────────────────────────────────────────────────────────────
create table public.node_types (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  icon text,
  color text,
  is_builtin boolean not null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

comment on table public.node_types is 'Per-user node-type schema. Built-in types seeded at signup; AI proposals add more later.';

create index node_types_user_idx on public.node_types (user_id);

-- ─────────────────────────────────────────────────────────────────────
-- link_types — kinds of relationships between nodes.
-- ─────────────────────────────────────────────────────────────────────
create table public.link_types (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  direction text not null check (direction in ('directed', 'undirected')),
  inverse_name text,
  applies_to_source_type_id uuid references public.node_types (id) on delete set null,
  applies_to_target_type_id uuid references public.node_types (id) on delete set null,
  is_builtin boolean not null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

comment on table public.link_types is 'Per-user relationship-type schema. Directed types use inverse_name to display the reverse relation.';

create index link_types_user_idx on public.link_types (user_id);

-- ─────────────────────────────────────────────────────────────────────
-- detail_definitions — per-user kinds of facts attached to nodes / links.
-- ─────────────────────────────────────────────────────────────────────
create table public.detail_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  value_type text not null check (
    value_type in ('text', 'date', 'month_year', 'number', 'currency', 'url', 'enum', 'json')
  ),
  value_config jsonb,
  applies_to_node_type_id uuid references public.node_types (id) on delete cascade,
  applies_to_link_type_id uuid references public.link_types (id) on delete cascade,
  is_default boolean not null default false,
  is_builtin boolean not null,
  created_by_ai boolean not null default false,
  multi_value boolean not null default false,
  created_at timestamptz not null default now(),
  -- A detail definition must apply to either a node type or a link type, not both.
  check (
    (applies_to_node_type_id is not null) <> (applies_to_link_type_id is not null)
  )
);

comment on table public.detail_definitions is 'Schema for the fact-fields attached to node/link instances. is_default=true → auto-attached as a placeholder when a new instance is created.';

create index detail_definitions_user_idx on public.detail_definitions (user_id);
create index detail_definitions_node_type_idx on public.detail_definitions (applies_to_node_type_id) where applies_to_node_type_id is not null;
create index detail_definitions_link_type_idx on public.detail_definitions (applies_to_link_type_id) where applies_to_link_type_id is not null;
