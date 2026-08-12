import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { PrivacyMode, ServiceFamily, Warning, Watermark } from "../contracts.js";
import { makeBudget, serviceFamily } from "../contracts.js";
import type { UnifiedContactResolver } from "../contacts.js";
import type { DatabaseContext, DatabaseRequest } from "../database.js";
import { assertFrozenTraversal, parseWatermark, watermarkToken } from "../database.js";
import type { DecodeResult, EditMetadataResult, MessageTextDecoder } from "../decoder.js";
import { populatedMessageText } from "../decoder.js";
import { ImessageMcpError } from "../errors.js";
import { decodeReference, encodeReference } from "../references.js";
import { columnSql, serviceFamilyCase, serviceFamilyPredicate, serviceSql } from "../schema-sql.js";
import type { DateBounds } from "../time.js";
import {
  appleTimestampBoundary,
  appleTimestampBoundarySql,
  appleTimestampSortSql,
  appleTimestampToIso,
  compareSqliteIntegers,
  sqliteIntegerBinding,
  sqliteIntegerIsPositive,
  sqliteIntegerToken,
} from "../time.js";

export type TimelineEventType = "message" | "retraction" | "participant_joined" | "participant_left" | "group_renamed" | "system_change";

export interface TimelineEvent {
  event_type: TimelineEventType;
  message_ref?: string;
  timestamp: string | null;
  service_family: ServiceFamily;
  direction: "incoming" | "outgoing" | "system";
  sender?: { name: string | null; handle: string | null };
  text?: string;
  text_status?: "decoded" | "malformed" | "unsupported" | "absent";
  retraction?: { state: "retracted"; at: string | null };
  edit?: { state: "available" | "unavailable" | "unknown"; count: number | null; timestamps: string[] };
  reactions?: Array<{ type: string; emoji?: string; sender: { name: string | null; handle: string | null } }>;
  receipt?: {
    capability: "available" | "unavailable" | "unknown";
    direction: "remote" | "local";
    state?: "sent" | "delivered" | "read";
    delivered_at?: string | null;
    read_at?: string | null;
  };
  attachments?: Array<{
    filename: string | null;
    mime_type: string | null;
    bytes: number | null;
    path?: string;
  }>;
  reply_to_ref?: string;
  system?: { action_code: number | null; affected_handle: string | null; title: string | null };
  row_status: "complete" | "partial";
}

interface MessageRow extends Record<string, unknown> {
  rowid: number;
  guid: string;
  text: string | null;
  text_type: string;
  attributed_body: Buffer | null;
  attributed_body_type: string;
  summary_info: Buffer | null;
  summary_info_type: string;
  handle: string | null;
  is_from_me: number;
  date: string;
  service: string | null;
  item_type: number;
  is_system_message: number;
  group_action_type: number;
  group_title: string | null;
  other_handle: string | null;
  date_edited: string;
  date_retracted: string;
  reply_to_guid: string | null;
  is_delivered: number;
  is_read: number;
  date_delivered: string;
  date_read: string;
}

interface ReactionRow {
  rowid: number;
  parent_guid: string;
  type_code: number;
  emoji: string | null;
  handle: string | null;
  handle_id: number | null;
  is_from_me: number;
}

interface ConversationCursor {
  frozen: Watermark;
  query_hash: string;
  before_date: string;
  before_rowid: number;
}

const MAX_CONVERSATION_TEXT_BYTES = 3 * 1024 * 1024;
const MAX_SELECTED_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGE_BLOB_BYTES = 1024 * 1024;
const MAX_RELATED_ROWS = 2_000;
const MAX_RELATED_TEXT_BYTES = 1024 * 1024;
const MAX_RELATED_VALUE_BYTES = 4096;

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function queryHash(input: {
  chatIds: number[];
  bounds: DateBounds;
  service?: ServiceFamily;
  eventFilters?: TimelineEventType[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      chat_ids: [...input.chatIds].sort((a, b) => a - b),
      bounds: input.bounds,
      service: input.service,
      event_filters: input.eventFilters ? [...input.eventFilters].sort() : undefined,
    }))
    .digest("hex")
    .slice(0, 24);
}

export function normalizeReactionParent(raw: string): string {
  return raw
    .replace(/^bp:/u, "")
    .replace(/^p:\d+\//u, "")
    .replace(/^p:/u, "")
    .trim();
}

function reactionName(code: number, emoji: string | null): string {
  if (emoji) return "emoji";
  return ({ 2000: "love", 2001: "like", 2002: "dislike", 2003: "laugh", 2004: "emphasize", 2005: "question" } as Record<number, string>)[code] ?? "unknown";
}

function loadReactions(
  request: DatabaseRequest,
  chatIds: number[],
  maxMessageId: number,
  parentGuids: string[],
): Map<string, ReactionRow[]> {
  if (request.capabilities.reactions !== "available" || parentGuids.length === 0) return new Map();
  const emoji = columnSql(request, "message", "m", "associated_message_emoji", "NULL");
  const parentExpression = `CASE
    WHEN m.associated_message_guid LIKE 'bp:%' THEN SUBSTR(m.associated_message_guid, 4)
    WHEN m.associated_message_guid GLOB 'p:[0-9]*/*' THEN SUBSTR(m.associated_message_guid, INSTR(m.associated_message_guid, '/') + 1)
    WHEN m.associated_message_guid LIKE 'p:%' THEN SUBSTR(m.associated_message_guid, 3)
    ELSE m.associated_message_guid END`;
  const source = `FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE cmj.chat_id IN (${placeholders(chatIds)})
         AND m.ROWID <= ?
         AND m.associated_message_type BETWEEN 2000 AND 3999
         AND m.associated_message_guid IS NOT NULL
         AND ${parentExpression} IN (${placeholders(parentGuids)})`;
  const bindings = [...chatIds, maxMessageId, ...parentGuids];
  const stats = request.db.prepare(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(LENGTH(CAST(parent_guid AS BLOB)) + LENGTH(CAST(COALESCE(emoji, '') AS BLOB)) + LENGTH(CAST(COALESCE(handle, '') AS BLOB))), 0) AS bytes,
            COALESCE(MAX(LENGTH(CAST(parent_guid AS BLOB))), 0) AS max_parent,
            COALESCE(MAX(LENGTH(CAST(COALESCE(emoji, '') AS BLOB))), 0) AS max_emoji,
            COALESCE(MAX(LENGTH(CAST(COALESCE(handle, '') AS BLOB))), 0) AS max_handle
     FROM (SELECT m.associated_message_guid AS parent_guid, ${emoji} AS emoji, h.id AS handle ${source})`,
  ).get(...bindings) as { rows: number; bytes: number; max_parent: number; max_emoji: number; max_handle: number };
  if (
    Number(stats.rows) > MAX_RELATED_ROWS ||
    Number(stats.bytes) > MAX_RELATED_TEXT_BYTES ||
    Number(stats.max_parent) > MAX_RELATED_VALUE_BYTES ||
    Number(stats.max_emoji) > MAX_RELATED_VALUE_BYTES ||
    Number(stats.max_handle) > MAX_RELATED_VALUE_BYTES
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "reaction history for the selected page exceeds its bounded source budget");
  }
  const rows = request.db
    .prepare(
      `SELECT m.ROWID AS rowid, m.associated_message_guid AS parent_guid,
              m.associated_message_type AS type_code, ${emoji} AS emoji,
              h.id AS handle, m.handle_id, m.is_from_me
       ${source}
       ORDER BY ${appleTimestampSortSql("m.date")}, m.ROWID
       LIMIT ${MAX_RELATED_ROWS + 1}`,
    )
    .all(...bindings) as ReactionRow[];
  const stateByKey = new Map<string, ReactionRow>();
  for (const row of rows) {
    const parent = normalizeReactionParent(row.parent_guid);
    const removal = row.type_code >= 3000;
    const baseCode = removal ? row.type_code - 1000 : row.type_code;
    if (!row.is_from_me && row.handle === null && row.handle_id === null) {
      throw new ImessageMcpError(
        "UNSUPPORTED_SCHEMA",
        "a reaction actor could not be identified well enough to fold current reaction state",
      );
    }
    const actor = row.is_from_me ? "me" : row.handle ?? `handle:${String(row.handle_id ?? row.rowid)}`;
    const key = `${parent}\0${actor}\0${baseCode}\0${row.emoji ?? ""}`;
    if (removal) stateByKey.delete(key);
    else stateByKey.set(key, { ...row, parent_guid: parent, type_code: baseCode });
  }
  const byParent = new Map<string, ReactionRow[]>();
  for (const row of stateByKey.values()) {
    const current = byParent.get(row.parent_guid) ?? [];
    current.push(row);
    byParent.set(row.parent_guid, current);
  }
  return byParent;
}

function loadAttachments(
  request: DatabaseRequest,
  messageIds: number[],
  includePaths: boolean,
): Map<number, TimelineEvent["attachments"]> {
  const result = new Map<number, TimelineEvent["attachments"]>();
  if (request.capabilities.attachments !== "available" || messageIds.length === 0) return result;
  const columns = request.capabilities.tables.attachment ?? [];
  const select = [
    "maj.message_id",
    columns.includes("transfer_name") ? "a.transfer_name" : "NULL AS transfer_name",
    columns.includes("filename") ? "a.filename" : "NULL AS filename",
    columns.includes("mime_type") ? "a.mime_type" : "NULL AS mime_type",
    columns.includes("total_bytes") ? "a.total_bytes" : "NULL AS total_bytes",
  ].join(", ");
  const statsParts = ["transfer_name", "filename", "mime_type"]
    .filter((column) => columns.includes(column))
    .map((column) => `LENGTH(CAST(COALESCE(a.${column}, '') AS BLOB))`);
  const stats = request.db.prepare(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(${statsParts.length ? statsParts.join(" + ") : "0"}), 0) AS bytes,
            COALESCE(MAX(${statsParts.length ? `MAX(${statsParts.join(", ")})` : "0"}), 0) AS max_value
     FROM message_attachment_join maj
     JOIN attachment a ON a.ROWID = maj.attachment_id
     WHERE maj.message_id IN (${placeholders(messageIds)})`,
  ).get(...messageIds) as { rows: number; bytes: number; max_value: number };
  if (
    Number(stats.rows) > MAX_RELATED_ROWS ||
    Number(stats.bytes) > MAX_RELATED_TEXT_BYTES ||
    Number(stats.max_value) > MAX_RELATED_VALUE_BYTES
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "attachments for the selected page exceed their bounded source budget");
  }
  const rows = request.db
    .prepare(
      `SELECT ${select}
       FROM message_attachment_join maj
       JOIN attachment a ON a.ROWID = maj.attachment_id
       WHERE maj.message_id IN (${placeholders(messageIds)})
       ORDER BY maj.message_id, a.ROWID
       LIMIT ${MAX_RELATED_ROWS + 1}`,
    )
    .all(...messageIds) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const messageId = Number(row.message_id);
    const filename = typeof row.filename === "string" ? row.filename : null;
    const transferName = typeof row.transfer_name === "string" ? row.transfer_name : null;
    const publicName = transferName || filename;
    const absolutePath = filename?.startsWith("~/")
      ? path.join(homedir(), filename.slice(2))
      : filename && path.isAbsolute(filename) ? filename : null;
    const totalBytes = Number(row.total_bytes);
    if (row.total_bytes !== null && row.total_bytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes < 0)) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "attachment metadata contains an invalid byte count");
    }
    const attachment = {
      filename: publicName ? path.basename(publicName) : null,
      mime_type: typeof row.mime_type === "string" ? row.mime_type : null,
      bytes: row.total_bytes === null || row.total_bytes === undefined ? null : totalBytes,
      ...(includePaths && absolutePath ? { path: absolutePath } : {}),
    };
    const list = result.get(messageId) ?? [];
    list.push(attachment);
    result.set(messageId, list);
  }
  return result;
}

function systemType(row: MessageRow): TimelineEventType {
  if (row.item_type === 1 && row.group_action_type === 0) return "participant_joined";
  if (row.item_type === 1 && row.group_action_type === 1) return "participant_left";
  if (row.item_type === 2 || row.group_title !== null) return "group_renamed";
  return "system_change";
}

function baseSelect(request: DatabaseRequest): string {
  const columns = request.capabilities.tables.message ?? [];
  const value = (column: string, fallback = "NULL") => columns.includes(column) ? `m.${column}` : `${fallback} AS ${column}`;
  const timestamp = (column: string) => columns.includes(column)
    ? `CAST(COALESCE(m.${column}, 0) AS TEXT) AS ${column}`
    : `'0' AS ${column}`;
  return [
    "m.ROWID AS rowid",
    "m.guid",
    value("text"),
    columns.includes("text") ? "TYPEOF(m.text) AS text_type" : "'null' AS text_type",
    columns.includes("attributedBody") ? "m.attributedBody AS attributed_body" : "NULL AS attributed_body",
    columns.includes("attributedBody") ? "TYPEOF(m.attributedBody) AS attributed_body_type" : "'null' AS attributed_body_type",
    columns.includes("message_summary_info") ? "m.message_summary_info AS summary_info" : "NULL AS summary_info",
    columns.includes("message_summary_info") ? "TYPEOF(m.message_summary_info) AS summary_info_type" : "'null' AS summary_info_type",
    "h.id AS handle",
    "m.is_from_me",
    `CAST(${appleTimestampSortSql("m.date")} AS TEXT) AS date`,
    `${serviceSql(request, "m", "scoped")} AS service`,
    value("item_type", "0"),
    value("is_system_message", "0"),
    value("group_action_type", "0"),
    value("group_title"),
    columns.includes("other_handle") ? "oh.id AS other_handle" : "NULL AS other_handle",
    timestamp("date_edited"),
    timestamp("date_retracted"),
    columns.includes("reply_to_guid") ? "m.reply_to_guid" : columns.includes("thread_originator_guid") ? "m.thread_originator_guid AS reply_to_guid" : "NULL AS reply_to_guid",
    value("is_delivered", "0"),
    value("is_read", "0"),
    timestamp("date_delivered"),
    timestamp("date_read"),
    value("associated_message_type", "0"),
  ].join(", ");
}

function aggregateSelect(request: DatabaseRequest): string {
  const columns = request.capabilities.tables.message ?? [];
  const expression = (column: string, fallback = "NULL") => columns.includes(column) ? `m.${column}` : fallback;
  return [
    "m.ROWID AS rowid",
    "'' AS guid",
    "NULL AS text",
    "NULL AS attributed_body",
    "NULL AS summary_info",
    "NULL AS handle",
    "m.is_from_me",
    `CAST(${appleTimestampSortSql("m.date")} AS TEXT) AS date`,
    `${serviceFamilyCase(serviceSql(request, "m", "scoped"))} AS service`,
    `${expression("item_type", "0")} AS item_type`,
    `${expression("is_system_message", "0")} AS is_system_message`,
    `${expression("group_action_type", "0")} AS group_action_type`,
    columns.includes("group_title") ? "CASE WHEN m.group_title IS NULL THEN NULL ELSE '' END AS group_title" : "NULL AS group_title",
    "NULL AS other_handle",
    "'0' AS date_edited",
    `CAST(COALESCE(${expression("date_retracted", "0")}, 0) AS TEXT) AS date_retracted`,
    "NULL AS reply_to_guid",
    "0 AS is_delivered",
    "0 AS is_read",
    "'0' AS date_delivered",
    "'0' AS date_read",
    "0 AS associated_message_type",
  ].join(", ");
}

function sourceLengthSelect(request: DatabaseRequest): string {
  const columns = request.capabilities.tables.message ?? [];
  const bytes = (expression: string) => `COALESCE(LENGTH(CAST(${expression} AS BLOB)), 0)`;
  const columnBytes = (column: string) => columns.includes(column) ? bytes(`m.${column}`) : "0";
  const metadata = [
    bytes("m.guid"),
    bytes("h.id"),
    bytes(serviceSql(request, "m", "scoped")),
    columns.includes("group_title") ? bytes("m.group_title") : "0",
    columns.includes("reply_to_guid")
      ? bytes("m.reply_to_guid")
      : columns.includes("thread_originator_guid")
        ? bytes("m.thread_originator_guid")
        : "0",
    columns.includes("other_handle") ? bytes("oh.id") : "0",
  ];
  return [
    "m.ROWID AS rowid",
    `${columnBytes("text")} AS text_bytes`,
    `${columnBytes("attributedBody")} AS body_bytes`,
    `${columnBytes("message_summary_info")} AS summary_bytes`,
    `${metadata.join(" + ")} AS metadata_bytes`,
    `${metadata.length === 1 ? metadata[0] : `MAX(${metadata.join(", ")})`} AS max_metadata`,
  ].join(", ");
}

function assertSelectedSourceBudget(
  request: DatabaseRequest,
  selections: Array<{ sql: string; bindings: unknown[] }>,
): void {
  let total = 0;
  let maxText = 0;
  let maxBody = 0;
  let maxSummary = 0;
  let maxMetadata = 0;
  for (const selection of selections) {
    const row = request.db.prepare(
      `SELECT COALESCE(SUM(text_bytes + body_bytes + summary_bytes + metadata_bytes), 0) AS total,
              COALESCE(MAX(text_bytes), 0) AS max_text,
              COALESCE(MAX(body_bytes), 0) AS max_body,
              COALESCE(MAX(summary_bytes), 0) AS max_summary,
              COALESCE(MAX(max_metadata), 0) AS max_metadata
       FROM (${selection.sql})`,
    ).get(...selection.bindings) as {
      total: number;
      max_text: number;
      max_body: number;
      max_summary: number;
      max_metadata: number;
    };
    total += Number(row.total || 0);
    maxText = Math.max(maxText, Number(row.max_text || 0));
    maxBody = Math.max(maxBody, Number(row.max_body || 0));
    maxSummary = Math.max(maxSummary, Number(row.max_summary || 0));
    maxMetadata = Math.max(maxMetadata, Number(row.max_metadata || 0));
  }
  if (
    total > MAX_SELECTED_SOURCE_BYTES ||
    maxText > MAX_MESSAGE_TEXT_BYTES ||
    maxBody > MAX_MESSAGE_BLOB_BYTES ||
    maxSummary > MAX_MESSAGE_BLOB_BYTES ||
    maxMetadata > MAX_RELATED_VALUE_BYTES
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "selected message source values exceed the bounded decode and response budget", {
      limit_bytes: MAX_SELECTED_SOURCE_BYTES,
      max_text_bytes: MAX_MESSAGE_TEXT_BYTES,
      max_blob_bytes: MAX_MESSAGE_BLOB_BYTES,
      retry: "use a smaller limit or a narrower date range",
    });
  }
}

function rowPredicate(request: DatabaseRequest, eventFilters: TimelineEventType[] | undefined): string {
  const associated = columnSql(request, "message", "m", "associated_message_type", "0");
  const item = columnSql(request, "message", "m", "item_type", "0");
  const action = columnSql(request, "message", "m", "group_action_type", "-1");
  const systemFlag = columnSql(request, "message", "m", "is_system_message", "0");
  const retracted = columnSql(request, "message", "m", "date_retracted", "0");
  const groupTitle = columnSql(request, "message", "m", "group_title", "NULL");
  const regular = `(COALESCE(${item}, 0) = 0 AND COALESCE(${associated}, 0) = 0 AND COALESCE(${systemFlag}, 0) <> 1)`;
  const system = `(COALESCE(${item}, 0) <> 0 OR COALESCE(${systemFlag}, 0) = 1)`;
  const requested = eventFilters ?? ["message", "retraction", "participant_joined", "participant_left", "group_renamed", "system_change"];
  const options: string[] = [];
  if (requested.includes("message")) options.push(`(${regular} AND COALESCE(${retracted}, 0) <= 0)`);
  if (requested.includes("retraction")) options.push(`(${regular} AND COALESCE(${retracted}, 0) > 0)`);
  if (requested.includes("participant_joined")) options.push(`(${system} AND COALESCE(${item}, 0) = 1 AND COALESCE(${action}, -1) = 0)`);
  if (requested.includes("participant_left")) options.push(`(${system} AND COALESCE(${item}, 0) = 1 AND COALESCE(${action}, -1) = 1)`);
  if (requested.includes("group_renamed")) options.push(`(${system} AND (COALESCE(${item}, 0) = 2 OR ${groupTitle} IS NOT NULL))`);
  if (requested.includes("system_change")) {
    options.push(`(${system}
      AND NOT (COALESCE(${item}, 0) = 1 AND COALESCE(${action}, -1) IN (0, 1))
      AND NOT (COALESCE(${item}, 0) = 2 OR ${groupTitle} IS NOT NULL))`);
  }
  return `(${options.join(" OR ") || "0"})`;
}

function validateMessageRows(rows: MessageRow[]): MessageRow[] {
  for (const row of rows) {
    if (!Number.isSafeInteger(Number(row.rowid)) || Number(row.rowid) <= 0 || typeof row.guid !== "string") {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "selected message contains an invalid identifier");
    }
    row.rowid = Number(row.rowid);
    row.date = sqliteIntegerToken(row.date, "message timestamp");
    row.date_edited = sqliteIntegerToken(row.date_edited, "message edit timestamp");
    row.date_retracted = sqliteIntegerToken(row.date_retracted, "message retraction timestamp");
    row.date_delivered = sqliteIntegerToken(row.date_delivered, "message delivery timestamp");
    row.date_read = sqliteIntegerToken(row.date_read, "message read timestamp");
  }
  return rows;
}

function loadRows(input: {
  request: DatabaseRequest;
  chatIds: number[];
  frozen: Watermark;
  limit: number;
  bounds: DateBounds;
  service?: ServiceFamily;
  eventFilters?: TimelineEventType[];
  aroundId?: number;
  before?: { date: string; rowid: number };
  aggregateOnly?: boolean;
}): MessageRow[] {
  const { request } = input;
  const sortDate = appleTimestampSortSql("m.date");
  const where = [
    "m.ROWID <= ?",
    rowPredicate(request, input.eventFilters),
  ];
  const bindings: unknown[] = [...input.chatIds, input.frozen.max_message_id];
  if (input.bounds.from_unix_seconds !== undefined) {
    const boundary = appleTimestampBoundary(input.bounds.from_unix_seconds);
    where.push(appleTimestampBoundarySql("m.date", ">=", "?", "?"));
    bindings.push(boundary.nanoseconds, boundary.seconds);
  }
  if (input.bounds.to_unix_seconds !== undefined) {
    const boundary = appleTimestampBoundary(input.bounds.to_unix_seconds);
    where.push(appleTimestampBoundarySql("m.date", "<", "?", "?"));
    bindings.push(boundary.nanoseconds, boundary.seconds);
  }
  if (input.service) {
    where.push(serviceFamilyPredicate(serviceSql(request, "m", "scoped"), input.service));
  }
  if (input.before) {
    where.push(`(${sortDate} < ? OR (${sortDate} = ? AND m.ROWID < ?))`);
    const exactDate = sqliteIntegerBinding(input.before.date);
    bindings.push(exactDate, exactDate, input.before.rowid);
  }

  const chatService = (request.capabilities.tables.chat ?? []).includes("service_name")
    ? `CASE
        WHEN COUNT(DISTINCT ${serviceFamilyCase("c.service_name")}) = 1 THEN MIN(c.service_name)
        ELSE 'unknown'
      END`
    : "NULL";
  const scopeCte = `WITH scoped_messages AS (
    SELECT cmj.message_id, ${chatService} AS service_name
    FROM chat_message_join cmj
    JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE cmj.chat_id IN (${placeholders(input.chatIds)})
    GROUP BY cmj.message_id
  )`;
  const common = `FROM message m
    JOIN scoped_messages scoped ON scoped.message_id = m.ROWID
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    ${request.capabilities.tables.message?.includes("other_handle") ? "LEFT JOIN handle oh ON oh.ROWID = m.other_handle" : ""}
    WHERE ${where.join(" AND ")}`;
  if (!input.aroundId) {
    if (!input.aggregateOnly) {
      assertSelectedSourceBudget(request, [{
        sql: `${scopeCte} SELECT ${sourceLengthSelect(request)} ${common} ORDER BY ${sortDate} DESC, m.ROWID DESC LIMIT ?`,
        bindings: [...bindings, input.limit],
      }]);
    }
    const select = input.aggregateOnly ? aggregateSelect(request) : baseSelect(request);
    return validateMessageRows(request.db
      .prepare(`${scopeCte} SELECT * FROM (SELECT ${select} ${common} ORDER BY ${sortDate} DESC, m.ROWID DESC LIMIT ?) ORDER BY CAST(date AS INTEGER), rowid`)
      .all(...bindings, input.limit) as MessageRow[]);
  }

  const center = request.db
    .prepare(`SELECT CAST(${sortDate} AS TEXT) AS date, m.ROWID AS rowid
      FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE m.ROWID = ? AND cmj.chat_id IN (${placeholders(input.chatIds)})`)
    .get(input.aroundId, ...input.chatIds) as { date: string; rowid: number } | undefined;
  if (!center) throw new ImessageMcpError("INVALID_INPUT", "around_message reference was not found");
  const centerDate = sqliteIntegerBinding(sqliteIntegerToken(center.date, "around-message timestamp"));
  const before = Math.floor((input.limit - 1) / 2);
  const after = input.limit - before - 1;
  if (!input.aggregateOnly) {
    assertSelectedSourceBudget(request, [
      {
        sql: `${scopeCte} SELECT ${sourceLengthSelect(request)} ${common} AND (${sortDate} < ? OR (${sortDate} = ? AND m.ROWID <= ?)) ORDER BY ${sortDate} DESC, m.ROWID DESC LIMIT ?`,
        bindings: [...bindings, centerDate, centerDate, center.rowid, before + 1],
      },
      {
        sql: `${scopeCte} SELECT ${sourceLengthSelect(request)} ${common} AND (${sortDate} > ? OR (${sortDate} = ? AND m.ROWID > ?)) ORDER BY ${sortDate}, m.ROWID LIMIT ?`,
        bindings: [...bindings, centerDate, centerDate, center.rowid, after],
      },
    ]);
  }
  const select = input.aggregateOnly ? aggregateSelect(request) : baseSelect(request);
  const older = request.db
    .prepare(`${scopeCte} SELECT ${select} ${common} AND (${sortDate} < ? OR (${sortDate} = ? AND m.ROWID <= ?)) ORDER BY ${sortDate} DESC, m.ROWID DESC LIMIT ?`)
    .all(...bindings, centerDate, centerDate, center.rowid, before + 1) as MessageRow[];
  const newer = request.db
    .prepare(`${scopeCte} SELECT ${select} ${common} AND (${sortDate} > ? OR (${sortDate} = ? AND m.ROWID > ?)) ORDER BY ${sortDate}, m.ROWID LIMIT ?`)
    .all(...bindings, centerDate, centerDate, center.rowid, after) as MessageRow[];
  return validateMessageRows([...older.reverse(), ...newer])
    .sort((a, b) => compareSqliteIntegers(a.date, b.date) || a.rowid - b.rowid);
}

function receiptFor(row: MessageRow, request: DatabaseRequest): TimelineEvent["receipt"] {
  if (request.capabilities.receipts !== "available") {
    return { capability: "unavailable", direction: row.is_from_me ? "remote" : "local" };
  }
  const direction = row.is_from_me ? "remote" : "local";
  if (sqliteIntegerIsPositive(row.date_read) || row.is_read) {
    return {
      capability: "available",
      direction,
      state: "read",
      delivered_at: appleTimestampToIso(row.date_delivered),
      read_at: appleTimestampToIso(row.date_read),
    };
  }
  if (sqliteIntegerIsPositive(row.date_delivered) || row.is_delivered) {
    return {
      capability: "available",
      direction,
      state: "delivered",
      delivered_at: appleTimestampToIso(row.date_delivered),
      read_at: null,
    };
  }
  return {
    capability: "available",
    direction,
    state: row.is_from_me ? "sent" : "delivered",
    delivered_at: null,
    read_at: null,
  };
}

async function materialize(input: {
  rows: MessageRow[];
  request: DatabaseRequest;
  contacts: UnifiedContactResolver;
  decoder: MessageTextDecoder;
  chatIds: number[];
  frozen: Watermark;
  allowPartial: boolean;
  includeAttachmentPaths: boolean;
}): Promise<{ events: TimelineEvent[]; warnings: Warning[] }> {
  const unsupportedStorage = input.rows.filter((row) =>
    (row.text_type !== "text" && row.text_type !== "null") ||
    (row.attributed_body_type !== "blob" && row.attributed_body_type !== "null") ||
    (row.summary_info_type !== "blob" && row.summary_info_type !== "null"),
  );
  if (unsupportedStorage.length > 0 && !input.allowPartial) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "a selected message uses an unsupported SQLite body storage class", {
      skipped_count: unsupportedStorage.length,
    });
  }
  const undecoded = input.rows.filter((row) => !populatedMessageText(row.text) && row.attributed_body && !sqliteIntegerIsPositive(row.date_retracted));
  let decoded: DecodeResult[] = [];
  let editMetadata: EditMetadataResult[] = [];
  const warnings: Warning[] = [];
  if (unsupportedStorage.length > 0) {
    warnings.push({
      code: "UNSUPPORTED_SCHEMA",
      message: "some selected messages use unsupported SQLite body storage classes",
      skipped_count: unsupportedStorage.length,
    });
  }
  if (undecoded.length) {
    try {
      decoded = await input.decoder.decode(undecoded.map((row) => row.attributed_body as Buffer));
    } catch (error) {
      if (!input.allowPartial) throw error;
      decoded = undecoded.map(() => ({ status: "unsupported" }));
    }
  }
  const decodedById = new Map<number, DecodeResult>();
  undecoded.forEach((row, index) => decodedById.set(row.rowid, decoded[index]));
  const editedWithSummary = input.rows.filter((row) => sqliteIntegerIsPositive(row.date_edited) && row.summary_info);
  if (editedWithSummary.length) {
    try {
      editMetadata = await input.decoder.decodeEditMetadata(
        editedWithSummary.map((row) => row.summary_info as Buffer),
      );
    } catch (error) {
      if (!input.allowPartial) throw error;
      editMetadata = editedWithSummary.map(() => ({ status: "unsupported" }));
    }
  }
  const editMetadataById = new Map<number, EditMetadataResult>();
  editedWithSummary.forEach((row, index) => editMetadataById.set(row.rowid, editMetadata[index]));
  const bodyFailures = undecoded.filter((_row, index) => decoded[index]?.status !== "decoded").length;
  const editFailures = editedWithSummary.filter((_row, index) => editMetadata[index]?.status !== "decoded").length;
  if (bodyFailures > 0 || editFailures > 0) {
    if (!input.allowPartial) {
      throw new ImessageMcpError("DECODE_FAILED", "a selected message body or edit record could not be decoded");
    }
    warnings.push({
      code: "DECODE_FAILED",
      message: "some selected message bodies or edit records could not be decoded",
      skipped_count: bodyFailures + editFailures,
    });
  }
  const reactions = loadReactions(
    input.request,
    input.chatIds,
    input.frozen.max_message_id,
    input.rows.map((row) => row.guid),
  );
  const attachments = loadAttachments(input.request, input.rows.map((row) => row.rowid), input.includeAttachmentPaths);
  const events: TimelineEvent[] = [];

  for (const row of input.rows) {
    const timestamp = appleTimestampToIso(row.date);
    const service = serviceFamily(row.service);
    if (row.item_type !== 0 || row.is_system_message !== 0) {
      events.push({
        event_type: systemType(row),
        timestamp,
        service_family: service,
        direction: "system",
        system: {
          action_code: Number.isFinite(row.group_action_type) ? row.group_action_type : null,
          affected_handle: row.other_handle ?? row.handle,
          title: row.group_title,
        },
        row_status: "complete",
      });
      continue;
    }
    const retracted = sqliteIntegerIsPositive(row.date_retracted);
    const storageUnsupported = (row.text_type !== "text" && row.text_type !== "null") ||
      (row.attributed_body_type !== "blob" && row.attributed_body_type !== "null") ||
      (row.summary_info_type !== "blob" && row.summary_info_type !== "null");
    const nativeText = retracted ? null : populatedMessageText(row.text);
    const decode = decodedById.get(row.rowid);
    const text = retracted ? undefined : nativeText ?? (decode?.status === "decoded" ? decode.text : undefined);
    const textStatus: TimelineEvent["text_status"] = retracted
      ? "absent"
      : storageUnsupported
      ? "unsupported"
      : nativeText || decode?.status === "decoded"
      ? "decoded"
      : decode?.status ?? "absent";
    const senderHandle = row.is_from_me ? null : row.handle;
    const currentReactions = (reactions.get(row.guid) ?? []).map((reaction) => {
      const handle = reaction.is_from_me ? null : reaction.handle;
      return {
        type: reactionName(reaction.type_code, reaction.emoji),
        ...(reaction.emoji ? { emoji: reaction.emoji } : {}),
        sender: { name: handle ? input.contacts.nameForHandle(handle) : "Me", handle },
      };
    });
    const editResult = editMetadataById.get(row.rowid);
    const fallbackEditTimestamp = appleTimestampToIso(row.date_edited);
    const decodedEditTimestamps = editResult?.status === "decoded"
      ? editResult.timestamps.map(appleTimestampToIso).filter((value): value is string => Boolean(value))
      : [];
    const edit = sqliteIntegerIsPositive(row.date_edited)
      ? editResult?.status === "decoded" && editResult.count > 0
        ? { state: "available" as const, count: editResult.count, timestamps: decodedEditTimestamps }
        : { state: "unknown" as const, count: null, timestamps: fallbackEditTimestamp ? [fallbackEditTimestamp] : [] }
      : service === "sms" || service === "rcs"
        ? { state: "unavailable" as const, count: null, timestamps: [] }
        : service === "unknown"
          ? { state: "unknown" as const, count: null, timestamps: [] }
          : { state: input.request.capabilities.edits, count: 0, timestamps: [] };
    const bodyPartial = Boolean(storageUnsupported || (row.attributed_body && !retracted && !nativeText && decode?.status !== "decoded"));
    const editPartial = Boolean(sqliteIntegerIsPositive(row.date_edited) && row.summary_info && editResult?.status !== "decoded");
    const event: TimelineEvent = {
      event_type: retracted ? "retraction" : "message",
      message_ref: encodeReference(input.request.referenceKey, input.request.lineage, "message", { rowid: row.rowid, guid: row.guid }),
      timestamp,
      service_family: service,
      direction: row.is_from_me ? "outgoing" : "incoming",
      sender: { name: senderHandle ? input.contacts.nameForHandle(senderHandle) : "Me", handle: senderHandle },
      ...(text !== undefined ? { text } : {}),
      text_status: textStatus,
      ...(retracted ? { retraction: { state: "retracted" as const, at: appleTimestampToIso(row.date_retracted) } } : {}),
      edit,
      reactions: currentReactions,
      receipt: receiptFor(row, input.request),
      attachments: retracted ? [] : attachments.get(row.rowid) ?? [],
      ...(row.reply_to_guid
        ? { reply_to_ref: encodeReference(input.request.referenceKey, input.request.lineage, "message", { guid: row.reply_to_guid }) }
        : {}),
      ...(bodyPartial || editPartial ? { row_status: "partial" as const } : { row_status: "complete" as const }),
    };
    if (event.row_status === "partial" && !input.allowPartial) {
      throw new ImessageMcpError("DECODE_FAILED", "a selected message body could not be decoded");
    }
    events.push(event);
  }
  return { events, warnings };
}

export async function getConversationEvents(input: {
  context: DatabaseContext;
  contacts: UnifiedContactResolver;
  decoder: MessageTextDecoder;
  chatIds: number[];
  limit: number;
  bounds: DateBounds;
  service?: ServiceFamily;
  eventFilters?: TimelineEventType[];
  aroundMessage?: string;
  cursor?: string;
  allowPartial: boolean;
  privacy: PrivacyMode;
  includeAttachmentPaths: boolean;
}): Promise<{
  events: TimelineEvent[];
  warnings: Warning[];
  frozen: Watermark;
  asOf: string;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const request = input.context.request();
  const budget = makeBudget(30_000, 50_000);
  try {
    if (input.aroundMessage && input.cursor) {
      throw new ImessageMcpError("INVALID_INPUT", "around_message cannot be combined with cursor");
    }
    const hash = queryHash(input);
    let frozen = request.asOf;
    let before: ConversationCursor | undefined;
    if (input.cursor) {
      const decoded = decodeReference(request.referenceKey, request.lineage, "page", input.cursor).value as unknown as ConversationCursor;
      if (
        decoded.query_hash !== hash ||
        !Number.isSafeInteger(decoded.before_rowid) || decoded.before_rowid <= 0
      ) {
        throw new ImessageMcpError("INVALID_INPUT", "cursor does not match this conversation query");
      }
      let beforeDate: string;
      try {
        beforeDate = sqliteIntegerToken(decoded.before_date, "conversation cursor timestamp");
      } catch {
        throw new ImessageMcpError("INVALID_INPUT", "cursor contains an invalid conversation position");
      }
      frozen = parseWatermark(decoded.frozen);
      assertFrozenTraversal(frozen, request.asOf);
      before = { ...decoded, frozen, before_date: beforeDate };
    }
    const around = input.aroundMessage
      ? decodeReference(request.referenceKey, request.lineage, "message", input.aroundMessage).value
      : undefined;
    let aroundId = around && Number.isSafeInteger(around.rowid) && Number(around.rowid) > 0
      ? Number(around.rowid)
      : undefined;
    if (aroundId && typeof around?.guid === "string") {
      const row = request.db.prepare("SELECT guid FROM message WHERE ROWID = ?").get(aroundId) as { guid: string } | undefined;
      if (!row || row.guid !== around.guid) aroundId = undefined;
    }
    if (!aroundId && typeof around?.guid === "string") {
      const row = request.db.prepare("SELECT ROWID AS rowid FROM message WHERE guid = ?").get(around.guid) as { rowid: number } | undefined;
      aroundId = row?.rowid;
    }
    if (input.aroundMessage && !aroundId) {
      throw new ImessageMcpError("INVALID_INPUT", "around_message reference was not found");
    }
    const rows = loadRows({
      request,
      chatIds: input.chatIds,
      frozen,
      limit: input.aroundMessage ? input.limit : input.limit + 1,
      bounds: input.bounds,
      service: input.service,
      eventFilters: input.eventFilters,
      aroundId,
      before: before ? { date: before.before_date, rowid: before.before_rowid } : undefined,
      aggregateOnly: input.privacy === "aggregate",
    });
    request.guard(budget, rows.length);
    const hasMore = !input.aroundMessage && rows.length > input.limit;
    const selected = hasMore ? rows.slice(rows.length - input.limit) : rows;
    const materialized = input.privacy === "aggregate"
      ? {
          events: selected.map((row): TimelineEvent => ({
            event_type: row.item_type !== 0 || row.is_system_message !== 0
              ? systemType(row)
              : sqliteIntegerIsPositive(row.date_retracted) ? "retraction" : "message",
            timestamp: null,
            service_family: serviceFamily(row.service),
            direction: row.item_type !== 0 || row.is_system_message !== 0
              ? "system"
              : row.is_from_me ? "outgoing" : "incoming",
            row_status: "complete",
          })),
          warnings: [],
        }
      : await materialize({
          rows: selected,
          request,
          contacts: input.contacts,
          decoder: input.decoder,
          chatIds: input.chatIds,
          frozen,
          allowPartial: input.allowPartial,
          includeAttachmentPaths: input.includeAttachmentPaths,
        });
    const textBytes = materialized.events.reduce(
      (total, event) => total + (event.text ? Buffer.byteLength(event.text, "utf8") : 0),
      0,
    );
    if (textBytes > MAX_CONVERSATION_TEXT_BYTES) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "selected exact message bodies exceed the response budget", {
        limit_bytes: MAX_CONVERSATION_TEXT_BYTES,
        retry: "use a smaller limit or a narrower date range",
      });
    }
    const oldest = selected[0];
    const nextCursor = hasMore && oldest
      ? encodeReference(request.referenceKey, request.lineage, "page", {
          frozen,
          query_hash: hash,
          before_date: oldest.date,
          before_rowid: oldest.rowid,
        })
      : null;
    return {
      ...materialized,
      frozen,
      asOf: watermarkToken(frozen),
      hasMore,
      nextCursor,
    };
  } finally {
    request.close();
  }
}

export function resolveMessageReference(referenceKey: Buffer, lineage: string, reference: string): { rowid?: number; guid?: string } {
  const value = decodeReference(referenceKey, lineage, "message", reference).value;
  return {
    ...(Number.isInteger(value.rowid) ? { rowid: Number(value.rowid) } : {}),
    ...(typeof value.guid === "string" ? { guid: value.guid } : {}),
  };
}

export function validateFrozenReference(current: Watermark, frozen: Watermark): void {
  assertFrozenTraversal(frozen, current);
}
