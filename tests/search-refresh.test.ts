import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "../src/sqlite.js";
import { UnifiedContactResolver } from "../src/contacts.js";
import { DatabaseContext } from "../src/database.js";
import { MessageTextDecoder } from "../src/decoder.js";
import { MemorySearchIndex, type SearchMode, type SearchScope } from "../src/search-index.js";
import { compileDateBounds } from "../src/time.js";
import { appleNanoseconds, createFixture, type Fixture } from "./fixture.js";


type Ranges = Array<[number, number]>;

function internals(index: MemorySearchIndex): {
  index: Database.Database;
  populateWithinDecoderSession: (...args: unknown[]) => Promise<void>;
} {
  return index as unknown as ReturnType<typeof internals>;
}

// Every stored column plus both full-text integrity checks, which fail when an
// external-content FTS table still holds a row its content table replaced.
function snapshot(index: MemorySearchIndex): unknown[] {
  const db = internals(index).index;
  db.exec("INSERT INTO message_fts(message_fts, rank) VALUES('integrity-check', 1)");
  db.exec("INSERT INTO message_trigram(message_trigram, rank) VALUES('integrity-check', 1)");
  return db.prepare("SELECT * FROM message_text ORDER BY rowid").all();
}

describe("search index refresh", () => {
  let fixture: Fixture;
  let writer: Database.Database;
  let context: DatabaseContext;
  let contacts: UnifiedContactResolver;
  let onBuild: ReturnType<typeof vi.fn>;
  let index: MemorySearchIndex;
  let populated: Ranges;

  const search = (query: string, options: { mode?: SearchMode; scopes?: SearchScope[]; allowPartial?: boolean } = {}) =>
    index.search({
      query,
      mode: options.mode ?? "substring",
      scopes: options.scopes ?? ["text"],
      order: "newest",
      bounds: compileDateBounds({ timezone: "UTC" }),
      limit: 50,
      allowPartial: options.allowPartial ?? true,
      privacy: "full",
    });

  const insertMessage = (rowid: number, text: string | null, chat = 1, body: Buffer | null = null) => {
    const date = appleNanoseconds("2026-04-01T00:00:00Z") + rowid;
    writer.prepare(
      "INSERT INTO message(ROWID,guid,text,attributedBody,handle_id,date,service) VALUES (?,?,?,?,1,?,'iMessage')",
    ).run(rowid, `refresh-${rowid}`, text, body, date);
    writer.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date) VALUES (?,?,?)").run(chat, rowid, date);
  };

  // A fresh index over the same snapshot is the oracle for every refresh.
  const expectParity = async () => {
    const fresh = new MemorySearchIndex(context, new MessageTextDecoder(), contacts);
    try {
      await fresh.ensure(true);
      expect(snapshot(index)).toEqual(snapshot(fresh));
    } finally {
      fresh.close();
    }
  };

  beforeEach(async () => {
    fixture = createFixture();
    writer = new Database(fixture.databasePath);
    insertMessage(300, "second bucket seed");
    insertMessage(600, "third bucket seed", 4);
    context = new DatabaseContext(fixture.databasePath, "copy");
    contacts = new UnifiedContactResolver(true, [
      { identifier: "alice", name: "Alice Refresh", phones: ["+15550000001"], emails: [] },
      { identifier: "bob", name: "Bob Refresh", phones: ["+15550000002"], emails: [] },
    ]);
    onBuild = vi.fn();
    index = new MemorySearchIndex(context, new MessageTextDecoder(), contacts, onBuild);
    await index.ensure(true);
    populated = [];
    const original = internals(index).populateWithinDecoderSession.bind(index);
    vi.spyOn(internals(index), "populateWithinDecoderSession").mockImplementation(
      (request, db, after, target, ...rest) => {
        populated.push([after as number, target as number]);
        return original(request, db, after, target, ...rest);
      },
    );
  });

  afterEach(() => {
    index.close();
    context.close();
    writer.close();
    fixture.cleanup();
  });

  it("ignores writes that search never reads without rebuilding or re-indexing", async () => {
    writer.prepare("UPDATE message SET is_read = 1, date_read = ? WHERE ROWID = 1").run(appleNanoseconds("2026-04-02T00:00:00Z"));
    writer.prepare("UPDATE chat SET state = 3 WHERE ROWID = 1").run();
    expect((await search("hello literal")).total).toBe(1);
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(populated).toEqual([]);
  });

  it("re-indexes only the bucket holding an edited message", async () => {
    writer.prepare("UPDATE message SET text = 'third bucket edited', date_edited = 1 WHERE ROWID = 600").run();
    expect((await search("third bucket edited")).total).toBe(1);
    expect((await search("third bucket seed", { mode: "token" })).total).toBe(0);
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(populated).toEqual([[511, 600]]);
    await expectParity();
  });

  it("indexes appends and drops deleted and retracted messages", async () => {
    insertMessage(900, "appended later");
    writer.prepare("DELETE FROM chat_message_join WHERE message_id = 300").run();
    writer.prepare("DELETE FROM message WHERE ROWID = 300").run();
    writer.prepare("UPDATE message SET date_retracted = 1 WHERE ROWID = 2").run();
    expect((await search("appended later")).total).toBe(1);
    expect((await search("second bucket seed")).total).toBe(0);
    expect((await search("reply one")).total).toBe(0);
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(populated).toEqual([[0, 511], [767, 900]]);
    await expectParity();
  });

  it("follows conversation renames, new participants, and attachment names", async () => {
    writer.prepare("UPDATE chat SET display_name = 'Renamed Refresh Group' WHERE ROWID = 4").run();
    writer.prepare("INSERT INTO handle(ROWID,id) VALUES (9,'+15550000009')").run();
    writer.prepare("INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (4,9)").run();
    writer.prepare("UPDATE attachment SET transfer_name = 'renamed-refresh.heic' WHERE ROWID = 1").run();
    expect((await search("Renamed Refresh Group", { scopes: ["conversation_names"] })).total).toBe(3);
    expect((await search("Synthetic Group", { scopes: ["conversation_names"] })).total).toBe(0);
    expect((await search("renamed-refresh", { scopes: ["attachment_filenames"] })).total).toBe(1);
    expect(onBuild).toHaveBeenCalledTimes(1);
    await expectParity();
  });

  it("moves a message between conversations", async () => {
    writer.prepare("UPDATE chat_message_join SET chat_id = 4 WHERE message_id = 300").run();
    expect((await search("second bucket seed")).total).toBe(1);
    const chats = internals(index).index.prepare("SELECT chat_ids FROM message_text WHERE rowid IN (300, 600)").all();
    expect(chats).toEqual([{ chat_ids: "[4]" }, { chat_ids: "[4]" }]);
    await expectParity();
  });

  it("rolls a failed strict refresh back and recovers once the source is fixed", async () => {
    await index.ensure(false);
    const before = snapshot(index);
    insertMessage(901, null, 1, Buffer.from("not an archived attributed string"));
    await expect(search("hello literal", { allowPartial: false })).rejects.toMatchObject({ reason: "DECODE_FAILED" });
    expect(snapshot(index)).toEqual(before);

    const partial = await search("hello literal");
    expect(partial.warnings).toEqual([expect.objectContaining({ code: "DECODE_FAILED", skipped_count: 1 })]);
    await expectParity();

    writer.prepare("UPDATE message SET text = 'repaired body' WHERE ROWID = 901").run();
    const repaired = await search("repaired body", { allowPartial: false });
    expect(repaired.total).toBe(1);
    expect(repaired.warnings).toEqual([]);
    expect(onBuild).toHaveBeenCalledTimes(1);
    await expectParity();
  });
});
