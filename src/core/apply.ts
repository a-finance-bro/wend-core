/**
 * The headless graph COMMIT path — the heart of Wend's governance loop.
 *
 * Extracted verbatim from src/lib/chat/actions.ts (2026-07-27) so the engine
 * is a plain module with no Next.js server-action plumbing: proposals in
 * (`pending_writes` payloads), confirmed graph rows out, provenance and
 * dedup preserved. Consumed by the chat confirm actions, the review
 * dashboard, and (as the exported open core) wend-core.
 *
 * Governance invariants enforced here, not in callers:
 *  - every committed fact carries a source (provenance) and user_confirmed
 *  - dedup at commit time (nodes fuzzy+alias, links exact, details value-set)
 *  - unknown vocabulary auto-mints per-user ontology rows (created_by_ai)
 *    instead of silently dropping facts — ontology is data, not DDL
 *  - renames preserve the old name as an alias so history keeps resolving
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// The apply functions only use PostgREST query chains, so any Supabase
// client works: the cookie-authed user client (RLS) or the service-role
// client with explicit user_id filters (every query here filters).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Normalize a display name for fuzzy comparison: lowercase, trim, drop
 * common organization suffixes, collapse whitespace, strip punctuation.
 * "Fintellect, Inc." → "fintellect"; "Fintelect" → "fintelect".
 */
export function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .trim()
    // Leading article: "The Keystone School" ↔ "Keystone School".
    .replace(/^(the|a|an)\s+/i, "")
    .replace(
      /\b(inc|llc|ltd|corp|co|company|gmbh|sa|ag|plc|limited|llp)\.?\b/g,
      "",
    )
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein edit distance, capped — we only care about distances
 * up to a small threshold (typo territory). Returns the actual
 * distance when ≤ cap, otherwise cap+1.
 */
export function editDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find an existing node whose name (or alias) is a fuzzy match for
 * `displayName`. Used by applyCreateNode to absorb typos like
 * "Fintelect" → existing "Fintellect" instead of creating a duplicate.
 *
 * Match thresholds:
 *  - Exact case-insensitive match (after normalize) → always.
 *  - Edit distance ≤ 2 on names ≥ 5 characters → match.
 *  - Otherwise no match.
 */
export async function findExistingNodeFuzzy(
  supabase: Db,
  userId: string,
  nodeTypeId: string,
  displayName: string,
): Promise<string | null> {
  const target = normalizeForMatch(displayName);
  if (!target) return null;

  const { data: existing } = await supabase
    .from("nodes")
    .select("id, display_name")
    .eq("user_id", userId)
    .eq("node_type_id", nodeTypeId)
    .is("deleted_at", null);
  const rows = (existing ?? []) as Array<{ id: string; display_name: string }>;

  // 1. Exact normalized match wins.
  for (const r of rows) {
    if (normalizeForMatch(r.display_name) === target) return r.id;
  }

  // 2. Edit distance for longer names (avoids "Bob" matching "Joe").
  if (target.length >= 5) {
    let bestId: string | null = null;
    let bestDist = 3;
    for (const r of rows) {
      const candidate = normalizeForMatch(r.display_name);
      if (candidate.length < 5) continue;
      const d = editDistance(target, candidate, 2);
      if (d <= 2 && d < bestDist) {
        bestDist = d;
        bestId = r.id;
      }
    }
    if (bestId) return bestId;
  }

  // 3. Aliases — covers nicknames and prior typos the user has saved
  //    against an existing node.
  const { data: aliasHits } = await supabase
    .from("node_aliases")
    .select("node_id, alias, nodes!inner(node_type_id)")
    .eq("user_id", userId)
    .eq("nodes.node_type_id", nodeTypeId);
  const aliases = (aliasHits ?? []) as Array<{
    node_id: string;
    alias: string;
  }>;
  for (const a of aliases) {
    if (normalizeForMatch(a.alias) === target) return a.node_id;
    if (target.length >= 5) {
      const d = editDistance(target, normalizeForMatch(a.alias), 2);
      if (d <= 2) return a.node_id;
    }
  }

  return null;
}

export interface ConfirmCaches {
  typeIdByName: Map<string, string>; // lower(type name) → type id
  existingNormByType: Map<string, Map<string, string>>; // typeId → normName → nodeId
  defIdByName: Map<string, string>; // detail-def name → id
}

export async function buildConfirmCaches(
  supabase: Db,
  userId: string,
): Promise<ConfirmCaches> {
  const [types, nodes, defs] = await Promise.all([
    supabase.from("node_types").select("id, name").eq("user_id", userId),
    supabase
      .from("nodes")
      .select("id, display_name, node_type_id")
      .eq("user_id", userId)
      .is("deleted_at", null),
    supabase.from("detail_definitions").select("id, name").eq("user_id", userId),
  ]);
  const typeIdByName = new Map<string, string>();
  for (const t of (types.data ?? []) as Array<{ id: string; name: string }>) {
    typeIdByName.set(t.name.toLowerCase(), t.id);
  }
  const existingNormByType = new Map<string, Map<string, string>>();
  for (const n of (nodes.data ?? []) as Array<{
    id: string;
    display_name: string;
    node_type_id: string;
  }>) {
    let m = existingNormByType.get(n.node_type_id);
    if (!m) {
      m = new Map();
      existingNormByType.set(n.node_type_id, m);
    }
    const norm = normalizeForMatch(n.display_name);
    if (norm && !m.has(norm)) m.set(norm, n.id);
  }
  const defIdByName = new Map<string, string>();
  for (const d of (defs.data ?? []) as Array<{ id: string; name: string }>) {
    defIdByName.set(d.name, d.id);
  }
  return { typeIdByName, existingNormByType, defIdByName };
}

export async function applyCreateNode(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  cache?: ConfirmCaches,
): Promise<string | null> {
  const typeName = String(payload.type ?? "Person");
  const displayName = String(payload.display_name ?? "").trim();
  if (!displayName) return null;

  // Type id: from the cache when bulk-confirming, else a single query.
  let typeId = cache?.typeIdByName.get(typeName.toLowerCase());
  if (!typeId) {
    const { data: typeRow } = await supabase
      .from("node_types")
      .select("id")
      .eq("user_id", userId)
      .ilike("name", typeName)
      .maybeSingle();
    if (!typeRow) return null;
    typeId = typeRow.id as string;
  }

  // Dedup against existing nodes of the same type. Cache path uses an
  // in-memory normalized map (exact-normalized: absorbs case / article / org
  // suffix, which covers the common bulk dupes); non-cache path keeps the
  // full fuzzy+alias+edit-distance match.
  if (cache) {
    const norm = normalizeForMatch(displayName);
    const hit = norm ? cache.existingNormByType.get(typeId)?.get(norm) : undefined;
    if (hit) return hit;
  } else {
    const existingId = await findExistingNodeFuzzy(
      supabase,
      userId,
      typeId,
      displayName,
    );
    if (existingId) return existingId;
  }

  const { data: node, error } = await supabase
    .from("nodes")
    .insert({
      user_id: userId,
      node_type_id: typeId,
      display_name: displayName,
    })
    .select("id")
    .single();
  if (error || !node) return null;

  // Seed the cache so later rows in the SAME batch dedup against this node.
  if (cache) {
    const norm = normalizeForMatch(displayName);
    if (norm) {
      let m = cache.existingNormByType.get(typeId);
      if (!m) {
        m = new Map();
        cache.existingNormByType.set(typeId, m);
      }
      if (!m.has(norm)) m.set(norm, node.id);
    }
  }

  const details = [
    ...((payload.details as Array<{ name: string; value: string }> | undefined) ??
      []),
  ];
  // A user-written note (e.g. added in the Gmail review popup before accepting)
  // lands as a bio detail.
  const userNote =
    typeof payload.user_note === "string" ? payload.user_note.trim() : "";
  if (userNote) details.push({ name: "bio", value: userNote });
  for (const d of details) {
    if (!d.value || d.value.trim().length === 0) continue;
    let defId = cache?.defIdByName.get(d.name);
    if (!defId) {
      const { data: defRow } = await supabase
        .from("detail_definitions")
        .select("id")
        .eq("user_id", userId)
        .eq("name", d.name)
        .maybeSingle();
      defId = defRow?.id as string | undefined;
      if (!defId) {
        // AUTO-CREATE a missing definition instead of silently dropping the
        // fact (applyAddDetail already does this). This is why LinkedIn
        // connections lost their `company` — no builtin def existed, so every
        // employer was discarded and the org-linking worker had nothing to act
        // on. Scope the new def to this node's type; list-like names go multi.
        // Every detail can hold multiple values (2026-07-18 rule).
        const additive = true;
        const { data: created } = await supabase
          .from("detail_definitions")
          .upsert(
            {
              user_id: userId,
              name: d.name,
              value_type: "text",
              applies_to_node_type_id: typeId,
              is_default: false,
              is_builtin: false,
              multi_value: additive,
              merge_strategy: additive ? "multi" : "replace",
            },
            { onConflict: "user_id,name" },
          )
          .select("id")
          .maybeSingle();
        defId = created?.id as string | undefined;
        if (!defId) continue;
        if (cache) cache.defIdByName.set(d.name, defId);
      }
    }
    if (!sourceId) continue;
    await supabase.from("node_details").insert({
      user_id: userId,
      node_id: node.id,
      detail_definition_id: defId,
      value: d.value,
      confidence: 1.0,
      source_id: sourceId,
      user_confirmed: true,
    });
  }
  return node.id;
}

export async function applyCreateLink(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  nameToId: Map<string, string>,
): Promise<string | null> {
  const linkTypeName = String(payload.link_type ?? "");
  const sourceRef = (payload.source as { id?: string; display_name?: string }) ?? {};
  const targetRef = (payload.target as { id?: string; display_name?: string }) ?? {};

  // Resolve a node reference in order of confidence: explicit id →
  // node created earlier in this batch → the user's Self node (the
  // agent often writes source {id:"", display_name:"Self"}) → an
  // existing node with that exact name. Previously anything past the
  // first two silently failed the whole link.
  const resolveRef = async (ref: {
    id?: string;
    display_name?: string;
  }): Promise<string | null> => {
    if (ref.id) return ref.id;
    const name = (ref.display_name ?? "").trim();
    if (!name) return null;
    const lc = name.toLowerCase();
    // Batch nodes: raw-lowercase key, then normalized key (seeded by the
    // caller / on commit) so a link to "Keystone School" matches a node
    // created this batch as "The Keystone School".
    const fromBatch = nameToId.get(lc);
    if (fromBatch) return fromBatch;
    const norm = normalizeForMatch(name);
    if (norm) {
      const fromBatchNorm = nameToId.get(`norm:${norm}`);
      if (fromBatchNorm) return fromBatchNorm;
    }
    if (["self", "me", "myself", "you"].includes(lc)) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("self_node_id")
        .eq("user_id", userId)
        .maybeSingle();
      return (prof as { self_node_id?: string } | null)?.self_node_id ?? null;
    }
    // Exact existing node.
    const { data: existing } = await supabase
      .from("nodes")
      .select("id")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .ilike("display_name", name)
      .limit(1);
    if (existing?.[0]?.id) return existing[0].id;
    // Alias: a node that was renamed keeps its old name here, so a link
    // referencing the prior spelling still resolves (e.g. "Kedabhai" → the
    // node now named "Kedar").
    const { data: aliasHit } = await supabase
      .from("node_aliases")
      .select("node_id")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .ilike("alias_text", name)
      .limit(1);
    if (aliasHit?.[0]?.node_id) return aliasHit[0].node_id;
    // Normalized fallback against ALL of the user's nodes — resolves
    // article/suffix/punctuation differences ("The Keystone School" vs
    // "Keystone School", "Fintellect, Inc." vs "Fintellect") that exact
    // match misses. Without this the link fails and reappears forever.
    if (norm) {
      const { data: all } = await supabase
        .from("nodes")
        .select("id, display_name")
        .eq("user_id", userId)
        .is("deleted_at", null);
      const hit = (all ?? []).find(
        (n) => normalizeForMatch((n as { display_name: string }).display_name) === norm,
      );
      if (hit) return (hit as { id: string }).id;
    }
    return null;
  };

  const sourceNodeId = await resolveRef(sourceRef);
  const targetNodeId = await resolveRef(targetRef);
  if (!sourceNodeId || !targetNodeId) return null;

  let { data: linkType } = await supabase
    .from("link_types")
    .select("id")
    .eq("user_id", userId)
    .eq("name", linkTypeName)
    .maybeSingle();
  if (!linkType) {
    // Evolving schema: mint the link type instead of silently failing the
    // row. The agent is told to use the MOST SPECIFIC relationship name
    // (contributor, honorary_role, spoke_at, …) and to coin a precise new
    // snake_case name when nothing fits — that only works if confirm-time
    // creates it. created_by_ai marks it for the schema surfaces; the user
    // can rename/delete it there (undo path).
    const coined = linkTypeName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (!coined) return null;
    const { data: minted } = await supabase
      .from("link_types")
      .insert({
        user_id: userId,
        name: coined,
        direction: "directed",
        is_builtin: false,
        created_by_ai: true,
        description: "Created automatically from a confirmed AI proposal.",
      })
      .select("id")
      .maybeSingle();
    if (!minted) {
      // Insert can race a concurrent mint of the same name — re-read.
      const { data: raced } = await supabase
        .from("link_types")
        .select("id")
        .eq("user_id", userId)
        .eq("name", coined)
        .maybeSingle();
      if (!raced) return null;
      linkType = raced;
    } else {
      linkType = minted;
    }
  }

  // Idempotency: an identical link (same type, same endpoints) must never be
  // inserted twice. Confirming Gmail-ingest batches used to re-apply the same
  // Self→Org link on every sweep — the 2026-07-07 audit found one member_of
  // link duplicated FIFTEEN times. Return the existing link id (and skip the
  // detail writes — they'd stack duplicate rows on the existing link).
  const { data: dupe } = await supabase
    .from("links")
    .select("id")
    .eq("user_id", userId)
    .eq("link_type_id", linkType.id)
    .eq("source_node_id", sourceNodeId)
    .eq("target_node_id", targetNodeId)
    .limit(1);
  if (dupe && dupe.length > 0) return dupe[0].id as string;

  const { data: link, error } = await supabase
    .from("links")
    .insert({
      user_id: userId,
      link_type_id: linkType.id,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
    })
    .select("id")
    .single();
  if (error || !link) return null;

  const details = (payload.details as Array<{ name: string; value: string }> | undefined) ?? [];
  for (const d of details) {
    if (!d.value || d.value.trim().length === 0) continue;
    const { data: defRow } = await supabase
      .from("detail_definitions")
      .select("id")
      .eq("user_id", userId)
      .eq("name", d.name)
      .maybeSingle();
    if (!defRow || !sourceId) continue;
    await supabase.from("link_details").insert({
      user_id: userId,
      link_id: link.id,
      detail_definition_id: defRow.id,
      value: d.value,
      confidence: 1.0,
      source_id: sourceId,
      user_confirmed: true,
    });
  }
  return link.id;
}

export type AddDetailOutcome =
  | { kind: "committed"; detail_id: string }
  | { kind: "conflict_flagged"; conflict_id: string }
  | { kind: "failed" };

// EVERY detail field holds multiple values (2026-07-18 founder rule): adding
// a fact never conflicts, the first value is primary and the rest secondary.
// The AI replaces (vs adds) explicitly via proposeEditNode. The old
// LIST_VALUED_DETAILS allowlist is gone — multi is simply the default.

// Geographic fields where a LESS-specific value is a comma-suffix of a
// more-specific one ("United States" ⊂ "Fremont, California, United States")
// — those must collapse to the specific one, never coexist or conflict.
const LOCATION_FIELDS = new Set([
  "location", "locations", "city", "cities", "based_in", "address",
]);

/** Comma-token containment: is `a` a trailing subset of `b` (a less specific)? */
export function isLocationSuffix(a: string, b: string): boolean {
  const ta = a.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const tb = b.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (ta.length === 0 || ta.length >= tb.length) return false;
  // a's tokens must equal the last ta.length tokens of b.
  const tail = tb.slice(tb.length - ta.length);
  return ta.every((t, i) => t === tail[i]);
}

export async function applyAddDetail(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  nameToId: Map<string, string>,
): Promise<AddDetailOutcome> {
  // Two producers write `add_detail` pending rows: the chat agent's
  // proposeAddDetail tool (uses `node_id`) and the web-enrichment
  // pipeline (uses `target_node_id`). Accept either key so a confirm
  // doesn't silently reject every enrichment row.
  const rawNodeId = String(
    payload.node_id ?? payload.target_node_id ?? "",
  ).trim();
  const detailName = String(payload.detail_name ?? "").trim();
  const value = String(payload.value ?? "").trim();
  if (!rawNodeId || !detailName || !value || !sourceId) {
    return { kind: "failed" };
  }

  // The agent sometimes stores node_id as a display_name (because the
  // node hasn't been created yet — it lives in a sibling create_node
  // pending row in the same batch). Resolve via nameToId map first;
  // only treat the value as a UUID if it parses as one.
  const looksUuid = /^[0-9a-f-]{36}$/i.test(rawNodeId);
  const nodeId = looksUuid
    ? rawNodeId
    : nameToId.get(rawNodeId.toLowerCase()) ?? null;
  if (!nodeId) return { kind: "failed" };

  let { data: defRow } = await supabase
    .from("detail_definitions")
    .select("id, merge_strategy, value_type")
    .eq("user_id", userId)
    .eq("name", detailName)
    .maybeSingle<{
      id: string;
      merge_strategy: "replace" | "append" | "multi" | null;
      value_type: string;
    }>();
  // No definition for this detail name? Auto-create a sensible text one
  // instead of hard-failing the row. Producers (web enrichment, the chat
  // agent) occasionally emit a vocabulary term that was never seeded — this
  // has silently dropped facts three times (migrations 052, 079). Scope the
  // new def to the target node's type so it shows up in the right editor.
  if (!defRow) {
    const { data: nodeRow } = await supabase
      .from("nodes")
      .select("node_type_id")
      .eq("user_id", userId)
      .eq("id", nodeId)
      .maybeSingle<{ node_type_id: string }>();
    // Note-like free-text fields default to multi (accumulate, never conflict);
    // everything else stays single-valued replace. Keeps auto-created vocab
    // consistent with the ALWAYS_ADDITIVE handling below.
    // Every detail can hold multiple values (2026-07-18 rule).
    const additive = true;
    const { data: created } = await supabase
      .from("detail_definitions")
      .upsert(
        {
          user_id: userId,
          name: detailName,
          value_type: "text",
          applies_to_node_type_id: nodeRow?.node_type_id ?? null,
          is_default: false,
          is_builtin: false,
          multi_value: additive,
          merge_strategy: additive ? "multi" : "replace",
        },
        { onConflict: "user_id,name" },
      )
      .select("id, merge_strategy, value_type")
      .maybeSingle<{
        id: string;
        merge_strategy: "replace" | "append" | "multi" | null;
        value_type: string;
      }>();
    if (!created) return { kind: "failed" };
    defRow = created;
  }

  // Free-form annotation fields are inherently a SET of independent notes, not
  // one single-valued fact — "Cofounder at Acme" and "Mutual connection
  // with Parshwa Shah" are both true at once. They must never land in the
  // Conflicts queue, whatever a (possibly stale) definition's merge_strategy
  // says. Force multi so every distinct value coexists — the general "add
  // unlimited attributes" guarantee for note-like fields.
  // Founder rule (2026-07-18): EVERY detail can hold multiple values — adding
  // a fact never conflicts with an existing one ("Volunteer at SNIPSA" and
  // "Volunteer at Special Olympics" are both true). Whether to REPLACE instead
  // of add is the AI's explicit call via proposeEditNode, which shows a
  // before→after preview. So: `append` defs keep their extend-the-text
  // behavior; everything else is multi. The old replace-and-conflict path is
  // gone — conflicts are for genuine contradictions, not second values.
  const strategy: "append" | "multi" =
    (defRow.merge_strategy as string | null) === "append" ? "append" : "multi";

  const { data: existing } = await supabase
    .from("node_details")
    .select("id, value, source_id")
    .eq("user_id", userId)
    .eq("node_id", nodeId)
    .eq("detail_definition_id", defRow.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── Append-style fields (bio, notes, interests, recent_news, …) ──
  // The new value extends the existing single row instead of conflicting.
  if (strategy === "append" && existing) {
    const merged = mergeAdditiveText(existing.value, value);
    if (!mergeAddedNew(existing.value, merged)) {
      // No new content — the incoming was already covered. Touch
      // updated_at so audit shows a confirmation but skip the actual
      // change to keep history clean.
      return { kind: "committed", detail_id: existing.id };
    }
    const { error: updErr } = await supabase
      .from("node_details")
      .update({
        value: merged,
        source_id: sourceId,
        user_confirmed: true,
      })
      .eq("user_id", userId)
      .eq("id", existing.id);
    if (updErr) return { kind: "failed" };
    return { kind: "committed", detail_id: existing.id };
  }

  // ── Multi-value path — every DISTINCT value gets its own row, no conflict.
  // Dedup on the exact value so re-running extraction/enrichment doesn't stack
  // identical notes/emails/languages (case-insensitive, whitespace-normalized).
  // Also the fresh-insert path for an append field's FIRST value (strategy is
  // append but nothing exists yet to append to).
  if (strategy === "multi" || !existing) {
    const { data: siblings } = await supabase
      .from("node_details")
      .select("id, value")
      .eq("user_id", userId)
      .eq("node_id", nodeId)
      .eq("detail_definition_id", defRow.id)
      .is("deleted_at", null);
    const norm = (v: unknown) =>
      String(v ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    const dupe = (siblings ?? []).find((s) => norm(s.value) === norm(value));
    if (dupe) return { kind: "committed", detail_id: dupe.id };

    // Location specificity: never store both "United States" and "Fremont,
    // California, United States". If the incoming is a less-specific suffix of
    // an existing one, keep the specific one (skip). If it's MORE specific than
    // an existing sibling, retire the vaguer one and keep the new.
    if (LOCATION_FIELDS.has(detailName.toLowerCase())) {
      for (const s of siblings ?? []) {
        const sv = String(s.value ?? "").trim();
        if (isLocationSuffix(value, sv)) {
          // incoming is vaguer than an existing value → covered, skip.
          return { kind: "committed", detail_id: s.id };
        }
      }
      const vaguer = (siblings ?? []).filter((s) =>
        isLocationSuffix(String(s.value ?? "").trim(), value),
      );
      for (const s of vaguer) {
        await supabase
          .from("node_details")
          .update({ deleted_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("id", s.id);
      }
    }

    const { data: detail, error } = await supabase
      .from("node_details")
      .insert({
        user_id: userId,
        node_id: nodeId,
        detail_definition_id: defRow.id,
        value,
        confidence: 1.0,
        source_id: sourceId,
        user_confirmed: true,
      })
      .select("id")
      .single();
    if (error || !detail) return { kind: "failed" };
    return { kind: "committed", detail_id: detail.id };
  }

  // Unreachable: strategy is always append or multi now, and both return
  // above. Kept as a hard fail so a future strategy addition can't silently
  // fall through.
  return { kind: "failed" };
}

/**
 * Merge new text into an existing free-text field (bio, notes, etc.).
 * Goals:
 *  - Skip duplicates: if the incoming sentence already appears in the
 *    existing value, drop it.
 *  - Avoid containment thrash: if either value is a strict substring of
 *    the other, return the longer.
 *  - Otherwise concatenate, separated by a sentence break.
 */
export function mergeAdditiveText(existing: unknown, incoming: string): string {
  const a = (typeof existing === "string" ? existing : "").trim();
  const b = incoming.trim();
  if (!a) return b;
  if (!b) return a;
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  if (b.toLowerCase().includes(a.toLowerCase())) return b;

  // Sentence-level dedup: if the new value is a few sentences and any
  // of them already appear, only keep the new ones.
  const sentencesIn = b
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const existingLower = a.toLowerCase();
  const fresh = sentencesIn.filter(
    (s) => !existingLower.includes(s.toLowerCase()),
  );
  if (fresh.length === 0) return a;
  const addition = fresh.join(" ");
  return a.endsWith(".") || a.endsWith("!") || a.endsWith("?")
    ? `${a} ${addition}`
    : `${a}. ${addition}`;
}

export function mergeAddedNew(existing: unknown, merged: string): boolean {
  const a = (typeof existing === "string" ? existing : "").trim();
  return merged.trim().length > a.length;
}

export function valuesDiffer(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string =>
    typeof v === "string"
      ? v.trim().toLowerCase()
      : typeof v === "number"
      ? String(v)
      : JSON.stringify(v);
  return norm(a) !== norm(b);
}

/**
 * Apply an `add_link_detail` pending row → insert a link_details row
 * for {link_id, detail_definition by name, value}. If a non-deleted
 * row already exists for the same (link, definition), soft-delete it
 * first so the new value replaces the old. This is the "agent updates
 * the title on Kevin Rudd's employee link" path.
 *
 * Returns the inserted link_details.id on success, null on any
 * lookup or insert failure. We deliberately don't go through the
 * conflict-flagging machinery used for node_details — link details
 * are usually role/title that the user is intentionally updating, and
 * adding a conflict UI flow here would dilute the signal.
 */
export async function applyAddLinkDetail(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
): Promise<string | null> {
  const linkId = String(payload.link_id ?? "").trim();
  const detailName = String(payload.detail_name ?? "").trim();
  const value = String(payload.value ?? "").trim();
  if (!linkId || !detailName || !value || !sourceId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return null;

  // Confirm the link actually belongs to this user (defensive — RLS
  // would also stop a cross-user write, but this is a clearer fail).
  const { data: linkRow } = await supabase
    .from("links")
    .select("id")
    .eq("user_id", userId)
    .eq("id", linkId)
    .maybeSingle();
  if (!linkRow) return null;

  const { data: defRow } = await supabase
    .from("detail_definitions")
    .select("id")
    .eq("user_id", userId)
    .eq("name", detailName)
    .maybeSingle();
  if (!defRow) return null;

  // Replace strategy: soft-delete any existing row for this detail on
  // this link, then insert the new value. Keeps history queryable via
  // link_details.deleted_at IS NOT NULL.
  await supabase
    .from("link_details")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("link_id", linkId)
    .eq("detail_definition_id", defRow.id)
    .is("deleted_at", null);

  const { data: inserted, error } = await supabase
    .from("link_details")
    .insert({
      user_id: userId,
      link_id: linkId,
      detail_definition_id: defRow.id,
      value,
      confidence: 1.0,
      source_id: sourceId,
      user_confirmed: true,
    })
    .select("id")
    .single();
  if (error || !inserted) return null;
  return inserted.id;
}

/**
 * Apply an edit_node pending row → change an EXISTING node's name and/or
 * detail values (new job, new location, typo fix, …). Each edit is
 * {field:"name", next} or {field:"detail", detail_name, next}. Renames keep
 * the old name as an alias so links/history keep resolving. Detail edits
 * replace the current value (soft-deleting the prior). Returns the node id
 * on any successful change.
 */
export async function applyEditNode(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
): Promise<string | null> {
  const nodeId = String(payload.node_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(nodeId)) return null;

  const { data: node } = await supabase
    .from("nodes")
    .select("id, node_type_id, display_name")
    .eq("user_id", userId)
    .eq("id", nodeId)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; node_type_id: string; display_name: string }>();
  if (!node) return null;

  const edits = Array.isArray(payload.edits)
    ? (payload.edits as Array<Record<string, unknown>>)
    : [];
  let changed = false;

  for (const e of edits) {
    const field = String(e.field ?? "").trim();
    const next = String(e.next ?? "").trim();
    if (!next) continue;

    if (field === "name") {
      const prev = node.display_name;
      if (next === prev) continue;
      const { error } = await supabase
        .from("nodes")
        .update({ display_name: next, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("id", nodeId);
      if (!error) {
        changed = true;
        // Preserve the old name as an alias so links referencing it still
        // resolve and recall can find it under the prior spelling. (Column is
        // alias_text; source must be user/agent/extension/enrichment.)
        if (prev && prev.trim()) {
          await supabase
            .from("node_aliases")
            .insert({
              user_id: userId,
              node_id: nodeId,
              alias_text: prev.trim(),
              source: "user",
            })
            .then(
              () => {},
              () => {},
            );
        }
      }
      continue;
    }

    if (field === "detail") {
      const detailName = String(e.detail_name ?? "").trim();
      if (!detailName || !sourceId) continue;
      let { data: defRow } = await supabase
        .from("detail_definitions")
        .select("id")
        .eq("user_id", userId)
        .eq("name", detailName)
        .maybeSingle<{ id: string }>();
      if (!defRow) {
        const { data: created } = await supabase
          .from("detail_definitions")
          .insert({
            user_id: userId,
            name: detailName,
            value_type: "text",
            applies_to_node_type_id: node.node_type_id,
            is_default: false,
            is_builtin: false,
            multi_value: false,
            merge_strategy: "replace",
          })
          .select("id")
          .maybeSingle<{ id: string }>();
        if (!created) continue;
        defRow = created;
      }
      // Replace: soft-delete existing values for this detail on this node,
      // then insert the new one.
      await supabase
        .from("node_details")
        .update({ deleted_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("node_id", nodeId)
        .eq("detail_definition_id", defRow.id)
        .is("deleted_at", null);
      const { error } = await supabase.from("node_details").insert({
        user_id: userId,
        node_id: nodeId,
        detail_definition_id: defRow.id,
        value: next,
        confidence: 1.0,
        source_id: sourceId,
        user_confirmed: true,
      });
      if (!error) changed = true;
    }
  }

  return changed ? nodeId : null;
}

/**
 * Apply a create_promise pending row → insert into the promises table.
 * The agent's flagPromise tool wrote {direction, description, target,
 * due_at} into payload. target.id may reference an existing node OR
 * target.display_name may match a create_node row earlier in the same
 * batch (resolved via nameToId). due_at is an ISO string or "" — empty
 * collapses to null. Source row is the same chat-batch source the rest
 * of the batch shares.
 */
export async function applyCreatePromise(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  nameToId: Map<string, string>,
): Promise<string | null> {
  if (!sourceId) return null;
  const direction = String(payload.direction ?? "");
  const description = String(payload.description ?? "").trim();
  if (!description) return null;
  if (
    direction !== "user_to_other" &&
    direction !== "other_to_user" &&
    direction !== "mutual"
  ) {
    return null;
  }

  const target = (payload.target as { id?: string; display_name?: string } | undefined) ?? {};
  const counterpartyId =
    target.id ||
    nameToId.get((target.display_name ?? "").trim().toLowerCase()) ||
    null;

  // Place the counterparty in the right slot per direction so the name renders
  // and "who owes whom" is correct everywhere (matches mobile + /app/promises):
  // other_to_user → committer = the other person, target = self;
  // user_to_other / mutual → target = the other person, committer = self.
  const { data: selfProf } = await supabase
    .from("profiles")
    .select("self_node_id")
    .eq("user_id", userId)
    .maybeSingle();
  const selfId =
    (selfProf as { self_node_id?: string | null } | null)?.self_node_id ?? null;
  const committerNodeId = direction === "other_to_user" ? counterpartyId : selfId;
  const targetNodeId = direction === "other_to_user" ? selfId : counterpartyId;

  const dueAtRaw = String(payload.due_at ?? "").trim();
  let dueAt: string | null = null;
  if (dueAtRaw.length > 0) {
    const parsed = new Date(dueAtRaw);
    if (!Number.isNaN(parsed.getTime())) {
      dueAt = parsed.toISOString();
    }
  }

  // Dedup at confirm time: one ingest batch can propose the same commitment
  // phrased three ways ("send an invite for Wednesday at 9:30" x3), and
  // confirm-all then landed three live promises. Skip the insert when an
  // OPEN promise for the same counterparty already matches on normalized
  // wording. Fulfilled/discarded promises don't block: re-promising
  // something you already did once is a real new promise.
  const norm = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const { data: openExisting } = await supabase
    .from("promises")
    .select("id, description, target_node_id, committer_node_id")
    .eq("user_id", userId)
    .in("status", ["open", "expired"])
    .limit(200);
  const newKey = norm(description);
  const newWords = new Set(newKey.split(" ").filter((w) => w.length > 2));
  for (const ex of (openExisting ?? []) as Array<{
    id: string;
    description: string;
    target_node_id: string | null;
    committer_node_id: string | null;
  }>) {
    const samePeople =
      ex.target_node_id === targetNodeId && ex.committer_node_id === committerNodeId;
    if (!samePeople) continue;
    const exKey = norm(ex.description);
    if (exKey === newKey) return ex.id;
    // Near-duplicate: >=80% of the shorter description's significant words
    // appear in the other one.
    const exWords = new Set(exKey.split(" ").filter((w) => w.length > 2));
    const [small, big] = exWords.size <= newWords.size ? [exWords, newWords] : [newWords, exWords];
    if (small.size >= 3) {
      let hit = 0;
      for (const w of small) if (big.has(w)) hit++;
      if (hit / small.size >= 0.8) return ex.id;
    }
  }

  const { data: promise, error } = await supabase
    .from("promises")
    .insert({
      user_id: userId,
      direction,
      committer_node_id: committerNodeId,
      target_node_id: targetNodeId,
      description,
      due_at: dueAt,
      source_id: sourceId,
    })
    .select("id")
    .single();
  if (error || !promise) return null;
  return promise.id;
}
