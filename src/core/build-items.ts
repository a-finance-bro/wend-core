/**
 * Shared shaping of pending_writes → ProposalItem[] for the home
 * "Proposed additions" dashboard. Used by the server page render AND by the
 * column-refresh server action, so both produce identical grouping/labels.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDetails } from "./normalize-details.js";

export type ProposalCategory = "person" | "org" | "attribute" | "promise";
export type EntityKind = "person" | "org" | "event" | "location" | "other";

export interface ProposalItem {
  id: string;
  category: ProposalCategory;
  title: string;
  subtitle: string | null;
  source: string;
  created_at: string;
  /** External agent that proposed this via MCP (credential-stamped), for a
   *  "via Claude" badge. Null for in-app and user writes. Kept as a badge
   *  rather than a column so Approve-all keeps draining by conversation. */
  proposedByAgent?: string | null;
  entity: string;
  entityKind: EntityKind;
  isCreation: boolean;
}

type PendingRow = {
  id: string;
  kind: string;
  created_at: string;
  payload: {
    type?: string;
    display_name?: string;
    details?: Array<{ name?: string; value?: string }>;
    detail_name?: string;
    node_id?: string;
    node_name?: string;
    value?: unknown;
    description?: string;
    link_type?: string;
    link_id?: string;
    source?: { id?: string; display_name?: string };
    target?: { id?: string; display_name?: string };
    edits?: Array<{
      field?: string;
      detail_name?: string;
      previous?: string;
      next?: string;
      ended_at?: string;
    }>;
    // merge_nodes
    target_node_id?: string;
    target_name?: string;
    source_name?: string;
    confidence?: string;
  };
  conv_title: string | null;
  proposed_by_agent?: string | null;
};

export function sourceLabel(title?: string | null): string {
  const t = (title ?? "").toLowerCase();
  // Automatic research output gets its own column. Both producers stamp
  // deterministic titles ("Network updates: August 2026" from the rolling
  // refresh, "Web enrichment: <name>" from a manual run). Without these cases
  // they fell through to the catch-all column, which read as chat proposals showing
  // LinkedIn-import people (founder report) — the facts are ABOUT imported
  // people, but the producer is the researcher, and the column should say so.
  if (t.startsWith("network updates")) return "Research";
  if (t.startsWith("web enrichment")) return "Research";
  // Everything an outside agent proposes over MCP lands in a conversation
  // titled "MCP" (see ensureMcpConversation). Naming that column after the
  // protocol would be the one place in the product where the user is asked to
  // know what MCP is, so it says who did the work instead.
  if (t === "mcp") return "Your agent";
  // Browser-extension captures ALWAYS get their own column, regardless of the
  // captured site. Checked FIRST so "Capture · Zara | LinkedIn" doesn't fall
  // through to the LinkedIn-import column. The capture route stamps new
  // conversations with the "Capture · " prefix; "web capture" is its legacy
  // no-title fallback.
  if (t.startsWith("capture ·") || t.startsWith("web capture")) return "Extension";
  // Migrations from another tool ("Import from Dex") get one column of their
  // own. Checked before the per-integration titles so an import from Google
  // Contacts reads as a migration, not as the live Contacts sync.
  if (t.startsWith("import from")) return "Other tools";
  // People typed into the onboarding "add by hand" card get their own column.
  if (t.startsWith("added by hand")) return "Added by hand";
  // Local sources read by Wend for Mac. These are checked BEFORE the generic
  // substring rules below, because "Apple Contacts" contains "contact" and
  // "Apple Calendar" contains "calendar" — without these they would land in
  // the Google columns and claim a provenance they do not have.
  if (t.includes("whatsapp")) return "WhatsApp";
  if (t.includes("imessage")) return "iMessage";
  if (t.includes("apple contacts")) return "Apple Contacts";
  if (t.includes("apple calendar")) return "Apple Calendar";
  if (t.includes("apple mail")) return "Apple Mail";
  if (t.includes("granola")) return "Granola";
  if (t.includes("fireflies")) return "Fireflies";
  if (t.includes("gmail")) return "Gmail";
  if (t.includes("calendar")) return "Calendar";
  if (t.includes("contact")) return "Google Contacts";
  if (t.includes("linkedin")) return "LinkedIn";
  if (t.includes("spreadsheet") || t.includes("csv")) return "Spreadsheets";
  if (t.includes("upload") || t.includes("import")) return "Uploads";
  // Catch-all. With the in-app chat gone, anything that did not name its own
  // producer was proposed by an agent working on the user's behalf.
  return "Your agent";
}

const entityKindOf = (nodeType?: string): EntityKind =>
  nodeType === "Organization"
    ? "org"
    : nodeType === "Event"
      ? "event"
      : nodeType === "Location"
        ? "location"
        : nodeType === "Person"
          ? "person"
          : "other";

// Takes `unknown`, not an array type, on purpose: this reads a model-written
// JSONB payload, and a map-shaped `details` from an agent crashed the whole
// dashboard here with "a?.find is not a function".
const detailVal = (details: unknown, name: string) =>
  normalizeDetails(details).find((d) => d.name === name)?.value || null;

/**
 * Fetch + shape all pending proposals for a user into grouped ProposalItems.
 * `perConv`/`total` bound the per-conversation and overall row counts so one
 * huge import can't starve other sources.
 */
export async function buildProposalItems(
  supabase: SupabaseClient,
  userId: string,
  opts: { perConv?: number; total?: number } = {},
): Promise<{
  items: ProposalItem[];
  totalCount: number;
  /** TRUE pending rows per source column, uncapped. The dashboard fetch is
   *  bounded (300/conversation), and hiding that bound made a 5,000-row
   *  backlog look like "exactly 300" and made Accept all look broken when
   *  the columns refilled after a reload. */
  sourceTotals: Record<string, number>;
}> {
  const { data: rpcData } = await supabase.rpc(
    "pending_writes_recent_by_conversation",
    { p_per_conv: opts.perConv ?? 300, p_total: opts.total ?? 3000 },
  );
  const pendingRows = (rpcData ?? []) as unknown as PendingRow[];

  const { count } = await supabase
    .from("pending_writes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending");

  // Resolve referenced node names (for grouping details/promises/edits + link
  // endpoints) so every row anchors to the right entity + kind.
  const refIds = new Set<string>();
  const refLinkIds = new Set<string>();
  for (const r of pendingRows) {
    const nid = r.payload?.node_id;
    if (nid && r.kind !== "create_node") refIds.add(nid);
    if (r.kind === "create_link") {
      if (r.payload?.source?.id) refIds.add(r.payload.source.id);
      if (r.payload?.target?.id) refIds.add(r.payload.target.id);
    }
    const lid = r.payload?.link_id;
    if (lid && (r.kind === "add_link_detail" || r.kind === "add_detail")) {
      refLinkIds.add(lid);
    }
  }
  const linkSourceByLinkId = new Map<string, string>();
  if (refLinkIds.size > 0) {
    const { data: refLinks } = await supabase
      .from("links")
      .select("id, source_node_id")
      .eq("user_id", userId)
      .in("id", [...refLinkIds].slice(0, 200));
    for (const l of (refLinks ?? []) as Array<{ id: string; source_node_id: string }>) {
      linkSourceByLinkId.set(l.id, l.source_node_id);
      refIds.add(l.source_node_id);
    }
  }
  const nodeNameById = new Map<string, { name: string; type: string }>();
  if (refIds.size > 0) {
    const { data: refNodes } = await supabase
      .from("nodes")
      .select("id, display_name, node_types(name)")
      .eq("user_id", userId)
      .in("id", [...refIds].slice(0, 400));
    for (const n of (refNodes ?? []) as unknown as Array<{
      id: string;
      display_name: string;
      node_types: { name?: string } | { name?: string }[] | null;
    }>) {
      const nt = Array.isArray(n.node_types) ? n.node_types[0] : n.node_types;
      nodeNameById.set(n.id, { name: n.display_name, type: nt?.name ?? "Person" });
    }
  }

  const kindByName = new Map<string, EntityKind>();
  for (const r of pendingRows) {
    if (r.kind === "create_node") {
      const name = (r.payload?.display_name ?? "").trim().toLowerCase();
      if (name) kindByName.set(name, entityKindOf(r.payload?.type ?? "Person"));
    }
  }
  for (const [, ref] of nodeNameById) {
    kindByName.set(ref.name.trim().toLowerCase(), entityKindOf(ref.type));
  }

  const items = pendingRows
    .map((r): ProposalItem | null => {
      const source = sourceLabel(r.conv_title);
      const base = { id: r.id, source, created_at: r.created_at, proposedByAgent: r.proposed_by_agent ?? null };
      if (r.kind === "create_node") {
        const name = (r.payload?.display_name ?? "").trim();
        if (!name) return null;
        const d = r.payload?.details;
        const title = detailVal(d, "title");
        const company = detailVal(d, "company") ?? detailVal(d, "current_company");
        const subtitle =
          title && company
            ? `${title} at ${company}`
            : title || company || detailVal(d, "email") || null;
        const nodeType = r.payload?.type ?? "Person";
        return {
          ...base,
          category:
            nodeType === "Organization"
              ? ("org" as const)
              : nodeType === "Location"
                ? ("attribute" as const)
                : ("person" as const),
          title: name,
          subtitle,
          entity: name,
          entityKind: entityKindOf(nodeType),
          isCreation: true,
        };
      }
      if (r.kind === "create_link") {
        const from = (r.payload?.source?.display_name ?? "").trim();
        const to = (r.payload?.target?.display_name ?? "").trim();
        if (!from && !to) return null;
        const srcRef = r.payload?.source?.id
          ? nodeNameById.get(r.payload.source.id)
          : undefined;
        const anchor = srcRef?.name ?? (from || to);
        const anchorKind = srcRef
          ? entityKindOf(srcRef.type)
          : kindByName.get(anchor.trim().toLowerCase()) ?? "person";
        return {
          ...base,
          category: "attribute" as const,
          title: `→ ${to || "?"}`,
          subtitle: r.payload?.link_type ?? null,
          entity: anchor,
          entityKind: anchorKind,
          isCreation: false,
        };
      }
      if (r.kind === "add_detail" || r.kind === "add_link_detail") {
        const value = String(r.payload?.value ?? "").trim();
        if (!value) return null;
        const lid = r.payload?.link_id;
        const nid = r.payload?.node_id ?? (lid ? linkSourceByLinkId.get(lid) : undefined);
        const ref = nid ? nodeNameById.get(nid) : undefined;
        return {
          ...base,
          category: "attribute" as const,
          title: value.length > 90 ? `${value.slice(0, 89)}…` : value,
          subtitle: r.payload?.detail_name ?? null,
          entity: ref?.name ?? "Details",
          entityKind: entityKindOf(ref?.type),
          isCreation: false,
        };
      }
      if (r.kind === "edit_node") {
        const ref = r.payload?.node_id ? nodeNameById.get(r.payload.node_id) : undefined;
        const entity = ref?.name ?? r.payload?.node_name ?? "Edits";
        const edits = Array.isArray(r.payload?.edits) ? r.payload.edits : [];
        const first = edits[0];
        // An end has no `next`, so the plain before→after label would render as
        // "current company: Stripe → " and read like a broken row. It gets its
        // own sentence: what stopped, and when it stopped if the user said.
        const label = first
          ? first.field === "name"
            ? `rename → ${first.next ?? ""}`
            : first.field === "end_detail"
              ? `${(first.detail_name ?? "detail").replace(/_/g, " ")}: ${first.previous || "current value"} ended${
                  first.ended_at ? ` ${String(first.ended_at).slice(0, 10)}` : ""
                }`
              : `${(first.detail_name ?? "detail").replace(/_/g, " ")}: ${first.previous ?? "(unset)"} → ${first.next ?? ""}`
          : "edit";
        return {
          ...base,
          category: "attribute" as const,
          title: label.length > 90 ? `${label.slice(0, 89)}…` : label,
          subtitle: edits.length > 1 ? `+${edits.length - 1} more edit${edits.length > 2 ? "s" : ""}` : "edit",
          entity,
          entityKind: ref ? entityKindOf(ref.type) : "person",
          isCreation: false,
        };
      }
      if (r.kind === "merge_nodes") {
        // Rendered as an attribute row on the person being KEPT, so it lands in
        // that person's group rather than floating in a category of its own.
        const keep = r.payload?.target_node_id
          ? nodeNameById.get(r.payload.target_node_id)
          : undefined;
        const keepName = keep?.name ?? r.payload?.target_name ?? "this entry";
        const loseName = r.payload?.source_name ?? "another entry";
        const confidence = String(r.payload?.confidence ?? "likely");
        return {
          ...base,
          category: "attribute" as const,
          title: `Same person as ${loseName}`,
          subtitle:
            confidence === "unsure"
              ? "spelling unsure - approve to combine them"
              : "approve to combine them into one",
          entity: keepName,
          entityKind: keep ? entityKindOf(keep.type) : "person",
          isCreation: false,
        };
      }
      if (r.kind === "create_promise") {
        const desc = String(r.payload?.description ?? "").trim();
        if (!desc) return null;
        const ref = r.payload?.node_id ? nodeNameById.get(r.payload.node_id) : undefined;
        const counterparty = ref?.name ?? r.payload?.target?.display_name ?? null;
        return {
          ...base,
          category: "promise" as const,
          title: desc,
          subtitle: null,
          entity: counterparty || "Promises",
          entityKind: ref ? entityKindOf(ref.type) : "person",
          isCreation: false,
        };
      }
      return null;
    })
    .filter((p): p is ProposalItem => p !== null);

  // Uncapped per-source counts. PostgREST cannot GROUP BY, so count per
  // conversation (bounded set) and roll up by the same label mapping.
  const sourceTotals: Record<string, number> = {};
  try {
    const { data: convRows } = await supabase
      .from("conversations")
      .select("id, title")
      .eq("user_id", userId)
      .limit(2000);
    const convs = (convRows ?? []) as Array<{ id: string; title: string | null }>;
    const byLabel = new Map<string, string[]>();
    for (const c of convs) {
      const label = sourceLabel(c.title);
      byLabel.set(label, [...(byLabel.get(label) ?? []), c.id]);
    }
    await Promise.all(
      [...byLabel.entries()].map(async ([label, ids]) => {
        const { count: c } = await supabase
          .from("pending_writes")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("status", "pending")
          .in("conversation_id", ids);
        if ((c ?? 0) > 0) sourceTotals[label] = c ?? 0;
      }),
    );
  } catch {
    /* totals are display sugar; the dashboard works without them */
  }

  return { items, totalCount: count ?? items.length, sourceTotals };
}
