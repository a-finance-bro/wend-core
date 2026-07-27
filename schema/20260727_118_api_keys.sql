-- 118: API keys for the Wend MCP server (agent access).
--
-- A key authenticates an external AI agent (Claude, ChatGPT, Cursor, any MCP
-- client) as ONE Wend user. Only a SHA-256 hash is stored; the plaintext
-- (wend_live_…) is shown exactly once at mint time. Revocation is a soft
-- stamp so the row (and its last_used_at trail) survives for audit.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'MCP key',
  -- First characters of the plaintext (wend_live_ab12…) for display only.
  key_prefix text not null,
  -- SHA-256 hex of the full plaintext key. Unique = O(1) auth lookup.
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_user_idx on public.api_keys (user_id, created_at desc);

alter table public.api_keys enable row level security;

-- Owners manage their own keys from the settings UI (cookie-authed client).
-- The MCP route itself verifies keys with the service-role client.
create policy "api_keys_self_select" on public.api_keys
  for select using (user_id = (select auth.uid()));
create policy "api_keys_self_insert" on public.api_keys
  for insert with check (user_id = (select auth.uid()));
create policy "api_keys_self_update" on public.api_keys
  for update using (user_id = (select auth.uid()));
create policy "api_keys_self_delete" on public.api_keys
  for delete using (user_id = (select auth.uid()));
