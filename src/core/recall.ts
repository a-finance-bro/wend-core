/**
 * Vector recall over the user's graph — Subsystem #5.
 *
 * Embed a natural-language query via Voyage, then surface the top-N
 * nodes by cosine similarity via the `recall_nodes` RPC (migration
 * 010). Used by the chat agent's `recallNodes` tool to answer
 * questions like "who do I know in fintech?" or "what did Sarah and
 * I talk about?".
 *
 * Production safety: when no Voyage key is configured — or Voyage
 * rate-limits (the free tier is 3 RPM; prod hit 429s that made the
 * agent claim it knew nothing about people it had rows for) — recall
 * degrades to a case-insensitive text match over node names + aliases
 * instead of returning nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { embedText } from "../embed/provider.js";

export interface RecallMatch {
  id: string;
  display_name: string;
  node_type_name: string;
  similarity: number;
}

export interface RecallResult {
  ok: boolean;
  matches: RecallMatch[];
  error?: string;
  /** True when semantic search was unavailable (no key / rate limit)
   * and the matches came from plain text matching instead. */
  degraded?: boolean;
}

/**
 * Default match count — small enough to fit comfortably in a Claude
 * Opus context window even with verbose detail expansion, big enough
 * to surface the long tail. The agent can request more via the tool's
 * `top_k` parameter.
 */
export const DEFAULT_TOP_K = 8;

/**
 * Embed `query` and return the top `topK` matching nodes for `userId`.
 * Returns ok=false on the embedding step failing; ok=true with an
 * empty matches array on no embeddings configured (production /
 * cold-start case).
 */
export async function recallNodes(
  supabase: SupabaseClient,
  query: string,
  topK: number = DEFAULT_TOP_K,
): Promise<RecallResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: true, matches: [] };
  }

  // Clamp topK to reasonable bounds so a malformed agent call can't
  // blow up the context window.
  const k = Math.min(Math.max(1, Math.floor(topK)), 32);

  const vec = await embedText(trimmed);
  if (!vec) {
    // Voyage no-op'd (no key), rate-limited (429 — free tier is 3 RPM),
    // or transiently failed. Degrade to text matching so the agent can
    // still ground answers in real nodes instead of claiming the graph
    // is empty.
    const matches = await textFallbackRecall(supabase, trimmed, k);
    return { ok: true, matches, degraded: true };
  }

  const { data, error } = await supabase.rpc("recall_nodes", {
    query_embedding: vec,
    match_count: k,
  });

  if (error) {
    return { ok: false, matches: [], error: error.message };
  }

  const matches = ((data ?? []) as Array<{
    id: string;
    display_name: string;
    node_type_name: string;
    similarity: number;
  }>).map((r) => ({
    id: r.id,
    display_name: r.display_name,
    node_type_name: r.node_type_name,
    similarity: typeof r.similarity === "number" ? r.similarity : 0,
  }));

  // Semantic search only sees nodes that HAVE an embedding. A node whose
  // embedding was never generated (Voyage rate-limited at ingest, or a
  // brand-new node) is invisible here even though Voyage answered THIS query
  // fine — so a plain "recallNodes('Professor Kumar')" returned [] for a person
  // who was clearly in the graph, and the agent wrongly said "you don't have
  // anything about them". When the semantic pass comes back empty OR only weakly
  // (a proper-name query embeds poorly against topical vectors), supplement with
  // the embedding-free name/text match so real name hits still surface.
  const best = matches[0]?.similarity ?? 0;
  if (matches.length === 0 || best < WEAK_SIMILARITY) {
    const textHits = await textFallbackRecall(supabase, trimmed, k);
    const seen = new Set(matches.map((m) => m.id));
    const merged = [...matches];
    for (const t of textHits) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      merged.push(t);
      if (merged.length >= k) break;
    }
    if (merged.length > matches.length) {
      return { ok: true, matches: merged, degraded: matches.length === 0 };
    }
  }

  return { ok: true, matches };
}

/**
 * Below this cosine similarity the top semantic hit is too weak to trust as
 * the answer on its own (e.g. "Anna" at 0.17 for a "Professor Kumar" query),
 * so we also run the name-text match and merge real name hits in.
 */
const WEAK_SIMILARITY = 0.35;

/**
 * Embedding-free recall: case-insensitive substring match on node
 * display names for each significant word in the query (RLS scopes the
 * session client to the user). No similarity signal — entries carry 0
 * so callers can tell they're text hits, and results are deduped
 * across words in query-word order.
 */
async function textFallbackRecall(
  supabase: SupabaseClient,
  query: string,
  k: number,
): Promise<RecallMatch[]> {
  const words = Array.from(
    new Set(
      query
        .split(/[^\p{L}\p{N}'-]+/u)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3),
    ),
  ).slice(0, 6);
  if (words.length === 0) return [];

  // PostgREST `or` with ilike per word. Escape %/_ so a literal in the
  // query can't widen the match, and commas/parens (or-syntax chars).
  const pattern = (w: string) =>
    `display_name.ilike.%${w.replace(/[\\%_,()]/g, "")}%`;
  const { data, error } = await supabase
    .from("nodes")
    .select("id, display_name, node_types(name)")
    .is("deleted_at", null)
    .or(words.map(pattern).join(","))
    .limit(k);
  if (error || !data) return [];

  return (data as unknown as Array<{
    id: string;
    display_name: string;
    node_types: { name: string } | null;
  }>).map((r) => ({
    id: r.id,
    display_name: r.display_name,
    node_type_name: r.node_types?.name ?? "Node",
    similarity: 0,
  }));
}

/**
 * Pull a node + every detail + every outgoing/incoming link in one
 * shot. Used by the agent's `getNodeDetails` tool to expand on a
 * recall hit when the user asks a follow-up.
 *
 * Returns null if the node doesn't belong to the user (RLS enforces
 * but the explicit null path is friendlier for the tool's reply).
 */
export interface NodeExpansion {
  id: string;
  display_name: string;
  node_type: string;
  details: Array<{
    name: string;
    value: string;
    /**
     * Where this fact came from. Null only for legacy rows written before
     * provenance was mandatory. Any agent reading this graph should be able to
     * cite a source, because "every fact has a source, and you approved it" is
     * the product, not a marketing line.
     */
    source: { label: string; type: string } | null;
    /** True when a human approved it, as opposed to it being an AI inference. */
    confirmed: boolean;
  }>;
  outgoing: Array<{
    link_id: string;
    link_type: string;
    target_display_name: string;
    target_id: string;
    // Link-level details (title, employee_start, etc.) so the agent
    // can see whether a role / dates are already set before proposing
    // an update.
    link_details: Array<{ name: string; value: string }>;
  }>;
  incoming: Array<{
    link_id: string;
    link_type: string;
    source_display_name: string;
    source_id: string;
    link_details: Array<{ name: string; value: string }>;
  }>;
  /** Links beyond the per-direction cap, if any. Hub nodes (Self, big
   *  orgs) can carry hundreds of links; expanding all of them into an
   *  agent context burned ~50K tokens per call pre-cap. */
  omitted_outgoing?: number;
  omitted_incoming?: number;
}

/** Max links per direction returned to agent tools. Enough to answer any
 *  real dedup/context question; hub nodes report the omitted remainder. */
const EXPAND_LINK_CAP = 60;

export async function expandNode(
  supabase: SupabaseClient,
  userId: string,
  nodeId: string,
): Promise<NodeExpansion | null> {
  const [nodeRes, detailsRes, outgoingRes, incomingRes] = await Promise.all([
    supabase
      .from("nodes")
      .select("id, display_name, node_types(name)")
      .eq("user_id", userId)
      .eq("id", nodeId)
      .maybeSingle(),
    supabase
      .from("node_details")
      // `sources(...)` is the whole product promise made machine-readable.
      // Without it, an agent reading this graph over MCP gets facts with no
      // provenance, which is the one thing Wend claims to be for. Found by
      // asking Claude, through the live connector, "what is the source behind
      // each fact": it called search twice looking for a capability that could
      // tell it, and there was none.
      .select(
        "value, user_confirmed, detail_definitions(name), sources(source_type, display_label)",
      )
      .eq("user_id", userId)
      .eq("node_id", nodeId)
      .is("deleted_at", null),
    supabase
      .from("links")
      .select(
        "id, link_types(name), target_node:nodes!links_target_node_id_fkey(id, display_name), link_details(value, detail_definitions(name), deleted_at)",
      )
      .eq("user_id", userId)
      .eq("source_node_id", nodeId),
    supabase
      .from("links")
      .select(
        "id, link_types(name), source_node:nodes!links_source_node_id_fkey(id, display_name), link_details(value, detail_definitions(name), deleted_at)",
      )
      .eq("user_id", userId)
      .eq("target_node_id", nodeId),
  ]);

  const node = nodeRes.data as unknown as
    | { id: string; display_name: string; node_types: { name: string } | null }
    | null;
  if (!node) return null;

  const details = ((detailsRes.data ?? []) as unknown as Array<{
    value: unknown;
    user_confirmed: boolean | null;
    detail_definitions: { name: string } | null;
    sources: { source_type: string; display_label: string } | null;
  }>)
    .map((d) => ({
      name: d.detail_definitions?.name ?? "",
      value: typeof d.value === "string" ? d.value : JSON.stringify(d.value),
      // Kept deliberately terse. A hub node can carry dozens of details and
      // every field here is re-sent on each agent turn, so this is the label a
      // human would recognise plus the machine type, and nothing else. The
      // full source row stays one lookup away in the app.
      source: d.sources
        ? { label: d.sources.display_label, type: d.sources.source_type }
        : null,
      confirmed: d.user_confirmed === true,
    }))
    .filter((d) => d.name.length > 0 && d.value.length > 0);

  type RawLinkDetail = {
    value: unknown;
    detail_definitions: { name: string } | null;
    deleted_at: string | null;
  };
  const flattenLinkDetails = (rows: RawLinkDetail[] | null | undefined) =>
    (rows ?? [])
      .filter((d) => !d.deleted_at)
      .map((d) => ({
        name: d.detail_definitions?.name ?? "",
        value:
          typeof d.value === "string" ? d.value : JSON.stringify(d.value),
      }))
      .filter((d) => d.name.length > 0 && d.value.length > 0);

  const outgoing = ((outgoingRes.data ?? []) as unknown as Array<{
    id: string;
    link_types: { name: string } | null;
    target_node: { id: string; display_name: string } | null;
    link_details: RawLinkDetail[] | null;
  }>)
    .map((l) => ({
      link_id: l.id,
      link_type: l.link_types?.name ?? "",
      target_display_name: l.target_node?.display_name ?? "",
      target_id: l.target_node?.id ?? "",
      link_details: flattenLinkDetails(l.link_details),
    }))
    .filter((l) => l.link_type && l.target_id);

  const incoming = ((incomingRes.data ?? []) as unknown as Array<{
    id: string;
    link_types: { name: string } | null;
    source_node: { id: string; display_name: string } | null;
    link_details: RawLinkDetail[] | null;
  }>)
    .map((l) => ({
      link_id: l.id,
      link_type: l.link_types?.name ?? "",
      source_display_name: l.source_node?.display_name ?? "",
      source_id: l.source_node?.id ?? "",
      link_details: flattenLinkDetails(l.link_details),
    }))
    .filter((l) => l.link_type && l.source_id);

  const omittedOutgoing = Math.max(0, outgoing.length - EXPAND_LINK_CAP);
  const omittedIncoming = Math.max(0, incoming.length - EXPAND_LINK_CAP);
  return {
    id: node.id,
    display_name: node.display_name,
    node_type: node.node_types?.name ?? "Node",
    details,
    outgoing: outgoing.slice(0, EXPAND_LINK_CAP),
    incoming: incoming.slice(0, EXPAND_LINK_CAP),
    ...(omittedOutgoing > 0 ? { omitted_outgoing: omittedOutgoing } : {}),
    ...(omittedIncoming > 0 ? { omitted_incoming: omittedIncoming } : {}),
  };
}
