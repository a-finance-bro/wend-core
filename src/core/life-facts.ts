/**
 * The personal-life fact vocabulary: one home for the names, the value
 * formats, and the parsers (2026-08-21, migration 183).
 *
 * WHY ONE FILE. `education_entry` taught this lesson the hard way: the same
 * detail name got two value shapes from two writers, and the materializer read
 * one lane's rows as a school named `{"school": "Stanford`. Every surface that
 * touches these eight names imports THIS file: the local seed
 * (src/lib/localdb/schema.ts) uses the description strings, the extraction
 * tool schemas and the extension prompt use LIFE_VOCABULARY_HINT, and
 * structured-recall uses the parsers. The hosted seed is SQL and cannot
 * import, so `life-facts.test.ts` reads migration 183 and fails if its
 * descriptions drift from these strings.
 *
 * Value formats are pipe-separated ("category/type | date | note") because a
 * detail value is one text column on both arms, and agents produce a flat
 * string far more reliably than JSON (the Azure schema-verbosity finding).
 * Every parser FAILS OPEN: free text that ignores the format still surfaces,
 * it just carries no date or direction semantics. A recorded fact must never
 * become unreadable because somebody typed it naturally.
 *
 * Plain data and pure functions, no imports, so the hosted app, the Mac
 * sidecar and the wend-core export share it.
 */

/** The eight seeded personal-life detail names, as a closed list. */
export const LIFE_DETAIL_NAMES = [
  "life_event",
  "how_we_met",
  "food_preference",
  "allergy",
  "gift_idea",
  "gift_given",
  "gift_received",
  "favor_owed",
] as const;

export type LifeDetailName = (typeof LIFE_DETAIL_NAMES)[number];

/**
 * The closed life_event category vocabulary. Closed for org-intel's reason:
 * open labels make "wedding" and "married" unmatchable as the same thing.
 */
export const LIFE_EVENT_CATEGORIES = {
  work: ["new_job", "promotion", "retirement"],
  home: ["moved", "bought_home"],
  family: ["engagement", "married", "child_born", "bereavement"],
} as const;

/**
 * Seed descriptions, shared byte-for-byte by the local seed and (via the
 * drift test) migration 183. They double as the agent-facing format spec:
 * detail descriptions are what schema surfaces show, so the format has to
 * live in them. No apostrophes, so the SQL needs no escaping.
 */
export const LIFE_DETAIL_DESCRIPTIONS: Record<LifeDetailName, string> = {
  life_event:
    "A dated life event for this person. Value format: category/type | date | note. Categories: work (new_job, promotion, retirement), home (moved, bought_home), family (engagement, married, child_born, bereavement). Date is ISO YYYY-MM-DD when known. One event per entry.",
  how_we_met:
    "The story of how you met this person, in a sentence or two. where_we_met holds the place; this holds the circumstances.",
  food_preference:
    "A food this person likes, avoids, or eats by rule (vegetarian, halal, no cilantro). One preference per entry.",
  allergy:
    "An allergy this person has (food, medication, environmental). One allergy per entry.",
  gift_idea: "A gift idea for this person. One idea per entry.",
  gift_given:
    "A gift you gave this person. Value format: occasion | date | gift. Date is ISO YYYY-MM-DD when known.",
  gift_received:
    "A gift this person gave you. Value format: occasion | date | gift. Date is ISO YYYY-MM-DD when known.",
  favor_owed:
    "A favor between you and this person. Value format: direction | what | status. Direction is owed_by_me or owed_to_me; status is open or settled.",
};

/**
 * One compact sentence naming the vocabulary, for the extraction tool schemas
 * and the extension system prompt. Deliberately terse: the Azure lane returns
 * EMPTY tool calls when schemas grow verbose, so the schema gets the names and
 * the prompt carries the judgement about when to use them.
 */
export const LIFE_VOCABULARY_HINT =
  "Personal life: life_event ('category/type | date | note'; categories work: new_job/promotion/retirement, home: moved/bought_home, family: engagement/married/child_born/bereavement), how_we_met (the story, not the place), food_preference, allergy, gift_idea, gift_given ('occasion | date | gift'), gift_received ('occasion | date | gift'), favor_owed ('owed_by_me or owed_to_me | what | open or settled').";

/** A detail value as stored: text locally, jsonb hosted. Coerce to one string. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function pipeSegments(value: unknown): string[] {
  return asText(value)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/** First ISO date anywhere in the value, or null. Position is not trusted. */
function findIsoDate(segments: string[]): string | null {
  for (const s of segments) {
    const m = ISO_DATE.exec(s);
    if (m) return m[0];
  }
  return null;
}

export interface ParsedLifeEvent {
  /** "work" | "home" | "family" when recognized, else null. */
  category: string | null;
  /** "married", "new_job", ... when a category/type segment parsed, else null. */
  type: string | null;
  /** ISO YYYY-MM-DD, or null when the value carries no parseable date. */
  date: string | null;
  /** Everything that was not the category/type or the date. */
  note: string | null;
  /** The stored text, untouched, for surfaces that just print it. */
  raw: string;
}

/** Parse a life_event value. Fails open: free text comes back as raw + note. */
export function parseLifeEvent(value: unknown): ParsedLifeEvent {
  const raw = asText(value).trim();
  const segments = pipeSegments(value);
  const date = findIsoDate(segments);

  let category: string | null = null;
  let type: string | null = null;
  const rest: string[] = [];
  for (const s of segments) {
    if (category === null && s.includes("/")) {
      const [c, t] = s.split("/", 2).map((p) => p.trim().toLowerCase());
      if (c in LIFE_EVENT_CATEGORIES) {
        category = c;
        type = t || null;
        continue;
      }
    }
    if (date !== null && ISO_DATE.test(s) && s.replace(ISO_DATE, "").trim() === "") continue;
    rest.push(s);
  }
  return { category, type, date, note: rest.length > 0 ? rest.join(" | ") : null, raw };
}

export type FavorDirection = "owed_by_me" | "owed_to_me";

export interface ParsedFavor {
  /** null when the value never states a direction. */
  direction: FavorDirection | null;
  /** The favor itself, with the direction and status segments stripped. */
  what: string;
  settled: boolean;
  raw: string;
}

/** Parse a favor_owed value. Free text is an OPEN favor with no direction. */
export function parseFavor(value: unknown): ParsedFavor {
  const raw = asText(value).trim();
  const segments = pipeSegments(value);
  let direction: FavorDirection | null = null;
  let settled = false;
  const rest: string[] = [];
  for (const s of segments) {
    const norm = s.toLowerCase().replace(/\s+/g, "_");
    if (norm === "owed_by_me" || norm === "i_owe" || norm === "i_owe_them") {
      direction = "owed_by_me";
    } else if (norm === "owed_to_me" || norm === "they_owe_me" || norm === "owes_me") {
      direction = "owed_to_me";
    } else if (norm === "settled" || norm === "done" || norm === "repaid") {
      settled = true;
    } else if (norm === "open" || norm === "outstanding" || norm === "unsettled") {
      settled = false;
    } else {
      rest.push(s);
    }
  }
  return { direction, what: rest.join(" | ") || raw, settled, raw };
}

export interface ParsedGift {
  occasion: string | null;
  date: string | null;
  /** The gift itself; falls back to the whole value for free text. */
  gift: string;
  raw: string;
}

/** Parse a gift_given / gift_received value ("occasion | date | gift"). */
export function parseGift(value: unknown): ParsedGift {
  const raw = asText(value).trim();
  const segments = pipeSegments(value);
  if (segments.length <= 1) return { occasion: null, date: findIsoDate(segments), gift: raw, raw };
  const date = findIsoDate(segments);
  const rest = segments.filter((s) => !(date !== null && s.replace(ISO_DATE, "").trim() === "" && ISO_DATE.test(s)));
  const occasion = rest.length > 1 ? rest[0] : null;
  const gift = rest.length > 1 ? rest.slice(1).join(" | ") : rest[0] ?? raw;
  return { occasion, date, gift, raw };
}
