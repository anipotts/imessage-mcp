import { createHash } from "node:crypto";
import type { PrivacyMode, ServiceFamily, Watermark } from "../contracts.js";
import { makeBudget, serviceFamily } from "../contracts.js";
import type { UnifiedContactResolver } from "../contacts.js";
import { normalizeHandle } from "../contacts.js";
import type { DatabaseContext, DatabaseRequest } from "../database.js";
import { assertFrozenTraversal, parseWatermark, watermarkToken } from "../database.js";
import { ImessageMcpError } from "../errors.js";
import { decodeReference, encodeReference } from "../references.js";
import { serviceFamilyCase, serviceSql } from "../schema-sql.js";
import type { DateBounds } from "../time.js";
import {
  appleTimestampBoundary,
  appleTimestampBoundarySql,
  appleTimestampSortSql,
  appleTimestampToIso,
  compareSqliteIntegers,
  sqliteIntegerToken,
} from "../time.js";

export interface ConversationFilters {
  handles?: string[];
  service?: ServiceFamily;
  kind?: "direct" | "group";
  replied?: boolean;
  bounds: DateBounds;
}

export interface ConversationSummary {
  conversation_ref: string;
  display_name: string | null;
  kind: "direct" | "group";
  participants: Array<{ name: string | null; handle: string }>;
  service_families: ServiceFamily[];
  message_count: number;
  system_event_count: number;
  replied: boolean;
  first_activity_at: string | null;
  last_activity_at: string | null;
}

interface RawConversation {
  chatIds: number[];
  names: string[];
  handles: string[];
  activityServices: ServiceFamily[];
  services: ServiceFamily[];
  messageCount: number;
  systemCount: number;
  replied: boolean;
  groupEvidence: boolean;
  directEvidence: boolean;
  firstDate: string;
  lastDate: string;
}

interface PageCursor {
  filters: string;
  frozen: Watermark;
  after_date: string;
  after_chat: number;
}

const MAX_CATALOG_MESSAGES = 10_000_000;
const MAX_CATALOG_CHATS = 250_000;
const MAX_CATALOG_RELATIONS = 20_000_000;
const MAX_CATALOG_TEXT_BYTES = 128 * 1024 * 1024;
const MAX_IDENTITY_TEXT_BYTES = 4096;
const MAX_LOOKUP_ROWS = 2_000_000;
const MAX_LOOKUP_FANOUT = 1_000;
export const MAX_CHAT_IDS_PER_CONVERSATION = 1_000;
const MAX_PARTICIPANTS_PER_CONVERSATION = 1_000;

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

function filterFingerprint(filters: ConversationFilters): string {
  return createHash("sha256")
    .update(JSON.stringify({
      handles: filters.handles?.map(normalizeHandle).sort(),
      service: filters.service,
      kind: filters.kind,
      replied: filters.replied,
      bounds: filters.bounds,
    }))
    .digest("hex")
    .slice(0, 20);
}

function linkedChats(request: DatabaseRequest): UnionFind {
  const union = new UnionFind();
  if (request.capabilities.chat_lookup !== "available") return union;
  const rows = request.db
    .prepare(
      `SELECT domain, identifier, chat
       FROM chat_lookup
       ORDER BY identifier, domain, chat
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

function registerCanonicalChat(request: DatabaseRequest, union: UnionFind): void {
  request.db.function("mcp_canonical_chat", { deterministic: true }, (chatId: number) => union.find(Number(chatId)));
}

function assertOneCanonicalConversationPerMessage(
  request: DatabaseRequest,
  maxMessageId: number,
): void {
  const invalid = request.db.prepare(
    `SELECT 1 AS value
     FROM chat_message_join cmj
     JOIN message m ON m.ROWID = cmj.message_id
     WHERE m.ROWID <= @max_message_id
     GROUP BY cmj.message_id
     HAVING COUNT(DISTINCT mcp_canonical_chat(cmj.chat_id)) > 1
     LIMIT 1`,
  ).get({ max_message_id: maxMessageId }) as { value: number } | undefined;
  if (invalid) {
    throw new ImessageMcpError(
      "UNSUPPORTED_SCHEMA",
      "a message belongs to multiple conversations that Apple did not link through chat_lookup",
    );
  }
}

export function canonicalChatMap(request: DatabaseRequest): Map<number, number> {
  assertCatalogBudget(request);
  return new Map(linkedChats(request).canonicalEntries());
}

export function assertMessageConversationIntegrity(
  request: DatabaseRequest,
  maxMessageId = request.asOf.max_message_id,
): Map<number, number> {
  assertCatalogBudget(request);
  const union = linkedChats(request);
  registerCanonicalChat(request, union);
  assertOneCanonicalConversationPerMessage(request, maxMessageId);
  return new Map(union.canonicalEntries());
}

function parseStringArray(value: unknown, maximum: number, label: string): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string") {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", `Messages ${label} aggregation returned a non-JSON value`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) || parsed.length > maximum ||
      parsed.some((item) => typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_IDENTITY_TEXT_BYTES)
    ) {
      throw new Error("invalid string array");
    }
    return parsed.filter((item) => item.length > 0);
  } catch {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", `Messages ${label} aggregation returned invalid JSON`);
  }
}

function parseChatIdArray(value: unknown): number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > MAX_CHAT_IDS_PER_CONVERSATION ||
      parsed.some((item) => !Number.isSafeInteger(item) || Number(item) <= 0)
    ) {
      throw new Error("invalid chat ids");
    }
    return [...new Set(parsed.map(Number))].sort((a, b) => a - b);
  } catch {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "Messages conversation aggregation returned invalid chat identifiers");
  }
}

function minimumChatId(ids: number[]): number {
  if (ids.length === 0 || ids.length > MAX_CHAT_IDS_PER_CONVERSATION) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "conversation contains an invalid number of linked chat records");
  }
  let minimum = Number.MAX_SAFE_INTEGER;
  for (const id of ids) minimum = Math.min(minimum, id);
  return minimum;
}

function userMessagePredicate(request: DatabaseRequest): string {
  const columns = request.capabilities.tables.message ?? [];
  const reaction = columns.includes("associated_message_type") ? "COALESCE(m.associated_message_type, 0) = 0" : "1 = 1";
  const item = columns.includes("item_type") ? "COALESCE(m.item_type, 0) = 0" : "1 = 1";
  const system = columns.includes("is_system_message") ? "COALESCE(m.is_system_message, 0) <> 1" : "1 = 1";
  return `${reaction} AND ${item} AND ${system}`;
}

function systemMessagePredicate(request: DatabaseRequest): string {
  const columns = request.capabilities.tables.message ?? [];
  const predicates: string[] = [];
  if (columns.includes("item_type")) predicates.push("COALESCE(m.item_type, 0) <> 0");
  if (columns.includes("is_system_message")) predicates.push("COALESCE(m.is_system_message, 0) = 1");
  return predicates.length ? `(${predicates.join(" OR ")})` : "0";
}

function loadRaw(request: DatabaseRequest, filters: ConversationFilters, maxMessageId: number): RawConversation[] {
  assertCatalogBudget(request);
  const union = linkedChats(request);
  registerCanonicalChat(request, union);
  assertOneCanonicalConversationPerMessage(request, maxMessageId);
  const where = ["m.ROWID <= @max_message_id"];
  const bindings: Record<string, unknown> = { max_message_id: maxMessageId };
  if (filters.bounds.from_unix_seconds !== undefined) {
    const boundary = appleTimestampBoundary(filters.bounds.from_unix_seconds);
    where.push(appleTimestampBoundarySql("m.date", ">=", "@date_from_seconds", "@date_from_nanoseconds"));
    bindings.date_from_seconds = boundary.seconds;
    bindings.date_from_nanoseconds = boundary.nanoseconds;
  }
  if (filters.bounds.to_unix_seconds !== undefined) {
    const boundary = appleTimestampBoundary(filters.bounds.to_unix_seconds);
    where.push(appleTimestampBoundarySql("m.date", "<", "@date_to_seconds", "@date_to_nanoseconds"));
    bindings.date_to_seconds = boundary.seconds;
    bindings.date_to_nanoseconds = boundary.nanoseconds;
  }
  const chatColumns = request.capabilities.tables.chat ?? [];
  const displayName = chatColumns.includes("display_name") ? "c.display_name" : "NULL";
  const chatService = chatColumns.includes("service_name") ? "c.service_name" : "NULL";
  const groupEvidence = [
    chatColumns.includes("style") ? "COALESCE(c.style, 0) = 43" : "0",
    chatColumns.includes("group_id") ? "COALESCE(c.group_id, '') <> ''" : "0",
    chatColumns.includes("display_name") ? "COALESCE(c.display_name, '') <> ''" : "0",
  ].join(" OR ");
  const messageService = serviceFamilyCase(serviceSql(request, "m", "relation_chat"));
  const userMessage = userMessagePredicate(request);
  const systemMessage = systemMessagePredicate(request);
  const excessiveParticipants = request.db.prepare(
    `SELECT 1 AS value
     FROM chat_handle_join chj
     JOIN handle h ON h.ROWID = chj.handle_id
     GROUP BY mcp_canonical_chat(chj.chat_id)
     HAVING COUNT(DISTINCT h.id) > @limit
     LIMIT 1`,
  ).get({ limit: MAX_PARTICIPANTS_PER_CONVERSATION }) as { value: number } | undefined;
  if (excessiveParticipants) {
    throw new ImessageMcpError(
      "QUERY_BUDGET_EXCEEDED",
      "conversation participant aggregation exceeds its bounded identity count",
    );
  }
  const classifiedChatService = serviceFamilyCase(chatService);
  const rows = request.db
    .prepare(
      `WITH raw_scoped_relations AS (
         SELECT DISTINCT mcp_canonical_chat(cmj.chat_id) AS conversation_id, cmj.message_id, cmj.chat_id
         FROM chat_message_join cmj
         JOIN message m ON m.ROWID = cmj.message_id
         WHERE ${where.join(" AND ")}
       ), scoped_relations AS (
         SELECT raw.conversation_id, raw.message_id,
                CASE WHEN COUNT(DISTINCT ${messageService}) = 1
                     THEN MIN(${messageService}) ELSE 'unknown' END AS message_service
         FROM raw_scoped_relations raw
         JOIN message m ON m.ROWID = raw.message_id
         JOIN chat relation_chat ON relation_chat.ROWID = raw.chat_id
         GROUP BY raw.conversation_id, raw.message_id
       ), conversation_stats AS (
         SELECT scoped.conversation_id,
           SUM(CASE WHEN ${userMessage} THEN 1 ELSE 0 END) AS message_count,
           SUM(CASE WHEN ${userMessage} AND m.is_from_me = 1 THEN 1 ELSE 0 END) AS sent_count,
           SUM(CASE WHEN ${systemMessage} THEN 1 ELSE 0 END) AS system_count,
           json_group_array(DISTINCT scoped.message_service) AS message_services,
           CAST(MIN(${appleTimestampSortSql("m.date")}) AS TEXT) AS first_date,
           CAST(MAX(${appleTimestampSortSql("m.date")}) AS TEXT) AS last_date
         FROM scoped_relations scoped
         JOIN message m ON m.ROWID = scoped.message_id
         GROUP BY scoped.conversation_id
       ), participant_stats AS (
         SELECT mcp_canonical_chat(chj.chat_id) AS conversation_id,
                json_group_array(DISTINCT h.id) AS handles
         FROM chat_handle_join chj
         JOIN handle h ON h.ROWID = chj.handle_id
         GROUP BY mcp_canonical_chat(chj.chat_id)
       ), chat_stats AS (
         SELECT mcp_canonical_chat(c.ROWID) AS conversation_id,
                json_group_array(DISTINCT c.ROWID) AS chat_ids,
                json_group_array(DISTINCT ${displayName}) FILTER (WHERE ${displayName} IS NOT NULL) AS display_names,
                json_group_array(DISTINCT ${classifiedChatService}) AS chat_services,
                MAX(CASE WHEN ${groupEvidence} THEN 1 ELSE 0 END) AS group_evidence,
                ${chatColumns.includes("style")
                  ? "MIN(CASE WHEN COALESCE(c.style, 0) = 45 THEN 1 ELSE 0 END)"
                  : "0"} AS direct_evidence
         FROM chat c
         GROUP BY mcp_canonical_chat(c.ROWID)
       )
       SELECT
         stats.conversation_id,
         chats.chat_ids,
         chats.display_names,
         chats.chat_services,
         chats.group_evidence,
         chats.direct_evidence,
         participants.handles,
         stats.message_services,
         stats.message_count,
         stats.sent_count,
         stats.system_count,
         stats.first_date,
         stats.last_date
       FROM conversation_stats stats
       JOIN chat_stats chats ON chats.conversation_id = stats.conversation_id
       LEFT JOIN participant_stats participants ON participants.conversation_id = stats.conversation_id
       WHERE stats.message_count > 0 OR stats.system_count > 0`,
    )
    .all(bindings) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    chatIds: parseChatIdArray(row.chat_ids),
    names: parseStringArray(row.display_names, MAX_CHAT_IDS_PER_CONVERSATION, "display-name")
      .map((name) => name.trim()).filter(Boolean),
    handles: parseStringArray(row.handles, MAX_PARTICIPANTS_PER_CONVERSATION, "participant"),
    activityServices: parseStringArray(row.message_services, 4, "message-service").map(serviceFamily),
    services: [
      ...parseStringArray(row.message_services, 4, "message-service"),
      ...parseStringArray(row.chat_services, 4, "chat-service"),
    ].map(serviceFamily),
    messageCount: Number(row.message_count ?? 0),
    systemCount: Number(row.system_count ?? 0),
    replied: Number(row.sent_count ?? 0) > 0,
    groupEvidence: Number(row.group_evidence ?? 0) > 0,
    directEvidence: Number(row.direct_evidence ?? 0) > 0,
    firstDate: sqliteIntegerToken(row.first_date, "conversation first-activity timestamp"),
    lastDate: sqliteIntegerToken(row.last_date, "conversation last-activity timestamp"),
  }));
}

export class ConversationCatalog {
  private cacheKey: string | null = null;
  private cached: RawConversation[] = [];

  constructor(private readonly context: DatabaseContext) {}

  warm(): void {
    const request = this.context.request();
    try {
      this.rows(request, { bounds: { timezone: "UTC" } }, request.asOf);
    } finally {
      request.close();
    }
  }

  rows(request: DatabaseRequest, filters: ConversationFilters, frozen: Watermark): RawConversation[] {
    if (
      filters.bounds.from_unix_seconds !== undefined ||
      filters.bounds.to_unix_seconds !== undefined
    ) {
      return loadRaw(request, filters, frozen.max_message_id);
    }
    const key = watermarkToken(frozen);
    if (this.cacheKey !== key) {
      this.cached = loadRaw(request, { bounds: filters.bounds }, frozen.max_message_id);
      this.cacheKey = key;
    }
    return [...this.cached];
  }
}

function matches(raw: RawConversation, filters: ConversationFilters): boolean {
  const handles = new Set(raw.handles.map(normalizeHandle));
  if (filters.handles && !filters.handles.some((handle) => handles.has(normalizeHandle(handle)))) return false;
  const kind = raw.groupEvidence ? "group" : raw.directEvidence ? "direct" : handles.size > 1 ? "group" : "direct";
  if (filters.kind && kind !== filters.kind) return false;
  if (filters.service && !raw.activityServices.includes(filters.service)) return false;
  if (filters.replied !== undefined && raw.replied !== filters.replied) return false;
  return true;
}

function publicSummary(
  raw: RawConversation,
  request: DatabaseRequest,
  contacts: UnifiedContactResolver,
): ConversationSummary {
  const handles = [...new Set(raw.handles)].sort();
  const participants = handles.map((handle) => ({ name: contacts.nameForHandle(handle), handle }));
  const kind = raw.groupEvidence ? "group" : raw.directEvidence ? "direct" : handles.length > 1 ? "group" : "direct";
  const displayName = [...new Set(raw.names)].sort()[0] ?? (kind === "direct" ? participants[0]?.name ?? null : null);
  return {
    conversation_ref: encodeReference(request.referenceKey, request.lineage, "conversation", {
      chat_ids: raw.chatIds.sort((a, b) => a - b),
    }),
    display_name: displayName,
    kind,
    participants,
    service_families: [...new Set(raw.services)].sort(),
    message_count: raw.messageCount,
    system_event_count: raw.systemCount,
    replied: raw.replied,
    first_activity_at: appleTimestampToIso(raw.firstDate),
    last_activity_at: appleTimestampToIso(raw.lastDate),
  };
}

export function listConversations(input: {
  context: DatabaseContext;
  contacts: UnifiedContactResolver;
  filters: ConversationFilters;
  limit: number;
  cursor?: string;
  privacy: PrivacyMode;
  catalog?: ConversationCatalog;
}): { conversations: ConversationSummary[]; hasMore: boolean; nextCursor: string | null; asOf: string } {
  const budget = makeBudget(30_000, 200_000);
  const request = input.context.request();
  try {
    const fingerprint = filterFingerprint(input.filters);
    let frozen = request.asOf;
    // Apple nanosecond timestamps are larger than Number.MAX_SAFE_INTEGER.
    // Infinity is only the in-process first-page sentinel; persisted cursors
    // always contain an observed database value.
    let afterDate: string | null = null;
    let afterChat = Number.MAX_SAFE_INTEGER;
    if (input.cursor) {
      const decoded = decodeReference(request.referenceKey, request.lineage, "page", input.cursor).value as unknown as PageCursor;
      if (
        decoded.filters !== fingerprint ||
        !Number.isSafeInteger(decoded.after_chat) || decoded.after_chat <= 0
      ) {
        throw new ImessageMcpError("INVALID_INPUT", "cursor filters or position do not match this query");
      }
      frozen = parseWatermark(decoded.frozen);
      assertFrozenTraversal(frozen, request.asOf);
      try {
        afterDate = sqliteIntegerToken(decoded.after_date, "conversation cursor timestamp");
      } catch {
        throw new ImessageMcpError("INVALID_INPUT", "cursor contains an invalid conversation position");
      }
      afterChat = decoded.after_chat;
    }
    request.guard(budget);
    const rows = (input.catalog?.rows(request, input.filters, frozen) ?? loadRaw(request, input.filters, frozen.max_message_id))
      .filter((row) => matches(row, input.filters))
      .sort((a, b) => compareSqliteIntegers(b.lastDate, a.lastDate) || minimumChatId(b.chatIds) - minimumChatId(a.chatIds))
      .filter((row) => afterDate === null || compareSqliteIntegers(row.lastDate, afterDate) < 0 ||
        (row.lastDate === afterDate && minimumChatId(row.chatIds) < afterChat));
    request.guard(budget, rows.length);
    const selected = rows.slice(0, input.limit + 1);
    const hasMore = selected.length > input.limit;
    const page = selected.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? encodeReference(request.referenceKey, request.lineage, "page", {
          filters: fingerprint,
          frozen,
          after_date: last.lastDate,
          after_chat: minimumChatId(last.chatIds),
        })
      : null;
    return {
      conversations: page.map((row) => publicSummary(row, request, input.contacts)),
      hasMore,
      nextCursor,
      asOf: watermarkToken(frozen),
    };
  } finally {
    request.close();
  }
}

export function resolveConversationReference(referenceKey: Buffer, lineage: string, reference: string): number[] {
  const value = decodeReference(referenceKey, lineage, "conversation", reference).value;
  if (
    !Array.isArray(value.chat_ids) ||
    value.chat_ids.length === 0 ||
    value.chat_ids.length > MAX_CHAT_IDS_PER_CONVERSATION ||
    value.chat_ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0) ||
    new Set(value.chat_ids).size !== value.chat_ids.length
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "invalid conversation reference");
  }
  return value.chat_ids as number[];
}
