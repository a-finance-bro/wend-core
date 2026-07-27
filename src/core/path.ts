/**
 * Shortest-path / connection tracing over the user's relationship graph.
 *
 * The chat agent's other tools only ever see a node's IMMEDIATE neighbours
 * (expandNode = 1 hop), so it can't answer "how are A and B connected?" when
 * the link is multi-hop (A → me → 1435 Capital → Suhani → Brearley). This does
 * an undirected BFS over the links table and returns the shortest chain.
 *
 * The graph is small (a personal network — hundreds of nodes, low thousands of
 * links), so loading every node + link once and walking in memory is fine.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { selectAllRows } from "./paginate.js";

export interface PathStep {
  node_id: string;
  display_name: string;
  /** Relationship label to the NEXT step (null on the final node). */
  edge_label: string | null;
}

export interface PathResult {
  found: boolean;
  steps: PathStep[];
  hops: number;
  /** True if the chain crossed a likely-duplicate ("same as") bridge. */
  usedAlias: boolean;
}

export const ALIAS_LABEL = "likely the same as";

function norm(s: string): string {
  return s.toLowerCase().replace(/[.,'"]/g, "").replace(/\s+/g, " ").trim();
}
function tokenize(s: string): string[] {
  return norm(s).split(" ").filter(Boolean);
}

/**
 * Heuristic: do two node names almost certainly refer to the same entity?
 * Catches the common duplicate-node cases without bridging unrelated people:
 *   - identical after normalization
 *   - one name is a ≥2-token prefix of the other ("1435 Capital" ⊂ "1435
 *     Capital Management")
 *   - a person written long-form vs first-name + initial ("Dana Okafor" /
 *     "Dana O.")
 */
export function namesLikelySame(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokenize(a);
  const tb = tokenize(b);
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer = ta.length <= tb.length ? tb : ta;
  // ≥2-token prefix match (orgs gaining a suffix word, etc.)
  if (shorter.length >= 2 && shorter.every((t, i) => longer[i] === t)) {
    return true;
  }
  // First name + middle/last initial vs full ("dana o" / "dana okafor").
  if (ta.length === 2 && tb.length === 2 && ta[0] === tb[0]) {
    const [, a2] = ta;
    const [, b2] = tb;
    if (a2.length === 1 && b2.startsWith(a2)) return true;
    if (b2.length === 1 && a2.startsWith(b2)) return true;
  }
  return false;
}

export async function findConnectionPath(
  supabase: SupabaseClient,
  userId: string,
  fromId: string,
  toId: string,
  maxDepth = 6,
): Promise<PathResult> {
  // Page through ALL nodes + links — a BFS on a truncated graph reports wrong
  // paths / false "no connection". (db-max-rows would otherwise cap this.)
  const [nodesRaw, linksRaw] = await Promise.all([
    selectAllRows((from, to) =>
      supabase
        .from("nodes")
        .select("id, display_name")
        .eq("user_id", userId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    selectAllRows((from, to) =>
      supabase
        .from("links")
        .select("source_node_id, target_node_id, link_types(name)")
        .eq("user_id", userId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  const nodes = nodesRaw as Array<{ id: string; display_name: string }>;
  const links = linksRaw as unknown as Array<{
    source_node_id: string;
    target_node_id: string;
    link_types: { name: string } | null;
  }>;

  const nameById = new Map(
    ((nodes ?? []) as Array<{ id: string; display_name: string }>).map((n) => [
      n.id,
      n.display_name,
    ]),
  );

  if (fromId === toId) {
    return {
      found: true,
      hops: 0,
      usedAlias: false,
      steps: [
        { node_id: fromId, display_name: nameById.get(fromId) ?? "?", edge_label: null },
      ],
    };
  }

  // Undirected adjacency list: node id → [{ to, label }].
  const adj = new Map<string, Array<{ to: string; label: string }>>();
  const addEdge = (a: string, b: string, label: string) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ to: b, label });
  };
  for (const l of (links ?? []) as Array<{
    source_node_id: string;
    target_node_id: string;
    link_types: { name?: string } | { name?: string }[] | null;
  }>) {
    const lt = Array.isArray(l.link_types) ? l.link_types[0] : l.link_types;
    const label = lt?.name ?? "linked";
    addEdge(l.source_node_id, l.target_node_id, label);
    addEdge(l.target_node_id, l.source_node_id, label);
  }

  // Bridge likely-duplicate nodes so a split entity ("1435 Capital" vs "1435
  // Capital Management") doesn't sever an otherwise-real chain. The bridge is
  // labeled so the rendered chain shows it honestly rather than pretending the
  // two are the same node.
  const entries = [...nameById.entries()];
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      if (namesLikelySame(entries[a][1], entries[b][1])) {
        addEdge(entries[a][0], entries[b][0], ALIAS_LABEL);
        addEdge(entries[b][0], entries[a][0], ALIAS_LABEL);
      }
    }
  }

  // BFS, recording how we reached each node so we can rebuild the path.
  const prev = new Map<string, { from: string; label: string }>();
  const visited = new Set<string>([fromId]);
  let frontier = [fromId];
  let depth = 0;
  let reached = false;

  while (frontier.length > 0 && depth < maxDepth && !reached) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const edge of adj.get(cur) ?? []) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        prev.set(edge.to, { from: cur, label: edge.label });
        if (edge.to === toId) {
          reached = true;
          break;
        }
        next.push(edge.to);
      }
      if (reached) break;
    }
    frontier = next;
    depth++;
  }

  if (!reached) return { found: false, steps: [], hops: 0, usedAlias: false };

  // Rebuild from toId back to fromId, then reverse.
  const back: Array<{ node: string; label: string }> = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur)!;
    back.push({ node: cur, label: p.label });
    cur = p.from;
  }
  back.push({ node: fromId, label: "" });
  back.reverse(); // fromId … toId; back[k].label is the edge INTO back[k]

  const steps: PathStep[] = back.map((b, idx) => ({
    node_id: b.node,
    display_name: nameById.get(b.node) ?? "?",
    edge_label: idx < back.length - 1 ? back[idx + 1].label : null,
  }));
  const usedAlias = steps.some((s) => s.edge_label === ALIAS_LABEL);

  return { found: true, steps, hops: steps.length - 1, usedAlias };
}
