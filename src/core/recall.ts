/**
 * Recall over the user's graph — Subsystem #5.
 *
 * Three strategies, chosen per call (see `RecallMode`):
 *   - semantic: embed the query, rank by cosine similarity via the
 *     `recall_nodes` RPC (migration 010, user-scoped in 125)
 *   - keyword:  match the query's words against node names AND detail
 *     values, no embedding call
 *   - hybrid:   the default. Semantic first, supplemented with keyword hits
 *     when the top semantic score is weak or the pass came back empty
 *
 * Hybrid is the default because the two fail in opposite directions. Meaning
 * finds "investors"; exact text finds "Kalinda Panholzer". A proper name embeds
 * poorly against topical vectors, which is why a plain recall for "Professor
 * Kumar" used to return nothing for a person plainly in the graph and the agent
 * would report it had never heard of them.
 *
 * Keyword is a first-class mode rather than only a fallback, because this graph
 * is highly structured: an exact company name, email address, LinkedIn URL or tag
 * is better matched as text than by cosine distance, and costs no embedding call.
 *
 * Every result reports the mode that actually produced it. A similarity of 0
 * means "text hit", not "weak hit", and a caller unable to tell the two apart
 * will either discard good matches or present a name match as a semantic one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { embedText } from "../embed/provider.js";
import { structuredRecall, type StructuredHit } from "./structured-recall.js";

export interface RecallMatch {
  /**
   * Set only on structural hits: the edge that produced this match, in plain
   * words ("directly linked to you: co founder"). Absent for similarity hits.
   */
  reason?: string;
  id: string;
  display_name: string;
  node_type_name: string;
  similarity: number;
}

/** Retrieval strategy. See recallNodes for why keyword is first-class. */
export type RecallMode = "hybrid" | "semantic" | "keyword";

export interface RecallResult {
  ok: boolean;
  matches: RecallMatch[];
  error?: string;
  /** True when semantic search was unavailable (no key / rate limit)
   * and the matches came from plain text matching instead. */
  degraded?: boolean;
  /** How many of the matches came from an exact graph edge rather than a score. */
  structural?: number;
  /**
   * Which strategy actually produced these matches. Reported because "hybrid"
   * asked for and "keyword" delivered is a materially different answer, and a
   * caller that cannot tell will present a name-match as a semantic one.
   */
  mode?: RecallMode;
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
  /**
   * Whose graph to search. REQUIRED, and second so it cannot be forgotten.
   *
   * This function runs with a user-scoped client from the web app AND with the
   * SERVICE-ROLE client from the MCP route, where RLS does not apply. It used to
   * take no user id and lean entirely on RLS, so the MCP path ran unscoped and a
   * the caller must pass the user it has already authenticated. Making this
   * argument required means a caller that forgets the scope is a compile error
   * rather than a query with no tenant.
   */
  userId: string,
  query: string,
  topK: number = DEFAULT_TOP_K,
  /**
   * How to search. Default "hybrid" runs the vector pass and supplements it
   * with keyword hits, which is what you want for almost every real question:
   * meaning finds "investors", exact text finds "Kalinda Panholzer", and the two
   * fail in different directions.
   *
   * "keyword" is a first-class choice, not just the fallback, because this graph
   * is highly structured. An exact company name, an email address, a LinkedIn
   * URL or a tag is better served by matching text than by cosine distance, and
   * it needs no embedding call, so it is also the fast and free path.
   */
  mode: RecallMode = "hybrid",
): Promise<RecallResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: true, matches: [] };
  }

  // Clamp topK to reasonable bounds so a malformed agent call can't
  // blow up the context window.
  const k = Math.min(Math.max(1, Math.floor(topK)), 32);

  // Structure first, always (except in explicit `semantic` mode, which exists
  // to measure the embeddings in isolation). When the question is relational
  // the graph already holds an exact answer, and an exact answer should never
  // lose to a similarity score. See structured-recall.ts for the evaluation
  // that motivated this.
  const structural =
    mode === "semantic"
      ? []
      : await structuredRecall(supabase, userId, trimmed, k);

  if (mode === "keyword") {
    const matches = await keywordRecall(supabase, userId, trimmed, k);
    return {
      ok: true,
      matches: mergeStructural(structural, matches, k),
      mode: "keyword",
      ...(structural.length > 0 ? { structural: structural.length } : {}),
    };
  }

  const vec = await embedText(trimmed);
  if (!vec) {
    // No vector: the provider is unconfigured, rate-limited, or had a bad
    // moment. Fall back to keyword so the agent grounds its answer in real
    // nodes instead of concluding the graph is empty, and SAY it degraded so a
    // caller can tell the difference between "nothing matched" and "the
    // semantic half did not run".
    const matches = await keywordRecall(supabase, userId, trimmed, k);
    return {
      ok: true,
      matches: mergeStructural(structural, matches, k),
      degraded: true,
      mode: "keyword",
      ...(structural.length > 0 ? { structural: structural.length } : {}),
    };
  }

  const { data, error } = await supabase.rpc("recall_nodes", {
    query_embedding: vec,
    match_count: k,
    // recall_nodes is SECURITY DEFINER and scoped by auth.uid(), which is NULL
    // for the service-role client the MCP route uses. Without this parameter
    // (migration 125) semantic recall returned zero rows for EVERY MCP request
    // and silently fell through to text matching. It read as the embedding
    // provider's rate limit. It was not. The function ignores p_user_id whenever auth.uid() is
    // present, so an authenticated caller cannot use it to widen its scope.
    p_user_id: userId,
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
  // embedding was never generated (rate-limited at ingest, or a
  // brand-new node) is invisible here even though the provider answered THIS
  // query fine, so a plain "recallNodes('Professor Kumar')" returned [] for a person
  // who was clearly in the graph, and the agent wrongly said "you don't have
  // anything about them". When the semantic pass comes back empty OR only weakly
  // (a proper-name query embeds poorly against topical vectors), supplement with
  // the embedding-free name/text match so real name hits still surface.
  // `semantic` means semantic only: the caller explicitly does not want text
  // hits mixed in, e.g. when measuring embedding quality or when the query is
  // conceptual and a stray name match would be noise.
  if (mode === "semantic") {
    return { ok: true, matches, mode: "semantic" };
  }

  const best = matches[0]?.similarity ?? 0;
  if (matches.length === 0 || best < WEAK_SIMILARITY) {
    const textHits = await keywordRecall(supabase, userId, trimmed, k);
    const seen = new Set(matches.map((m) => m.id));
    const merged = [...matches];
    for (const t of textHits) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      merged.push(t);
      if (merged.length >= k) break;
    }
    if (merged.length > matches.length) {
      return {
        ok: true,
        matches: mergeStructural(structural, merged, k),
        degraded: matches.length === 0,
        mode: "hybrid",
        ...(structural.length > 0 ? { structural: structural.length } : {}),
      };
    }
  }

  return {
    ok: true,
    matches: mergeStructural(structural, matches, k),
    mode: "hybrid",
    ...(structural.length > 0 ? { structural: structural.length } : {}),
  };
}

/**
 * Put exact graph answers above similarity guesses.
 *
 * A structural hit came from following a real edge, so it is not "more similar",
 * it is CORRECT. It carries similarity 1 to say so, and its `reason` explains
 * which edge produced it, so an agent can tell the user "she is your cofounder"
 * rather than "she scored 0.51".
 */
function mergeStructural(
  structural: StructuredHit[],
  semantic: RecallMatch[],
  k: number,
): RecallMatch[] {
  if (structural.length === 0) return semantic.slice(0, k);
  const out: RecallMatch[] = structural.map((h) => ({
    id: h.id,
    display_name: h.display_name,
    node_type_name: h.node_type_name,
    similarity: 1,
    reason: h.reason,
  }));
  const seen = new Set(out.map((m) => m.id));
  for (const m of semantic) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length >= k) break;
  }
  return out.slice(0, k);
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
async function keywordRecall(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  k: number,
): Promise<RecallMatch[]> {
  const words = Array.from(
    new Set(
      query
        .split(/[^\p{L}\p{N}'-]+/u)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase())),
    ),
  ).slice(0, 6);
  if (words.length === 0) return [];

  const safe = (w: string) => w.replace(/[\\%_,()]/g, "");

  // Two passes, because the interesting keywords usually are NOT in the name.
  // "who works at Stripe" has Stripe in a `company` detail; "the professor at
  // Stanford" has it in a link. Searching display_name only, which is what this
  // did before, answered those with nothing and let the caller conclude the
  // graph was empty.
  const [byName, byDetail] = await Promise.all([
    supabase
      .from("nodes")
      .select("id, display_name, node_types(name)")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .or(words.map((w) => `display_name.ilike.%${safe(w)}%`).join(","))
      .limit(k),
    supabase
      .from("node_details")
      .select("node_id, nodes!inner(id, display_name, deleted_at, node_types(name))")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .or(words.map((w) => `value.ilike.%${safe(w)}%`).join(","))
      .limit(k * 3),
  ]);

  const out: RecallMatch[] = [];
  const seen = new Set<string>();

  for (const r of (byName.data ?? []) as unknown as Array<{
    id: string;
    display_name: string;
    node_types: { name: string } | null;
  }>) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    // Name hits rank above detail hits: a query naming a person almost always
    // means that person, not everyone whose bio mentions them.
    out.push({
      id: r.id,
      display_name: r.display_name,
      node_type_name: r.node_types?.name ?? "Node",
      similarity: 0,
    });
  }

  for (const r of (byDetail.data ?? []) as unknown as Array<{
    node_id: string;
    nodes: {
      id: string;
      display_name: string;
      deleted_at: string | null;
      node_types: { name: string } | null;
    } | null;
  }>) {
    const n = r.nodes;
    if (!n || n.deleted_at || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push({
      id: n.id,
      display_name: n.display_name,
      node_type_name: n.node_types?.name ?? "Node",
      similarity: 0,
    });
  }

  return out.slice(0, k);
}

/**
 * Words that carry no retrieval signal but are long enough to pass the
 * three-character filter, so they used to match half the graph. "who do I know
 * at Stripe" should search Stripe, not "know".
 */
const STOPWORDS = new Set([
  "the", "and", "who", "what", "where", "when", "which", "know", "knows",
  "any", "all", "for", "from", "with", "about", "that", "this", "they",
  "them", "was", "were", "are", "has", "have", "had", "can", "could",
  "would", "should", "did", "does", "someone", "anyone", "people", "person",
  "tell", "show", "find", "give", "list", "there",
]);


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
