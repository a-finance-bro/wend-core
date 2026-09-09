/**
 * Deterministic time-expression parsing for recall queries.
 *
 * "Who did I meet in March", "who was I talking to last week", "people from
 * this summer" all carry a WINDOW, and the temporal recall lane needs that
 * window as two ISO instants. This is a small hand-written parser, not a model
 * call and not a date library: the recall path must return the same people for
 * the same question every time, and a model asked to read "last week" twice can
 * answer twice.
 *
 * Everything is computed in UTC. Interaction timestamps in the graph are stored
 * as ISO-8601 UTC strings, so a UTC window compares against them directly, and
 * the same query parsed on two machines yields the same window.
 *
 * ⚠️ MONTH NAMES ARE ALSO PEOPLE AND COMPANIES. "April Chen" is a person and
 * "March Capital" is a fund, and a parser that fires on every bare month name
 * turns both queries into date filters that hide the person being asked about.
 * A month therefore only counts when the query MARKS it as a time ("in March",
 * "since March", "last March", "March 2025"). The tests pin the misses as hard
 * as the hits, because a false window is worse than no window.
 */

export interface TimeWindow {
  /** Inclusive ISO-8601 start of the window. */
  start: string;
  /** Exclusive ISO-8601 end of the window. */
  end: string;
  /** The exact text that carried the time, so callers can strip it. */
  phrase: string;
  /** True when the phrase was open-ended ("since March"): end is `now`. */
  openEnded?: boolean;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

const DAY_MS = 86_400_000;

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

function startOfUtcDay(t: Date): Date {
  return utc(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** Monday-start week containing `t`, per ISO-8601. */
function startOfUtcWeek(t: Date): Date {
  const day = startOfUtcDay(t);
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * DAY_MS);
}

function window(start: Date, end: Date, phrase: string, openEnded?: boolean): TimeWindow {
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    phrase,
    ...(openEnded ? { openEnded: true } : {}),
  };
}

function unitMs(unit: string): number {
  if (unit.startsWith("day")) return DAY_MS;
  if (unit.startsWith("week")) return 7 * DAY_MS;
  // Months and years are calendar units; a millisecond width is only used for
  // the rolling "past N months" shape, where 30/365 days is the plain reading.
  if (unit.startsWith("month")) return 30 * DAY_MS;
  return 365 * DAY_MS;
}

/** The calendar period of `unit` that contains the instant `t`. */
function containingPeriod(t: Date, unit: string): { start: Date; end: Date } {
  if (unit.startsWith("day")) {
    const s = startOfUtcDay(t);
    return { start: s, end: new Date(s.getTime() + DAY_MS) };
  }
  if (unit.startsWith("week")) {
    const s = startOfUtcWeek(t);
    return { start: s, end: new Date(s.getTime() + 7 * DAY_MS) };
  }
  if (unit.startsWith("month")) {
    const s = utc(t.getUTCFullYear(), t.getUTCMonth(), 1);
    return { start: s, end: utc(t.getUTCFullYear(), t.getUTCMonth() + 1, 1) };
  }
  const s = utc(t.getUTCFullYear(), 0, 1);
  return { start: s, end: utc(t.getUTCFullYear() + 1, 0, 1) };
}

/**
 * Seasons, northern-meteorological: spring Mar-May, summer Jun-Aug,
 * fall Sep-Nov, winter Dec-Feb (a winter belongs to the year its December is
 * in). Coarse on purpose: "this summer" is a three-month intent, not a
 * solstice calculation.
 */
const SEASONS: Record<string, { startMonth: number }> = {
  spring: { startMonth: 2 },
  summer: { startMonth: 5 },
  fall: { startMonth: 8 },
  autumn: { startMonth: 8 },
  winter: { startMonth: 11 }, // Dec .. Feb of the next year
};

function seasonWindow(year: number, season: string): { start: Date; end: Date } {
  const s = SEASONS[season];
  // Every season is exactly three calendar months; Date.UTC rolls a month
  // index past December into the next year, which is what winter needs.
  return { start: utc(year, s.startMonth, 1), end: utc(year, s.startMonth + 3, 1) };
}

/**
 * Parse the first time expression in `query`, or null when it carries none.
 *
 * Priority runs from the most explicit shape to the least, so "last week of
 * March 2025" resolves as "March 2025" only if the "last week" shape misses
 * first, which it does not; explicitness wins ties by construction, and every
 * branch returns immediately.
 */
export function parseTimeExpression(query: string, now: Date = new Date()): TimeWindow | null {
  const q = String(query ?? "").toLowerCase();
  if (q.trim().length === 0) return null;

  // "past 30 days", "last 2 weeks", "past three months": a rolling window
  // ending now. Requires a count, which is what tells it apart from the
  // calendar "last week" below.
  {
    const m = q.match(
      /\b(?:past|last|previous)\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(days?|weeks?|months?|years?)\b/,
    );
    if (m) {
      const n = NUMBER_WORDS[m[1]] ?? Number(m[1]);
      if (Number.isFinite(n) && n > 0) {
        const start = new Date(now.getTime() - n * unitMs(m[2]));
        return window(start, now, m[0], true);
      }
    }
  }

  // "3 weeks ago", "two months ago": the calendar period containing that point.
  {
    const m = q.match(
      /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(days?|weeks?|months?|years?)\s+ago\b/,
    );
    if (m) {
      const n = NUMBER_WORDS[m[1]] ?? Number(m[1]);
      if (Number.isFinite(n) && n > 0) {
        const point = new Date(now.getTime() - n * unitMs(m[2]));
        const p = containingPeriod(point, m[2]);
        return window(p.start, p.end, m[0]);
      }
    }
  }

  // "yesterday" / "today".
  {
    const m = q.match(/\b(yesterday|today)\b/);
    if (m) {
      const today = containingPeriod(now, "day");
      if (m[1] === "today") return window(today.start, today.end, m[0]);
      return window(new Date(today.start.getTime() - DAY_MS), today.start, m[0]);
    }
  }

  // "last week" / "this month" / "last year": calendar periods.
  {
    const m = q.match(/\b(last|this|past)\s+(week|month|year)\b/);
    if (m) {
      const current = containingPeriod(now, m[2]);
      if (m[1] === "this") return window(current.start, current.end, m[0]);
      const prev = containingPeriod(new Date(current.start.getTime() - DAY_MS), m[2]);
      return window(prev.start, prev.end, m[0]);
    }
  }

  // Seasons: "this summer", "last winter", "in the fall".
  {
    const m = q.match(/\b(?:(last|this)\s+|in\s+(?:the\s+)?)(spring|summer|fall|autumn|winter)\b/);
    if (m) {
      const season = m[2];
      // The most recent one that has started (possibly in progress).
      let year = now.getUTCFullYear();
      while (seasonWindow(year, season).start > now) year -= 1;
      if (m[1] === "last") year -= 1;
      const w = seasonWindow(year, season);
      return window(w.start, w.end, m[0]);
    }
  }

  // Month with an explicit year: "March 2025". The year is the marker, so no
  // preposition is needed.
  {
    const m = q.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/,
    );
    if (m) {
      const mi = MONTHS.indexOf(m[1] as (typeof MONTHS)[number]);
      const y = Number(m[2]);
      return window(utc(y, mi, 1), utc(y, mi + 1, 1), m[0]);
    }
  }

  // Marked bare month: "in March", "since March", "last May", "back in June".
  // The marker is REQUIRED: "March Capital" and "April Chen" are entities, and
  // a parser that fires on them hides the thing being asked about.
  {
    const m = q.match(
      /\b(in|since|during|last|this|back in)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
    );
    if (m) {
      const mi = MONTHS.indexOf(m[2] as (typeof MONTHS)[number]);
      const marker = m[1];
      // The most recent occurrence that has started; "last <month>" means the
      // most recent occurrence that has fully ENDED.
      let year = now.getUTCFullYear();
      if (utc(year, mi, 1) > now) year -= 1;
      if (marker === "last" && utc(year, mi + 1, 1) > now) year -= 1;
      const start = utc(year, mi, 1);
      if (marker === "since") return window(start, now, m[0], true);
      return window(start, utc(year, mi + 1, 1), m[0]);
    }
  }

  // A bare year: "in 2024", "who did I meet 2023". Bounded to a plausible
  // range so a street number cannot become a decade filter.
  {
    const m = q.match(/\b(20[12]\d)\b/);
    if (m) {
      const y = Number(m[1]);
      return window(utc(y, 0, 1), utc(y + 1, 0, 1), m[0]);
    }
  }

  return null;
}

/**
 * The query with the matched time phrase removed, for lanes that should score
 * the remaining words. "sarah last week" searches "sarah"; a bare "last week"
 * strips to nothing and the caller browses the window instead.
 */
export function stripTimePhrase(query: string, w: TimeWindow): string {
  const idx = query.toLowerCase().indexOf(w.phrase);
  if (idx === -1) return query.trim();
  const stripped = query.slice(0, idx) + query.slice(idx + w.phrase.length);
  // Tidy the seam: a dangling preposition before the removed phrase reads as a
  // word to search for ("met with" left behind by "met with in march").
  return stripped.replace(/\s{2,}/g, " ").replace(/\s+(in|on|at|during|from|since)\s*$/i, "").trim();
}

/** True when `iso` falls inside the window. Nulls and garbage are outside. */
export function inWindow(iso: string | null | undefined, w: TimeWindow): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return t >= Date.parse(w.start) && t < Date.parse(w.end);
}
