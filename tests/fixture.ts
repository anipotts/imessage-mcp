import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { APPLE_EPOCH_UNIX_SECONDS } from "../src/time.js";

export interface Fixture {
  directory: string;
  databasePath: string;
  cleanup(): void;
}

export function appleNanoseconds(iso: string): number {
  return Math.floor((Date.parse(iso) / 1000 - APPLE_EPOCH_UNIX_SECONDS) * 1_000_000_000);
}

export function foundationAttributedBody(text: string): Buffer {
  const script = `ObjC.import("Foundation"); function run(argv) {
    const object = $.NSMutableAttributedString.alloc.init;
    object.mutableString.appendString($(argv[0]));
    const data = $.NSArchiver.archivedDataWithRootObject(object);
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  }`;
  return Buffer.from(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, text], { encoding: "utf8" }).trim(), "base64");
}

export function foundationAttributedBodyWithRuns(text: string): Buffer {
  const script = `ObjC.import("Foundation"); function run(argv) {
    const object = $.NSMutableAttributedString.alloc.init;
    object.mutableString.appendString($(argv[0]));
    const firstRun = Math.max(1, Math.floor(String(argv[0]).length / 2));
    object.addAttributeValueRange($("SyntheticAttribute"), $("value"), $.NSMakeRange(0, firstRun));
    const data = $.NSArchiver.archivedDataWithRootObject(object);
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  }`;
  return Buffer.from(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, text], { encoding: "utf8" }).trim(), "base64");
}

export function foundationEditSummary(timestamps: number[]): Buffer {
  const script = `ObjC.import("Foundation"); function run(argv) {
    const history = $.NSMutableArray.array;
    for (const value of argv) {
      const event = $.NSMutableDictionary.dictionary;
      event.setObjectForKey($(Number(value)), $("d"));
      event.setObjectForKey($.NSData.data, $("t"));
      history.addObject(event);
    }
    const edits = $.NSMutableDictionary.dictionary;
    edits.setObjectForKey(history, $("0"));
    const root = $.NSMutableDictionary.dictionary;
    root.setObjectForKey(edits, $("ec"));
    const error = Ref();
    const data = $.NSPropertyListSerialization.dataWithPropertyListFormatOptionsError(
      root, $.NSPropertyListBinaryFormat_v1_0, 0, error
    );
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  }`;
  return Buffer.from(execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, ...timestamps.map(String)],
    { encoding: "utf8" },
  ).trim(), "base64");
}

export function foundationLegacyDateArchive(): Buffer {
  const script = `ObjC.import("Foundation"); function run() {
    const data = $.NSArchiver.archivedDataWithRootObject($.NSDate.date);
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  }`;
  return Buffer.from(execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    { encoding: "utf8" },
  ).trim(), "base64");
}

export function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-mcp-fixture-"));
  const databasePath = path.join(directory, "chat.db");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT, country TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, style INTEGER DEFAULT 0, state INTEGER DEFAULT 0,
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
      message_summary_info BLOB, service TEXT
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, transfer_name TEXT, mime_type TEXT, total_bytes INTEGER
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  db.exec(`
    INSERT INTO handle(ROWID,id) VALUES
      (1,'+15550000001'), (2,'+15550000002'), (3,'unknown@example.test');
    INSERT INTO chat(ROWID,guid,chat_identifier,service_name,display_name,group_id) VALUES
      (1,'chat-guid-1','+15550000001','iMessage',NULL,NULL),
      (2,'chat-guid-2','+15550000001','SMS',NULL,NULL),
      (3,'chat-guid-3','unknown@example.test','SMS',NULL,NULL),
      (4,'chat-guid-4','group-rcs','RCS','Synthetic Group','group-1'),
      (5,'chat-guid-5','mystery','SatelliteRelay',NULL,NULL);
    INSERT INTO chat_handle_join(chat_id,handle_id) VALUES
      (1,1),(2,1),(3,3),(4,1),(4,2),(5,2);
    INSERT INTO chat_lookup(identifier,domain,chat) VALUES
      ('linked-alice','iMessage',1),('linked-alice','SMS',2),
      ('incoming-only','SMS',3),('group-rcs','RCS',4),('mystery','SatelliteRelay',5);
  `);

  const insertMessage = db.prepare(`INSERT INTO message(
    ROWID,guid,text,attributedBody,handle_id,date,date_read,date_delivered,is_delivered,is_from_me,is_read,
    is_system_message,cache_has_attachments,item_type,other_handle,group_title,group_action_type,
    associated_message_guid,associated_message_type,associated_message_emoji,reply_to_guid,date_retracted,date_edited,message_summary_info,service
  ) VALUES (
    @rowid,@guid,@text,@attributedBody,@handle_id,@date,@date_read,@date_delivered,@is_delivered,@is_from_me,@is_read,
    @is_system_message,@cache_has_attachments,@item_type,@other_handle,@group_title,@group_action_type,
    @associated_message_guid,@associated_message_type,@associated_message_emoji,@reply_to_guid,@date_retracted,@date_edited,@message_summary_info,@service
  )`);
  const defaults = {
    text: null,
    attributedBody: null,
    handle_id: null,
    date_read: 0,
    date_delivered: 0,
    is_delivered: 0,
    is_from_me: 0,
    is_read: 0,
    is_system_message: 0,
    cache_has_attachments: 0,
    item_type: 0,
    other_handle: 0,
    group_title: null,
    group_action_type: 0,
    associated_message_guid: null,
    associated_message_type: 0,
    associated_message_emoji: null,
    reply_to_guid: null,
    date_retracted: 0,
    date_edited: 0,
    message_summary_info: null,
    service: "iMessage",
  };
  const rows = [
    { rowid: 1, guid: "m1", text: "hello literal %_ token café 👨‍👩‍👧‍👦", handle_id: 1, date: appleNanoseconds("2026-03-08T06:30:00Z") },
    { rowid: 2, guid: "m2", text: "reply one", is_from_me: 1, date: appleNanoseconds("2026-03-08T06:35:00Z") },
    { rowid: 3, guid: "m3", text: "reply two in same turn", is_from_me: 1, date: appleNanoseconds("2026-03-08T06:36:00Z") },
    { rowid: 4, guid: "m4", text: "green sms", is_from_me: 1, date: appleNanoseconds("2026-03-08T07:30:00Z"), service: "SMS" },
    { rowid: 5, guid: "m5", text: "incoming only", handle_id: 3, date: appleNanoseconds("2026-03-09T01:00:00Z"), service: "MMS" },
    { rowid: 6, guid: "m6", text: "group hello", handle_id: 1, date: appleNanoseconds("2026-03-09T02:00:00Z"), service: "RCS" },
    { rowid: 7, guid: "m7", cache_has_attachments: 1, handle_id: 2, date: appleNanoseconds("2026-03-09T02:01:00Z"), service: "RCS" },
    { rowid: 8, guid: "m8", text: "mystery service", handle_id: 2, date: appleNanoseconds("2026-03-09T03:00:00Z"), service: "SatelliteRelay" },
    { rowid: 9, guid: "m9", attributedBody: foundationAttributedBody("blob exact ✨\nsecond line"), handle_id: 1, date: appleNanoseconds("2026-03-09T04:00:00Z") },
    {
      rowid: 10,
      guid: "m10",
      text: "edited current",
      handle_id: 1,
      date: appleNanoseconds("2026-03-09T04:05:00Z"),
      date_edited: appleNanoseconds("2026-03-09T04:06:00Z"),
      message_summary_info: foundationEditSummary([794_721_900, 794_721_960]),
    },
    { rowid: 11, guid: "m11", text: "should never be returned", is_from_me: 1, date: appleNanoseconds("2026-03-09T04:10:00Z"), date_retracted: appleNanoseconds("2026-03-09T04:11:00Z") },
    { rowid: 12, guid: "m12", text: "thread reply", handle_id: 1, date: appleNanoseconds("2026-03-09T04:15:00Z"), reply_to_guid: "m1" },
    { rowid: 13, guid: "r-add-love", handle_id: 1, date: appleNanoseconds("2026-03-09T04:20:00Z"), associated_message_guid: "p:0/m1", associated_message_type: 2000 },
    { rowid: 14, guid: "r-remove-love", handle_id: 1, date: appleNanoseconds("2026-03-09T04:21:00Z"), associated_message_guid: "bp:m1", associated_message_type: 3000 },
    { rowid: 15, guid: "r-add-like", handle_id: 1, date: appleNanoseconds("2026-03-09T04:22:00Z"), associated_message_guid: "m1", associated_message_type: 2001 },
    { rowid: 16, guid: "sys-join", handle_id: 2, date: appleNanoseconds("2026-03-09T04:30:00Z"), item_type: 1, group_action_type: 0, is_system_message: 1, service: "RCS" },
    { rowid: 17, guid: "sys-name", handle_id: 2, date: appleNanoseconds("2026-03-09T04:31:00Z"), item_type: 2, group_title: "Renamed Group", is_system_message: 1, service: "RCS" },
    { rowid: 18, guid: "m18", text: "receipt target", is_from_me: 1, date: appleNanoseconds("2026-03-09T05:00:00Z"), date_delivered: appleNanoseconds("2026-03-09T05:00:10Z"), date_read: appleNanoseconds("2026-03-09T05:02:00Z"), is_delivered: 1, is_read: 1 },
    { rowid: 19, guid: "m19", text: "exact wildcard %_ value", handle_id: 1, date: appleNanoseconds("2026-03-10T05:00:00Z") },
    { rowid: 20, guid: "m20", text: "the exact phrase lives here", handle_id: 1, date: appleNanoseconds("2026-03-10T06:00:00Z") },
  ];
  const chatByMessage = new Map<number, number>([
    [1,1],[2,1],[3,1],[4,2],[5,3],[6,4],[7,4],[8,5],[9,1],[10,1],[11,1],[12,1],
    [13,1],[14,1],[15,1],[16,4],[17,4],[18,1],[19,1],[20,1],
  ]);
  const transaction = db.transaction(() => {
    for (const row of rows) {
      insertMessage.run({ ...defaults, ...row });
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (?,?,?,0)")
        .run(chatByMessage.get(row.rowid), row.rowid, row.date);
    }
  });
  transaction();
  db.prepare("INSERT INTO attachment(ROWID,guid,filename,transfer_name,mime_type,total_bytes) VALUES (1,'a1','/Users/fake/Library/Messages/Attachments/private/photo.png','/Users/fake/private-alias/photo.png','image/png',1234)").run();
  db.prepare("INSERT INTO message_attachment_join(message_id,attachment_id) VALUES (7,1)").run();
  db.close();
  return {
    directory,
    databasePath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function createMinimalSchemaFixture(): Fixture {
  const fixture = createFixture();
  const db = new Database(fixture.databasePath);
  db.exec(`
    DROP TABLE chat_lookup;
    DROP TABLE message_attachment_join;
    DROP TABLE attachment;
  `);
  for (const column of [
    "text",
    "attributedBody",
    "date_read",
    "date_delivered",
    "is_delivered",
    "is_read",
    "is_system_message",
    "cache_has_attachments",
    "item_type",
    "other_handle",
    "group_title",
    "group_action_type",
    "associated_message_guid",
    "associated_message_type",
    "associated_message_emoji",
    "reply_to_guid",
    "date_retracted",
    "date_edited",
    "message_summary_info",
    "service",
  ]) {
    db.exec(`ALTER TABLE message DROP COLUMN "${column}"`);
  }
  for (const column of ["style", "state", "chat_identifier", "service_name", "display_name", "group_id"]) {
    db.exec(`ALTER TABLE chat DROP COLUMN "${column}"`);
  }
  for (const column of ["service", "country"]) db.exec(`ALTER TABLE handle DROP COLUMN "${column}"`);
  for (const column of ["message_date", "index_state"]) {
    db.exec(`ALTER TABLE chat_message_join DROP COLUMN "${column}"`);
  }
  db.close();
  return fixture;
}
