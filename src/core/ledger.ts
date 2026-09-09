/**
 * The typed interaction ledger (Part 10): reciprocity as structured rows.
 *
 * Wend already records favors and gifts, as pipe-encoded detail VALUES on a
 * person (life-facts.ts: "owed_to_me | fifty dollars | open"). That is fine for
 * "what favors are open with Sarah" and useless for "who owes me money", which
 * is a question about an amount across everyone. This promotes those facts to
 * rows in `interaction_ledger` with a real amount, currency, direction and a
 * settle-state, so the money questions are a flat SQL read with no model call,
 * identical on Postgres and the SQLite shim.
 *
 * life-facts.ts keeps working for everything not promoted; this is the queryable
 * projection, not a replacement. The one-time promotion (migrateLifeFactsToLedger)
 * is insert-only, name-keyed on the origin detail id, and idempotent.
 *
 * A directly-recorded entry carries `user_typed` provenance, the same choice
 * every hand-recorded fact makes. Provenance is mandatory: the writer refuses
 * without a source, exactly as a Moment does.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseFavor, parseGift } from "./life-facts.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const LEDGER_KINDS = [
  "gift_given",
  "gift_received",
  "favor_owed",
  "favor_done",
  "debt",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export type LedgerDirection = "owed_by_me" | "owed_to_me" | "none";

export interface RecordLedgerInput {
  node_id: string;
  kind: LedgerKind;
  description: string;
  amount?: number | null;
  currency?: string | null;
  direction?: LedgerDirection | null;
  /** ISO date of the event or milestone (a gift's date, a debt's due date). */
  date?: string | null;
}

export interface LedgerEntry {
  id: string;
  node_id: string;
  kind: LedgerKind;
  description: string;
  amount: number | null;
  currency: string | null;
  direction: LedgerDirection | null;
  date: string | null;
  settled: boolean;
  settled_at: string | null;
}

/** A recall hit, structurally identical to StructuredHit so recall can map it. */
export interface LedgerHit {
  id: string;
  display_name: string;
  node_type_name: string;
  reason: string;
}

export interface RecordLedgerResult {
  ok: boolean;
  id?: string;
  reminderCreated?: boolean;
  error?: string;
}

/** True on both arms: SQLite stores 0/1, Postgres a boolean. */
function isSettled(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

/**
 * Record one ledger entry directly.
 *
 * A ledger entry is account bookkeeping about a relationship, the same category
 * as an `interactions` touchpoint — it is not a graph FACT in `node_details`,
 * so it does not go through the proposal/approval queue any more than
 * iReachedOut does. Provenance is still mandatory.
 *
 * A future milestone date on an unsettled entry MATERIALIZES A REMINDER: a
 * `promise` with that due date, so "I owe Sarah $50 by Friday" surfaces in
 * Today rather than living only in a ledger nobody opens. Best-effort; a
 * reminder failure never fails the ledger write.
 */
export async function recordLedgerEntry(
  db: Db,
  userId: string,
  input: RecordLedgerInput,
  now: Date = new Date(),
): Promise<RecordLedgerResult> {
  const nodeId = (input.node_id ?? "").trim();
  if (!nodeId) return { ok: false, error: "A ledger entry needs a person (node_id)." };
  if (!LEDGER_KINDS.includes(input.kind)) {
    return { ok: false, error: `Unknown ledger kind '${input.kind}'.` };
  }
  const description = (input.description ?? "").trim();
  if (!description) return { ok: false, error: "A ledger entry needs a description." };

  const amount =
    typeof input.amount === "number" && Number.isFinite(input.amount) ? input.amount : null;
  const currency = amount != null && input.currency ? input.currency.trim().toUpperCase().slice(0, 8) : null;
  const direction = normalizeDirection(input.direction);
  const date = normalizeDate(input.date);

  // Provenance, mandatory.
  const { data: src, error: srcErr } = await db
    .from("sources")
    .insert({
      user_id: userId,
      source_type: "user_typed",
      display_label: "Ledger entry",
      context_text: description.slice(0, 500),
      metadata: { ledger: true, kind: input.kind },
    })
    .select("id")
    .single();
  if (srcErr || !(src as { id?: string } | null)?.id) {
    return { ok: false, error: srcErr?.message ?? "Could not record where this entry came from." };
  }
  const sourceId = (src as { id: string }).id;

  const { data: row, error } = await db
    .from("interaction_ledger")
    .insert({
      user_id: userId,
      node_id: nodeId,
      kind: input.kind,
      description,
      amount,
      currency,
      direction,
      date,
      settled: false,
      source_id: sourceId,
    })
    .select("id")
    .single();
  if (error || !(row as { id?: string } | null)?.id) {
    return { ok: false, error: error?.message ?? "Could not save the ledger entry." };
  }
  const id = (row as { id: string }).id;

  const reminderCreated = await maybeMaterializeReminder(db, userId, {
    nodeId,
    kind: input.kind,
    description,
    amount,
    currency,
    direction,
    date,
    sourceId,
    now,
  });

  return { ok: true, id, reminderCreated };
}

/** Mark a ledger entry settled (a debt repaid, a favor returned). */
export async function settleLedgerEntry(
  db: Db,
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; error?: string }> {
  const clean = (id ?? "").trim();
  if (!clean) return { ok: false, error: "Which entry? (id)" };
  const { error } = await db
    .from("interaction_ledger")
    .update({ settled: true, settled_at: now.toISOString() })
    .eq("user_id", userId)
    .eq("id", clean);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** A person's whole ledger, newest first. Settled entries included, flagged. */
export async function listLedgerForNode(
  db: Db,
  userId: string,
  nodeId: string,
): Promise<LedgerEntry[]> {
  const clean = (nodeId ?? "").trim();
  if (!clean) return [];
  const { data } = await db
    .from("interaction_ledger")
    .select("id, node_id, kind, description, amount, currency, direction, date, settled, settled_at")
    .eq("user_id", userId)
    .eq("node_id", clean)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  return ((data ?? []) as Array<Record<string, unknown>>).map(toEntry);
}

// ─────────────────────────────────────────────────────────── recall

export type LedgerIntent =
  | { kind: "owed_to_me" }
  | { kind: "owed_by_me" }
  | { kind: "given_to"; names: string[] }
  | { kind: "received_from"; names: string[] };

/**
 * Does the query ask a ledger question this module answers exactly?
 *
 * Deliberately tight, like matchedLifeIntent: a false match runs queries AND
 * outranks a good semantic hit. Money questions require a self reference; gift
 * HISTORY questions ("what did I give X") are distinct from gift IDEAS ("gift
 * ideas for X"), which life-facts.ts still owns.
 */
export function matchedLedgerIntent(query: string): LedgerIntent | null {
  const q = query.toLowerCase();
  const self = /\b(my|our|mine|i|me|us|we)\b/i.test(query);

  // Money / debts / owing FIRST, so "give me a list of who owes me" is a money
  // question, not a gift-history one. Needs a self reference so "owe" is not
  // idiom ("she owes her success to...").
  if (self && (/\bowes?\b/.test(q) || /\bowed\b/.test(q) || /\bdebts?\b/.test(q) || /\bpay me back\b/.test(q))) {
    const toMe = /\b(owes? me|owe me|owed to me|who owes|pay me back|owe us)\b/.test(q);
    const byMe = /\b(do i owe|i owe|we owe|my debts?|money i owe)\b/.test(q);
    if (byMe && !toMe) return { kind: "owed_by_me" };
    return { kind: "owed_to_me" };
  }

  // "what did I give Sarah", "gifts I gave X", "what have I given X". The gift
  // HISTORY, distinct from gift IDEAS ("gift ideas for X"), which life-facts.ts
  // owns.
  if (/\b(gave|given|give)\b/.test(q) && !/\bgift ideas?\b/.test(q)) {
    if (/\b(to me|give me|gave me|given to me)\b/.test(q)) {
      return { kind: "received_from", names: ledgerTargetNames(query) };
    }
    return { kind: "given_to", names: ledgerTargetNames(query) };
  }

  return null;
}

/**
 * Answer a ledger question with a flat read. Returns [] when the query is not a
 * ledger question, which is the common case and costs one regex.
 *
 * Two reads, the life-facts pattern: the ledger rows, then the nodes they name.
 * Identical on Postgres and the shim.
 */
export async function ledgerRecall(
  db: Db,
  userId: string,
  query: string,
  limit: number,
): Promise<LedgerHit[]> {
  const intent = matchedLedgerIntent(query);
  if (!intent) return [];

  let rows: LedgerRow[];
  if (intent.kind === "owed_to_me" || intent.kind === "owed_by_me") {
    const direction = intent.kind === "owed_to_me" ? "owed_to_me" : "owed_by_me";
    // Debts and open favors that are directional, unsettled, in this direction.
    rows = (await ledgerRows(db, userId, { kinds: ["debt", "favor_owed"] })).filter(
      (r) => !isSettled(r.settled) && (r.direction === direction || r.direction == null),
    );
    // Money questions rank a priced entry first; a bare favor still surfaces.
    rows.sort((a, b) => Number(b.amount != null) - Number(a.amount != null));
  } else {
    const kind = intent.kind === "given_to" ? "gift_given" : "gift_received";
    rows = await ledgerRows(db, userId, { kinds: [kind] });
    if (intent.names.length > 0) {
      rows = rows.filter((r) =>
        intent.names.some((n) => (r.node?.display_name ?? "").toLowerCase().includes(n)),
      );
    }
  }

  const out: LedgerHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.node || r.node.deleted_at) continue;
    // Dedup by (person, row) so one person with two debts shows once per debt
    // but never twice for the same row.
    const key = `${r.node.id}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.node.id,
      display_name: r.node.display_name,
      node_type_name: r.node.node_types?.name ?? "Person",
      reason: hitReason(intent, r),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function hitReason(intent: LedgerIntent, r: LedgerRow): string {
  const money = r.amount != null ? formatMoney(r.amount, r.currency) : null;
  const what = r.description.slice(0, 60);
  if (intent.kind === "owed_to_me") {
    return money ? `owes you ${money}: ${what}` : `owes you: ${what}`;
  }
  if (intent.kind === "owed_by_me") {
    return money ? `you owe them ${money}: ${what}` : `you owe them: ${what}`;
  }
  if (intent.kind === "given_to") {
    return `you gave: ${what}${r.date ? ` (${r.date})` : ""}`;
  }
  return `they gave you: ${what}${r.date ? ` (${r.date})` : ""}`;
}

// ─────────────────────────────────────────────────────────── promotion

/**
 * Promote existing life-facts pipe values into ledger rows, once.
 *
 * Runs on the Mac at engine boot (the hosted side does the same in migration
 * 199's SQL). Insert-only and name-keyed on the origin detail id, so the unique
 * index on (user_id, origin_key) makes a second run a no-op. Provenance is
 * inherited: the ledger row points at the same source as the detail.
 *
 * Returns the number of new rows written. Idempotent: a re-run returns 0.
 */
export async function migrateLifeFactsToLedger(
  db: Db,
  userId: string,
): Promise<{ promoted: number }> {
  // The three reciprocity definitions this promotes.
  const { data: defs } = await db
    .from("detail_definitions")
    .select("id, name")
    .eq("user_id", userId)
    .in("name", ["favor_owed", "gift_given", "gift_received"]);
  const defRows = (defs ?? []) as Array<{ id: string; name: string }>;
  if (defRows.length === 0) return { promoted: 0 };
  const nameByDef = new Map(defRows.map((d) => [d.id, d.name]));

  const { data: details } = await db
    .from("node_details")
    .select("id, node_id, value, detail_definition_id, source_id")
    .eq("user_id", userId)
    .in("detail_definition_id", defRows.map((d) => d.id))
    .is("deleted_at", null)
    .limit(2000);
  const detailRows = (details ?? []) as Array<{
    id: string;
    node_id: string;
    value: unknown;
    detail_definition_id: string;
    source_id: string | null;
  }>;
  if (detailRows.length === 0) return { promoted: 0 };

  // Which origin keys are already promoted, so a re-run inserts nothing twice.
  const { data: existing } = await db
    .from("interaction_ledger")
    .select("origin_key")
    .eq("user_id", userId)
    .not("origin_key", "is", null);
  const already = new Set(
    ((existing ?? []) as Array<{ origin_key: string | null }>).map((r) => r.origin_key).filter(Boolean),
  );

  const toInsert: Array<Record<string, unknown>> = [];
  for (const d of detailRows) {
    if (already.has(d.id)) continue;
    if (!d.source_id) continue; // provenance mandatory; a sourceless detail is skipped
    const name = nameByDef.get(d.detail_definition_id);
    if (!name) continue;

    if (name === "favor_owed") {
      const favor = parseFavor(d.value);
      toInsert.push({
        user_id: userId,
        node_id: d.node_id,
        kind: "favor_owed",
        description: favor.what || String(d.value ?? "").trim() || "favor",
        direction: favor.direction ?? null,
        settled: favor.settled,
        source_id: d.source_id,
        origin_key: d.id,
      });
    } else {
      const gift = parseGift(d.value);
      toInsert.push({
        user_id: userId,
        node_id: d.node_id,
        kind: name, // gift_given | gift_received
        description: gift.gift || String(d.value ?? "").trim() || "gift",
        direction: "none",
        date: gift.date ?? null,
        settled: name === "gift_given" || name === "gift_received", // a gift is a done thing
        source_id: d.source_id,
        origin_key: d.id,
      });
    }
  }
  if (toInsert.length === 0) return { promoted: 0 };

  const { error } = await db.from("interaction_ledger").insert(toInsert);
  // A unique-violation on origin_key means a concurrent run beat us; that is the
  // idempotency working, not a failure. Anything else is real.
  if (error && !/unique|duplicate|constraint/i.test(error.message)) {
    return { promoted: 0 };
  }
  return { promoted: toInsert.length };
}

// ─────────────────────────────────────────────────────────── internals

interface LedgerNode {
  id: string;
  display_name: string;
  node_types: { name: string } | null;
  deleted_at: string | null;
}

interface LedgerRow {
  id: string;
  node_id: string;
  kind: string;
  description: string;
  amount: number | null;
  currency: string | null;
  direction: LedgerDirection | null;
  date: string | null;
  settled: unknown;
  node: LedgerNode | null;
}

async function ledgerRows(
  db: Db,
  userId: string,
  opts: { kinds: string[] },
): Promise<LedgerRow[]> {
  const { data } = await db
    .from("interaction_ledger")
    .select("id, node_id, kind, description, amount, currency, direction, date, settled")
    .eq("user_id", userId)
    .in("kind", opts.kinds)
    .is("deleted_at", null)
    .limit(500);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  const nodeIds = [...new Set(rows.map((r) => String(r.node_id)))];
  const { data: nodes } = await db
    .from("nodes")
    .select("id, display_name, deleted_at, node_types(name)")
    .eq("user_id", userId)
    .in("id", nodeIds);
  const byId = new Map(
    ((nodes ?? []) as unknown as LedgerNode[]).map((n) => [n.id, n]),
  );

  return rows.map((r) => ({
    id: String(r.id),
    node_id: String(r.node_id),
    kind: String(r.kind),
    description: String(r.description ?? ""),
    amount: r.amount == null ? null : Number(r.amount),
    currency: r.currency == null ? null : String(r.currency),
    direction: (r.direction as LedgerDirection | null) ?? null,
    date: r.date == null ? null : String(r.date),
    settled: r.settled,
    node: byId.get(String(r.node_id)) ?? null,
  }));
}

function toEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    id: String(r.id),
    node_id: String(r.node_id),
    kind: r.kind as LedgerKind,
    description: String(r.description ?? ""),
    amount: r.amount == null ? null : Number(r.amount),
    currency: r.currency == null ? null : String(r.currency),
    direction: (r.direction as LedgerDirection | null) ?? null,
    date: r.date == null ? null : String(r.date),
    settled: isSettled(r.settled),
    settled_at: r.settled_at == null ? null : String(r.settled_at),
  };
}

async function maybeMaterializeReminder(
  db: Db,
  userId: string,
  ctx: {
    nodeId: string;
    kind: LedgerKind;
    description: string;
    amount: number | null;
    currency: string | null;
    direction: LedgerDirection | null;
    date: string | null;
    sourceId: string;
    now: Date;
  },
): Promise<boolean> {
  // Only a future due date on an obligation earns a reminder. A gift already
  // given is done; a debt or favor with a date ahead is a thing to act on.
  if (!ctx.date) return false;
  if (ctx.kind !== "debt" && ctx.kind !== "favor_owed") return false;
  const due = Date.parse(ctx.date);
  if (Number.isNaN(due) || due <= ctx.now.getTime()) return false;

  const money = ctx.amount != null ? ` ${formatMoney(ctx.amount, ctx.currency)}` : "";
  const description =
    ctx.direction === "owed_by_me"
      ? `Return${money}: ${ctx.description}`.slice(0, 300)
      : `Follow up on${money} owed to you: ${ctx.description}`.slice(0, 300);
  const promiseDirection = ctx.direction === "owed_by_me" ? "user_to_other" : "other_to_user";

  try {
    const { error } = await db.from("promises").insert({
      user_id: userId,
      direction: promiseDirection,
      target_node_id: ctx.nodeId,
      description,
      due_at: new Date(due).toISOString(),
      status: "open",
      source_id: ctx.sourceId,
      kind: "follow_up",
    });
    return !error;
  } catch {
    return false;
  }
}

function normalizeDirection(d: string | null | undefined): LedgerDirection | null {
  if (d === "owed_by_me" || d === "owed_to_me" || d === "none") return d;
  return null;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  if (m) return value.trim().slice(0, 10);
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function formatMoney(amount: number, currency: string | null): string {
  const symbol = currency === "USD" || currency == null ? "$" : "";
  const body = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return symbol ? `${symbol}${body}` : `${body} ${currency}`;
}

/** Capitalized runs then "to/from X", like giftTargetNames in structured-recall. */
function ledgerTargetNames(query: string): string[] {
  const caps = Array.from(
    new Set(
      (query.match(/"([^"]+)"|\b([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*)*)/g) ?? [])
        .map((m) => m.replace(/"/g, "").trim().toLowerCase())
        .filter(
          (m) =>
            m.length >= 2 &&
            !/^(i|my|who|what|where|the|anyone|someone|people|do|does|is|are|give|given|gave|to|from|me)$/i.test(m),
        ),
    ),
  );
  if (caps.length > 0) return caps.slice(0, 3);
  const after = /\b(?:to|for)\s+([a-z][\w'-]*(?:\s+[a-z][\w'-]*)?)\s*\??$/i.exec(query.trim());
  return after ? [after[1].toLowerCase()] : [];
}
