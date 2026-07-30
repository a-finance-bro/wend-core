/**
 * Deterministic, structure-first retrieval.
 *
 * WHY THIS EXISTS. An evaluation against the founder's real real graph put
 * semantic-only recall at 5/10 rank-1 with 3 outright misses, and every failure
 * had the same shape: the question was about a RELATIONSHIP, and the answer was
 * literally an edge in the graph.
 *
 *   "my cofounder" ranked Dana Okafor nowhere in the top 8, behind NewCo, Future
 *   Founders Club and four strangers. Her node says `note: Cofounder at A14
 *   Labs`, `title: Co-Founder, Growth & Ops`, `headline: Founder @ Wend`, and
 *   there is an edge `Dana Okafor -[co_founder]-> Dana Okafor`. Embeddings could not
 *   find her because ~500 imported LinkedIn contacts also say "Co-Founder & CEO"
 *   in their title. The word is everywhere; the EDGE is unique.
 *
 *   "people who work at Acme" returned the Acme org node at 0.612 and no people
 *   at all, while Priya Raman sat one `employee` edge away.
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
  { phrases: ["co-founder", "cofounder", "co founder"], types: ["co_founder", "founder"] },
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

  // Nothing structural to do. Bail before touching the database.
  if (relations.length === 0 && !isSelf) return [];

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
        push(other, `directly linked to you: ${type.replace(/_/g, " ")}`);
      }
    }
  }

  // ── 2. "people who work at Acme": org named in the query, follow its edges ─
  //
  // Semantic search finds the ORG for these (Acme scored 0.612) and stops. The
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
  // "people who work at Acme" fails traversal because Priya Raman has
  // company="Acme" as a DETAIL and no `employee` edge to a Acme org node (the
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
        const { data } = await supabase.rpc("search_person_attributes", {
          p_keys: [...keys],
          p_value: name,
          p_user_id: userId,
          p_limit: limit,
        });
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
