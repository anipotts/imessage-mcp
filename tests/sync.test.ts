import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { runtimeConfig } from "../src/config.js";
import { LocalToolRuntime } from "../src/runtime.js";
import Database from "../src/sqlite.js";
import { appleNanoseconds, createFixture, type Fixture } from "./fixture.js";

interface SyncData {
  changes: Array<Record<string, unknown>>;
  cursor: string;
}

describe("sync_messages change log", () => {
  let fixture: Fixture;
  let runtime: LocalToolRuntime;
  let writer: Database;

  const sync = async (cursor?: string, extra: Record<string, unknown> = {}) => {
    const result = await runtime.call("sync_messages", { limit: 50, ...(cursor ? { cursor } : {}), ...extra });
    if (result.isError) throw Object.assign(new Error("sync failed"), { structured: result.structuredContent });
    return (result.structuredContent as { data: SyncData; page: { has_more: boolean } });
  };
  const insertMessage = (rowid: number, guid: string, fields: Record<string, unknown> = {}) => {
    const date = appleNanoseconds("2026-08-10T12:00:00Z") + rowid;
    const columns = { ROWID: rowid, guid, text: `message ${rowid}`, handle_id: 1, date, is_from_me: 0, service: "iMessage", ...fields };
    const names = Object.keys(columns);
    writer.prepare(`INSERT INTO message(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(columns));
    writer.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (2,?,?,0)").run(rowid, date);
  };

  beforeEach(() => {
    fixture = createFixture();
    writer = new Database(fixture.databasePath);
    runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: fixture.databasePath, contacts: "none" }));
  });

  afterEach(() => {
    runtime.close();
    writer.close();
    fixture.cleanup();
  });

  it("starts with an empty batch and a cursor, then reports nothing until something changes", async () => {
    const first = await sync();
    expect(first.data.changes).toEqual([]);
    expect(first.data.cursor).toMatch(/^im3_sync_/u);
    const again = await sync(first.data.cursor);
    expect(again.data.changes).toEqual([]);
  });

  it("reports every kind of change with ids and current content", async () => {
    const { data: { cursor } } = await sync();
    insertMessage(30, "sync-created");
    writer.prepare("UPDATE message SET text = 'edited current body', date_edited = ? WHERE ROWID = 1").run(appleNanoseconds("2026-08-10T13:00:00Z"));
    writer.prepare("UPDATE message SET date_retracted = ? WHERE ROWID = 3").run(appleNanoseconds("2026-08-10T13:05:00Z"));
    writer.prepare("UPDATE message SET is_read = 1, date_read = ? WHERE ROWID = 4").run(appleNanoseconds("2026-08-10T13:06:00Z"));
    insertMessage(31, "sync-reaction", { text: null, associated_message_guid: "p:0/m1", associated_message_type: 2001 });
    writer.prepare("DELETE FROM chat_message_join WHERE message_id = 12").run();
    writer.prepare("DELETE FROM message WHERE ROWID = 12").run();
    insertMessage(32, "sync-group-event", { text: null, item_type: 2, group_title: "Renamed", is_system_message: 1 });

    const { data } = await sync(cursor);
    const byType = (type: string) => data.changes.filter((change) => change.change_type === type);
    expect(byType("message_created")).toEqual([expect.objectContaining({ message_id: 30, chat_id: 1, text: "message 30", row_status: "complete" })]);
    expect(byType("message_edited")).toEqual([expect.objectContaining({ message_id: 1, text: "edited current body" })]);
    expect(byType("message_retracted")).toEqual([expect.objectContaining({ message_id: 3 })]);
    expect(byType("receipt_changed")).toEqual([expect.objectContaining({ message_id: 4, receipt: expect.objectContaining({ state: "read" }) })]);
    expect(byType("reaction_added")).toEqual([expect.objectContaining({ parent_message_id: 1, reaction: { type: "like" } })]);
    expect(byType("message_deleted")).toEqual([expect.objectContaining({ message_id: 12 })]);
    expect(byType("group_event")).toHaveLength(1);
    const seqs = data.changes.map((change) => change.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("treats a reused ROWID as a deletion and a new message", async () => {
    const { data: { cursor } } = await sync();
    writer.prepare("DELETE FROM chat_message_join WHERE message_id = 20").run();
    writer.prepare("DELETE FROM message WHERE ROWID = 20").run();
    insertMessage(20, "reused-rowid");
    const { data } = await sync(cursor);
    expect(data.changes.map((change) => [change.change_type, change.message_id])).toEqual([
      ["message_deleted", 20],
      ["message_created", 20],
    ]);
  });

  it("pages with limit and resumes exactly after the last change it returned", async () => {
    const { data: { cursor } } = await sync();
    for (let rowid = 40; rowid < 45; rowid += 1) insertMessage(rowid, `page-${rowid}`);
    const first = await sync(cursor, { limit: 2 });
    expect(first.data.changes).toHaveLength(2);
    expect(first.page.has_more).toBe(true);
    const second = await sync(first.data.cursor, { limit: 50 });
    expect([...first.data.changes, ...second.data.changes].map((change) => change.message_id)).toEqual([40, 41, 42, 43, 44]);
    expect(second.page.has_more).toBe(false);
  });

  it("rejects a cursor from a different archive and a malformed cursor", async () => {
    const { data: { cursor } } = await sync();
    const other = createFixture();
    const copy = path.join(other.directory, "other.db");
    copyFileSync(other.databasePath, copy);
    const otherWriter = new Database(copy);
    otherWriter.prepare("UPDATE message SET guid = 'different-archive' WHERE ROWID = 1").run();
    otherWriter.close();
    const otherRuntime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: copy, contacts: "none" }));
    try {
      const result = await otherRuntime.call("sync_messages", { cursor, limit: 10 });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { reason: string } }).error.reason).toBe("DATABASE_CHANGED");
      const malformed = await otherRuntime.call("sync_messages", { cursor: "im3_sync_bm90IGpzb24", limit: 10 });
      expect((malformed.structuredContent as { error: { reason: string } }).error.reason).toBe("INVALID_INPUT");
    } finally {
      otherRuntime.close();
      other.cleanup();
    }
  });

  it("reports only counts in aggregate mode", async () => {
    const { data: { cursor } } = await sync();
    insertMessage(50, "aggregate-created");
    const result = await runtime.call("sync_messages", { cursor, limit: 10, privacy_mode: "aggregate" });
    expect(result.isError).toBeUndefined();
    const data = (result.structuredContent as { data: { change_count: number; by_type: Record<string, number> } }).data;
    expect(data).toMatchObject({ change_count: 1, by_type: { message_created: 1 } });
    const text = JSON.stringify(result.structuredContent);
    expect(text).not.toMatch(/message_id|chat_id|message 50|handle/u);
  });
});
