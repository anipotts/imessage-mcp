import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnifiedContactResolver } from "../src/contacts.js";
import { DatabaseContext } from "../src/database.js";
import { MessageTextDecoder } from "../src/decoder.js";
import { MemorySearchIndex, type SearchMode, type SearchOrder, type SearchScope } from "../src/search-index.js";
import Database, { sqliteCheckpointAvailable } from "../src/sqlite.js";
import { compileDateBounds } from "../src/time.js";
import { appleNanoseconds, createFixture, type Fixture } from "./fixture.js";

describe("search and refresh with shared conversation memberships", () => {
  let fixture: Fixture;
  let cacheDirectory: string;
  let writer: Database;
  let context: DatabaseContext;
  let contacts: UnifiedContactResolver;
  let index: MemorySearchIndex;
  let onBuild: ReturnType<typeof vi.fn>;

  const insertMessage = (rowid: number, memberships: number[], fields: Record<string, unknown> = {}) => {
    const columns = {
      ROWID: rowid,
      guid: `membership-${rowid}`,
      handle_id: 1,
      date: appleNanoseconds("2026-04-01T00:00:00Z") + rowid,
      text: "shared search needle",
      service: "iMessage",
      ...fields,
    };
    const names = Object.keys(columns);
    writer.prepare(`INSERT INTO message(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(columns));
    const join = writer.prepare("INSERT INTO chat_message_join(chat_id, message_id, message_date) VALUES (?, ?, ?)");
    for (const chat of memberships) join.run(chat, rowid, columns.date);
  };

  const search = (query: string, options: {
    mode?: SearchMode;
    scopes?: SearchScope[];
    order?: SearchOrder;
    limit?: number;
    cursor?: string;
    target?: MemorySearchIndex;
  } = {}) => (options.target ?? index).search({
    query,
    mode: options.mode ?? "substring",
    scopes: options.scopes ?? ["text"],
    order: options.order ?? "newest",
    bounds: compileDateBounds({ timezone: "UTC" }),
    limit: options.limit ?? 50,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    allowPartial: false,
    privacy: "full",
  });

  const startIndex = () => {
    context = new DatabaseContext(fixture.databasePath, "copy");
    onBuild = vi.fn();
    index = new MemorySearchIndex(context, new MessageTextDecoder(), contacts, onBuild, cacheDirectory);
  };

  const comparable = (result: Awaited<ReturnType<MemorySearchIndex["search"]>>) => ({
    hits: result.hits,
    total: result.total,
    hasMore: result.hasMore,
    warnings: result.warnings,
  });

  // Compare actual results rather than only index internals. A complete rebuild
  // is the oracle for an incremental refresh and for encrypted-cache restore.
  const expectFreshParity = async (queries: Array<{ query: string; scopes?: SearchScope[] }> = [{ query: "shared search needle" }]) => {
    const fresh = new MemorySearchIndex(context, new MessageTextDecoder(), contacts);
    try {
      for (const query of queries) {
        expect(comparable(await search(query.query, { ...query, target: index })))
          .toEqual(comparable(await search(query.query, { ...query, target: fresh })));
      }
    } finally {
      fresh.close();
    }
  };

  beforeEach(() => {
    fixture = createFixture();
    cacheDirectory = mkdtempSync(path.join(tmpdir(), "imessage-search-memberships-"));
    writer = new Database(fixture.databasePath);
    writer.exec(`
      DELETE FROM message_attachment_join;
      DELETE FROM chat_message_join;
      DELETE FROM message;
      UPDATE chat SET display_name = 'Primary Archive' WHERE ROWID IN (1, 2);
      UPDATE chat SET display_name = 'Secondary Archive' WHERE ROWID = 3;
    `);
    contacts = new UnifiedContactResolver(true, [
      { identifier: "primary", name: "Primary Person", phones: ["+15550000001"], emails: [] },
      { identifier: "secondary", name: "Secondary Person", phones: [], emails: ["unknown@example.test"] },
      { identifier: "new-secondary", name: "Inserted Secondary Person", phones: [], emails: ["added-secondary@example.test"] },
    ]);
    insertMessage(1, [2, 3]);
    startIndex();
  });

  afterEach(() => {
    index.close();
    context.close();
    writer.close();
    fixture.cleanup();
    rmSync(cacheDirectory, { recursive: true, force: true });
  });

  it("returns one shared hit with every canonical membership and no arbitrary singular id", async () => {
    // Raw aliases 1 and 2 still identify one component, separate from chat 3.
    writer.prepare("INSERT INTO chat_message_join(chat_id, message_id) VALUES (1, 1)").run();
    const result = await search("shared search needle");
    expect(result.total).toBe(1);
    expect(result.hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1, 3], row_status: "complete" })]);
    expect(result.hits[0]).not.toHaveProperty("chat_id");
    expect(index.state()).toMatchObject({ state: "ready", indexed_messages: 1 });
  });

  it("accepts shared conversations with the same 600 participants instead of summing their overlap", async () => {
    writer.exec("DELETE FROM chat_handle_join");
    const handle = writer.prepare("INSERT INTO handle(ROWID, id) VALUES (?, ?)");
    for (let id = 4; id <= 600; id += 1) handle.run(id, `participant-${id}@example.test`);
    const participant = writer.prepare("INSERT INTO chat_handle_join(chat_id, handle_id) VALUES (?, ?)");
    for (let id = 1; id <= 600; id += 1) {
      participant.run(2, id);
      participant.run(3, id);
    }
    const result = await search("shared search needle");
    expect(result.total).toBe(1);
    expect(result.hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1, 3], matched_scopes: ["text"] })]);
    expect(result.hits[0]).not.toHaveProperty("chat_id");
    expect(index.state()).toMatchObject({ state: "ready", indexed_messages: 1 });
  });

  it.each(["substring", "exact", "token", "phrase"] as SearchMode[])(
    "matches the names of either recorded conversation in %s mode",
    async (mode) => {
      for (const query of ["Primary Archive", "Secondary Archive"]) {
        const result = await search(query, { mode, scopes: ["conversation_names"] });
        expect(result.total).toBe(1);
        expect(result.hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1, 3], matched_scopes: ["conversation_names"] })]);
        expect(result.hits[0]).not.toHaveProperty("chat_id");
      }
    },
  );

  it.each(["newest", "relevance"] as SearchOrder[])("pages unique message rows in %s order", async (order) => {
    for (const rowid of [300, 600, 900, 1200]) insertMessage(rowid, [1, 2, 3]);
    const ids: number[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await search("shared search needle", { order, limit: 2, cursor });
      expect(page.total).toBe(5);
      expect(page.hits.every((hit) => JSON.stringify(hit.chat_ids) === "[1,3]")).toBe(true);
      ids.push(...page.hits.map((hit) => hit.message_id));
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor ?? undefined;
    }
    expect(ids).toEqual([1200, 900, 600, 300, 1]);
    expect(new Set(ids).size).toBe(5);
  });

  it("refreshes a secondary component's name and participants in every rowid bucket", async () => {
    insertMessage(300, [2, 3]);
    insertMessage(600, [2, 3]);
    insertMessage(900, [4], { text: "unrelated text" });
    expect((await search("Secondary Archive", { scopes: ["conversation_names"] })).hits.map((hit) => hit.message_id)).toEqual([600, 300, 1]);
    writer.exec(`
      UPDATE chat SET display_name = 'Revised Secondary Archive' WHERE ROWID = 3;
      INSERT INTO handle(ROWID, id) VALUES (99, 'added-secondary@example.test');
      INSERT INTO chat_handle_join(chat_id, handle_id) VALUES (3, 99);
    `);
    const renamed = await search("Revised Secondary Archive", { scopes: ["conversation_names"] });
    expect(renamed.hits.map((hit) => hit.message_id)).toEqual([600, 300, 1]);
    expect((await search("Secondary Archive", { mode: "exact", scopes: ["conversation_names"] })).total).toBe(0);
    const participant = await search("Inserted Secondary Person", { scopes: ["conversation_names"] });
    expect(participant.hits.map((hit) => hit.message_id)).toEqual([600, 300, 1]);
    expect(participant.hits.every((hit) => JSON.stringify(hit.chat_ids) === "[1,3]")).toBe(true);
    expect((await search("Primary Archive", { scopes: ["conversation_names"] })).total).toBe(3);
    expect((await search("unrelated text")).hits).toEqual([expect.objectContaining({ message_id: 900, chat_ids: [4], chat_id: 4 })]);
    expect(index.changeLog().read(0, 20)).toEqual([]);
    expect(onBuild).toHaveBeenCalledTimes(1);
    await expectFreshParity([
      { query: "shared search needle" },
      { query: "Revised Secondary Archive", scopes: ["conversation_names"] },
      { query: "Inserted Secondary Person", scopes: ["conversation_names"] },
    ]);
  });

  it("refreshes join removal and insertion without losing or duplicating the searchable message", async () => {
    await index.ensure(false);
    writer.prepare("DELETE FROM chat_message_join WHERE message_id = 1 AND chat_id = 3").run();
    const removed = await search("shared search needle");
    expect(removed.hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1], chat_id: 1 })]);
    expect((await search("Secondary Archive", { scopes: ["conversation_names"] })).total).toBe(0);
    const afterRemoval = index.changeLog();
    expect(afterRemoval.read(0, 20)).toEqual([expect.objectContaining({
      type: "message_membership_changed", rowid: 1, previous_chat_ids_json: "[1,3]", chat_ids_json: "[1]",
    })]);
    writer.prepare("INSERT INTO chat_message_join(chat_id, message_id) VALUES (3, 1)").run();
    const inserted = await search("Secondary Archive", { scopes: ["conversation_names"] });
    expect(inserted.total).toBe(1);
    expect(inserted.hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1, 3] })]);
    expect(inserted.hits[0]).not.toHaveProperty("chat_id");
    expect(index.changeLog().read(afterRemoval.latestSeq, 20)).toEqual([expect.objectContaining({
      type: "message_membership_changed", rowid: 1, previous_chat_ids_json: "[1]", chat_ids_json: "[1,3]",
    })]);
    await expectFreshParity([{ query: "shared search needle" }, { query: "Secondary Archive", scopes: ["conversation_names"] }]);
  });

  it("refreshes lookup merges and splits, including sync state for excluded reactions and system rows", async () => {
    insertMessage(900, [3], { text: null, associated_message_type: 2001, associated_message_guid: "p:0/membership-1" });
    insertMessage(1200, [3], { text: null, item_type: 2, is_system_message: 1 });
    await index.ensure(false);
    expect(index.state().indexed_messages).toBe(1);
    writer.prepare("INSERT INTO chat_lookup(identifier, domain, chat) VALUES ('linked-alice', 'RCS', 3)").run();
    expect((await search("shared search needle")).hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1], chat_id: 1 })]);
    const merged = index.changeLog();
    expect(merged.read(0, 20).map((row) => [row.type, row.rowid, row.previous_chat_ids_json, row.chat_ids_json])).toEqual([
      ["message_membership_changed", 1, "[1,3]", "[1]"],
      ["message_membership_changed", 900, "[3]", "[1]"],
      ["message_membership_changed", 1200, "[3]", "[1]"],
    ]);
    writer.prepare("DELETE FROM chat_lookup WHERE identifier = 'linked-alice' AND chat = 3").run();
    const split = await search("shared search needle");
    expect(split.hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1, 3] })]);
    expect(split.hits[0]).not.toHaveProperty("chat_id");
    expect(index.changeLog().read(merged.latestSeq, 20).map((row) => [row.type, row.rowid, row.previous_chat_ids_json, row.chat_ids_json])).toEqual([
      ["message_membership_changed", 1, "[1]", "[1,3]"],
      ["message_membership_changed", 900, "[1]", "[3]"],
      ["message_membership_changed", 1200, "[1]", "[3]"],
    ]);
    expect(index.state().indexed_messages).toBe(1);
    await expectFreshParity([{ query: "shared search needle" }, { query: "Secondary Archive", scopes: ["conversation_names"] }]);
  });

  it.skipIf(!sqliteCheckpointAvailable())("restores memberships from cache, catches up on offline relinking, and matches a fresh rebuild", async () => {
    insertMessage(300, [2, 3]);
    await index.ensure(false);
    const original = index.changeLog();
    index.close();
    context.close();
    writer.exec(`
      INSERT INTO chat_lookup(identifier, domain, chat) VALUES ('linked-alice', 'RCS', 3);
      UPDATE chat SET display_name = 'Offline Secondary Archive' WHERE ROWID = 3;
    `);
    startIndex();
    const restored = await search("shared search needle");
    expect(restored.hits.map((hit) => [hit.message_id, hit.chat_ids, hit.chat_id])).toEqual([[300, [1], 1], [1, [1], 1]]);
    expect((await search("Offline Secondary Archive", { scopes: ["conversation_names"] })).total).toBe(2);
    expect(onBuild).not.toHaveBeenCalled();
    expect(index.changeLog().logId).toBe(original.logId);
    expect(index.changeLog().read(original.latestSeq, 20).map((row) => [row.type, row.rowid, row.chat_ids_json])).toEqual([
      ["message_membership_changed", 1, "[1]"],
      ["message_membership_changed", 300, "[1]"],
    ]);
    await expectFreshParity([{ query: "shared search needle" }, { query: "Offline Secondary Archive", scopes: ["conversation_names"] }]);
  });

  it.each([false, true])("preserves a failed index state and clears its stable error after source repair (built=%s)", async (built) => {
    if (built) await index.ensure(false);
    writer.prepare("INSERT INTO chat_lookup(identifier, domain, chat) VALUES ('', 'iMessage', 3)").run();
    await expect(search("shared search needle")).rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
    expect(index.state()).toMatchObject({ state: "failed", last_error: { reason: "UNSUPPORTED_SCHEMA" }, indexed_messages: built ? 1 : 0 });
    expect(index.state().last_error).toEqual({ reason: "UNSUPPORTED_SCHEMA" });
    await expect(search("shared search needle")).rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
    expect(index.state().state).toBe("failed");
    expect(index.state().last_error).toEqual({ reason: "UNSUPPORTED_SCHEMA" });
    writer.prepare("DELETE FROM chat_lookup WHERE identifier = ''").run();
    expect((await search("shared search needle")).hits).toEqual([expect.objectContaining({ message_id: 1, chat_ids: [1, 3] })]);
    expect(index.state()).toMatchObject({ state: "ready", indexed_messages: 1 });
    expect(index.state()).not.toHaveProperty("last_error");
  });
});
