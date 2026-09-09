/**
 * The shape of an employment or education fact, written and read in one place.
 *
 * ── WHY THIS MODULE EXISTS, measured rather than supposed ─────────────────
 *
 * A real cached profile (linkedin.com/in/pisanvs, 2026-08-20) holds FOUR
 * companies and one school. Three of those companies are CURRENT: their
 * `end_date` is "Present". What the graph got out of it was one organisation.
 *
 *   current_company   indies.la
 *   past_role         events & stuff at indies.la (May 2026 to Present)
 *   past_role         dev at Flyra CRM (May 2026 to Present)
 *   past_role         Lead at Stealth AI Labs (Mar 2026 to Present)
 *   past_role         Founder at [nu]motics (Apr 2023 to Mar 2026)
 *   education_summary equivalent to 4.0 GPA, Lincoln International Academy (2012–2026)
 *
 * Two defects in one reading. Only the single `current_company` reached
 * `materializeOrgs`, which reads company details and nothing else, so four of
 * this person's five organisations existed as TEXT ON A PERSON and as no node,
 * no link and no dates. And three jobs he currently holds were filed under
 * `past_role`, because the mapper wrote every experience row there whatever
 * its end date said.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────
 *
 * A role fact reads "TITLE at COMPANY (START to END)", an education fact reads
 * "DEGREE, SCHOOL (START-END)". Both halves of that contract live here: the
 * formatter the enrichment mapper writes with, and the parser the materializer
 * reads with. They were going to be written twice, in two packages, and a
 * format that is written in one place and parsed in another is a format that
 * drifts the first time either side is touched.
 *
 * ⚠️ EVERY NAME USED HERE IS ALREADY IN `ALLOWED_DETAIL_NAMES` (web.ts). A
 * name outside that set is dropped with NO error at all, so a fact under a
 * new name looks exactly like a provider that returned nothing.
 */

/** Present-tense end dates, as the providers actually spell them. */
const PRESENT = /^(present|current|now|ongoing|today)$/i;

/** One parsed role: who they were, where, and when. */
export interface RoleFact {
  /** The organisation. Never empty in a successful parse. */
  company: string;
  /** The role at that organisation, when the fact carried one. */
  title: string;
  start: string;
  end: string;
  /** True when the fact says the role has not ended. */
  current: boolean;
}

export interface EducationFact {
  /** The school. Never empty in a successful parse. */
  school: string;
  /** "BS in Computer Science", or whatever the provider wrote. */
  degree: string;
  /** Field of study, when the source separates it from the degree. */
  field: string;
  start: string;
  end: string;
}

/** Is this end date an unfinished one? An absent end date means current too. */
export function isPresent(end: string): boolean {
  const e = (end ?? "").trim();
  return e === "" || PRESENT.test(e);
}

/**
 * "Founder at Acme (Apr 2023 to Mar 2026)".
 *
 * The span is omitted rather than half-written when neither date is known: a
 * trailing "( to )" is the kind of artefact that ends up on somebody's profile
 * card.
 */
export function formatRole(r: {
  company: string;
  title?: string;
  start?: string;
  end?: string;
}): string {
  const company = (r.company ?? "").trim();
  if (!company) return "";
  const title = (r.title ?? "").trim();
  const start = (r.start ?? "").trim();
  const end = (r.end ?? "").trim();
  const span = start || end ? ` (${[start, end].filter(Boolean).join(" to ")})` : "";
  return `${title ? `${title} at ` : ""}${company}${span}`;
}

/**
 * The inverse of `formatRole`, and deliberately forgiving of what it did not
 * write: these facts also arrive from graphs enriched before this module
 * existed, and from a user typing one by hand.
 *
 * ⚠️ THE LAST " at " WINS. "Head of Engineering at Meta" and
 * "Founder at Acme at Large" both have to land on a company, and a company
 * name containing " at " is rarer than a title containing one.
 */
export function parseRole(value: string): RoleFact | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  let body = raw;
  let start = "";
  let end = "";

  // The span is always trailing and always parenthesised, so it comes off
  // first and whatever remains is title-and-company.
  const span = body.match(/\s*\(([^()]*)\)\s*$/);
  if (span) {
    body = body.slice(0, span.index).trim();
    const inner = span[1].trim();
    // "Apr 2023 to Mar 2026", "2012-2026", "2012 - 2026" or a lone date.
    const parts = inner.split(/\s+to\s+|\s*[-–—]\s*/);
    if (parts.length >= 2) {
      start = parts[0].trim();
      end = parts.slice(1).join(" ").trim();
    } else {
      start = inner;
    }
  }

  const at = body.toLowerCase().lastIndexOf(" at ");
  const title = at >= 0 ? body.slice(0, at).trim() : "";
  const company = at >= 0 ? body.slice(at + 4).trim() : body;
  if (!company) return null;

  return { company, title, start, end, current: isPresent(end) };
}

/**
 * The CANONICAL `education_entry` value: a compact JSON object.
 *
 * ⚠️ THIS FORMAT WAS ALREADY DECIDED, in the web enricher's prompt
 * (`src/lib/enrichment/web.ts`), which instructs the model to emit exactly
 * `{"school","degree","level","field","start","end"}` per school. Writing a
 * second, human-readable spelling here would have given one detail name two
 * shapes from two lanes, and `parseEducation` would silently read the web
 * lane's rows as a school literally named `{"school": "Stanford...`. The
 * one-line human summary belongs under `education_summary`, which is a
 * different name for a different job.
 *
 * Keys are emitted in the prompt's order and omitted when empty, so a value
 * stays short and two writers of the same fact produce the same string.
 */
export function formatEducation(e: {
  school: string;
  degree?: string;
  level?: string;
  field?: string;
  start?: string;
  end?: string;
}): string {
  const school = (e.school ?? "").trim();
  if (!school) return "";
  const out: Record<string, string> = { school };
  for (const k of ["degree", "level", "field", "start", "end"] as const) {
    const v = (e[k] ?? "").trim();
    if (v) out[k] = v;
  }
  return JSON.stringify(out);
}

/** The one-line human summary that goes under `education_summary`. */
export function formatEducationSummary(entries: EducationFact[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of entries) {
    const school = (e.school ?? "").trim();
    if (!school) continue;
    const degree = (e.degree ?? "").trim();
    const line = degree ? `${degree} ${school}` : school;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(line);
  }
  return parts.join("; ");
}

/**
 * The inverse of `formatEducation`, and ALSO the reader for the human spelling.
 *
 * ⚠️ IT MUST ACCEPT BOTH. The canonical value is the JSON object above, but
 * `education_summary` rows, hand-typed facts and the flat `educations_details`
 * string from Bright Data are all plain text naming a school. A parser that
 * understood only one of the two would make the materializer blind to whichever
 * lane it was not written for, which is the failure that left the graph with no
 * schools at all.
 *
 * ⚠️ THE LAST COMMA SEPARATES THE DEGREE FROM THE SCHOOL, because a degree
 * routinely contains one ("BS, Computer Science, Stanford") and a school name
 * routinely does too ("University of California, Berkeley"). Neither split is
 * right every time; the last comma is right more often, and a school that
 * loses its suffix still keys to the same organisation as long as it does so
 * consistently. A value with no comma is all school, which is what
 * `educations_details` gives us.
 */
export function parseEducation(value: string): EducationFact | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("{")) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
      const school = pick("school");
      if (school) {
        return {
          school,
          degree: pick("degree"),
          field: pick("field"),
          start: pick("start"),
          end: pick("end"),
        };
      }
    } catch {
      /* Not JSON after all; fall through and read it as text. */
    }
    return null;
  }

  let body = raw;
  let start = "";
  let end = "";

  const years = body.match(/\s*\(([^()]*)\)\s*$/);
  if (years) {
    body = body.slice(0, years.index).trim();
    const inner = years[1].trim();
    const parts = inner.split(/\s+to\s+|\s*[-–—]\s*/);
    if (parts.length >= 2) {
      start = parts[0].trim();
      end = parts.slice(1).join(" ").trim();
    } else {
      end = inner;
    }
  }

  const comma = body.lastIndexOf(",");
  const degree = comma >= 0 ? body.slice(0, comma).trim() : "";
  const school = comma >= 0 ? body.slice(comma + 1).trim() : body;
  if (!school) return null;

  return { school, degree, field: "", start, end };
}
