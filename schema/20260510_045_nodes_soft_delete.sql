-- 045: soft-delete on nodes.
--
-- The original `nodes` table (004) was hard-delete only. Merging two people and
-- the dedup pass both need a tombstone instead: a hard delete takes the audit
-- trail and the provenance records with it, and leaves no way to undo. Live
-- nodes are `deleted_at is null`, and the engine filters on that everywhere,
-- so this file has to be applied before the functions that select it.

alter table public.nodes
  add column if not exists deleted_at timestamptz;

comment on column public.nodes.deleted_at is
  'Soft-delete marker. Set when a node is merged into another or cleaned up. '
  'Live nodes are deleted_at IS NULL.';

-- Partial index covering the common "show live nodes" filter shape.
create index if not exists nodes_user_live_idx
  on public.nodes (user_id, node_type_id)
  where deleted_at is null;
