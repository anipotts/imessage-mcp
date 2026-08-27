import { createHash, createHmac } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DATABASE_PATH } from "./config.js";
import type { CapabilityState, QueryBudget, SchemaCapabilities, Watermark } from "./contracts.js";
import { ImessageMcpError } from "./errors.js";
import { appleTimestampSortSql, sqliteIntegerBinding, sqliteIntegerToken } from "./time.js";

const RELEVANT_TABLES = [
  "message",
  "chat",
  "handle",
  "chat_message_join",
  "chat_handle_join",
  "chat_lookup",
  "attachment",
  "message_attachment_join",
] as const;

const MAX_SCHEMA_COLUMNS_PER_TABLE = 512;
const MAX_SCHEMA_IDENTIFIER_BYTES = 512;
const MAX_SCHEMA_METADATA_BYTES = 256 * 1024;

type FileIdentity = { device: bigint; inode: bigint };

interface ResolvedRegularFile {
  canonicalPath: string;
  identity: FileIdentity;
}

function inspectRegularFile(filePath: string): ResolvedRegularFile | null {
  try {
    const canonicalPath = realpathSync(filePath);
    const stat = statSync(canonicalPath, { bigint: true });
    if (!stat.isFile()) return null;
    return { canonicalPath, identity: { device: stat.dev, inode: stat.ino } };
  } catch {
    return null;
  }
}

function resolveRequiredRegularFile(filePath: string): ResolvedRegularFile {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(filePath);
  } catch {
    throw new ImessageMcpError("DATABASE_UNAVAILABLE", "Messages database path could not be resolved");
  }
  try {
    const stat = statSync(canonicalPath, { bigint: true });
    if (!stat.isFile()) throw new Error("not a regular file");
    return { canonicalPath, identity: { device: stat.dev, inode: stat.ino } };
  } catch {
    throw new ImessageMcpError("DATABASE_UNAVAILABLE", "Messages database must resolve to a readable regular file");
  }
}

function isSameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function rejectLiveCopyAlias(): never {
  throw new ImessageMcpError(
    "INVALID_INPUT",
    "copied Messages data must not resolve to this Mac's live Messages database",
  );
}

function inspectCopiedWal(filePath: string): ResolvedRegularFile | null {
  try {
    const stat = lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ImessageMcpError("INVALID_INPUT", "copied Messages database sidecars must be regular files");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ImessageMcpError) throw error;
    throw new ImessageMcpError("DATABASE_UNAVAILABLE", "copied Messages database sidecars could not be inspected safely");
  }
  const inspected = inspectRegularFile(filePath);
  if (inspected === null) {
    throw new ImessageMcpError("DATABASE_UNAVAILABLE", "copied Messages database sidecars could not be inspected safely");
  }
  return inspected;
}

function assertCopiedSourceBoundary(
  canonicalPath: string,
  identity: FileIdentity,
  sourceMode: "live" | "copy",
  liveDatabasePath: string,
): void {
  if (sourceMode !== "copy") return;

  const liveLexicalPath = path.resolve(liveDatabasePath);
  const liveDatabase = inspectRegularFile(liveLexicalPath);
  if (
    canonicalPath === liveLexicalPath ||
    (liveDatabase !== null && (
      canonicalPath === liveDatabase.canonicalPath ||
      isSameFile(identity, liveDatabase.identity)
    ))
  ) {
    rejectLiveCopyAlias();
  }

  const copiedWal = inspectCopiedWal(`${canonicalPath}-wal`);
  if (copiedWal === null) return;

  const liveWalPaths = new Set([
    `${liveLexicalPath}-wal`,
    `${liveDatabase?.canonicalPath ?? liveLexicalPath}-wal`,
  ]);
  for (const liveWalPath of liveWalPaths) {
    const liveWal = inspectRegularFile(liveWalPath);
    if (
      copiedWal.canonicalPath === path.resolve(liveWalPath) ||
      (liveWal !== null && isSameFile(copiedWal.identity, liveWal.identity))
    ) {
      rejectLiveCopyAlias();
    }
  }
}

export function assertCopiedDatabaseSourceBoundary(databasePath: string, liveDatabasePath: string): void {
  const selected = resolveRequiredRegularFile(databasePath);
  assertCopiedSourceBoundary(selected.canonicalPath, selected.identity, "copy", liveDatabasePath);
}

const REQUIRED: Record<string, string[]> = {
  message: ["ROWID", "guid", "handle_id", "date", "is_from_me"],
  chat: ["ROWID", "guid"],
  handle: ["ROWID", "id"],
  chat_message_join: ["chat_id", "message_id"],
  chat_handle_join: ["chat_id", "handle_id"],
};

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function state(condition: boolean): CapabilityState {
  return condition ? "available" : "unavailable";
}

function columnsFor(
  db: Database.Database,
  table: string,
  budget: { bytes: number },
): string[] {
  const columns: string[] = [];
  const rows = db.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).iterate() as Iterable<{ name: unknown }>;
  for (const row of rows) {
    if (columns.length >= MAX_SCHEMA_COLUMNS_PER_TABLE) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "Messages schema exceeds the bounded column count");
    }
    if (typeof row.name !== "string") {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "Messages schema contains an invalid column name");
    }
    const bytes = Buffer.byteLength(row.name, "utf8");
    if (bytes === 0 || bytes > MAX_SCHEMA_IDENTIFIER_BYTES) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "Messages schema contains an oversized column name");
    }
    budget.bytes += bytes;
    if (budget.bytes > MAX_SCHEMA_METADATA_BYTES) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "Messages schema metadata exceeds its byte budget");
    }
    columns.push(row.name);
  }
  return columns;
}

function fingerprint(tables: Record<string, string[]>): string {
  const canonical = Object.entries(tables)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, columns]) => `${table}:${[...columns].sort().join(",")}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function inspectSchema(db: Database.Database): SchemaCapabilities {
  const names = RELEVANT_TABLES.map(() => "?").join(",");
  const present = new Set((db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names}) ORDER BY name
     LIMIT ${RELEVANT_TABLES.length + 1}`,
  ).all(...RELEVANT_TABLES) as Array<{ name: string }>).map((row) => row.name));
  const budget = { bytes: 0 };
  const tables: Record<string, string[]> = {};
  for (const table of RELEVANT_TABLES) {
    if (present.has(table)) tables[table] = columnsFor(db, table, budget);
  }
  const has = (table: string, column: string) => tables[table]?.includes(column) ?? false;
  const requiredCore = Object.entries(REQUIRED).every(([table, columns]) =>
    columns.every((column) => has(table, column)),
  );

  return {
    schema_fingerprint: fingerprint(tables),
    required_core: state(requiredCore),
    chat_lookup: state(
      has("chat_lookup", "identifier") && has("chat_lookup", "domain") && has("chat_lookup", "chat"),
    ),
    attributed_body: state(has("message", "attributedBody")),
    edits: state(has("message", "date_edited")),
    retractions: state(has("message", "date_retracted")),
    reactions: state(has("message", "associated_message_type") && has("message", "associated_message_guid")),
    receipts: state(
      has("message", "date_read") || has("message", "date_delivered") ||
      has("message", "is_read") || has("message", "is_delivered"),
    ),
    receipt_changes: state(has("message", "date_read") || has("message", "date_delivered")),
    replies: state(has("message", "reply_to_guid") || has("message", "thread_originator_guid")),
    attachments: state(
      has("attachment", "ROWID") &&
        has("message_attachment_join", "message_id") &&
        has("message_attachment_join", "attachment_id"),
    ),
    group_events: state(has("message", "item_type") && has("message", "group_action_type")),
    rcs: has("message", "service") || has("chat", "service_name") ? "unknown" : "unavailable",
    tables,
  };
}

export function openReadonlyDatabase(databasePath: string): Database.Database {
  if (!existsSync(databasePath)) {
    throw new ImessageMcpError("DATABASE_UNAVAILABLE", "Messages database was not found");
  }
  try {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 5000");
    return db;
  } catch (error) {
    throw new ImessageMcpError("DATABASE_UNAVAILABLE", "Messages database could not be opened read-only", {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
}

function scalarIntegerToken(db: Database.Database, sql: string, label: string): string {
  const row = db.prepare(sql).get() as { value?: unknown } | undefined;
  return sqliteIntegerToken(row?.value ?? "0", label);
}

function watermark(db: Database.Database, capabilities: SchemaCapabilities): Watermark {
  const messageColumns = capabilities.tables.message ?? [];
  const joinColumns = capabilities.tables.chat_message_join ?? [];
  const receiptColumns = ["date_read", "date_delivered"].filter((column) => messageColumns.includes(column));
  const receiptExpression = receiptColumns.length
    ? receiptColumns.length === 1
      ? appleTimestampSortSql(quotedIdentifier(receiptColumns[0]))
      : `MAX(${receiptColumns.map((column) => appleTimestampSortSql(quotedIdentifier(column))).join(", ")})`
    : "0";
  const message = db.prepare(
    `SELECT
       COALESCE(MAX(ROWID), 0) AS max_message_id,
       ${capabilities.edits === "available"
         ? `CAST(COALESCE(MAX(${appleTimestampSortSql("date_edited")}), 0) AS TEXT)`
         : "'0'"} AS max_edited_at,
       ${capabilities.retractions === "available"
         ? `CAST(COALESCE(MAX(${appleTimestampSortSql("date_retracted")}), 0) AS TEXT)`
         : "'0'"} AS max_retracted_at,
       ${receiptColumns.length
         ? `CAST(COALESCE(MAX(${receiptExpression}), 0) AS TEXT)`
         : "'0'"} AS max_receipt_at
     FROM message`,
  ).get() as {
    max_message_id: unknown;
    max_edited_at: unknown;
    max_retracted_at: unknown;
    max_receipt_at: unknown;
  } | undefined;
  const maxMessageId = Number(message?.max_message_id);
  if (!Number.isSafeInteger(maxMessageId) || maxMessageId < 0) {
    throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "message ROWID exceeds the supported exact integer range");
  }
  return {
    data_version: Number(db.pragma("data_version", { simple: true })) || 0,
    max_message_id: maxMessageId,
    max_chat_message_date: joinColumns.includes("message_date")
      ? scalarIntegerToken(
          db,
          `SELECT CAST(COALESCE(MAX(${appleTimestampSortSql("message_date")}), 0) AS TEXT) AS value FROM chat_message_join`,
          "chat message timestamp",
        )
      : "0",
    max_edited_at: sqliteIntegerToken(message?.max_edited_at ?? "0", "edit timestamp"),
    max_retracted_at: sqliteIntegerToken(message?.max_retracted_at ?? "0", "retraction timestamp"),
    max_receipt_at: sqliteIntegerToken(message?.max_receipt_at ?? "0", "receipt timestamp"),
  };
}

function computeLineage(
  referenceKey: Buffer,
  databaseId: Buffer,
): string {
  const hmac = createHmac("sha256", referenceKey)
    .update("imessage-mcp:v2:database-lineage:v3\0")
    .update(String(databaseId.length))
    .update("\0")
    .update(databaseId);
  return hmac.digest("hex");
}

export class DatabaseRequest {
  readonly db: Database.Database;
  readonly capabilities: SchemaCapabilities;
  readonly lineage: string;
  readonly referenceKey: Buffer;
  readonly asOf: Watermark;
  private readonly ownsDatabase: boolean;
  private closed = false;

  constructor(
    source: string | Database.Database,
    referenceKey: Buffer,
    databaseId: Buffer,
    knownCapabilities?: SchemaCapabilities,
    observedDataVersion?: number,
    knownWatermark?: Watermark,
  ) {
    this.ownsDatabase = typeof source === "string";
    this.db = this.ownsDatabase ? openReadonlyDatabase(source as string) : source as Database.Database;
    this.referenceKey = Buffer.from(referenceKey);
    try {
      if (this.db.inTransaction) {
        throw new ImessageMcpError("DATABASE_CHANGED", "database request connection retained an unexpected transaction");
      }
      this.db.exec("BEGIN DEFERRED TRANSACTION");
      this.capabilities = knownCapabilities ?? inspectSchema(this.db);
      if (this.capabilities.required_core !== "available") {
        throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "Messages database is missing required Mac chat.db tables or columns");
      }
      // BEGIN DEFERRED does not establish SQLite's read snapshot. The cached
      // capabilities/watermark path otherwise performs no read before the
      // observer data_version check in DatabaseContext.request(), leaving a
      // commit window in which newer rows could be labeled with an older
      // watermark. This bounded read pins the query connection's snapshot
      // before that observer comparison.
      this.db.prepare("SELECT ROWID FROM message ORDER BY ROWID LIMIT 1").get();
      this.lineage = computeLineage(this.referenceKey, databaseId);
      this.asOf = knownWatermark
        ? { ...knownWatermark, data_version: observedDataVersion ?? knownWatermark.data_version }
        : watermark(this.db, this.capabilities);
      if (!knownWatermark && observedDataVersion !== undefined) this.asOf.data_version = observedDataVersion;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  guard(budget: QueryBudget, rows = 0): void {
    budget.rows_seen += rows;
    if (Date.now() > budget.deadline_ms || budget.rows_seen > budget.max_rows) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "query exceeded its bounded runtime or row budget");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
    } finally {
      if (this.ownsDatabase) this.db.close();
    }
  }
}

export class DatabaseContext {
  readonly canonicalPath: string;
  readonly capabilities: SchemaCapabilities;
  readonly lineage: string;
  readonly referenceKey: Buffer;
  readonly sourceMode: "live" | "copy";
  private readonly databaseId: Buffer;
  private readonly fileIdentity: { device: bigint; inode: bigint };
  private readonly schemaVersion: number;
  private readonly observer: Database.Database;
  private readonly queryConnection: Database.Database;
  private cachedWatermark: Watermark;
  private closed = false;

  constructor(
    databasePath: string,
    referenceKey: Buffer,
    databaseId: Buffer,
    sourceMode: "live" | "copy" = "copy",
  ) {
    if (referenceKey.length < 32 || referenceKey.length > 4096) {
      throw new ImessageMcpError("INVALID_INPUT", "opaque-reference key must contain between 32 and 4096 bytes");
    }
    if (databaseId.length < 32 || databaseId.length > 4096) {
      throw new ImessageMcpError("INVALID_INPUT", "database-lineage identity must contain between 32 and 4096 bytes");
    }
    if (referenceKey.equals(databaseId)) {
      throw new ImessageMcpError(
        "INVALID_INPUT",
        "opaque-reference key and database-lineage identity must be generated independently",
      );
    }
    this.referenceKey = Buffer.from(referenceKey);
    this.databaseId = Buffer.from(databaseId);
    this.sourceMode = sourceMode;
    const selected = resolveRequiredRegularFile(databasePath);
    this.canonicalPath = selected.canonicalPath;
    this.fileIdentity = selected.identity;
    assertCopiedSourceBoundary(this.canonicalPath, this.fileIdentity, sourceMode, DEFAULT_DATABASE_PATH);
    const observer = openReadonlyDatabase(this.canonicalPath);
    let queryConnection: Database.Database;
    try {
      queryConnection = openReadonlyDatabase(this.canonicalPath);
    } catch (error) {
      observer.close();
      throw error;
    }
    this.observer = observer;
    this.queryConnection = queryConnection;
    this.schemaVersion = this.observedSchemaVersion();
    let request: DatabaseRequest;
    try {
      const dataVersion = this.observedDataVersion();
      request = new DatabaseRequest(this.queryConnection, this.referenceKey, this.databaseId, undefined, dataVersion);
      this.assertFileIdentity();
      this.assertSchemaVersion();
      if (this.observedDataVersion() !== dataVersion) {
        throw new ImessageMcpError("DATABASE_CHANGED", "database changed while the server was establishing its read snapshot");
      }
    } catch (error) {
      this.queryConnection.close();
      this.observer.close();
      throw error;
    }
    try {
      this.capabilities = request.capabilities;
      this.lineage = request.lineage;
      this.cachedWatermark = { ...request.asOf };
    } finally {
      request.close();
    }
  }

  request(): DatabaseRequest {
    if (this.closed) throw new ImessageMcpError("DATABASE_UNAVAILABLE", "database context is closed");
    this.assertFileIdentity();
    this.assertSchemaVersion();
    const dataVersion = this.observedDataVersion();
    const knownWatermark = dataVersion === this.cachedWatermark.data_version
      ? this.cachedWatermark
      : undefined;
    const request = new DatabaseRequest(
      this.queryConnection,
      this.referenceKey,
      this.databaseId,
      this.capabilities,
      dataVersion,
      knownWatermark,
    );
    try {
      this.assertFileIdentity();
      this.assertSchemaVersion();
      if (this.observedDataVersion() !== dataVersion) {
        throw new ImessageMcpError("DATABASE_CHANGED", "database changed while the server was establishing its read snapshot");
      }
    } catch (error) {
      request.close();
      throw error;
    }
    if (request.lineage !== this.lineage) {
      request.close();
      throw new ImessageMcpError("DATABASE_CHANGED", "database lineage changed while the server was running");
    }
    if (!knownWatermark) this.cachedWatermark = { ...request.asOf };
    return request;
  }

  currentWatermark(): Watermark {
    const request = this.request();
    try {
      return request.asOf;
    } finally {
      request.close();
    }
  }

  assertObservedDataVersion(expected: number): void {
    this.assertFileIdentity();
    if (this.observedDataVersion() !== expected) {
      throw new ImessageMcpError("DATABASE_CHANGED", "database changed while a read snapshot was being verified");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queryConnection.close();
    this.observer.close();
  }

  private observedDataVersion(): number {
    return Number(this.observer.pragma("data_version", { simple: true })) || 0;
  }

  private observedSchemaVersion(): number {
    const value = Number(this.observer.pragma("schema_version", { simple: true }));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ImessageMcpError("UNSUPPORTED_SCHEMA", "Messages schema version is invalid");
    }
    return value;
  }

  private assertSchemaVersion(): void {
    if (this.observedSchemaVersion() !== this.schemaVersion) {
      throw new ImessageMcpError("DATABASE_CHANGED", "database schema changed while the server was running");
    }
  }

  private readFileIdentity(reason: "DATABASE_UNAVAILABLE" | "DATABASE_CHANGED"): { device: bigint; inode: bigint } {
    try {
      const stat = statSync(this.canonicalPath, { bigint: true });
      if (!stat.isFile()) throw new Error("not a regular file");
      return { device: stat.dev, inode: stat.ino };
    } catch {
      throw new ImessageMcpError(reason, reason === "DATABASE_CHANGED"
        ? "database file identity changed while the server was running"
        : "Messages database must resolve to a readable regular file");
    }
  }

  private assertFileIdentity(): void {
    const current = this.readFileIdentity("DATABASE_CHANGED");
    if (current.device !== this.fileIdentity.device || current.inode !== this.fileIdentity.inode) {
      throw new ImessageMcpError("DATABASE_CHANGED", "database file identity changed while the server was running");
    }
  }
}

export function watermarkToken(value: Watermark): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function parseWatermark(value: unknown): Watermark {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImessageMcpError("INVALID_INPUT", "cursor contains a malformed database watermark");
  }
  const candidate = value as Partial<Watermark>;
  if (
    !Number.isSafeInteger(candidate.data_version) || Number(candidate.data_version) < 0 ||
    !Number.isSafeInteger(candidate.max_message_id) || Number(candidate.max_message_id) < 0
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "cursor contains a malformed database watermark");
  }
  try {
    const tokens = [
      candidate.max_chat_message_date,
      candidate.max_edited_at,
      candidate.max_retracted_at,
      candidate.max_receipt_at,
    ];
    if (tokens.some((token) => typeof token !== "string" || sqliteIntegerToken(token) !== token || sqliteIntegerBinding(token) < 0n)) {
      throw new Error("invalid watermark token");
    }
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", "cursor contains a malformed database watermark");
  }
  return candidate as Watermark;
}

export function assertFrozenTraversal(frozen: Watermark, current: Watermark): void {
  if (
    current.data_version !== frozen.data_version ||
    current.max_message_id !== frozen.max_message_id ||
    current.max_chat_message_date !== frozen.max_chat_message_date ||
    current.max_edited_at !== frozen.max_edited_at ||
    current.max_retracted_at !== frozen.max_retracted_at ||
    current.max_receipt_at !== frozen.max_receipt_at
  ) {
    throw new ImessageMcpError("DATABASE_CHANGED", "database changed in a way that cannot preserve this traversal");
  }
}
