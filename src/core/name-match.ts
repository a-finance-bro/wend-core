/**
 * Name-variant detection. Feeds identity arbitration (contract 033): it is
 * the only matcher, used by the hosted sweep and by the Mac screen alike.
 *
 * Decides whether two display names plausibly refer to the same person —
 * a full name vs. an initialized form, or a nicknamed first name:
 *   "Ansh Vasani" ~ "Ansh V."      (last name → initial)
 *   "Ansh Vasani" ~ "A. Vasani"    (first name → initial)
 *   "A. Lu"       ~ "A. Lu"        (exact duplicate)
 *   "Bill Smith"  ~ "William Smith" (first name → known nickname)
 *
 * Pure + deterministic so it's unit-testable and runs the same on web + mobile.
 * Conservative by design: it anchors on at least one FULLY-matching name part,
 * so "A. V." doesn't match every two-letter person, and a differing full last
 * name ("Ansh Vasani" vs "Ansh Kumar") is never a match. A nickname widens
 * the FIRST-name comparison only and is never the anchor itself (compat, not
 * fullEqual), so "Bill Smith" vs "William Jones" stays null: the surname must
 * still fully match before a nickname can raise the question.
 */

import { isNicknamePair } from "./nicknames";

export type NameMatch = "exact" | "variant" | null;

function tokens(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const isInitial = (t: string) => t.length === 1;

/** Are two single name-parts compatible, and is it a full (non-initial) match? */
function partCompat(x: string, y: string): { compat: boolean; fullEqual: boolean } {
  if (x === y) return { compat: true, fullEqual: !isInitial(x) };
  if (isInitial(x) && !isInitial(y)) return { compat: y[0] === x, fullEqual: false };
  if (isInitial(y) && !isInitial(x)) return { compat: x[0] === y, fullEqual: false };
  if (isInitial(x) && isInitial(y)) return { compat: x === y, fullEqual: false };
  return { compat: false, fullEqual: false }; // two different full words
}

export function nameMatch(aName: string, bName: string): NameMatch {
  const an = aName.trim().toLowerCase();
  const bn = bName.trim().toLowerCase();
  if (!an || !bn) return null;
  if (an === bn) return "exact";

  const a = tokens(aName);
  const b = tokens(bName);
  if (a.length === 0 || b.length === 0) return null;
  // Single-token names ("Anna") only match on exact (handled above) — too
  // little to safely disambiguate.
  if (a.length === 1 || b.length === 1) return null;

  // Compare first + last parts — the parts humans abbreviate.
  let first = partCompat(a[0], b[0]);
  // FIRST token only: a known nickname pair (bill ~ william) is compatible but
  // NEVER a full match, so it can satisfy the comparison and never the anchor.
  // The surname branch deliberately gets no nickname widening: surnames are
  // not nicknamed, and the anchor rule below leans on the last name being a
  // real full match.
  if (!first.compat && !isInitial(a[0]) && !isInitial(b[0]) && isNicknamePair(a[0], b[0])) {
    first = { compat: true, fullEqual: false };
  }
  const last = partCompat(a[a.length - 1], b[b.length - 1]);
  if (!first.compat || !last.compat) return null;
  // Anchor: at least one part must be a full, equal match, so we never merge
  // two purely-initial names ("A. V." ~ "A. V." would already be "exact").
  if (!first.fullEqual && !last.fullEqual) return null;
  // ⚠️ INTERIOR TOKENS MUST NOT DISAGREE. The anchor looks only at first + last,
  // so "National Economics Challenge" and "National Personal Finance Challenge"
  // both anchor on National…Challenge and used to match on the two shared words
  // alone — exactly the org merge prompt Ava called too aggressive. When BOTH
  // names carry middle tokens and none of them is compatible with any on the
  // other side, the names disagree about the middle and are not the same thing.
  // A one-sided middle (a dropped middle name, "Ana Vasani" ~ "Ana Kumar Vasani")
  // leaves this untouched, and an initial-of-a-middle still matches.
  const aMid = a.slice(1, -1);
  const bMid = b.slice(1, -1);
  if (aMid.length > 0 && bMid.length > 0) {
    const someCompat = aMid.some((x) =>
      bMid.some((y) => partCompat(x, y).compat || (!isInitial(x) && !isInitial(y) && isNicknamePair(x, y))),
    );
    if (!someCompat) return null;
  }
  return "variant";
}

/** "Fullness" score — more name parts + longer parts = more complete. Used to
 *  pick which node survives a merge (keep the fuller name as the target). */
export function nameFullness(name: string): number {
  const t = tokens(name);
  return t.reduce((s, p) => s + (isInitial(p) ? 1 : 10), 0) + t.length;
}
