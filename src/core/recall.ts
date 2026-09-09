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
import { proximityLane, rrfFuse, temporalLane, type Lane } from "./recall-lanes.js";
import { structuredRecall, type StructuredHit } from "./structured-recall.js";
import {
  parseTimeExpression,
  stripTimePhrase,
  type TimeWindow,
} from "./time-expressions.js";
import { byWindowStart, factWindow, heldAt } from "./validity.js";

export interface RecallMatch {
  /**
   * Set on hits that came from something better than a score: a structural hit
   * carries the edge that produced it ("directly linked to you: co founder"),
   * a temporal-only hit carries the window ("interacted with you in March").
   * Absent for plain similarity and text hits.
   */
  reason?: string;
  id: string;
  display_name: string;
  node_type_name: string;
  similarity: number;
}

/** Retrieval strategy. See recallNodes for why keyword is first-class. */
export type RecallMode = "hybrid" | "semantic" | "keyword";

/**
 * What actually ran: the base strategy plus the deterministic lanes that
 * contributed to THESE matches. "hybrid+temporal+proximity" means the vector
 * and text lanes fused with an interaction-window lane and a graph-proximity
 * boost; a bare base mode means the extra lanes had nothing to add. Reported,
 * never requested: callers still ask for one of the three base modes.
 */
export type ReportedRecallMode = RecallMode | `${RecallMode}+${string}`;

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
   * caller that cannot tell will present a name-match as a semantic one. Lane
   * suffixes ("+temporal", "+proximity") appear only when that lane actually
   * contributed to the returned matches.
   */
  mode?: ReportedRecallMode;
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
   * recall on one account returned a node id owned by another user. Making this
   * a required positional means omitting it is a compile error rather than a
   * silent cross-tenant read.
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

  // The two deterministic lanes. `semantic` mode exists to measure the
  // embeddings in isolation, so it takes neither. The time window, when the
  // query carries one, also REWRITES what the content lanes search: "sarah
  // last week" should text-match "sarah", not "week", and the phrase itself
  // becomes the temporal lane's whole job.
  const window = mode === "semantic" ? null : parseTimeExpression(trimmed);
  const searchText = window ? stripTimePhrase(trimmed, window) : trimmed;

  const temporalPromise: Promise<Lane> = window
    ? temporalLane(supabase, userId, window)
    : Promise.resolve({ name: "temporal", ids: [] });
  const proximityPromise: Promise<Lane> =
    mode === "semantic"
      ? Promise.resolve({ name: "proximity", ids: [] })
      : proximityLane(supabase, userId);

  // Structure first, always (except in explicit `semantic` mode). When the
  // question is relational the graph already holds an exact answer, and an
  // exact answer should never lose to a similarity score. See
  // structured-recall.ts for the evaluation that motivated this.
  const structural =
    mode === "semantic" || searchText.length === 0
      ? []
      : await structuredRecall(supabase, userId, searchText, k);

  if (mode === "keyword") {
    const matches =
      searchText.length > 0
        ? await keywordRecall(supabase, userId, searchText, k)
        : [];
    return fuseAndFinish(supabase, userId, {
      base: "keyword",
      contentMatches: [{ name: "keyword", matches }],
      temporal: await temporalPromise,
      proximity: await proximityPromise,
      window,
      structural,
      k,
    });
  }

  const vec = searchText.length > 0 ? await embedText(searchText) : null;
  if (!vec) {
    // No vector: the provider is unconfigured, rate-limited, or had a bad
    // moment (or the query stripped to a bare time phrase, which embeds as
    // nothing). Fall back to keyword so the agent grounds its answer in real
    // nodes instead of concluding the graph is empty, and SAY it degraded so a
    // caller can tell the difference between "nothing matched" and "the
    // semantic half did not run". A pure time question is not degraded: the
    // temporal lane IS its answer.
    const matches =
      searchText.length > 0
        ? await keywordRecall(supabase, userId, searchText, k)
        : [];
    return fuseAndFinish(supabase, userId, {
      base: "keyword",
      contentMatches: [{ name: "keyword", matches }],
      temporal: await temporalPromise,
      proximity: await proximityPromise,
      window,
      structural,
      k,
      degraded: searchText.length > 0,
    });
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
  const contentMatches: Array<{ name: string; matches: RecallMatch[] }> = [
    { name: "semantic", matches },
  ];
  let degraded = false;
  if (matches.length === 0 || best < WEAK_SIMILARITY) {
    const textHits = await keywordRecall(supabase, userId, searchText, k);
    contentMatches.push({ name: "keyword", matches: textHits });
    degraded = matches.length === 0 && textHits.length > 0;
  }

  return fuseAndFinish(supabase, userId, {
    base: "hybrid",
    contentMatches,
    temporal: await temporalPromise,
    proximity: await proximityPromise,
    window,
    structural,
    k,
    degraded,
  });
}

/**
 * Fuse the ranked lanes with RRF, resolve any temporal-only candidates to real
 * nodes, put structural answers on top, and report honestly which lanes made
 * the answer.
 *
 * The temporal lane is a CONTENT lane: "who did I meet in March" has no
 * keyword and no useful vector, so the window is allowed to introduce people.
 * Proximity is a BOOST lane only: being near a recently-contacted person makes
 * a match rank higher, it never makes somebody a match by itself.
 */
async function fuseAndFinish(
  supabase: SupabaseClient,
  userId: string,
  args: {
    base: "hybrid" | "keyword";
    contentMatches: Array<{ name: string; matches: RecallMatch[] }>;
    temporal: Lane;
    proximity: Lane;
    window: TimeWindow | null;
    structural: StructuredHit[];
    k: number;
    degraded?: boolean;
  },
): Promise<RecallResult> {
  const { base, contentMatches, temporal, proximity, window, structural, k } = args;

  const matchById = new Map<string, RecallMatch>();
  for (const lane of contentMatches) {
    for (const m of lane.matches) {
      if (!matchById.has(m.id)) matchById.set(m.id, m);
    }
  }

  const contentLanes: Lane[] = contentMatches.map((l) => ({
    name: l.name,
    ids: l.matches.map((m) => m.id),
  }));
  if (window) contentLanes.push(temporal);

  const fused = rrfFuse(contentLanes, [proximity]);

  // Temporal-only candidates arrive as bare ids; give them names, and drop
  // anyone deleted or unresolvable. Read a little past k so a dropped row
  // does not shorten the answer.
  const unresolved = fused
    .filter((c) => !matchById.has(c.id))
    .slice(0, k + 8)
    .map((c) => c.id);
  if (unresolved.length > 0) {
    try {
      const { data } = await supabase
        .from("nodes")
        .select("id, display_name, node_types(name)")
        .eq("user_id", userId)
        .in("id", unresolved)
        .is("deleted_at", null);
      for (const r of (data ?? []) as unknown as Array<{
        id: string;
        display_name: string;
        node_types: { name: string } | null;
      }>) {
        if (!r?.id || matchById.has(r.id)) continue;
        matchById.set(r.id, {
          id: r.id,
          display_name: r.display_name,
          node_type_name: r.node_types?.name ?? "Node",
          similarity: 0,
          ...(window ? { reason: `interaction in the window "${window.phrase}"` } : {}),
        });
      }
    } catch {
      /* a failed name lookup costs those candidates, never the recall */
    }
  }

  const laneUse = new Map<string, string[]>();
  const ranked: RecallMatch[] = [];
  for (const c of fused) {
    const m = matchById.get(c.id);
    if (!m) continue;
    ranked.push(m);
    laneUse.set(c.id, c.lanes);
    if (ranked.length >= k) break;
  }

  const finalMatches = mergeStructural(structural, ranked, k);

  // The suffixes are earned, not asserted: a lane is reported only when a
  // returned match actually carries its vote.
  const contributed = (laneName: string) =>
    finalMatches.some((m) => (laneUse.get(m.id) ?? []).includes(laneName));
  let mode: ReportedRecallMode = base;
  if (window && contributed("temporal")) mode = `${mode}+temporal` as ReportedRecallMode;
  if (contributed("proximity")) mode = `${mode}+proximity` as ReportedRecallMode;

  return {
    ok: true,
    matches: finalMatches,
    mode,
    ...(args.degraded ? { degraded: true } : {}),
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
 *
 * Exported so the command palette can search the graph on its own SQL-only
 * path: the palette must never spend an embedding call on a keystroke, so it
 * calls this directly rather than recallNodes (which may embed in hybrid mode).
 */
export async function keywordRecall(
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
  /**
   * Values that STOPPED being true, each with the window it held and the source
   * behind it. Present only when the caller asks for history, because it is the
   * answer to a question ("when did she leave Stripe") and not context every
   * agent turn should pay for.
   */
  history?: Array<{
    name: string;
    value: string;
    /** Start of the window. Null when the graph never learned one. */
    from: string | null;
    /** False when `from` is when Wend first held the fact, not a recorded start. */
    from_known: boolean;
    /** End of the window. Always set on a history row. */
    until: string | null;
    source: { label: string; type: string } | null;
  }>;
  /**
   * How many values on this node have ended.
   *
   * Only on a read that already asked about time, because counting it otherwise
   * costs a second query on the hottest path in the product for a number nobody
   * asked for. What tells an agent history EXISTS is the capability description,
   * which is where a capability belongs: patching the answer instead of the
   * catalogue is the mistake `listCapabilities` was built to stop.
   */
  ended_values?: number;
  /** Echoed when the caller read the graph at an instant other than now. */
  as_of?: string;
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

/**
 * How to read a node's facts in time.
 *
 * ⚠️ CURRENT IS THE DEFAULT AND MUST STAY THE DEFAULT. Every caller that existed
 * before validity windows asks this function for "what is true", and answering
 * with a person's whole employment history instead would be a regression on
 * every screen and every agent turn at once.
 */
export interface ExpandOptions {
  /**
   * Read the graph as it stood at this instant (ISO). Facts that had not
   * started yet are left out, facts that had not ended yet are included.
   */
  asOf?: string | null;
  /** Also return the values that ended, each with its window and its source. */
  includeHistory?: boolean;
}

export async function expandNode(
  supabase: SupabaseClient,
  userId: string,
  nodeId: string,
  options: ExpandOptions = {},
): Promise<NodeExpansion | null> {
  // An unparseable as_of is NOT silently taken as now: an agent that asked for
  // 2019 and got today would quote today's facts as history. Invalid input
  // means the caller gets nothing back rather than a confident wrong answer.
  const asOfMs =
    options.asOf === undefined || options.asOf === null || options.asOf === ""
      ? null
      : new Date(options.asOf).getTime();
  if (asOfMs !== null && Number.isNaN(asOfMs)) return null;
  const at = asOfMs ?? Date.now();

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
        "value, user_confirmed, valid_from, valid_until, created_at, deleted_at, detail_definitions(name), sources(source_type, display_label)",
      )
      .eq("user_id", userId)
      .eq("node_id", nodeId)
      // ⚠️ KEEP THIS FILTER. Both node_details indexes are PARTIAL on
      // `deleted_at is null` (migration 004), so a read without it cannot use
      // either one and falls to a sequential scan on the hottest query in the
      // product. Ended values are fetched separately, through the window index
      // migration 190 adds, and only when somebody asks for them.
      .is("deleted_at", null),
    supabase
      .from("links")
      .select(
        "id, link_types(name), target_node:nodes!links_target_node_id_fkey(id, display_name), link_details(value, detail_definitions(name), deleted_at, valid_from, valid_until, created_at)",
      )
      .eq("user_id", userId)
      .eq("source_node_id", nodeId),
    supabase
      .from("links")
      .select(
        "id, link_types(name), source_node:nodes!links_source_node_id_fkey(id, display_name), link_details(value, detail_definitions(name), deleted_at, valid_from, valid_until, created_at)",
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
    valid_from: string | null;
    valid_until: string | null;
    created_at: string | null;
    deleted_at: string | null;
    detail_definitions: { name: string } | null;
    sources: { source_type: string; display_label: string } | null;
  }>)
    // Current by default, and at `at` when the caller named an instant. Rows
    // whose window has closed are already tombstoned by closeWindowPatch, so
    // this is belt and braces on the live read; it is load-bearing for an as-of
    // read, where a fact that had not started yet must not appear.
    .filter((d) => heldAt(d, at))
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
    valid_from: string | null;
    valid_until: string | null;
    created_at: string | null;
  };
  // A title that was superseded is tombstoned as well as closed, so the first
  // filter already hides it; `heldAt` is what makes an as-of read return the
  // role somebody held then instead of the one they hold now.
  const flattenLinkDetails = (rows: RawLinkDetail[] | null | undefined) =>
    (rows ?? [])
      .filter((d) => heldAt(d, at))
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

  // ── The values that ended ────────────────────────────────────────────
  //
  // A second read, not a widened first one, and it runs only when somebody
  // asked. It is keyed on `valid_until is not null`, which migration 190's
  // partial index covers exactly, so it walks the handful of rows that have a
  // window and never the years of merge tombstones sitting beside them.
  let history: NodeExpansion["history"];
  let endedCount = 0;
  let atInstantDetails = details;
  if (options.includeHistory || asOfMs !== null) {
    const { data: endedRows } = await supabase
      .from("node_details")
      .select(
        "value, valid_from, valid_until, created_at, deleted_at, detail_definitions(name), sources(source_type, display_label)",
      )
      .eq("user_id", userId)
      .eq("node_id", nodeId)
      .not("valid_until", "is", null);
    const ended = ((endedRows ?? []) as unknown as Array<{
      value: unknown;
      valid_from: string | null;
      valid_until: string | null;
      created_at: string | null;
      deleted_at: string | null;
      detail_definitions: { name: string } | null;
      sources: { source_type: string; display_label: string } | null;
    }>).map((d) => ({
      row: d,
      name: d.detail_definitions?.name ?? "",
      value: typeof d.value === "string" ? d.value : JSON.stringify(d.value),
      source: d.sources
        ? { label: d.sources.display_label, type: d.sources.source_type }
        : null,
    }));
    endedCount = ended.length;

    // As-of: a value that had ended by `at` is not history, it is what was true
    // then. It joins `details` rather than the history list, because the whole
    // point of the option is to hand back the graph as it stood.
    if (asOfMs !== null) {
      atInstantDetails = [
        ...details,
        ...ended
          .filter((e) => heldAt(e.row, at))
          .map((e) => ({
            name: e.name,
            value: e.value,
            source: e.source,
            confirmed: true,
          })),
      ].filter((d) => d.name.length > 0 && d.value.length > 0);
    }

    if (options.includeHistory) {
      history = ended
        .filter((e) => e.name.length > 0 && e.value.length > 0)
        // Excluded on purpose when reading as of a past instant: a fact that
        // ended after that date had not ended yet, and listing it as history
        // would answer "when did she leave" with a date from the caller's own
        // future.
        .filter((e) => asOfMs === null || !heldAt(e.row, at))
        .sort((a, b) => byWindowStart(a.row, b.row))
        .map((e) => {
          const w = factWindow(e.row);
          return {
            name: e.name,
            value: e.value,
            from: w.from,
            from_known: w.from_known,
            until: w.until,
            source: e.source,
          };
        });
    }
  }

  const omittedOutgoing = Math.max(0, outgoing.length - EXPAND_LINK_CAP);
  const omittedIncoming = Math.max(0, incoming.length - EXPAND_LINK_CAP);
  return {
    id: node.id,
    display_name: node.display_name,
    node_type: node.node_types?.name ?? "Node",
    details: atInstantDetails,
    outgoing: outgoing.slice(0, EXPAND_LINK_CAP),
    incoming: incoming.slice(0, EXPAND_LINK_CAP),
    ...(omittedOutgoing > 0 ? { omitted_outgoing: omittedOutgoing } : {}),
    ...(omittedIncoming > 0 ? { omitted_incoming: omittedIncoming } : {}),
    ...(history ? { history } : {}),
    ...(endedCount > 0 ? { ended_values: endedCount } : {}),
    ...(asOfMs !== null ? { as_of: new Date(at).toISOString() } : {}),
  };
}
