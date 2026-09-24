import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, linkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import Database from "../src/sqlite.js";
import { DEFAULT_DATABASE_PATH, resolveDefaultDatabasePath, runtimeConfig } from "../src/config.js";
import { doctor } from "../src/commands/doctor.js";
import { serviceFamily } from "../src/contracts.js";
import { UnifiedContactResolver } from "../src/contacts.js";
import { assertCopiedDatabaseSourceBoundary, DatabaseContext } from "../src/database.js";
import { MessageTextDecoder } from "../src/decoder.js";
import { MAX_CURSOR_LENGTH, MAX_SYNC_CURSOR_LENGTH } from "../src/references.js";
import { estimateSearchIndexFloor, MemorySearchIndex } from "../src/search-index.js";
import { LocalToolRuntime } from "../src/runtime.js";
import { APPLE_EPOCH_UNIX_SECONDS, appleTimestampToIso, compileDateBounds } from "../src/time.js";
import { MAX_ATTRIBUTED_BODY_BYTES } from "../src/limits.js";
import { analyze } from "../src/repositories/analytics.js";
import { ConversationCatalog, listConversations } from "../src/repositories/conversations.js";
import { getConversationEvents } from "../src/repositories/messages.js";
import {
  appleNanoseconds,
  createFixture,
  createMinimalSchemaFixture,
  foundationAttributedBody,
  foundationAttributedBodyWithRuns,
  foundationEditSummary,
  foundationLegacyDateArchive,
  type Fixture,
  foundationAttributedBodyFromStdin,
  foundationEmptyAttributedBody,
} from "./fixture.js";


function markMessagesRecentlyMutable(databasePath: string, rowids: number[]): number {
  const base = appleNanoseconds(new Date(Date.now() - 2 * 60 * 1000).toISOString());
  const db = new Database(databasePath);
  try {
    const updateMessage = db.prepare("UPDATE message SET date=? WHERE ROWID=?");
    const updateJoin = db.prepare("UPDATE chat_message_join SET message_date=? WHERE message_id=?");
    db.transaction(() => {
      rowids.forEach((rowid, index) => {
        const date = base + index * 1_000_000;
        updateMessage.run(date, rowid);
        updateJoin.run(date, rowid);
      });
    })();
  } finally {
    db.close();
  }
  return base;
}

function appendRecentMessages(
  databasePath: string,
  count: number,
  startRowid = 21,
  dateOffsetMs = 0,
): void {
  const base = appleNanoseconds(new Date(Date.now() - 2 * 60 * 1000 + dateOffsetMs).toISOString());
  const db = new Database(databasePath);
  try {
    const insertMessage = db.prepare(
      "INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (?,?,?,?,?,0,'iMessage')",
    );
    const insertJoin = db.prepare(
      "INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,?,?,0)",
    );
    db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const rowid = startRowid + index;
        const date = base + index * 1_000_000;
        insertMessage.run(rowid, `recent-${rowid}`, "recent bounded body", 1, date);
        insertJoin.run(rowid, date);
      }
    })();
  } finally {
    db.close();
  }
}

describe("2.0 data and query core", () => {
  let fixture: Fixture;
  let context: DatabaseContext;
  let contacts: UnifiedContactResolver;
  let decoder: MessageTextDecoder;

  beforeAll(() => {
    fixture = createFixture();
    const config = runtimeConfig({
      transport: "stdio",
      databasePath: fixture.databasePath,
      contacts: "none",
    });
    context = new DatabaseContext(config.database_path);
    contacts = new UnifiedContactResolver(false);
    decoder = new MessageTextDecoder();
  });

  afterAll(() => {
    context.close();
    fixture.cleanup();
  });

  it("compiles inclusive local dates through the exclusive next midnight across DST", () => {
    const bounds = compileDateBounds({ date_from: "2026-03-08", date_to: "2026-03-08", timezone: "America/New_York" });
    expect(bounds.to_unix_seconds! - bounds.from_unix_seconds!).toBe(23 * 3600);
    expect(() => appleTimestampToIso(Number.MAX_VALUE))
      .toThrowError(expect.objectContaining({ reason: "UNSUPPORTED_SCHEMA" }));
  });

  it("recognizes the default Messages path as live and rejects Contacts for other copied databases", () => {
    const explicit = runtimeConfig({
      transport: "stdio",
      databasePath: DEFAULT_DATABASE_PATH,
      contacts: "none",
    });
    expect(explicit.source_mode).toBe("live");
    expect(() => runtimeConfig({
      transport: "stdio",
      databasePath: path.join(fixture.directory, "copied-chat.db"),
      contacts: "live",
    })).toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
  });

  it("derives the live Messages path from the OS account instead of HOME", () => {
    const previousHome = process.env.HOME;
    process.env.HOME = fixture.directory;
    try {
      expect(resolveDefaultDatabasePath()).toBe(path.join(userInfo().homedir, "Library", "Messages", "chat.db"));
      expect(resolveDefaultDatabasePath()).not.toBe(path.join(fixture.directory, "Library", "Messages", "chat.db"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("warns before an oversized archive fails its first search", async () => {
    const capacityFixture = createFixture();
    const capacityConfig = runtimeConfig({
      transport: "stdio",
      databasePath: capacityFixture.databasePath,
      contacts: "none",
    });
    const capacityContext = new DatabaseContext(capacityFixture.databasePath);
    const request = capacityContext.request();
    let estimated = 0;
    try {
      const estimate = estimateSearchIndexFloor(request);
      estimated = estimate.estimated_bytes;
      expect(estimate.rows).toBeGreaterThan(0);
      expect(estimated).toBeGreaterThan(estimate.rows * 224);
    } finally {
      request.close();
      capacityContext.close();
    }

    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const run = async (
      json: boolean,
      limitBytes?: number,
    ): Promise<{ code: number; text: string }> => {
      output.length = 0;
      const code = await doctor(capacityConfig, json, { searchIndexMemoryLimitBytes: limitBytes });
      return { code, text: output.join("") };
    };
    const capacityOf = (text: string): { name: string; status: string; detail: string } => {
      const parsed = JSON.parse(text) as { checks: Array<{ name: string; status: string; detail: string }> };
      return parsed.checks.find((check) => check.name === "search_index_capacity")!;
    };
    try {
      const healthy = capacityOf((await run(true)).text);
      expect(healthy.status).toBe("pass");
      expect(healthy.detail).toMatch(/indexable messages need at least .+ against the .+ in-memory search ceiling$/u);

      const near = capacityOf((await run(true, Math.ceil(estimated / 0.95))).text);
      expect(near.status).toBe("warn");
      expect(near.detail).toMatch(/may fail with INDEX_TOO_LARGE$/u);
      expect(near.detail).toContain(`${estimated} bytes`);

      const over = await run(false, Math.floor(estimated / 2));
      expect(over.code).toBe(1);
      expect(over.text).toMatch(
        new RegExp(`^fail search_index_capacity: .+${estimated} bytes.+will fail with INDEX_TOO_LARGE$`, "mu"),
      );
    } finally {
      stdout.mockRestore();
      capacityFixture.cleanup();
    }
  });

  it("retains ambiguous unified contacts instead of guessing", () => {
    const resolver = new UnifiedContactResolver(true, [
      { identifier: "a", name: "Alex", phones: ["+1 555 111 0000"], emails: [] },
      { identifier: "b", name: "Alex", phones: ["+1 555 222 0000"], emails: [] },
    ]);
    const result = resolver.resolve("Alex");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  it("treats duplicate cards with the same name and a shared handle as one person", () => {
    const resolver = new UnifiedContactResolver(true, [
      { identifier: "icloud", name: "Sam Rivera", phones: ["+1 555 111 0000"], emails: ["sam@example.test"] },
      { identifier: "google", name: "Sam Rivera", phones: ["+15551110000"], emails: [] },
      { identifier: "other", name: "Sam Rivera", phones: ["+1 555 999 0000"], emails: [] },
    ]);
    const result = resolver.resolve("Sam Rivera");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates).toHaveLength(2);
    const twins = new UnifiedContactResolver(true, [
      { identifier: "icloud", name: "Sam Rivera", phones: ["+1 555 111 0000"], emails: [] },
      { identifier: "google", name: "Sam Rivera", phones: ["+15551110000"], emails: ["sam@example.test"] },
    ]);
    const merged = twins.resolve("Sam");
    expect(merged.status).toBe("unique");
    if (merged.status === "unique") expect(merged.contact.handles).toHaveLength(2);
  });

  it("keeps two people who share a landline apart", () => {
    const resolver = new UnifiedContactResolver(true, [
      { identifier: "a", name: "Pat Lee", phones: ["+1 555 222 0000"], emails: [] },
      { identifier: "b", name: "Jo Lee", phones: ["+1 555 222 0000"], emails: [] },
    ]);
    expect(resolver.resolve("Lee").status).toBe("ambiguous");
  });

  it("keeps international phone identities distinct", () => {
    const resolver = new UnifiedContactResolver(true, [
      { identifier: "gb", name: "London", phones: ["+44 20 1234 5678"], emails: [] },
      { identifier: "in", name: "Delhi", phones: ["+91 20 1234 5678"], emails: [] },
    ]);
    expect(resolver.resolve("+44 20 1234 5678")).toMatchObject({
      status: "unique",
      contact: { name: "London" },
    });
  });

  it("resolves names containing digits as names instead of partial phone handles", () => {
    const resolver = new UnifiedContactResolver(true, [
      { identifier: "agent", name: "Agent 47", phones: ["+1 555 000 0047"], emails: [] },
    ]);
    expect(resolver.resolve("Agent 47")).toMatchObject({
      status: "unique",
      contact: { name: "Agent 47", match: "exact_name" },
    });
  });

  it("resolves normalized database handles when Contacts is not paired", async () => {
    const runtime = new LocalToolRuntime(
      runtimeConfig({
        transport: "stdio",
        databasePath: fixture.databasePath,
        contacts: "none",
      }),
    );
    try {
      const result = await runtime.call("resolve_contact", { query: "555-000-0001", privacy_mode: "full" });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        data: { status: "unique", contact: { name: null, handles: ["+15550000001"] } },
      });
    } finally {
      runtime.close();
    }
  });

  it("fails closed on name filters when unified Contacts is unavailable", async () => {
    const runtime = new LocalToolRuntime(
      runtimeConfig({
        transport: "stdio",
        databasePath: fixture.databasePath,
        contacts: "none",
      }),
    );
    try {
      const result = await runtime.call("list_conversations", {
        contact: "Alice Example",
        limit: 50,
        privacy_mode: "full",
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { reason: "UNSUPPORTED_SCHEMA" } },
      });
    } finally {
      runtime.close();
    }
  });

  it("establishes the cached-watermark read snapshot before returning a request", () => {
    const isolated = createFixture();
    const setup = new Database(isolated.databasePath);
    setup.pragma("journal_mode = WAL");
    const before = setup.prepare("SELECT text FROM message WHERE ROWID = 1").pluck().get();
    setup.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath, "live");
    try {
      // Warm the cached-watermark path, then open a request whose first
      // consumer query is deliberately delayed until after another connection
      // commits. The request must retain the earlier SQLite snapshot.
      const warm = isolatedContext.request();
      warm.close();
      const request = isolatedContext.request();

      const writer = new Database(isolated.databasePath);
      writer.prepare("UPDATE message SET text = ? WHERE ROWID = 1").run("committed after request creation");
      writer.close();

      expect(request.db.prepare("SELECT text FROM message WHERE ROWID = 1").pluck().get()).toBe(before);
      request.close();

      const next = isolatedContext.request();
      expect(next.db.prepare("SELECT text FROM message WHERE ROWID = 1").pluck().get())
        .toBe("committed after request creation");
      next.close();
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("binds request snapshots to one canonical regular-file identity", () => {
    const isolated = createFixture();
    const link = path.join(isolated.directory, "selected.db");
    const alternate = path.join(isolated.directory, "alternate.db");
    const original = path.join(isolated.directory, "original.db");
    copyFileSync(isolated.databasePath, alternate);
    symlinkSync(isolated.databasePath, link);
    const linkedContext = new DatabaseContext(link);
    try {
      unlinkSync(link);
      symlinkSync(alternate, link);
      linkedContext.request().close();
      renameSync(isolated.databasePath, original);
      copyFileSync(original, isolated.databasePath);
      expect(() => linkedContext.request()).toThrowError(expect.objectContaining({ reason: "DATABASE_CHANGED" }));
    } finally {
      linkedContext.close();
      isolated.cleanup();
    }
  });

  it("rejects copied database aliases to a synthetic live database before opening SQLite", () => {
    const live = createFixture();
    const copied = createFixture();
    const directLink = path.join(copied.directory, "live-link.db");
    const linkedParent = path.join(copied.directory, "live-parent");
    const hardLink = path.join(copied.directory, "live-hardlink.db");
    symlinkSync(live.databasePath, directLink);
    symlinkSync(live.directory, linkedParent, "dir");
    linkSync(live.databasePath, hardLink);
    try {
      for (const selectedPath of [
        live.databasePath,
        directLink,
        path.join(linkedParent, "chat.db"),
        hardLink,
      ]) {
        expect(() => assertCopiedDatabaseSourceBoundary(selectedPath, live.databasePath))
          .toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
      }
    } finally {
      live.cleanup();
      copied.cleanup();
    }
  });

  it("keeps ordinary copies and symlinks to non-live copies supported", () => {
    const live = createFixture();
    const copied = createFixture();
    const copiedLink = path.join(copied.directory, "copied-link.db");
    symlinkSync(copied.databasePath, copiedLink);
    try {
      for (const selectedPath of [copied.databasePath, copiedLink]) {
        expect(() => assertCopiedDatabaseSourceBoundary(selectedPath, live.databasePath)).not.toThrow();
      }
      const copiedContext = new DatabaseContext(copiedLink, "copy");
      copiedContext.close();
    } finally {
      live.cleanup();
      copied.cleanup();
    }
  });

  it("rejects copied WAL aliases to a synthetic live WAL before opening SQLite", () => {
    const live = createFixture();
    const copied = createFixture();
    const liveWal = `${live.databasePath}-wal`;
    const copiedWal = `${copied.databasePath}-wal`;
    try {
      symlinkSync(liveWal, copiedWal);
      expect(() => assertCopiedDatabaseSourceBoundary(copied.databasePath, live.databasePath))
        .toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));

      unlinkSync(copiedWal);
      writeFileSync(liveWal, "synthetic live WAL identity");
      symlinkSync(liveWal, copiedWal);
      expect(() => assertCopiedDatabaseSourceBoundary(copied.databasePath, live.databasePath))
        .toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));

      unlinkSync(copiedWal);
      linkSync(liveWal, copiedWal);
      expect(() => assertCopiedDatabaseSourceBoundary(copied.databasePath, live.databasePath))
        .toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));

      unlinkSync(copiedWal);
      writeFileSync(copiedWal, "synthetic copied WAL identity");
      expect(() => assertCopiedDatabaseSourceBoundary(copied.databasePath, live.databasePath)).not.toThrow();
    } finally {
      live.cleanup();
      copied.cleanup();
    }
  });

  it("preserves database-unavailable errors for missing and dangling copied paths", () => {
    const live = createFixture();
    const copied = createFixture();
    const missing = path.join(copied.directory, "missing.db");
    const dangling = path.join(copied.directory, "dangling.db");
    symlinkSync(missing, dangling);
    try {
      for (const selectedPath of [missing, dangling]) {
        expect(() => assertCopiedDatabaseSourceBoundary(selectedPath, live.databasePath))
          .toThrowError(expect.objectContaining({ reason: "DATABASE_UNAVAILABLE" }));
      }
    } finally {
      live.cleanup();
      copied.cleanup();
    }
  });

  it("merges only Apple-linked service variants and includes incoming-only chats", () => {
    const listed = listConversations({
      context,
      contacts,
      filters: { bounds: compileDateBounds({ timezone: "America/New_York" }) },
      limit: 50,
      privacy: "full",
    });
    expect(listed.conversations).toHaveLength(4);
    const linked = listed.conversations.find((conversation) => conversation.service_families.includes("imessage") && conversation.service_families.includes("sms"));
    expect(linked).toBeDefined();
    expect(linked!.chat_id).toBe(1);
    const incomingOnly = listed.conversations.find((conversation) => conversation.participants.some((participant) => participant.handle === "unknown@example.test"));
    expect(incomingOnly?.replied).toBe(false);
    const group = listed.conversations.find((conversation) => conversation.kind === "group");
    expect(group).toMatchObject({ message_count: 2, system_event_count: 2 });
    expect(serviceFamily("not-iMessage-compatible")).toBe("unknown");
  });

  it("applies service filters to activity inside the selected local-date range", () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    const moved = appleNanoseconds("2026-03-10T07:30:00Z");
    db.prepare("UPDATE message SET date=? WHERE ROWID=4").run(moved);
    db.prepare("UPDATE chat_message_join SET message_date=? WHERE message_id=4").run(moved);
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      const listed = listConversations({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        filters: {
          service: "sms",
          bounds: compileDateBounds({ date_from: "2026-03-08", date_to: "2026-03-08", timezone: "UTC" }),
        },
        limit: 50,
        privacy: "full",
      });
      expect(listed.conversations).toEqual([]);
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("keeps one-nanosecond and one-second date boundaries exact across every query surface", async () => {
    const isolated = createFixture();
    const midnightUnix = Date.parse("2026-03-08T00:00:00Z") / 1000;
    const midnightSeconds = midnightUnix - APPLE_EPOCH_UNIX_SECONDS;
    const midnightNanoseconds = BigInt(midnightSeconds) * 1_000_000_000n;
    const oldNanoseconds = midnightNanoseconds - 2n * 86_400n * 1_000_000_000n;
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET date=?").run(oldNanoseconds);
    db.prepare("UPDATE chat_message_join SET message_date=?").run(oldNanoseconds);
    db.prepare("UPDATE message SET text='boundary nanos before', date=? WHERE ROWID=1").run(midnightNanoseconds - 1n);
    db.prepare("UPDATE message SET text='boundary nanos included', date=? WHERE ROWID=2").run(midnightNanoseconds);
    db.prepare("UPDATE message SET text='boundary seconds before', date=? WHERE ROWID=3").run(midnightSeconds - 1);
    db.prepare("UPDATE message SET text='boundary seconds included', date=? WHERE ROWID=4").run(midnightSeconds);
    for (const rowid of [1, 2, 3, 4]) {
      const date = rowid === 1
        ? midnightNanoseconds - 1n
        : rowid === 2
          ? midnightNanoseconds
          : rowid === 3
            ? midnightSeconds - 1
            : midnightSeconds;
      db.prepare("UPDATE chat_message_join SET message_date=? WHERE message_id=?").run(date, rowid);
    }
    db.close();

    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const isolatedContacts = new UnifiedContactResolver(false);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), isolatedContacts);
    const bounds = compileDateBounds({ date_from: "2026-03-08", date_to: "2026-03-08", timezone: "UTC" });
    try {
      const listed = listConversations({
        context: isolatedContext,
        contacts: isolatedContacts,
        filters: { bounds },
        limit: 50,
        privacy: "full",
      });
      expect(listed.conversations).toEqual([
        expect.objectContaining({ message_count: 2 }),
      ]);

      const timeline = await getConversationEvents({
        context: isolatedContext,
        contacts: isolatedContacts,
        decoder: new MessageTextDecoder(),
        chatIds: [1, 2],
        limit: 50,
        bounds,
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      });
      expect(timeline.events.map((event) => event.text)).toEqual([
        "boundary nanos included",
        "boundary seconds included",
      ]);

      const searched = await index.search({
        query: "boundary",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(searched.hits.map((hit) => hit.snippet)).toEqual(expect.arrayContaining([
        expect.stringContaining("boundary nanos included"),
        expect.stringContaining("boundary seconds included"),
      ]));
      expect(searched.hits).toHaveLength(2);

      const counts = analyze({
        context: isolatedContext,
        scope: { kind: "global" },
        metric: "message_count",
        bounds,
        sessionGapHours: 8,
      });
      expect(Number(counts.overall.messages)).toBe(2);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("deduplicates messages joined to multiple Apple-linked chat records", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET service=NULL WHERE ROWID=1").run();
    db.prepare(
      "INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) SELECT 2,1,date,0 FROM message WHERE ROWID=1",
    ).run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const isolatedContacts = new UnifiedContactResolver(false);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), isolatedContacts);
    try {
      const listed = listConversations({
        context: isolatedContext,
        contacts: isolatedContacts,
        filters: { bounds: compileDateBounds({ timezone: "UTC" }) },
        limit: 50,
        privacy: "full",
      });
      const linked = listed.conversations.find((conversation) =>
        conversation.service_families.includes("imessage") && conversation.service_families.includes("sms")
      );
      expect(linked).toMatchObject({ message_count: 11, system_event_count: 0 });

      const timeline = await getConversationEvents({
        context: isolatedContext,
        contacts: isolatedContacts,
        decoder: new MessageTextDecoder(),
        chatIds: [1, 2],
        limit: 200,
        bounds: compileDateBounds({ timezone: "UTC" }),
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      });
      expect(timeline.events).toHaveLength(11);
      expect(timeline.events.filter((event) => event.text?.startsWith("hello literal"))).toEqual([
        expect.objectContaining({ service_family: "unknown" }),
      ]);
      expect(new Set(timeline.events.map((event) => event.message_id)).size).toBe(11);

      const counts = analyze({
        context: isolatedContext,
        scope: { kind: "conversation", chatIds: [1, 2] },
        metric: "message_count",
        bounds: compileDateBounds({ timezone: "UTC" }),
        sessionGapHours: 8,
      });
      expect(counts.overall).toMatchObject({ messages: 11, reaction_events: 3, system_events: 0 });
      const searched = await index.search({
        query: "hello literal",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(searched.hits).toEqual([expect.objectContaining({ service_family: "unknown" })]);
      expect(searched.hits[0].chat_id).toBe(1);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("fails closed instead of merging message relationships Apple did not link", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare(
      "INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) SELECT 3,1,date,0 FROM message WHERE ROWID=1",
    ).run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const isolatedContacts = new UnifiedContactResolver(false);
    const isolatedDecoder = new MessageTextDecoder();
    const index = new MemorySearchIndex(isolatedContext, isolatedDecoder, isolatedContacts);
    const unsupported = { reason: "UNSUPPORTED_SCHEMA" };
    try {
      expect(() => listConversations({
        context: isolatedContext,
        contacts: isolatedContacts,
        filters: { bounds: compileDateBounds({ timezone: "UTC" }) },
        limit: 50,
        privacy: "full",
      })).toThrowError(expect.objectContaining(unsupported));
      expect(() => analyze({
        context: isolatedContext,
        scope: { kind: "global" },
        metric: "message_count",
        bounds: compileDateBounds({ timezone: "UTC" }),
        sessionGapHours: 8,
      })).toThrowError(expect.objectContaining(unsupported));
      await expect(index.search({
        query: "hello",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject(unsupported);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("keeps Apple group-style chats grouped after membership shrinks", () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE chat SET style=43, display_name=NULL, group_id=NULL WHERE ROWID=4").run();
    db.prepare("DELETE FROM chat_handle_join WHERE chat_id=4 AND handle_id=2").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      const listed = listConversations({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        filters: { bounds: compileDateBounds({ timezone: "UTC" }) },
        limit: 50,
        privacy: "full",
      });
      expect(listed.conversations.find((conversation) => conversation.service_families.includes("rcs"))?.kind).toBe("group");
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("resolves one named Apple-linked component instead of treating linked chats as ambiguous", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE chat SET display_name='Linked Alice' WHERE ROWID IN (1,2)").run();
    db.close();
    const runtime = new LocalToolRuntime(
      runtimeConfig({
        transport: "stdio",
        databasePath: isolated.databasePath,
        contacts: "none",
      }),
    );
    try {
      const result = await runtime.call("get_conversation", {
        query: "Linked Alice",
        limit: 200,
        allow_partial: false,
        privacy_mode: "full",
      });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent?.data as { events: unknown[] }).events).toHaveLength(11);
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("ranks conversations by message count and pages through that order", async () => {
    const isolated = createFixture();
    const runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: isolated.databasePath, contacts: "none" }));
    try {
      const first = await runtime.call("list_conversations", { order: "most_messages", limit: 1, privacy_mode: "full" });
      const firstData = first.structuredContent as { data: { conversations: Array<{ chat_id: number; message_count: number }> }; page?: { next_cursor?: string } };
      const all = await runtime.call("list_conversations", { order: "most_messages", limit: 50, privacy_mode: "full" });
      const counts = (all.structuredContent as { data: { conversations: Array<{ message_count: number }> } }).data.conversations.map((row) => row.message_count);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
      expect(firstData.data.conversations[0].message_count).toBe(counts[0]);
      const second = await runtime.call("list_conversations", { order: "most_messages", limit: 1, cursor: firstData.page?.next_cursor, privacy_mode: "full" });
      const secondRow = (second.structuredContent as { data: { conversations: Array<{ chat_id: number }> } }).data.conversations[0];
      expect(secondRow.chat_id).not.toBe(firstData.data.conversations[0].chat_id);
      const mixed = await runtime.call("list_conversations", { order: "recent", limit: 1, cursor: firstData.page?.next_cursor, privacy_mode: "full" });
      expect((mixed.structuredContent as { error: { reason: string } }).error.reason).toBe("INVALID_INPUT");
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("lists each conversation with its latest message, text removed when redacted", async () => {
    const isolated = createFixture();
    const runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: isolated.databasePath, contacts: "none" }));
    try {
      type Listed = { data: { conversations: Array<{ chat_id: number; latest_message?: { message_id: number; direction: string; text?: string } }> } };
      const full = (await runtime.call("list_conversations", { limit: 50, privacy_mode: "full" })).structuredContent as Listed;
      const linked = full.data.conversations.find((row) => row.chat_id === 1);
      expect(linked?.latest_message).toMatchObject({ message_id: 20, direction: "incoming", text: "the exact phrase lives here" });
      const redacted = (await runtime.call("list_conversations", { limit: 50, privacy_mode: "redacted" })).structuredContent as Listed;
      const masked = redacted.data.conversations.find((row) => row.chat_id === 1);
      expect(masked?.latest_message?.direction).toBe("incoming");
      expect(masked?.latest_message).not.toHaveProperty("text");
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("breaks message counts down by local hour and weekday", async () => {
    const isolated = createFixture();
    const runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: isolated.databasePath, contacts: "none" }));
    try {
      const result = await runtime.call("analyze_communication", { metric: "message_count", scope: "global", timezone: "UTC", privacy_mode: "full" });
      const overall = (result.structuredContent as { data: { overall: { messages: number; by_hour: number[]; by_weekday: Record<string, number> } } }).data.overall;
      expect(overall.by_hour).toHaveLength(24);
      expect(overall.by_hour.reduce((a, b) => a + b, 0)).toBe(overall.messages);
      expect(Object.values(overall.by_weekday).reduce((a, b) => a + b, 0)).toBe(overall.messages);
      // 2026-03-08T06:30Z, the first fixture message, is a Sunday at 6 in UTC.
      expect(overall.by_hour[6]).toBeGreaterThan(0);
      expect(overall.by_weekday.sun).toBeGreaterThan(0);
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("reads the one-to-one chat when a person in a group chat too is named", async () => {
    const isolated = createFixture();
    const runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: isolated.databasePath, contacts: "none" }));
    try {
      const result = await runtime.call("get_conversation", { query: "+15550000001", limit: 5, privacy_mode: "full" });
      expect(result.isError).toBeUndefined();
      const data = (result.structuredContent as { data: { conversation: { kind: string; handle?: string } } }).data;
      expect(data.conversation).toMatchObject({ kind: "direct", handle: "+15550000001" });
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("names each search hit's conversation and masks an unnamed handle when redacted", async () => {
    const isolated = createFixture();
    const runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: isolated.databasePath, contacts: "none" }));
    try {
      type Hits = { data: { results: Array<{ snippet?: string; conversation?: { name: string | null; kind: string; handle?: string } }> } };
      const group = (await runtime.call("search_messages", { query: "group hello", mode: "substring", scopes: ["text"], order: "newest", limit: 5, privacy_mode: "full" })).structuredContent as Hits;
      expect(group.data.results[0].conversation).toEqual({ name: "Synthetic Group", kind: "group" });
      const direct = (await runtime.call("search_messages", { query: "reply one", mode: "substring", scopes: ["text"], order: "newest", limit: 5, privacy_mode: "full" })).structuredContent as Hits;
      expect(direct.data.results[0].conversation).toEqual({ name: null, kind: "direct", handle: "+15550000001" });
      const redacted = (await runtime.call("search_messages", { query: "reply one", mode: "substring", scopes: ["text"], order: "newest", limit: 5, privacy_mode: "redacted" })).structuredContent as Hits;
      expect(redacted.data.results[0].conversation?.handle).toMatch(/^\[masked:/u);
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("trims a large page to the result budget and keeps the cursor working", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    const insert = db.prepare("INSERT INTO message(ROWID, guid, text, handle_id, date, service) VALUES (?, ?, ?, 1, ?, 'iMessage')");
    const join = db.prepare("INSERT INTO chat_message_join(chat_id, message_id, message_date) VALUES (1, ?, ?)");
    // One transaction: 500 autocommits each sync the journal to disk, which alone
    // pushed this test past its timeout on a busy runner.
    db.transaction(() => {
      for (let i = 0; i < 250; i += 1) {
        const rowid = 1000 + i;
        const date = appleNanoseconds("2026-04-01T00:00:00Z") + i * 60_000_000_000;
        insert.run(rowid, `long-${i}`, `long message ${i} ${"x".repeat(600)}`, date);
        join.run(rowid, date);
      }
    })();
    db.close();
    const runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: isolated.databasePath, contacts: "none" }));
    try {
      const result = await runtime.call("get_conversation", { chat_id: 1, limit: 200, privacy_mode: "full" });
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as { text: string }).text;
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(40_000);
      const structured = result.structuredContent as { warnings?: Array<{ code: string }>; page?: { next_cursor?: string } };
      expect(structured.warnings?.map((warning) => warning.code)).toContain("RESULT_TRIMMED");
      expect(JSON.parse(text)).toEqual(structured);
      expect(structured.page?.next_cursor).toBeTruthy();
      const next = await runtime.call("get_conversation", { chat_id: 1, limit: 20, cursor: structured.page?.next_cursor, privacy_mode: "full" });
      expect(next.isError).toBeUndefined();
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("tells the caller which tool resolves an ambiguous conversation query", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    const chats = db.prepare("SELECT ROWID FROM chat ORDER BY ROWID").pluck().all() as number[];
    db.prepare(`UPDATE chat SET display_name='Twin' WHERE ROWID IN (${chats[0]}, ${chats.at(-1)})`).run();
    db.close();
    const runtime = new LocalToolRuntime(runtimeConfig({ transport: "stdio", databasePath: isolated.databasePath, contacts: "none" }));
    try {
      const result = await runtime.call("get_conversation", { query: "Twin", limit: 20, privacy_mode: "full" });
      expect(result.isError).toBe(true);
      expect((result.structuredContent?.error as { reason: string }).reason).toBe("AMBIGUOUS_CONTACT");
      expect((result.content[0] as { text: string }).text).toContain("call list_conversations");
    } finally {
      runtime.close();
      isolated.cleanup();
    }
  });

  it("counts flag-only system records separately from user messages", () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET is_system_message=1, item_type=0 WHERE ROWID=8").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      const listed = listConversations({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        filters: { bounds: compileDateBounds({ timezone: "UTC" }) },
        limit: 50,
        privacy: "full",
      });
      const unknown = listed.conversations.find((conversation) => conversation.service_families.includes("unknown"));
      expect(unknown).toMatchObject({ message_count: 0, system_event_count: 1 });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("keeps flag-only system records out of message filters and classifies titled changes consistently", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET is_system_message=1, item_type=0, group_title='New title' WHERE ROWID=8").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const base = {
      context: isolatedContext,
      contacts: new UnifiedContactResolver(false),
      decoder: new MessageTextDecoder(),
      chatIds: [5],
      limit: 50,
      bounds: compileDateBounds({ timezone: "UTC" }),
      allowPartial: false,
      privacy: "full" as const,
      includeAttachmentPaths: false,
    };
    try {
      expect((await getConversationEvents({ ...base, eventFilters: ["message"] })).events).toEqual([]);
      expect((await getConversationEvents({ ...base, eventFilters: ["group_renamed"] })).events).toEqual([
        expect.objectContaining({ event_type: "group_renamed", system: expect.objectContaining({ title: "New title" }) }),
      ]);
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("rejects oversized participant components before JSON aggregation", () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    const insertHandle = db.prepare("INSERT INTO handle(ROWID,id) VALUES (?,?)");
    const insertJoin = db.prepare("INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (1,?)");
    db.transaction(() => {
      for (let index = 0; index <= 1_000; index += 1) {
        const rowid = 100 + index;
        insertHandle.run(rowid, `oversized-${index}@example.test`);
        insertJoin.run(rowid);
      }
    })();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      expect(() => listConversations({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        filters: { bounds: compileDateBounds({ timezone: "UTC" }) },
        limit: 50,
        privacy: "full",
      })).toThrowError(expect.objectContaining({ reason: "QUERY_BUDGET_EXCEEDED" }));
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("returns newest-selected events chronologically with visible-state lifecycle folding", async () => {
    const result = await getConversationEvents({
      context,
      contacts,
      decoder,
      chatIds: [1, 2],
      limit: 200,
      bounds: compileDateBounds({ timezone: "UTC" }),
      allowPartial: false,
      privacy: "full",
      includeAttachmentPaths: false,
    });
    expect(result.events.map((event) => event.timestamp)).toEqual([...result.events.map((event) => event.timestamp)].sort());
    const first = result.events.find((event) => event.text?.startsWith("hello literal"));
    expect(first?.reactions?.map((reaction) => reaction.type)).toEqual(["like"]);
    expect(first?.receipt).toMatchObject({ capability: "available", direction: "local", state: "delivered" });
    expect(result.events.find((event) => event.text === "reply one")?.receipt)
      .toMatchObject({ capability: "available", direction: "remote", state: "sent" });
    const blob = result.events.find((event) => event.text?.startsWith("blob exact"));
    expect(blob?.text).toBe("blob exact ✨\nsecond line");
    const retracted = result.events.find((event) => event.event_type === "retraction");
    expect(retracted).not.toHaveProperty("text");
    expect(retracted?.retraction?.state).toBe("retracted");
    expect(result.events.find((event) => event.text === "thread reply")?.reply_to_message_id).toBe(1);
    expect(result.events.find((event) => event.text === "receipt target")?.receipt?.state).toBe("read");
    // An unedited message carries no edit field; SMS edit support lives in server_status.
    expect(result.events.find((event) => event.text === "green sms")).not.toHaveProperty("edit");
    expect(result.events.find((event) => event.text === "edited current")?.edit).toEqual({
      state: "available",
      count: 1,
      timestamps: ["2026-03-09T04:06:00.000Z"],
    });
  });

  it("fails closed on malformed selected bodies and reports exact partial rows when allowed", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=1").run(Buffer.from("malformed body"));
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const input = {
      context: isolatedContext,
      contacts: new UnifiedContactResolver(false),
      decoder: new MessageTextDecoder(),
      chatIds: [1, 2],
      limit: 200,
      bounds: compileDateBounds({ timezone: "UTC" }),
      privacy: "full" as const,
      includeAttachmentPaths: false,
    };
    try {
      await expect(getConversationEvents({ ...input, allowPartial: false })).rejects.toMatchObject({ reason: "DECODE_FAILED" });
      const partial = await getConversationEvents({ ...input, allowPartial: true });
      expect(partial.warnings).toEqual([
        expect.objectContaining({ code: "DECODE_FAILED", skipped_count: 1 }),
      ]);
      expect(partial.events.find((event) => event.message_id && event.text_status === "malformed"))
        .toMatchObject({ row_status: "partial" });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("fails closed on malformed edit metadata and marks it partial only when requested", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET message_summary_info=? WHERE ROWID=10").run(Buffer.from("malformed edits"));
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const input = {
      context: isolatedContext,
      contacts: new UnifiedContactResolver(false),
      decoder: new MessageTextDecoder(),
      chatIds: [1, 2],
      limit: 200,
      bounds: compileDateBounds({ timezone: "UTC" }),
      privacy: "full" as const,
      includeAttachmentPaths: false,
    };
    try {
      await expect(getConversationEvents({ ...input, allowPartial: false })).rejects.toMatchObject({ reason: "DECODE_FAILED" });
      const partial = await getConversationEvents({ ...input, allowPartial: true });
      expect(partial.warnings).toEqual([
        expect.objectContaining({ code: "DECODE_FAILED", skipped_count: 1 }),
      ]);
      expect(partial.events.find((event) => event.text === "edited current")).toMatchObject({
        row_status: "partial",
        edit: { state: "unknown" },
      });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("budgets reaction actor metadata before materializing selected history", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("INSERT INTO handle(ROWID,id) VALUES (99,?)").run("x".repeat(4_097));
    db.prepare("UPDATE message SET handle_id=99 WHERE ROWID=13").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      await expect(getConversationEvents({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        decoder: new MessageTextDecoder(),
        chatIds: [1, 2],
        limit: 200,
        bounds: compileDateBounds({ timezone: "UTC" }),
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      })).rejects.toMatchObject({ reason: "QUERY_BUDGET_EXCEEDED" });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("fails closed for a dangling incoming reaction actor and omits it only in partial mode", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET handle_id=99 WHERE ROWID=15").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const input = {
      context: isolatedContext,
      contacts: new UnifiedContactResolver(false),
      decoder: new MessageTextDecoder(),
      chatIds: [1, 2],
      limit: 50,
      bounds: compileDateBounds({ timezone: "UTC" }),
      privacy: "full" as const,
      includeAttachmentPaths: false,
    };
    try {
      await expect(getConversationEvents({ ...input, allowPartial: false }))
        .rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
      const partial = await getConversationEvents({ ...input, allowPartial: true });
      const parent = partial.events.find((event) => event.text?.startsWith("hello literal"));
      expect(parent).toMatchObject({ row_status: "partial" });
      expect(parent).not.toHaveProperty("reactions");
      expect(partial.warnings).toContainEqual(expect.objectContaining({
        code: "UNSUPPORTED_SCHEMA",
        skipped_count: 1,
      }));
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("never attributes an unresolved incoming timeline sender to Me", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET handle_id=99 WHERE ROWID=1").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const input = {
      context: isolatedContext,
      contacts: new UnifiedContactResolver(false),
      decoder: new MessageTextDecoder(),
      chatIds: [1, 2],
      limit: 50,
      bounds: compileDateBounds({ timezone: "UTC" }),
      privacy: "full" as const,
      includeAttachmentPaths: false,
    };
    try {
      await expect(getConversationEvents({ ...input, allowPartial: false }))
        .rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
      const partial = await getConversationEvents({ ...input, allowPartial: true });
      expect(partial.events.find((event) => event.text?.startsWith("hello literal"))).toMatchObject({
        direction: "incoming",
        sender: { name: null, handle: null },
        row_status: "partial",
      });
      expect(partial.warnings).toContainEqual(expect.objectContaining({
        code: "UNSUPPORTED_SCHEMA",
        skipped_count: 1,
      }));
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("rejects duplicate message GUIDs before emitting timeline references", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    const date = appleNanoseconds("2026-03-10T07:00:00Z");
    db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                VALUES (21,'m1','duplicate guid',1,?,0,'iMessage')`).run(date);
    db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(date);
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      await expect(getConversationEvents({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        decoder: new MessageTextDecoder(),
        chatIds: [1, 2],
        limit: 50,
        bounds: compileDateBounds({ timezone: "UTC" }),
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      })).rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("returns typed group events and attachment-only user messages", async () => {
    const result = await getConversationEvents({
      context,
      contacts,
      decoder,
      chatIds: [4],
      limit: 50,
      bounds: compileDateBounds({ timezone: "UTC" }),
      allowPartial: false,
      privacy: "full",
      includeAttachmentPaths: false,
    });
    expect(result.events.some((event) => event.event_type === "participant_joined")).toBe(true);
    expect(result.events.some((event) => event.event_type === "group_renamed")).toBe(true);
    const attachmentOnly = result.events.find((event) => event.attachments?.length);
    expect(attachmentOnly?.attachments?.[0]).toMatchObject({ filename: "photo.png", mime_type: "image/png", bytes: 1234 });
    expect(attachmentOnly?.attachments?.[0]).not.toHaveProperty("path");
  });

  it("searches complete exact native text with literal wildcard and explicit scopes", async () => {
    const index = new MemorySearchIndex(context, decoder, contacts);
    const bounds = compileDateBounds({ timezone: "UTC" });
    const wildcard = await index.search({
      query: "%_",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(wildcard.total).toBe(2);
    expect(wildcard.hits.every((hit) => hit.snippet?.includes("%_"))).toBe(true);
    const blob = await index.search({
      query: "blob exact ✨\nsecond line",
      mode: "exact",
      scopes: ["text"],
      order: "newest",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(blob.total).toBe(1);
    const defaultScope = await index.search({
      query: "Synthetic Group",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(defaultScope.total).toBe(0);
    const nameScope = await index.search({
      query: "Synthetic Group",
      mode: "substring",
      scopes: ["conversation_names"],
      order: "newest",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(nameScope.total).toBeGreaterThan(0);
    const attachmentScope = await index.search({
      query: "photo.png",
      mode: "exact",
      scopes: ["attachment_filenames"],
      order: "newest",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(attachmentScope.total).toBe(1);
    expect(attachmentScope.hits[0].attachment_filenames).toEqual(["photo.png"]);
    expect(JSON.stringify(attachmentScope.hits)).not.toContain("/Users/fake");
    const retracted = await index.search({
      query: "should never be returned",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(retracted.total).toBe(0);
    const mmsAsSms = await index.search({
      query: "incoming only",
      mode: "exact",
      scopes: ["text"],
      order: "newest",
      service: "sms",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(mmsAsSms.hits.map((hit) => hit.service_family)).toEqual(["sms"]);
    const unknown = await index.search({
      query: "mystery service",
      mode: "exact",
      scopes: ["text"],
      order: "newest",
      service: "unknown",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(unknown.hits.map((hit) => hit.service_family)).toEqual(["unknown"]);
    const phrase = await index.search({
      query: "exact phrase",
      mode: "phrase",
      scopes: ["text"],
      order: "relevance",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    const repeated = await index.search({
      query: "exact phrase",
      mode: "phrase",
      scopes: ["text"],
      order: "relevance",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(phrase.total).toBe(1);
    const punctuatedPhrase = await index.search({
      query: "exact-phrase",
      mode: "phrase",
      scopes: ["text", "conversation_names"],
      order: "relevance",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(punctuatedPhrase.total).toBe(1);
    expect(punctuatedPhrase.hits[0].matched_scopes).toEqual(["text"]);
    expect(punctuatedPhrase.hits[0].snippet).toContain("exact phrase");
    const tokens = await index.search({
      query: "literal café",
      mode: "token",
      scopes: ["text"],
      order: "relevance",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(tokens.total).toBe(1);
    expect(tokens.hits[0].snippet).toContain("literal");
    const substringRelevance = await index.search({
      query: "reply",
      mode: "substring",
      scopes: ["text"],
      order: "relevance",
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full",
    });
    expect(substringRelevance.hits.at(-1)?.snippet).toContain("thread reply");
    expect(substringRelevance.hits.every((hit) => typeof hit.relevance === "number")).toBe(true);
    expect(repeated.hits.map(({ message_id: _message, chat_id: _conversation, ...hit }) => hit))
      .toEqual(phrase.hits.map(({ message_id: _message, chat_id: _conversation, ...hit }) => hit));
    index.close();
  });

  it("partitions search on sent and received without changing the unfiltered result", async () => {
    const index = new MemorySearchIndex(context, decoder, contacts);
    const bounds = compileDateBounds({ timezone: "UTC" });
    const input = {
      query: "reply",
      mode: "substring" as const,
      scopes: ["text" as const],
      order: "newest" as const,
      bounds,
      limit: 50,
      allowPartial: false,
      privacy: "full" as const,
    };
    try {
      const all = await index.search(input);
      const sent = await index.search({ ...input, fromMe: true });
      const received = await index.search({ ...input, fromMe: false });
      expect(all.total).toBe(3);
      expect(sent.total).toBe(2);
      expect(received.total).toBe(1);
      expect(sent.total + received.total).toBe(all.total);
      expect(sent.hits.map((hit) => hit.snippet)).toEqual(["reply two in same turn", "reply one"]);
      expect(received.hits.map((hit) => hit.snippet)).toEqual(["thread reply"]);
      expect(sent.hits.every((hit) => hit.sender.handle === null)).toBe(true);
      expect(received.hits.every((hit) => hit.sender.handle === "+15550000001")).toBe(true);
      expect([...sent.hits, ...received.hits].map((hit) => hit.snippet).sort())
        .toEqual(all.hits.map((hit) => hit.snippet).sort());

      const firstSent = await index.search({ ...input, fromMe: true, limit: 1 });
      expect(firstSent.hasMore).toBe(true);
      expect(firstSent.nextCursor).not.toBeNull();
      const nextSent = await index.search({ ...input, fromMe: true, limit: 1, cursor: firstSent.nextCursor! });
      expect(nextSent.total).toBe(2);
      expect(nextSent.hits.map((hit) => hit.snippet)).toEqual(["reply one"]);
      await expect(index.search({ ...input, fromMe: false, limit: 1, cursor: firstSent.nextCursor! }))
        .rejects.toMatchObject({ reason: "INVALID_INPUT" });
      await expect(index.search({ ...input, limit: 1, cursor: firstSent.nextCursor! }))
        .rejects.toMatchObject({ reason: "INVALID_INPUT" });
    } finally {
      index.close();
    }
  });

  it("accepts from_me through the search_messages tool and reports it in scope", async () => {
    const runtime = new LocalToolRuntime(
      runtimeConfig({
        transport: "stdio",
        databasePath: fixture.databasePath,
        contacts: "none",
      }),
    );
    const params = {
      query: "reply",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      limit: 50,
      privacy_mode: "full",
    };
    try {
      const unfiltered = await runtime.call("search_messages", params);
      const sent = await runtime.call("search_messages", { ...params, from_me: true });
      const received = await runtime.call("search_messages", { ...params, from_me: false });
      for (const result of [unfiltered, sent, received]) expect(result.isError).toBeUndefined();
      expect(unfiltered.structuredContent).toMatchObject({
        effective_scope: { from_me: "all" },
        data: { total_matches: 3 },
      });
      expect(sent.structuredContent).toMatchObject({
        effective_scope: { from_me: true },
        data: { total_matches: 2 },
      });
      expect(received.structuredContent).toMatchObject({
        effective_scope: { from_me: false },
        data: { total_matches: 1 },
      });
    } finally {
      runtime.close();
    }
  });

  it("indexes unified conversation names for outgoing direct messages", async () => {
    const namedContacts = new UnifiedContactResolver(true, [
      { identifier: "alice", name: "Alice Example", phones: ["+15550000001"], emails: [] },
    ]);
    const index = new MemorySearchIndex(context, decoder, namedContacts);
    try {
      const result = await index.search({
        query: "Alice Example",
        mode: "exact",
        scopes: ["conversation_names"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      const ids = result.hits.map((hit) => hit.message_id);
      expect(ids).toContain(2);
      expect(result.hits.every((hit) => hit.matched_scopes.includes("conversation_names"))).toBe(true);
    } finally {
      index.close();
    }
  });

  it("marks search rows partial when an allowed blob decode is incomplete", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=1").run(Buffer.from("malformed search body"));
    db.prepare("UPDATE chat SET display_name='Partial Search Match' WHERE ROWID IN (1, 2)").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    const input = {
      query: "Partial Search Match",
      mode: "exact" as const,
      scopes: ["conversation_names" as const],
      order: "newest" as const,
      bounds: compileDateBounds({ timezone: "UTC" }),
      limit: 50,
      privacy: "full" as const,
    };
    try {
      await expect(index.search({ ...input, allowPartial: false })).rejects.toMatchObject({ reason: "DECODE_FAILED" });
      const result = await index.search({ ...input, allowPartial: true });
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "DECODE_FAILED", skipped_count: 1 }),
      ]);
      expect(result.hits.filter((hit) => hit.row_status === "partial")).toHaveLength(1);
      expect(result.hits.every((hit) => hit.row_status === "complete" || hit.row_status === "partial")).toBe(true);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("never attributes an unresolved incoming search sender to Me", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET handle_id=99 WHERE ROWID=1").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    const input = {
      query: "hello literal",
      mode: "substring" as const,
      scopes: ["text" as const],
      order: "newest" as const,
      bounds: compileDateBounds({ timezone: "UTC" }),
      limit: 50,
      privacy: "full" as const,
    };
    try {
      await expect(index.search({ ...input, allowPartial: false }))
        .rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
      const partial = await index.search({ ...input, allowPartial: true });
      expect(partial.hits).toHaveLength(1);
      expect(partial.hits[0]).toMatchObject({
        sender: { name: null, handle: null },
        row_status: "partial",
      });
      expect(partial.warnings).toContainEqual(expect.objectContaining({
        code: "UNSUPPORTED_SCHEMA",
        skipped_count: 1,
      }));
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("rejects duplicate message GUIDs before indexing search references", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    const date = appleNanoseconds("2026-03-10T07:00:00Z");
    db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                VALUES (21,'m1','duplicate searchable guid',1,?,0,'iMessage')`).run(date);
    db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(date);
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    try {
      await expect(index.search({
        query: "duplicate searchable guid",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  describe("archived empty attributed strings", () => {
    it("decode to empty text for both root classes, while empty data stays malformed", async () => {
      const decoder = new MessageTextDecoder();
      expect(await decoder.decode([
        foundationEmptyAttributedBody(false),
        foundationEmptyAttributedBody(true),
        Buffer.alloc(0),
        Buffer.from("040b73747265616d74797065648186", "hex"),
      ])).toEqual([
        { status: "decoded", text: "" },
        { status: "decoded", text: "" },
        { status: "malformed" },
        { status: "malformed" },
      ]);
    }, 60_000);

    it("do not make a strict search or conversation page fail", async () => {
      const isolated = createFixture();
      const db = new Database(isolated.databasePath);
      db.prepare("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=1").run(foundationEmptyAttributedBody(false));
      db.close();
      const isolatedContext = new DatabaseContext(isolated.databasePath);
      const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
      try {
        const result = await index.search({
          query: "a",
          mode: "substring",
          scopes: ["text"],
          order: "newest",
          bounds: compileDateBounds({ timezone: "UTC" }),
          limit: 50,
          privacy: "full",
          allowPartial: false,
        });
        expect(result.warnings ?? []).toEqual([]);
        const page = await getConversationEvents({
          context: isolatedContext,
          contacts: new UnifiedContactResolver(false),
          decoder: new MessageTextDecoder(),
          chatIds: [1, 2],
          limit: 200,
          bounds: compileDateBounds({ timezone: "UTC" }),
          privacy: "full",
          includeAttachmentPaths: false,
          allowPartial: false,
        });
        expect(page.warnings ?? []).toEqual([]);
      } finally {
        index.close();
        isolatedContext.close();
        isolated.cleanup();
      }
    }, 60_000);
  });

  describe("attributed bodies above the former 1 MiB decoder bound", () => {
    // A long pasted message: about 1.4 MiB of text in a body well past 1 MiB, the
    // shape that made every strict search on a real archive fail before 2.1.1.
    const needle = "zephyrlongpastemarker";
    const text = `${"the quick brown fox jumps over the lazy dog ".repeat(34_000)}${needle}`;
    let body: Buffer;
    beforeAll(() => {
      body = foundationAttributedBodyFromStdin(text);
      expect(body.length).toBeGreaterThan(1024 * 1024);
      expect(body.length).toBeLessThanOrEqual(MAX_ATTRIBUTED_BODY_BYTES);
    }, 120_000);

    it("decodes the body exactly", async () => {
      const [decoded] = await new MessageTextDecoder().decode([body]);
      expect(decoded).toMatchObject({ status: "decoded" });
      expect((decoded as { text: string }).text).toBe(text);
    }, 120_000);

    it("finds it in a strict search, without allow_partial", async () => {
      const isolated = createFixture();
      const db = new Database(isolated.databasePath);
      db.prepare("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=1").run(body);
      db.close();
      const isolatedContext = new DatabaseContext(isolated.databasePath);
      const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
      try {
        const result = await index.search({
          query: needle,
          mode: "substring",
          scopes: ["text"],
          order: "newest",
          bounds: compileDateBounds({ timezone: "UTC" }),
          limit: 50,
          privacy: "full",
          allowPartial: false,
        });
        expect(result.warnings ?? []).toEqual([]);
        expect(result.hits).toHaveLength(1);
      } finally {
        index.close();
        isolatedContext.close();
        isolated.cleanup();
      }
    }, 120_000);

    it("returns it from a strict get_conversation page", async () => {
      const isolated = createFixture();
      const db = new Database(isolated.databasePath);
      db.prepare("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=1").run(body);
      db.close();
      const isolatedContext = new DatabaseContext(isolated.databasePath);
      try {
        const page = await getConversationEvents({
          context: isolatedContext,
          contacts: new UnifiedContactResolver(false),
          decoder: new MessageTextDecoder(),
          chatIds: [1, 2],
          limit: 200,
          bounds: compileDateBounds({ timezone: "UTC" }),
          privacy: "full",
          includeAttachmentPaths: false,
          allowPartial: false,
        });
        expect(page.warnings ?? []).toEqual([]);
        expect(page.events.some((event) => typeof event.text === "string" && event.text.endsWith(needle))).toBe(true);
      } finally {
        isolatedContext.close();
        isolated.cleanup();
      }
    }, 120_000);

  });

  it("never loads oversized search blobs and omits only their bodies in partial mode", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=1")
      .run(Buffer.alloc(MAX_ATTRIBUTED_BODY_BYTES + 1, 0x61));
    db.prepare("UPDATE chat SET display_name='Oversized Search Match' WHERE ROWID IN (1, 2)").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    const input = {
      query: "Oversized Search Match",
      mode: "exact" as const,
      scopes: ["conversation_names" as const],
      order: "newest" as const,
      bounds: compileDateBounds({ timezone: "UTC" }),
      limit: 50,
      privacy: "full" as const,
    };
    try {
      await expect(index.search({ ...input, allowPartial: false })).rejects.toMatchObject({ reason: "DECODE_FAILED" });
      const result = await index.search({ ...input, allowPartial: true });
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "DECODE_FAILED", skipped_count: 1 }),
      ]);
      expect(result.hits.filter((hit) => hit.row_status === "partial")).toHaveLength(1);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("matches exact relationship values without crossing linked names or filenames", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE chat SET display_name='Alpha' WHERE ROWID=1").run();
    db.prepare("UPDATE chat SET display_name='Beta' WHERE ROWID=2").run();
    db.prepare(
      "INSERT INTO attachment(ROWID,guid,filename,transfer_name,mime_type,total_bytes) VALUES (2,'a2','/Users/fake/second.pdf','second.pdf','application/pdf',42)",
    ).run();
    db.prepare("INSERT INTO message_attachment_join(message_id,attachment_id) VALUES (7,2)").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    const bounds = compileDateBounds({ timezone: "UTC" });
    try {
      const exactName = await index.search({
        query: "Alpha",
        mode: "exact",
        scopes: ["conversation_names"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(exactName.total).toBeGreaterThan(0);
      const crossedPhrase = await index.search({
        query: "Alpha Beta",
        mode: "phrase",
        scopes: ["conversation_names"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(crossedPhrase.total).toBe(0);
      const exactAttachment = await index.search({
        query: "photo.png",
        mode: "exact",
        scopes: ["attachment_filenames"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(exactAttachment.total).toBe(1);
      expect(exactAttachment.hits[0].attachment_filenames).toEqual(["photo.png", "second.pdf"]);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("builds grapheme-safe snippets from a bounded streaming window", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET text=? WHERE ROWID=1")
      .run(`${"x".repeat(300_000)} marker 👨‍👩‍👧‍👦 tail`);
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    try {
      const result = await index.search({
        query: "marker",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(result.total).toBe(1);
      expect(result.hits[0].snippet).toMatch(/^…x{35,40} marker 👨‍👩‍👧‍👦 tail$/u);
      expect(Buffer.byteLength(result.hits[0].snippet ?? "", "utf8")).toBeLessThan(1024);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("caps snippet bytes without splitting large grapheme clusters", async () => {
    const isolated = createFixture();
    const largeGrapheme = `a${"\u0301".repeat(2_000)}`;
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET text=? WHERE ROWID=1").run(`marker ${largeGrapheme.repeat(40)}`);
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    try {
      const result = await index.search({
        query: "marker",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      const snippet = result.hits[0].snippet ?? "";
      expect(Buffer.byteLength(snippet, "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(snippet).toMatch(/^marker /u);
      expect(snippet).toMatch(/…$/u);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("uses stable keyset pages and rejects a cursor after any database change", async () => {
    const isolated = createFixture();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const isolatedContacts = new UnifiedContactResolver(false);
    const isolatedDecoder = new MessageTextDecoder();
    try {
      const first = await getConversationEvents({
        context: isolatedContext,
        contacts: isolatedContacts,
        decoder: isolatedDecoder,
        chatIds: [1, 2],
        limit: 3,
        bounds: compileDateBounds({ timezone: "UTC" }),
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      });
      expect(first.hasMore).toBe(true);
      const second = await getConversationEvents({
        context: isolatedContext,
        contacts: isolatedContacts,
        decoder: isolatedDecoder,
        chatIds: [1, 2],
        limit: 3,
        cursor: first.nextCursor!,
        bounds: compileDateBounds({ timezone: "UTC" }),
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      });
      const firstRefs = new Set(first.events.map((event) => event.message_id).filter((id) => id !== undefined));
      expect(second.events.every((event) => !event.message_id || !firstRefs.has(event.message_id))).toBe(true);
      expect(second.asOf).toBe(first.asOf);

      const db = new Database(isolated.databasePath);
      const date = appleNanoseconds("2026-08-10T12:00:00Z");
      db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                  VALUES (21,'pagination-new','new activity',1,?,0,'iMessage')`).run(date);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(date);
      db.close();
      await expect(getConversationEvents({
        context: isolatedContext,
        contacts: isolatedContacts,
        decoder: isolatedDecoder,
        chatIds: [1, 2],
        limit: 3,
        cursor: first.nextCursor!,
        bounds: compileDateBounds({ timezone: "UTC" }),
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("orders and paginates exact Apple nanoseconds beyond JavaScript's safe integer range", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    const base = 1_000_000_000_000_000_000n;
    db.transaction(() => {
      const insertChat = db.prepare(
        "INSERT INTO chat(ROWID,guid,chat_identifier,service_name) VALUES (?,?,?,'iMessage')",
      );
      const insertParticipant = db.prepare("INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (?,1)");
      const insertMessage = db.prepare(
        "INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (?,?,?,?,?,0,'iMessage')",
      );
      const insertJoin = db.prepare(
        "INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (?,?,?,0)",
      );
      for (const [chatId, offset] of [[6, 11n], [7, 13n], [8, 12n]] as const) {
        insertChat.run(chatId, `precision-chat-${chatId}`, `precision-${chatId}`);
        insertParticipant.run(chatId);
        const messageId = 35 + chatId;
        const date = base + offset;
        insertMessage.run(messageId, `precision-conversation-${chatId}`, `precision conversation ${chatId}`, 1, date);
        insertJoin.run(chatId, messageId, date);
      }
      for (const [rowid, offset, label] of [
        [31, 1n, "low"],
        [32, 3n, "high"],
        [33, 2n, "mid"],
      ] as const) {
        const date = base + offset;
        insertMessage.run(rowid, `precision-timeline-${label}`, `precision timeline ${label}`, 1, date);
        insertJoin.run(1, rowid, date);
      }
    })();
    db.close();

    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const isolatedContacts = new UnifiedContactResolver(false);
    const isolatedDecoder = new MessageTextDecoder();
    const index = new MemorySearchIndex(isolatedContext, isolatedDecoder, isolatedContacts);
    try {
      const conversationOrder: number[] = [];
      let conversationCursor: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const result = listConversations({
          context: isolatedContext,
          contacts: isolatedContacts,
          filters: { bounds: compileDateBounds({ timezone: "UTC" }) },
          limit: 1,
          cursor: conversationCursor,
          privacy: "full",
        });
        conversationOrder.push(result.conversations[0].chat_id);
        conversationCursor = result.nextCursor ?? undefined;
      }
      expect(conversationOrder).toEqual([7, 8, 6]);

      const timelineOrder: Array<string | undefined> = [];
      let timelineCursor: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const result = await getConversationEvents({
          context: isolatedContext,
          contacts: isolatedContacts,
          decoder: isolatedDecoder,
          chatIds: [1, 2],
          limit: 1,
          cursor: timelineCursor,
          bounds: compileDateBounds({ timezone: "UTC" }),
          allowPartial: false,
          privacy: "full",
          includeAttachmentPaths: false,
        });
        timelineOrder.push(result.events[0].text);
        timelineCursor = result.nextCursor ?? undefined;
      }
      expect(timelineOrder).toEqual([
        "precision timeline high",
        "precision timeline mid",
        "precision timeline low",
      ]);

      const searched = await index.search({
        query: "precision timeline",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 3,
        allowPartial: false,
        privacy: "full",
      });
      expect(searched.hits.map((hit) => hit.snippet)).toEqual([
        "precision timeline high",
        "precision timeline mid",
        "precision timeline low",
      ]);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("freezes search pages, then refreshes complete results for a fresh query", async () => {
    const isolated = createFixture();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    try {
      const bounds = compileDateBounds({ timezone: "UTC" });
      const first = await index.search({
        query: "reply",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 1,
        allowPartial: false,
        privacy: "full",
      });
      expect(first.hasMore).toBe(true);
      const db = new Database(isolated.databasePath);
      const date = appleNanoseconds("2026-08-10T12:00:00Z");
      db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                  VALUES (21,'search-new','reply newest',1,?,0,'iMessage')`).run(date);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(date);
      db.close();
      await expect(index.search({
        query: "reply",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 1,
        cursor: first.nextCursor!,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
      const fresh = await index.search({
        query: "reply",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(fresh.total).toBe(4);
      expect(fresh.hits[0].snippet).toContain("reply newest");
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("rebuilds search after an append combined with a backdated edit", async () => {
    const isolated = createFixture();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const index = new MemorySearchIndex(isolatedContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    const bounds = compileDateBounds({ timezone: "UTC" });
    try {
      expect((await index.search({
        query: "hello literal",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).total).toBe(1);
      const db = new Database(isolated.databasePath);
      const appended = appleNanoseconds("2026-08-10T12:00:00Z");
      const backdated = appleNanoseconds("2026-03-08T06:31:00Z");
      db.prepare("UPDATE message SET text='backdated current body', date_edited=? WHERE ROWID=1").run(backdated);
      db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                  VALUES (21,'combined-append','unrelated append',1,?,0,'iMessage')`).run(appended);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(appended);
      db.close();
      expect((await index.search({
        query: "hello literal",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).total).toBe(0);
      expect((await index.search({
        query: "backdated current body",
        mode: "exact",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).total).toBe(1);
    } finally {
      index.close();
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("rejects duplicate search scopes before executing a full scan", async () => {
    const index = new MemorySearchIndex(context, decoder, contacts);
    try {
      await expect(index.search({
        query: "h",
        mode: "substring",
        scopes: ["text", "text"],
        order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "INVALID_INPUT" });
    } finally {
      index.close();
    }
  });

  it("rejects oversized selected bodies before native decoding", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET text=? WHERE ROWID=1").run("x".repeat(3 * 1024 * 1024 + 1));
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      await expect(getConversationEvents({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        decoder: new MessageTextDecoder(),
        chatIds: [1],
        limit: 200,
        bounds: compileDateBounds({ timezone: "UTC" }),
        allowPartial: false,
        privacy: "full",
        includeAttachmentPaths: false,
      })).rejects.toMatchObject({ reason: "QUERY_BUDGET_EXCEEDED" });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("uses documented analytics formulas and counts attachment-only messages", () => {
    const bounds = compileDateBounds({ timezone: "America/New_York" });
    const counts = analyze({ context, scope: { kind: "global" }, metric: "message_count", bounds, sessionGapHours: 8 });
    expect(Number(counts.overall.messages)).toBe(15);
    expect(Number(counts.overall.reaction_events)).toBe(3);
    expect(Number(counts.overall.system_events)).toBe(2);
    expect(counts.service_partitions.some((partition) => partition.service_family === "rcs")).toBe(true);
    const response = analyze({ context, scope: { kind: "conversation", chatIds: [1, 2] }, metric: "response_time", bounds, sessionGapHours: 8 });
    expect(response.formula).toContain("collapse consecutive same-sender");
    expect(Number(response.overall.samples)).toBeGreaterThan(0);
    const streak = analyze({ context, scope: { kind: "global" }, metric: "streaks", bounds, sessionGapHours: 8 });
    expect(streak.overall).toHaveProperty("any_activity_longest_days");
    expect(streak.overall).toHaveProperty("mutual_exchange_longest_days");
    const contact = analyze({
      context,
      scope: { kind: "contact", handles: ["+15550000001"] },
      metric: "message_count",
      bounds,
      sessionGapHours: 8,
    });
    expect(Number(contact.overall.sent)).toBeGreaterThan(0);
  });

  it("normalizes contact handles in set-based analytics scope", () => {
    const exact = analyze({
      context,
      scope: { kind: "contact", handles: ["+15550000001"] },
      metric: "message_count",
      bounds: compileDateBounds({ timezone: "UTC" }),
      sessionGapHours: 8,
    });
    const formatted = analyze({
      context,
      scope: { kind: "contact", handles: ["+1 (555) 000-0001"] },
      metric: "message_count",
      bounds: compileDateBounds({ timezone: "UTC" }),
      sessionGapHours: 8,
    });
    expect(Number(exact.overall.messages)).toBe(13);
    expect(formatted.overall).toEqual(exact.overall);
    expect(formatted.service_partitions).toEqual(exact.service_partitions);
  });

  it("classifies modern one-to-one chats as direct even though Apple fills group_id for them", () => {
    // Current macOS writes a group_id GUID on every chat, one-to-one included, and
    // marks the shape in chat.style: 45 for one-to-one, 43 for groups.
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE chat SET style=45, group_id='modern-direct-' || ROWID WHERE ROWID IN (1, 2, 3)").run();
    db.prepare("UPDATE chat SET display_name='Named One To One' WHERE ROWID=3").run();
    db.prepare("UPDATE chat SET style=43, display_name=NULL WHERE ROWID=4").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    const list = (kind?: "direct" | "group") => listConversations({
      context: isolatedContext,
      contacts: new UnifiedContactResolver(false),
      filters: { bounds: compileDateBounds({ timezone: "UTC" }), ...(kind ? { kind } : {}) },
      limit: 50,
      privacy: "full",
    }).conversations;
    try {
      const all = list();
      const imessage = all.find((conversation) => conversation.service_families.includes("imessage"));
      const incoming = all.find((conversation) => conversation.message_count > 0 && conversation.participants.some((p) => p.handle === "unknown@example.test"));
      const group = all.find((conversation) => conversation.service_families.includes("rcs"));
      expect(imessage).toMatchObject({ kind: "direct" });
      expect(incoming).toMatchObject({ kind: "direct" });
      expect(group).toMatchObject({ kind: "group" });
      // References are opaque per request, so compare the filtered listings by shape.
      const direct = list("direct");
      expect(direct.every((conversation) => conversation.kind === "direct")).toBe(true);
      expect(direct.some((conversation) => conversation.service_families.includes("imessage"))).toBe(true);
      const groups = list("group");
      expect(groups.map((conversation) => conversation.service_families)).toEqual([["rcs"]]);
      const response = analyze({
        context: isolatedContext,
        scope: { kind: "conversation", chatIds: [1, 2] },
        metric: "response_time",
        bounds: compileDateBounds({ timezone: "UTC" }),
        sessionGapHours: 8,
      });
      expect(Number(response.overall.samples)).toBeGreaterThan(0);
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("keeps Apple-linked direct service variants direct when their handles differ", () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE chat SET style=45 WHERE ROWID IN (1, 2)").run();
    db.prepare("INSERT INTO handle(ROWID,id) VALUES (99,'alice@example.test')").run();
    db.prepare("INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (2,99)").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      const listed = listConversations({
        context: isolatedContext,
        contacts: new UnifiedContactResolver(false),
        filters: { bounds: compileDateBounds({ timezone: "UTC" }) },
        limit: 50,
        privacy: "full",
      });
      const linked = listed.conversations.find((conversation) => conversation.service_families.includes("imessage"));
      expect(linked).toMatchObject({ kind: "direct" });
      expect(linked?.participants).toHaveLength(2);
      const response = analyze({
        context: isolatedContext,
        scope: { kind: "conversation", chatIds: [1, 2] },
        metric: "response_time",
        bounds: compileDateBounds({ timezone: "UTC" }),
        sessionGapHours: 8,
      });
      expect(Number(response.overall.samples)).toBeGreaterThan(0);
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });

  it("excludes Apple group-style conversations from response-time metrics after membership shrinks", () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE chat SET style=43, display_name=NULL, group_id=NULL WHERE ROWID=4").run();
    db.prepare("DELETE FROM chat_handle_join WHERE chat_id=4 AND handle_id=2").run();
    const date = appleNanoseconds("2026-03-09T02:02:00Z");
    db.prepare("INSERT INTO message(ROWID,guid,text,date,is_from_me,service) VALUES (21,'group-reply','reply',?,1,'RCS')").run(date);
    db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (4,21,?,0)").run(date);
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath);
    try {
      const result = analyze({
        context: isolatedContext,
        scope: { kind: "conversation", chatIds: [4] },
        metric: "response_time",
        bounds: compileDateBounds({ timezone: "UTC" }),
        sessionGapHours: 8,
      });
      expect(result.overall).toMatchObject({ samples: 0 });
    } finally {
      isolatedContext.close();
      isolated.cleanup();
    }
  });
});

describe("capability-aware schemas", () => {
  it("keeps all read paths available when optional tables and columns are absent", async () => {
    const fixture = createMinimalSchemaFixture();
    const context = new DatabaseContext(fixture.databasePath);
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    const index = new MemorySearchIndex(context, decoder, contacts);
    try {
      expect(context.capabilities).toMatchObject({
        required_core: "available",
        chat_lookup: "unavailable",
        attributed_body: "unavailable",
        edits: "unavailable",
        retractions: "unavailable",
        reactions: "unavailable",
        receipts: "unavailable",
        replies: "unavailable",
        attachments: "unavailable",
        group_events: "unavailable",
      });
      const bounds = compileDateBounds({ timezone: "UTC" });
      expect(listConversations({
        context,
        contacts,
        filters: { bounds },
        limit: 50,
        privacy: "full",
      }).conversations.length).toBeGreaterThan(0);
      const conversation = await getConversationEvents({
        context,
        contacts,
        decoder,
        chatIds: [1],
        limit: 10,
        bounds,
        allowPartial: true,
        privacy: "full",
        includeAttachmentPaths: false,
      });
      expect(conversation.events.every((event) => event.receipt?.capability === "unavailable")).toBe(true);
      expect((await index.search({
        query: "not present",
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        bounds,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).total).toBe(0);
      expect(analyze({
        context,
        scope: { kind: "global" },
        metric: "message_count",
        bounds,
        sessionGapHours: 8,
      }).overall).toHaveProperty("messages");
      await index.ensure(true);
      expect(index.changeLog().read(0, 10)).toEqual([]);
    } finally {
      index.close();
      context.close();
      fixture.cleanup();
    }
  });
});

describe("Foundation fixtures", () => {
  it("preserves input positions around oversized bodies", async () => {
    const decoder = new MessageTextDecoder();
    const oversized = Buffer.alloc(MAX_ATTRIBUTED_BODY_BYTES + 1);
    expect(await decoder.decode([
      foundationAttributedBody("before"), oversized, foundationAttributedBody("after"),
    ])).toEqual([
      { status: "decoded", text: "before" }, { status: "unsupported" }, { status: "decoded", text: "after" },
    ]);
  });

  it("preserves input positions around oversized edit summaries", async () => {
    const decoder = new MessageTextDecoder();
    const oversized = Buffer.alloc(MAX_ATTRIBUTED_BODY_BYTES + 1);
    expect(await decoder.decodeEditMetadata([
      foundationEditSummary([0, 100]), oversized, foundationEditSummary([0, 200, 300]),
    ])).toEqual([
      { status: "decoded", count: 1, timestamps: [100] }, { status: "unsupported" },
      { status: "decoded", count: 2, timestamps: [200, 300] },
    ]);
  });

  it.each([
    "short",
    "x".repeat(400),
    "unicode 👨‍👩‍👧‍👦 café ✨",
    "line one\nline two\nline three",
  ])("decodes exact Foundation text %#", async (text) => {
    const decoder = new MessageTextDecoder();
    const [result] = await decoder.decode([foundationAttributedBody(text)]);
    expect(result).toEqual({ status: "decoded", text });
  });

  it("decodes exact Foundation text with multiple attributed runs", async () => {
    const text = "rich unicode 👨‍👩‍👧‍👦 text across multiple runs";
    const decoder = new MessageTextDecoder();
    const [result] = await decoder.decode([foundationAttributedBodyWithRuns(text)]);
    expect(result).toEqual({ status: "decoded", text });
  });

  it("classifies malformed blobs without heuristic recovery", async () => {
    const decoder = new MessageTextDecoder();
    const [result] = await decoder.decode([Buffer.from("not a Foundation archive")]);
    expect(result.status).toBe("malformed");
  });

  it("rejects marker-smuggled streamtyped non-archives", async () => {
    const fake = Buffer.concat([
      Buffer.from([0x04, 0x0b]),
      Buffer.from("streamtypedjunkNSAttributedStringjunkNSObjectjunkNSString"),
      Buffer.from([0x01, 0x90, 0x84, 0x01, 0x2b, 0x06]),
      Buffer.from("forged"),
      Buffer.from([0x86, 0x00, 0x00, 0x00]),
    ]);
    const decoder = new MessageTextDecoder();
    const [result] = await decoder.decode([fake]);
    expect(result.status).toBe("malformed");
  });

  it("rejects truncated and impossible legacy attributed-string frames", async () => {
    const valid = foundationAttributedBody("certified frame");
    const truncated = Buffer.from(valid);
    truncated[truncated.length - 1] = 0;

    const impossible = Buffer.from(valid);
    const textOffset = impossible.indexOf(Buffer.from("certified frame"));
    const runMarker = Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]);
    const runOffset = impossible.indexOf(runMarker, textOffset + Buffer.byteLength("certified frame"));
    expect(runOffset).toBeGreaterThan(0);
    impossible[runOffset + runMarker.length] = 0x7f;

    const decoder = new MessageTextDecoder();
    const [truncatedResult, impossibleResult] = await decoder.decode([truncated, impossible]);
    expect(truncatedResult.status).toBe("malformed");
    expect(impossibleResult.status).toBe("malformed");
  });

  it("rejects a non-string legacy archive without constructing archived objects", async () => {
    const decoder = new MessageTextDecoder();
    const [result] = await decoder.decode([foundationLegacyDateArchive()]);
    expect(result.status).toBe("malformed");
  });
});
