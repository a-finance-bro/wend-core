/**
 * The headless graph COMMIT path — the heart of Wend's governance loop.
 *
 * Extracted verbatim from src/lib/chat/actions.ts (2026-07-27) so the engine
 * is a plain module with no Next.js server-action plumbing: proposals in
 * (`pending_writes` payloads), confirmed graph rows out, provenance and
 * dedup preserved. Consumed by the chat confirm actions, the review
 * dashboard, and (as the exported open core) wend-core.
 *
 * Governance invariants enforced here, not in callers:
 *  - every committed fact carries a source (provenance) and user_confirmed
 *  - dedup at commit time (nodes fuzzy+alias, links exact, details value-set)
 *  - unknown vocabulary auto-mints per-user ontology rows (created_by_ai)
 *    instead of silently dropping facts — ontology is data, not DDL
 *  - renames preserve the old name as an alias so history keeps resolving
 *
 * ── Failure contract (REBUILD-MASTER-PLAN §4.11, atomic commits) ─────────
 *
 * Two kinds of "no" come out of an apply, and they are deliberately different:
 *
 *   A SOFT RESULT (`null` / `{ kind: "failed" }`) means THIS ROW cannot land:
 *   an unknown type, a reference to a node that does not exist, a value the
 *   row does not carry. Nothing was written for it. The caller counts it,
 *   strikes it, and carries on with the rest of the batch.
 *
 *   A THROWN `GraphWriteError` means A WRITE WAS REFUSED: an insert or update
 *   the apply had every right to make came back with an error. That is never
 *   about the row; it is the database failing under the batch, and the only
 *   honest answer is to stop, roll the batch back (confirm-core.ts does that:
 *   a real savepoint on the Mac, a compensating journal on Postgres) and say
 *   which row it stopped at. The old code discarded most of these errors and
 *   reported the row committed, which is how a node could land with half its
 *   facts missing and no record that anything went wrong.
 *
 * Every write here goes through `mustWrite`, so there is no third kind. The two
 * exceptions are named where they occur: an alias insert (an improvement to a
 * node, never a reason to lose it) and a link-type mint racing a concurrent
 * mint of the same name, which is expected to lose and re-read.
 *
 * ── The journal ──────────────────────────────────────────────────────────
 *
 * Every apply reports what it wrote into the optional `ApplyOutcome`: each
 * created row as `{ table, id }` and each patched row as `{ table, id,
 * previous }` with the prior values of exactly the columns it changed. On the
 * Mac the batch savepoint makes this redundant; on Postgres, where there is no
 * transaction across twenty PostgREST calls, it is what confirm-core unwinds
 * on a failure. Best-effort by nature, and the caller says so.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { dedupeFamilyFor, planFamilyDedupe } from "./detail-dedupe.js";
import { normalizeDetails } from "./normalize-details.js";
import {
  closeWindowPatch,
  normalizeEnd,
  openWindowPatch,
} from "./validity.js";

// The apply functions only use PostgREST query chains, so any Supabase
// client works: the cookie-authed user client (RLS) or the service-role
// client with explicit user_id filters (every query here filters).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Normalize a display name for fuzzy comparison: lowercase, trim, drop
 * common organization suffixes, collapse whitespace, strip punctuation.
 * "Fintellect, Inc." → "fintellect"; "Fintelect" → "fintelect".
 */
export function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .trim()
    // Leading article: "The Keystone School" ↔ "Keystone School".
    .replace(/^(the|a|an)\s+/i, "")
    .replace(
      /\b(inc|llc|ltd|corp|co|company|gmbh|sa|ag|plc|limited|llp)\.?\b/g,
      "",
    )
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein edit distance, capped — we only care about distances
 * up to a small threshold (typo territory). Returns the actual
 * distance when ≤ cap, otherwise cap+1.
 */
export function editDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find an existing node whose name (or alias) is a fuzzy match for
 * `displayName`. Used by applyCreateNode to absorb typos like
 * "Fintelect" → existing "Fintellect" instead of creating a duplicate.
 *
 * Match thresholds:
 *  - Exact case-insensitive match (after normalize) → always.
 *  - Edit distance ≤ 2 on names ≥ 5 characters → match.
 *  - Otherwise no match.
 */
/**
 * The ids of the user's satellite-cluster nodes, so main-graph resolution can
 * exclude them. HOSTED-SAFE: selecting `graph_layer` errors on the hosted schema
 * (no such column), and hosted has no satellite nodes anyway, so the empty set
 * is the correct answer there. Returns a plain Set; callers that never see a
 * satellite node (the common case) pay one cheap indexed query.
 */
export async function loadSatelliteNodeIds(
  supabase: Db,
  userId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("nodes")
    .select("id")
    .eq("user_id", userId)
    .eq("graph_layer", "satellite")
    .is("deleted_at", null);
  if (error) return new Set();
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
}

export async function findExistingNodeFuzzy(
  supabase: Db,
  userId: string,
  nodeTypeId: string,
  displayName: string,
): Promise<string | null> {
  const target = normalizeForMatch(displayName);
  if (!target) return null;

  // Keep satellite-cluster members OUT of the dedup candidate set. A normal
  // "John Doe" create must never collapse into a same-named Telegram/Signal
  // contact — that is exactly what the faint cross-cluster bridge exists to
  // express, and merging them here would silently pull a main-graph fact onto a
  // cluster node (HARD INVARIANT: a cluster node is NOT a main-graph node). The
  // cache path in buildConfirmCaches drops the same rows; this is the non-cache
  // twin (confirmBatch / the chat-agent confirm / the Gmail selected-rows path),
  // which the cache-path fix missed. The hosted schema has no graph_layer column
  // and PostgREST errors on an unknown column, so fall back to the layerless
  // select there — hosted has no satellite nodes, so there is nothing to drop.
  const withLayer = await supabase
    .from("nodes")
    .select("id, display_name, graph_layer")
    .eq("user_id", userId)
    .eq("node_type_id", nodeTypeId)
    .is("deleted_at", null);
  const existing = withLayer.error
    ? (
        await supabase
          .from("nodes")
          .select("id, display_name")
          .eq("user_id", userId)
          .eq("node_type_id", nodeTypeId)
          .is("deleted_at", null)
      ).data
    : withLayer.data;
  const allRows = (existing ?? []) as Array<{
    id: string;
    display_name: string;
    graph_layer?: string | null;
  }>;
  // Satellite ids, so the alias step below can drop them too: a satellite member
  // carries `also_spelled` aliases, so an alias match would otherwise resolve a
  // normal create onto a cluster node the same way a name match would. Empty on
  // hosted (no column), which is correct there — hosted has no satellite nodes.
  const satelliteIds = new Set(
    allRows.filter((r) => r.graph_layer === "satellite").map((r) => r.id),
  );
  const rows = allRows.filter((r) => r.graph_layer !== "satellite");

  // 1. Exact normalized match wins.
  for (const r of rows) {
    if (normalizeForMatch(r.display_name) === target) return r.id;
  }

  // 2. Edit distance for longer names (avoids "Bob" matching "Joe").
  if (target.length >= 5) {
    let bestId: string | null = null;
    let bestDist = 3;
    for (const r of rows) {
      const candidate = normalizeForMatch(r.display_name);
      if (candidate.length < 5) continue;
      const d = editDistance(target, candidate, 2);
      if (d <= 2 && d < bestDist) {
        bestDist = d;
        bestId = r.id;
      }
    }
    if (bestId) return bestId;
  }

  // 3. Aliases — covers nicknames and prior typos the user has saved
  //    against an existing node.
  // The column is alias_text, not alias. Selecting a column that does not
  // exist made PostgREST reject the whole query, and the discarded error left
  // aliasHits null — so this entire step was dead and every saved nickname
  // still minted a duplicate person. Bind the error so the next typo is loud.
  const { data: aliasHits, error: aliasErr } = await supabase
    .from("node_aliases")
    .select("node_id, alias_text, nodes!inner(node_type_id)")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .eq("nodes.node_type_id", nodeTypeId);
  if (aliasErr) {
    // eslint-disable-next-line no-console
    console.error("[findExistingNodeFuzzy] alias lookup failed:", aliasErr.message);
  }
  const aliases = (aliasHits ?? []) as Array<{
    node_id: string;
    alias_text: string;
  }>;
  for (const a of aliases) {
    if (satelliteIds.has(a.node_id)) continue;
    if (normalizeForMatch(a.alias_text) === target) return a.node_id;
    if (target.length >= 5) {
      const d = editDistance(target, normalizeForMatch(a.alias_text), 2);
      if (d <= 2) return a.node_id;
    }
  }

  return null;
}

/**
 * Did an apply CREATE the thing, or land on one that was already there?
 *
 * `applyCreateNode` and `applyCreateLink` both return an id either way, which is
 * right for the caller that only wants to wire the graph up and useless for the
 * one that has to be able to take the import back out. Undo cannot tell a person
 * this import invented from a person it merely recognised, and guessing from
 * timestamps breaks the moment two writes land in the same millisecond. So the
 * apply says so, the confirm records it on the row, and undo reads it.
 *
 * Optional everywhere: a caller that does not pass one is unaffected.
 */
export interface ApplyOutcome {
  reused: boolean;
  /** Rows this apply inserted, in the order it inserted them. */
  created?: JournalCreated[];
  /** Rows this apply changed, with the prior value of every column it changed. */
  patched?: JournalPatched[];
}

/** A row an apply inserted. Unwound by deleting it. */
export interface JournalCreated {
  table: string;
  id: string;
}

/** A row an apply changed. Unwound by writing `previous` back. */
export interface JournalPatched {
  table: string;
  id: string;
  /** The patched columns, at the values they held before the patch. */
  previous: Record<string, unknown>;
}

/** Record a created row on the outcome, when the caller asked for one. */
export function noteCreated(outcome: ApplyOutcome | undefined, table: string, id: string): void {
  if (!outcome) return;
  (outcome.created ??= []).push({ table, id });
}

/** Record a patched row on the outcome, when the caller asked for one. */
export function notePatched(
  outcome: ApplyOutcome | undefined,
  table: string,
  id: string,
  previous: Record<string, unknown>,
): void {
  if (!outcome) return;
  (outcome.patched ??= []).push({ table, id, previous });
}

/**
 * A write the database refused. See the header: this is the batch failing, not
 * the row, and the confirm path rolls back on it.
 */
export class GraphWriteError extends Error {
  readonly table: string;
  readonly op: "insert" | "update" | "upsert" | "delete";
  /** The database's own code when it gave one (a Postgres SQLSTATE, or SQLite's numeric extended code). */
  readonly code: string | undefined;

  constructor(
    table: string,
    op: "insert" | "update" | "upsert" | "delete",
    error: { message: string; code?: string },
  ) {
    super(`${op} into ${table} was refused: ${error.message}`);
    this.name = "GraphWriteError";
    this.table = table;
    this.op = op;
    this.code = error.code;
  }
}

/**
 * Is this the database rejecting THIS row's values (a unique, foreign-key,
 * check or not-null violation) rather than failing outright? Postgres puts
 * every integrity violation in SQLSTATE class 23; SQLite says "constraint
 * failed" in the message and numbers them 19 (extended codes 19 + n*256).
 * Used only where a violation is the EXPECTED outcome of a race, never to
 * downgrade a refused write into a soft result.
 */
export function isConstraintViolation(error: { message: string; code?: string }): boolean {
  if (error.code && /^23/.test(error.code)) return true;
  if (error.code && /^\d+$/.test(error.code) && (Number(error.code) & 0xff) === 19) return true;
  return /constraint failed/i.test(error.message);
}

/**
 * The one gate every write passes through. Returns the result untouched when
 * it carries no error, and throws `GraphWriteError` when it does.
 */
export function mustWrite<R extends { error: { message: string; code?: string } | null }>(
  result: R,
  table: string,
  op: "insert" | "update" | "upsert" | "delete",
): R {
  if (result.error) throw new GraphWriteError(table, op, result.error);
  return result;
}

export interface ConfirmCaches {
  typeIdByName: Map<string, string>; // lower(type name) → type id
  existingNormByType: Map<string, Map<string, string>>; // typeId → normName → nodeId
  defIdByName: Map<string, string>; // detail-def name → id
}

export async function buildConfirmCaches(
  supabase: Db,
  userId: string,
): Promise<ConfirmCaches> {
  // Try to read graph_layer so satellite-cluster members are kept OUT of the
  // main-graph dedup map — otherwise a normal "John" create would collapse into
  // a Telegram "John" that only exists to be cross-linked. The local schema
  // (migration 3) has the column; the hosted schema does not yet, and PostgREST
  // errors on an unknown column, so fall back to the layerless select there.
  // Satellite nodes only exist locally, so on hosted there is nothing to exclude.
  const nodesWithLayer = await supabase
    .from("nodes")
    .select("id, display_name, node_type_id, graph_layer")
    .eq("user_id", userId)
    .is("deleted_at", null);
  const nodesQuery = nodesWithLayer.error
    ? await supabase
        .from("nodes")
        .select("id, display_name, node_type_id")
        .eq("user_id", userId)
        .is("deleted_at", null)
    : nodesWithLayer;

  const [types, defs] = await Promise.all([
    supabase.from("node_types").select("id, name").eq("user_id", userId),
    supabase.from("detail_definitions").select("id, name").eq("user_id", userId),
  ]);
  const nodes = nodesQuery;
  const typeIdByName = new Map<string, string>();
  for (const t of (types.data ?? []) as Array<{ id: string; name: string }>) {
    typeIdByName.set(t.name.toLowerCase(), t.id);
  }
  const existingNormByType = new Map<string, Map<string, string>>();
  for (const n of (nodes.data ?? []) as Array<{
    id: string;
    display_name: string;
    node_type_id: string;
    graph_layer?: string | null;
  }>) {
    if (n.graph_layer === "satellite") continue;
    let m = existingNormByType.get(n.node_type_id);
    if (!m) {
      m = new Map();
      existingNormByType.set(n.node_type_id, m);
    }
    const norm = normalizeForMatch(n.display_name);
    if (norm && !m.has(norm)) m.set(norm, n.id);
  }
  const defIdByName = new Map<string, string>();
  for (const d of (defs.data ?? []) as Array<{ id: string; name: string }>) {
    defIdByName.set(d.name, d.id);
  }
  return { typeIdByName, existingNormByType, defIdByName };
}

export async function applyCreateNode(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  cache?: ConfirmCaches,
  outcome?: ApplyOutcome,
): Promise<string | null> {
  const typeName = String(payload.type ?? "Person");
  const displayName = String(payload.display_name ?? "").trim();
  if (!displayName) return null;

  // Satellite-cluster placement (local-first, migration 3). A satellite member
  // is a person in a Telegram/Signal/etc. cluster, not on the main graph. Its node
  // must NOT dedup into a main-graph node of the same name — that IS what the
  // faint cross-cluster bridge exists to express — and it carries its cluster.
  // These fields are absent from ordinary proposals, so the main-graph path
  // below is unchanged and the hosted schema (which has no graph_layer column
  // yet) is never asked to store one.
  const graphLayer = payload.graph_layer === "satellite" ? "satellite" : undefined;
  const clusterId =
    typeof payload.cluster_id === "string" && payload.cluster_id ? payload.cluster_id : undefined;
  const isSatellite = graphLayer === "satellite";

  // Type id: from the cache when bulk-confirming, else a single query.
  let typeId = cache?.typeIdByName.get(typeName.toLowerCase());
  if (!typeId) {
    const { data: typeRow } = await supabase
      .from("node_types")
      .select("id")
      .eq("user_id", userId)
      .ilike("name", typeName)
      .maybeSingle();
    if (!typeRow) return null;
    typeId = typeRow.id as string;
  }

  // Dedup against existing nodes of the same type. Cache path uses an
  // in-memory normalized map (exact-normalized: absorbs case / article / org
  // suffix, which covers the common bulk dupes); non-cache path keeps the
  // full fuzzy+alias+edit-distance match. A SATELLITE create skips both: the
  // linking engine already deduped it against its own cluster (by account id),
  // and matching it against the main graph would collapse a cluster member into
  // the very person the cross-link bridges to.
  //
  // A DEDUP HIT NO LONGER RETURNS EMPTY-HANDED. Both branches used to
  // `return hit` on the spot, which discarded every detail the proposal was
  // carrying. That made the second source to mention someone a no-op: import
  // WhatsApp, then import iMessage, and the phone number iMessage found was
  // dropped in silence because the person already existed. It reads as
  // "iMessage found nothing", which is the failure the founder saw as a source
  // that ends with no result. The node is reused, as it should be; the facts
  // land on it, as they always should have.
  let existingNodeId: string | null = null;
  if (!isSatellite) {
    if (cache) {
      const norm = normalizeForMatch(displayName);
      existingNodeId = (norm ? cache.existingNormByType.get(typeId)?.get(norm) : null) ?? null;
    } else {
      existingNodeId = await findExistingNodeFuzzy(
        supabase,
        userId,
        typeId,
        displayName,
      );
    }
  }

  let node: { id: string } | null = existingNodeId ? { id: existingNodeId } : null;
  if (outcome) outcome.reused = Boolean(existingNodeId);
  if (!node) {
    const { data: created } = mustWrite(
      await supabase
        .from("nodes")
        .insert({
          user_id: userId,
          node_type_id: typeId,
          display_name: displayName,
          ...(graphLayer ? { graph_layer: graphLayer } : {}),
          ...(clusterId ? { cluster_id: clusterId } : {}),
        })
        .select("id")
        .single(),
      "nodes",
      "insert",
    );
    if (!created) return null;
    node = created as { id: string };
    noteCreated(outcome, "nodes", node.id);
  }

  // Seed the cache so later rows in the SAME batch dedup against this node.
  if (cache) {
    const norm = normalizeForMatch(displayName);
    if (norm) {
      let m = cache.existingNormByType.get(typeId);
      if (!m) {
        m = new Map();
        cache.existingNormByType.set(typeId, m);
      }
      if (!m.has(norm)) m.set(norm, node.id);
    }
  }

  // Values already on an existing node, so a re-import does not stack a second
  // copy of the same phone number every time it runs.
  //
  // LAZY ON PURPOSE. A re-import of a 1,400-person LinkedIn archive dedups every
  // row, and reading each node's details up front would add 1,400 round trips to
  // a job that already has a time budget. The read happens on the first detail
  // actually written to a node that already existed, so a dedup with nothing new
  // to say costs nothing, and a freshly created node never reads at all.
  // `rows` exists beside the key set for the dedupe families (education,
  // roles, honors): "is this the same fact" for those needs the sibling VALUES
  // (a JSON and a text spelling of one school share no string key), and the
  // ids so a richer incoming can retire the weaker spelling it replaces.
  interface KnownDetails {
    keys: Set<string>;
    rows: Array<{ id: string; defId: string; value: string }>;
  }
  let knownValues: KnownDetails | null = existingNodeId
    ? null
    : { keys: new Set<string>(), rows: [] };
  const valuesAlreadyThere = async (): Promise<KnownDetails> => {
    if (knownValues) return knownValues;
    const seen: KnownDetails = { keys: new Set<string>(), rows: [] };
    const { data: had } = await supabase
      .from("node_details")
      .select("id, detail_definition_id, value")
      .eq("user_id", userId)
      .eq("node_id", existingNodeId as string)
      .is("deleted_at", null);
    for (const d of (had ?? []) as Array<{
      id: string;
      detail_definition_id: string;
      value: string;
    }>) {
      seen.keys.add(`${d.detail_definition_id} ${sameValueKey(d.value)}`);
      seen.rows.push({ id: d.id, defId: d.detail_definition_id, value: d.value });
    }
    knownValues = seen;
    return seen;
  };

  // Spellings the agent was unsure of become aliases on the node it created.
  //
  // This is the whole point of marking a heard name uncertain. A transcript
  // that says "Steven" when the graph will later see "Stephen" used to produce
  // two people and no signal that they were one; registering the alternates
  // means resolveRef, findNodeByName and recall all land the second mention on
  // this same entry, so the duplicate is prevented rather than merged away
  // afterwards. Failures are swallowed: an alias is an improvement to the node,
  // never a reason to lose it (the one deliberate exception to mustWrite; a
  // duplicate alias is the usual refusal and it is not news). One that lands is
  // journaled like any other row.
  const alsoSpelled = String(payload.also_spelled ?? "")
    .split(/[,;/|]| or /i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.toLowerCase() !== displayName.toLowerCase())
    .slice(0, 6);
  for (const alias of alsoSpelled) {
    await insertAliasBestEffort(supabase, userId, node.id, alias, "agent", outcome);
  }

  const details = normalizeDetails(payload.details);
  // A user-written note (e.g. added in the Gmail review popup before accepting)
  // lands as a bio detail.
  const userNote =
    typeof payload.user_note === "string" ? payload.user_note.trim() : "";
  if (userNote) details.push({ name: "bio", value: userNote });
  for (const d of details) {
    if (!d.value || d.value.trim().length === 0) continue;
    let defId = cache?.defIdByName.get(d.name);
    if (!defId) {
      const { data: defRow } = await supabase
        .from("detail_definitions")
        .select("id")
        .eq("user_id", userId)
        .eq("name", d.name)
        .maybeSingle();
      defId = defRow?.id as string | undefined;
      if (!defId) {
        // AUTO-CREATE a missing definition instead of silently dropping the
        // fact (applyAddDetail already does this). This is why LinkedIn
        // connections lost their `company` — no builtin def existed, so every
        // employer was discarded and the org-linking worker had nothing to act
        // on. Scope the new def to this node's type; list-like names go multi.
        // Every detail can hold multiple values (2026-07-18 rule).
        const additive = true;
        const { data: created } = mustWrite(
          await supabase
            .from("detail_definitions")
            .upsert(
              {
                user_id: userId,
                name: d.name,
                value_type: "text",
                applies_to_node_type_id: typeId,
                is_default: false,
                is_builtin: false,
                multi_value: additive,
                merge_strategy: additive ? "multi" : "replace",
              },
              { onConflict: "user_id,name" },
            )
            .select("id")
            .maybeSingle(),
          "detail_definitions",
          "upsert",
        );
        defId = created?.id as string | undefined;
        if (!defId) continue;
        // The select above found no definition, so this upsert minted one.
        noteCreated(outcome, "detail_definitions", defId);
        if (cache) cache.defIdByName.set(d.name, defId);
      }
    }
    if (!sourceId) continue;
    const known = await valuesAlreadyThere();

    // Education, roles and honors compare what the values SAY, not their
    // strings: the JSON and text spellings of one school are ONE fact, and a
    // spelling that carries less than a sibling never lands beside it. When
    // the incoming is the richer one, the weaker sibling it replaces is
    // tombstoned — a plain delete, same reasoning as the location-specificity
    // block in applyAddDetail: a better spelling of the same fact, not a
    // supersession.
    if (dedupeFamilyFor(d.name)) {
      const siblings = known.rows.filter((r) => r.defId === defId);
      const plan = planFamilyDedupe(d.name, siblings, d.value);
      if (plan.action === "skip") continue;
      if (plan.action === "replace") {
        for (const retireId of plan.retire) {
          await tombstoneDetail(supabase, userId, "node_details", retireId, outcome);
        }
        known.rows = known.rows.filter((r) => !plan.retire.includes(r.id));
      }
      const { data: createdDetail } = mustWrite(
        await supabase
          .from("node_details")
          .insert({
            user_id: userId,
            node_id: node.id,
            detail_definition_id: defId,
            value: d.value,
            confidence: 1.0,
            source_id: sourceId,
            user_confirmed: true,
          })
          .select("id")
          .maybeSingle(),
        "node_details",
        "insert",
      );
      const createdId = (createdDetail as { id?: string } | null)?.id;
      if (createdId) {
        known.rows.push({ id: createdId, defId, value: d.value });
        noteCreated(outcome, "node_details", createdId);
      }
      continue;
    }

    const key = `${defId} ${sameValueKey(d.value)}`;
    if (known.keys.has(key)) continue;
    known.keys.add(key);
    const { data: createdDetail } = mustWrite(
      await supabase
        .from("node_details")
        .insert({
          user_id: userId,
          node_id: node.id,
          detail_definition_id: defId,
          value: d.value,
          confidence: 1.0,
          source_id: sourceId,
          user_confirmed: true,
        })
        .select("id")
        .maybeSingle(),
      "node_details",
      "insert",
    );
    const createdId = (createdDetail as { id?: string } | null)?.id;
    if (createdId) noteCreated(outcome, "node_details", createdId);
  }

  /*
   * Buckets the SOURCE already knew this person belonged to.
   *
   * A tag needs a node id and there is no node id until this function runs, so
   * a producer that knows the bucket at propose time has nowhere to put it
   * except the payload. Google Contacts is the case that forced it: a group the
   * user named "Investors" is their own classification of their own network,
   * strictly better than anything we would infer, and it is lost if it cannot
   * ride along with the person it describes.
   *
   * Applied rather than proposed, matching tagNode: a tag is a reversible label
   * on a person the user is approving anyway, and a second approval step for
   * the user's own filing buys nothing. Failures are swallowed for the same
   * reason aliases are — a missing tag is a smaller loss than a lost person.
   * Absent from every other producer's payload, so nothing else changes.
   */
  const tags = Array.isArray(payload.tags)
    ? (payload.tags as unknown[])
        .map((t) => String(t ?? "").trim())
        .filter((t) => t.length > 0)
        .slice(0, 12)
    : [];
  if (tags.length > 0) {
    const { applyTagByName } = await import("./tags-resolve.js");
    for (const tag of tags) {
      try {
        await applyTagByName(supabase, userId, node.id, tag);
      } catch {
        /* a label is never a reason to fail the person */
      }
    }
  }

  return node.id;
}

/**
 * Are two detail values the same fact? Matches the dedup rule applyAddDetail
 * uses, so the create path and the add path agree about what a repeat is.
 */
function sameValueKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Tombstone one live detail row (a plain delete in the validity vocabulary: a
 * better spelling of the same fact, never a supersession). The row was read
 * through a `deleted_at is null` filter, so its prior value is known to be null
 * without a second read, and that is what the journal restores.
 */
async function tombstoneDetail(
  supabase: Db,
  userId: string,
  table: "node_details" | "link_details",
  id: string,
  outcome: ApplyOutcome | undefined,
): Promise<void> {
  mustWrite(
    await supabase
      .from(table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("id", id),
    table,
    "update",
  );
  notePatched(outcome, table, id, { deleted_at: null });
}

/**
 * Insert an alias and swallow a refusal. The deliberate exception to mustWrite
 * (see the header): a node that already carries this spelling refuses the
 * duplicate, and losing the node over that would be absurd. An alias that
 * lands is journaled so an unwind can take it back out.
 */
async function insertAliasBestEffort(
  supabase: Db,
  userId: string,
  nodeId: string,
  aliasText: string,
  source: "agent" | "user",
  outcome: ApplyOutcome | undefined,
): Promise<void> {
  try {
    const { data } = await supabase
      .from("node_aliases")
      .insert({ user_id: userId, node_id: nodeId, alias_text: aliasText, source })
      .select("id")
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (id) noteCreated(outcome, "node_aliases", id);
  } catch {
    /* an alias is never a reason to lose the node */
  }
}

/**
 * Do these node ids all name live nodes of this user? One read, however many
 * ids. The link and promise paths ask before writing so a stale reference (an
 * agent naming a node that was merged away since) is a SOFT failure of that row
 * and never a foreign-key refusal that would roll the whole batch back.
 */
async function nodesExist(supabase: Db, userId: string, ids: string[]): Promise<boolean> {
  const wanted = Array.from(new Set(ids.filter(Boolean)));
  if (wanted.length === 0) return true;
  const { data, error } = await supabase
    .from("nodes")
    .select("id")
    .eq("user_id", userId)
    .in("id", wanted);
  if (error) return false;
  const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  return wanted.every((id) => found.has(id));
}

export async function applyCreateLink(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  nameToId: Map<string, string>,
  outcome?: ApplyOutcome,
): Promise<string | null> {
  const linkTypeName = String(payload.link_type ?? "");
  const sourceRef = (payload.source as { id?: string; display_name?: string }) ?? {};
  const targetRef = (payload.target as { id?: string; display_name?: string }) ?? {};

  // Resolve a node reference in order of confidence: explicit id →
  // node created earlier in this batch → the user's Self node (the
  // agent often writes source {id:"", display_name:"Self"}) → an
  // existing node with that exact name. Previously anything past the
  // first two silently failed the whole link.
  // Satellite-cluster members must never be the endpoint a main-graph link
  // resolves to BY NAME: a link referencing "John Doe" must not silently attach
  // Self (or anyone) to a same-named Telegram/Signal contact, which would pull a
  // cluster node onto the main graph without the faint reviewable bridge the
  // model requires. Only cross-cluster bridges (drawn by the linking engine as
  // proposals, always by explicit id) may touch a satellite node. Loaded once,
  // hosted-safe: the hosted schema has no graph_layer column (PostgREST errors
  // on it) and no satellite nodes, so the set is empty there.
  const satelliteIds = await loadSatelliteNodeIds(supabase, userId);

  const resolveRef = async (ref: {
    id?: string;
    display_name?: string;
  }): Promise<string | null> => {
    // An explicit id is honoured as-is: the linking engine addresses satellite
    // members and their bridges by id on purpose, and confirm-core remaps a
    // pending-row id to the committed node id before this runs.
    if (ref.id) return ref.id;
    const name = (ref.display_name ?? "").trim();
    if (!name) return null;
    const lc = name.toLowerCase();
    // Batch nodes: raw-lowercase key, then normalized key (seeded by the
    // caller / on commit) so a link to "Keystone School" matches a node
    // created this batch as "The Keystone School".
    const fromBatch = nameToId.get(lc);
    if (fromBatch) return fromBatch;
    const norm = normalizeForMatch(name);
    if (norm) {
      const fromBatchNorm = nameToId.get(`norm:${norm}`);
      if (fromBatchNorm) return fromBatchNorm;
    }
    if (["self", "me", "myself", "you"].includes(lc)) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("self_node_id")
        .eq("user_id", userId)
        .maybeSingle();
      return (prof as { self_node_id?: string } | null)?.self_node_id ?? null;
    }
    // Exact existing node. Ordered so a satellite hit never wins over a main one
    // and, when the only same-name node is satellite, resolves to nothing rather
    // than to the cluster member. Paged, not capped: see firstMatchPaged.
    const exact = await firstMatchPaged<{ id: string }>(
      (from, to) =>
        supabase
          .from("nodes")
          .select("id")
          .eq("user_id", userId)
          .is("deleted_at", null)
          .ilike("display_name", name)
          .order("id", { ascending: true })
          .range(from, to),
      (n) => !satelliteIds.has(n.id),
    );
    if (exact) return exact.id;
    // Alias: a node that was renamed keeps its old name here, so a link
    // referencing the prior spelling still resolves (e.g. "Kedabhai" → the
    // node now named "Kedar"). A satellite member's also_spelled alias is
    // excluded for the same reason as its name.
    const aliasMatch = await firstMatchPaged<{ id: string; node_id: string }>(
      (from, to) =>
        supabase
          .from("node_aliases")
          .select("id, node_id")
          .eq("user_id", userId)
          .is("deleted_at", null)
          .ilike("alias_text", name)
          .order("id", { ascending: true })
          .range(from, to),
      (a) => !satelliteIds.has(a.node_id),
    );
    if (aliasMatch) return aliasMatch.node_id;
    // Normalized fallback against ALL of the user's nodes — resolves
    // article/suffix/punctuation differences ("The Keystone School" vs
    // "Keystone School", "Fintellect, Inc." vs "Fintellect") that exact
    // match misses. Without this the link fails and reappears forever.
    if (norm) {
      const { data: all } = await supabase
        .from("nodes")
        .select("id, display_name")
        .eq("user_id", userId)
        .is("deleted_at", null);
      const hit = (all ?? []).find(
        (n) =>
          !satelliteIds.has((n as { id: string }).id) &&
          normalizeForMatch((n as { display_name: string }).display_name) === norm,
      );
      if (hit) return (hit as { id: string }).id;
    }
    return null;
  };

  const sourceNodeId = await resolveRef(sourceRef);
  const targetNodeId = await resolveRef(targetRef);
  if (!sourceNodeId || !targetNodeId) return null;
  // An explicit id is honoured as-is above, and an explicit id can be stale: an
  // agent naming a person who was merged away since it looked. Asking first
  // keeps that a soft failure of this row instead of a foreign-key refusal on
  // the insert, which would be read as the database failing under the batch.
  if (!(await nodesExist(supabase, userId, [sourceNodeId, targetNodeId]))) return null;

  let { data: linkType } = await supabase
    .from("link_types")
    .select("id")
    .eq("user_id", userId)
    .eq("name", linkTypeName)
    .maybeSingle();
  if (!linkType) {
    // Evolving schema: mint the link type instead of silently failing the
    // row. The agent is told to use the MOST SPECIFIC relationship name
    // (contributor, honorary_role, spoke_at, …) and to coin a precise new
    // snake_case name when nothing fits — that only works if confirm-time
    // creates it. created_by_ai marks it for the schema surfaces; the user
    // can rename/delete it there (undo path).
    //
    // NAMESPACE RULE: every mint is NAME-KEYED — the select above ran first,
    // so an existing name (seeded or user-made) is always REUSED, never
    // shadowed, and the race re-read below keeps that true under concurrency.
    // The seed side holds the same rule in reverse: ontology backfills
    // (migration 183 and its ancestors) are insert-only ON CONFLICT DO
    // NOTHING, so a later seed upgrade never overwrites a name a user's mint
    // already claimed.
    const coined = linkTypeName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (!coined) return null;
    const mint = await supabase
      .from("link_types")
      .insert({
        user_id: userId,
        name: coined,
        direction: "directed",
        is_builtin: false,
        created_by_ai: true,
        description: "Created automatically from a confirmed AI proposal.",
      })
      .select("id")
      .maybeSingle();
    // The second deliberate exception to mustWrite: losing the unique race to a
    // concurrent mint of the same name is expected, and the re-read below is
    // the answer to it. Any OTHER refusal is the database failing.
    if (mint.error && !isConstraintViolation(mint.error)) {
      throw new GraphWriteError("link_types", "insert", mint.error);
    }
    const minted = mint.data as { id: string } | null;
    if (!minted) {
      // Insert can race a concurrent mint of the same name — re-read.
      const { data: raced } = await supabase
        .from("link_types")
        .select("id")
        .eq("user_id", userId)
        .eq("name", coined)
        .maybeSingle();
      if (!raced) return null;
      linkType = raced;
    } else {
      linkType = minted;
      noteCreated(outcome, "link_types", minted.id);
    }
  }

  // Idempotency: an identical link (same type, same endpoints) must never be
  // inserted twice. Confirming Gmail-ingest batches used to re-apply the same
  // Self→Org link on every sweep — the 2026-07-07 audit found one member_of
  // link duplicated FIFTEEN times. Return the existing link id (and skip the
  // detail writes — they'd stack duplicate rows on the existing link).
  const { data: dupe } = await supabase
    .from("links")
    .select("id")
    .eq("user_id", userId)
    .eq("link_type_id", linkType.id)
    .eq("source_node_id", sourceNodeId)
    .eq("target_node_id", targetNodeId)
    .limit(1);
  if (dupe && dupe.length > 0) {
    // The link was already there. Saying so is what lets an undo leave a link
    // the user drew by hand, or an earlier import made, exactly where it is.
    if (outcome) outcome.reused = true;
    return dupe[0].id as string;
  }

  const { data: link } = mustWrite(
    await supabase
      .from("links")
      .insert({
        user_id: userId,
        link_type_id: linkType.id,
        source_node_id: sourceNodeId,
        target_node_id: targetNodeId,
      })
      .select("id")
      .single(),
    "links",
    "insert",
  );
  if (!link) return null;
  noteCreated(outcome, "links", link.id as string);

  const details = normalizeDetails(payload.details);
  for (const d of details) {
    if (!d.value || d.value.trim().length === 0) continue;
    let { data: defRow } = await supabase
      .from("detail_definitions")
      .select("id")
      .eq("user_id", userId)
      .eq("name", d.name)
      .maybeSingle();
    // Auto-mint like applyAddDetail does. Dropping an unrecognized link-detail
    // name was silent AND unrecorded: the LinkedIn importer's start/end dates
    // vanished on every confirm while the row reported success. Any name the
    // agent or an importer coins now becomes vocabulary instead of a hole.
    if (!defRow) {
      const { data: created } = mustWrite(
        await supabase
          .from("detail_definitions")
          .upsert(
            {
              user_id: userId,
              name: d.name,
              value_type: "text",
              applies_to_link_type_id: linkType.id,
              is_default: false,
              is_builtin: false,
              multi_value: true,
              merge_strategy: "multi",
              created_by_ai: true,
            },
            { onConflict: "user_id,name" },
          )
          .select("id")
          .maybeSingle(),
        "detail_definitions",
        "upsert",
      );
      defRow = created ?? null;
      if (defRow) noteCreated(outcome, "detail_definitions", defRow.id as string);
    }
    if (!defRow || !sourceId) continue;
    const { data: linkDetail } = mustWrite(
      await supabase
        .from("link_details")
        .insert({
          user_id: userId,
          link_id: link.id,
          detail_definition_id: defRow.id,
          value: d.value,
          confidence: 1.0,
          source_id: sourceId,
          user_confirmed: true,
        })
        .select("id")
        .maybeSingle(),
      "link_details",
      "insert",
    );
    const linkDetailId = (linkDetail as { id?: string } | null)?.id;
    if (linkDetailId) noteCreated(outcome, "link_details", linkDetailId);
  }
  return link.id;
}

/**
 * Page size for the by-name resolvers. Small on purpose: the common case is one
 * page with one row, and a name that fills several pages is a hub surname.
 */
const NAME_PAGE = 20;

/**
 * Walk a query page by page until `pick` accepts a row or the rows run out.
 *
 * This replaces a fixed `.limit(20)` that the by-name resolvers carried, which
 * was a silent miss on a large graph: with twenty-one satellite "John Doe"s
 * sorting ahead of the one main-graph John Doe, the query returned twenty
 * cluster members, the satellite filter dropped every one, and the link failed
 * to resolve on a graph that plainly held the person. `page` builds a FRESH
 * query each time because a builder is single-use.
 */
async function firstMatchPaged<R>(
  page: (from: number, to: number) => PromiseLike<{ data: R[] | null; error: unknown }>,
  pick: (row: R) => boolean,
  pageSize: number = NAME_PAGE,
): Promise<R | null> {
  for (let from = 0; ; from += pageSize) {
    const { data } = await page(from, from + pageSize - 1);
    const rows = (data ?? []) as R[];
    const hit = rows.find(pick);
    if (hit) return hit;
    if (rows.length < pageSize) return null;
  }
}

export type AddDetailOutcome =
  | { kind: "committed"; detail_id: string }
  | { kind: "conflict_flagged"; conflict_id: string }
  | { kind: "failed" };

// EVERY detail field holds multiple values (2026-07-18 founder rule): adding
// a fact never conflicts, the first value is primary and the rest secondary.
// The AI replaces (vs adds) explicitly via proposeEditNode. The old
// LIST_VALUED_DETAILS allowlist is gone — multi is simply the default.

// Geographic fields where a LESS-specific value is a comma-suffix of a
// more-specific one ("United States" ⊂ "Fremont, California, United States")
// — those must collapse to the specific one, never coexist or conflict.
const LOCATION_FIELDS = new Set([
  "location", "locations", "city", "cities", "based_in", "address",
]);

/** Comma-token containment: is `a` a trailing subset of `b` (a less specific)? */
export function isLocationSuffix(a: string, b: string): boolean {
  const ta = a.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const tb = b.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (ta.length === 0 || ta.length >= tb.length) return false;
  // a's tokens must equal the last ta.length tokens of b.
  const tail = tb.slice(tb.length - ta.length);
  return ta.every((t, i) => t === tail[i]);
}

export async function applyAddDetail(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  nameToId: Map<string, string>,
  outcome?: ApplyOutcome,
): Promise<AddDetailOutcome> {
  // Two producers write `add_detail` pending rows: the chat agent's
  // proposeAddDetail tool (uses `node_id`) and the web-enrichment
  // pipeline (uses `target_node_id`). Accept either key so a confirm
  // doesn't silently reject every enrichment row.
  const rawNodeId = String(
    payload.node_id ?? payload.target_node_id ?? "",
  ).trim();
  const detailName = String(payload.detail_name ?? "").trim();
  const value = String(payload.value ?? "").trim();
  if (!rawNodeId || !detailName || !value || !sourceId) {
    return { kind: "failed" };
  }

  // The agent sometimes stores node_id as a display_name (because the
  // node hasn't been created yet — it lives in a sibling create_node
  // pending row in the same batch). Resolve via nameToId map first;
  // only treat the value as a UUID if it parses as one.
  const looksUuid = /^[0-9a-f-]{36}$/i.test(rawNodeId);
  const nodeId = looksUuid
    ? rawNodeId
    : nameToId.get(rawNodeId.toLowerCase()) ?? null;
  if (!nodeId) return { kind: "failed" };

  // The node has to be there. An agent's `node_id` can be stale (merged away
  // since it looked), and the foreign key on the insert below would refuse it,
  // which reads as the database failing under the batch. It is this row that
  // cannot land, so it is asked here and answered softly.
  const { data: nodeRow } = await supabase
    .from("nodes")
    .select("node_type_id")
    .eq("user_id", userId)
    .eq("id", nodeId)
    .maybeSingle<{ node_type_id: string }>();
  if (!nodeRow) return { kind: "failed" };

  let { data: defRow } = await supabase
    .from("detail_definitions")
    .select("id, merge_strategy, value_type")
    .eq("user_id", userId)
    .eq("name", detailName)
    .maybeSingle<{
      id: string;
      merge_strategy: "replace" | "append" | "multi" | null;
      value_type: string;
    }>();
  // No definition for this detail name? Auto-create a sensible text one
  // instead of hard-failing the row. Producers (web enrichment, the chat
  // agent) occasionally emit a vocabulary term that was never seeded — this
  // has silently dropped facts three times (migrations 052, 079). Scope the
  // new def to the target node's type so it shows up in the right editor.
  if (!defRow) {
    // Note-like free-text fields default to multi (accumulate, never conflict);
    // everything else stays single-valued replace. Keeps auto-created vocab
    // consistent with the ALWAYS_ADDITIVE handling below.
    // Every detail can hold multiple values (2026-07-18 rule).
    const additive = true;
    const { data: created } = mustWrite(
      await supabase
        .from("detail_definitions")
        .upsert(
          {
            user_id: userId,
            name: detailName,
            value_type: "text",
            applies_to_node_type_id: nodeRow.node_type_id ?? null,
            is_default: false,
            is_builtin: false,
            multi_value: additive,
            merge_strategy: additive ? "multi" : "replace",
          },
          { onConflict: "user_id,name" },
        )
        .select("id, merge_strategy, value_type")
        .maybeSingle<{
          id: string;
          merge_strategy: "replace" | "append" | "multi" | null;
          value_type: string;
        }>(),
      "detail_definitions",
      "upsert",
    );
    if (!created) return { kind: "failed" };
    defRow = created;
    noteCreated(outcome, "detail_definitions", created.id);
  }

  // Free-form annotation fields are inherently a SET of independent notes, not
  // one single-valued fact — "Cofounder at A14 Labs" and "Mutual connection
  // with Parshwa Shah" are both true at once. They must never land in the
  // Conflicts queue, whatever a (possibly stale) definition's merge_strategy
  // says. Force multi so every distinct value coexists — the general "add
  // unlimited attributes" guarantee for note-like fields.
  // Founder rule (2026-07-18): EVERY detail can hold multiple values — adding
  // a fact never conflicts with an existing one ("Volunteer at SNIPSA" and
  // "Volunteer at Special Olympics" are both true). Whether to REPLACE instead
  // of add is the AI's explicit call via proposeEditNode, which shows a
  // before→after preview. So: `append` defs keep their extend-the-text
  // behavior; everything else is multi. The old replace-and-conflict path is
  // gone — conflicts are for genuine contradictions, not second values.
  const strategy: "append" | "multi" =
    (defRow.merge_strategy as string | null) === "append" ? "append" : "multi";

  const { data: existing } = await supabase
    .from("node_details")
    .select("id, value, source_id, user_confirmed")
    .eq("user_id", userId)
    .eq("node_id", nodeId)
    .eq("detail_definition_id", defRow.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── Append-style fields (bio, notes, interests, recent_news, …) ──
  // The new value extends the existing single row instead of conflicting.
  if (strategy === "append" && existing) {
    const merged = mergeAdditiveText(existing.value, value);
    if (!mergeAddedNew(existing.value, merged)) {
      // No new content — the incoming was already covered. Touch
      // updated_at so audit shows a confirmation but skip the actual
      // change to keep history clean.
      return { kind: "committed", detail_id: existing.id };
    }
    mustWrite(
      await supabase
        .from("node_details")
        .update({
          value: merged,
          source_id: sourceId,
          user_confirmed: true,
        })
        .eq("user_id", userId)
        .eq("id", existing.id),
      "node_details",
      "update",
    );
    notePatched(outcome, "node_details", existing.id, {
      value: existing.value,
      source_id: existing.source_id,
      user_confirmed: existing.user_confirmed,
    });
    return { kind: "committed", detail_id: existing.id };
  }

  // ── Multi-value path — every DISTINCT value gets its own row, no conflict.
  // Dedup on the exact value so re-running extraction/enrichment doesn't stack
  // identical notes/emails/languages (case-insensitive, whitespace-normalized).
  // Also the fresh-insert path for an append field's FIRST value (strategy is
  // append but nothing exists yet to append to).
  if (strategy === "multi" || !existing) {
    const { data: siblings } = await supabase
      .from("node_details")
      .select("id, value")
      .eq("user_id", userId)
      .eq("node_id", nodeId)
      .eq("detail_definition_id", defRow.id)
      .is("deleted_at", null);
    const norm = (v: unknown) =>
      String(v ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    const dupe = (siblings ?? []).find((s) => norm(s.value) === norm(value));
    if (dupe) return { kind: "committed", detail_id: dupe.id };

    // The dedupe families (education_entry, past_role/current_role, honor)
    // compare what the values SAY: the canonical JSON and the plain-text
    // spellings of one school are one fact, and a spelling missing the degree
    // or the years is covered by the one that has them. An incoming value an
    // existing sibling already covers commits onto that sibling; an incoming
    // that covers existing siblings retires exactly those (a plain delete,
    // like the location block below: a better spelling of the same fact,
    // never a supersession) and lands as the surviving row.
    if (dedupeFamilyFor(detailName)) {
      const plan = planFamilyDedupe(
        detailName,
        (siblings ?? []) as Array<{ id: string; value: string }>,
        value,
      );
      if (plan.action === "skip") return { kind: "committed", detail_id: plan.coveredBy };
      if (plan.action === "replace") {
        for (const retireId of plan.retire) {
          await tombstoneDetail(supabase, userId, "node_details", retireId, outcome);
        }
      }
    }

    // Location specificity: never store both "United States" and "Fremont,
    // California, United States". If the incoming is a less-specific suffix of
    // an existing one, keep the specific one (skip). If it's MORE specific than
    // an existing sibling, retire the vaguer one and keep the new.
    if (LOCATION_FIELDS.has(detailName.toLowerCase())) {
      for (const s of siblings ?? []) {
        const sv = String(s.value ?? "").trim();
        if (isLocationSuffix(value, sv)) {
          // incoming is vaguer than an existing value → covered, skip.
          return { kind: "committed", detail_id: s.id };
        }
      }
      const vaguer = (siblings ?? []).filter((s) =>
        isLocationSuffix(String(s.value ?? "").trim(), value),
      );
      // ⚠️ A PLAIN DELETE, AND IT MUST STAY ONE. "Fremont, California, United
      // States" does not mean the person stopped living in the United States,
      // so closing a window here would record a move that never happened. This
      // is a better spelling of the same fact, which is exactly the case
      // supersession is NOT for.
      for (const s of vaguer) {
        await tombstoneDetail(supabase, userId, "node_details", s.id, outcome);
      }
    }

    const { data: detail } = mustWrite(
      await supabase
        .from("node_details")
        .insert({
          user_id: userId,
          node_id: nodeId,
          detail_definition_id: defRow.id,
          value,
          confidence: 1.0,
          source_id: sourceId,
          user_confirmed: true,
        })
        .select("id")
        .single(),
      "node_details",
      "insert",
    );
    if (!detail) return { kind: "failed" };
    noteCreated(outcome, "node_details", detail.id);
    return { kind: "committed", detail_id: detail.id };
  }

  // Unreachable: strategy is always append or multi now, and both return
  // above. Kept as a hard fail so a future strategy addition can't silently
  // fall through.
  return { kind: "failed" };
}

/**
 * Merge new text into an existing free-text field (bio, notes, etc.).
 * Goals:
 *  - Skip duplicates: if the incoming sentence already appears in the
 *    existing value, drop it.
 *  - Avoid containment thrash: if either value is a strict substring of
 *    the other, return the longer.
 *  - Otherwise concatenate, separated by a sentence break.
 */
export function mergeAdditiveText(existing: unknown, incoming: string): string {
  const a = (typeof existing === "string" ? existing : "").trim();
  const b = incoming.trim();
  if (!a) return b;
  if (!b) return a;
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  if (b.toLowerCase().includes(a.toLowerCase())) return b;

  // Sentence-level dedup: if the new value is a few sentences and any
  // of them already appear, only keep the new ones.
  const sentencesIn = b
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const existingLower = a.toLowerCase();
  const fresh = sentencesIn.filter(
    (s) => !existingLower.includes(s.toLowerCase()),
  );
  if (fresh.length === 0) return a;
  const addition = fresh.join(" ");
  return a.endsWith(".") || a.endsWith("!") || a.endsWith("?")
    ? `${a} ${addition}`
    : `${a}. ${addition}`;
}

export function mergeAddedNew(existing: unknown, merged: string): boolean {
  const a = (typeof existing === "string" ? existing : "").trim();
  return merged.trim().length > a.length;
}

export function valuesDiffer(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string =>
    typeof v === "string"
      ? v.trim().toLowerCase()
      : typeof v === "number"
      ? String(v)
      : JSON.stringify(v);
  return norm(a) !== norm(b);
}

/**
 * Apply an `add_link_detail` pending row → insert a link_details row
 * for {link_id, detail_definition by name, value}. If a non-deleted
 * row already exists for the same (link, definition), soft-delete it
 * first so the new value replaces the old. This is the "agent updates
 * the title on Kevin Rudd's employee link" path.
 *
 * Returns the inserted link_details.id on success, null on any
 * lookup or insert failure. We deliberately don't go through the
 * conflict-flagging machinery used for node_details — link details
 * are usually role/title that the user is intentionally updating, and
 * adding a conflict UI flow here would dilute the signal.
 */
export async function applyAddLinkDetail(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  outcome?: ApplyOutcome,
): Promise<string | null> {
  const linkId = String(payload.link_id ?? "").trim();
  const detailName = String(payload.detail_name ?? "").trim();
  const value = String(payload.value ?? "").trim();
  if (!linkId || !detailName || !value || !sourceId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return null;

  // Confirm the link actually belongs to this user (defensive — RLS
  // would also stop a cross-user write, but this is a clearer fail).
  const { data: linkRow } = await supabase
    .from("links")
    .select("id, link_type_id")
    .eq("user_id", userId)
    .eq("id", linkId)
    .maybeSingle();
  if (!linkRow) return null;

  let { data: defRow } = await supabase
    .from("detail_definitions")
    .select("id")
    .eq("user_id", userId)
    .eq("name", detailName)
    .maybeSingle();
  // Auto-mint, matching applyAddDetail and applyCreateLink. The agent accepts
  // any free-text detail_name from the model, so a name outside the seeded
  // vocabulary used to produce a proposal that could NEVER confirm — rejected
  // from chat, three-strikes-cleared from the dashboard, and re-proposed the
  // next time the same source was read.
  //
  // NAMESPACE RULE: name-keyed, like every mint site — the select above reuses
  // an existing name and the upsert's onConflict target makes the race lose
  // gracefully, so a mint never shadows a seeded definition and a later seed
  // upgrade (insert-only, ON CONFLICT DO NOTHING) never overwrites a mint.
  if (!defRow) {
    const { data: created } = mustWrite(
      await supabase
        .from("detail_definitions")
        .upsert(
          {
            user_id: userId,
            name: detailName,
            value_type: "text",
            applies_to_link_type_id: (linkRow as { link_type_id?: string }).link_type_id ?? null,
            is_default: false,
            is_builtin: false,
            multi_value: true,
            merge_strategy: "multi",
            created_by_ai: true,
          },
          { onConflict: "user_id,name" },
        )
        .select("id")
        .maybeSingle(),
      "detail_definitions",
      "upsert",
    );
    defRow = created ?? null;
    if (defRow) noteCreated(outcome, "detail_definitions", defRow.id as string);
  }
  if (!defRow) return null;

  // ── Replace, as a SUPERSESSION rather than a deletion ──────────────
  //
  // This is the single-value path for link details: a title on an employee link
  // holds one value, and a new one means the old one stopped being true. It used
  // to soft-delete the prior row, which threw away the one thing worth keeping —
  // WHEN it stopped. The window is closed instead, so "she was Head of GTM until
  // March" is answerable and the source behind that old title survives with it.
  //
  // The tombstone still lands (closeWindowPatch writes both), so every reader
  // that has ever filtered deleted_at behaves exactly as it did yesterday.
  const open = await openDetailRows(
    supabase,
    userId,
    "link_details",
    "link_id",
    linkId,
    defRow.id,
  );

  // Re-asserting the value that is already there is not a change in the world,
  // and closing a window for it would invent a departure and a return on the
  // same day. Re-running an import must never do that.
  const unchanged = open.find((r) => !valuesDiffer(r.value, value));
  if (unchanged) return unchanged.id;

  const at = new Date().toISOString();
  await closeDetailWindows(supabase, userId, "link_details", open, at, outcome);

  const { data: inserted } = mustWrite(
    await supabase
      .from("link_details")
      .insert({
        user_id: userId,
        link_id: linkId,
        detail_definition_id: defRow.id,
        value,
        confidence: 1.0,
        source_id: sourceId,
        user_confirmed: true,
        // Only when it took over from something. A first value has no known
        // start: the role may predate the graph by a decade, and stamping "today"
        // on it would be Wend inventing a date and then quoting it back.
        ...(open.length > 0 ? openWindowPatch(at) : {}),
      })
      .select("id")
      .single(),
    "link_details",
    "insert",
  );
  if (!inserted) return null;
  noteCreated(outcome, "link_details", inserted.id as string);
  return inserted.id;
}

/**
 * Apply an edit_node pending row → change an EXISTING node's name and/or
 * detail values (new job, new location, typo fix, …). Each edit is
 * {field:"name", next}, {field:"detail", detail_name, next} or
 * {field:"end_detail", detail_name, previous?, ended_at?}. Renames keep the old
 * name as an alias so links/history keep resolving. Returns the node id on any
 * successful change.
 *
 * ⚠️ A DETAIL EDIT SUPERSEDES, IT DOES NOT DELETE. The prior value's window is
 * closed at the moment of the confirm and the new value starts there, so the old
 * fact keeps its value and its source and gains an end. That is the whole
 * difference between a graph that can answer "when did she leave Stripe" and one
 * that can only answer "where does she work". Closing tombstones the row too
 * (src/lib/graph/validity.ts), so nothing that reads this graph shows two
 * current employers.
 *
 * ⚠️ AND IT HAPPENS ONLY HERE, ON A CONFIRM. Nothing infers an ending. A second
 * value arriving from an import is an ADDITION (applyAddDetail, multi-value by
 * the 2026-07-18 rule) and a genuine contradiction is still a question put to
 * the user in Conflicts. Supersession is what the user approved when they
 * approved a REPLACEMENT, and it is never what an extraction decided on its own.
 */
export async function applyEditNode(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  outcome?: ApplyOutcome,
): Promise<string | null> {
  const nodeId = String(payload.node_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(nodeId)) return null;

  // updated_at is read so a rename's journal entry can restore it exactly,
  // rather than leaving a rolled-back edit's timestamp behind.
  const { data: node } = await supabase
    .from("nodes")
    .select("id, node_type_id, display_name, updated_at")
    .eq("user_id", userId)
    .eq("id", nodeId)
    .is("deleted_at", null)
    .maybeSingle<{
      id: string;
      node_type_id: string;
      display_name: string;
      updated_at: string | null;
    }>();
  if (!node) return null;

  const edits = Array.isArray(payload.edits)
    ? (payload.edits as Array<Record<string, unknown>>)
    : [];
  let changed = false;

  for (const e of edits) {
    const field = String(e.field ?? "").trim();
    const next = String(e.next ?? "").trim();
    // end_detail is the one edit with nothing to put in `next`: it records that
    // a fact stopped being true without naming a replacement ("she left Stripe",
    // said on its own). Every other edit needs a value.
    if (!next && field !== "end_detail") continue;

    if (field === "name") {
      const prev = node.display_name;
      if (next === prev) continue;
      mustWrite(
        await supabase
          .from("nodes")
          .update({ display_name: next, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("id", nodeId),
        "nodes",
        "update",
      );
      notePatched(outcome, "nodes", nodeId, {
        display_name: prev,
        updated_at: node.updated_at ?? null,
      });
      changed = true;
      // Preserve the old name as an alias so links referencing it still
      // resolve and recall can find it under the prior spelling. (Column is
      // alias_text; source must be user/agent/extension/enrichment.)
      if (prev && prev.trim()) {
        await insertAliasBestEffort(supabase, userId, nodeId, prev.trim(), "user", outcome);
      }
      continue;
    }

    if (field === "end_detail") {
      // ⚠️ WHERE THE END'S PROVENANCE LIVES. The row keeps `source_id`, which
      // names where the VALUE came from, and there is no second column for
      // where the ENDING came from. That is not a hole: an end is only ever
      // written by confirming a proposal, so the pending_writes row holds who
      // asked, what they said, the source behind it and the moment it was
      // approved. Adding a column for it would be a schema change on all three
      // databases to duplicate a record that already exists.
      const detailName = String(e.detail_name ?? "").trim();
      if (!detailName) continue;
      const { data: defRow } = await supabase
        .from("detail_definitions")
        .select("id")
        .eq("user_id", userId)
        .eq("name", detailName)
        .maybeSingle<{ id: string }>();
      // No definition means no rows, so there is nothing to end. Minting one
      // here would create an ontology entry for a fact the graph never held.
      if (!defRow) continue;
      const open = await openDetailRows(
        supabase,
        userId,
        "node_details",
        "node_id",
        nodeId,
        defRow.id,
      );
      // A named previous value ends exactly that one, which matters on the
      // multi-value definitions the 2026-07-18 rule made the default: "she left
      // Stripe" must not close "she also advises Foo".
      const only = String(e.previous ?? "").trim();
      const target = only
        ? open.filter((r) => !valuesDiffer(r.value, only))
        : open;
      const closed = await closeDetailWindows(
        supabase,
        userId,
        "node_details",
        target,
        e.ended_at,
        outcome,
      );
      if (closed > 0) changed = true;
      continue;
    }

    if (field === "detail") {
      const detailName = String(e.detail_name ?? "").trim();
      if (!detailName || !sourceId) continue;
      let { data: defRow } = await supabase
        .from("detail_definitions")
        .select("id")
        .eq("user_id", userId)
        .eq("name", detailName)
        .maybeSingle<{ id: string }>();
      if (!defRow) {
        const mint = await supabase
          .from("detail_definitions")
          .insert({
            user_id: userId,
            name: detailName,
            value_type: "text",
            applies_to_node_type_id: node.node_type_id,
            is_default: false,
            is_builtin: false,
            multi_value: false,
            merge_strategy: "replace",
          })
          .select("id")
          .maybeSingle<{ id: string }>();
        // Name-keyed like every mint site: losing the unique race to a
        // concurrent mint is expected and the re-read is the answer. Any other
        // refusal is the database failing under the batch.
        if (mint.error && !isConstraintViolation(mint.error)) {
          throw new GraphWriteError("detail_definitions", "insert", mint.error);
        }
        let created = mint.data;
        if (!created) {
          const { data: raced } = await supabase
            .from("detail_definitions")
            .select("id")
            .eq("user_id", userId)
            .eq("name", detailName)
            .maybeSingle<{ id: string }>();
          created = raced;
        } else {
          noteCreated(outcome, "detail_definitions", created.id);
        }
        if (!created) continue;
        defRow = created;
      }
      // Replace = supersede. The prior value keeps its source and gains an end;
      // the new one starts where the old one stopped.
      const open = await openDetailRows(
        supabase,
        userId,
        "node_details",
        "node_id",
        nodeId,
        defRow.id,
      );
      // Confirming the value that is already there changes nothing in the world.
      // Without this guard an agent re-proposing what it read back would write a
      // departure and an arrival on the same day, and the history it produced
      // would be an artefact of our own writes.
      if (open.length > 0 && open.every((r) => !valuesDiffer(r.value, next))) {
        continue;
      }
      const at = new Date().toISOString();
      await closeDetailWindows(supabase, userId, "node_details", open, at, outcome);
      const { data: inserted } = mustWrite(
        await supabase
          .from("node_details")
          .insert({
            user_id: userId,
            node_id: nodeId,
            detail_definition_id: defRow.id,
            value: next,
            confidence: 1.0,
            source_id: sourceId,
            user_confirmed: true,
            // A first value has no known start. Only a value that TOOK OVER from
            // another one does, and it starts exactly where that one ended.
            ...(open.length > 0 ? openWindowPatch(at) : {}),
          })
          .select("id")
          .maybeSingle(),
        "node_details",
        "insert",
      );
      const insertedId = (inserted as { id?: string } | null)?.id;
      if (insertedId) noteCreated(outcome, "node_details", insertedId);
      changed = true;
    }
  }

  return changed ? nodeId : null;
}

/** A live value with an open window, as the two closers below need it. */
interface OpenDetailRow {
  id: string;
  value: unknown;
  valid_from: string | null;
  created_at: string | null;
}

/**
 * The values that are true RIGHT NOW for one (owner, definition) pair.
 *
 * ⚠️ `valid_until is null` is half the filter and it is the half that is easy to
 * drop. Without it a second confirm would re-close a window somebody already
 * recorded, rewriting the end date of a fact that had already ended. An
 * overwritten end is the one thing a supersede-never-overwrite design cannot
 * allow, so the two closers below both read through here.
 */
async function openDetailRows(
  supabase: Db,
  userId: string,
  table: "node_details" | "link_details",
  ownerColumn: "node_id" | "link_id",
  ownerId: string,
  definitionId: string,
): Promise<OpenDetailRow[]> {
  const { data } = await supabase
    .from(table)
    .select("id, value, valid_from, created_at")
    .eq("user_id", userId)
    .eq(ownerColumn, ownerId)
    .eq("detail_definition_id", definitionId)
    .is("deleted_at", null)
    .is("valid_until", null);
  return (data ?? []) as OpenDetailRow[];
}

/**
 * End these values. Returns how many closed, so a caller can tell "there was
 * nothing to end" from "done" rather than reporting a clean zero. A close the
 * database refuses throws (mustWrite), so the count is the row count or the
 * batch is already unwinding.
 *
 * The journal entry restores exactly what closeWindowPatch wrote, and both
 * columns were null by construction: openDetailRows filters on
 * `deleted_at is null` AND `valid_until is null`, which is what makes the prior
 * value known without a second read.
 */
async function closeDetailWindows(
  supabase: Db,
  userId: string,
  table: "node_details" | "link_details",
  rows: OpenDetailRow[],
  endedAt?: unknown,
  outcome?: ApplyOutcome,
): Promise<number> {
  let closed = 0;
  for (const row of rows) {
    mustWrite(
      await supabase
        .from(table)
        .update(closeWindowPatch(normalizeEnd(endedAt, row)))
        .eq("user_id", userId)
        .eq("id", row.id),
      table,
      "update",
    );
    notePatched(outcome, table, row.id, { valid_until: null, deleted_at: null });
    closed += 1;
  }
  return closed;
}

/**
 * Apply a create_promise pending row → insert into the promises table.
 * The agent's flagPromise tool wrote {direction, description, target,
 * due_at} into payload. target.id may reference an existing node OR
 * target.display_name may match a create_node row earlier in the same
 * batch (resolved via nameToId). due_at is an ISO string or "" — empty
 * collapses to null. Source row is the same chat-batch source the rest
 * of the batch shares.
 */
export async function applyCreatePromise(
  supabase: Db,
  userId: string,
  payload: Record<string, unknown>,
  sourceId: string | undefined,
  nameToId: Map<string, string>,
  outcome?: ApplyOutcome,
): Promise<string | null> {
  if (!sourceId) return null;
  const direction = String(payload.direction ?? "");
  const description = String(payload.description ?? "").trim();
  if (!description) return null;
  if (
    direction !== "user_to_other" &&
    direction !== "other_to_user" &&
    direction !== "mutual"
  ) {
    return null;
  }

  const target = (payload.target as { id?: string; display_name?: string } | undefined) ?? {};
  const counterpartyId =
    target.id ||
    nameToId.get((target.display_name ?? "").trim().toLowerCase()) ||
    null;
  // A named counterparty that is not in the graph is this row's problem, not
  // the batch's: answered here so the insert's foreign key never has to.
  if (counterpartyId && !(await nodesExist(supabase, userId, [counterpartyId]))) return null;

  // Place the counterparty in the right slot per direction so the name renders
  // and "who owes whom" is correct everywhere (matches mobile + /app/promises):
  // other_to_user → committer = the other person, target = self;
  // user_to_other / mutual → target = the other person, committer = self.
  const { data: selfProf } = await supabase
    .from("profiles")
    .select("self_node_id")
    .eq("user_id", userId)
    .maybeSingle();
  const selfId =
    (selfProf as { self_node_id?: string | null } | null)?.self_node_id ?? null;
  const committerNodeId = direction === "other_to_user" ? counterpartyId : selfId;
  const targetNodeId = direction === "other_to_user" ? selfId : counterpartyId;

  const dueAtRaw = String(payload.due_at ?? "").trim();
  let dueAt: string | null = null;
  if (dueAtRaw.length > 0) {
    const parsed = new Date(dueAtRaw);
    if (!Number.isNaN(parsed.getTime())) {
      dueAt = parsed.toISOString();
    }
  }

  // Dedup at confirm time: one ingest batch can propose the same commitment
  // phrased three ways ("send an invite for Wednesday at 9:30" x3), and
  // confirm-all then landed three live promises. Skip the insert when an
  // OPEN promise for the same counterparty already matches on normalized
  // wording. Fulfilled/discarded promises don't block: re-promising
  // something you already did once is a real new promise.
  //
  // KEYED AND PAGED, NOT CAPPED. This used to read the first 200 open promises
  // across the whole account and compare parties in memory, so on a graph with
  // more than 200 open commitments a duplicate for this person could sit at
  // row 201 and never be seen (REBUILD-MASTER-PLAN §3, "fixed-cap dedup"). The
  // parties are the key: the database is asked only for open promises between
  // exactly these two nodes, and those are walked page by page to the end.
  const norm = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const newKey = norm(description);
  const newWords = new Set(newKey.split(" ").filter((w) => w.length > 2));
  const isSameCommitment = (ex: { description: string }): boolean => {
    const exKey = norm(ex.description);
    if (exKey === newKey) return true;
    // Near-duplicate: >=80% of the shorter description's significant words
    // appear in the other one.
    const exWords = new Set(exKey.split(" ").filter((w) => w.length > 2));
    const [small, big] = exWords.size <= newWords.size ? [exWords, newWords] : [newWords, exWords];
    if (small.size < 3) return false;
    let hit = 0;
    for (const w of small) if (big.has(w)) hit++;
    return hit / small.size >= 0.8;
  };
  const duplicate = await firstMatchPaged<{ id: string; description: string }>(
    (from, to) => {
      // `eq(col, null)` compiles to `= NULL`, which matches nothing on either
      // database; a missing party is an IS NULL.
      let q = supabase
        .from("promises")
        .select("id, description")
        .eq("user_id", userId)
        .in("status", ["open", "expired"]);
      q = committerNodeId
        ? q.eq("committer_node_id", committerNodeId)
        : q.is("committer_node_id", null);
      q = targetNodeId ? q.eq("target_node_id", targetNodeId) : q.is("target_node_id", null);
      return q.order("id", { ascending: true }).range(from, to);
    },
    isSameCommitment,
    PROMISE_PAGE,
  );
  if (duplicate) return duplicate.id;

  const { data: promise } = mustWrite(
    await supabase
      .from("promises")
      .insert({
        user_id: userId,
        direction,
        committer_node_id: committerNodeId,
        target_node_id: targetNodeId,
        description,
        due_at: dueAt,
        source_id: sourceId,
      })
      .select("id")
      .single(),
    "promises",
    "insert",
  );
  if (!promise) return null;
  noteCreated(outcome, "promises", promise.id as string);
  return promise.id;
}

/** Page size for the open-promise walk. Open commitments between one pair of
 *  people rarely reach this; it bounds one read, not the search. */
const PROMISE_PAGE = 200;
