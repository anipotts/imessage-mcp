import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANGE_LOG_SQL,
  assertCursorLog,
  diffRowStates,
  materializeChanges,
  readRowStates,
  recordChanges,
  storedRowStates,
  writeRowStates,
  type ChangeRow,
  type RowState,
} from "../src/changes.js";
import { UnifiedContactResolver } from "../src/contacts.js";
import { DatabaseRequest } from "../src/database.js";
import { MessageTextDecoder } from "../src/decoder.js";
import Database from "../src/sqlite.js";

describe("durable sync conversation memberships", () => {
  let source: Database;
  let log: Database;

  const setMemberships = (ids: number[], message = 1) => {
    source.prepare("DELETE FROM chat_message_join WHERE message_id = ?").run(message);
    const insert = source.prepare("INSERT INTO chat_message_join(chat_id, message_id) VALUES (?, ?)");
    for (const id of ids) insert.run(id, message);
  };

  const states = () => {
    const request = new DatabaseRequest(source);
    try {
      return readRowStates(request, 0, request.asOf.max_message_id);
    } finally {
      request.close();
    }
  };

  const loggedChanges = () => log.prepare("SELECT * FROM changes ORDER BY seq").all() as Array<ChangeRow & { seq: number }>;

  const output = async (rows = loggedChanges(), decoder = new MessageTextDecoder()) => {
    const request = new DatabaseRequest(source);
    try {
      return await materializeChanges({ request, contacts: new UnifiedContactResolver(false), decoder, rows });
    } finally {
      request.close();
    }
  };

  beforeEach(() => {
    // Entirely synthetic: no filesystem, Messages archive or native contact access.
    source = new Database(":memory:");
    source.exec(`
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, handle_id INTEGER,
        date INTEGER DEFAULT 1000000000, is_from_me INTEGER DEFAULT 0,
        text TEXT, attributedBody BLOB, service TEXT DEFAULT 'iMessage', date_edited INTEGER DEFAULT 0,
        date_retracted INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
        associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT
      );
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_lookup (identifier TEXT, domain TEXT, chat INTEGER);
      CREATE INDEX chat_message_join_message ON chat_message_join(message_id);
      INSERT INTO handle VALUES (1, 'synthetic@example.test');
      INSERT INTO chat VALUES (1, 'chat-1'), (2, 'chat-2'), (3, 'chat-3');
      INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (3, 1);
      INSERT INTO chat_lookup VALUES ('linked', 'iMessage', 1), ('linked', 'SMS', 2);
      INSERT INTO message(ROWID, guid, handle_id, text) VALUES (1, 'message-1', 1, 'synthetic body');
      INSERT INTO chat_message_join VALUES (2, 1);
    `);
    log = new Database(":memory:");
    log.exec(CHANGE_LOG_SQL);
  });

  afterEach(() => {
    log.close();
    source.close();
  });

  it("stores all sorted canonical memberships in row state and creation history", async () => {
    setMemberships([3, 2, 1]);
    const snapshot = states();
    expect(snapshot[0]).toMatchObject({ chat_id: null, chat_ids_json: "[1,3]" });
    writeRowStates(log, snapshot);
    expect(storedRowStates(log, 1, 1)).toEqual(snapshot);
    recordChanges(log, diffRowStates([], snapshot));
    expect(loggedChanges()).toEqual([expect.objectContaining({ type: "message_created", chat_id: null, chat_ids_json: "[1,3]" })]);
    const [created] = await output();
    expect(created).toMatchObject({ message_id: 1, chat_ids: [1, 3], text: "synthetic body", row_status: "complete" });
    expect(created).not.toHaveProperty("chat_id");
    expect(created).not.toHaveProperty("previous_chat_ids");
  });

  it.each(["incoming", "outgoing"] as const)("preserves single-member %s creation and edit projections with current text", async (direction) => {
    if (direction === "outgoing") source.exec("UPDATE message SET is_from_me = 1, handle_id = NULL");
    const before = states();
    recordChanges(log, diffRowStates([], before));
    source.exec("UPDATE message SET text = 'current edited body', date_edited = 2000000000");
    recordChanges(log, diffRowStates(before, states()));
    const events = await output();
    expect(events.map((event) => event.change_type)).toEqual(["message_created", "message_edited"]);
    for (const event of events) {
      expect(event).toMatchObject({
        message_id: 1, chat_id: 1, chat_ids: [1], direction, text: "current edited body",
        service_family: "imessage", row_status: "complete",
        sender: direction === "outgoing" ? { name: "Me", handle: null } : { name: null, handle: "synthetic@example.test" },
      });
      expect(event.changed_at).not.toBeNull();
    }
  });

  it.each([
    ["item type", 2, 0],
    ["system flag", 0, 1],
    ["both", 2, 1],
  ])("keeps %s system creation and membership changes complete without a human sender", async (_label, itemType, isSystem) => {
    source.prepare("UPDATE message SET item_type = ?, is_system_message = ?, handle_id = NULL, is_from_me = NULL, text = NULL")
      .run(itemType, isSystem);
    const before = states();
    recordChanges(log, diffRowStates([], before));
    setMemberships([2, 3]);
    recordChanges(log, diffRowStates(before, states()));
    const events = await output();
    expect(events.map((event) => event.change_type)).toEqual(["group_event", "message_membership_changed"]);
    for (const event of events) {
      expect(event).toMatchObject({ direction: "system", row_status: "complete" });
      expect(event).not.toHaveProperty("sender");
      expect(event).not.toHaveProperty("text");
    }
    expect(events[0]).toMatchObject({ chat_id: 1, chat_ids: [1] });
    expect(events[1]).toMatchObject({ message_id: 1, previous_chat_ids: [1], chat_ids: [1, 3], changed_at: null });
    expect(events[1]).not.toHaveProperty("chat_id");
  });

  it.each(["native text", "attributed body"])("suppresses retained %s from old creation/edit events after current retraction", async (storage) => {
    const before = states();
    recordChanges(log, diffRowStates([], before));
    if (storage === "native text") {
      source.exec("UPDATE message SET text = 'retained retracted body', date_edited = 2000000000");
    } else {
      source.prepare("UPDATE message SET text = NULL, attributedBody = ?, date_edited = 2000000000")
        .run(Buffer.from("synthetic retained archive"));
    }
    const edited = states();
    recordChanges(log, diffRowStates(before, edited));
    source.exec("UPDATE message SET date_retracted = 3000000000");
    recordChanges(log, diffRowStates(edited, states()));
    const decoder = new MessageTextDecoder();
    const decode = vi.spyOn(decoder, "decode").mockResolvedValue([{ status: "decoded", text: "retained retracted body" }]);
    const events = await output(loggedChanges(), decoder);
    expect(events.map((event) => event.change_type)).toEqual(["message_created", "message_edited", "message_retracted"]);
    for (const event of events) {
      expect(event).toMatchObject({ message_id: 1, chat_id: 1, chat_ids: [1], row_status: "complete" });
      expect(event).not.toHaveProperty("text");
    }
    expect(events[2].changed_at).not.toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });

  it("keeps unlinked messages and dangling chat joins as empty memberships", async () => {
    source.exec("INSERT INTO message(ROWID, guid, handle_id, text) VALUES (2, 'message-2', 1, 'unlinked')");
    setMemberships([999]);
    const snapshot = states();
    expect(snapshot.map((row) => [row.rowid, row.chat_id, row.chat_ids_json])).toEqual([[1, null, "[]"], [2, null, "[]"]]);
    recordChanges(log, diffRowStates([], snapshot));
    const created = await output();
    expect(created.map((row) => row.chat_ids)).toEqual([[], []]);
    expect(created.every((row) => !("chat_id" in row))).toBe(true);
  });

  it.each([
    ["addition", [2], [2, 3], [1], [1, 3]],
    ["removal", [2, 3], [2], [1, 3], [1]],
    ["movement", [2], [3], [1], [3]],
    ["detachment", [2], [], [1], []],
    ["attachment", [], [2], [], [1]],
  ] as Array<[string, number[], number[], number[], number[]]>) (
    "emits one membership event for join %s without duplicating content changes",
    async (_label, initial, final, previousIds, nextIds) => {
      setMemberships(initial);
      const before = states();
      setMemberships(final);
      const changes = diffRowStates(before, states());
      expect(changes).toEqual([expect.objectContaining({
        type: "message_membership_changed",
        rowid: 1,
        chat_id: nextIds.length === 1 ? nextIds[0] : null,
        chat_ids_json: JSON.stringify(nextIds),
        previous_chat_ids_json: JSON.stringify(previousIds),
      })]);
      recordChanges(log, changes);
      const [event] = await output();
      expect(event).toMatchObject({ change_type: "message_membership_changed", message_id: 1, chat_ids: nextIds, previous_chat_ids: previousIds, changed_at: null });
      expect(event).not.toHaveProperty("text");
      if (nextIds.length === 1) expect(event.chat_id).toBe(nextIds[0]);
      else expect(event).not.toHaveProperty("chat_id");
    },
  );

  it("emits membership changes when lookup components merge and split, preserving each event snapshot", async () => {
    setMemberships([2, 3]);
    const separate = states();
    source.exec("INSERT INTO chat_lookup VALUES ('linked', 'RCS', 3)");
    const linked = states();
    recordChanges(log, diffRowStates(separate, linked));
    source.exec("DELETE FROM chat_lookup WHERE chat = 3");
    const split = states();
    recordChanges(log, diffRowStates(linked, split));
    const events = await output();
    expect(events.map((row) => [row.change_type, row.previous_chat_ids, row.chat_ids])).toEqual([
      ["message_membership_changed", [1, 3], [1]],
      ["message_membership_changed", [1], [1, 3]],
    ]);
    expect(events[0].chat_id).toBe(1);
    expect(events[1]).not.toHaveProperty("chat_id");
  });

  it("keeps historical deletion memberships after a graph change and source-row removal", async () => {
    setMemberships([2, 3]);
    const before = states();
    source.exec("DELETE FROM chat_message_join WHERE message_id = 1; DELETE FROM message WHERE ROWID = 1");
    recordChanges(log, diffRowStates(before, states()));
    // This would remap a live chat_id=2 to 2, and merge the recorded 3 into 1.
    source.exec("DELETE FROM chat_lookup WHERE chat = 2; INSERT INTO chat_lookup VALUES ('linked', 'RCS', 3)");
    const [deleted] = await output();
    expect(deleted).toMatchObject({ change_type: "message_deleted", message_id: 1, chat_ids: [1, 3], row_status: "complete", changed_at: null });
    expect(deleted).not.toHaveProperty("chat_id");
  });

  it("uses unknown time for physical reaction removal and the recorded time for an explicit removal event", async () => {
    source.exec(`
      INSERT INTO message(ROWID, guid, handle_id, associated_message_type, associated_message_guid)
      VALUES (2, 'reaction-2', 1, 2001, 'p:0/message-1');
      INSERT INTO chat_message_join VALUES (2, 2);
    `);
    const before = states();
    source.exec("DELETE FROM chat_message_join WHERE message_id = 2; DELETE FROM message WHERE ROWID = 2");
    recordChanges(log, diffRowStates(before, states()));
    const [physical] = await output();
    expect(physical).toMatchObject({ change_type: "reaction_removed", parent_message_id: 1, chat_id: 1, chat_ids: [1], changed_at: null, row_status: "complete" });
    const afterRemoval = states();
    source.exec(`
      INSERT INTO message(ROWID, guid, handle_id, date, associated_message_type, associated_message_guid)
      VALUES (3, 'reaction-3', 1, 4000000000, 3001, 'p:0/message-1');
      INSERT INTO chat_message_join VALUES (2, 3);
    `);
    recordChanges(log, diffRowStates(afterRemoval, states()));
    const explicit = (await output())[1];
    expect(explicit).toMatchObject({ change_type: "reaction_removed", parent_message_id: 1, chat_id: 1, chat_ids: [1], row_status: "complete" });
    expect(explicit.changed_at).not.toBeNull();
  });

  it("reports a content edit once when it occurs with a membership change", () => {
    const before = states();
    setMemberships([2, 3]);
    source.exec("UPDATE message SET text = 'edited synthetic body', date_edited = 2000000000 WHERE ROWID = 1");
    const changes = diffRowStates(before, states());
    expect(changes.map((row) => row.type)).toEqual(["message_membership_changed", "message_edited"]);
    expect(changes.every((row) => row.chat_ids_json === "[1,3]")).toBe(true);
  });

  it("does not report membership changes for join duplicates or canonical alias changes", () => {
    const before = states();
    setMemberships([1, 2, 2]);
    expect(diffRowStates(before, states())).toEqual([]);
  });

  it("preserves legacy single-membership states without remapping their historical id", async () => {
    const legacy = { ...states()[0], chat_id: 2 } as RowState;
    delete legacy.chat_ids_json;
    writeRowStates(log, [legacy]);
    expect(storedRowStates(log, 1, 1)[0]).toMatchObject({ chat_id: 2, chat_ids_json: "[2]" });
    recordChanges(log, diffRowStates([], [legacy]));
    expect((await output())[0]).toMatchObject({ chat_id: 2, chat_ids: [2] });
  });

  it("rejects the 1001st distinct conversation instead of truncating sync history", () => {
    const chat = source.prepare("INSERT INTO chat(ROWID, guid) VALUES (?, ?)");
    const join = source.prepare("INSERT INTO chat_message_join(chat_id, message_id) VALUES (?, 1)");
    source.exec("DELETE FROM chat_message_join; DELETE FROM chat_lookup");
    for (let id = 4; id <= 1001; id += 1) chat.run(id, `chat-${id}`);
    for (let id = 1; id <= 1000; id += 1) join.run(id);
    expect(JSON.parse(states()[0].chat_ids_json ?? "[]")).toHaveLength(1000);
    join.run(1001);
    expect(states).toThrow(expect.objectContaining({ reason: "QUERY_BUDGET_EXCEEDED" }));
  });

  it("rejects an old valid sync cursor as DATABASE_CHANGED after rebuilding the change log", () => {
    const oldCursor = { v: 3, seq: 10, log: "before-schema-rebuild", db: "same-archive" };
    expect(() => assertCursorLog(oldCursor, "after-schema-rebuild", "same-archive", 1))
      .toThrow(expect.objectContaining({ reason: "DATABASE_CHANGED" }));
    expect(() => assertCursorLog(oldCursor, "after-schema-rebuild", "same-archive", 1))
      .toThrow("the change history this cursor continues from was rebuilt or trimmed");
    expect(assertCursorLog({ ...oldCursor, log: "after-schema-rebuild" }, "after-schema-rebuild", "same-archive", 1)).toBe(10);
  });
});
