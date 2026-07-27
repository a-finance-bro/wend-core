-- Wend Subsystem #2.1: Graph instance layer + supporting tables.
--
-- The actual nodes (people, orgs, places…), relationships between
-- them, the per-instance fact values, plus everything needed for
-- provenance, tagging, AI schema-proposal queue, and conflict
-- resolution.
--
-- See docs/specs/02-knowledge-graph-engine.md §4 for the full data model.

-- ─────────────────────────────────────────────────────────────────────
-- sources — where a fact came from. Every node_detail / link_detail
-- references one. Required for the spec's provenance-first design.
-- ─────────────────────────────────────────────────────────────────────
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_type text not null check (source_type in (
    'chat_message_text',
    'chat_message_voice',
    'screenshot',
    'image_upload',
    'audio_upload',
    'video_upload',
    'email_thread',
    'gmail_message',
    'web_search',
    'web_enrichment',
    'calendar_event',
    'user_typed',
    'mobile_share_sheet'
  )),
  display_label text not null,
  storage_path text,
  original_filename text,
  mime_type text,
  size_bytes bigint,
  external_url text,
  metadata jsonb,
  context_text text,
  created_at timestamptz not null default now()
);

comment on table public.sources is 'Provenance — every fact in the graph traces back to one of these.';

create index sources_user_created_idx on public.sources (user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────
-- tags — user-extensible bucket labels for nodes + links.
-- ─────────────────────────────────────────────────────────────────────
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  color text,
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create index tags_user_idx on public.tags (user_id);

-- ─────────────────────────────────────────────────────────────────────
-- nodes — instances. People, orgs, places, etc.
-- ─────────────────────────────────────────────────────────────────────
create table public.nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  node_type_id uuid not null references public.node_types (id) on delete restrict,
  display_name text not null,
  -- 1024-dim vector matches Voyage AI voyage-3 (the configured embedder).
  embedding vector(1024),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.nodes is 'Concrete entities. Embedding column populated by the ingest pipeline (Subsystem #2.2 / #4).';

create index nodes_user_type_idx on public.nodes (user_id, node_type_id);
create index nodes_user_display_name_idx on public.nodes (user_id, display_name);
-- Trigram index for "fuzzy match" lookups (e.g. "sarah c" → "Sarah Chen").
create index nodes_user_display_name_trgm_idx on public.nodes using gin (display_name gin_trgm_ops);
-- Vector similarity index. ivfflat is the right default for write-heavy
-- per-user data; we'll tune lists once we have real volumes.
create index nodes_embedding_idx on public.nodes using ivfflat (embedding vector_cosine_ops) with (lists = 50);

-- updated_at maintenance.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger nodes_touch_updated_at
  before update on public.nodes
  for each row
  execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- links — directed or undirected edges between nodes.
-- ─────────────────────────────────────────────────────────────────────
create table public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  link_type_id uuid not null references public.link_types (id) on delete restrict,
  source_node_id uuid not null references public.nodes (id) on delete cascade,
  target_node_id uuid not null references public.nodes (id) on delete cascade,
  notes text,
  created_at timestamptz not null default now(),
  -- Self-loops are rare but legal (e.g. mentor-of-self thought experiment).
  -- We don't enforce non-self-loop here; UI can warn.
  check (source_node_id <> target_node_id or link_type_id is not null)
);

create index links_user_source_idx on public.links (user_id, source_node_id);
create index links_user_target_idx on public.links (user_id, target_node_id);
create index links_user_type_idx on public.links (user_id, link_type_id);

-- ─────────────────────────────────────────────────────────────────────
-- node_details + link_details — instance-level fact values, each
-- carrying provenance + a confidence score.
-- ─────────────────────────────────────────────────────────────────────
create table public.node_details (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid not null references public.nodes (id) on delete cascade,
  detail_definition_id uuid not null references public.detail_definitions (id) on delete restrict,
  value jsonb not null,
  valid_from timestamptz,
  valid_until timestamptz,
  confidence numeric(3, 2) not null default 1.0 check (confidence >= 0 and confidence <= 1),
  source_id uuid not null references public.sources (id) on delete restrict,
  user_confirmed boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.node_details is 'Per-node fact values. user_confirmed=true overrides future auto-extraction. soft-deleted via deleted_at.';

create index node_details_user_node_idx on public.node_details (user_id, node_id) where deleted_at is null;
create index node_details_user_def_idx on public.node_details (user_id, detail_definition_id) where deleted_at is null;
create index node_details_source_idx on public.node_details (source_id);

create trigger node_details_touch_updated_at
  before update on public.node_details
  for each row
  execute function public.touch_updated_at();

create table public.link_details (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  link_id uuid not null references public.links (id) on delete cascade,
  detail_definition_id uuid not null references public.detail_definitions (id) on delete restrict,
  value jsonb not null,
  valid_from timestamptz,
  valid_until timestamptz,
  confidence numeric(3, 2) not null default 1.0 check (confidence >= 0 and confidence <= 1),
  source_id uuid not null references public.sources (id) on delete restrict,
  user_confirmed boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index link_details_user_link_idx on public.link_details (user_id, link_id) where deleted_at is null;
create index link_details_user_def_idx on public.link_details (user_id, detail_definition_id) where deleted_at is null;
create index link_details_source_idx on public.link_details (source_id);

create trigger link_details_touch_updated_at
  before update on public.link_details
  for each row
  execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- node_tags + link_tags — many-to-many tag assignments.
-- ─────────────────────────────────────────────────────────────────────
create table public.node_tags (
  user_id uuid not null references auth.users (id) on delete cascade,
  node_id uuid not null references public.nodes (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, node_id, tag_id)
);

create index node_tags_user_tag_idx on public.node_tags (user_id, tag_id);

create table public.link_tags (
  user_id uuid not null references auth.users (id) on delete cascade,
  link_id uuid not null references public.links (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, link_id, tag_id)
);

create index link_tags_user_tag_idx on public.link_tags (user_id, tag_id);

-- ─────────────────────────────────────────────────────────────────────
-- schema_proposals — AI-driven additions to the per-user schema. The UI
-- flow that surfaces / approves these lives in Subsystem #2.3.
-- ─────────────────────────────────────────────────────────────────────
create table public.schema_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  proposal_type text not null check (proposal_type in (
    'node_type', 'link_type', 'detail_definition', 'subjective_scale', 'tag'
  )),
  proposed_payload jsonb not null,
  reasoning text not null,
  triggering_source_ids uuid[],
  status text not null default 'pending' check (status in (
    'pending', 'approved', 'rejected', 'superseded'
  )),
  decision_notes text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index schema_proposals_user_status_idx on public.schema_proposals (user_id, status, created_at desc);

-- ─────────────────────────────────────────────────────────────────────
-- conflicts — detail-value disagreements awaiting user resolution. Flow
-- lives in Subsystem #2.4.
-- ─────────────────────────────────────────────────────────────────────
create table public.conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  target_kind text not null check (target_kind in ('node_detail', 'link_detail')),
  target_id uuid not null,
  existing_value jsonb not null,
  existing_source_id uuid not null references public.sources (id) on delete cascade,
  incoming_value jsonb not null,
  incoming_source_id uuid not null references public.sources (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'ignored')),
  resolution text check (resolution in (
    'kept_existing', 'replaced_with_incoming', 'merged', 'both_valid_temporal'
  )),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index conflicts_user_status_idx on public.conflicts (user_id, status, created_at desc);
