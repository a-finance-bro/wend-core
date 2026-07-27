/**
 * Minimal self-hosted MCP server over node:http (Streamable HTTP transport).
 *
 * Environment:
 *   SUPABASE_URL              your Postgres/Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY service-role key (server-side only, never a browser)
 *   WEND_USER_ID              the user whose graph this server exposes
 *   PORT                      default 8787
 *
 * Single-user by design: this example maps one bearer token (API_TOKEN env,
 * default "dev") to one user. Multi-user hosting needs real key management —
 * see the hosted product, or wire your own table like the schema's api_keys.
 *
 *   npx tsx examples/serve.ts
 *   # then: claude mcp add --transport http wend http://localhost:8787 \
 *   #         --header "Authorization: Bearer dev"
 */

import { createServer } from "node:http";

import { createClient } from "@supabase/supabase-js";

import { ensureMcpConversation, handleMcpMessage } from "../src/mcp/server.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.WEND_USER_ID;
const token = process.env.API_TOKEN ?? "dev";
const port = Number(process.env.PORT ?? 8787);

if (!url || !key || !userId) {
  console.error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and WEND_USER_ID.");
  process.exit(1);
}

const supabase = createClient(url, key);

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (req.method === "DELETE") return void res.writeHead(200).end();
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return void res.end(JSON.stringify({ error: "POST JSON-RPC messages to this endpoint." }));
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return void res.end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }),
    );
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return void res.end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
    );
  }

  const deps = { userId: userId as string, supabase, ensureConversation: ensureMcpConversation };
  const messages = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const msg of messages) {
    const out = await handleMcpMessage(msg as Record<string, unknown>, deps);
    if (out !== null) responses.push(out);
  }
  if (responses.length === 0) return void res.writeHead(202).end();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
});

server.listen(port, () => {
  console.log(`wend-core MCP server listening on http://localhost:${port}`);
});
