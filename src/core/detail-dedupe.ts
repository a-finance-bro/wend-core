/**
 * Is this fact already there, written differently? The one rule, for the three
 * fact families where two spellings of one fact are routine.
 *
 * ── THE EVIDENCE ──────────────────────────────────────────────────────────
 *
 * A tester's onboarding summary showed, under EDUCATION, two checked rows from
 * one LinkedIn read of the SAME school:
 *
 *   Education   {"school":"Stanford Online High School"}   LinkedIn
 *   Education   Stanford Online High School                LinkedIn
 *
 * The commit path dedupes on the folded string (`sameValueKey` in apply.ts),
 * and those two strings differ, so both landed and both were shown. The fix is
 * not a smarter string fold: it is comparing what the values SAY, which means
 * parsing them with the one parser the format already has
 * (src/lib/enrichment/employment.ts) and comparing fields.
 *
 * ── THE EQUALITY RULE (the tight gate everything here shares) ─────────────
 *
 * Two values are ONE FACT when they parse to the same base identity (school /
 * title+company / the folded text) and no other field disagrees: each of
 * degree, field, start, end is equal after folding OR absent on one side.
 * A field that is non-empty on both sides and different is a real difference
 * ("BS" vs "MS" at the same school is two degrees, not a duplicate), and this
 * module keeps both.
 *
 * When one fact covers the other, the RICHER spelling survives and the weaker
 * is skipped or tombstoned — the exact reasoning apply.ts already wrote down
 * for location specificity: "a better spelling of the same fact, which is
 * exactly the case supersession is NOT for". Plain `deleted_at`, never a
 * validity window.
 *
 * ── SIMILAR IS A QUESTION, NEVER A MERGE ──────────────────────────────────
 *
 * `nearDupe` flags similar-but-not-equal wording (token containment / high
 * overlap) so a surface can ASK. It decides nothing: "don't silently
 * auto-resolve conflicting facts" is a HARD rule, and a merge on a similarity
 * score is that rule broken with extra steps.
 *
 * PURE. No client, no fetch, no DOM. The commit path, the preview builder, the
 * proposal janitor and the boot repair all import these same functions, which
 * is what keeps "is this a repeat" one answer product-wide.
 */

import { isPresent, parseEducation, parseRole } from "./employment.js";

export type DedupeFamily = "education" | "role" | "text";

/**
 * The detail names dedupe applies to, and nothing else.
 *
 * Deliberately short. `current_company` is an org name that materializeOrgs
 * keys on; `bio`/`notes` are append fields with their own merge; everything
 * else keeps apply.ts's plain folded-string rule. Widening this set is a
 * product decision, not a refactor.
 */
const FAMILY_BY_NAME: Record<string, DedupeFamily> = {
  education_entry: "education",
  past_role: "role",
  current_role: "role",
  honor: "text",
};

export function dedupeFamilyFor(detailName: unknown): DedupeFamily | null {
  const name = typeof detailName === "string" ? detailName.trim() : "";
  return FAMILY_BY_NAME[name] ?? null;
}

/** Case and whitespace never make two values two facts. */
function fold(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * One parsed value: the base identity plus its qualifying fields, all folded.
 *
 * `base` empty means the value did not parse to anything comparable; callers
 * fall back to the plain fold.
 */
interface Fields {
  base: string;
  rest: Record<string, string>;
}

function educationFields(value: string): Fields | null {
  const e = parseEducation(value);
  if (!e || !fold(e.school)) return null;
  return {
    base: fold(e.school),
    rest: {
      degree: fold(e.degree),
      field: fold(e.field),
      start: fold(e.start),
      // "Present", "ongoing" and an absent end are the same statement.
      end: isPresent(e.end ?? "") ? "" : fold(e.end),
    },
  };
}

function roleFields(value: string): Fields | null {
  const r = parseRole(value);
  if (!r || !fold(r.company)) return null;
  return {
    base: fold(r.company),
    rest: {
      title: fold(r.title),
      start: fold(r.start),
      end: r.current ? "" : fold(r.end),
    },
  };
}

function fieldsFor(family: DedupeFamily, value: string): Fields | null {
  if (family === "education") return educationFields(value);
  if (family === "role") return roleFields(value);
  return { base: fold(value), rest: {} };
}

/**
 * The full-tuple identity of a value, for set-keyed dedupe.
 *
 * Two values with the SAME key are the same fact stated twice (the JSON form
 * and the text form of one school land on one key). Values that differ only by
 * a missing field get DIFFERENT keys — that relation is not an equivalence, so
 * it cannot live in a key; use `compareDetailValues` for it.
 *
 * For a name outside the families this is exactly apply.ts's `sameValueKey`,
 * so nothing changes for the rest of the ontology.
 */
export function canonicalDetailKey(detailName: unknown, value: unknown): string {
  const family = dedupeFamilyFor(detailName);
  const text = String(value ?? "");
  if (!family) return fold(text);
  const f = fieldsFor(family, text);
  if (!f) return fold(text);
  const rest = Object.keys(f.rest)
    .sort()
    .filter((k) => f.rest[k])
    .map((k) => `${k}=${f.rest[k]}`)
    .join("|");
  return `${f.base}#${rest}`;
}

export type DetailComparison = "equal" | "a_covers_b" | "b_covers_a" | "different";

/**
 * The equality rule from the header, as a four-way answer.
 *
 * "a_covers_b" means b says nothing a does not already say (same base, every
 * field of b empty or equal to a's) while a carries more. Symmetric coverage
 * is "equal".
 */
export function compareDetailValues(
  detailName: unknown,
  a: unknown,
  b: unknown,
): DetailComparison {
  const family = dedupeFamilyFor(detailName);
  const ta = String(a ?? "");
  const tb = String(b ?? "");
  if (!family) return fold(ta) === fold(tb) ? "equal" : "different";
  const fa = fieldsFor(family, ta);
  const fb = fieldsFor(family, tb);
  if (!fa || !fb) return fold(ta) === fold(tb) ? "equal" : "different";
  if (fa.base !== fb.base) return "different";

  let aExtra = false;
  let bExtra = false;
  const keys = new Set([...Object.keys(fa.rest), ...Object.keys(fb.rest)]);
  for (const k of keys) {
    const va = fa.rest[k] ?? "";
    const vb = fb.rest[k] ?? "";
    if (va && vb && va !== vb) return "different";
    if (va && !vb) aExtra = true;
    if (vb && !va) bExtra = true;
  }
  if (aExtra && bExtra) {
    // Each side knows something the other does not (a has the degree, b has
    // the years). Neither spelling can replace the other without losing a
    // field, so both stand. A writer that wants one row here has to write the
    // merged value itself; this module never invents one.
    return "different";
  }
  if (aExtra) return "a_covers_b";
  if (bExtra) return "b_covers_a";
  return "equal";
}

/**
 * Which spelling survives a collapse of two EQUAL values.
 *
 * More non-empty fields wins; on a tie the education family prefers the
 * canonical JSON form (it is the shape the materializer and the web lane
 * already write); then the longer text; then `a`, so the answer is stable.
 */
export function richerDetailValue(detailName: unknown, a: string, b: string): string {
  const family = dedupeFamilyFor(detailName);
  if (family && family !== "text") {
    const fa = fieldsFor(family, a);
    const fb = fieldsFor(family, b);
    const na = fa ? Object.values(fa.rest).filter(Boolean).length : -1;
    const nb = fb ? Object.values(fb.rest).filter(Boolean).length : -1;
    if (na !== nb) return na > nb ? a : b;
    if (family === "education") {
      const ja = a.trim().startsWith("{");
      const jb = b.trim().startsWith("{");
      if (ja !== jb) return ja ? a : b;
    }
  }
  if (a.trim().length !== b.trim().length) return a.trim().length > b.trim().length ? a : b;
  return a;
}

export type FamilyDedupePlan =
  | { action: "insert" }
  | { action: "skip"; coveredBy: string }
  | { action: "replace"; retire: string[] };

/**
 * What the commit path should do with one incoming value, given the live rows
 * already on the (node, definition).
 *
 * skip     an existing row already says this (equal, or richer).
 * replace  the incoming says everything some existing rows say and more:
 *          insert it and tombstone exactly those rows.
 * insert   a genuinely new fact.
 */
export function planFamilyDedupe(
  detailName: unknown,
  existing: ReadonlyArray<{ id: string; value: unknown }>,
  incoming: string,
): FamilyDedupePlan {
  const retire: string[] = [];
  for (const row of existing) {
    const cmp = compareDetailValues(detailName, String(row.value ?? ""), incoming);
    if (cmp === "equal" || cmp === "a_covers_b") {
      return { action: "skip", coveredBy: row.id };
    }
    if (cmp === "b_covers_a") retire.push(row.id);
  }
  return retire.length > 0 ? { action: "replace", retire } : { action: "insert" };
}

export interface CollapsibleRow {
  id: string;
  value: unknown;
  created_at?: unknown;
  user_confirmed?: unknown;
}

export interface CollapsePlan {
  /** Rows to keep, in input order. */
  keep: string[];
  /** Each tombstoned row, with the surviving row it folded into. */
  tombstone: Array<{ id: string; into: string }>;
  /** Kept rows that must gain user_confirmed because a folded twin had it. */
  confirm: string[];
}

/**
 * Collapse a settled group of live rows down to its maximal spellings.
 *
 * The plan for the boot repair, and deliberately only a PLAN: the caller owns
 * the writes, the provenance and the trace. Deterministic — richest first,
 * ties broken the way `richerDetailValue` breaks them, then by created_at,
 * then id — so two runs over the same graph produce the same plan and the
 * second run over a repaired graph produces an empty one.
 *
 * A twin that was user_confirmed passes its confirmation to the survivor:
 * the person approved this fact, and the spelling collapsing is not the fact
 * changing.
 */
export function planCollapse(
  detailName: unknown,
  rows: ReadonlyArray<CollapsibleRow>,
): CollapsePlan {
  const ordered = [...rows].sort((x, y) => {
    const xv = String(x.value ?? "");
    const yv = String(y.value ?? "");
    const richer = richerDetailValue(detailName, xv, yv);
    if (richer === xv && richer !== yv) return -1;
    if (richer === yv && richer !== xv) return 1;
    const cx = String(x.created_at ?? "");
    const cy = String(y.created_at ?? "");
    if (cx !== cy) return cx < cy ? -1 : 1;
    return String(x.id) < String(y.id) ? -1 : 1;
  });

  const kept: CollapsibleRow[] = [];
  const tombstone: Array<{ id: string; into: string }> = [];
  const confirm = new Set<string>();
  for (const row of ordered) {
    const winner = kept.find((k) => {
      const cmp = compareDetailValues(detailName, String(k.value ?? ""), String(row.value ?? ""));
      return cmp === "equal" || cmp === "a_covers_b";
    });
    if (!winner) {
      kept.push(row);
      continue;
    }
    tombstone.push({ id: String(row.id), into: String(winner.id) });
    if (isConfirmed(row.user_confirmed) && !isConfirmed(winner.user_confirmed)) {
      confirm.add(String(winner.id));
      winner.user_confirmed = 1;
    }
  }

  const keepIds = new Set(kept.map((k) => String(k.id)));
  return {
    keep: rows.map((r) => String(r.id)).filter((id) => keepIds.has(id)),
    tombstone,
    confirm: [...confirm],
  };
}

/** SQLite hands back 0/1, Postgres a boolean, a mirror whatever was on the wire. */
function isConfirmed(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/* ── similar-but-not-equal: the question, never the merge ─────────────── */

/** Words that carry no identity. Kept minimal on purpose. */
const STOP_WORDS = new Set(["the", "of", "a", "an", "and", "at", "in", "for", "de"]);

function tokens(text: string): string[] {
  return fold(text)
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * Are two base strings similar enough to ASK about?
 *
 * Token-set containment where the contained side still has at least two
 * significant tokens ("University of California" inside "University of
 * California, Berkeley"), or Jaccard >= 0.6 with at least two shared tokens.
 * One shared token is never enough: "Harvard" vs "Harvard Business School"
 * is two institutions, and a false question outranks a missed one here the
 * way a false industry match does in org-intel.
 */
export function similarWording(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  if (sa.size === sb.size && [...sa].every((t) => sb.has(t))) return true;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared += 1;
  if (shared >= 2 && shared === small.size) return true; // containment
  const union = sa.size + sb.size - shared;
  return shared >= 2 && union > 0 && shared / union >= 0.6;
}

/**
 * Should a surface ask "same thing written twice?" about these two values?
 *
 * Only when the qualifying fields do NOT disagree (a shared school with two
 * different degrees is two facts, and two date ranges at one company can be
 * two stints) and the identities are similar without being equal.
 */
export function nearDupeDetailValues(detailName: unknown, a: unknown, b: unknown): boolean {
  const family = dedupeFamilyFor(detailName);
  if (!family) return false;
  const ta = String(a ?? "");
  const tb = String(b ?? "");
  const cmp = compareDetailValues(detailName, ta, tb);
  if (cmp !== "different") return false; // equal or covered: collapse, do not ask

  if (family === "text") return similarWording(ta, tb);

  const fa = fieldsFor(family, ta);
  const fb = fieldsFor(family, tb);
  if (!fa || !fb) return false;
  for (const k of new Set([...Object.keys(fa.rest), ...Object.keys(fb.rest)])) {
    const va = fa.rest[k] ?? "";
    const vb = fb.rest[k] ?? "";
    // The role families' identity words (title) are judged below; the rest
    // (degree, field, dates) must be compatible or this is two real facts.
    if (family === "role" && k === "title") continue;
    if (family === "education" && (k === "degree" || k === "field")) {
      if (va && vb && va !== vb) return false;
      continue;
    }
    if (va && vb && va !== vb) return false;
  }

  if (family === "education") {
    return fa.base !== fb.base && similarWording(fa.base, fb.base);
  }
  // role: same company with similar titles, or same title at similarly-worded
  // companies.
  const titleA = fa.rest.title ?? "";
  const titleB = fb.rest.title ?? "";
  if (fa.base === fb.base) {
    if (!titleA || !titleB) return false; // covered handled above; bare vs bare is equal
    return titleA !== titleB && similarWording(titleA, titleB);
  }
  if (titleA && titleA === titleB) return similarWording(fa.base, fb.base);
  return false;
}
