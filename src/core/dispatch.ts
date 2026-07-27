/**
 * Reference dispatch for the open graph tool set.
 *
 * Reads query the graph directly; writes insert `pending_writes` proposals —
 * NEVER graph rows. Confirmation is a human act: your UI calls the apply
 * functions (src/core/apply.ts) for rows the user approved. There is
 * deliberately no "confirm" capability here, so no agent — however prompted —
 * can approve its own writes. That asymmetry is the whole trust model.
 */

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeForMatch } from "./apply.js";
import { recallNodes } from "./recall.js";
import { GRAPH_TOOLS } from "./tool-definitions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export interface ToolContext {
  supabase: Db;
  userId: string;
  /** Groups the proposals of one agent run for batch review. */
  conversationId: string;
  batchId: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function makeToolContext(supabase: Db, userId: string, conversationId: string): ToolContext {
  return { supabase, userId, conversationId, batchId: randomUUID() };
}

type MatchQuality = "exact" | "strong" | "weak_partial";

function classifyMatch(query: string, displayName: string): MatchQuality {
  const q = query.trim().toLowerCase();
  const d = displayName.trim().toLowerCase();
  if (q === d || normalizeForMatch(query) === normalizeForMatch(displayName)) return "exact";
  const words = new Set(d.split(/\s+/));
  const qWords = q.split(/\s+/).filter(Boolean);
  if (qWords.every((w) => words.has(w))) return "strong";
  return "weak_partial";
}

async function pendingWrite(
  ctx: ToolContext,
  kind: string,
  payload: Record<string, unknown>,
): Promise<ToolResult> {
  const { error } = await ctx.supabase.from("pending_writes").insert({
    user_id: ctx.userId,
    batch_id: ctx.batchId,
    conversation_id: ctx.conversationId,
    kind,
    payload,
  });
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    data: {
      proposed: kind,
      status: "pending_review",
      note: "Saved as a proposal. The user reviews and confirms it in their Wend inbox before it touches the graph.",
    },
  };
}

export async function dispatchToolCall(
  ctx: ToolContext,
  toolName: string,
  toolInput: unknown,
): Promise<ToolResult> {
  const args = (toolInput ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "findNodeByName": {
      const name = String(args.name ?? "").trim();
      if (!name) return { ok: false, error: "name is required" };
      let q = ctx.supabase
        .from("nodes")
        .select("id, display_name, node_types!inner(name)")
        .eq("user_id", ctx.userId)
        .is("deleted_at", null)
        .ilike("display_name", `%${name}%`)
        .limit(12);
      const typeFilter = String(args.type ?? "").trim();
      if (typeFilter) q = q.ilike("node_types.name", typeFilter);
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      const matches = (data ?? []).map((r) => {
        const row = r as { id: string; display_name: string; node_types: { name: string } | { name: string }[] };
        const t = Array.isArray(row.node_types) ? row.node_types[0]?.name : row.node_types?.name;
        return {
          id: row.id,
          display_name: row.display_name,
          type: t ?? null,
          match_quality: classifyMatch(name, row.display_name),
        };
      });
      return { ok: true, data: { matches } };
    }

    case "recallNodes": {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "query is required" };
      const limit = Number(args.limit ?? 8);
      try {
        const hits = await recallNodes(ctx.supabase, query, Number.isFinite(limit) ? limit : 8);
        return { ok: true, data: { hits } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "recall failed" };
      }
    }

    case "getNodeDetails": {
      const nodeId = String(args.node_id ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(nodeId)) return { ok: false, error: "node_id must be a UUID" };
      const [{ data: node }, { data: detailRows }, { data: outLinks }, { data: inLinks }] =
        await Promise.all([
          ctx.supabase
            .from("nodes")
            .select("id, display_name, notes, created_at, node_types(name)")
            .eq("user_id", ctx.userId)
            .eq("id", nodeId)
            .is("deleted_at", null)
            .maybeSingle(),
          ctx.supabase
            .from("node_details")
            .select("value, source_id, user_confirmed, created_at, detail_definitions(name)")
            .eq("user_id", ctx.userId)
            .eq("node_id", nodeId)
            .is("deleted_at", null),
          ctx.supabase
            .from("links")
            .select("id, link_types(name), target:nodes!links_target_node_id_fkey(id, display_name)")
            .eq("user_id", ctx.userId)
            .eq("source_node_id", nodeId),
          ctx.supabase
            .from("links")
            .select("id, link_types(name), source:nodes!links_source_node_id_fkey(id, display_name)")
            .eq("user_id", ctx.userId)
            .eq("target_node_id", nodeId),
        ]);
      if (!node) return { ok: false, error: "Node not found." };
      return {
        ok: true,
        data: { node, details: detailRows ?? [], links_out: outLinks ?? [], links_in: inLinks ?? [] },
      };
    }

    case "proposeCreateNode":
      return pendingWrite(ctx, "create_node", {
        type: args.type,
        display_name: args.display_name,
        details: args.details,
      });
    case "proposeCreateLink":
      return pendingWrite(ctx, "create_link", {
        link_type: args.link_type,
        source: args.source,
        target: args.target,
        details: args.details,
      });
    case "proposeAddDetail":
      return pendingWrite(ctx, "add_detail", {
        node_id: args.node_id,
        detail_name: args.detail_name,
        value: args.value,
      });
    case "proposeAddLinkDetail":
      return pendingWrite(ctx, "add_link_detail", {
        link_id: args.link_id,
        detail_name: args.detail_name,
        value: args.value,
      });
    case "proposeEditNode":
      return pendingWrite(ctx, "edit_node", { node_id: args.node_id, edits: args.edits });
    case "flagPromise":
      return pendingWrite(ctx, "create_promise", {
        direction: args.direction,
        description: args.description,
        target: args.target,
        due_at: args.due_at ?? "",
      });

    default:
      return {
        ok: false,
        error: `Unknown tool "${toolName}". Available: ${GRAPH_TOOLS.map((t) => t.name).join(", ")}`,
      };
  }
}
