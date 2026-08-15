import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import type { PrivacyMode, ServiceFamily, Warning, Watermark } from "../contracts.js";
import { serviceFamily } from "../contracts.js";
import type { UnifiedContactResolver } from "../contacts.js";
import type { DatabaseContext, DatabaseRequest } from "../database.js";
import { assertFrozenTraversal, parseWatermark, watermarkToken } from "../database.js";
import type { MessageTextDecoder } from "../decoder.js";
import { populatedMessageText } from "../decoder.js";
import { ImessageMcpError } from "../errors.js";
import { decodeReference, encodeReference, MAX_SYNC_CURSOR_LENGTH } from "../references.js";
import { validateSender } from "../sender.js";
import { columnSql, serviceFamilyCase, serviceSql } from "../schema-sql.js";
import {
  appleTimestampBoundary,
  appleTimestampBoundarySql,
  appleTimestampSortSql,
  appleTimestampSortToken,
  appleTimestampToIso,
  compareSqliteIntegers,
  sqliteIntegerBinding,
  sqliteIntegerIsPositive,
  sqliteIntegerToken,
} from "../time.js";
import { normalizeReactionParent } from "./messages.js";
import { resolveUniqueMessageGuids } from "./message-integrity.js";
import { assertMessageConversationIntegrity, type ConversationCatalog } from "./conversations.js";

export type ChangeType =
  | "message_created"
  | "message_edited"
  | "message_retracted"
  | "reaction_added"
  | "reaction_removed"
  | "receipt_changed"
  | "group_event";

export interface SyncChange {
  change_type: ChangeType;
  changed_at: string | null;
  message_ref?: string;
  conversation_ref?: string;
  parent_message_ref?: string;
  service_family: ServiceFamily;
  direction?: "incoming" | "outgoing" | "system";
  sender?: { name: string | null; handle: string | null };
  text?: string;
  current_state?: Record<string, unknown>;
  row_status: "complete" | "partial";
}

interface SyncCursor {
  version: 2;
  source_mode: "live" | "copy";
  checkpoint: Watermark;
  checkpoint_integrity?: SyncIntegrity;
  checkpoint_copy_fingerprint?: string;
  target?: Watermark;
  target_integrity?: SyncIntegrity;
  after_time?: string;
  after_key?: string;
}

interface SyncIntegrity {
  structural_signature: string;
  content_signature: string;
  receipt_signature: string;
  mutable_content_state: string;
  prefix_rows: number;
  prefix_relations: number;
}

interface RawChange extends Record<string, unknown> {
  key: string;
  change_type: ChangeType;
  change_time: string;
  sort_time: string;
  rowid: number;
  guid: string;
  text: string | null;
  text_unsupported: number;
  attributed_body: Buffer | null;
  body_unsupported: number;
  is_from_me: number;
  handle: string | null;
  handle_id: number | null;
  service: string | null;
  chat_ids_json: string;
  associated_message_guid: string | null;
  associated_message_type: number;
  associated_message_emoji: string | null;
  date_read: string;
  date_delivered: string;
  date_retracted: string;
  item_type: number;
  group_action_type: number;
  group_title: string | null;
}

const MAX_SYNC_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SYNC_BLOB_BYTES = 1024 * 1024;
const MAX_SYNC_METADATA_BYTES = 1024 * 1024;
const MAX_SYNC_METADATA_VALUE_BYTES = 4096;
const MAX_SYNC_MESSAGE_ROWS = 10_000_000;
const MAX_SYNC_RELATIONS = 20_000_000;
const MAX_SYNC_CHATS_PER_MESSAGE = 1_000;
const MAX_SYNC_INTEGRITY_BYTES = 512 * 1024 * 1024;
const MAX_SYNC_INTEGRITY_VALUE_BYTES = 8 * 1024 * 1024;
const MUTABLE_CONTENT_WINDOW_SECONDS = 60 * 60;
const MAX_MUTABLE_CONTENT_ROWS = 2_048;
const MUTABLE_CONTENT_RECORD_BYTES = 24;
const MAX_COPY_FINGERPRINT_BYTES = 8 * 1024 * 1024 * 1024;
const COPY_FINGERPRINT_TIMEOUT_MS = 25_000;
const COPY_FINGERPRINT_READ_BYTES = 1024 * 1024;

interface FingerprintedFile {
  path: string;
  optional: boolean;
  present: boolean;
  device?: bigint;
  inode?: bigint;
  size?: bigint;
  modified?: bigint;
  changed?: bigint;
}

interface PreparedCopyFingerprint {
  fingerprint: string;
  watermark: Watermark;
}

const preparedCopyFingerprints = new WeakMap<DatabaseContext, Promise<PreparedCopyFingerprint>>();

async function fingerprintFile(
  hash: ReturnType<typeof createHmac>,
  filePath: string,
  optional: boolean,
  deadline: number,
): Promise<FingerprintedFile> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
      updateSignature(hash, [filePath.endsWith("-wal") ? "wal-absent" : "file-absent"]);
      return { path: filePath, optional, present: false };
    }
    throw new ImessageMcpError("DATABASE_CHANGED", "copied database files changed while creating a sync checkpoint");
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_COPY_FINGERPRINT_BYTES)) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "copied database exceeds the bounded sync fingerprint size");
    }
    updateSignature(hash, [filePath.endsWith("-wal") ? "wal" : "database", before.size]);
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: COPY_FINGERPRINT_READ_BYTES,
    })) {
      if (Date.now() > deadline) {
        throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "copied database sync fingerprint exceeded its cold-query deadline");
      }
      hash.update(chunk as Buffer);
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    ) {
      throw new ImessageMcpError("DATABASE_CHANGED", "copied database files changed while creating a sync checkpoint");
    }
    return {
      path: filePath,
      optional,
      present: true,
      device: before.dev,
      inode: before.ino,
      size: before.size,
      modified: before.mtimeNs,
      changed: before.ctimeNs,
    };
  } finally {
    await handle.close();
  }
}

async function assertFingerprintFilesStable(files: FingerprintedFile[]): Promise<void> {
  for (const file of files) {
    try {
      const current = await lstat(file.path, { bigint: true });
      if (
        !file.present || !current.isFile() || current.dev !== file.device || current.ino !== file.inode ||
        current.size !== file.size || current.mtimeNs !== file.modified || current.ctimeNs !== file.changed
      ) {
        throw new Error("changed");
      }
    } catch (error) {
      if (!file.present && file.optional && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new ImessageMcpError("DATABASE_CHANGED", "copied database files changed while creating a sync checkpoint");
    }
  }
}

async function copiedDatabaseFingerprint(context: DatabaseContext): Promise<string> {
  const deadline = Date.now() + COPY_FINGERPRINT_TIMEOUT_MS;
  const hash = createHmac("sha256", context.referenceKey).update("imessage-mcp:sync:copied-database:v2\0");
  const files = [
    await fingerprintFile(hash, context.canonicalPath, false, deadline),
    await fingerprintFile(hash, `${context.canonicalPath}-wal`, true, deadline),
  ];
  await assertFingerprintFilesStable(files);
  return hash.digest("hex");
}

async function createPreparedCopyFingerprint(context: DatabaseContext): Promise<PreparedCopyFingerprint> {
  const request = context.request();
  try {
    const fingerprint = await copiedDatabaseFingerprint(context);
    context.assertObservedDataVersion(request.asOf.data_version);
    return { fingerprint, watermark: request.asOf };
  } finally {
    request.close();
  }
}

export async function prepareCopiedDatabaseSync(context: DatabaseContext): Promise<void> {
  if (context.sourceMode !== "copy") return;
  let preparation = preparedCopyFingerprints.get(context);
  if (!preparation) {
    preparation = createPreparedCopyFingerprint(context);
    preparedCopyFingerprints.set(context, preparation);
  }
  try {
    await preparation;
  } catch (error) {
    if (preparedCopyFingerprints.get(context) === preparation) {
      preparedCopyFingerprints.delete(context);
    }
    throw error;
  }
}

async function initialCopiedDatabaseFingerprint(
  context: DatabaseContext,
  current: Watermark,
): Promise<string> {
  const preparation = preparedCopyFingerprints.get(context);
  if (!preparation) {
    const fingerprint = await copiedDatabaseFingerprint(context);
    context.assertObservedDataVersion(current.data_version);
    return fingerprint;
  }
  preparedCopyFingerprints.delete(context);
  const prepared = await preparation;
  assertFrozenTraversal(prepared.watermark, current);
  context.assertObservedDataVersion(current.data_version);
  return prepared.fingerprint;
}

function syncSourceBudget(request: DatabaseRequest, maxMessageId: number): void {
  const counts = request.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM message WHERE ROWID <= @max_id) AS messages,
       (SELECT COUNT(*) FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id WHERE m.ROWID <= @max_id) AS relations`,
  ).get({ max_id: maxMessageId }) as { messages: number; relations: number };
  const fanout = request.db.prepare(
    `SELECT COUNT(*) AS value
     FROM chat_message_join cmj
     JOIN message m ON m.ROWID = cmj.message_id
     WHERE m.ROWID <= @max_id
     GROUP BY cmj.message_id
     HAVING COUNT(*) > @max_fanout
     LIMIT 1`,
  ).get({ max_id: maxMessageId, max_fanout: MAX_SYNC_CHATS_PER_MESSAGE }) as { value: number } | undefined;
  if (
    Number(counts.messages) > MAX_SYNC_MESSAGE_ROWS ||
    Number(counts.relations) > MAX_SYNC_RELATIONS ||
    Number(fanout?.value ?? 0) > MAX_SYNC_CHATS_PER_MESSAGE
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "sync source exceeds its bounded row or relationship budget");
  }
}

function updateSignature(hash: { update(data: string | Buffer): unknown }, values: unknown[]): void {
  for (const value of values) {
    const type = value === null || value === undefined
      ? 0
      : Buffer.isBuffer(value)
        ? 1
        : typeof value === "number"
          ? 2
          : 3;
    const encoded = type === 0
      ? Buffer.alloc(0)
      : type === 1
        ? value as Buffer
        : Buffer.from(String(value), "utf8");
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(encoded.length, 1);
    hash.update(header);
    hash.update(encoded);
  }
}

function optionalColumn(request: DatabaseRequest, column: string, fallback = "NULL"): string {
  return (request.capabilities.tables.message ?? []).includes(column) ? `m.${column}` : fallback;
}

function syncIntegritySignatures(
  request: DatabaseRequest,
  maxMessageId: number,
  mutableContentIds: number[],
  receiptCutoff: string,
): Pick<SyncIntegrity, "structural_signature" | "content_signature" | "receipt_signature"> {
  syncSourceBudget(request, maxMessageId);
  const metadataExpressions = [
    "m.guid",
    "h.id",
    optionalColumn(request, "service"),
    optionalColumn(request, "associated_message_guid"),
    optionalColumn(request, "associated_message_emoji"),
    optionalColumn(request, "reply_to_guid", optionalColumn(request, "thread_originator_guid")),
    optionalColumn(request, "group_title"),
  ];
  const metadataLengths = metadataExpressions.map((expression) => `COALESCE(LENGTH(CAST(${expression} AS BLOB)), 0)`);
  const metadata = request.db.prepare(
    `SELECT COALESCE(SUM(${metadataLengths.join(" + ")}), 0) AS bytes,
            COALESCE(MAX(MAX(${metadataLengths.join(", ")})), 0) AS max_value
     FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
     WHERE m.ROWID <= @max_id`,
  ).get({ max_id: maxMessageId }) as { bytes: number; max_value: number };
  const chatService = (request.capabilities.tables.chat ?? []).includes("service_name") ? "c.service_name" : "NULL";
  const relationshipMetadata = request.db.prepare(
    `SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(${chatService}, '') AS BLOB))), 0) AS bytes,
            COALESCE(MAX(LENGTH(CAST(COALESCE(${chatService}, '') AS BLOB))), 0) AS max_value
     FROM chat_message_join cmj
     JOIN message m ON m.ROWID = cmj.message_id
     JOIN chat c ON c.ROWID = cmj.chat_id
     WHERE m.ROWID <= @max_id`,
  ).get({ max_id: maxMessageId }) as { bytes: number; max_value: number };
  const contentRows = "1 = 1";
  const immutableContentRows = mutableContentIds.length
    ? `m.ROWID NOT IN (${mutableContentIds.join(",")})`
    : "1 = 1";
  const text = optionalColumn(request, "text");
  const body = optionalColumn(request, "attributedBody");
  const summary = optionalColumn(request, "message_summary_info");
  const content = request.db.prepare(
    `SELECT COALESCE(SUM(COALESCE(LENGTH(CAST(${text} AS BLOB)), 0) + COALESCE(LENGTH(CAST(${body} AS BLOB)), 0) + COALESCE(LENGTH(CAST(${summary} AS BLOB)), 0)), 0) AS bytes,
            COALESCE(MAX(LENGTH(CAST(${text} AS BLOB))), 0) AS max_text,
            COALESCE(MAX(LENGTH(CAST(${body} AS BLOB))), 0) AS max_body,
            COALESCE(MAX(LENGTH(CAST(${summary} AS BLOB))), 0) AS max_summary
     FROM message m WHERE m.ROWID <= @max_id AND (${contentRows})`,
  ).get({ max_id: maxMessageId }) as { bytes: number; max_text: number; max_body: number; max_summary: number };
  let attachmentMetadata = { rows: 0, bytes: 0, max_value: 0 };
  if (request.capabilities.attachments === "available") {
    const attachmentColumns = request.capabilities.tables.attachment ?? [];
    const attachment = (column: string) => attachmentColumns.includes(column) ? `a.${column}` : "NULL";
    const attachmentLengths = ["guid", "filename", "transfer_name", "mime_type"]
      .map((column) => `COALESCE(LENGTH(CAST(${attachment(column)} AS BLOB)), 0)`);
    attachmentMetadata = request.db.prepare(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(${attachmentLengths.join(" + ")}), 0) AS bytes,
              COALESCE(MAX(MAX(${attachmentLengths.join(", ")})), 0) AS max_value
       FROM message_attachment_join maj
       JOIN message m ON m.ROWID = maj.message_id
       JOIN attachment a ON a.ROWID = maj.attachment_id
       WHERE m.ROWID <= @max_id`,
    ).get({ max_id: maxMessageId }) as { rows: number; bytes: number; max_value: number };
  }
  if (
    Number(metadata.bytes) + Number(relationshipMetadata.bytes) + Number(content.bytes) + Number(attachmentMetadata.bytes) > MAX_SYNC_INTEGRITY_BYTES ||
    Math.max(Number(metadata.max_value), Number(relationshipMetadata.max_value), Number(attachmentMetadata.max_value)) > MAX_SYNC_METADATA_VALUE_BYTES ||
    Number(attachmentMetadata.rows) > MAX_SYNC_RELATIONS ||
    Number(content.max_text) > MAX_SYNC_INTEGRITY_VALUE_BYTES ||
    Number(content.max_body) > MAX_SYNC_INTEGRITY_VALUE_BYTES ||
    Number(content.max_summary) > MAX_SYNC_INTEGRITY_VALUE_BYTES
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "sync integrity source exceeds its bounded byte budget");
  }

  const structural = createHash("sha256").update("imessage-mcp:sync:structural:v2\0");
  const messageRows = request.db.prepare(
    `SELECT m.ROWID AS rowid, m.guid, m.handle_id, h.id AS handle, m.date, m.is_from_me,
            ${optionalColumn(request, "service")} AS service,
            ${optionalColumn(request, "item_type", "0")} AS item_type,
            ${optionalColumn(request, "is_system_message", "0")} AS is_system_message,
            ${optionalColumn(request, "associated_message_guid")} AS associated_message_guid,
            ${optionalColumn(request, "associated_message_type", "0")} AS associated_message_type,
            ${optionalColumn(request, "associated_message_emoji")} AS associated_message_emoji,
            ${optionalColumn(request, "reply_to_guid", optionalColumn(request, "thread_originator_guid"))} AS reply_to_guid,
            ${optionalColumn(request, "other_handle", "0")} AS other_handle,
            ${optionalColumn(request, "group_action_type", "0")} AS group_action_type,
            ${optionalColumn(request, "group_title")} AS group_title
     FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
     WHERE m.ROWID <= @max_id ORDER BY m.ROWID`,
  ).safeIntegers(true).iterate({ max_id: maxMessageId }) as Iterable<Record<string, unknown>>;
  for (const row of messageRows) {
    updateSignature(structural, [
      "message", row.rowid, row.guid, row.handle_id, row.handle, row.date, row.is_from_me, row.service,
      row.item_type, row.is_system_message, row.associated_message_guid, row.associated_message_type,
      row.associated_message_emoji, row.reply_to_guid, row.other_handle, row.group_action_type, row.group_title,
    ]);
  }
  const relationships = request.db.prepare(
    `SELECT cmj.message_id, cmj.chat_id, ${chatService} AS chat_service
     FROM chat_message_join cmj
     JOIN message m ON m.ROWID = cmj.message_id
     JOIN chat c ON c.ROWID = cmj.chat_id
     WHERE m.ROWID <= @max_id ORDER BY cmj.message_id, cmj.chat_id`,
  ).safeIntegers(true).iterate({ max_id: maxMessageId }) as Iterable<Record<string, unknown>>;
  for (const row of relationships) {
    updateSignature(structural, ["chat", row.message_id, row.chat_id, row.chat_service]);
  }
  if (request.capabilities.chat_lookup === "available") {
    const lookupRows = request.db.prepare(
      `SELECT domain, identifier, chat FROM chat_lookup ORDER BY identifier, domain, chat`,
    ).safeIntegers(true).iterate() as Iterable<Record<string, unknown>>;
    for (const row of lookupRows) {
      updateSignature(structural, ["chat_lookup", row.identifier, row.domain, row.chat]);
    }
  }
  if (request.capabilities.attachments === "available") {
    const attachmentColumns = request.capabilities.tables.attachment ?? [];
    const attachment = (column: string) => attachmentColumns.includes(column) ? `a.${column}` : "NULL";
    const attachmentRows = request.db.prepare(
      `SELECT maj.message_id, maj.attachment_id, ${attachment("guid")} AS guid,
              ${attachment("filename")} AS filename, ${attachment("transfer_name")} AS transfer_name,
              ${attachment("mime_type")} AS mime_type, ${attachment("total_bytes")} AS total_bytes
       FROM message_attachment_join maj
       JOIN message m ON m.ROWID = maj.message_id
       JOIN attachment a ON a.ROWID = maj.attachment_id
       WHERE m.ROWID <= @max_id ORDER BY maj.message_id, maj.attachment_id`,
    ).safeIntegers(true).iterate({ max_id: maxMessageId }) as Iterable<Record<string, unknown>>;
    for (const row of attachmentRows) {
      updateSignature(structural, [
        "attachment", row.message_id, row.attachment_id, row.guid, row.filename,
        row.transfer_name, row.mime_type, row.total_bytes,
      ]);
    }
  }

  const contentHash = createHash("sha256").update("imessage-mcp:sync:content:v2\0");
  const changedContent = request.db.prepare(
    `SELECT m.ROWID AS rowid, ${text} AS text, ${body} AS attributed_body,
            ${summary} AS summary_info,
            ${optionalColumn(request, "cache_has_attachments", "0")} AS cache_has_attachments,
            ${optionalColumn(request, "date_edited", "0")} AS date_edited,
            ${optionalColumn(request, "date_retracted", "0")} AS date_retracted
     FROM message m WHERE m.ROWID <= @max_id AND (${immutableContentRows}) ORDER BY m.ROWID`,
  ).safeIntegers(true).iterate({ max_id: maxMessageId }) as Iterable<Record<string, unknown>>;
  for (const row of changedContent) {
    updateSignature(contentHash, [
      row.rowid, row.text, row.attributed_body, row.summary_info, row.cache_has_attachments,
      row.date_edited, row.date_retracted,
    ]);
  }

  const receiptHash = createHash("sha256").update("imessage-mcp:sync:receipt:v2\0");
  const dateRead = appleTimestampSortSql(optionalColumn(request, "date_read", "0"));
  const dateDelivered = appleTimestampSortSql(optionalColumn(request, "date_delivered", "0"));
  const normalizedDateRead = `CASE WHEN COALESCE(${dateRead}, 0) > @receipt_cutoff THEN 0 ELSE COALESCE(${dateRead}, 0) END`;
  const normalizedDateDelivered = `CASE WHEN COALESCE(${dateDelivered}, 0) > @receipt_cutoff THEN 0 ELSE COALESCE(${dateDelivered}, 0) END`;
  const normalizedIsRead = `CASE WHEN COALESCE(${dateRead}, 0) > @receipt_cutoff THEN 0 ELSE COALESCE(${optionalColumn(request, "is_read", "0")}, 0) END`;
  const normalizedIsDelivered = `CASE WHEN COALESCE(${dateDelivered}, 0) > @receipt_cutoff THEN 0 ELSE COALESCE(${optionalColumn(request, "is_delivered", "0")}, 0) END`;
  const receiptRows = request.db.prepare(
    `SELECT m.ROWID AS rowid,
            ${normalizedDateRead} AS date_read,
            ${normalizedDateDelivered} AS date_delivered,
            ${normalizedIsRead} AS is_read,
            ${normalizedIsDelivered} AS is_delivered
     FROM message m WHERE m.ROWID <= @max_id ORDER BY m.ROWID`,
  ).safeIntegers(true).iterate({
    max_id: maxMessageId,
    receipt_cutoff: sqliteIntegerBinding(receiptCutoff),
  }) as Iterable<Record<string, unknown>>;
  for (const row of receiptRows) {
    updateSignature(receiptHash, [row.rowid, row.date_read, row.date_delivered, row.is_read, row.is_delivered]);
  }
  return {
    structural_signature: structural.digest("hex"),
    content_signature: contentHash.digest("hex"),
    receipt_signature: receiptHash.digest("hex"),
  };
}

function syncPrefixCardinality(request: DatabaseRequest, maxMessageId: number): { rows: number; relations: number } {
  const value = request.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM message WHERE ROWID <= @max_id) AS rows,
       (SELECT COUNT(*) FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id WHERE m.ROWID <= @max_id) AS relations`,
  ).get({ max_id: maxMessageId }) as { rows: number; relations: number };
  return { rows: Number(value.rows), relations: Number(value.relations) };
}

function validSignature(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function mutableContentIds(request: DatabaseRequest, maxMessageId: number): number[] {
  const cutoff = Math.floor(Date.now() / 1000) - MUTABLE_CONTENT_WINDOW_SECONDS;
  const boundary = appleTimestampBoundary(cutoff);
  const rows = request.db.prepare(
    `SELECT m.ROWID AS rowid
     FROM message m
     WHERE m.ROWID <= @max_id AND ${appleTimestampBoundarySql(
       "m.date",
       ">=",
       "@cutoff_seconds",
       "@cutoff_nanoseconds",
     )}
     ORDER BY m.ROWID
     LIMIT ${MAX_MUTABLE_CONTENT_ROWS + 1}`,
  ).all({
    max_id: maxMessageId,
    cutoff_seconds: boundary.seconds,
    cutoff_nanoseconds: boundary.nanoseconds,
  }) as Array<{ rowid: number }>;
  if (rows.length > MAX_MUTABLE_CONTENT_ROWS) {
    throw new ImessageMcpError(
      "QUERY_BUDGET_EXCEEDED",
      "too many messages remain inside the bounded live edit-integrity window; poll sync more frequently",
    );
  }
  const ids = rows.map((row) => Number(row.rowid));
  if (ids.some((rowid, index) => !Number.isSafeInteger(rowid) || rowid <= 0 || (index > 0 && rowid <= ids[index - 1]))) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "live edit-integrity rows contain invalid identifiers");
  }
  return ids;
}

function contentStateRows(request: DatabaseRequest, ids: number[]): Array<Record<string, unknown>> {
  if (ids.length === 0) return [];
  const text = optionalColumn(request, "text");
  const body = optionalColumn(request, "attributedBody");
  const summary = optionalColumn(request, "message_summary_info");
  return request.db.prepare(
    `SELECT m.ROWID AS rowid, ${text} AS text, ${body} AS attributed_body,
            ${summary} AS summary_info,
            ${optionalColumn(request, "cache_has_attachments", "0")} AS cache_has_attachments,
            ${optionalColumn(request, "date_edited", "0")} AS date_edited,
            ${optionalColumn(request, "date_retracted", "0")} AS date_retracted
     FROM message m WHERE m.ROWID IN (${ids.map(() => "?").join(",")}) ORDER BY m.ROWID`,
  ).safeIntegers(true).all(...ids) as Array<Record<string, unknown>>;
}

function contentStateDigest(row: Record<string, unknown>): Buffer {
  const hash = createHash("sha256").update("imessage-mcp:sync:mutable-content:v2\0");
  updateSignature(hash, [
    row.rowid, row.text, row.attributed_body, row.summary_info, row.cache_has_attachments,
    row.date_edited, row.date_retracted,
  ]);
  return hash.digest().subarray(0, 16);
}

function encodeMutableContentState(rows: Array<Record<string, unknown>>): string {
  if (rows.length > MAX_MUTABLE_CONTENT_ROWS) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "live edit-integrity state exceeds its row budget");
  }
  const packed = Buffer.allocUnsafe(rows.length * MUTABLE_CONTENT_RECORD_BYTES);
  let previous = 0;
  rows.forEach((row, index) => {
    const rowid = Number(row.rowid);
    if (!Number.isSafeInteger(rowid) || rowid <= previous) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "live edit-integrity rows contain invalid ordering");
    }
    const offset = index * MUTABLE_CONTENT_RECORD_BYTES;
    packed.writeBigUInt64BE(BigInt(rowid), offset);
    contentStateDigest(row).copy(packed, offset + 8);
    previous = rowid;
  });
  return packed.toString("base64url");
}

function decodeMutableContentState(value: string): Array<{ rowid: number; digest: Buffer }> {
  const packed = Buffer.from(value, "base64url");
  if (
    packed.toString("base64url") !== value ||
    packed.length % MUTABLE_CONTENT_RECORD_BYTES !== 0 ||
    packed.length / MUTABLE_CONTENT_RECORD_BYTES > MAX_MUTABLE_CONTENT_ROWS
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "sync cursor has malformed mutable-content integrity state");
  }
  const rows: Array<{ rowid: number; digest: Buffer }> = [];
  let previous = 0;
  for (let offset = 0; offset < packed.length; offset += MUTABLE_CONTENT_RECORD_BYTES) {
    const rowid = Number(packed.readBigUInt64BE(offset));
    if (!Number.isSafeInteger(rowid) || rowid <= previous) {
      throw new ImessageMcpError("INVALID_INPUT", "sync cursor has invalid mutable-content row ordering");
    }
    rows.push({ rowid, digest: Buffer.from(packed.subarray(offset + 8, offset + MUTABLE_CONTENT_RECORD_BYTES)) });
    previous = rowid;
  }
  return rows;
}

function validMutableContentState(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 70_000 || !/^[A-Za-z0-9_-]*$/u.test(value)) return false;
  try {
    decodeMutableContentState(value);
    return true;
  } catch {
    return false;
  }
}

function mutableContentChangesAreClassified(
  request: DatabaseRequest,
  previousState: string,
  checkpoint: Watermark,
): boolean {
  const previous = decodeMutableContentState(previousState);
  if (previous.length === 0) return true;
  const currentRows = contentStateRows(request, previous.map((row) => row.rowid));
  if (currentRows.length !== previous.length) return false;
  return currentRows.every((row, index) => {
    const old = previous[index];
    if (Number(row.rowid) !== old.rowid) return false;
    if (contentStateDigest(row).equals(old.digest)) return true;
    return compareSqliteIntegers(
      appleTimestampSortToken(row.date_edited ?? 0, "mutable edit timestamp"),
      checkpoint.max_edited_at,
    ) > 0 || compareSqliteIntegers(
      appleTimestampSortToken(row.date_retracted ?? 0, "mutable retraction timestamp"),
      checkpoint.max_retracted_at,
    ) > 0;
  });
}

function validIntegrity(value: unknown): value is SyncIntegrity {
  if (!value || typeof value !== "object") return false;
  const integrity = value as Partial<SyncIntegrity>;
  return validSignature(integrity.structural_signature) &&
    validSignature(integrity.content_signature) &&
    validSignature(integrity.receipt_signature) &&
    validMutableContentState(integrity.mutable_content_state) &&
    Number.isSafeInteger(integrity.prefix_rows) && Number(integrity.prefix_rows) >= 0 &&
    Number.isSafeInteger(integrity.prefix_relations) && Number(integrity.prefix_relations) >= 0;
}

function syncIntegrity(
  request: DatabaseRequest,
  maxMessageId: number,
  mutableState?: string,
  receiptCutoff = request.asOf.max_receipt_at,
): SyncIntegrity {
  const ids = mutableState === undefined
    ? mutableContentIds(request, maxMessageId)
    : decodeMutableContentState(mutableState).map((row) => row.rowid);
  if (ids.some((rowid) => rowid > maxMessageId)) {
    throw new ImessageMcpError("INVALID_INPUT", "sync cursor mutable-content state exceeds its checkpoint");
  }
  const cardinality = syncPrefixCardinality(request, maxMessageId);
  const signatures = syncIntegritySignatures(request, maxMessageId, ids, receiptCutoff);
  const stateRows = contentStateRows(request, ids);
  if (stateRows.length !== ids.length) {
    throw new ImessageMcpError("DATABASE_CHANGED", "a live mutable-content row disappeared from its checkpoint");
  }
  return {
    ...signatures,
    mutable_content_state: encodeMutableContentState(stateRows),
    prefix_rows: cardinality.rows,
    prefix_relations: cardinality.relations,
  };
}

function parseChatIds(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_SYNC_CHATS_PER_MESSAGE ||
      parsed.some((item) => !Number.isSafeInteger(item) || Number(item) <= 0)
    ) {
      throw new Error("invalid chat identifiers");
    }
    return [...new Set(parsed.map(Number))].sort((a, b) => a - b);
  } catch {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "sync relationship aggregation returned invalid chat identifiers");
  }
}

function receiptExpression(request: DatabaseRequest): string {
  const columns = request.capabilities.tables.message ?? [];
  const dates = ["date_read", "date_delivered"]
    .filter((column) => columns.includes(column))
    .map((column) => appleTimestampSortSql(`m.${column}`));
  if (dates.length === 0) return "0";
  return dates.length === 1 ? dates[0] : `MAX(${dates.join(", ")})`;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function assertSyncMetadataBudget(request: DatabaseRequest, messageIds: number[]): void {
  if (messageIds.length === 0) return;
  const ids = placeholders(messageIds);
  const expressions = [
    "m.guid",
    "h.id",
    columnSql(request, "message", "m", "service", "NULL"),
    columnSql(request, "message", "m", "associated_message_guid", "NULL"),
    columnSql(request, "message", "m", "associated_message_emoji", "NULL"),
    columnSql(request, "message", "m", "group_title", "NULL"),
  ];
  const lengths = expressions.map((expression) => `COALESCE(LENGTH(CAST(${expression} AS BLOB)), 0)`);
  const metadata = request.db.prepare(
    `SELECT COALESCE(SUM(${lengths.join(" + ")}), 0) AS bytes,
            COALESCE(MAX(MAX(${lengths.join(", ")})), 0) AS max_value
     FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
     WHERE m.ROWID IN (${ids})`,
  ).get(...messageIds) as { bytes: number; max_value: number };
  const chatService = columnSql(request, "chat", "c", "service_name", "NULL");
  const relationships = request.db.prepare(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(LENGTH(CAST(COALESCE(${chatService}, '') AS BLOB))), 0) AS bytes,
            COALESCE(MAX(LENGTH(CAST(COALESCE(${chatService}, '') AS BLOB))), 0) AS max_value
     FROM chat_message_join cmj JOIN chat c ON c.ROWID = cmj.chat_id
     WHERE cmj.message_id IN (${ids})`,
  ).get(...messageIds) as { rows: number; bytes: number; max_value: number };
  if (
    Number(metadata.bytes) + Number(relationships.bytes) > MAX_SYNC_METADATA_BYTES ||
    Math.max(Number(metadata.max_value), Number(relationships.max_value)) > MAX_SYNC_METADATA_VALUE_BYTES ||
    Number(relationships.rows) > messageIds.length * MAX_SYNC_CHATS_PER_MESSAGE
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "sync metadata exceeds its bounded source budget");
  }
}

function baseRows(input: {
  request: DatabaseRequest;
  where: string;
  bindings: Record<string, unknown>;
  changeType: ChangeType;
  changeColumn: string;
  afterTime?: string;
  afterKey?: string;
  limit: number;
}): RawChange[] {
  const { request } = input;
  const key = `'${input.changeType}:' || m.ROWID`;
  const sortTime = appleTimestampSortSql(input.changeColumn);
  const after = input.afterTime === undefined
    ? ""
    : `AND (${sortTime} > @after_time OR (${sortTime} = @after_time AND ${key} > @after_key))`;
  const candidateRows = request.db.prepare(
    `SELECT m.ROWID AS rowid
     FROM message m
     WHERE ${input.where}
       AND EXISTS (SELECT 1 FROM chat_message_join sync_visible WHERE sync_visible.message_id = m.ROWID)
       ${after}
     ORDER BY ${sortTime}, ${key}
     LIMIT @family_limit`,
  ).all({
    ...input.bindings,
    after_time: input.afterTime === undefined ? 0n : sqliteIntegerBinding(input.afterTime),
    after_key: input.afterKey ?? "",
    family_limit: input.limit + 1,
  }) as Array<{ rowid: number }>;
  const messageIds = candidateRows.map((row) => Number(row.rowid));
  if (messageIds.length === 0) return [];
  assertSyncMetadataBudget(request, messageIds);
  const selected = placeholders(messageIds);
  const associatedGuid = columnSql(request, "message", "m", "associated_message_guid", "NULL");
  const associatedType = columnSql(request, "message", "m", "associated_message_type", "0");
  const associatedEmoji = columnSql(request, "message", "m", "associated_message_emoji", "NULL");
  const dateRead = columnSql(request, "message", "m", "date_read", "0");
  const dateDelivered = columnSql(request, "message", "m", "date_delivered", "0");
  const dateRetracted = columnSql(request, "message", "m", "date_retracted", "0");
  const itemType = columnSql(request, "message", "m", "item_type", "0");
  const groupAction = columnSql(request, "message", "m", "group_action_type", "0");
  const groupTitle = columnSql(request, "message", "m", "group_title", "NULL");
  const service = serviceSql(request, "m", "c");
  const serviceFamilyExpression = serviceFamilyCase(service);
  const rows = request.db
    .prepare(
      `WITH chat_relations AS (
         SELECT direct.message_id, direct.conversation_id,
                CASE WHEN COUNT(DISTINCT direct.service_family) = 1
                     THEN MIN(direct.service) ELSE 'unknown' END AS service
         FROM (
           SELECT cmj.message_id, mcp_canonical_chat(cmj.chat_id) AS conversation_id,
                  ${service} AS service, ${serviceFamilyExpression} AS service_family
           FROM chat_message_join cmj
           JOIN message m ON m.ROWID = cmj.message_id
           JOIN chat c ON c.ROWID = cmj.chat_id
           WHERE cmj.message_id IN (${selected})
         ) direct
         GROUP BY direct.message_id, direct.conversation_id
       ), component_relations AS (
         SELECT mcp_canonical_chat(component_chat.ROWID) AS conversation_id,
                json_group_array(DISTINCT component_chat.ROWID) AS chat_ids_json
         FROM chat component_chat
         GROUP BY mcp_canonical_chat(component_chat.ROWID)
       ), resolved_relations AS (
         SELECT relations.message_id, relations.service, components.chat_ids_json
         FROM chat_relations relations
         JOIN component_relations components ON components.conversation_id = relations.conversation_id
       )
       SELECT
         ${key} AS key,
         '${input.changeType}' AS change_type,
         CAST(COALESCE(${input.changeColumn}, 0) AS TEXT) AS change_time,
         CAST(${sortTime} AS TEXT) AS sort_time,
         m.ROWID AS rowid,
         m.guid,
	         NULL AS text,
	         0 AS text_unsupported,
	         NULL AS attributed_body,
         0 AS body_unsupported,
         m.is_from_me,
         h.id AS handle,
         m.handle_id,
         relations.service AS service,
         COALESCE(relations.chat_ids_json, '[]') AS chat_ids_json,
         ${associatedGuid} AS associated_message_guid,
         ${associatedType} AS associated_message_type,
         ${associatedEmoji} AS associated_message_emoji,
         CAST(COALESCE(${dateRead}, 0) AS TEXT) AS date_read,
         CAST(COALESCE(${dateDelivered}, 0) AS TEXT) AS date_delivered,
         CAST(COALESCE(${dateRetracted}, 0) AS TEXT) AS date_retracted,
         ${itemType} AS item_type,
         ${groupAction} AS group_action_type,
         ${groupTitle} AS group_title
       FROM message m
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       LEFT JOIN resolved_relations relations ON relations.message_id = m.ROWID
       WHERE m.ROWID IN (${selected})
       ORDER BY ${sortTime}, ${key}`,
    )
    .all(...messageIds, ...messageIds) as RawChange[];
  for (const row of rows) {
    if (
      !Number.isSafeInteger(Number(row.rowid)) || Number(row.rowid) <= 0 ||
      typeof row.guid !== "string" || row.guid.length === 0 ||
      Buffer.byteLength(row.guid, "utf8") > MAX_SYNC_METADATA_VALUE_BYTES
    ) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "sync change contains an invalid message identifier");
    }
    row.rowid = Number(row.rowid);
    row.change_time = sqliteIntegerToken(row.change_time, "sync change timestamp");
    row.sort_time = sqliteIntegerToken(row.sort_time, "sync sort timestamp");
    row.date_read = sqliteIntegerToken(row.date_read, "sync read timestamp");
    row.date_delivered = sqliteIntegerToken(row.date_delivered, "sync delivery timestamp");
    row.date_retracted = sqliteIntegerToken(row.date_retracted, "sync retraction timestamp");
  }
  return rows;
}

function gather(request: DatabaseRequest, cursor: SyncCursor, limit: number): RawChange[] {
  const target = cursor.target as Watermark;
  const associatedType = columnSql(request, "message", "m", "associated_message_type", "0");
  const itemType = columnSql(request, "message", "m", "item_type", "0");
  const system = columnSql(request, "message", "m", "is_system_message", "0");
  const families: RawChange[][] = [];
  const shared = {
    request,
    afterTime: cursor.after_time,
    afterKey: cursor.after_key,
    limit,
  };

  families.push(baseRows({
    ...shared,
    where: `m.ROWID > @checkpoint_id AND m.ROWID <= @target_id
      AND COALESCE(${associatedType}, 0) = 0
      AND COALESCE(${itemType}, 0) = 0
      AND COALESCE(${system}, 0) = 0`,
    bindings: { checkpoint_id: cursor.checkpoint.max_message_id, target_id: target.max_message_id },
    changeType: "message_created",
    changeColumn: "m.date",
  }));
  families.push(baseRows({
    ...shared,
    where: `m.ROWID > @checkpoint_id AND m.ROWID <= @target_id AND ${associatedType} BETWEEN 2000 AND 2999`,
    bindings: { checkpoint_id: cursor.checkpoint.max_message_id, target_id: target.max_message_id },
    changeType: "reaction_added",
    changeColumn: "m.date",
  }));
  families.push(baseRows({
    ...shared,
    where: `m.ROWID > @checkpoint_id AND m.ROWID <= @target_id AND ${associatedType} BETWEEN 3000 AND 3999`,
    bindings: { checkpoint_id: cursor.checkpoint.max_message_id, target_id: target.max_message_id },
    changeType: "reaction_removed",
    changeColumn: "m.date",
  }));
  families.push(baseRows({
    ...shared,
    where: `m.ROWID > @checkpoint_id AND m.ROWID <= @target_id
      AND (COALESCE(${itemType}, 0) <> 0 OR COALESCE(${system}, 0) = 1)`,
    bindings: { checkpoint_id: cursor.checkpoint.max_message_id, target_id: target.max_message_id },
    changeType: "group_event",
    changeColumn: "m.date",
  }));

  if (request.capabilities.edits === "available") {
    const editedAt = appleTimestampSortSql("m.date_edited");
    families.push(baseRows({
      ...shared,
      where: `${editedAt} > @checkpoint_edit AND ${editedAt} <= @target_edit`,
      bindings: {
        checkpoint_edit: sqliteIntegerBinding(cursor.checkpoint.max_edited_at),
        target_edit: sqliteIntegerBinding(target.max_edited_at),
      },
      changeType: "message_edited",
      changeColumn: "m.date_edited",
    }));
  }
  if (request.capabilities.retractions === "available") {
    const retractedAt = appleTimestampSortSql("m.date_retracted");
    families.push(baseRows({
      ...shared,
      where: `${retractedAt} > @checkpoint_retract AND ${retractedAt} <= @target_retract`,
      bindings: {
        checkpoint_retract: sqliteIntegerBinding(cursor.checkpoint.max_retracted_at),
        target_retract: sqliteIntegerBinding(target.max_retracted_at),
      },
      changeType: "message_retracted",
      changeColumn: "m.date_retracted",
    }));
  }
  if (request.capabilities.receipt_changes === "available") {
    const receipt = receiptExpression(request);
    families.push(baseRows({
      ...shared,
      where: `${receipt} > @checkpoint_receipt AND ${receipt} <= @target_receipt`,
      bindings: {
        checkpoint_receipt: sqliteIntegerBinding(cursor.checkpoint.max_receipt_at),
        target_receipt: sqliteIntegerBinding(target.max_receipt_at),
      },
      changeType: "receipt_changed",
      changeColumn: receipt,
    }));
  }

  const deduped = new Map<string, RawChange>();
  for (const change of families.flat()) deduped.set(`${change.key}:${change.change_time}`, change);
  const rows = [...deduped.values()]
    .sort((a, b) => compareSqliteIntegers(a.sort_time, b.sort_time) || a.key.localeCompare(b.key))
    .slice(0, limit + 1);
  const metadataBytes = rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify({
    key: row.key,
    guid: row.guid,
    handle: row.handle,
    service: row.service,
    chat_ids_json: row.chat_ids_json,
    associated_message_guid: row.associated_message_guid,
    associated_message_emoji: row.associated_message_emoji,
    group_title: row.group_title,
  }), "utf8"), 0);
  if (metadataBytes > MAX_SYNC_METADATA_BYTES) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "sync metadata exceeds its bounded source budget");
  }
  return rows;
}

function hydrateBodies(request: DatabaseRequest, rows: RawChange[], allowPartial: boolean): void {
  const selected = [...new Set(rows
    .filter((row) => row.change_type === "message_created" || row.change_type === "message_edited")
    .map((row) => row.rowid))];
  if (selected.length === 0) return;
  const placeholders = selected.map(() => "?").join(",");
  const text = columnSql(request, "message", "m", "text", "NULL");
  const body = columnSql(request, "message", "m", "attributedBody", "NULL");
  const textUnsupported = `CASE WHEN TYPEOF(${text}) NOT IN ('text', 'null') THEN 1 ELSE 0 END`;
  const bodyUnsupportedType = `CASE WHEN TYPEOF(${body}) NOT IN ('blob', 'null') THEN 1 ELSE 0 END`;
  const needsBody = `(TYPEOF(${text}) <> 'text' OR ${text} = '' OR ${text} = CHAR(65532))`;
  const boundedBody = `CASE WHEN ${needsBody} AND TYPEOF(${body}) = 'blob'
    AND COALESCE(LENGTH(${body}), 0) <= ${MAX_SYNC_BLOB_BYTES}
    THEN ${body} ELSE NULL END`;
  const unsupportedBody = `CASE WHEN ${bodyUnsupportedType} = 1 OR (${needsBody} AND ${body} IS NOT NULL
    AND LENGTH(${body}) > ${MAX_SYNC_BLOB_BYTES}) THEN 1 ELSE 0 END`;
  const stats = request.db.prepare(
    `SELECT COALESCE(SUM(text_bytes + body_bytes), 0) AS bytes,
            COALESCE(MAX(text_bytes), 0) AS max_text,
            COALESCE(MAX(body_bytes), 0) AS max_body,
	            COALESCE(SUM(body_unsupported), 0) AS unsupported_bodies,
	            COALESCE(SUM(text_unsupported), 0) AS unsupported_text
	     FROM (SELECT COALESCE(LENGTH(CAST(${text} AS BLOB)), 0) AS text_bytes,
	                  COALESCE(LENGTH(CAST(${boundedBody} AS BLOB)), 0) AS body_bytes,
	                  ${unsupportedBody} AS body_unsupported,
	                  ${textUnsupported} AS text_unsupported
	           FROM message m WHERE m.ROWID IN (${placeholders}))`,
  ).get(...selected) as {
    bytes: number;
    max_text: number;
    max_body: number;
    unsupported_bodies: number;
    unsupported_text: number;
  };
  if (
    Number(stats.bytes) > MAX_SYNC_SOURCE_BYTES ||
    Number(stats.max_text) > MAX_SYNC_SOURCE_BYTES
  ) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "changed message bodies exceed the bounded sync source budget");
  }
  if (!allowPartial && Number(stats.unsupported_text) > 0) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "a changed message uses an unsupported SQLite text storage class", {
      skipped_count: Number(stats.unsupported_text),
    });
  }
  if (!allowPartial && Number(stats.unsupported_bodies) > 0) {
    throw new ImessageMcpError("DECODE_FAILED", "a changed message body exceeds the 1 MiB decoder limit", {
      skipped_count: Number(stats.unsupported_bodies),
      limit_bytes: MAX_SYNC_BLOB_BYTES,
      retry: "retry with allow_partial true to omit only oversized changed bodies",
    });
  }
  const bodies = request.db.prepare(
    `SELECT m.ROWID AS rowid, ${text} AS text, ${textUnsupported} AS text_unsupported,
            ${boundedBody} AS attributed_body,
	            ${unsupportedBody} AS body_unsupported
	     FROM message m WHERE m.ROWID IN (${placeholders})`,
  ).all(...selected) as Array<{
    rowid: number;
    text: string | null;
    text_unsupported: number;
    attributed_body: Buffer | null;
    body_unsupported: number;
  }>;
  const byId = new Map(bodies.map((row) => [row.rowid, row]));
  for (const row of rows) {
    const hydrated = byId.get(row.rowid);
    if (!hydrated) continue;
    row.text = hydrated.text;
    row.text_unsupported = hydrated.text_unsupported;
    row.attributed_body = hydrated.attributed_body;
    row.body_unsupported = hydrated.body_unsupported;
  }
}

async function materialize(
  rows: RawChange[],
  request: DatabaseRequest,
  maxMessageId: number,
  contacts: UnifiedContactResolver,
  decoder: MessageTextDecoder,
  allowPartial: boolean,
): Promise<{ changes: SyncChange[]; warnings: Warning[] }> {
  const isReaction = (row: RawChange): boolean =>
    row.change_type === "reaction_added" || row.change_type === "reaction_removed";
  const ownReferences = rows.filter((row) => !isReaction(row));
  resolveUniqueMessageGuids(
    request,
    ownReferences.map((row) => row.guid),
    maxMessageId,
  );
  const parentByRowid = new Map<number, string>();
  for (const row of rows.filter(isReaction)) {
    const parent = row.associated_message_guid ? normalizeReactionParent(row.associated_message_guid) : "";
    if (parent) parentByRowid.set(row.rowid, parent);
  }
  const parentRows = resolveUniqueMessageGuids(
    request,
    [...parentByRowid.values()],
    maxMessageId,
  );
  const senders = new Map<number, ReturnType<typeof validateSender>>();
  let relationshipFailures = 0;
  for (const row of rows) {
    const sender = validateSender(row, contacts);
    senders.set(row.rowid, sender);
    if (row.change_type !== "group_event" && !sender.complete) relationshipFailures += 1;
    if (isReaction(row) && !parentRows.has(parentByRowid.get(row.rowid) ?? "")) relationshipFailures += 1;
  }
  if (relationshipFailures > 0 && !allowPartial) {
    throw new ImessageMcpError(
      "UNSUPPORTED_SCHEMA",
      "a changed sender or reaction parent could not be resolved uniquely",
      { skipped_count: relationshipFailures },
    );
  }
  const bodyRows = rows.filter((row) =>
    (row.change_type === "message_created" || row.change_type === "message_edited") &&
    !sqliteIntegerIsPositive(row.date_retracted) &&
    !populatedMessageText(row.text) &&
    row.attributed_body,
  );
  let decoded: Awaited<ReturnType<MessageTextDecoder["decode"]>> = [];
  const warnings: Warning[] = [];
  try {
    decoded = bodyRows.length ? await decoder.decode(bodyRows.map((row) => row.attributed_body as Buffer)) : [];
  } catch (error) {
    if (!allowPartial) throw error;
    decoded = bodyRows.map(() => ({ status: "unsupported" as const }));
  }
  const decodedById = new Map(bodyRows.map((row, index) => [row.rowid, decoded[index]]));
  let skippedBodies = 0;
  const changes = rows.map((row): SyncChange => {
    const chatIds = parseChatIds(row.chat_ids_json);
    const sender = senders.get(row.rowid) as ReturnType<typeof validateSender>;
    const native = populatedMessageText(row.text);
    const decodedBody = decodedById.get(row.rowid);
    const isRetracted = sqliteIntegerIsPositive(row.date_retracted) || row.change_type === "message_retracted";
    const text = isRetracted ? undefined : native ?? (decodedBody?.status === "decoded" ? decodedBody.text : undefined);
	  const partial = Boolean(
	      (row.text_unsupported || row.attributed_body || row.body_unsupported) &&
      !isRetracted &&
      !native &&
      decodedBody?.status !== "decoded" &&
      (row.change_type === "message_created" || row.change_type === "message_edited"),
    );
    if (partial) {
      skippedBodies += 1;
      if (!allowPartial) throw new ImessageMcpError("DECODE_FAILED", "a changed message body could not be decoded");
    }
    const reaction = isReaction(row);
    const parent = reaction ? parentByRowid.get(row.rowid) : undefined;
    const parentRowid = parent ? parentRows.get(parent) : undefined;
    const relationshipPartial = (row.change_type !== "group_event" && !sender.complete) ||
      (reaction && !parentRowid);
    const reactionType = row.change_type === "reaction_removed"
      ? row.associated_message_type - 1000
      : row.associated_message_type;
    return {
      change_type: row.change_type,
      changed_at: appleTimestampToIso(row.change_time),
      ...(reaction && parent && parentRowid
        ? { parent_message_ref: encodeReference(request.referenceKey, request.lineage, "message", { rowid: parentRowid, guid: parent }) }
        : !reaction
          ? { message_ref: encodeReference(request.referenceKey, request.lineage, "message", { rowid: row.rowid, guid: row.guid }) }
          : {}),
      ...(chatIds.length
        ? { conversation_ref: encodeReference(request.referenceKey, request.lineage, "conversation", { chat_ids: chatIds }) }
        : {}),
      service_family: serviceFamily(row.service),
      direction: row.change_type === "group_event" ? "system" : sender.direction,
      sender: sender.identity,
      ...(text ? { text } : {}),
      current_state: row.change_type === "receipt_changed"
        ? {
            direction: row.is_from_me ? "remote" : "local",
            receipt: sqliteIntegerIsPositive(row.date_read) ? "read" : sqliteIntegerIsPositive(row.date_delivered) ? "delivered" : "sent",
            read_at: appleTimestampToIso(row.date_read),
            delivered_at: appleTimestampToIso(row.date_delivered),
          }
        : reaction
          ? {
              reaction_type: reactionType,
              emoji: row.associated_message_emoji,
              present: row.change_type === "reaction_added",
            }
          : isRetracted
            ? { retracted: true }
            : row.change_type === "group_event"
              ? { item_type: row.item_type, action_code: row.group_action_type, title: row.group_title }
              : {},
      row_status: partial || relationshipPartial ? "partial" : "complete",
    };
  });
  if (skippedBodies > 0) {
    warnings.push({
      code: "DECODE_FAILED",
      message: "some changed message bodies could not be decoded",
      skipped_count: skippedBodies,
    });
  }
  if (relationshipFailures > 0) {
    warnings.push({
      code: "UNSUPPORTED_SCHEMA",
      message: "some changed sender or reaction relationships could not be resolved uniquely",
      skipped_count: relationshipFailures,
    });
  }
  return { changes, warnings };
}

function cursorIsAhead(current: Watermark, checkpoint: Watermark): boolean {
  return current.max_message_id < checkpoint.max_message_id ||
    compareSqliteIntegers(current.max_edited_at, checkpoint.max_edited_at) < 0 ||
    compareSqliteIntegers(current.max_retracted_at, checkpoint.max_retracted_at) < 0 ||
    compareSqliteIntegers(current.max_receipt_at, checkpoint.max_receipt_at) < 0;
}

function structuralIntegrityMatches(current: SyncIntegrity, checkpoint: SyncIntegrity): boolean {
  return current.prefix_rows === checkpoint.prefix_rows &&
    current.prefix_relations === checkpoint.prefix_relations &&
    current.structural_signature === checkpoint.structural_signature;
}

export async function syncMessages(input: {
  context: DatabaseContext;
  contacts: UnifiedContactResolver;
  decoder: MessageTextDecoder;
  cursor?: string;
  limit: number;
  allowPartial: boolean;
  privacy: PrivacyMode;
  catalog?: ConversationCatalog;
}): Promise<{ changes: SyncChange[]; cursor: string; hasMore: boolean; asOf: string; warnings: Warning[] }> {
  const request = input.context.request();
  try {
    if (input.catalog) input.catalog.assertIntegrity(request);
    else assertMessageConversationIntegrity(request);
    if (!input.cursor) {
      const copyFingerprint = input.context.sourceMode === "copy"
        ? await initialCopiedDatabaseFingerprint(input.context, request.asOf)
        : undefined;
      const integrity = input.context.sourceMode === "live"
        ? syncIntegrity(request, request.asOf.max_message_id)
        : undefined;
      const cursor = encodeReference(request.referenceKey, request.lineage, "sync", {
        version: 2,
        source_mode: input.context.sourceMode,
        checkpoint: request.asOf,
        ...(integrity ? { checkpoint_integrity: integrity } : {}),
        ...(copyFingerprint ? { checkpoint_copy_fingerprint: copyFingerprint } : {}),
      });
      return { changes: [], cursor, hasMore: false, asOf: watermarkToken(request.asOf), warnings: [] };
    }
    const value = decodeReference(
      request.referenceKey,
      request.lineage,
      "sync",
      input.cursor,
      MAX_SYNC_CURSOR_LENGTH,
    ).value as unknown as SyncCursor;
    if (
      value.version !== 2 ||
      value.source_mode !== input.context.sourceMode ||
      !value.checkpoint
    ) {
      throw new ImessageMcpError("INVALID_INPUT", "sync cursor has an unsupported or malformed checkpoint");
    }
    value.checkpoint = parseWatermark(value.checkpoint);
    if (value.target) value.target = parseWatermark(value.target);
    if (Boolean(value.target) !== (value.after_time !== undefined && value.after_key !== undefined)) {
      throw new ImessageMcpError("INVALID_INPUT", "sync cursor has an inconsistent page target");
    }
    if (value.after_time !== undefined || value.after_key !== undefined) {
      if (
        !value.target || typeof value.after_key !== "string" ||
        !/^(?:message_created|message_edited|message_retracted|reaction_added|reaction_removed|receipt_changed|group_event):[1-9]\d*$/u.test(value.after_key)
      ) {
        throw new ImessageMcpError("INVALID_INPUT", "sync cursor has a malformed page position");
      }
      try {
        value.after_time = sqliteIntegerToken(value.after_time, "sync cursor position");
      } catch {
        throw new ImessageMcpError("INVALID_INPUT", "sync cursor has a malformed page position");
      }
    }
    if (input.context.sourceMode === "copy") {
      if (!validSignature(value.checkpoint_copy_fingerprint) || value.target) {
        throw new ImessageMcpError("INVALID_INPUT", "copied-database sync cursor is malformed");
      }
      assertFrozenTraversal(value.checkpoint, request.asOf);
      const fingerprint = await copiedDatabaseFingerprint(input.context);
      input.context.assertObservedDataVersion(request.asOf.data_version);
      if (fingerprint !== value.checkpoint_copy_fingerprint) {
        throw new ImessageMcpError("DATABASE_CHANGED", "copied databases are immutable after a sync checkpoint; restart with a fresh snapshot");
      }
      return {
        changes: [],
        cursor: encodeReference(request.referenceKey, request.lineage, "sync", {
          version: 2,
          source_mode: "copy",
          checkpoint: request.asOf,
          checkpoint_copy_fingerprint: fingerprint,
        }),
        hasMore: false,
        asOf: watermarkToken(request.asOf),
        warnings: [],
      };
    }
    if (cursorIsAhead(request.asOf, value.checkpoint)) {
      throw new ImessageMcpError("DATABASE_CHANGED", "sync cursor is ahead of this database copy");
    }
    if (value.target) {
	      if (value.checkpoint_integrity !== undefined || !validIntegrity(value.target_integrity)) {
        throw new ImessageMcpError("INVALID_INPUT", "sync cursor target is malformed");
      }
      assertFrozenTraversal(value.target, request.asOf);
    } else if (!validIntegrity(value.checkpoint_integrity) || value.target_integrity !== undefined) {
      throw new ImessageMcpError("INVALID_INPUT", "live-database sync cursor integrity is malformed");
    }
    if (!value.target) {
      const checkpointIntegrity = value.checkpoint_integrity as SyncIntegrity;
      const currentIntegrity = syncIntegrity(
        request,
        value.checkpoint.max_message_id,
        checkpointIntegrity.mutable_content_state,
        value.checkpoint.max_receipt_at,
      );
      if (
        !structuralIntegrityMatches(currentIntegrity, checkpointIntegrity) ||
        currentIntegrity.content_signature !== checkpointIntegrity.content_signature ||
        !mutableContentChangesAreClassified(
          request,
          checkpointIntegrity.mutable_content_state,
          value.checkpoint,
        ) ||
        currentIntegrity.receipt_signature !== checkpointIntegrity.receipt_signature
      ) {
        throw new ImessageMcpError(
          "DATABASE_CHANGED",
          "an older message or relationship changed outside its exact supported lifecycle class; start a fresh sync cursor",
        );
      }
    }
    const state: SyncCursor = value.target ? value : {
      version: 2,
      source_mode: value.source_mode,
      checkpoint: value.checkpoint,
      target: request.asOf,
      target_integrity: syncIntegrity(request, request.asOf.max_message_id),
    };
    const rows = gather(request, state, input.limit);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    if (input.privacy !== "aggregate") hydrateBodies(request, page, input.allowPartial);
    const rendered = input.privacy === "aggregate"
      ? {
          changes: page.map((row): SyncChange => ({
            change_type: row.change_type,
            changed_at: null,
            service_family: serviceFamily(row.service),
            row_status: "complete",
          })),
          warnings: [],
        }
      : await materialize(
          page,
          request,
          (state.target as Watermark).max_message_id,
          input.contacts,
          input.decoder,
          input.allowPartial,
        );
    const last = page.at(-1);
    const nextState: SyncCursor = hasMore && last
      ? { ...state, after_time: last.sort_time, after_key: last.key }
      : {
          version: 2,
          source_mode: state.source_mode,
          checkpoint: state.target as Watermark,
          checkpoint_integrity: state.target_integrity as SyncIntegrity,
        };
    return {
      ...rendered,
      cursor: encodeReference(request.referenceKey, request.lineage, "sync", nextState as unknown as Record<string, unknown>),
      hasMore,
      asOf: watermarkToken(state.target as Watermark),
    };
  } finally {
    request.close();
  }
}
