-- Subsystem #4 (chat agent) — base schema.
--
-- Three tables ship together: conversations + messages + pending_writes.
-- conversations groups a single chat session (1-hour idle timeout cron
-- not in this migration; lands when scheduling lands). messages stores
-- one row per turn (user, assistant, tool_call, tool_result,
-- clarifying_question). pending_writes is the intermediate state
-- between agent extraction and graph commits (the user has to confirm
-- before anything reaches nodes/links/node_details).
--
-- This migration adds tables + indexes + RLS only. The agent's
-- tool-use loop and the confirm/edit/reject UI follow in a later PR.
-- We ship the schema separately because it's the stable foundation
-- everything else depends on, and we'd rather land it early.

-- ─────────────────────────────────────────────────────────────────────
-- conversations
-- ─────────────────────────────────────────────────────────────────────
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  -- Set by an idle-timeout cron (1h after last_active_at) once that
  -- lands. Until then, conversations stay open indefinitely.
  ended_at timestamptz,
  last_active_at timestamptz not null default now(),
  -- Optional AI-generated title surfaced in /chat/history. Populated
  -- a few turns into the conversation by the agent.
  title text,
  created_at timestamptz not null default now()
);

create index conversations_user_active_idx
  on public.conversations (user_id, last_active_at desc);
create index conversations_user_open_idx
  on public.conversations (user_id, ended_at)
  where ended_at is null;

alter table public.conversations enable row level security;

create policy "conversations_self_select" on public.conversations
  for select using (user_id = (select auth.uid()));
create policy "conversations_self_insert" on public.conversations
  for insert with check (user_id = (select auth.uid()));
create policy "conversations_self_update" on public.conversations
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "conversations_self_delete" on public.conversations
  for delete using (user_id = (select auth.uid()));

comment on table public.conversations is
  'Chat sessions. One row per session; last_active_at + ended_at drive idle-timeout + history navigation.';

-- ─────────────────────────────────────────────────────────────────────
-- messages
-- ─────────────────────────────────────────────────────────────────────
-- Stores all chat turns: user messages, assistant replies, tool calls
-- the agent made, tool results, and clarifying questions. Each turn is
-- one row; tool_calls + tool_result are jsonb so we don't lock the
-- schema while the tool set is still evolving.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (
    role in (
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'clarifying_question'
    )
  ),
  -- Free-text content for user / assistant / clarifying_question rows.
  content text,
  -- Array of {tool_name, args, call_id} when role='tool_call'.
  tool_calls jsonb,
  -- {call_id, output} when role='tool_result'.
  tool_result jsonb,
  -- Only set when role='user' — the chat message becomes a source row
  -- so future graph writes can be attributed back to it.
  source_id uuid references public.sources (id) on delete set null,
  -- Groups all proposed writes from this turn together; nullable
  -- because most rows don't trigger writes (greetings, clarifications).
  pending_writes_batch_id uuid,
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);
create index messages_user_created_idx
  on public.messages (user_id, created_at desc);

alter table public.messages enable row level security;

create policy "messages_self_select" on public.messages
  for select using (user_id = (select auth.uid()));
create policy "messages_self_insert" on public.messages
  for insert with check (user_id = (select auth.uid()));
-- No update policy — messages are append-only. Edits to user-typed
-- text would break source provenance for any writes that referenced
-- the original message.
create policy "messages_self_delete" on public.messages
  for delete using (user_id = (select auth.uid()));

comment on table public.messages is
  'All chat turns: user, assistant, tool_call, tool_result, clarifying_question. Append-only.';

-- ─────────────────────────────────────────────────────────────────────
-- pending_writes
-- ─────────────────────────────────────────────────────────────────────
-- Intermediate state between agent extraction and graph commits.
-- Every tool call that proposes a graph mutation lands here first;
-- the user must Confirm to apply. Edits flip status='edited' with the
-- modified payload in edited_payload. Rejected rows stay around for
-- audit + the GC cron to sweep after 30 days.
create table public.pending_writes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  batch_id uuid not null,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  kind text not null check (
    kind in (
      'create_node',
      'create_link',
      'add_detail',
      'create_schema_proposal',
      'flag_conflict'
    )
  ),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'edited', 'rejected')),
  -- If user edited the row in the summary card, the modified version
  -- lives here; payload stays as the agent's original proposal so
  -- we can compute calibration metrics on agent accuracy.
  edited_payload jsonb,
  -- Once status='confirmed' (or 'edited' then committed), this is
  -- the resulting nodes.id / links.id / node_details.id / etc.
  committed_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index pending_writes_batch_idx
  on public.pending_writes (batch_id);
create index pending_writes_user_status_idx
  on public.pending_writes (user_id, status);
create index pending_writes_conversation_idx
  on public.pending_writes (conversation_id, created_at);

alter table public.pending_writes enable row level security;

create policy "pending_writes_self_select" on public.pending_writes
  for select using (user_id = (select auth.uid()));
create policy "pending_writes_self_insert" on public.pending_writes
  for insert with check (user_id = (select auth.uid()));
create policy "pending_writes_self_update" on public.pending_writes
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "pending_writes_self_delete" on public.pending_writes
  for delete using (user_id = (select auth.uid()));

comment on table public.pending_writes is
  'Agent-proposed graph writes awaiting user confirmation. Atomically applied on Confirm; soft-state on Reject; GC sweeps after 30 days.';

-- ─────────────────────────────────────────────────────────────────────
-- Touch last_active_at on every new message — keeps idle-timeout
-- semantics honest without requiring app-side updates.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.touch_conversation_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
     set last_active_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation_active();
