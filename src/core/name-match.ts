/**
 * Name-variant detection for the /app/conflicts disambiguation feature.
 *
 * Decides whether two display names plausibly refer to the same person —
 * a full name vs. an initialized form:
 *   "Dana Okafor" ~ "Dana O."   (last name → initial)
 *   "Dana Okafor" ~ "D. Okafor" (first name → initial)
 *   "A. Lu"       ~ "A. Lu"     (exact duplicate)
 *
 * Pure + deterministic so it's unit-testable and runs the same on web + mobile.
 * Conservative by design: it anchors on at least one FULLY-matching name part,
 * so "A. V." doesn't match every two-letter person, and a differing full last
 * name ("Dana Okafor" vs "Dana Mbeki") is never a match.
 */

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
  const first = partCompat(a[0], b[0]);
  const last = partCompat(a[a.length - 1], b[b.length - 1]);
  if (!first.compat || !last.compat) return null;
  // Anchor: at least one part must be a full, equal match, so we never merge
  // two purely-initial names ("A. V." ~ "A. V." would already be "exact").
  if (!first.fullEqual && !last.fullEqual) return null;
  return "variant";
}

/** "Fullness" score — more name parts + longer parts = more complete. Used to
 *  pick which node survives a merge (keep the fuller name as the target). */
export function nameFullness(name: string): number {
  const t = tokens(name);
  return t.reduce((s, p) => s + (isInitial(p) ? 1 : 10), 0) + t.length;
}
