import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One-line fact digests for recall matches — the "expand the hit before the
 * model sees it" step.
 *
 * Recall returns names and scores. To say anything concrete about a match, an
 * agent otherwise has to follow up with a details call per person — and every
 * one of those is a fresh model round trip that re-bills the whole system
 * prompt and tool schemas. In production that preamble measured ~14,000 input
 * tokens per iteration, against ~25 tokens to carry the same facts inline.
 *
 * So the trade is a few hundred tokens added once versus thousands saved per
 * avoided round trip, and the answer improves too: the agent can say
 * "partner at Accel, SF" instead of listing bare names.
 *
 * Deterministic by construction — a SQL read and a join, no model call.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * The fields worth a digest, in the order they read best. Deliberately short:
 * this is an identifying line, not a profile. bio/notes are excluded because
 * they are long free text and are exactly what getNodeDetails is still for.
 */
const DIGEST_FIELDS = [
  // Enrichment/chat vocabulary...
  "current_role",
  "current_company",
  "location",
  "headline",
  // ...and the names bulk importers actually write. On a graph built mostly
  // from an import, `title`/`company` outnumber the canonical `current_*`
  // names by more than an order of magnitude, so a reader that only knows the
  // canonical vocabulary produces an empty digest for almost everyone. Check
  // your own detail_definitions frequencies before trimming this list.
  "title",
  "company",
  "industry",
] as const;

/**
 * Compose the one-liner. Pure, so the field precedence is testable: the
 * enrichment vocabulary (current_role/current_company) wins where present,
 * and the importer vocabulary (title/company) carries everyone else.
 */
export function buildSummary(fields: Map<string, string>): string {
  const role =
    fields.get("current_role") ?? fields.get("title") ?? fields.get("headline");
  const company = fields.get("current_company") ?? fields.get("company");
  const parts: string[] = [];
  if (role && company) parts.push(`${role} at ${company}`);
  else if (role) parts.push(role);
  else if (company) parts.push(company);
  const place = fields.get("location") ?? fields.get("industry");
  if (place) parts.push(place);
  return parts.join(" · ").slice(0, 160);
}

export interface NodeDigest {
  /** e.g. "partner at Accel · San Francisco" */
  summary: string;
}

/**
 * Compact one-liners for a set of node ids.
 *
 * Returns a Map so callers can attach a digest without changing match order,
 * and silently returns an empty map on failure: a recall that loses its
 * digests is degraded, never broken.
 */
export async function digestForNodes(
  db: Db,
  userId: string,
  nodeIds: string[],
): Promise<Map<string, NodeDigest>> {
  const out = new Map<string, NodeDigest>();
  if (nodeIds.length === 0) return out;
  try {
    const { data } = await db
      .from("node_details")
      .select("node_id, value, detail_definitions!inner(name)")
      .eq("user_id", userId)
      .in("node_id", nodeIds.slice(0, 60))
      .in("detail_definitions.name", DIGEST_FIELDS as unknown as string[])
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(400);

    // Keep the FIRST value seen per (node, field). Rows arrive newest-first,
    // and multi-value fields (someone with three past locations) would
    // otherwise stack into a paragraph.
    const byNode = new Map<string, Map<string, string>>();
    for (const r of (data ?? []) as Array<{
      node_id: string;
      value: unknown;
      detail_definitions: { name: string } | { name: string }[];
    }>) {
      const defs = Array.isArray(r.detail_definitions)
        ? r.detail_definitions[0]
        : r.detail_definitions;
      const name = defs?.name;
      if (!name) continue;
      const raw = typeof r.value === "string" ? r.value : String(r.value ?? "");
      const value = raw.replace(/^"|"$/g, "").trim();
      if (!value) continue;
      let fields = byNode.get(r.node_id);
      if (!fields) {
        fields = new Map();
        byNode.set(r.node_id, fields);
      }
      if (!fields.has(name)) fields.set(name, value);
    }

    for (const [nodeId, fields] of byNode) {
      const summary = buildSummary(fields);
      if (summary) out.set(nodeId, { summary });
    }
  } catch {
    /* digests are an optimization; recall still works without them */
  }
  return out;
}
