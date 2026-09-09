/**
 * Resolve a tag by name, creating it when nothing matches.
 *
 * WHY THIS IS ITS OWN MODULE. `tags` has a per-user name and no unique index on
 * it, so every writer has to do the same case-insensitive find-then-insert. The
 * chat agent's `tagNode` has carried a private copy of this since tags shipped;
 * the Google Contacts import needs the identical rule, because a user whose
 * Google group is called "investors" and whose graph tag is "Investors" has ONE
 * bucket and must not end up with two. A second copy of the rule is how the two
 * spellings start.
 *
 * Not a server action: this is called from an import running under the
 * service-role client, and every export of a "use server" file is a public POST
 * endpoint. Callers name the tenant in the arguments.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/** Escape a value for an exact ilike match (a tag may legitimately contain % or _). */
function likeExact(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The palette a new tag's colour is drawn from. Deterministic on the name, so a
 * tag deleted and recreated comes back the same colour rather than reshuffling
 * the board.
 */
const TAG_COLORS = [
  "#5E503F",
  "#22333B",
  "#a84432",
  "#3a7a45",
  "#C6AC8F",
  "#7a5a3a",
  "#3b5566",
];

export function tagColorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

/**
 * Find (case-insensitively) or create this user's tag. Returns null rather than
 * throwing: a tag is a label, never a reason to fail the work that wanted it.
 */
export async function resolveOrCreateTag(
  supabase: Db,
  userId: string,
  rawName: string,
): Promise<{ id: string; name: string } | null> {
  const name = rawName.trim();
  if (!name) return null;

  const { data: existing } = await supabase
    .from("tags")
    .select("id, name")
    .eq("user_id", userId)
    .ilike("name", likeExact(name))
    .maybeSingle();
  if (existing?.id) return { id: existing.id as string, name: existing.name as string };

  const { data: created, error } = await supabase
    .from("tags")
    .insert({ user_id: userId, name, color: tagColorFor(name), is_builtin: false })
    .select("id, name")
    .single();
  if (error || !created) return null;
  return { id: created.id as string, name: created.name as string };
}

/**
 * Attach a tag to a node, by name. Idempotent through the node_tags primary key.
 * Returns the tag name that was applied, or null if nothing was.
 */
export async function applyTagByName(
  supabase: Db,
  userId: string,
  nodeId: string,
  rawName: string,
): Promise<string | null> {
  const tag = await resolveOrCreateTag(supabase, userId, rawName);
  if (!tag) return null;
  const { error } = await supabase
    .from("node_tags")
    .upsert(
      { user_id: userId, node_id: nodeId, tag_id: tag.id },
      { onConflict: "user_id,node_id,tag_id", ignoreDuplicates: true },
    );
  return error ? null : tag.name;
}
