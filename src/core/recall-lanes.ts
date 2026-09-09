/**
 * The two deterministic recall lanes beside keyword and vector, and the fusion
 * that combines all of them.
 *
 * GRAPH PROXIMITY. A recall answer should prefer the part of the graph the
 * user actually lives in. "Recently-interacted people" are read from whatever
 * interaction table the current arm has (relationship_status hosted,
 * source_contact_stats local and mirrored), and everyone within one or two
 * links of them gets a boost. Pure SQL plus a two-hop walk in memory, no model
 * call. It is a BOOST lane, never a source: a node that matched no content
 * lane is not an answer just for being near one, so fusion only counts
 * proximity for candidates a content lane already produced.
 *
 * TEMPORAL. When the query carries a time expression ("in March", "last
 * week"), the deterministic parser in time-expressions.ts turns it into a
 * window and this lane ranks the people with interactions inside it. It IS a
 * content lane: "who did I meet in March" has no keyword and no useful vector,
 * so the window is the whole question.
 *
 * RECIPROCAL-RANK FUSION. Lanes produce ranked lists, not comparable scores: a
 * cosine similarity, a text hit and an interaction count share no scale, which
 * is why the old merge could only concatenate. RRF scores a candidate by
 * sum(1 / (K + rank)) across every lane it appears in, which needs no score
 * calibration at all. K = 60, the standard damping constant from the original
 * Cormack/Clarke/Buettcher formulation; ties break by lane order then rank
 * then id, so the fusion is fully deterministic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { inWindow, type TimeWindow } from "./time-expressions.js";

// ── Reciprocal-rank fusion ──────────────────────────────────────────────────

export const RRF_K = 60;

export interface Lane {
  name: string;
  /** Candidate ids, best first. */
  ids: string[];
}

export interface FusedCandidate {
  id: string;
  score: number;
  /** Which lanes voted for this candidate, in lane order. */
  lanes: string[];
}

/**
 * Fuse ranked lanes. `contentLanes` define the candidate set; `boostLanes`
 * only add score to candidates that already exist. Deterministic: score desc,
 * then first-appearance (lane order, then rank), then id.
 */
export function rrfFuse(
  contentLanes: Lane[],
  boostLanes: Lane[] = [],
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate & { appearance: number }>();
  let appearance = 0;

  for (const lane of contentLanes) {
    lane.ids.forEach((id, rank) => {
      let c = byId.get(id);
      if (!c) {
        c = { id, score: 0, lanes: [], appearance: appearance++ };
        byId.set(id, c);
      }
      // A lane votes once per candidate; a duplicate id deeper in the same
      // lane must not double-count.
      if (!c.lanes.includes(lane.name)) {
        c.score += 1 / (RRF_K + rank + 1);
        c.lanes.push(lane.name);
      }
    });
  }

  for (const lane of boostLanes) {
    lane.ids.forEach((id, rank) => {
      const c = byId.get(id);
      if (!c || c.lanes.includes(lane.name)) return;
      c.score += 1 / (RRF_K + rank + 1);
      c.lanes.push(lane.name);
    });
  }

  return [...byId.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.appearance - b.appearance ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(({ id, score, lanes }) => ({ id, score, lanes }));
}

// ── Shared probing ──────────────────────────────────────────────────────────

type Rows = Array<Record<string, unknown>>;

/**
 * A lane read that cannot take the recall down. The sqlite shim answers a
 * missing table with an error VALUE, supabase-js can reject, and the unit-test
 * stubs implement only part of the builder surface and THROW on the rest; all
 * three shapes mean the same thing here: this arm does not have the signal.
 */
async function probe(run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<Rows> {
  try {
    const { data, error } = await run();
    if (error || !Array.isArray(data)) return [];
    return data as Rows;
  } catch {
    return [];
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// ── The graph-proximity lane ────────────────────────────────────────────────

/** How far back an interaction still marks somebody as "recent". */
const PROXIMITY_RECENT_DAYS = 45;
/** At most this many recent people seed the walk. */
const PROXIMITY_SEED_CAP = 25;
/** Links loaded for the two-hop walk. A personal graph sits far below this. */
const PROXIMITY_LINK_CAP = 8000;
/** Ranked ids the lane returns. */
const PROXIMITY_RESULT_CAP = 120;

/**
 * Nodes within one or two links of recently-interacted people, ranked.
 *
 * Rank order: the seeds themselves (most recent interaction first), then
 * one-hop neighbours, then two-hop, each tier ordered by the recency rank of
 * the best seed that reaches it, tie-broken by id. Everything is a plain read
 * plus set arithmetic, so the same graph state always ranks the same way.
 */
export async function proximityLane(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<Lane> {
  const cutoff = new Date(now.getTime() - PROXIMITY_RECENT_DAYS * 86_400_000).toISOString();

  const [statusRows, statRows] = await Promise.all([
    probe(() =>
      supabase
        .from("relationship_status")
        .select("node_id, last_interaction_at")
        .eq("user_id", userId)
        .gte("last_interaction_at", cutoff)
        .order("last_interaction_at", { ascending: false })
        .limit(PROXIMITY_SEED_CAP),
    ),
    probe(() =>
      supabase
        .from("source_contact_stats")
        .select("node_id, last_message_at")
        .eq("user_id", userId)
        .gte("last_message_at", cutoff)
        .order("last_message_at", { ascending: false })
        .limit(PROXIMITY_SEED_CAP),
    ),
  ]);

  // Merge the two seed sources on recency, newest first, deduped.
  const seedRecency = new Map<string, string>();
  for (const r of [...statusRows, ...statRows]) {
    const id = str(r.node_id);
    const at = str(r.last_interaction_at) ?? str(r.last_message_at);
    if (!id || !at) continue;
    const prev = seedRecency.get(id);
    if (!prev || at > prev) seedRecency.set(id, at);
  }
  const seeds = [...seedRecency.entries()]
    .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : a[0] < b[0] ? -1 : 1))
    .slice(0, PROXIMITY_SEED_CAP)
    .map(([id]) => id);
  if (seeds.length === 0) return { name: "proximity", ids: [] };

  const linkRows = await probe(() =>
    supabase
      .from("links")
      .select("source_node_id, target_node_id")
      .eq("user_id", userId)
      .limit(PROXIMITY_LINK_CAP),
  );
  const adj = new Map<string, string[]>();
  const addEdge = (a: string | null, b: string | null) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  };
  for (const l of linkRows) {
    const s = str(l.source_node_id);
    const t = str(l.target_node_id);
    addEdge(s, t);
    addEdge(t, s);
  }

  // Two-hop walk. bestSeedRank[n] = the rank of the best seed reaching n,
  // hop[n] = how many links away. Tiers: hop asc, then seed rank asc, then id.
  const hop = new Map<string, number>();
  const bestSeedRank = new Map<string, number>();
  seeds.forEach((s, rank) => {
    hop.set(s, 0);
    bestSeedRank.set(s, rank);
  });
  let frontier = seeds;
  for (let depth = 1; depth <= 2; depth++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const rank = bestSeedRank.get(cur)!;
      for (const n of adj.get(cur) ?? []) {
        if (!hop.has(n)) {
          hop.set(n, depth);
          bestSeedRank.set(n, rank);
          next.push(n);
        } else if (hop.get(n) === depth && rank < bestSeedRank.get(n)!) {
          bestSeedRank.set(n, rank);
        }
      }
    }
    frontier = next;
  }

  const ids = [...hop.keys()]
    .sort((a, b) => {
      const byHop = hop.get(a)! - hop.get(b)!;
      if (byHop !== 0) return byHop;
      const byRank = bestSeedRank.get(a)! - bestSeedRank.get(b)!;
      if (byRank !== 0) return byRank;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, PROXIMITY_RESULT_CAP);

  return { name: "proximity", ids };
}

// ── The temporal lane ───────────────────────────────────────────────────────

const TEMPORAL_ROW_CAP = 4000;
const TEMPORAL_RESULT_CAP = 120;

/**
 * People with interactions inside `window`, ranked by how much happened there
 * (event count desc), then by the latest event, then id.
 *
 * Sources, each fail-soft: typed interactions and calendar co-attendance
 * (hosted), the per-contact message stats' last-message timestamp (local and
 * mirror), and relationship_status. A person appears once however many
 * sources vouch for them.
 */
export async function temporalLane(
  supabase: SupabaseClient,
  userId: string,
  window: TimeWindow,
): Promise<Lane> {
  const [interactionRows, calendarRows, statRows, statusRows, messageRows] = await Promise.all([
    probe(() =>
      supabase
        .from("interactions")
        .select("node_id, happened_at")
        .eq("user_id", userId)
        .gte("happened_at", window.start)
        .lt("happened_at", window.end)
        .limit(TEMPORAL_ROW_CAP),
    ),
    probe(() =>
      supabase
        .from("calendar_events")
        .select("start_at, attendee_node_ids")
        .eq("user_id", userId)
        .gte("start_at", window.start)
        .lt("start_at", window.end)
        .not("attendee_node_ids", "is", null)
        .limit(TEMPORAL_ROW_CAP),
    ),
    probe(() =>
      supabase
        .from("source_contact_stats")
        .select("node_id, last_message_at")
        .eq("user_id", userId)
        .gte("last_message_at", window.start)
        .lt("last_message_at", window.end)
        .limit(TEMPORAL_ROW_CAP),
    ),
    probe(() =>
      supabase
        .from("relationship_status")
        .select("node_id, last_interaction_at")
        .eq("user_id", userId)
        .gte("last_interaction_at", window.start)
        .lt("last_interaction_at", window.end)
        .limit(TEMPORAL_ROW_CAP),
    ),
    // Local only: the raw message index. node_id is the linked sender, so the
    // owner's own lines (null) drop out on the filter.
    probe(() =>
      supabase
        .from("imported_messages")
        .select("node_id, sent_at")
        .eq("user_id", userId)
        .not("node_id", "is", null)
        .gte("sent_at", window.start)
        .lt("sent_at", window.end)
        .limit(TEMPORAL_ROW_CAP),
    ),
  ]);

  const count = new Map<string, number>();
  const latest = new Map<string, string>();
  const add = (nodeId: unknown, at: unknown) => {
    const id = str(nodeId);
    const iso = str(at);
    if (!id || !iso || !inWindow(iso, window)) return;
    count.set(id, (count.get(id) ?? 0) + 1);
    const prev = latest.get(id);
    if (!prev || iso > prev) latest.set(id, iso);
  };

  for (const r of interactionRows) add(r.node_id, r.happened_at);
  for (const r of calendarRows) {
    const attendees = Array.isArray(r.attendee_node_ids) ? r.attendee_node_ids : [];
    for (const a of attendees) add(a, r.start_at);
  }
  for (const r of statRows) add(r.node_id, r.last_message_at);
  for (const r of statusRows) add(r.node_id, r.last_interaction_at);
  for (const r of messageRows) add(r.node_id, r.sent_at);

  const ids = [...count.keys()]
    .sort((a, b) => {
      const byCount = count.get(b)! - count.get(a)!;
      if (byCount !== 0) return byCount;
      const la = latest.get(a)!;
      const lb = latest.get(b)!;
      if (la !== lb) return la > lb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, TEMPORAL_RESULT_CAP);

  return { name: "temporal", ids };
}
