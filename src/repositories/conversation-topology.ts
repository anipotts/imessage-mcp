// A message is one entity with zero or more recorded chat memberships. Only
// Apple's explicit lookup identifiers join chat components. Sharing a message
// never joins components and never makes an otherwise readable schema invalid.
import type { DatabaseRequest } from "../database.js";
import { ImessageMcpError } from "../errors.js";

const MAX_CATALOG_MESSAGES = 10_000_000;
const MAX_CATALOG_CHATS = 250_000;
const MAX_CATALOG_RELATIONS = 20_000_000;
const MAX_CATALOG_TEXT_BYTES = 128 * 1024 * 1024;
export const MAX_IDENTITY_TEXT_BYTES = 4096;
const MAX_LOOKUP_ROWS = 2_000_000;
const MAX_LOOKUP_FANOUT = 1_000;
export const MAX_CHAT_IDS_PER_CONVERSATION = 1_000;
export const MAX_PARTICIPANTS_PER_CONVERSATION = 1_000;

function catalogScalar(request: DatabaseRequest, sql: string): number {
  return Number((request.db.prepare(sql).get() as { value: number } | undefined)?.value ?? 0) || 0;
}

function assertCatalogBudget(request: DatabaseRequest): void {
  const messages = catalogScalar(request, "SELECT COUNT(*) AS value FROM message");
  const chats = catalogScalar(request, "SELECT COUNT(*) AS value FROM chat");
  const chatMessages = catalogScalar(request, "SELECT COUNT(*) AS value FROM chat_message_join");
  const chatHandles = catalogScalar(request, "SELECT COUNT(*) AS value FROM chat_handle_join");
  const handles = catalogScalar(request, "SELECT COUNT(*) AS value FROM handle");
  const lookups = request.capabilities.chat_lookup === "available"
    ? catalogScalar(request, "SELECT COUNT(*) AS value FROM chat_lookup")
    : 0;
  const chatColumns = request.capabilities.tables.chat ?? [];
  const messageColumns = request.capabilities.tables.message ?? [];
  const chatTextColumns = ["display_name", "group_id", "service_name"].filter((column) => chatColumns.includes(column));
  const chatTextExpression = chatTextColumns.length
    ? chatTextColumns.map((column) => `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`).join(" + ")
    : "0";
  const chatBytes = catalogScalar(request, `SELECT COALESCE(SUM(${chatTextExpression}), 0) AS value FROM chat`);
  const handleBytes = catalogScalar(request, "SELECT COALESCE(SUM(LENGTH(CAST(id AS BLOB))), 0) AS value FROM handle");
  const messageServiceBytes = messageColumns.includes("service")
    ? catalogScalar(request, "SELECT COALESCE(SUM(LENGTH(CAST(service AS BLOB))), 0) AS value FROM message")
    : 0;
  const lookupBytes = request.capabilities.chat_lookup === "available"
    ? catalogScalar(request, "SELECT COALESCE(SUM(LENGTH(CAST(identifier AS BLOB)) + LENGTH(CAST(domain AS BLOB))), 0) AS value FROM chat_lookup")
    : 0;
  const chatTextLengths = chatTextColumns.map((column) => `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`);
  const maxChatText = chatTextColumns.length
    ? catalogScalar(request, `SELECT COALESCE(MAX(${chatTextLengths.length === 1 ? chatTextLengths[0] : `MAX(${chatTextLengths.join(", ")})`}), 0) AS value FROM chat`)
    : 0;
  const maxHandle = catalogScalar(request, "SELECT COALESCE(MAX(LENGTH(CAST(id AS BLOB))), 0) AS value FROM handle");
  const maxMessageService = messageColumns.includes("service")
    ? catalogScalar(request, "SELECT COALESCE(MAX(LENGTH(CAST(service AS BLOB))), 0) AS value FROM message")
    : 0;
  const maxLookupText = request.capabilities.chat_lookup === "available"
    ? catalogScalar(request, "SELECT COALESCE(MAX(MAX(LENGTH(CAST(identifier AS BLOB)), LENGTH(CAST(domain AS BLOB)))), 0) AS value FROM chat_lookup")
    : 0;
  const excessiveLookupFanout = request.capabilities.chat_lookup === "available"
    ? request.db.prepare(
        `SELECT 1 AS value FROM chat_lookup GROUP BY identifier
         HAVING COUNT(DISTINCT chat) > @limit LIMIT 1`,
      ).get({ limit: MAX_LOOKUP_FANOUT }) as { value: number } | undefined
    : undefined;
  if (
    messages > MAX_CATALOG_MESSAGES ||
    chats > MAX_CATALOG_CHATS ||
    handles > MAX_CATALOG_CHATS ||
    chatMessages > MAX_CATALOG_RELATIONS ||
    chatHandles > MAX_CATALOG_RELATIONS ||
    lookups > MAX_LOOKUP_ROWS ||
    chatBytes + handleBytes + messageServiceBytes + lookupBytes > MAX_CATALOG_TEXT_BYTES ||
    Math.max(maxChatText, maxHandle, maxMessageService, maxLookupText) > MAX_IDENTITY_TEXT_BYTES ||
    Boolean(excessiveLookupFanout)
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "conversation catalog source exceeds its bounded cardinality or identity-text budget", {
      limits: {
        messages: MAX_CATALOG_MESSAGES,
        chats: MAX_CATALOG_CHATS,
        relations: MAX_CATALOG_RELATIONS,
        lookup_rows: MAX_LOOKUP_ROWS,
        lookup_fanout: MAX_LOOKUP_FANOUT,
        identity_text_bytes: MAX_CATALOG_TEXT_BYTES,
        single_identity_bytes: MAX_IDENTITY_TEXT_BYTES,
      },
    });
  }
}

class UnionFind {
  private parent = new Map<number, number>();
  private size = new Map<number, number>();

  find(value: number): number {
    if (!this.parent.has(value)) {
      this.parent.set(value, value);
      this.size.set(value, 1);
    }
    let root = value;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as number;
    let current = value;
    while (this.parent.get(current) !== root) {
      const next = this.parent.get(current) as number;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    const root = Math.min(a, b);
    const child = Math.max(a, b);
    const nextSize = (this.size.get(a) ?? 1) + (this.size.get(b) ?? 1);
    if (nextSize > MAX_CHAT_IDS_PER_CONVERSATION) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "Apple-linked conversation component exceeds its bounded chat count");
    }
    this.parent.set(child, root);
    this.size.set(root, nextSize);
    this.size.delete(child);
  }

  canonicalEntries(): Array<[number, number]> {
    return [...this.parent.keys()].map((chatId) => [chatId, this.find(chatId)]);
  }
}

function linkedChats(request: DatabaseRequest): UnionFind {
  const union = new UnionFind();
  if (request.capabilities.chat_lookup !== "available") return union;
  const rows = request.db
    .prepare(
      `SELECT lookup.domain, lookup.identifier, lookup.chat
       FROM chat_lookup lookup
       JOIN chat c ON c.ROWID = lookup.chat
       ORDER BY lookup.identifier, lookup.domain, lookup.chat
       LIMIT ${MAX_LOOKUP_ROWS + 1}`,
    )
    .iterate() as Iterable<{ domain: string; identifier: string; chat: number }>;
  let currentIdentifier: string | null = null;
  let firstChat: number | null = null;
  let fanoutChats = new Set<number>();
  let count = 0;
  for (const row of rows) {
    count += 1;
    if (count > MAX_LOOKUP_ROWS) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "chat lookup exceeds its bounded row count");
    }
    const chat = Number(row.chat);
    if (!Number.isSafeInteger(chat) || chat <= 0) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "chat lookup contains an invalid chat reference");
    }
    if (
      typeof row.domain !== "string" || typeof row.identifier !== "string" ||
      row.domain.length === 0 || row.identifier.length === 0 ||
      Buffer.byteLength(row.domain, "utf8") > MAX_IDENTITY_TEXT_BYTES ||
      Buffer.byteLength(row.identifier, "utf8") > MAX_IDENTITY_TEXT_BYTES
    ) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "chat lookup contains an invalid namespace or identifier");
    }
    if (row.identifier !== currentIdentifier) {
      currentIdentifier = row.identifier;
      firstChat = chat;
      fanoutChats = new Set([chat]);
      union.find(chat);
      continue;
    }
    fanoutChats.add(chat);
    if (fanoutChats.size > MAX_LOOKUP_FANOUT) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "chat lookup identifier exceeds its bounded fanout");
    }
    union.union(firstChat as number, chat);
  }
  return union;
}

const snapshotTopologies = new WeakMap<DatabaseRequest, Map<number, number>>();

export function registerConversationTopology(request: DatabaseRequest): Map<number, number> {
  const cached = snapshotTopologies.get(request);
  if (cached) return cached;
  assertCatalogBudget(request);
  const canonical = new Map(linkedChats(request).canonicalEntries());
  request.db.function("mcp_canonical_chat", { deterministic: true }, (chatId: number) => {
    const id = Number(chatId);
    return canonical.get(id) ?? id;
  });
  snapshotTopologies.set(request, canonical);
  return canonical;
}

export const canonicalChatMap = registerConversationTopology;

export function membershipFields(ids: number[]): { chat_ids: number[]; chat_id?: number } {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (sorted.length > MAX_CHAT_IDS_PER_CONVERSATION || sorted.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "message conversation memberships exceed their bounded identifier count");
  }
  return { chat_ids: sorted, ...(sorted.length === 1 ? { chat_id: sorted[0] } : {}) };
}

// The caller registers topology once for its read snapshot before bounded
// per-message lookups. The 1001st distinct membership stops before aggregation.
export function messageConversationIds(request: DatabaseRequest, messageId: number): number[] {
  const rows = request.db.prepare(`
    SELECT DISTINCT mcp_canonical_chat(j.chat_id) AS id
    FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id
    WHERE j.message_id = ? ORDER BY id LIMIT ${MAX_CHAT_IDS_PER_CONVERSATION + 1}
  `).all(messageId) as Array<{ id: number }>;
  return membershipFields(rows.map((row) => Number(row.id))).chat_ids;
}

export interface ConversationMembershipSummary {
  total_messages: number;
  joined_messages: number;
  shared_messages: number;
  unlinked_messages: number;
}

// Counts only, safe for aggregate diagnostics. Multiplicity is a supported
// data shape, not schema corruption. Rows without a valid chat stay visible in
// this diagnostic even though conversation tools require a recorded chat.
export function conversationMembershipSummary(request: DatabaseRequest): ConversationMembershipSummary {
  registerConversationTopology(request);
  const total = catalogScalar(request, "SELECT COUNT(*) AS value FROM message");
  const row = request.db.prepare(`
    WITH memberships AS (
      SELECT cmj.message_id, COUNT(DISTINCT mcp_canonical_chat(cmj.chat_id)) AS conversations
      FROM chat_message_join cmj
      JOIN message m ON m.ROWID = cmj.message_id
      JOIN chat c ON c.ROWID = cmj.chat_id
      GROUP BY cmj.message_id
    )
    SELECT COUNT(*) AS joined, COALESCE(SUM(conversations > 1), 0) AS shared FROM memberships
  `).get() as { joined: number; shared: number };
  return { total_messages: total, joined_messages: Number(row.joined), shared_messages: Number(row.shared), unlinked_messages: total - Number(row.joined) };
}
