/**
 * The wend-core MCP server: JSON-RPC message handling over the graph tools.
 *
 * Two meta-tools keep the surface lean as capabilities grow: `search`
 * discovers capabilities (names, descriptions, JSON schemas), `execute` runs
 * one. Writes always land as pending_writes proposals — see
 * src/core/dispatch.ts for the governance model. Transport is up to you;
 * examples/serve.ts wires this to a plain node:http Streamable-HTTP server.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { dispatchToolCall, makeToolContext } from "../core/dispatch.js";
import { GRAPH_TOOLS, type ToolDefinition } from "../core/tool-definitions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "wend-core", version: "0.1.0" };

export interface Capability extends ToolDefinition {}

export function listCapabilities(): Capability[] {
  return GRAPH_TOOLS;
}

export function searchCapabilities(query?: string): Capability[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return GRAPH_TOOLS;
  const terms = q.split(/\s+/).filter(Boolean);
  return GRAPH_TOOLS.filter((c) => {
    const hay = `${c.name} ${c.description}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

export const META_TOOLS = [
  {
    name: "search",
    description:
      "Discover capabilities of this relationship-memory graph (people, organizations, events; every fact carries a source). Call with no arguments to list everything, or pass a query to filter. Returns names, descriptions, and JSON parameter schemas for use with `execute`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional keyword filter." },
      },
    },
  },
  {
    name: "execute",
    description:
      "Run one capability by exact name (discover names via `search`). Reads return graph data with provenance. Writes NEVER commit directly: they create proposals the user reviews and confirms — say so after proposing.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string" },
        args: { type: "object" },
      },
      required: ["capability"],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpSessionDeps {
  userId: string;
  supabase: Db;
  /** Get-or-create the conversation proposals attach to. */
  ensureConversation: (supabase: Db, userId: string) => Promise<string>;
}

type JsonValue = Record<string, unknown> | null;

function rpcResult(id: JsonRpcRequest["id"], result: Record<string, unknown>): JsonValue {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): JsonValue {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolText(payload: unknown): Record<string, unknown> {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
    ],
  };
}

/** Handle one JSON-RPC message; null for notifications (no response body). */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  deps: McpSessionDeps,
): Promise<JsonValue> {
  const { id, method, params } = msg;
  if ((method ?? "").startsWith("notifications/")) return null;

  switch (method) {
    case "initialize": {
      const requested = (params?.protocolVersion as string | undefined) ?? "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "This server is a person's relationship memory (people, organizations, events; every fact carries a source). Call `search` to discover capabilities, then `execute` to run one. Writes become proposals the user confirms; mention that after proposing.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: META_TOOLS });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "search") {
        return rpcResult(
          id,
          toolText({ capabilities: searchCapabilities(args.query as string | undefined) }),
        );
      }
      if (name === "execute") {
        const capability = args.capability as string | undefined;
        if (!capability || !GRAPH_TOOLS.some((c) => c.name === capability)) {
          return rpcResult(id, {
            ...toolText(
              `Unknown capability "${capability ?? ""}". Call the search tool to list valid names.`,
            ),
            isError: true,
          });
        }
        try {
          const conversationId = await deps.ensureConversation(deps.supabase, deps.userId);
          const ctx = makeToolContext(deps.supabase, deps.userId, conversationId);
          const result = await dispatchToolCall(
            ctx,
            capability,
            (args.args ?? {}) as Record<string, unknown>,
          );
          if (!result.ok) {
            return rpcResult(id, { ...toolText(result.error ?? "Capability failed."), isError: true });
          }
          return rpcResult(id, toolText(result.data ?? { ok: true }));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Capability crashed.";
          return rpcResult(id, { ...toolText(message), isError: true });
        }
      }
      return rpcError(id, -32602, `Unknown tool "${name ?? ""}". This server exposes: search, execute.`);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method ?? "(none)"}`);
  }
}

/** Default ensureConversation: one persistent "MCP" conversation per user. */
export async function ensureMcpConversation(supabase: Db, userId: string): Promise<string> {
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("title", "MCP")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title: "MCP" })
    .select("id")
    .single();
  if (error || !created) throw new Error(error?.message ?? "Couldn't open the MCP conversation.");
  return (created as { id: string }).id;
}
