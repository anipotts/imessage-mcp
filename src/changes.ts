// The change log behind sync_messages. The search index keeps one small state
// row per message ROWID; whenever a refresh re-indexes a bucket, the old and
// new states are compared and every difference becomes a numbered change.
// chat.db has no history of its own, so this is the only exact record of
// edits, unsends, deletions, reactions and receipts between two reads.

import { createHash, randomBytes } from "node:crypto";
import type { ServiceFamily } from "./contracts.js";
import { serviceFamily } from "./contracts.js";
import type { UnifiedContactResolver } from "./contacts.js";
import type { DatabaseRequest } from "./database.js";
import type { MessageTextDecoder } from "./decoder.js";
import { populatedMessageText } from "./decoder.js";
import { ImessageMcpError } from "./errors.js";
import { canonicalChatMap } from "./repositories/conversations.js";
import { normalizeReactionParent } from "./repositories/messages.js";
import { columnSql } from "./schema-sql.js";
import { validateSender } from "./sender.js";
import type Database from "./sqlite.js";
import { appleTimestampToIso, sqliteIntegerIsPositive } from "./time.js";

export type ChangeType =
  | "message_created"
  | "message_edited"
  | "message_retracted"
  | "message_deleted"
  | "reaction_added"
  | "reaction_removed"
  | "receipt_changed"
  | "group_event";

export interface RowState {
  rowid: number;
  guid: string;
  chat_id: number | null;
  kind: "message" | "reaction" | "system";
  parent_guid: string | null;
  reaction_type: number;
  content: string;
  date: string;
  date_edited: string;
  date_retracted: string;
  receipt: string;
}

export interface ChangeRow {
  type: ChangeType;
  rowid: number;
  guid: string;
  chat_id: number | null;
  parent_guid: string | null;
  reaction_type: number;
  changed_at: string;
}

// Oldest changes are dropped past this count; a cursor older than the oldest
// retained change is rejected so a client never silently misses changes.
export const MAX_RETAINED_CHANGES = 200_000;

export const CHANGE_LOG_SQL = `
  CREATE TABLE row_state (
    rowid INTEGER PRIMARY KEY, guid TEXT NOT NULL, chat_id INTEGER, kind TEXT NOT NULL, parent_guid TEXT,
    reaction_type INTEGER NOT NULL, content TEXT NOT NULL, date TEXT NOT NULL, date_edited TEXT NOT NULL,
    date_retracted TEXT NOT NULL, receipt TEXT NOT NULL
  );
  CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, rowid INTEGER NOT NULL, guid TEXT NOT NULL,
    chat_id INTEGER, parent_guid TEXT, reaction_type INTEGER NOT NULL, changed_at TEXT NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function newLogId(): string {
  return randomBytes(12).toString("base64url");
}

function contentHash(text: unknown, body: unknown): string {
  const hash = createHash("sha1");
  hash.update(typeof text === "string" ? `s${Buffer.byteLength(text, "utf8")}:` : "n:");
  if (typeof text === "string") hash.update(text);
  if (Buffer.isBuffer(body)) {
    hash.update(`b${body.length}:`);
    hash.update(body);
  } else {
    hash.update("n");
  }
  return hash.digest("base64url").slice(0, 22);
}

// Reads the state of every message row with after < ROWID <= target.
export function readRowStates(request: DatabaseRequest, after: number, target: number): RowState[] {
  const column = (name: string, fallback = "NULL") => columnSql(request, "message", "m", name, fallback);
  const rows = request.db.prepare(
    `SELECT m.ROWID AS rowid, m.guid AS guid,
            (SELECT MIN(j.chat_id) FROM chat_message_join j WHERE j.message_id = m.ROWID) AS chat_id,
            COALESCE(${column("associated_message_type", "0")}, 0) AS associated_type,
            ${column("associated_message_guid")} AS associated_guid,
            COALESCE(${column("item_type", "0")}, 0) AS item_type,
            COALESCE(${column("is_system_message", "0")}, 0) AS is_system,
            CAST(COALESCE(m.date, 0) AS TEXT) AS date,
            CAST(COALESCE(${column("date_edited", "0")}, 0) AS TEXT) AS date_edited,
            CAST(COALESCE(${column("date_retracted", "0")}, 0) AS TEXT) AS date_retracted,
            COALESCE(${column("is_delivered", "0")}, 0) || ':' || CAST(COALESCE(${column("date_delivered", "0")}, 0) AS TEXT) || ':' ||
              COALESCE(${column("is_read", "0")}, 0) || ':' || CAST(COALESCE(${column("date_read", "0")}, 0) AS TEXT) AS receipt,
            ${column("text")} AS text, ${column("attributedBody")} AS body
     FROM message m
     WHERE m.ROWID > ? AND m.ROWID <= ?
     ORDER BY m.ROWID`,
  ).all(after, target) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const associated = Number(row.associated_type) || 0;
    const reaction = associated >= 2000 && associated < 4000;
    const system = !reaction && (Number(row.item_type) !== 0 || Number(row.is_system) !== 0);
    return {
      rowid: Number(row.rowid),
      guid: String(row.guid),
      chat_id: row.chat_id === null || row.chat_id === undefined ? null : Number(row.chat_id),
      kind: reaction ? "reaction" : system ? "system" : "message",
      parent_guid: reaction && typeof row.associated_guid === "string" ? normalizeReactionParent(row.associated_guid) : null,
      reaction_type: reaction ? associated : 0,
      content: contentHash(row.text, row.body),
      date: String(row.date),
      date_edited: String(row.date_edited),
      date_retracted: String(row.date_retracted),
      receipt: String(row.receipt),
    };
  });
}

function change(type: ChangeType, state: RowState, changedAt: string): ChangeRow {
  return {
    type,
    rowid: state.rowid,
    guid: state.guid,
    chat_id: state.chat_id,
    parent_guid: state.parent_guid,
    reaction_type: state.reaction_type,
    changed_at: changedAt,
  };
}

function created(state: RowState): ChangeRow | null {
  if (state.kind === "message") return change("message_created", state, state.date);
  if (state.kind === "system") return change("group_event", state, state.date);
  return change(state.reaction_type >= 3000 ? "reaction_removed" : "reaction_added", state, state.date);
}

function removed(state: RowState): ChangeRow | null {
  if (state.kind === "message") return change("message_deleted", state, state.date);
  if (state.kind === "reaction" && state.reaction_type < 3000) return change("reaction_removed", state, state.date);
  return null;
}

function newest(...tokens: string[]): string {
  return tokens.reduce((best, token) => (BigInt(token) > BigInt(best) ? token : best), "0");
}

// Compares the states of one ROWID range before and after a refresh.
export function diffRowStates(before: RowState[], after: RowState[]): ChangeRow[] {
  const old = new Map(before.map((state) => [state.rowid, state]));
  const next = new Map(after.map((state) => [state.rowid, state]));
  const rowids = [...new Set([...old.keys(), ...next.keys()])].sort((a, b) => a - b);
  const changes: ChangeRow[] = [];
  const push = (row: ChangeRow | null) => {
    if (row) changes.push(row);
  };
  for (const rowid of rowids) {
    const a = old.get(rowid);
    const b = next.get(rowid);
    if (!a && b) {
      push(created(b));
    } else if (a && !b) {
      push(removed(a));
    } else if (a && b && a.guid !== b.guid) {
      push(removed(a));
      push(created(b));
    } else if (a && b && b.kind === "message") {
      if (!sqliteIntegerIsPositive(a.date_retracted) && sqliteIntegerIsPositive(b.date_retracted)) {
        push(change("message_retracted", b, b.date_retracted));
      } else if (a.content !== b.content || a.date_edited !== b.date_edited) {
        push(change("message_edited", b, sqliteIntegerIsPositive(b.date_edited) ? b.date_edited : b.date));
      }
      if (a.receipt !== b.receipt) {
        const [, delivered = "0", , read = "0"] = b.receipt.split(":");
        push(change("receipt_changed", b, newest(delivered, read)));
      }
    }
  }
  return changes;
}

export function writeRowStates(index: Database, states: RowState[]): void {
  const insert = index.prepare(
    `INSERT INTO row_state(rowid, guid, chat_id, kind, parent_guid, reaction_type, content, date, date_edited, date_retracted, receipt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const state of states) {
    insert.run(state.rowid, state.guid, state.chat_id, state.kind, state.parent_guid, state.reaction_type, state.content,
      state.date, state.date_edited, state.date_retracted, state.receipt);
  }
}

export function storedRowStates(index: Database, first: number, last: number): RowState[] {
  return index.prepare("SELECT * FROM row_state WHERE rowid BETWEEN ? AND ? ORDER BY rowid").all(first, last) as RowState[];
}

export function recordChanges(index: Database, changes: ChangeRow[]): void {
  if (changes.length === 0) return;
  const insert = index.prepare(
    "INSERT INTO changes(type, rowid, guid, chat_id, parent_guid, reaction_type, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of changes) insert.run(row.type, row.rowid, row.guid, row.chat_id, row.parent_guid, row.reaction_type, row.changed_at);
  const latest = Number((index.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number }).seq);
  index.prepare("DELETE FROM changes WHERE seq <= ?").run(latest - MAX_RETAINED_CHANGES);
}

export function metaValue(index: Database, key: string): string | null {
  const row = index.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetaValue(index: Database, key: string, value: string): void {
  index.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export interface SyncChange {
  seq: number;
  change_type: ChangeType;
  changed_at: string | null;
  message_id?: number;
  parent_message_id?: number;
  chat_id?: number;
  service_family: ServiceFamily;
  direction?: "incoming" | "outgoing" | "system";
  sender?: { name: string | null; handle: string | null };
  text?: string;
  reaction?: { type: string };
  receipt?: { state: "sent" | "delivered" | "read"; delivered_at: string | null; read_at: string | null };
  row_status: "complete" | "partial";
}

const REACTION_NAMES: Record<number, string> = { 0: "love", 1: "like", 2: "dislike", 3: "laugh", 4: "emphasize", 5: "question", 6: "emoji", 7: "sticker" };

// Turns logged changes into tool output, reading each message's current row.
export async function materializeChanges(input: {
  request: DatabaseRequest;
  contacts: UnifiedContactResolver;
  decoder: MessageTextDecoder;
  rows: Array<ChangeRow & { seq: number }>;
}): Promise<SyncChange[]> {
  const { request } = input;
  const canonical = canonicalChatMap(request);
  const column = (name: string, fallback = "NULL") => columnSql(request, "message", "m", name, fallback);
  const current = request.db.prepare(
    `SELECT m.ROWID AS rowid, m.guid AS guid, m.is_from_me AS is_from_me, m.handle_id AS handle_id, h.id AS handle,
            ${column("service")} AS service, ${column("text")} AS text, ${column("attributedBody")} AS body,
            CAST(COALESCE(${column("date_read", "0")}, 0) AS TEXT) AS date_read,
            CAST(COALESCE(${column("date_delivered", "0")}, 0) AS TEXT) AS date_delivered,
            COALESCE(${column("is_read", "0")}, 0) AS is_read, COALESCE(${column("is_delivered", "0")}, 0) AS is_delivered
     FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.ROWID = ?`,
  );
  const byGuid = request.db.prepare("SELECT ROWID AS rowid FROM message WHERE guid = ? LIMIT 2");
  const out: SyncChange[] = [];
  for (const row of input.rows) {
    const live = current.get(row.rowid) as Record<string, unknown> | undefined;
    const present = live && live.guid === row.guid ? live : undefined;
    const chatId = row.chat_id === null ? undefined : canonical.get(row.chat_id) ?? row.chat_id;
    const base: SyncChange = {
      seq: row.seq,
      change_type: row.type,
      changed_at: appleTimestampToIso(row.changed_at),
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      service_family: serviceFamily(present?.service),
      row_status: "complete",
    };
    if (row.type === "reaction_added" || row.type === "reaction_removed") {
      const parents = row.parent_guid ? byGuid.all(row.parent_guid) as Array<{ rowid: number }> : [];
      if (parents.length === 1) base.parent_message_id = parents[0].rowid;
      else base.row_status = "partial";
      base.reaction = { type: REACTION_NAMES[row.reaction_type % 1000] ?? "unknown" };
    } else if (row.type !== "group_event") {
      base.message_id = row.rowid;
    }
    if (present) {
      const sender = validateSender({ is_from_me: present.is_from_me, handle_id: present.handle_id, handle: present.handle }, input.contacts);
      base.direction = row.type === "group_event" ? "system" : sender.direction;
      base.sender = sender.identity;
      if (!sender.complete && row.type !== "group_event") base.row_status = "partial";
      if (row.type === "message_created" || row.type === "message_edited") {
        const native = populatedMessageText(present.text);
        if (native !== null) {
          base.text = native;
        } else if (Buffer.isBuffer(present.body)) {
          const [decoded] = await input.decoder.decode([present.body]);
          if (decoded?.status === "decoded") base.text = decoded.text;
          else base.row_status = "partial";
        }
      }
      if (row.type === "receipt_changed") {
        const read = sqliteIntegerIsPositive(String(present.date_read)) || Number(present.is_read) === 1;
        const delivered = sqliteIntegerIsPositive(String(present.date_delivered)) || Number(present.is_delivered) === 1;
        base.receipt = {
          state: read ? "read" : delivered ? "delivered" : "sent",
          delivered_at: appleTimestampToIso(String(present.date_delivered)),
          read_at: appleTimestampToIso(String(present.date_read)),
        };
      }
    } else if (row.type !== "message_deleted" && row.type !== "reaction_removed") {
      base.row_status = "partial";
    }
    out.push(base);
  }
  return out;
}

export function assertCursorLog(cursor: Record<string, unknown>, logId: string, databaseId: string, oldestSeq: number): number {
  if (cursor.v !== 3 || typeof cursor.log !== "string" || typeof cursor.db !== "string" || !Number.isSafeInteger(cursor.seq) || Number(cursor.seq) < 0) {
    throw new ImessageMcpError("INVALID_INPUT", "sync cursor is malformed; call sync_messages without a cursor to start again");
  }
  if (cursor.db !== databaseId) {
    throw new ImessageMcpError("DATABASE_CHANGED", "sync cursor belongs to a different Messages archive; call sync_messages without a cursor");
  }
  if (cursor.log !== logId || Number(cursor.seq) < oldestSeq - 1) {
    throw new ImessageMcpError("DATABASE_CHANGED", "the change history this cursor continues from was rebuilt or trimmed; call sync_messages without a cursor");
  }
  return Number(cursor.seq);
}
