/**
 * Shared TypeScript types for the graph layer (Subsystem #2).
 *
 * Mirrors the Postgres schema exactly — keep this file in sync with
 * `supabase/migrations/20260504_003_graph_schema_layer.sql` and
 * `supabase/migrations/20260504_004_graph_instance_layer.sql`. Auto-
 * generation via `supabase gen types` will replace this hand-rolled
 * file once we add the supabase CLI workflow (post-launch).
 *
 * Convention: rows use snake_case to match Postgres column names so
 * Supabase client returns map directly without renaming.
 */

// ── Schema layer ────────────────────────────────────────────────────

export interface NodeType {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  is_builtin: boolean;
  created_by_ai: boolean;
  created_at: string;
}

export type LinkDirection = "directed" | "undirected";

export interface LinkType {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  direction: LinkDirection;
  inverse_name: string | null;
  applies_to_source_type_id: string | null;
  applies_to_target_type_id: string | null;
  is_builtin: boolean;
  created_by_ai: boolean;
  created_at: string;
}

export type DetailValueType =
  | "text"
  | "date"
  | "month_year"
  | "number"
  | "currency"
  | "url"
  | "enum"
  | "json";

/**
 * `value_config` shapes per `value_type`:
 *  - enum:     { options: string[] }
 *  - currency: { currency: string }  // ISO 4217 code
 *  - number:   { min?: number; max?: number; integer?: boolean }
 *  - others:   null
 */
export type DetailValueConfig =
  | { options: string[] }
  | { currency: string }
  | { min?: number; max?: number; integer?: boolean }
  | null;

export interface DetailDefinition {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  value_type: DetailValueType;
  value_config: DetailValueConfig;
  applies_to_node_type_id: string | null;
  applies_to_link_type_id: string | null;
  is_default: boolean;
  is_builtin: boolean;
  created_by_ai: boolean;
  multi_value: boolean;
  created_at: string;
}

// ── Instance layer ──────────────────────────────────────────────────

export interface NodeRow {
  id: string;
  user_id: string;
  node_type_id: string;
  display_name: string;
  // pgvector returns a JS number[] when selected, but we usually omit
  // this column from default selects (it's huge).
  embedding: number[] | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  id: string;
  user_id: string;
  link_type_id: string;
  source_node_id: string;
  target_node_id: string;
  notes: string | null;
  created_at: string;
}

/**
 * Detail value union — `value` is a jsonb column. The shape depends on
 * the corresponding DetailDefinition's `value_type`. Cast at the
 * accessor layer.
 */
export type DetailValue =
  | string
  | number
  | boolean
  | { [k: string]: unknown };

export interface NodeDetailRow {
  id: string;
  user_id: string;
  node_id: string;
  detail_definition_id: string;
  value: DetailValue;
  valid_from: string | null;
  valid_until: string | null;
  confidence: number;
  source_id: string;
  user_confirmed: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkDetailRow {
  id: string;
  user_id: string;
  link_id: string;
  detail_definition_id: string;
  value: DetailValue;
  valid_from: string | null;
  valid_until: string | null;
  confidence: number;
  source_id: string;
  user_confirmed: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Tagging ─────────────────────────────────────────────────────────

export interface TagRow {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  is_builtin: boolean;
  created_at: string;
}

export interface NodeTagRow {
  user_id: string;
  node_id: string;
  tag_id: string;
  created_at: string;
}

export interface LinkTagRow {
  user_id: string;
  link_id: string;
  tag_id: string;
  created_at: string;
}

// ── Sources / provenance ───────────────────────────────────────────

export type SourceType =
  | "chat_message_text"
  | "chat_message_voice"
  | "screenshot"
  | "image_upload"
  | "audio_upload"
  | "video_upload"
  | "email_thread"
  | "gmail_message"
  | "web_search"
  | "web_enrichment"
  | "calendar_event"
  | "user_typed"
  | "mobile_share_sheet";

export interface SourceRow {
  id: string;
  user_id: string;
  source_type: SourceType;
  display_label: string;
  storage_path: string | null;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  external_url: string | null;
  metadata: Record<string, unknown> | null;
  context_text: string | null;
  created_at: string;
}

// ── Schema evolution + conflict resolution ─────────────────────────

export type SchemaProposalType =
  | "node_type"
  | "link_type"
  | "detail_definition"
  | "subjective_scale"
  | "tag";

export type SchemaProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded";

export interface SchemaProposalRow {
  id: string;
  user_id: string;
  proposal_type: SchemaProposalType;
  proposed_payload: Record<string, unknown>;
  reasoning: string;
  triggering_source_ids: string[] | null;
  status: SchemaProposalStatus;
  decision_notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export type ConflictTargetKind = "node_detail" | "link_detail";
export type ConflictStatus = "pending" | "resolved" | "ignored";
export type ConflictResolution =
  | "kept_existing"
  | "replaced_with_incoming"
  | "merged"
  | "both_valid_temporal";

export interface ConflictRow {
  id: string;
  user_id: string;
  target_kind: ConflictTargetKind;
  target_id: string;
  existing_value: DetailValue;
  existing_source_id: string;
  incoming_value: DetailValue;
  incoming_source_id: string;
  status: ConflictStatus;
  resolution: ConflictResolution | null;
  created_at: string;
  resolved_at: string | null;
}

// ── Built-in seed names — useful constants ─────────────────────────

export const BUILTIN_NODE_TYPES = [
  "Person",
  "Organization",
  "Country",
  "City",
] as const;

export const BUILTIN_TAG_NAMES = [
  "Personal",
  "Work",
  "Family",
  "Investors",
] as const;

export type BuiltinNodeTypeName = (typeof BUILTIN_NODE_TYPES)[number];
export type BuiltinTagName = (typeof BUILTIN_TAG_NAMES)[number];
