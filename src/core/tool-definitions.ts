/**
 * The open graph tool set: definitions any agent (or the MCP server) can use.
 *
 * These are the engine's governed verbs. READS return graph data with
 * provenance. WRITES never touch the graph directly — every propose* lands a
 * row in `pending_writes` for the human to confirm; the commit path is
 * src/core/apply.ts. That split is the governance model: the agent proposes,
 * the human approves, every fact keeps its source.
 *
 * Note for integrators: the hosted Wend product ships longer, heavily tuned
 * tool descriptions as part of its closed model pack. These descriptions are
 * functionally complete; tune your own wording freely.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const ref = {
  type: "object",
  properties: {
    id: { type: "string", description: "Node UUID when known." },
    display_name: {
      type: "string",
      description:
        "Exact display name when the id is unknown (resolved against batch siblings, Self, existing nodes, then aliases).",
    },
  },
} as const;

const details = {
  type: "array",
  description: "Typed attributes, e.g. [{name:'role', value:'CTO'}].",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      value: { type: "string" },
    },
    required: ["name", "value"],
  },
} as const;

export const GRAPH_TOOLS: ToolDefinition[] = [
  {
    name: "findNodeByName",
    description:
      "Look up existing nodes by (partial) name before proposing anything. Returns candidates with a match_quality tier (exact | strong | weak_partial). A weak_partial is a mid-word substring hit and is almost never the same entity — never treat it as an identity.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: {
          type: "string",
          description: "Optional node type filter, e.g. Person, Organization, Event.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "recallNodes",
    description:
      "Semantic recall across the whole graph ('who do I know in fintech in SF?'). Requires an embedding provider. Returns the closest nodes with similarity scores.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results, default 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "getNodeDetails",
    description:
      "Full profile of one node: attributes (with provenance source ids), links with their typed details, and tags.",
    input_schema: {
      type: "object",
      properties: { node_id: { type: "string" } },
      required: ["node_id"],
    },
  },
  {
    name: "proposeCreateNode",
    description:
      "Propose a NEW person/organization/event/location node (plus initial attributes). Lands in the review queue; commit-time dedup absorbs typos and duplicates.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type name, e.g. Person." },
        display_name: { type: "string", description: "Copy the source's exact spelling." },
        details,
      },
      required: ["type", "display_name"],
    },
  },
  {
    name: "proposeCreateLink",
    description:
      "Propose a typed relationship between two nodes (works_at, met_at, advisor, …). Unknown link types are minted per-user at confirm time, flagged created_by_ai. Optional details ride the link (role, dates, notes).",
    input_schema: {
      type: "object",
      properties: {
        link_type: { type: "string", description: "snake_case relationship name, most specific available." },
        source: ref,
        target: ref,
        details,
      },
      required: ["link_type", "source", "target"],
    },
  },
  {
    name: "proposeAddDetail",
    description:
      "Propose one attribute value on an EXISTING node. Every detail field is multi-value: adding never conflicts; replacing is proposeEditNode's job.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node UUID (or a display_name of a node proposed earlier in this batch)." },
        detail_name: { type: "string" },
        value: { type: "string" },
      },
      required: ["node_id", "detail_name", "value"],
    },
  },
  {
    name: "proposeAddLinkDetail",
    description: "Propose a detail on an existing link (e.g. update the title on an employment link). Replaces the current value at confirm time.",
    input_schema: {
      type: "object",
      properties: {
        link_id: { type: "string" },
        detail_name: { type: "string" },
        value: { type: "string" },
      },
      required: ["link_id", "detail_name", "value"],
    },
  },
  {
    name: "proposeEditNode",
    description:
      "Propose explicit edits to an existing node: rename (old name preserved as an alias) or replace a detail value. This is the deliberate REPLACE path; additive facts belong in proposeAddDetail.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", enum: ["name", "detail"] },
              detail_name: { type: "string" },
              next: { type: "string" },
            },
            required: ["field", "next"],
          },
        },
      },
      required: ["node_id", "edits"],
    },
  },
  {
    name: "flagPromise",
    description:
      "Propose a tracked commitment ('I owe them an intro', 'they'll send the deck'). Direction is user_to_other, other_to_user, or mutual; optional ISO due date.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["user_to_other", "other_to_user", "mutual"] },
        description: { type: "string" },
        target: ref,
        due_at: { type: "string", description: "ISO timestamp or empty." },
      },
      required: ["direction", "description", "target"],
    },
  },
];
