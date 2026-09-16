#!/usr/bin/env node
// Builds a small, entirely fictional Messages database for recording the
// README demo. Every name, number, and message body here is invented for
// this script; none of it is real Messages data. Schema matches the real
// chat.db closely enough for the server to read it as a live-shaped copy.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APPLE_EPOCH_MS = Date.parse("2001-01-01T00:00:00Z");
const ns = (iso) => (Date.parse(iso) - APPLE_EPOCH_MS) * 1_000_000;

export function buildDemoDatabase(directory = mkdtempSync(path.join(tmpdir(), "imessage-mcp-demo-"))) {
  const databasePath = path.join(directory, "chat.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT, country TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, style INTEGER DEFAULT 45, state INTEGER DEFAULT 0,
      chat_identifier TEXT, service_name TEXT, display_name TEXT, group_id TEXT
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, index_state INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id, message_id));
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_lookup (identifier TEXT NOT NULL, domain TEXT NOT NULL, chat INTEGER NOT NULL, priority INTEGER DEFAULT 0);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT, attributedBody BLOB, handle_id INTEGER,
      date INTEGER DEFAULT 0, date_read INTEGER DEFAULT 0, date_delivered INTEGER DEFAULT 0,
      is_delivered INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
      is_system_message INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT,
      group_action_type INTEGER DEFAULT 0, associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0, associated_message_emoji TEXT,
      reply_to_guid TEXT, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0,
      message_summary_info BLOB, service TEXT DEFAULT 'iMessage'
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, transfer_name TEXT, mime_type TEXT, total_bytes INTEGER
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    CREATE INDEX chat_message_join_message ON chat_message_join(message_id);
  `);

  db.exec(`
    INSERT INTO handle(ROWID, id) VALUES
      (1, '+15555010142'), (2, '+15555010188'), (3, '+15555010199'), (4, '+15555010160');
    INSERT INTO chat(ROWID, guid, chat_identifier, service_name, display_name, group_id) VALUES
      (1, 'demo-chat-jordan', '+15555010142', 'iMessage', NULL, NULL),
      (2, 'demo-chat-group',  'demo-group',   'iMessage', 'Book Club', 'demo-group-1');
    INSERT INTO chat_handle_join(chat_id, handle_id) VALUES
      (1, 1), (2, 1), (2, 2), (2, 3);
  `);

  const insert = db.prepare(`INSERT INTO message(
    ROWID, guid, text, handle_id, date, date_read, date_delivered, is_delivered, is_from_me, is_read,
    associated_message_guid, associated_message_type, reply_to_guid, date_edited, service
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const join = db.prepare("INSERT INTO chat_message_join(chat_id, message_id, message_date) VALUES (?, ?, ?)");

  const rows = [
    { chat: 1, rowid: 1, guid: "d1", text: "hey are we still on for the dinner reservation Friday?", handle: 1, at: "2026-09-10T18:02:00Z" },
    { chat: 1, rowid: 2, guid: "d2", text: "yeah! 7pm at the place on 4th, table's under your name", from_me: true, at: "2026-09-10T18:04:00Z" },
    { chat: 1, rowid: 3, guid: "d3", text: "perfect, see you there", handle: 1, at: "2026-09-10T18:05:00Z", read: true, delivered: true },
    { chat: 1, rowid: 4, guid: "r1", handle: 1, at: "2026-09-10T18:05:30Z", tapback: { on: "d3", type: 2000 } },
    { chat: 2, rowid: 5, guid: "d4", text: "so did anyone actually finish the book this month", handle: 2, at: "2026-09-12T20:10:00Z" },
    { chat: 2, rowid: 6, guid: "d5", text: "halfway through, work's been brutal", handle: 3, at: "2026-09-12T20:11:00Z" },
    { chat: 2, rowid: 7, guid: "d6", text: "same, can we push to next Sunday", from_me: true, at: "2026-09-12T20:12:00Z" },
    { chat: 2, rowid: 8, guid: "d7", text: "next Sunday works for me too", handle: 2, at: "2026-09-12T20:13:00Z", editedAt: "2026-09-12T20:14:00Z" },
  ];

  const tx = db.exec.bind(db);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      insert.run(
        row.rowid, row.guid, row.text ?? null, row.handle ?? null, ns(row.at),
        row.read ? ns(row.at) : 0, row.delivered ? ns(row.at) : 0, row.delivered ? 1 : 0,
        row.from_me ? 1 : 0, row.read ? 1 : 0,
        row.tapback ? row.tapback.on : null, row.tapback ? row.tapback.type : 0,
        null, row.editedAt ? ns(row.editedAt) : 0, "iMessage",
      );
      join.run(row.chat, row.rowid, ns(row.at));
    }
  } finally {
    db.exec("COMMIT");
  }
  db.close();
  return databasePath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${buildDemoDatabase(process.argv[2])}\n`);
}
