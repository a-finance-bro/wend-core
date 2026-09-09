/**
 * Shortest-path / connection tracing over the user's relationship graph.
 *
 * The chat agent's other tools only ever see a node's IMMEDIATE neighbours
 * (expandNode = 1 hop), so it can't answer "how are A and B connected?" when
 * the link is multi-hop (A → me → 1435 Capital → Suhani → Brearley). This
 * walks the links table undirected and returns the best chain.
 *
 * "Best" is STRENGTH-WEIGHTED, because the question behind most path queries
 * is "who can actually introduce me". Two chains of equal length are not equal
 * when one runs through somebody the user talks to weekly and the other
 * through a LinkedIn import last heard from in 2024. Each edge costs
 * 1 + 0.9 * (1 - tieStrength(person it reaches)), so a live tie costs about 1
 * and a dead one about 1.9: warmth re-ranks equal-length chains outright, and
 * a chain one hop longer can win only when it is much warmer, which is the
 * honest trade. With no interaction signal anywhere every edge costs the same
 * and this degrades to exactly the old BFS answer. Deterministic throughout:
 * the walk breaks ties by cost, then hops, then node id.
 *
 * The graph is small (a personal network — hundreds of nodes, low thousands of
 * links), so loading every node + link once and walking in memory is fine.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { selectAllRows } from "./paginate.js";
import { computeTieStrength, gatherInteractionSignals } from "./tie-strength.js";

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

/**
 * How much a dead tie costs over a live one. Below 1 keeps hop count the
 * primary signal: at 0.9 the coldest edge costs 1.9, so a chain must be
 * substantially warmer to justify each extra hop, and equal-length chains are
 * ranked purely by warmth.
 */
const WARMTH_WEIGHT = 0.9;

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
 *   - a person written long-form vs first-name + initial ("Ansh Vasani" /
 *     "Ansh V.")
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
  // First name + middle/last initial vs full ("ansh v" / "ansh vasani").
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

  // Tie strengths, for the edge weights. Fail-soft: an arm with no
  // interaction tables gets an empty map, every edge costs the same, and the
  // walk is the plain shortest path it always was.
  let strengthById = new Map<string, number>();
  try {
    const now = new Date();
    const signals = await gatherInteractionSignals(supabase, userId);
    strengthById = new Map(
      [...signals.entries()].map(([id, sig]) => [id, computeTieStrength(sig, now).score]),
    );
  } catch {
    /* no signal, uniform weights */
  }
  const edgeCost = (to: string): number =>
    1 + WARMTH_WEIGHT * (1 - (strengthById.get(to) ?? 0));

  // Uniform-cost search (Dijkstra), recording how we reached each node so we
  // can rebuild the path. `maxDepth` still bounds HOPS, so the reach of the
  // answer is unchanged from the BFS this replaces.
  const prev = new Map<string, { from: string; label: string }>();
  const cost = new Map<string, number>([[fromId, 0]]);
  const hopsTo = new Map<string, number>([[fromId, 0]]);
  const settled = new Set<string>();
  let reached = false;

  while (!reached) {
    // The graph is a personal network; a scan beats a heap at this size and
    // keeps the tie-break (cost, then hops, then id) explicit and testable.
    let cur: string | null = null;
    for (const [id, c] of cost) {
      if (settled.has(id)) continue;
      if (cur === null) {
        cur = id;
        continue;
      }
      const best = cost.get(cur)!;
      if (
        c < best ||
        (c === best &&
          (hopsTo.get(id)! < hopsTo.get(cur)! ||
            (hopsTo.get(id)! === hopsTo.get(cur)! && id < cur)))
      ) {
        cur = id;
      }
    }
    if (cur === null) break;
    if (cur === toId) {
      reached = true;
      break;
    }
    settled.add(cur);
    const curHops = hopsTo.get(cur)!;
    if (curHops >= maxDepth) continue;
    for (const edge of adj.get(cur) ?? []) {
      if (settled.has(edge.to)) continue;
      const nextCost = cost.get(cur)! + edgeCost(edge.to);
      const nextHops = curHops + 1;
      const oldCost = cost.get(edge.to);
      // Strictly better only: among equal-cost equal-hop routes the first one
      // found wins, and the scan order is deterministic, so the answer is too.
      if (
        oldCost === undefined ||
        nextCost < oldCost ||
        (nextCost === oldCost && nextHops < hopsTo.get(edge.to)!)
      ) {
        cost.set(edge.to, nextCost);
        hopsTo.set(edge.to, nextHops);
        prev.set(edge.to, { from: cur, label: edge.label });
      }
    }
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
