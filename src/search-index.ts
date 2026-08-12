import { createHash } from "node:crypto";
import { totalmem } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { PrivacyMode, ServiceFamily, Warning, Watermark } from "./contracts.js";
import { serviceFamily } from "./contracts.js";
import type { UnifiedContactResolver } from "./contacts.js";
import type { DatabaseContext, DatabaseRequest } from "./database.js";
import { assertFrozenTraversal, parseWatermark, watermarkToken } from "./database.js";
import type { MessageTextDecoder } from "./decoder.js";
import { populatedMessageText } from "./decoder.js";
import { ImessageMcpError } from "./errors.js";
import { decodeReference, encodeReference } from "./references.js";
import { assertMessageConversationIntegrity } from "./repositories/conversations.js";
import { columnSql, serviceFamilyCase, serviceFamilyPredicate, serviceSql } from "./schema-sql.js";
import type { DateBounds } from "./time.js";
import {
  appleTimestampBoundary,
  appleTimestampBoundarySql,
  appleTimestampSortToken,
  appleTimestampToIso,
  sqliteIntegerBinding,
  sqliteIntegerToken,
} from "./time.js";

export type SearchMode = "substring" | "exact" | "token" | "phrase";
export type SearchScope = "text" | "conversation_names" | "attachment_filenames";
export type SearchOrder = "newest" | "relevance";

export interface SearchHit {
  message_ref: string;
  conversation_ref: string;
  timestamp: string | null;
  service_family: ServiceFamily;
  sender: { name: string | null; handle: string | null };
  snippet?: string;
  matched_scopes: SearchScope[];
  attachment_filenames?: string[];
  relevance?: number;
  row_status: "complete" | "partial";
}

interface SourceRow {
  rowid: number;
  guid: string;
  text: string | null;
  text_type: string;
  attributed_body: Buffer | null;
  body_unsupported: number;
  date: string;
  is_from_me: number;
  service: string | null;
  handle: string | null;
  chat_ids_json: string;
  chat_names_json: string;
  participant_handles_json: string;
  filenames_json: string;
}

interface IndexCursor {
  query_hash: string;
  frozen: Watermark;
  after_date?: string;
  after_rowid: number;
  after_rank?: number;
}

interface IndexEstimate {
  rows: number;
  body_bytes: number;
  relation_bytes: number;
  relation_rows: number;
  max_text_bytes: number;
  max_blob_bytes: number;
  max_relation_value_bytes: number;
  max_relations_per_message: number;
  estimated_bytes: number;
}

const MIB = 1024 * 1024;
const SOURCE_BATCH_SIZE = 500;
const SOURCE_BATCH_BYTES = 8 * MIB;
const MAX_INDEX_TEXT_BYTES = 3 * MIB;
const MAX_INDEX_BLOB_BYTES = MIB;
const ESTIMATED_BYTES_PER_ROW = 224;
const MAX_INDEX_RELATION_ROWS = 20_000_000;
const MAX_INDEX_RELATIONS_PER_MESSAGE = 1_000;
const MAX_INDEX_RELATION_VALUE_BYTES = 4_096;
const MAX_SNIPPET_WINDOW_BYTES = 256 * 1024;
const MAX_SNIPPET_NEEDLE_LENGTH = 16_384;
const MAX_SNIPPET_BYTES = 32 * 1024;
const MAX_SNIPPET_CONTENT_BYTES = MAX_SNIPPET_BYTES - 6;
const SNIPPET_CONTEXT_GRAPHEMES = 40;

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function safeFtsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizedTokens(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function scopeMatches(value: string, query: string, mode: SearchMode): boolean {
  const normalizedValue = normalize(value);
  const normalizedQuery = normalize(query);
  if (mode === "exact") return normalizedValue === normalizedQuery;
  if (mode === "token") {
    const tokens = normalizedTokens(query);
    const values = new Set(normalizedTokens(value));
    return tokens.length > 0 && tokens.every((token) => values.has(token));
  }
  return normalizedValue.includes(normalizedQuery);
}

function normalizedScopeMatches(normalizedValue: string, query: string, mode: SearchMode): boolean {
  const normalizedQuery = normalize(query);
  if (mode === "exact") return normalizedValue === normalizedQuery;
  if (mode === "token") {
    const tokens = normalizedTokens(query);
    const values = new Set(normalizedValue.match(/[\p{L}\p{N}]+/gu) ?? []);
    return tokens.length > 0 && tokens.every((token) => values.has(token));
  }
  if (mode === "phrase") {
    const phrase = normalizedTokens(query);
    const values = normalizedValue.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (phrase.length === 0 || phrase.length > values.length) return false;
    return values.some((_, start) => phrase.every((token, offset) => values[start + offset] === token));
  }
  return normalizedValue.includes(normalizedQuery);
}

function snippetNeedle(normalizedText: string, query: string, mode: SearchMode): string {
  if ((mode !== "token" && mode !== "phrase") || normalizedText.includes(normalize(query))) return query;
  return normalizedTokens(query).find((token) => normalizedText.includes(token)) ?? query;
}

function parseJsonArray(value: string, maximum: number, label: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > maximum) throw new Error("invalid array");
    return parsed;
  } catch {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", `search ${label} aggregation returned invalid JSON`);
  }
}

function stringArray(value: string, maximum: number, label: string): string[] {
  const parsed = parseJsonArray(value, maximum, label);
  if (parsed.some((item) => typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_INDEX_RELATION_VALUE_BYTES)) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", `search ${label} aggregation contains an invalid value`);
  }
  return (parsed as string[]).filter((item) => item.length > 0);
}

function basenameArray(value: string): string[] {
  return stringArray(value, MAX_INDEX_RELATIONS_PER_MESSAGE, "attachment-filename")
    .map((item) => path.basename(item))
    .filter((item) => item.length > 0)
    .sort();
}

function chatIdArray(value: string): number[] {
  const parsed = parseJsonArray(value, MAX_INDEX_RELATIONS_PER_MESSAGE, "conversation");
  if (
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "search conversation aggregation contains invalid chat identifiers");
  }
  return (parsed as number[]).sort((a, b) => a - b);
}

function graphemeSnippet(text: string, query: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const matchNeedle = normalize(query);
  if (matchNeedle.length === 0 || matchNeedle.length > MAX_SNIPPET_NEEDLE_LENGTH) return "";
  const window: Array<{ source: string; normalized: string; bytes: number }> = [];
  let windowNormalized = "";
  let windowBytes = 0;
  let prefixOmitted = false;
  let selected: string[] | null = null;
  let selectedBytes = 0;
  let remainingContext = SNIPPET_CONTEXT_GRAPHEMES;
  let suffixOmitted = false;
  for (const segment of segmenter.segment(text)) {
    if (selected) {
      if (remainingContext === 0) {
        suffixOmitted = true;
        break;
      }
      const bytes = Buffer.byteLength(segment.segment, "utf8");
      if (selectedBytes + bytes > MAX_SNIPPET_CONTENT_BYTES) {
        suffixOmitted = true;
        break;
      }
      selected.push(segment.segment);
      selectedBytes += bytes;
      remainingContext -= 1;
      continue;
    }
    const normalizedSegment = normalize(segment.segment);
    const bytes = Buffer.byteLength(segment.segment, "utf8");
    if (bytes > MAX_SNIPPET_WINDOW_BYTES) return "";
    window.push({ source: segment.segment, normalized: normalizedSegment, bytes });
    windowNormalized += normalizedSegment;
    windowBytes += bytes;
    while (window.length > 1) {
      const first = window[0];
      const canDrop = windowNormalized.length - first.normalized.length >= matchNeedle.length + SNIPPET_CONTEXT_GRAPHEMES;
      const mustDrop = windowBytes > MAX_SNIPPET_WINDOW_BYTES;
      if (!canDrop && !mustDrop) break;
      if (mustDrop && windowNormalized.length - first.normalized.length < matchNeedle.length) return "";
      window.shift();
      windowNormalized = windowNormalized.slice(first.normalized.length);
      windowBytes -= first.bytes;
      prefixOmitted = true;
    }
    const matchIndex = windowNormalized.indexOf(matchNeedle);
    if (matchIndex < 0) continue;
    let normalizedOffset = 0;
    let firstMatch = 0;
    let lastMatch = window.length - 1;
    for (let index = 0; index < window.length; index += 1) {
      const next = normalizedOffset + window[index].normalized.length;
      if (next <= matchIndex) firstMatch = index + 1;
      if (normalizedOffset < matchIndex + matchNeedle.length) lastMatch = index;
      normalizedOffset = next;
    }
    const start = Math.max(0, firstMatch - SNIPPET_CONTEXT_GRAPHEMES);
    prefixOmitted ||= start > 0;
    selected = window.slice(start, lastMatch + 1).map((value) => value.source);
    selectedBytes = selected.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
    let prefixItems = firstMatch - start;
    while (selectedBytes > MAX_SNIPPET_CONTENT_BYTES && prefixItems > 0) {
      selectedBytes -= Buffer.byteLength(selected.shift() as string, "utf8");
      prefixItems -= 1;
      prefixOmitted = true;
    }
    if (selectedBytes > MAX_SNIPPET_CONTENT_BYTES) return "";
  }
  if (!selected) return "";
  return `${prefixOmitted ? "…" : ""}${selected.join("")}${suffixOmitted ? "…" : ""}`;
}

function queryHash(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
}

export class MemorySearchIndex {
  private index: Database.Database | null = null;
  private indexedWatermark: Watermark | null = null;
  private skipped = 0;
  private complete = false;
  private trigram = false;
  private building: Promise<void> | null = null;

  constructor(
    private readonly context: DatabaseContext,
    private readonly decoder: MessageTextDecoder,
    private readonly contacts: UnifiedContactResolver,
  ) {}

  state(): {
    state: "cold" | "ready" | "partial" | "building";
    indexed_messages: number;
    memory_used_bytes: number;
    memory_limit_bytes: number;
  } {
    const count = this.index
      ? Number((this.index.prepare("SELECT COUNT(*) AS count FROM message_text").get() as { count: number }).count)
      : 0;
    return {
      state: this.building ? "building" : !this.index ? "cold" : this.complete ? "ready" : "partial",
      indexed_messages: count,
      memory_used_bytes: this.index ? this.memoryFootprint(this.index) : 0,
      memory_limit_bytes: this.memoryLimit(),
    };
  }

  private memoryLimit(): number {
    return Math.min(512 * MIB, Math.floor(totalmem() / 8));
  }

  private createIndex(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("temp_store = MEMORY");
    const pageSize = Number(db.pragma("page_size", { simple: true })) || 4096;
    db.pragma(`max_page_count = ${Math.max(1, Math.floor(this.memoryLimit() / pageSize))}`);
    db.exec(`
      CREATE TABLE message_text (
        rowid INTEGER PRIMARY KEY,
        guid TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        conversation_text TEXT NOT NULL,
        normalized_conversation TEXT NOT NULL,
        normalized_conversation_values TEXT NOT NULL,
        attachment_text TEXT NOT NULL,
        normalized_attachments TEXT NOT NULL,
        normalized_attachment_values TEXT NOT NULL,
        date INTEGER NOT NULL,
        is_from_me INTEGER NOT NULL,
        service TEXT,
        handle TEXT,
        chat_ids TEXT NOT NULL,
        filenames TEXT NOT NULL,
        row_status TEXT NOT NULL CHECK (row_status IN ('complete', 'partial'))
      );
    `);
    db.function("mcp_text_matches", { deterministic: true }, (value: unknown, query: unknown, mode: unknown) =>
      typeof value === "string" && typeof query === "string" &&
      (mode === "token" || mode === "phrase") && normalizedScopeMatches(value, query, mode) ? 1 : 0
    );
    db.function("mcp_values_match", { deterministic: true }, (encoded: unknown, query: unknown, mode: unknown) => {
      if (typeof encoded !== "string" || typeof query !== "string" || (mode !== "token" && mode !== "phrase")) return 0;
      try {
        const values = JSON.parse(encoded) as unknown;
        return Array.isArray(values) && values.some((value) =>
          typeof value === "string" && normalizedScopeMatches(value, query, mode)
        ) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    return db;
  }

  private finalizeIndex(db: Database.Database): void {
    db.exec(`
      CREATE INDEX message_text_exact ON message_text(normalized_text);
      CREATE INDEX message_text_newest ON message_text(date DESC, rowid DESC);
      CREATE VIRTUAL TABLE message_fts USING fts5(
        normalized_text, normalized_conversation, normalized_attachments,
        content='message_text', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 0'
      );
      INSERT INTO message_fts(message_fts) VALUES('rebuild');
    `);
    try {
      db.exec(`CREATE VIRTUAL TABLE message_trigram USING fts5(
        normalized_text, content='message_text', content_rowid='rowid', tokenize='trigram case_sensitive 1'
      );
      INSERT INTO message_trigram(message_trigram) VALUES('rebuild');`);
      this.trigram = true;
    } catch {
      this.trigram = false;
    }
    db.pragma("optimize");
    db.pragma("shrink_memory");
  }

  private estimate(request: DatabaseRequest, allowPartial: boolean): IndexEstimate {
    const text = columnSql(request, "message", "m", "text", "NULL");
    const body = columnSql(request, "message", "m", "attributedBody", "NULL");
    const associated = columnSql(request, "message", "m", "associated_message_type", "0");
    const itemType = columnSql(request, "message", "m", "item_type", "0");
    const system = columnSql(request, "message", "m", "is_system_message", "0");
    const retracted = columnSql(request, "message", "m", "date_retracted", "0");
    const eligible = `m.ROWID <= @target
      AND COALESCE(${associated}, 0) = 0
      AND COALESCE(${itemType}, 0) = 0
      AND COALESCE(${system}, 0) = 0
      AND COALESCE(${retracted}, 0) <= 0
      AND EXISTS (SELECT 1 FROM chat_message_join eligible_cmj WHERE eligible_cmj.message_id = m.ROWID)`;
    const indexedBodyBytes = allowPartial
      ? `CASE WHEN COALESCE(LENGTH(${body}), 0) <= ${MAX_INDEX_BLOB_BYTES}
              THEN COALESCE(LENGTH(${body}), 0) ELSE 0 END`
      : `COALESCE(LENGTH(${body}), 0)`;
    const row = request.db
      .prepare(
        `SELECT COUNT(*) AS rows,
                COALESCE(SUM(LENGTH(CAST(${text} AS BLOB))), 0) + COALESCE(SUM(${indexedBodyBytes}), 0) AS body_bytes,
                COALESCE(MAX(LENGTH(CAST(${text} AS BLOB))), 0) AS max_text_bytes,
                COALESCE(MAX(LENGTH(${body})), 0) AS max_blob_bytes
         FROM message m
         WHERE ${eligible}`,
      )
      .get({ target: request.asOf.max_message_id }) as {
        rows: number;
        body_bytes: number;
        max_text_bytes: number;
        max_blob_bytes: number;
      };
    const rows = Number(row.rows || 0);
    const bodyBytes = Number(row.body_bytes || 0);
    const chatColumns = request.capabilities.tables.chat ?? [];
    const attachmentColumns = request.capabilities.tables.attachment ?? [];
    const messageService = columnSql(request, "message", "m", "service", "NULL");
    const messageMetadata = request.db.prepare(
      `SELECT COALESCE(SUM(LENGTH(CAST(m.guid AS BLOB)) + LENGTH(CAST(COALESCE(h.id, '') AS BLOB)) +
               LENGTH(CAST(COALESCE(${messageService}, '') AS BLOB))), 0) AS bytes,
              COALESCE(MAX(MAX(LENGTH(CAST(m.guid AS BLOB)), LENGTH(CAST(COALESCE(h.id, '') AS BLOB)),
               LENGTH(CAST(COALESCE(${messageService}, '') AS BLOB)))), 0) AS max_value
       FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE ${eligible}`,
    ).get({ target: request.asOf.max_message_id }) as { bytes: number; max_value: number };
    const chatTextParts = [
      chatColumns.includes("display_name") ? "LENGTH(CAST(COALESCE(c.display_name, '') AS BLOB))" : "0",
      chatColumns.includes("service_name") ? "LENGTH(CAST(COALESCE(c.service_name, '') AS BLOB))" : "0",
    ];
    const componentCounts = `eligible_components AS (
      SELECT m.ROWID AS rowid, mcp_canonical_chat(cmj.chat_id) AS conversation_id
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE ${eligible}
      GROUP BY m.ROWID
    ), component_message_counts AS (
      SELECT conversation_id, COUNT(*) AS messages
      FROM eligible_components
      GROUP BY conversation_id
    )`;
    const chatStats = request.db.prepare(
      `WITH ${componentCounts}, component_chat_stats AS (
         SELECT mcp_canonical_chat(c.ROWID) AS conversation_id,
                COUNT(*) AS relations,
                COALESCE(SUM(${chatTextParts.join(" + ")}), 0) AS bytes,
                COALESCE(MAX(MAX(${chatTextParts.join(", ")})), 0) AS max_value
         FROM chat c
         GROUP BY mcp_canonical_chat(c.ROWID)
       )
       SELECT COALESCE(SUM(counts.messages * stats.relations), 0) AS rows,
              COALESCE(SUM(counts.messages * stats.bytes), 0) AS bytes,
              COALESCE(MAX(stats.max_value), 0) AS max_value,
              COALESCE(MAX(stats.relations), 0) AS max_fanout
       FROM component_message_counts counts
       JOIN component_chat_stats stats ON stats.conversation_id = counts.conversation_id`,
    ).get({ target: request.asOf.max_message_id }) as { rows: number; bytes: number; max_value: number; max_fanout: number };
    const participantStats = request.db.prepare(
      `WITH ${componentCounts}, distinct_participants AS (
         SELECT DISTINCT mcp_canonical_chat(chj.chat_id) AS conversation_id, h.id
         FROM chat_handle_join chj
         JOIN handle h ON h.ROWID = chj.handle_id
       ), component_participant_stats AS (
         SELECT conversation_id, COUNT(*) AS relations,
                COALESCE(SUM(LENGTH(CAST(id AS BLOB))), 0) AS bytes,
                COALESCE(MAX(LENGTH(CAST(id AS BLOB))), 0) AS max_value
         FROM distinct_participants
         GROUP BY conversation_id
       )
       SELECT COALESCE(SUM(counts.messages * stats.relations), 0) AS rows,
              COALESCE(SUM(counts.messages * stats.bytes), 0) AS bytes,
              COALESCE(MAX(stats.max_value), 0) AS max_value,
              COALESCE(MAX(stats.relations), 0) AS max_fanout
       FROM component_message_counts counts
       JOIN component_participant_stats stats ON stats.conversation_id = counts.conversation_id`,
    ).get({ target: request.asOf.max_message_id }) as { rows: number; bytes: number; max_value: number; max_fanout: number };
    const attachmentTextParts = ["transfer_name", "filename"]
      .filter((column) => attachmentColumns.includes(column))
      .map((column) => `LENGTH(CAST(COALESCE(a.${column}, '') AS BLOB))`);
    const attachmentStats = request.capabilities.attachments === "available"
      ? request.db.prepare(
          `SELECT COUNT(*) AS rows,
                  COALESCE(SUM(${attachmentTextParts.length ? attachmentTextParts.join(" + ") : "0"}), 0) AS bytes,
                  COALESCE(MAX(${attachmentTextParts.length === 0 ? "0" : attachmentTextParts.length === 1 ? attachmentTextParts[0] : `MAX(${attachmentTextParts.join(", ")})`}), 0) AS max_value
           FROM message_attachment_join maj
           JOIN message m ON m.ROWID = maj.message_id
           JOIN attachment a ON a.ROWID = maj.attachment_id
           WHERE ${eligible}`,
        ).get({ target: request.asOf.max_message_id }) as { rows: number; bytes: number; max_value: number }
      : { rows: 0, bytes: 0, max_value: 0 };
    const attachmentFanout = request.capabilities.attachments === "available"
      ? request.db.prepare(
          `SELECT COALESCE(MAX(value), 0) AS value FROM (
             SELECT COUNT(*) AS value FROM message_attachment_join maj
             JOIN message m ON m.ROWID = maj.message_id
             WHERE ${eligible} GROUP BY maj.message_id
           )`,
        ).get({ target: request.asOf.max_message_id }) as { value: number }
      : { value: 0 };
    const relationBytes = Number(messageMetadata.bytes || 0) + Number(chatStats.bytes || 0) +
      Number(participantStats.bytes || 0) + Number(attachmentStats.bytes || 0);
    const relationRows = Number(chatStats.rows || 0) + Number(participantStats.rows || 0) + Number(attachmentStats.rows || 0);
    return {
      rows,
      body_bytes: bodyBytes,
      relation_bytes: relationBytes,
      relation_rows: relationRows,
      max_text_bytes: Number(row.max_text_bytes || 0),
      max_blob_bytes: Number(row.max_blob_bytes || 0),
      max_relation_value_bytes: Math.max(
        Number(messageMetadata.max_value || 0),
        Number(chatStats.max_value || 0),
        Number(participantStats.max_value || 0),
        Number(attachmentStats.max_value || 0),
      ),
      max_relations_per_message: Math.max(
        Number(chatStats.max_fanout || 0),
        Number(participantStats.max_fanout || 0),
        Number(attachmentFanout.value || 0),
      ),
      // The fixed row allowance covers SQLite table and index pages. Variable source
      // values are counted separately without multiplying relationship metadata as
      // though the pre-aggregated source query still formed a Cartesian product.
      estimated_bytes: rows * ESTIMATED_BYTES_PER_ROW + bodyBytes * 2 + relationBytes * 3 + relationRows * 8,
    };
  }

  private nextBatchTarget(request: DatabaseRequest, afterRowid: number, targetRowid: number): number {
    const text = columnSql(request, "message", "m", "text", "NULL");
    const body = columnSql(request, "message", "m", "attributedBody", "NULL");
    const associated = columnSql(request, "message", "m", "associated_message_type", "0");
    const itemType = columnSql(request, "message", "m", "item_type", "0");
    const system = columnSql(request, "message", "m", "is_system_message", "0");
    const retracted = columnSql(request, "message", "m", "date_retracted", "0");
    const rows = request.db.prepare(
      `SELECT m.ROWID AS rowid,
              COALESCE(LENGTH(CAST(${text} AS BLOB)), 0) +
                CASE WHEN COALESCE(LENGTH(${body}), 0) <= ${MAX_INDEX_BLOB_BYTES}
                     THEN COALESCE(LENGTH(${body}), 0) ELSE 0 END AS source_bytes
       FROM message m
       WHERE m.ROWID > @after AND m.ROWID <= @target
         AND COALESCE(${associated}, 0) = 0
         AND COALESCE(${itemType}, 0) = 0
         AND COALESCE(${system}, 0) = 0
         AND COALESCE(${retracted}, 0) <= 0
         AND EXISTS (SELECT 1 FROM chat_message_join eligible_cmj WHERE eligible_cmj.message_id = m.ROWID)
       ORDER BY m.ROWID
       LIMIT @limit`,
    ).all({ after: afterRowid, target: targetRowid, limit: SOURCE_BATCH_SIZE }) as Array<{ rowid: number; source_bytes: number }>;
    if (rows.length === 0) return targetRowid;
    let bytes = 0;
    let selected = rows[0].rowid;
    for (const row of rows) {
      const next = Number(row.source_bytes || 0);
      if (bytes > 0 && bytes + next > SOURCE_BATCH_BYTES) break;
      bytes += next;
      selected = row.rowid;
    }
    return selected;
  }

  private sourceRows(request: DatabaseRequest, afterRowid: number, targetRowid: number): SourceRow[] {
    const text = columnSql(request, "message", "m", "text", "NULL");
    const attributedBody = columnSql(request, "message", "m", "attributedBody", "NULL");
    const textType = `TYPEOF(${text})`;
    const bodyType = `TYPEOF(${attributedBody})`;
    const boundedAttributedBody = `CASE WHEN ${bodyType} = 'blob'
      AND COALESCE(LENGTH(${attributedBody}), 0) <= ${MAX_INDEX_BLOB_BYTES}
      THEN ${attributedBody} ELSE NULL END`;
    const bodyUnsupported = `CASE WHEN ${bodyType} NOT IN ('blob', 'null') OR (${attributedBody} IS NOT NULL
      AND LENGTH(${attributedBody}) > ${MAX_INDEX_BLOB_BYTES}) THEN 1 ELSE 0 END`;
    const associated = columnSql(request, "message", "m", "associated_message_type", "0");
    const itemType = columnSql(request, "message", "m", "item_type", "0");
    const system = columnSql(request, "message", "m", "is_system_message", "0");
    const retracted = columnSql(request, "message", "m", "date_retracted", "0");
    const attachmentColumns = request.capabilities.tables.attachment ?? [];
    const filenameSources = ["transfer_name", "filename"]
      .filter((column) => attachmentColumns.includes(column))
      .map((column) => `NULLIF(a.${column}, '')`);
    const filename = filenameSources.length === 0
      ? "NULL"
      : filenameSources.length === 1
        ? filenameSources[0]
        : `COALESCE(${filenameSources.join(", ")})`;
    const selectedService = columnSql(request, "message", "m", "service", "NULL");
    const attachmentCte = request.capabilities.attachments === "available"
      ? `, attachment_relations AS (
           SELECT selected.rowid,
                  json_group_array(DISTINCT ${filename}) FILTER (WHERE ${filename} IS NOT NULL) AS filenames_json
           FROM selected
           LEFT JOIN message_attachment_join maj ON maj.message_id = selected.rowid
           LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
           GROUP BY selected.rowid
         )`
      : "";
    const filenames = request.capabilities.attachments === "available"
      ? "COALESCE(attachment_relations.filenames_json, '[]')"
      : "'[]'";
    const relationService = serviceSql(request, "selected", "c");
    const relationServiceFamily = serviceFamilyCase(relationService);
    const componentChatName = columnSql(request, "chat", "component_chat", "display_name", "NULL");

    return request.db
      .prepare(
        `WITH selected AS (
	           SELECT m.ROWID AS rowid, m.guid, ${text} AS text, ${textType} AS text_type,
                  ${boundedAttributedBody} AS attributed_body, ${bodyUnsupported} AS body_unsupported,
                  CAST(m.date AS TEXT) AS date, m.is_from_me,
                  m.handle_id, ${selectedService} AS service
           FROM message m
           WHERE m.ROWID > @after AND m.ROWID <= @target
             AND COALESCE(${associated}, 0) = 0
             AND COALESCE(${itemType}, 0) = 0
             AND COALESCE(${system}, 0) = 0
             AND COALESCE(${retracted}, 0) <= 0
             AND EXISTS (SELECT 1 FROM chat_message_join eligible_cmj WHERE eligible_cmj.message_id = m.ROWID)
           ORDER BY m.ROWID
           LIMIT @limit
         ), direct_relations AS (
           SELECT selected.rowid, mcp_canonical_chat(cmj.chat_id) AS conversation_id,
                  ${relationService} AS service
           FROM selected
           JOIN chat_message_join cmj ON cmj.message_id = selected.rowid
           JOIN chat c ON c.ROWID = cmj.chat_id
         ), message_conversations AS (
           SELECT rowid, MIN(conversation_id) AS conversation_id,
                  CASE WHEN COUNT(DISTINCT ${serviceFamilyCase("service")}) = 1
                       THEN MIN(service) ELSE 'unknown' END AS service
           FROM direct_relations
           GROUP BY rowid
         ), component_relations AS (
           SELECT mcp_canonical_chat(component_chat.ROWID) AS conversation_id,
                  json_group_array(DISTINCT component_chat.ROWID) AS chat_ids_json,
                  json_group_array(DISTINCT ${componentChatName}) FILTER (WHERE ${componentChatName} IS NOT NULL) AS chat_names_json
           FROM chat component_chat
           GROUP BY mcp_canonical_chat(component_chat.ROWID)
         ), component_participants AS (
           SELECT mcp_canonical_chat(chj.chat_id) AS conversation_id,
                  json_group_array(DISTINCT participant.id) AS participant_handles_json
           FROM chat_handle_join chj
           JOIN handle participant ON participant.ROWID = chj.handle_id
           GROUP BY mcp_canonical_chat(chj.chat_id)
         ), chat_relations AS (
           SELECT messages.rowid, messages.service, components.chat_ids_json, components.chat_names_json,
                  COALESCE(participants.participant_handles_json, '[]') AS participant_handles_json
           FROM message_conversations messages
           JOIN component_relations components ON components.conversation_id = messages.conversation_id
           LEFT JOIN component_participants participants ON participants.conversation_id = messages.conversation_id
         )
         ${attachmentCte}
         SELECT
	           selected.rowid,
	           selected.guid,
	           selected.text,
	           selected.text_type,
	           selected.attributed_body,
           selected.body_unsupported,
           selected.date,
           selected.is_from_me,
           chat_relations.service,
           h.id AS handle,
           chat_relations.chat_ids_json,
           chat_relations.chat_names_json,
           chat_relations.participant_handles_json,
           ${filenames} AS filenames_json
         FROM selected
         JOIN chat_relations ON chat_relations.rowid = selected.rowid
         LEFT JOIN handle h ON h.ROWID = selected.handle_id
         ${request.capabilities.attachments === "available" ? "LEFT JOIN attachment_relations ON attachment_relations.rowid = selected.rowid" : ""}
         ORDER BY selected.rowid`,
      )
      .all({ after: afterRowid, target: targetRowid, limit: SOURCE_BATCH_SIZE }) as SourceRow[];
  }

  private memoryFootprint(db: Database.Database): number {
    const pages = Number(db.pragma("page_count", { simple: true })) || 0;
    const pageSize = Number(db.pragma("page_size", { simple: true })) || 0;
    return pages * pageSize;
  }

  private enforceMemoryLimit(db: Database.Database): void {
    const used = this.memoryFootprint(db);
    if (used > this.memoryLimit()) {
      throw new ImessageMcpError("INDEX_TOO_LARGE", "complete in-memory search index exceeded its memory ceiling", {
        observed_bytes: used,
        limit_bytes: this.memoryLimit(),
      });
    }
  }

  private async populate(
    request: DatabaseRequest,
    db: Database.Database,
    afterRowid: number,
    targetRowid: number,
    allowPartial: boolean,
    updateIndexes: boolean,
  ): Promise<void> {
    await this.decoder.withSession(() => this.populateWithinDecoderSession(
      request,
      db,
      afterRowid,
      targetRowid,
      allowPartial,
      updateIndexes,
    ));
  }

  private async populateWithinDecoderSession(
    request: DatabaseRequest,
    db: Database.Database,
    afterRowid: number,
    targetRowid: number,
    allowPartial: boolean,
    updateIndexes: boolean,
  ): Promise<void> {
    const insert = db.prepare(
      `INSERT INTO message_text(
         rowid, guid, text, normalized_text, conversation_text, normalized_conversation,
         normalized_conversation_values, attachment_text, normalized_attachments,
         normalized_attachment_values, date, is_from_me, service, handle, chat_ids, filenames, row_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = updateIndexes
      ? db.prepare(
          "INSERT INTO message_fts(rowid, normalized_text, normalized_conversation, normalized_attachments) VALUES (?, ?, ?, ?)",
        )
      : null;
    const insertTrigram = updateIndexes && this.trigram
      ? db.prepare("INSERT INTO message_trigram(rowid, normalized_text) VALUES (?, ?)")
      : null;

    let cursor = afterRowid;
    while (cursor < targetRowid) {
      const batchTarget = this.nextBatchTarget(request, cursor, targetRowid);
      const batch = this.sourceRows(request, cursor, batchTarget);
      if (batch.length === 0) break;
      const blobRows = batch.filter((row) => !populatedMessageText(row.text) && row.attributed_body);
      let decoded: Awaited<ReturnType<MessageTextDecoder["decode"]>> = [];
      try {
        decoded = blobRows.length ? await this.decoder.decode(blobRows.map((row) => row.attributed_body as Buffer)) : [];
      } catch (error) {
        if (!allowPartial) throw error;
        decoded = blobRows.map(() => ({ status: "unsupported" as const }));
      }
      const decodedById = new Map(blobRows.map((row, index) => [row.rowid, decoded[index]]));
      const transaction = db.transaction(() => {
        for (const row of batch) {
          if (
            !Number.isSafeInteger(Number(row.rowid)) || Number(row.rowid) <= 0 ||
            typeof row.guid !== "string" || row.guid.length === 0 ||
            Buffer.byteLength(row.guid, "utf8") > MAX_INDEX_RELATION_VALUE_BYTES
          ) {
            throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "search source contains an invalid message identifier");
          }
          row.rowid = Number(row.rowid);
          const unsupportedText = row.text_type !== "text" && row.text_type !== "null";
          const native = populatedMessageText(row.text);
          const result = decodedById.get(row.rowid);
          const text = native ?? (result?.status === "decoded" ? result.text : "");
          const partial = Boolean(unsupportedText || (!native && (
            row.body_unsupported || (row.attributed_body && result?.status !== "decoded")
          )));
          if (partial) {
            this.skipped += 1;
            if (!allowPartial) {
              throw new ImessageMcpError(
                unsupportedText ? "UNSUPPORTED_SCHEMA" : "DECODE_FAILED",
                unsupportedText
                  ? "search index encountered an unsupported SQLite text storage class"
                  : "search index encountered an undecodable message body",
              );
            }
          }
          const participantNames = stringArray(
            row.participant_handles_json,
            MAX_INDEX_RELATIONS_PER_MESSAGE,
            "participant",
          )
            .map((handle) => this.contacts.nameForHandle(handle))
            .filter((name): name is string => Boolean(name));
          const conversationValues = [...new Set([
            ...stringArray(row.chat_names_json, MAX_INDEX_RELATIONS_PER_MESSAGE, "conversation-name"),
            ...participantNames,
          ])].sort();
          const conversationText = conversationValues.join(" ");
          const filenames = basenameArray(row.filenames_json);
          const attachmentText = filenames.join(" ");
          if (
            Buffer.byteLength(conversationText, "utf8") > MAX_INDEX_TEXT_BYTES ||
            Buffer.byteLength(attachmentText, "utf8") > MAX_INDEX_TEXT_BYTES
          ) {
            throw new ImessageMcpError("INDEX_TOO_LARGE", "one search relationship aggregate exceeds its bounded text size", {
              max_relation_value_bytes: MAX_INDEX_TEXT_BYTES,
              limit_bytes: this.memoryLimit(),
            });
          }
          const normalizedText = normalize(text);
          const normalizedConversationValues = conversationValues.map(normalize);
          const normalizedAttachmentValues = filenames.map(normalize);
          const normalizedConversation = normalizedConversationValues.join(" ");
          const normalizedAttachments = normalizedAttachmentValues.join(" ");
          insert.run(
            row.rowid,
            row.guid,
            text,
            normalizedText,
            conversationText,
            normalizedConversation,
            JSON.stringify(normalizedConversationValues),
            attachmentText,
            normalizedAttachments,
            JSON.stringify(normalizedAttachmentValues),
            sqliteIntegerBinding(appleTimestampSortToken(row.date, "search message timestamp")),
            row.is_from_me,
            row.service,
            row.handle,
            JSON.stringify(chatIdArray(row.chat_ids_json)),
            JSON.stringify(filenames),
            partial ? "partial" : "complete",
          );
          insertFts?.run(row.rowid, normalizedText, normalizedConversation, normalizedAttachments);
          insertTrigram?.run(row.rowid, normalizedText);
        }
      });
      transaction();
      cursor = batch.at(-1)!.rowid;
      this.enforceMemoryLimit(db);
    }
  }

  private async build(allowPartial: boolean): Promise<void> {
    const request = this.context.request();
    let db: Database.Database | null = null;
    try {
      assertMessageConversationIntegrity(request);
      const estimate = this.estimate(request, allowPartial);
      if (!allowPartial && estimate.max_blob_bytes > MAX_INDEX_BLOB_BYTES) {
        throw new ImessageMcpError("DECODE_FAILED", "search index encountered an attributed-body blob above the 1 MiB decoder limit", {
          max_blob_bytes: estimate.max_blob_bytes,
          limit_bytes: MAX_INDEX_BLOB_BYTES,
          retry: "retry with allow_partial true to omit only oversized blob bodies",
        });
      }
      if (
        estimate.estimated_bytes > this.memoryLimit() ||
        estimate.max_text_bytes > MAX_INDEX_TEXT_BYTES ||
        estimate.relation_rows > MAX_INDEX_RELATION_ROWS ||
        estimate.max_relations_per_message > MAX_INDEX_RELATIONS_PER_MESSAGE ||
        estimate.max_relation_value_bytes > MAX_INDEX_RELATION_VALUE_BYTES
      ) {
        throw new ImessageMcpError("INDEX_TOO_LARGE", "complete in-memory search index would exceed its memory ceiling", {
          estimated_bytes: estimate.estimated_bytes,
          indexed_rows: estimate.rows,
          source_body_bytes: estimate.body_bytes,
          source_relation_bytes: estimate.relation_bytes,
          source_relation_rows: estimate.relation_rows,
          max_text_bytes: estimate.max_text_bytes,
          max_blob_bytes: estimate.max_blob_bytes,
          max_relation_value_bytes: estimate.max_relation_value_bytes,
          max_relations_per_message: estimate.max_relations_per_message,
          limit_bytes: this.memoryLimit(),
        });
      }
      db = this.createIndex();
      this.skipped = 0;
      await this.populate(request, db, 0, request.asOf.max_message_id, allowPartial, false);
      this.finalizeIndex(db);
      this.enforceMemoryLimit(db);
      const previous = this.index;
      this.index = db;
      db = null;
      this.indexedWatermark = request.asOf;
      this.complete = this.skipped === 0;
      previous?.close();
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_FULL") {
        throw new ImessageMcpError("INDEX_TOO_LARGE", "complete in-memory search index exceeded its hard SQLite page ceiling", {
          limit_bytes: this.memoryLimit(),
        });
      }
      throw error;
    } finally {
      db?.close();
      request.close();
    }
  }

  async ensure(allowPartial: boolean): Promise<void> {
    if (this.building) await this.building;
    if (!this.index || (!allowPartial && !this.complete)) {
      this.building = this.build(allowPartial);
      try {
        await this.building;
      } finally {
        this.building = null;
      }
      return;
    }

    const request = this.context.request();
    try {
      const indexed = this.indexedWatermark;
      if (!indexed) return;
      if (request.asOf.data_version !== indexed.data_version) {
        request.close();
        this.building = this.build(allowPartial);
        try {
          await this.building;
        } finally {
          this.building = null;
        }
        return;
      }
      if (request.asOf.max_message_id > indexed.max_message_id) {
        await this.populate(request, this.index, indexed.max_message_id, request.asOf.max_message_id, allowPartial, true);
      }
      this.indexedWatermark = request.asOf;
      this.complete = this.complete && this.skipped === 0;
    } finally {
      if (request.db.open) request.close();
    }
  }

  private whereFor(input: {
    query: string;
    mode: SearchMode;
    scopes: SearchScope[];
    bounds: DateBounds;
    service?: ServiceFamily;
  }): { sql: string; bindings: Record<string, unknown>; rank: string } {
    const conditions: string[] = [];
    const normalizedQuery = normalize(input.query);
    const bindings: Record<string, unknown> = { query: normalizedQuery };
    let rank = "0.0";
    const scopeColumns = input.scopes.map((scope) => ({
      column: scope === "text" ? "normalized_text" : scope === "conversation_names" ? "normalized_conversation" : "normalized_attachments",
      valuesColumn: scope === "text"
        ? null
        : scope === "conversation_names"
          ? "normalized_conversation_values"
          : "normalized_attachment_values",
      weight: scope === "text" ? 3 : scope === "conversation_names" ? 2 : 1,
    }));
    const exactCondition = ({ column, valuesColumn }: typeof scopeColumns[number]) => valuesColumn
      ? `EXISTS (SELECT 1 FROM json_each(${valuesColumn}) scope_value WHERE scope_value.value = @query)`
      : `${column} = @query`;
    const substringPosition = ({ column, valuesColumn }: typeof scopeColumns[number]) => valuesColumn
      ? `COALESCE((SELECT MIN(INSTR(scope_value.value, @query)) FROM json_each(${valuesColumn}) scope_value WHERE INSTR(scope_value.value, @query) > 0), 0)`
      : `INSTR(${column}, @query)`;
    if (input.mode === "exact") {
      conditions.push(`(${scopeColumns.map(exactCondition).join(" OR ")})`);
      const scores = scopeColumns.map((scope) => `CASE WHEN ${exactCondition(scope)} THEN ${scope.weight}.0 ELSE 0.0 END`);
      rank = scores.length === 1 ? scores[0] : `MAX(${scores.join(", ")})`;
    } else if (input.mode === "substring") {
      if (this.trigram && input.scopes.length === 1 && input.scopes[0] === "text" && [...normalizedQuery].length >= 3) {
        conditions.push(
          "rowid IN (SELECT rowid FROM message_trigram WHERE message_trigram MATCH @fts_query) AND INSTR(normalized_text, @query) > 0",
        );
        bindings.fts_query = safeFtsPhrase(normalizedQuery);
      } else {
        conditions.push(`(${scopeColumns.map((scope) => `${substringPosition(scope)} > 0`).join(" OR ")})`);
      }
      const scores = scopeColumns.map((scope) =>
        `CASE WHEN ${substringPosition(scope)} > 0 THEN ${scope.weight}.0 + (1.0 / ${substringPosition(scope)}) ELSE 0.0 END`
      );
      rank = scores.length === 1 ? scores[0] : `MAX(${scores.join(", ")})`;
    } else {
      const terms = normalizedTokens(normalizedQuery);
      if (terms.length === 0) {
        throw new ImessageMcpError("INVALID_INPUT", "token and phrase search require at least one letter or number");
      }
      const query = input.mode === "phrase"
        ? safeFtsPhrase(terms.join(" "))
        : terms.map(safeFtsPhrase).join(" AND ");
      conditions.push("rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH @fts_query)");
      bindings.fts_query = scopeColumns
        .map(({ column }) => `${column} : (${query})`)
        .join(" OR ");
      bindings.match_mode = input.mode;
      conditions.push(`(${scopeColumns.map(({ column, valuesColumn }) => valuesColumn
        ? `mcp_values_match(${valuesColumn}, @query, @match_mode) = 1`
        : `mcp_text_matches(${column}, @query, @match_mode) = 1`
      ).join(" OR ")})`);
      rank = "(SELECT -bm25(message_fts, 3.0, 2.0, 1.0) FROM message_fts WHERE message_fts.rowid = message_text.rowid AND message_fts MATCH @fts_query)";
    }
    if (input.bounds.from_unix_seconds !== undefined) {
      const boundary = appleTimestampBoundary(input.bounds.from_unix_seconds);
      conditions.push(appleTimestampBoundarySql("date", ">=", "@date_from_seconds", "@date_from_nanoseconds"));
      bindings.date_from_seconds = boundary.seconds;
      bindings.date_from_nanoseconds = boundary.nanoseconds;
    }
    if (input.bounds.to_unix_seconds !== undefined) {
      const boundary = appleTimestampBoundary(input.bounds.to_unix_seconds);
      conditions.push(appleTimestampBoundarySql("date", "<", "@date_to_seconds", "@date_to_nanoseconds"));
      bindings.date_to_seconds = boundary.seconds;
      bindings.date_to_nanoseconds = boundary.nanoseconds;
    }
    if (input.service) conditions.push(serviceFamilyPredicate("service", input.service));
    return { sql: conditions.join(" AND "), bindings, rank };
  }

  async search(input: {
    query: string;
    mode: SearchMode;
    scopes: SearchScope[];
    order: SearchOrder;
    bounds: DateBounds;
    service?: ServiceFamily;
    limit: number;
    cursor?: string;
    allowPartial: boolean;
    privacy: PrivacyMode;
  }): Promise<{ hits: SearchHit[]; total: number; nextCursor: string | null; hasMore: boolean; asOf: string; warnings: Warning[] }> {
    if (input.query.length === 0 || normalize(input.query).trim().length === 0) {
      throw new ImessageMcpError("INVALID_INPUT", "search query must not be empty");
    }
    if (input.query.length > 4096) throw new ImessageMcpError("INVALID_INPUT", "search query exceeds the 4096 character limit");
    if (input.scopes.length === 0) throw new ImessageMcpError("INVALID_INPUT", "at least one search scope is required");
    if (input.scopes.length > 3 || new Set(input.scopes).size !== input.scopes.length) {
      throw new ImessageMcpError("INVALID_INPUT", "search scopes must be unique and limited to the three supported scopes");
    }

    const hash = queryHash({
      query: input.query,
      mode: input.mode,
      scopes: input.scopes,
      order: input.order,
      bounds: input.bounds,
      service: input.service,
    });
    let decodedCursor: IndexCursor | null = null;
    if (input.cursor) {
      const decoded = decodeReference(this.context.referenceKey, this.context.lineage, "page", input.cursor).value as unknown as IndexCursor;
      if (
        decoded.query_hash !== hash ||
        !Number.isSafeInteger(decoded.after_rowid) || decoded.after_rowid <= 0 ||
        (input.order === "relevance" && (typeof decoded.after_rank !== "number" || !Number.isFinite(decoded.after_rank)))
      ) {
        throw new ImessageMcpError("INVALID_INPUT", "cursor does not match this search");
      }
      if (input.order === "newest") {
        try {
          decoded.after_date = sqliteIntegerToken(decoded.after_date, "search cursor timestamp");
        } catch {
          throw new ImessageMcpError("INVALID_INPUT", "cursor contains an invalid search position");
        }
      }
      decoded.frozen = parseWatermark(decoded.frozen);
      decodedCursor = decoded;
      assertFrozenTraversal(decodedCursor.frozen, this.context.currentWatermark());
    }

    await this.ensure(input.allowPartial);
    if (!this.index || !this.indexedWatermark) throw new ImessageMcpError("DECODE_FAILED", "search index is unavailable");
    if (decodedCursor) assertFrozenTraversal(decodedCursor.frozen, this.indexedWatermark);
    const frozen = decodedCursor?.frozen ?? this.indexedWatermark;
    const { sql, bindings, rank } = this.whereFor(input);
    bindings.frozen_max = frozen.max_message_id;
    const cursorBindings: Record<string, unknown> = {};
    let cursorCondition = "";
    if (decodedCursor) {
      if (input.order === "newest") {
        cursorCondition = "AND (date < @after_date OR (date = @after_date AND rowid < @after_rowid))";
        cursorBindings.after_date = sqliteIntegerBinding(
          sqliteIntegerToken(decodedCursor.after_date, "search cursor timestamp"),
        );
        cursorBindings.after_rowid = decodedCursor.after_rowid;
      } else {
        cursorCondition = `AND ((${rank}) < @after_rank OR ((${rank}) = @after_rank AND rowid < @after_rowid))`;
        cursorBindings.after_rank = decodedCursor.after_rank;
        cursorBindings.after_rowid = decodedCursor.after_rowid;
      }
    }
    const frozenSql = `rowid <= @frozen_max AND ${sql}`;
    const total = Number(
      (this.index.prepare(`SELECT COUNT(*) AS count FROM message_text WHERE ${frozenSql}`).get(bindings) as { count: number }).count,
    );
    const order = input.order === "newest" ? "date DESC, rowid DESC" : "relevance DESC, rowid DESC";
    const rows = this.index
      .prepare(`SELECT *, CAST(date AS TEXT) AS date_token, ${rank} AS relevance FROM message_text WHERE ${frozenSql} ${cursorCondition} ORDER BY ${order} LIMIT @limit`)
      .all({ ...bindings, ...cursorBindings, limit: input.limit + 1 }) as Array<Record<string, unknown>>;
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const hits = page.map((row): SearchHit => {
      const text = String(row.text ?? "");
      const normalizedText = String(row.normalized_text ?? "");
      const normalizedConversationValues = stringArray(
        String(row.normalized_conversation_values),
        MAX_INDEX_RELATIONS_PER_MESSAGE,
        "indexed conversation-name",
      );
      const normalizedAttachmentValues = stringArray(
        String(row.normalized_attachment_values),
        MAX_INDEX_RELATIONS_PER_MESSAGE,
        "indexed attachment-filename",
      );
      const matchedScopes: SearchScope[] = [];
      if (input.scopes.includes("text") && normalizedScopeMatches(normalizedText, input.query, input.mode)) matchedScopes.push("text");
      if (
        input.scopes.includes("conversation_names") &&
        normalizedConversationValues.some((value) => normalizedScopeMatches(value, input.query, input.mode))
      ) {
        matchedScopes.push("conversation_names");
      }
      if (
        input.scopes.includes("attachment_filenames") &&
        normalizedAttachmentValues.some((value) => normalizedScopeMatches(value, input.query, input.mode))
      ) {
        matchedScopes.push("attachment_filenames");
      }
      const handle = Number(row.is_from_me) ? null : typeof row.handle === "string" ? row.handle : null;
      const chatIds = chatIdArray(String(row.chat_ids));
      const filenames = stringArray(String(row.filenames), MAX_INDEX_RELATIONS_PER_MESSAGE, "indexed filename");
      return {
        message_ref: encodeReference(this.context.referenceKey, this.context.lineage, "message", { rowid: Number(row.rowid), guid: row.guid }),
        conversation_ref: encodeReference(this.context.referenceKey, this.context.lineage, "conversation", { chat_ids: chatIds }),
        timestamp: appleTimestampToIso(row.date_token),
        service_family: serviceFamily(row.service),
        sender: { name: handle ? this.contacts.nameForHandle(handle) : "Me", handle },
        ...(text && matchedScopes.includes("text")
          ? { snippet: graphemeSnippet(text, snippetNeedle(normalizedText, input.query, input.mode)) }
          : {}),
        matched_scopes: matchedScopes,
        ...(input.scopes.includes("attachment_filenames") && filenames.length ? { attachment_filenames: filenames } : {}),
        ...(input.order === "relevance" ? { relevance: Number(row.relevance) } : {}),
        row_status: row.row_status === "partial" ? "partial" : "complete",
      };
    });
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? encodeReference(this.context.referenceKey, this.context.lineage, "page", {
          query_hash: hash,
          frozen,
          after_date: sqliteIntegerToken(last.date_token, "search cursor timestamp"),
          after_rowid: Number(last.rowid),
          after_rank: Number(last.relevance),
        })
      : null;
    const warnings = this.skipped
      ? [{ code: "DECODE_FAILED", message: "unsupported or undecodable message bodies were marked partial in search", skipped_count: this.skipped }]
      : [];
    return { hits, total, nextCursor, hasMore, asOf: watermarkToken(frozen), warnings };
  }

  close(): void {
    this.index?.close();
    this.index = null;
    this.indexedWatermark = null;
  }
}
