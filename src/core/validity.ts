/**
 * Validity windows on facts: the one home for what "still true" means.
 *
 * A fact in Wend has two time axes and always has had. The transaction axis is
 * `created_at` / `deleted_at`: when Wend came to believe the fact and when it
 * stopped. The valid axis is `valid_from` / `valid_until`: when the fact was
 * true in the world. Migration 004 shipped the valid-time columns and nothing
 * ever wrote them; migration 190 arms them.
 *
 * Everything about windows lives here so it cannot be spelled two ways. The
 * predicate is written once and used by the writer (apply.ts), by every fact
 * reader (recall.ts#expandNode), and by the mirror arm, which means the hosted
 * graph, wend.db and a user's D1 copy cannot disagree about which value is
 * current. That is the same rule `isDeleted` in src/lib/mirror/reader.ts had to
 * learn the hard way: a guard written twice is a guard that is wrong once.
 *
 * THE FOUR STATES a detail row can be in:
 *
 *   current      deleted_at null, window open at the instant asked about.
 *   superseded   deleted_at set AND valid_until set. It was true, then it was
 *                not. The value, the window and the source all survive, and
 *                history is exactly this set.
 *   retracted    deleted_at set, valid_until null. A wrong fact somebody
 *                removed. It was never true, so no as-of read may resurrect it.
 *   scheduled    valid_until in the future. We never write one (see
 *                `normalizeEnd`), and a reader still handles it correctly.
 *
 * ⚠️ CLOSING A WINDOW ALSO TOMBSTONES, ALWAYS. `closeWindowPatch` writes both
 * columns in one patch and there is no way to write `valid_until` without
 * `deleted_at` from here. Sixty-odd readers across three surfaces already
 * filter `deleted_at is null` and none of them was written to know about a
 * window; closing without the tombstone would print the old employer beside the
 * new one on every screen in the product. The tombstone is derived from the
 * window, never the other way round.
 */

/**
 * The window-bearing columns, as any of the three databases hand them back.
 *
 * Typed `unknown` rather than `string | null` on purpose: Postgres returns a
 * timestamptz, SQLite returns TEXT, and a mirror read arrives as a bare
 * `Record<string, unknown>` off the wire. Every function here parses defensively,
 * so one predicate serves all three instead of each caller casting its way in.
 */
export interface ValidityRow {
  valid_from?: unknown;
  valid_until?: unknown;
  created_at?: unknown;
  deleted_at?: unknown;
}

/** Milliseconds since epoch, or null when the value is not a usable instant. */
function ms(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const t = new Date(trimmed).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Is this row tombstoned? `deleted_at` is a TIMESTAMP, not a boolean.
 *
 * Same trap the mirror reader documents: a `truthy` check only ever matched
 * 1 / "1" / true, so a real ISO date walked straight through every guard that
 * used one. A row is tombstoned when deleted_at is present and not empty.
 */
export function isTombstoned(row: ValidityRow): boolean {
  const v = row.deleted_at;
  return v !== null && v !== undefined && v !== "" && v !== 0 && v !== "0";
}

/** Was this value ended, as opposed to deleted for being wrong? */
export function isSuperseded(row: ValidityRow): boolean {
  return ms(row.valid_until) !== null;
}

/** A wrong fact somebody removed. Never true, so never in an as-of answer. */
export function isRetracted(row: ValidityRow): boolean {
  return isTombstoned(row) && !isSuperseded(row);
}

/**
 * The lower bound of the window, and whether the start is actually KNOWN.
 *
 * ⚠️ AN UNKNOWN START IS NOT THE BEGINNING OF TIME. Treating a null
 * `valid_from` as year zero would sort a fact we learned yesterday above one
 * the user typed themselves in May, and would answer "was this true in 2019?"
 * with a confident yes for a row that has no idea. The bound falls back to
 * `created_at`, which is the instant Wend first held the fact and the only
 * bound with evidence behind it, and `known` stays false so callers can say
 * "unknown" instead of printing a date the graph never learned.
 */
export function windowStart(row: ValidityRow): { at: number | null; known: boolean } {
  const from = ms(row.valid_from);
  if (from !== null) return { at: from, known: true };
  return { at: ms(row.created_at), known: false };
}

/**
 * Was this fact true at `at` (default: now)?
 *
 * Half-open on purpose: start <= at < end. Supersession stamps the old row's
 * `valid_until` and the new row's `valid_from` with the SAME instant, so an
 * as-of read at exactly that instant returns the new value and only the new
 * value. An overlap of one millisecond would show a person holding two jobs.
 *
 * A row with no usable lower bound at all (no valid_from, no created_at) counts
 * as started: the alternative is dropping a fact because its bookkeeping is
 * thin, and a fact with a source is worth more than a timestamp.
 */
export function heldAt(row: ValidityRow, at: number = Date.now()): boolean {
  if (isRetracted(row)) return false;
  const start = windowStart(row).at;
  if (start !== null && start > at) return false;
  const end = ms(row.valid_until);
  return end === null || end > at;
}

/**
 * The default read: what is true right now.
 *
 * Every existing reader gets this behaviour for free through the tombstone, so
 * this exists for the readers that ask explicitly and for rows written by
 * anything that ever sets a window without one.
 */
export function isCurrent(row: ValidityRow, now: number = Date.now()): boolean {
  return heldAt(row, now);
}

/** Order facts by when they started, with the unknown-start fallback applied. */
export function byWindowStart(a: ValidityRow, b: ValidityRow): number {
  const ka = windowStart(a).at ?? 0;
  const kb = windowStart(b).at ?? 0;
  return ka - kb;
}

/**
 * Normalize an end instant a caller supplied.
 *
 * ⚠️ ENDS ARE NEVER IN THE FUTURE. "She leaves at the end of the month" is a
 * schedule, and nothing in Wend sweeps a boundary: a row that quietly becomes
 * stale on a date nobody watches is worse than one that changes when somebody
 * says so, and the tombstone that keeps every legacy reader honest cannot be
 * written ahead of time either. A future instant is taken as now.
 *
 * A past instant is the normal case and is kept exactly: "she left Stripe in
 * March" is the answer the whole feature is for. It is never allowed before the
 * row's own start, because a window that ends before it begins is not a fact,
 * it is a bug with a date on it.
 *
 * ⚠️ THE FLOOR IS A KNOWN `valid_from`, NEVER THE `created_at` FALLBACK, and the
 * difference is the whole reason there are two time axes. Wend learning in
 * August that somebody left in March is the ordinary case, not a contradiction:
 * created_at is when we found out and has no authority over when the fact was
 * true. Clamping to it would silently rewrite every departure to the day it was
 * reported, which is the one date nobody asked about.
 */
export function normalizeEnd(
  input: unknown,
  row: ValidityRow = {},
  now: number = Date.now(),
): string {
  const asked = ms(input);
  const capped = asked === null || asked > now ? now : asked;
  const start = windowStart(row);
  const at = start.known && start.at !== null && capped < start.at ? start.at : capped;
  return new Date(at).toISOString();
}

/** Same rules for a start: a known start is never in the future. */
function normalizeStart(input: unknown, now: number = Date.now()): string {
  const asked = ms(input);
  const at = asked === null || asked > now ? now : asked;
  return new Date(at).toISOString();
}

/**
 * THE ONLY WAY A WINDOW CLOSES. Both columns, one patch.
 *
 * Callers pass this straight into an update. There is deliberately no variant
 * that writes `valid_until` alone: see the header.
 */
export function closeWindowPatch(at: string): {
  valid_until: string;
  deleted_at: string;
} {
  return { valid_until: at, deleted_at: at };
}

/**
 * The start stamp for the row that replaces a closed one.
 *
 * Takes the instant a caller has, normalized by the same rule ends are: a start
 * is never in the future. Callers pass the moment of the confirm today; a source
 * that genuinely knows when something began can pass that date instead and the
 * shape does not change.
 */
export function openWindowPatch(at: unknown): { valid_from: string } {
  return { valid_from: normalizeStart(at) };
}

/** One fact's window, as a reader hands it to an agent or a screen. */
export interface FactWindow {
  /** ISO instant, or null when the start was never learned. */
  from: string | null;
  /**
   * False when `from` is a fallback to when Wend first held the fact rather
   * than a start anybody recorded. Never print a date for an unknown start.
   */
  from_known: boolean;
  /** ISO instant, or null while the fact still holds. */
  until: string | null;
}

export function factWindow(row: ValidityRow): FactWindow {
  const start = windowStart(row);
  const end = ms(row.valid_until);
  return {
    from: start.at === null ? null : new Date(start.at).toISOString(),
    from_known: start.known,
    until: end === null ? null : new Date(end).toISOString(),
  };
}
