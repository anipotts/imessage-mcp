export const API_VERSION = "2.0" as const;

export type PrivacyMode = "full" | "redacted" | "aggregate";
export type Completeness = "complete" | "partial";
export type CapabilityState = "available" | "unavailable" | "unknown";
export type ServiceFamily = "imessage" | "sms" | "rcs" | "unknown";

export type ErrorReason =
  | "INVALID_INPUT"
  | "AMBIGUOUS_CONTACT"
  | "PRIVACY_RESTRICTED"
  | "DATABASE_UNAVAILABLE"
  | "DATABASE_CHANGED"
  | "UNSUPPORTED_SCHEMA"
  | "DECODE_FAILED"
  | "INDEX_TOO_LARGE"
  | "QUERY_BUDGET_EXCEEDED";

export interface Warning {
  code: string;
  message: string;
  skipped_count?: number;
}

export interface PageInfo {
  next_cursor: string | null;
  has_more: boolean;
  as_of: string;
}

export interface SuccessEnvelope<T = unknown> {
  api_version: typeof API_VERSION;
  effective_scope: Record<string, unknown>;
  completeness: Completeness;
  data: T;
  page?: PageInfo;
  warnings?: Warning[];
}

export interface ServicePartition {
  service_family: ServiceFamily;
  count: number;
}

export interface Watermark {
  data_version: number;
  max_message_id: number;
  max_chat_message_date: string;
  max_edited_at: string;
  max_retracted_at: string;
  max_receipt_at: string;
}

export interface SchemaCapabilities {
  schema_fingerprint: string;
  required_core: CapabilityState;
  chat_lookup: CapabilityState;
  attributed_body: CapabilityState;
  edits: CapabilityState;
  retractions: CapabilityState;
  reactions: CapabilityState;
  receipts: CapabilityState;
  receipt_changes: CapabilityState;
  replies: CapabilityState;
  attachments: CapabilityState;
  group_events: CapabilityState;
  rcs: CapabilityState;
  tables: Record<string, string[]>;
}

export interface QueryBudget {
  deadline_ms: number;
  max_rows: number;
  rows_seen: number;
}

export function serviceFamily(service: unknown): ServiceFamily {
  const value = String(service ?? "").trim().toLowerCase();
  if (value === "imessage") return "imessage";
  if (value === "rcs") return "rcs";
  if (value === "sms" || value === "mms") return "sms";
  return "unknown";
}

export function makeBudget(timeoutMs: number, maxRows = 1_000_000): QueryBudget {
  return { deadline_ms: Date.now() + timeoutMs, max_rows: maxRows, rows_seen: 0 };
}
