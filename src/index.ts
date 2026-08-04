/**
 * wend-core — the provenance-first personal graph engine.
 *
 * The relationship memory layer for AI agents: a typed graph of people,
 * organizations, and events where every fact carries a source, every AI
 * write is a human-confirmed proposal, and any MCP client can plug in.
 */

// Commit path (confirm-time): dedup, ontology auto-mint, provenance.
export {
  applyAddDetail,
  applyAddLinkDetail,
  applyCreateLink,
  applyCreateNode,
  applyCreatePromise,
  applyEditNode,
  buildConfirmCaches,
  editDistance,
  findExistingNodeFuzzy,
  isLocationSuffix,
  mergeAdditiveText,
  normalizeForMatch,
  valuesDiffer,
  type AddDetailOutcome,
  type ConfirmCaches,
} from "./core/apply.js";

// Read path.
export { recallNodes } from "./core/recall.js";
// Expand recall hits in the database, so an agent can answer without a
// details round trip per match.
export {
  buildSummary,
  digestForNodes,
  type NodeDigest,
} from "./core/recall-digest.js";
export { findConnectionPath } from "./core/path.js";

// Governed tool surface (propose-only writes) + dispatch.
export { GRAPH_TOOLS, type ToolDefinition } from "./core/tool-definitions.js";
export {
  dispatchToolCall,
  makeToolContext,
  type ToolContext,
  type ToolResult,
} from "./core/dispatch.js";

// Review-queue shaping shared by any confirm UI.
export * from "./core/build-items.js";

// Identity heuristics.
export * from "./core/name-match.js";

// MCP server (JSON-RPC core; bring your own transport — see examples/serve.ts).
export {
  ensureMcpConversation,
  handleMcpMessage,
  listCapabilities,
  searchCapabilities,
  MCP_PROTOCOL_VERSION,
  META_TOOLS,
  SERVER_INFO,
  type Capability,
  type McpSessionDeps,
} from "./mcp/server.js";

// Crypto: AES-256-GCM secret box for OAuth tokens and other secrets at rest.
export * from "./crypto/secret-box.js";

// Embeddings are pluggable; register yours once at startup.
export { setEmbeddingProvider, embedText, type EmbeddingProvider } from "./embed/provider.js";
