// Tool-level ACL checks.

import { getRequestContext } from "./context.js";

const TOOL_SCOPE_MAP: Record<string, string[]> = {
  help: ["messages.read"],

  // Core retrieval
  search_messages: ["messages.read"],
  get_conversation: ["messages.read"],
  list_contacts: ["messages.read"],
  get_contact: ["messages.read"],
  resolve_contact: ["messages.read"],
  get_thread: ["messages.read"],
  list_group_chats: ["messages.read"],
  get_group_chat: ["messages.read"],
  list_attachments: ["messages.read"],
  get_reactions: ["messages.read"],
  get_read_receipts: ["messages.read"],
  get_edited_messages: ["messages.read"],
  get_message_effects: ["messages.read"],

  // Analytics
  contact_stats: ["analytics.read"],
  message_stats: ["analytics.read"],
  temporal_heatmap: ["analytics.read"],
  first_last_message: ["analytics.read"],
  conversation_gaps: ["analytics.read"],
  streaks: ["analytics.read"],
  who_initiates: ["analytics.read"],
  double_texts: ["analytics.read"],
  yearly_wrapped: ["analytics.read"],
  on_this_day: ["analytics.read"],
  forgotten_contacts: ["analytics.read"],

  // Sync/incremental
  check_new_messages: ["sync.read"],
  list_changes: ["sync.read"],
  sync_health: ["sync.read"],

  // Workflow pack
  needs_reply: ["analytics.read"],
  follow_up_queue: ["analytics.read"],
  compare_wrapped: ["analytics.read"],
  conversation_brief: ["analytics.read"],
  unknown_sender_analysis: ["analytics.read"],
  memory_digest: ["analytics.read"],
  lead_candidates: ["analytics.read"],

  // Export/compliance
  export_evidence_bundle: ["export.read"],

  // Webhooks (new)
  create_webhook_subscription: ["webhooks.manage"],
  list_webhook_subscriptions: ["webhooks.manage"],
  delete_webhook_subscription: ["webhooks.manage"],
  replay_webhook_subscription: ["webhooks.manage"],

  // Indexing
  search_index_status: ["index.read"],
  rebuild_search_index: ["index.manage"],
};

function normalizeScopes(scopes: string[]): string[] {
  return scopes
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes("*") || scopes.includes("admin.*")) return true;
  if (scopes.includes(required)) return true;

  const [domain] = required.split(".");
  if (domain && scopes.includes(`${domain}.*`)) return true;

  return false;
}

export interface ToolAccessResult {
  ok: boolean;
  missing_scopes?: string[];
}

export function checkToolAccess(toolName: string): ToolAccessResult {
  const ctx = getRequestContext();

  // Local stdio usage remains permissive.
  if (!ctx?.principal) {
    return { ok: true };
  }

  const requiredScopes = TOOL_SCOPE_MAP[toolName] ?? ["messages.read"];
  const principalScopes = normalizeScopes(ctx.principal.scopes);
  const missing = requiredScopes.filter((scope) => !hasScope(principalScopes, scope));

  if (missing.length > 0) {
    return { ok: false, missing_scopes: missing };
  }

  return { ok: true };
}
