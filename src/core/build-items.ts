/**
 * Shared shaping of pending_writes → ProposalItem[] for the home
 * "Proposed additions" dashboard. Used by the server page render AND by the
 * column-refresh server action, so both produce identical grouping/labels.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ProposalCategory = "person" | "org" | "attribute" | "promise";
export type EntityKind = "person" | "org" | "event" | "location" | "other";

export interface ProposalItem {
  id: string;
  category: ProposalCategory;
  title: string;
  subtitle: string | null;
  source: string;
  created_at: string;
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
    edits?: Array<{ field?: string; detail_name?: string; previous?: string; next?: string }>;
  };
  conv_title: string | null;
};

function sourceLabel(title?: string | null): string {
  const t = (title ?? "").toLowerCase();
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
  if (t.includes("gmail")) return "Inbox";
  if (t.includes("calendar")) return "Calendar";
  if (t.includes("contact")) return "Google Contacts";
  if (t.includes("linkedin")) return "LinkedIn";
  if (t.includes("spreadsheet") || t.includes("csv")) return "Spreadsheets";
  if (t.includes("upload") || t.includes("import")) return "Uploads";
  return "Wend chats";
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

const detailVal = (
  details: Array<{ name?: string; value?: string }> | undefined,
  name: string,
) => details?.find((d) => d.name === name)?.value?.trim() || null;

/**
 * Fetch + shape all pending proposals for a user into grouped ProposalItems.
 * `perConv`/`total` bound the per-conversation and overall row counts so one
 * huge import can't starve other sources.
 */
export async function buildProposalItems(
  supabase: SupabaseClient,
  userId: string,
  opts: { perConv?: number; total?: number } = {},
): Promise<{ items: ProposalItem[]; totalCount: number }> {
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
      const base = { id: r.id, source, created_at: r.created_at };
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
        const label = first
          ? first.field === "name"
            ? `rename → ${first.next ?? ""}`
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

  return { items, totalCount: count ?? items.length };
}
