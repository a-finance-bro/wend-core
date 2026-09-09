/**
 * Deterministic, structure-first retrieval.
 *
 * WHY THIS EXISTS. An evaluation against the founder's real 1,282-node graph put
 * semantic-only recall at 5/10 rank-1 with 3 outright misses, and every failure
 * had the same shape: the question was about a RELATIONSHIP, and the answer was
 * literally an edge in the graph.
 *
 *   "my cofounder" ranked Ava Yu nowhere in the top 8, behind NewCo, Future
 *   Founders Club and four strangers. Her node says `note: Cofounder at A14
 *   Labs`, `title: Co-Founder, Growth & Ops`, `headline: Founder @ Wend`, and
 *   there is an edge `Ansh Vasani -[co_founder]-> Ava Yu`. Embeddings could not
 *   find her because ~500 imported LinkedIn contacts also say "Co-Founder & CEO"
 *   in their title. The word is everywhere; the EDGE is unique.
 *
 *   "people who work at Meta" returned the Meta org node at 0.612 and no people
 *   at all, while Ami Vasani sat one `employee` edge away.
 *
 * No amount of embedding tuning fixes that, because it is not a similarity
 * problem. A vector search asks "what reads like this sentence"; the user asked
 * "who is connected to me this way". This module answers the second question
 * with SQL, and recall.ts puts its results above the semantic ones, which are
 * still what answers genuinely fuzzy questions like "who do I know in fintech".
 *
 * Everything here is deterministic: no model call, no scoring heuristic, nothing
 * that drifts when a provider changes. It either finds the edge or it does not.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseFavor,
  parseGift,
  parseLifeEvent,
  type FavorDirection,
} from "./life-facts.js";
import { ledgerRecall, matchedLedgerIntent } from "./ledger.js";

export interface StructuredHit {
  id: string;
  display_name: string;
  node_type_name: string;
  /** Plain-language explanation of the edge that produced this hit. */
  reason: string;
}

/**
 * Phrase to link-type mapping, grounded in the link types that actually carry
 * edges in production rather than invented. Longest phrases first so "works
 * with" is not eaten by "works".
 */
const RELATION_PHRASES: Array<{ phrases: string[]; types: string[] }> = [
  // co_founder is person-to-person; `founder` is person-to-ORGANIZATION.
  // Including both made "my cofounder" return FiveSight and Equibinder, the
  // companies the user founded, ranked alongside the actual cofounder.
  { phrases: ["co-founder", "cofounder", "co founder"], types: ["co_founder"] },
  { phrases: ["founded", "founder of", "started"], types: ["founder"] },
  { phrases: ["works at", "work at", "working at", "employed at", "employee of", "works for", "job at"], types: ["employee"] },
  { phrases: ["studied at", "studies at", "went to school", "attends", "student at", "alum of", "alumni of"], types: ["student", "attended"] },
  { phrases: ["advises", "advisor to", "advisor at", "advising"], types: ["advisor"] },
  { phrases: ["colleague", "coworker", "co-worker", "works with"], types: ["colleague", "employee"] },
  { phrases: ["friend"], types: ["friend"] },
  { phrases: ["met at", "met through"], types: ["met_at"] },
  { phrases: ["spoke at", "speaker at"], types: ["spoke_at"] },
  { phrases: ["member of", "belongs to"], types: ["member_of"] },
  { phrases: ["customer", "client"], types: ["customer"] },
  { phrases: ["parent", "mother", "father"], types: ["parent"] },
  { phrases: ["relative", "family", "cousin", "sibling"], types: ["relative"] },
];

/** "my", "our", "I" — the query is anchored on the user's own node. */
const SELF_REFERENCE = /\b(my|our|mine|i|me|myself)\b/i;

/** The user is asking for PEOPLE, so an organization is not the answer. */
const PERSON_SEEKING =
  /\b(who|people|person|someone|anyone|folks|contacts|everyone|employees|staff|team)\b/i;

/**
 * Industry words a user actually types, mapped to the closed vocabulary in
 * org_intel. "VC", "venture", "venture capital" are the same question.
 *
 * This is what makes "who do I know in VC" deterministic. It resolves through a
 * SQL join (people -> employer -> shared org cache), with no embedding and no
 * model call at question time, so the same question returns the same people
 * every time.
 */
const INDUSTRY_PHRASES: Array<{ phrases: string[]; industry: string }> = [
  { phrases: ["vc", "venture capital", "venture", "vcs", "investor", "investors"], industry: "venture capital" },
  { phrases: ["private equity", "pe firm", "buyout"], industry: "private equity" },
  { phrases: ["fintech", "financial technology"], industry: "fintech" },
  { phrases: ["banking", "bank", "investment banking"], industry: "banking" },
  { phrases: ["ai", "artificial intelligence", "machine learning", "ml"], industry: "artificial intelligence" },
  { phrases: ["software", "saas", "tech company"], industry: "software" },
  { phrases: ["healthcare", "health care", "medicine", "medical"], industry: "healthcare" },
  { phrases: ["biotech", "life sciences", "pharma"], industry: "biotech" },
  { phrases: ["education", "edtech", "academia", "university"], industry: "education" },
  { phrases: ["media", "journalism", "publishing"], industry: "media" },
  { phrases: ["real estate", "property"], industry: "real estate" },
  { phrases: ["legal", "law firm", "lawyer", "attorney"], industry: "legal" },
  { phrases: ["consulting", "consultant", "advisory"], industry: "consulting" },
  { phrases: ["government", "public sector", "policy"], industry: "government" },
  { phrases: ["nonprofit", "non-profit", "ngo", "charity"], industry: "nonprofit" },
  { phrases: ["energy", "climate", "cleantech", "renewables"], industry: "energy" },
  { phrases: ["recruiting", "recruiter", "talent", "headhunter"], industry: "recruiting" },
  { phrases: ["marketing", "advertising", "brand"], industry: "marketing" },
  { phrases: ["aerospace", "space", "defense"], industry: "aerospace" },
];

function matchedIndustry(query: string): string | null {
  const q = ` ${query.toLowerCase()} `;
  for (const entry of INDUSTRY_PHRASES) {
    // Word-boundary match, so "ai" does not fire on "said" and "pe" does not
    // fire on "people".
    if (entry.phrases.some((p) => new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(q))) {
      return entry.industry;
    }
  }
  return null;
}

/**
 * Relations that hold between two PEOPLE. When one of these is asked for, an
 * organization on the other end of the edge is a data error, not an answer.
 */
const PERSON_RELATIONS = new Set([
  "co_founder",
  "colleague",
  "friend",
  "parent",
  "relative",
  "knows",
]);

function matchedRelations(query: string): string[] {
  const q = query.toLowerCase();
  const types = new Set<string>();
  for (const entry of RELATION_PHRASES) {
    if (entry.phrases.some((p) => q.includes(p))) {
      for (const t of entry.types) types.add(t);
    }
  }
  return [...types];
}

interface EdgeRow {
  link_types: { name: string } | null;
  source_node: { id: string; display_name: string; node_types: { name: string } | null; deleted_at: string | null } | null;
  target_node: { id: string; display_name: string; node_types: { name: string } | null; deleted_at: string | null } | null;
}

const EDGE_SELECT =
  "link_types(name), " +
  "source_node:nodes!links_source_node_id_fkey(id, display_name, deleted_at, node_types(name)), " +
  "target_node:nodes!links_target_node_id_fkey(id, display_name, deleted_at, node_types(name))";

/**
 * Resolve the graph-shaped part of a question, if it has one.
 *
 * Returns [] whenever the query is not relational, which is the common case and
 * costs one cheap regex rather than a query.
 */
export async function structuredRecall(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  limit: number,
): Promise<StructuredHit[]> {
  const relations = matchedRelations(query);
  const isSelf = SELF_REFERENCE.test(query);
  const wantsPeople = PERSON_SEEKING.test(query);

  const industry = matchedIndustry(query);
  const lifeIntent = matchedLifeIntent(query);
  const ledgerIntent = matchedLedgerIntent(query);

  // Nothing structural to do. Bail before touching the database.
  if (relations.length === 0 && !isSelf && !industry && !lifeIntent && !ledgerIntent) return [];

  const out: StructuredHit[] = [];
  const seen = new Set<string>();
  const push = (n: EdgeRow["source_node"], reason: string) => {
    if (!n || n.deleted_at || seen.has(n.id)) return;
    seen.add(n.id);
    out.push({
      id: n.id,
      display_name: n.display_name,
      node_type_name: n.node_types?.name ?? "Node",
      reason,
    });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Typed interaction ledger (2026-08-25, Part 10, migration 24). "Who owes me
  // money", "what did I give Sarah": promoted from pipe values to structured
  // rows, so these carry an amount and a settle-state life-facts values cannot.
  // Identical SQL surface on Postgres and the SQLite shim (the org_intel
  // pattern); the read lives in src/lib/ledger/core.ts.
  //
  // It DOES NOT SHADOW the life-facts favor path: gift HISTORY (given_to /
  // received_from) has no life-facts equivalent, so that answer is the ledger's
  // alone and returns here; but a favor/money question ALSO reaches the
  // life-facts favor block below, and the two merge (a favor promoted into the
  // ledger and its still-present life-facts detail collapse to one person via
  // `seen`, so nobody is double-counted).
  // ═══════════════════════════════════════════════════════════════════════════
  if (ledgerIntent) {
    const ledgerHits = await ledgerRecall(supabase, userId, query, limit);
    if (ledgerIntent.kind === "given_to" || ledgerIntent.kind === "received_from") {
      // Gift history: the ledger is the only source, and "gifts I gave X" must
      // not fall through to gift IDEAS. Answer here.
      return ledgerHits.slice(0, limit);
    }
    for (const h of ledgerHits) {
      push(
        { id: h.id, display_name: h.display_name, node_types: { name: h.node_type_name }, deleted_at: null },
        h.reason,
      );
    }
    // Fall through: the life-facts favor block below adds any unpromoted favors.
  }
  // ═══════════════════ end ledger recall ═══════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // Personal-life recall (2026-08-21, the life-ontology pack, migration 183).
  // Favors, gift ideas, and life events are typed details with a declared value
  // format (src/lib/graph/life-facts.ts), so these questions are lookups, not
  // similarity searches. Runs FIRST because a life intent is the most specific
  // signal a query can carry, and returns through the same `push` dedupe. Kept
  // in one delimited block, helpers at the bottom of the file, to ease merging.
  // ═══════════════════════════════════════════════════════════════════════════
  if (lifeIntent) {
    const rows = await lifeDetailRows(
      supabase,
      userId,
      lifeIntent.kind === "favors"
        ? ["favor_owed"]
        : lifeIntent.kind === "gifts"
          ? ["gift_idea"]
          : ["life_event"],
    );

    if (lifeIntent.kind === "favors") {
      for (const row of rows) {
        const favor = parseFavor(row.value);
        if (favor.settled) continue;
        // A direction the query asked for excludes the OPPOSITE direction and
        // keeps direction-less free text: hiding a recorded favor because it
        // skipped the format would be the format overruling the fact.
        if (lifeIntent.direction && favor.direction && favor.direction !== lifeIntent.direction) {
          continue;
        }
        const what = favor.what.slice(0, 60);
        push(
          row.node,
          favor.direction === "owed_by_me"
            ? `you owe them: ${what}`
            : favor.direction === "owed_to_me"
              ? `they owe you: ${what}`
              : `open favor: ${what}`,
        );
        if (out.length >= limit) break;
      }
    } else if (lifeIntent.kind === "gifts") {
      const names = giftTargetNames(query);
      for (const row of rows) {
        if (
          names.length > 0 &&
          !names.some((n) => (row.node?.display_name ?? "").toLowerCase().includes(n))
        ) {
          continue;
        }
        push(row.node, `gift idea: ${parseGift(row.value).gift.slice(0, 60)}`);
        if (out.length >= limit) break;
      }
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const events = rows
        .map((row) => ({ row, event: parseLifeEvent(row.value) }))
        // "Upcoming" means a parseable date from today on. Without the word,
        // every recorded event answers, newest first, undated last.
        .filter(({ event }) => !lifeIntent.upcoming || (event.date !== null && event.date >= today))
        .sort((a, b) => {
          if (a.event.date === b.event.date) return 0;
          if (a.event.date === null) return 1;
          if (b.event.date === null) return -1;
          return lifeIntent.upcoming
            ? a.event.date < b.event.date
              ? -1
              : 1
            : a.event.date > b.event.date
              ? -1
              : 1;
        });
      for (const { row, event } of events) {
        const label =
          event.category && event.type ? `${event.category}/${event.type}` : event.raw.slice(0, 40);
        const when = event.date ? ` on ${event.date}` : "";
        const note = event.note && event.category ? `: ${event.note.slice(0, 40)}` : "";
        push(row.node, `life event ${label}${when}${note}`);
        if (out.length >= limit) break;
      }
    }

    // A life question is answered (or honestly empty) here. Falling through to
    // the relational sections would bolt strangers onto a precise answer.
    return out.slice(0, limit);
  }
  // ═══════════════════ end personal-life recall ═══════════════════

  // ── 0. "who do I know in VC": employer industry, via the shared org cache ──
  //
  // The measurement behind this: 92% of imported LinkedIn connections arrive
  // with a company and a title already, so the missing piece was never person
  // data, it was knowing that "Rednote Venture" is a venture firm. Classifying
  // 1,077 organizations answers that for 1,478 people, once, globally, instead
  // of enriching every person individually.
  if (industry) {
    const { data } = await supabase.rpc("people_in_industry", {
      p_industry: industry,
      p_user_id: userId,
      p_limit: limit,
    });
    for (const row of (data ?? []) as Array<{
      id: string;
      display_name: string;
      org_name: string;
      title: string | null;
    }>) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({
        id: row.id,
        display_name: row.display_name,
        node_type_name: "Person",
        reason: row.title
          ? `${row.title} at ${row.org_name} (${industry})`
          : `works at ${row.org_name} (${industry})`,
      });
    }
  }

  // ── 1. "my cofounder", "my advisor": traverse from the Self node ──────────
  if (isSelf && relations.length > 0) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("self_node_id")
      .eq("user_id", userId)
      .maybeSingle();
    const selfId = (prof as { self_node_id?: string } | null)?.self_node_id;
    if (selfId) {
      const { data } = await supabase
        .from("links")
        .select(EDGE_SELECT)
        .eq("user_id", userId)
        .or(`source_node_id.eq.${selfId},target_node_id.eq.${selfId}`)
        .limit(400);
      for (const row of (data ?? []) as unknown as EdgeRow[]) {
        const type = row.link_types?.name;
        if (!type || !relations.includes(type)) continue;
        // Return whichever end is not the user.
        const other = row.source_node?.id === selfId ? row.target_node : row.source_node;
        // A person-to-person relation cannot be satisfied by an organization.
        if (PERSON_RELATIONS.has(type) && (other?.node_types?.name ?? "") !== "Person") {
          continue;
        }
        push(other, `directly linked to you: ${type.replace(/_/g, " ")}`);
      }
    }
  }

  // ── 2. "people who work at Meta": org named in the query, follow its edges ─
  //
  // Semantic search finds the ORG for these (Meta scored 0.612) and stops. The
  // person the user wants is one edge away and scored nowhere, because their
  // node is mostly their own name and title.
  if (wantsPeople && out.length < limit) {
    const candidates = entityCandidates(query);

    for (const name of candidates) {
      if (out.length >= limit) break;
      const { data: orgs } = await supabase
        .from("nodes")
        .select("id, display_name, node_types(name)")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .ilike("display_name", name.replace(/[\\%_,()]/g, ""))
        .limit(3);

      for (const org of (orgs ?? []) as unknown as Array<{
        id: string;
        display_name: string;
        node_types: { name: string } | null;
      }>) {
        if ((org.node_types?.name ?? "") === "Person") continue;
        const { data } = await supabase
          .from("links")
          .select(EDGE_SELECT)
          .eq("user_id", userId)
          .or(`source_node_id.eq.${org.id},target_node_id.eq.${org.id}`)
          .limit(200);
        for (const row of (data ?? []) as unknown as EdgeRow[]) {
          const type = row.link_types?.name;
          if (!type) continue;
          // When the query named a relation, honour it; otherwise any
          // affiliation edge counts as "connected to this organization".
          if (relations.length > 0 && !relations.includes(type)) continue;
          const other = row.source_node?.id === org.id ? row.target_node : row.source_node;
          if ((other?.node_types?.name ?? "") !== "Person") continue;
          push(other, `${type.replace(/_/g, " ")} of ${org.display_name}`);
          if (out.length >= limit) break;
        }
      }
    }
  }

  // ── 3. Attribute lookup: the fact is structured, just not as an edge ──────
  //
  // "people who work at Meta" fails traversal because Ami Vasani has
  // company="Meta" as a DETAIL and no `employee` edge to a Meta org node (the
  // org-linking worker has not reached her). The fact is every bit as
  // structured as an edge: a typed key on a typed node. So match it directly.
  //
  // This generalises past employment: "who lives in San Francisco" is a
  // `location` detail, "who studied at Stanford" is a `school` detail. Exact
  // string matching on a known key, no scoring, no model.
  if (wantsPeople && out.length < limit) {
    const ATTR_KEYS: Record<string, string[]> = {
      employee: ["company", "current_company"],
      colleague: ["company", "current_company"],
      student: ["school", "education"],
      attended: ["school", "education"],
      founder: ["company", "current_company"],
    };
    const keys = new Set<string>();
    for (const rel of relations.length > 0 ? relations : ["employee"]) {
      for (const key of ATTR_KEYS[rel] ?? []) keys.add(key);
    }
    // A location word in the query means the location attribute, whatever the
    // relation vocabulary said.
    if (/\b(lives?|based|located|from)\b/i.test(query)) keys.add("location");

    if (keys.size > 0) {
      const candidates = entityCandidates(query);
      for (const name of candidates) {
        if (out.length >= limit) break;
        // Via RPC, not PostgREST: `node_details.value` is jsonb and Postgres has
        // no `jsonb ILIKE text` operator, so the obvious filter errors and the
        // caller silently sees zero rows. That is exactly how this lookup
        // appeared to "work" while finding nothing. Migration 127 unwraps the
        // scalar with #>> and indexes it with trigram.
        // Exact first, then substring. `company ILIKE '%Meta%'` also matches
        // Metabase and Metagenomi, and on prod those outranked the person who
        // actually works at Meta.
        const exact = await supabase.rpc("search_person_attributes", {
          p_keys: [...keys],
          p_value: name,
          p_user_id: userId,
          p_limit: limit,
          p_exact: true,
        });
        const data =
          (exact.data ?? []).length > 0
            ? exact.data
            : (
                await supabase.rpc("search_person_attributes", {
                  p_keys: [...keys],
                  p_value: name,
                  p_user_id: userId,
                  p_limit: limit,
                  p_exact: false,
                })
              ).data;
        for (const row of (data ?? []) as Array<{
          id: string;
          display_name: string;
          node_type_name: string;
          attribute: string;
          attribute_value: string;
        }>) {
          push(
            {
              id: row.id,
              display_name: row.display_name,
              node_types: { name: row.node_type_name },
              deleted_at: null,
            },
            `${row.attribute.replace(/_/g, " ")} is ${String(row.attribute_value).slice(0, 40)}`,
          );
          if (out.length >= limit) break;
        }
      }
    }
  }

  return out.slice(0, limit);
}

/**
 * Capitalized runs and quoted strings from the query, as candidate entity
 * names. Deliberately crude: a false positive costs one indexed lookup that
 * returns nothing, and a miss just falls through to semantic search.
 */
function entityCandidates(query: string): string[] {
  return Array.from(
    new Set(
      (query.match(/"([^"]+)"|\b([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*)*)/g) ?? [])
        .map((m) => m.replace(/"/g, "").trim())
        .filter(
          (m) =>
            m.length >= 2 &&
            !/^(I|My|Who|What|Where|The|Anyone|Someone|People|Do|Does|Is|Are)$/i.test(m),
        ),
    ),
  ).slice(0, 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// Personal-life recall helpers (2026-08-21, the life-ontology pack). Kept in
// one delimited block with the section above to ease merging.
// ═══════════════════════════════════════════════════════════════════════════

type LifeIntent =
  | { kind: "favors"; direction: FavorDirection | null }
  | { kind: "gifts" }
  | { kind: "life_events"; upcoming: boolean };

/**
 * Does the query ask a personal-life question this module can answer exactly?
 *
 * Deliberately tight, for section 0's reason: a false life match runs queries
 * AND outranks a good semantic hit. Favors additionally require a self
 * reference ("what do I owe", "who owes me"), because "owe" and "favor"
 * without one are usually idiom ("in favor of").
 */
function matchedLifeIntent(query: string): LifeIntent | null {
  const q = query.toLowerCase();

  if (/\bgift(s)?\b/.test(q) || /\bgift ideas?\b/.test(q)) {
    return { kind: "gifts" };
  }

  if (/\blife events?\b/.test(q) || /\bmilestones?\b/.test(q)) {
    return {
      kind: "life_events",
      upcoming: /\b(upcoming|coming up|soon|next|this month|this year)\b/.test(q),
    };
  }

  if ((/\bowes?\b/.test(q) || /\bowed\b/.test(q) || /\bfavou?rs?\b/.test(q)) && SELF_REFERENCE.test(query)) {
    const owedByMe = /\b(what do (i|we) owe|do i owe|i owe|i still owe)\b/.test(q);
    const owedToMe = /\b(owes? me|owed to me|who owes|owe us)\b/.test(q);
    return {
      kind: "favors",
      direction: owedByMe && !owedToMe ? "owed_by_me" : owedToMe && !owedByMe ? "owed_to_me" : null,
    };
  }

  return null;
}

/**
 * "gift ideas for Sarah": whose gifts? Capitalized runs first (the same
 * heuristic the org lookup uses), then the words after "for", because people
 * type names lowercase in a chat box and a miss here silently widens the
 * answer to everyone's gift list.
 */
function giftTargetNames(query: string): string[] {
  const caps = entityCandidates(query).map((n) => n.toLowerCase());
  if (caps.length > 0) return caps;
  const after = /\bfor\s+([a-z][\w'-]*(?:\s+[a-z][\w'-]*)?)\s*\??$/i.exec(query.trim());
  return after ? [after[1].toLowerCase()] : [];
}

interface LifeDetailRow {
  value: unknown;
  node: { id: string; display_name: string; node_types: { name: string } | null; deleted_at: string | null } | null;
}

/**
 * The live detail rows under the named definitions, joined to their nodes.
 *
 * Three flat reads rather than one join, so the identical code runs against
 * hosted Postgres and the Mac's SQLite shim. Detail definitions are per-user
 * rows (ontology-as-data), so the name lookup is tenant-scoped like every
 * other query here: the MCP route passes the service-role client, where RLS
 * does not apply.
 */
async function lifeDetailRows(
  supabase: SupabaseClient,
  userId: string,
  names: string[],
): Promise<LifeDetailRow[]> {
  const { data: defs } = await supabase
    .from("detail_definitions")
    .select("id, name")
    .eq("user_id", userId)
    .in("name", names);
  const defIds = ((defs ?? []) as Array<{ id: string }>).map((d) => d.id);
  if (defIds.length === 0) return [];

  const { data: details } = await supabase
    .from("node_details")
    .select("node_id, value, detail_definition_id")
    .eq("user_id", userId)
    .in("detail_definition_id", defIds)
    .is("deleted_at", null)
    .limit(500);
  const detailRows = (details ?? []) as Array<{ node_id: string; value: unknown }>;
  if (detailRows.length === 0) return [];

  const nodeIds = [...new Set(detailRows.map((d) => d.node_id))];
  const { data: nodes } = await supabase
    .from("nodes")
    .select("id, display_name, deleted_at, node_types(name)")
    .eq("user_id", userId)
    .in("id", nodeIds);
  const byId = new Map(
    ((nodes ?? []) as unknown as Array<NonNullable<LifeDetailRow["node"]>>).map((n) => [n.id, n]),
  );

  return detailRows.map((d) => ({ value: d.value, node: byId.get(d.node_id) ?? null }));
}
