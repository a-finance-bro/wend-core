-- Allow the edit_node proposal kind (agent-proposed edits to existing nodes:
-- rename, new job/location, typo fixes — reviewed with before/after preview).
alter table public.pending_writes drop constraint pending_writes_kind_check;
alter table public.pending_writes add constraint pending_writes_kind_check
  check (kind = any (array[
    'create_node', 'create_link', 'add_detail', 'add_link_detail',
    'create_schema_proposal', 'flag_conflict', 'create_promise', 'edit_node'
  ]));
