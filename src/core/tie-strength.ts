/**
 * Tie strength: how alive a relationship is, computed from data that already
 * exists. No model call, no embedding, nothing that drifts between two runs.
 *
 * THREE COMPONENTS, EACH 0..1, EACH FROM A DIFFERENT FAILURE MODE, plus a
 * fourth DAMPING factor that only bites when there is evidence for it:
 *
 *   recency      when did we last hear anything about this person. A tie that
 *                was strong in 2023 and silent since is not strong now.
 *   frequency    how often interactions happen. One long coffee a year and a
 *                weekly call are different relationships at the same recency.
 *   consistency  is the contact spread out or one burst. Forty messages in one
 *                onboarding week then nothing is a burst, not a relationship.
 *
 *   genuine ratio  of the interactions we have JUDGED (on-device, the
 *                connection-vs-coordination verdict, Class C), how many were
 *                real contact rather than logistics. A person you only ever text
 *                to coordinate — the plumber, the landlord — has heavy volume
 *                and recent contact but is not a friendship, so a low genuine
 *                ratio damps the blended score. It is NEUTRAL by construction:
 *                with nothing judged (the hosted arm has no verdicts, and a
 *                fresh local graph has none yet) the factor is 1 and the score
 *                is exactly the three-component blend it always was.
 *
 * WHERE THE SIGNALS COME FROM, and why the gatherer probes rather than joins:
 * the graph lives in three shapes (hosted Postgres, wend.db on a Mac, the D1
 * mirror) and no interaction table exists in all three. `relationship_status`
 * and `interactions` and `calendar_events` are hosted; `source_contact_stats`
 * is local and mirrors. Every read here FAILS SOFT: a missing table costs its
 * signal and nothing else, exactly like the search lanes in the engine. The
 * math is a separate pure function so the tests need no database at all.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** What we could learn about one person's interaction history. */
export interface InteractionSignal {
  nodeId: string;
  /** ISO instants of dated interaction events (messages, meetings, touches). */
  events: string[];
  /** Best-known last contact, from any source. */
  lastAt: string | null;
  /** Earliest known contact, when a source records one. */
  firstAt: string | null;
  /** Lifetime interaction volume where a source keeps a counter. */
  volume: number;
  /**
   * Interactions judged genuine contact by the on-device verdict (Class C).
   * Zero when nothing has been judged, which the score reads as "no evidence"
   * rather than "none genuine" (see judgedContacts).
   */
  genuineContacts: number;
  /** Interactions the on-device verdict has judged at all. */
  judgedContacts: number;
}

export interface TieStrength {
  nodeId: string;
  /** 0..1, the weighted blend below, damped by the genuine ratio when known. */
  score: number;
  recency: number;
  frequency: number;
  consistency: number;
  /**
   * 0..1 of judged interactions that were genuine contact, or null when nothing
   * has been judged. Null leaves `score` as the undamped three-component blend.
   */
  genuineRatio: number | null;
  lastAt: string | null;
  /** Lifetime volume: counter-based volume plus dated events. */
  pastVolume: number;
}

const DAY_MS = 86_400_000;

/** Recency half-life: sixty days of silence halves the recency component. */
const RECENCY_HALF_LIFE_DAYS = 60;

/** A weekly rhythm saturates the frequency component. */
const SATURATING_EVENTS_PER_YEAR = 52;

export function emptySignal(nodeId: string): InteractionSignal {
  return {
    nodeId,
    events: [],
    lastAt: null,
    firstAt: null,
    volume: 0,
    genuineContacts: 0,
    judgedContacts: 0,
  };
}

/**
 * How far a low genuine ratio pulls the score down. The factor runs from
 * GENUINE_FLOOR (an all-logistics tie) to 1 (all genuine), so even a pure
 * coordination contact keeps some score rather than vanishing, and a tie with
 * no verdicts at all keeps its full three-component score.
 */
const GENUINE_FLOOR = 0.4;

function daysBetween(a: number, b: number): number {
  return Math.max(0, (b - a) / DAY_MS);
}

function parseIso(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The pure math. Deterministic for a given signal and `now`; every component
 * is reported so a caller can explain WHY a score is what it is, which is the
 * difference between a ranking and a verdict.
 */
export function computeTieStrength(sig: InteractionSignal, now: Date): TieStrength {
  const nowMs = now.getTime();
  const eventTimes = sig.events
    .map((e) => parseIso(e))
    .filter((t): t is number => t !== null && t <= nowMs)
    .sort((a, b) => a - b);

  const lastKnown = Math.max(
    parseIso(sig.lastAt) ?? 0,
    eventTimes.length > 0 ? eventTimes[eventTimes.length - 1] : 0,
  );
  const firstKnown = Math.min(
    parseIso(sig.firstAt) ?? Number.POSITIVE_INFINITY,
    eventTimes.length > 0 ? eventTimes[0] : Number.POSITIVE_INFINITY,
  );

  // Recency: exponential decay from the last touch.
  const recency =
    lastKnown > 0 ? Math.pow(2, -daysBetween(lastKnown, nowMs) / RECENCY_HALF_LIFE_DAYS) : 0;

  // Frequency: events in the last year where we have dates; otherwise a rate
  // derived from a lifetime counter over its known span. Log-scaled so the
  // difference between 0 and 5 interactions matters more than 100 and 105.
  const yearAgo = nowMs - 365 * DAY_MS;
  const eventsLastYear = eventTimes.filter((t) => t >= yearAgo).length;
  let ratePerYear = eventsLastYear;
  if (ratePerYear === 0 && sig.volume > 0 && Number.isFinite(firstKnown) && lastKnown > 0) {
    const spanDays = Math.max(1, daysBetween(firstKnown, lastKnown));
    ratePerYear = Math.min(sig.volume, (sig.volume * 365) / spanDays);
  }
  const frequency = Math.min(
    1,
    Math.log1p(ratePerYear) / Math.log1p(SATURATING_EVENTS_PER_YEAR),
  );

  // Consistency: of the last twelve months, how many had at least one dated
  // event. With no dated events, a counter sustained over a long span still
  // says something: a tie that spans a year of history is not a burst.
  let consistency = 0;
  if (eventTimes.length > 0) {
    const months = new Set<number>();
    for (const t of eventTimes) {
      if (t < yearAgo) continue;
      const d = new Date(t);
      months.add(d.getUTCFullYear() * 12 + d.getUTCMonth());
    }
    consistency = Math.min(1, months.size / 12);
  } else if (sig.volume > 1 && Number.isFinite(firstKnown) && lastKnown > firstKnown) {
    consistency = Math.min(1, daysBetween(firstKnown, lastKnown) / 365) * 0.5;
  }

  const base = 0.45 * recency + 0.35 * frequency + 0.2 * consistency;

  // The fourth factor: how much of the judged contact was genuine. With nothing
  // judged the ratio is null and the factor is 1, so the score is exactly the
  // three-component blend it always was. With verdicts, an all-logistics tie is
  // pulled down to GENUINE_FLOOR of its blend.
  const genuineRatio =
    sig.judgedContacts > 0
      ? Math.max(0, Math.min(1, sig.genuineContacts / sig.judgedContacts))
      : null;
  const genuineFactor =
    genuineRatio === null ? 1 : GENUINE_FLOOR + (1 - GENUINE_FLOOR) * genuineRatio;
  const score = base * genuineFactor;

  return {
    nodeId: sig.nodeId,
    score: Number(score.toFixed(4)),
    recency: Number(recency.toFixed(4)),
    frequency: Number(frequency.toFixed(4)),
    consistency: Number(consistency.toFixed(4)),
    genuineRatio: genuineRatio === null ? null : Number(genuineRatio.toFixed(4)),
    lastAt: lastKnown > 0 ? new Date(lastKnown).toISOString() : null,
    pastVolume: sig.volume + eventTimes.length,
  };
}

// ── Dormant ties ────────────────────────────────────────────────────────────

/** Silence shorter than this is a normal gap, not dormancy. */
export const DORMANT_MIN_SILENCE_DAYS = 60;

/** Below this lifetime volume the tie was never strong enough to call dormant. */
export const DORMANT_MIN_VOLUME = 12;

/** Silence saturates the dormancy signal at about a year. */
const DORMANT_SILENCE_SATURATION_DAYS = 365;

/**
 * High past volume times long silence. Zero for anyone still in touch, anyone
 * we never really talked to, and anyone with no dated last contact at all: an
 * unknown last touch is missing data, not a year of silence.
 */
export function dormantScore(tie: TieStrength, now: Date): number {
  if (tie.pastVolume < DORMANT_MIN_VOLUME) return 0;
  const last = parseIso(tie.lastAt);
  if (last === null) return 0;
  const silenceDays = daysBetween(last, now.getTime());
  if (silenceDays < DORMANT_MIN_SILENCE_DAYS) return 0;
  const silence = Math.min(
    1,
    (silenceDays - DORMANT_MIN_SILENCE_DAYS) /
      (DORMANT_SILENCE_SATURATION_DAYS - DORMANT_MIN_SILENCE_DAYS),
  );
  const volume = Math.min(1, Math.log1p(tie.pastVolume) / Math.log1p(500));
  return Number((volume * (0.25 + 0.75 * silence)).toFixed(4));
}

// ── Gathering the signals ───────────────────────────────────────────────────

type Rows = Array<Record<string, unknown>>;

/**
 * One probe. The sqlite shim reports a missing table as an ERROR VALUE and
 * supabase-js can throw on a malformed filter, so both shapes are absorbed:
 * a signal we cannot read is a signal we do not have.
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

/** Per-source row caps, so a decade of calendar cannot stall a recall. */
const EVENT_ROW_CAP = 4000;

/**
 * Read every interaction signal the current arm can answer for `userId`.
 *
 * `userId` is a REQUIRED positional for the same reason it is on recallNodes:
 * this runs under the service-role client from the MCP route, where RLS does
 * not apply, and an unscoped read there is a cross-tenant read.
 *
 * When `nodeIds` is given, counter tables are narrowed to those people; the
 * dated-event tables are read whole (they are capped and the filter columns
 * differ per table), then trimmed here.
 *
 * ⚠️ `now` MUST be threaded through rather than read from the wall clock here.
 * The "has this calendar event happened yet" filter below used to call
 * `new Date()` directly, which is fine at the instant a caller writes that
 * code but wrong forever after: `tieStrengthsFor` and every caller above it
 * accept a `now` precisely so a planner run can be reproduced against a fixed
 * clock, and a calendar event dated after that `now` is a plan, not evidence
 * of contact, EVEN ONCE THE REAL CALENDAR CATCHES UP TO IT. Reading the real
 * clock here silently promoted every future meeting in a test fixture to a
 * past one the moment the actual date passed it — a graph-term bug with no
 * connection to timezone, that only ever looked TZ-shaped because it was
 * first noticed in a CI run pinned to TZ=UTC.
 */
export async function gatherInteractionSignals(
  supabase: SupabaseClient,
  userId: string,
  nodeIds?: string[],
  now: Date = new Date(),
): Promise<Map<string, InteractionSignal>> {
  const wanted = nodeIds && nodeIds.length > 0 ? new Set(nodeIds) : null;
  const signals = new Map<string, InteractionSignal>();
  const sig = (nodeId: string): InteractionSignal => {
    let s = signals.get(nodeId);
    if (!s) {
      s = emptySignal(nodeId);
      signals.set(nodeId, s);
    }
    return s;
  };
  const keep = (nodeId: unknown): string | null => {
    if (typeof nodeId !== "string" || nodeId.length === 0) return null;
    if (wanted && !wanted.has(nodeId)) return null;
    return nodeId;
  };

  const [statusRows, interactionRows, calendarRows, statRows, verdictRows] = await Promise.all([
    // Hosted + wherever the table exists: the "Mark contact" timestamps.
    probe(() =>
      supabase
        .from("relationship_status")
        .select("node_id, last_interaction_at")
        .eq("user_id", userId)
        .not("last_interaction_at", "is", null)
        .limit(EVENT_ROW_CAP),
    ),
    // Hosted: typed touchpoints (coffee, call, intro...).
    probe(() =>
      supabase
        .from("interactions")
        .select("node_id, happened_at")
        .eq("user_id", userId)
        .order("happened_at", { ascending: false })
        .limit(EVENT_ROW_CAP),
    ),
    // Hosted: calendar co-attendance. attendee_node_ids is matched at sync
    // time, so this is graph identity, not string comparison.
    probe(() =>
      supabase
        .from("calendar_events")
        .select("start_at, attendee_node_ids")
        .eq("user_id", userId)
        .not("attendee_node_ids", "is", null)
        .order("start_at", { ascending: false })
        .limit(EVENT_ROW_CAP),
    ),
    // Local + mirror: per-contact message stats the imports maintain.
    probe(() => {
      let q = supabase
        .from("source_contact_stats")
        .select("node_id, message_count, first_message_at, last_message_at")
        .eq("user_id", userId);
      if (wanted) q = q.in("node_id", [...wanted]);
      return q.limit(EVENT_ROW_CAP);
    }),
    // LOCAL ONLY: the on-device connection-vs-coordination verdicts (Class C).
    // Absent on the hosted arm and on a mirror, where the probe fails soft to an
    // empty read and the genuine ratio stays neutral.
    probe(() => {
      let q = supabase
        .from("keep_in_touch_verdicts")
        .select("node_id, is_genuine")
        .eq("user_id", userId);
      if (wanted) q = q.in("node_id", [...wanted]);
      return q.limit(EVENT_ROW_CAP);
    }),
  ]);

  for (const r of statusRows) {
    const nodeId = keep(r.node_id);
    if (!nodeId) continue;
    const at = typeof r.last_interaction_at === "string" ? r.last_interaction_at : null;
    if (!at) continue;
    const s = sig(nodeId);
    s.events.push(at);
    if (!s.lastAt || at > s.lastAt) s.lastAt = at;
  }

  for (const r of interactionRows) {
    const nodeId = keep(r.node_id);
    if (!nodeId) continue;
    const at = typeof r.happened_at === "string" ? r.happened_at : null;
    if (!at) continue;
    const s = sig(nodeId);
    s.events.push(at);
    if (!s.lastAt || at > s.lastAt) s.lastAt = at;
    if (!s.firstAt || at < s.firstAt) s.firstAt = at;
  }

  const nowIso = now.toISOString();
  for (const r of calendarRows) {
    const at = typeof r.start_at === "string" ? r.start_at : null;
    // A meeting on the calendar next month is a plan, not an interaction yet.
    if (!at || at > nowIso) continue;
    const attendees = Array.isArray(r.attendee_node_ids) ? r.attendee_node_ids : [];
    for (const a of attendees) {
      const nodeId = keep(a);
      if (!nodeId) continue;
      const s = sig(nodeId);
      s.events.push(at);
      if (!s.lastAt || at > s.lastAt) s.lastAt = at;
      if (!s.firstAt || at < s.firstAt) s.firstAt = at;
    }
  }

  for (const r of statRows) {
    const nodeId = keep(r.node_id);
    if (!nodeId) continue;
    const s = sig(nodeId);
    const count = typeof r.message_count === "number" ? r.message_count : Number(r.message_count) || 0;
    s.volume += Math.max(0, count);
    const last = typeof r.last_message_at === "string" ? r.last_message_at : null;
    const first = typeof r.first_message_at === "string" ? r.first_message_at : null;
    if (last && (!s.lastAt || last > s.lastAt)) s.lastAt = last;
    if (first && (!s.firstAt || first < s.firstAt)) s.firstAt = first;
  }

  for (const r of verdictRows) {
    const nodeId = keep(r.node_id);
    if (!nodeId) continue;
    const s = sig(nodeId);
    s.judgedContacts += 1;
    // The column is 0/1 (SQLite) but a truthy read is enough either way.
    const genuine = r.is_genuine === 1 || r.is_genuine === true || r.is_genuine === "1";
    if (genuine) s.genuineContacts += 1;
  }

  return signals;
}

/**
 * Strengths for a set of people in one call: gather once, compute per node.
 * People with no signal at all get the zero-signal strength rather than being
 * absent, so a caller can distinguish "weak tie" from "we forgot to ask".
 */
export async function tieStrengthsFor(
  supabase: SupabaseClient,
  userId: string,
  nodeIds: string[],
  now: Date = new Date(),
): Promise<Map<string, TieStrength>> {
  const signals = await gatherInteractionSignals(supabase, userId, nodeIds, now);
  const out = new Map<string, TieStrength>();
  for (const id of nodeIds) {
    out.set(id, computeTieStrength(signals.get(id) ?? emptySignal(id), now));
  }
  return out;
}
