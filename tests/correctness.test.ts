import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DATABASE_PATH, runtimeConfig } from "../src/config.js";
import { serviceFamily } from "../src/contracts.js";
import { UnifiedContactResolver } from "../src/contacts.js";
import { DatabaseContext } from "../src/database.js";
import { MessageTextDecoder } from "../src/decoder.js";
import { MAX_REFERENCE_LENGTH, MAX_SYNC_CURSOR_LENGTH } from "../src/references.js";
import { MemorySearchIndex } from "../src/search-index.js";
import { LocalToolRuntime } from "../src/tool-local.js";
import { APPLE_EPOCH_UNIX_SECONDS, appleTimestampToIso, compileDateBounds } from "../src/time.js";
import { analyze } from "../src/repositories/analytics.js";
import { ConversationCatalog, listConversations, resolveConversationReference } from "../src/repositories/conversations.js";
import { getConversationEvents, resolveMessageReference } from "../src/repositories/messages.js";
import { prepareCopiedDatabaseSync, syncMessages } from "../src/repositories/sync.js";
import {
  appleNanoseconds,
  createFixture,
  createMinimalSchemaFixture,
  foundationAttributedBody,
  foundationAttributedBodyWithRuns,
  foundationLegacyDateArchive,
  type Fixture,
} from "./fixture.js";

const REFERENCE_KEY = Buffer.alloc(32, 0x5a);

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
      referenceKey: REFERENCE_KEY,
    });
    context = new DatabaseContext(config.database_path, REFERENCE_KEY);
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
      referenceKey: REFERENCE_KEY,
    });
    expect(explicit.source_mode).toBe("live");
    expect(() => runtimeConfig({
      transport: "stdio",
      databasePath: path.join(fixture.directory, "copied-chat.db"),
      contacts: "live",
      referenceKey: REFERENCE_KEY,
    })).toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
  });

  it("honors and validates the attachment-path startup environment", () => {
    const previous = process.env.IMESSAGE_ATTACHMENT_PATHS;
    try {
      process.env.IMESSAGE_ATTACHMENT_PATHS = "1";
      expect(runtimeConfig({
        transport: "stdio",
        databasePath: fixture.databasePath,
        contacts: "none",
        referenceKey: REFERENCE_KEY,
      }).attachment_paths_enabled).toBe(true);
      process.env.IMESSAGE_ATTACHMENT_PATHS = "yes";
      expect(() => runtimeConfig({
        transport: "stdio",
        databasePath: fixture.databasePath,
        contacts: "none",
        referenceKey: REFERENCE_KEY,
      })).toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
    } finally {
      if (previous === undefined) delete process.env.IMESSAGE_ATTACHMENT_PATHS;
      else process.env.IMESSAGE_ATTACHMENT_PATHS = previous;
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
        referenceKey: REFERENCE_KEY,
      }),
      Buffer.alloc(32, 7),
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
        referenceKey: REFERENCE_KEY,
      }),
      Buffer.alloc(32, 7),
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

  it("preserves references across faithful copies and separates unrelated lineages", () => {
    const source = createFixture();
    const copy = path.join(source.directory, "faithful-copy.db");
    copyFileSync(source.databasePath, copy);
    const sourceContext = new DatabaseContext(source.databasePath, REFERENCE_KEY);
    const copyContext = new DatabaseContext(copy, REFERENCE_KEY);
    let sourceLineage = "";
    try {
      sourceLineage = sourceContext.lineage;
      expect(copyContext.lineage).toBe(sourceContext.lineage);
    } finally {
      sourceContext.close();
      copyContext.close();
    }
    const changed = new Database(copy);
    changed.prepare("UPDATE message SET guid='different-archive-message' WHERE ROWID=1").run();
    changed.close();
    const unrelated = new DatabaseContext(copy, REFERENCE_KEY);
    try {
      expect(unrelated.lineage).not.toBe(sourceLineage);
    } finally {
      unrelated.close();
      source.cleanup();
    }
  });

  it("fails closed when a live database's lineage anchors change", () => {
    const isolated = createFixture();
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
    try {
      const changed = new Database(isolated.databasePath);
      changed.prepare("UPDATE message SET guid='replaced-archive-anchor' WHERE ROWID=1").run();
      changed.close();
      expect(() => isolatedContext.request()).toThrowError(expect.objectContaining({ reason: "DATABASE_CHANGED" }));
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
    const linkedContext = new DatabaseContext(link, REFERENCE_KEY);
    try {
      unlinkSync(link);
      symlinkSync(alternate, link);
      const request = linkedContext.request();
      expect(request.lineage).toBe(linkedContext.lineage);
      request.close();
      renameSync(isolated.databasePath, original);
      copyFileSync(original, isolated.databasePath);
      expect(() => linkedContext.request()).toThrowError(expect.objectContaining({ reason: "DATABASE_CHANGED" }));
    } finally {
      linkedContext.close();
      isolated.cleanup();
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
    expect(resolveConversationReference(context.referenceKey, context.lineage, linked!.conversation_ref)).toEqual([1, 2]);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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

    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
      expect(new Set(timeline.events.map((event) => event.message_ref)).size).toBe(11);

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
      expect(resolveConversationReference(
        isolatedContext.referenceKey,
        isolatedContext.lineage,
        searched.hits[0].conversation_ref,
      )).toEqual([1, 2]);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
      await expect(syncMessages({
        context: isolatedContext,
        contacts: isolatedContacts,
        decoder: isolatedDecoder,
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
        referenceKey: REFERENCE_KEY,
      }),
      Buffer.alloc(32, 9),
    );
    try {
      const result = await runtime.call("get_conversation", {
        query: "Linked Alice",
        limit: 200,
        allow_partial: false,
        include_attachment_paths: false,
        privacy_mode: "full",
      });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent?.data as { events: unknown[] }).events).toHaveLength(11);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    expect(result.events.find((event) => event.text === "thread reply")?.reply_to_ref).toMatch(/^im2_/u);
    expect(result.events.find((event) => event.text === "receipt target")?.receipt?.state).toBe("read");
    expect(result.events.find((event) => event.text === "green sms")?.edit).toMatchObject({
      state: "unavailable",
      count: null,
    });
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
      expect(partial.events.find((event) => event.message_ref && event.text_status === "malformed"))
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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

  it("fails closed when an incoming reaction actor has no stable identity", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET handle_id=NULL WHERE ROWID=13").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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

  it("serializes Foundation decoding across independent workers", async () => {
    const lock = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const left = new MessageTextDecoder(lock, 1);
    const right = new MessageTextDecoder(lock, 2);
    const [leftResult, rightResult] = await Promise.all([
      left.decode([foundationAttributedBody("left exact")]),
      right.decode([foundationAttributedBody("right exact")]),
    ]);
    expect(leftResult).toEqual([{ status: "decoded", text: "left exact" }]);
    expect(rightResult).toEqual([{ status: "decoded", text: "right exact" }]);
    expect(Atomics.load(new Int32Array(lock), 2)).toBe(1);
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
    expect(repeated.hits.map(({ message_ref: _message, conversation_ref: _conversation, ...hit }) => hit))
      .toEqual(phrase.hits.map(({ message_ref: _message, conversation_ref: _conversation, ...hit }) => hit));
    index.close();
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
      const ids = result.hits.map((hit) => resolveMessageReference(
        context.referenceKey,
        context.lineage,
        hit.message_ref,
      ).rowid);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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

  it("never loads oversized search blobs and omits only their bodies in partial mode", async () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=1")
      .run(Buffer.alloc(1024 * 1024 + 1, 0x61));
    db.prepare("UPDATE chat SET display_name='Oversized Search Match' WHERE ROWID IN (1, 2)").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
      const firstRefs = new Set(first.events.map((event) => event.message_ref).filter(Boolean));
      expect(second.events.every((event) => !event.message_ref || !firstRefs.has(event.message_ref))).toBe(true);
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

    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
        conversationOrder.push(resolveConversationReference(
          isolatedContext.referenceKey,
          isolatedContext.lineage,
          result.conversations[0].conversation_ref,
        )[0]);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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

  it("keeps Apple-linked direct service variants direct when their handles differ", () => {
    const isolated = createFixture();
    const db = new Database(isolated.databasePath);
    db.prepare("UPDATE chat SET style=45 WHERE ROWID IN (1, 2)").run();
    db.prepare("INSERT INTO handle(ROWID,id) VALUES (99,'alice@example.test')").run();
    db.prepare("INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (2,99)").run();
    db.close();
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const isolatedContext = new DatabaseContext(isolated.databasePath, REFERENCE_KEY);
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
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY);
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
      expect((await syncMessages({
        context,
        contacts,
        decoder,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).changes).toEqual([]);
    } finally {
      index.close();
      context.close();
      fixture.cleanup();
    }
  });
});

describe("stateless sync", () => {
  it("hashes existing multi-megabyte archive values without treating them as decoder inputs", async () => {
    const fixture = createFixture();
    const db = new Database(fixture.databasePath);
    db.prepare("UPDATE message SET attributedBody=? WHERE ROWID=1")
      .run(Buffer.alloc(2 * 1024 * 1024, 0x61));
    db.close();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    try {
      const first = await syncMessages({
        context,
        contacts: new UnifiedContactResolver(false),
        decoder: new MessageTextDecoder(),
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(first.changes).toEqual([]);
      expect(first.cursor).toMatch(/^im2_/u);
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("never loads oversized changed blobs and reports them only in partial mode", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      const date = appleNanoseconds("2026-08-10T12:00:00Z");
      db.prepare(`INSERT INTO message(ROWID,guid,text,attributedBody,handle_id,date,is_from_me,service)
                  VALUES (21,'oversized-sync',NULL,?,1,?,0,'iMessage')`)
        .run(Buffer.alloc(1024 * 1024 + 1, 0x61), date);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)")
        .run(date);
      db.close();

      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DECODE_FAILED" });
      const partial = await syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: true,
        privacy: "full",
      });
      expect(partial.warnings).toEqual([
        expect.objectContaining({ code: "DECODE_FAILED", skipped_count: 1 }),
      ]);
      expect(partial.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ change_type: "message_created", row_status: "partial" }),
      ]));
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("detects lifecycle changes separated by one exact Apple nanosecond", async () => {
    const fixture = createFixture();
    const recent = BigInt(Date.now() - APPLE_EPOCH_UNIX_SECONDS * 1000 - 120_000) * 1_000_000n;
    const db = new Database(fixture.databasePath);
    db.prepare("UPDATE message SET date=?, date_edited=?, text='precision before' WHERE ROWID=10")
      .run(recent, recent);
    db.prepare("UPDATE chat_message_join SET message_date=? WHERE message_id=10").run(recent);
    db.close();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const changed = new Database(fixture.databasePath);
      changed.prepare("UPDATE message SET date_edited=?, text='precision after' WHERE ROWID=10")
        .run(recent + 1n);
      changed.close();
      const second = await syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(second.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ change_type: "message_edited", text: "precision after" }),
      ]));
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("starts at latest and emits new, edited, retracted, reaction, receipt, and group changes", async () => {
    const fixture = createFixture();
    try {
      const recent = markMessagesRecentlyMutable(fixture.databasePath, [10, 12]);
      const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
      const contacts = new UnifiedContactResolver(false);
      const decoder = new MessageTextDecoder();
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      expect(first.changes).toEqual([]);

      const db = new Database(fixture.databasePath);
      const now = recent + 60 * 1_000_000_000;
      db.prepare(`INSERT INTO message(ROWID,guid,text,attributedBody,handle_id,date,is_from_me,cache_has_attachments,item_type,is_system_message,associated_message_type,date_edited,date_retracted,date_read,date_delivered,service)
                  VALUES (21,'new-21','new synced text',NULL,1,?,0,0,0,0,0,0,0,0,0,'iMessage')`).run(now);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(now);
      db.prepare("UPDATE message SET text='edited current again', date_edited=? WHERE ROWID=10").run(now + 1_000_000_000);
      db.prepare("UPDATE message SET text='superseded private value', date_edited=?, date_retracted=? WHERE ROWID=12")
        .run(now + 1_500_000_000, now + 2_000_000_000);
      db.prepare(`INSERT INTO message(ROWID,guid,handle_id,date,is_from_me,associated_message_guid,associated_message_type,service)
                  VALUES (22,'reaction-22',1,?,0,'p:0/new-21',2003,'iMessage')`).run(now + 3_000_000_000);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,22,?,0)").run(now + 3_000_000_000);
      db.prepare(`INSERT INTO message(ROWID,guid,handle_id,date,is_from_me,associated_message_guid,associated_message_type,service)
                  VALUES (24,'reaction-24',1,?,0,'p:0/new-21',3003,'iMessage')`).run(now + 3_500_000_000);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,24,?,0)").run(now + 3_500_000_000);
      db.prepare(`INSERT INTO message(ROWID,guid,handle_id,date,is_from_me,item_type,is_system_message,group_action_type,service)
                  VALUES (23,'group-23',2,?,0,1,1,1,'RCS')`).run(now + 4_000_000_000);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (4,23,?,0)").run(now + 4_000_000_000);
      db.prepare("UPDATE message SET date_delivered=?, is_delivered=1 WHERE ROWID=4").run(now + 5_000_000_000);
      db.prepare("UPDATE message SET date_read=?, is_read=1 WHERE ROWID=1").run(now + 5_500_000_000);
      db.close();

      const second = await syncMessages({ context, contacts, decoder, cursor: first.cursor, limit: 50, allowPartial: false, privacy: "full" });
      const types = new Set(second.changes.map((change) => change.change_type));
      expect(types).toContain("message_created");
      expect(types).toContain("message_edited");
      expect(types).toContain("message_retracted");
      expect(types).toContain("reaction_added");
      expect(types).toContain("reaction_removed");
      expect(types).toContain("receipt_changed");
      expect(types).toContain("group_event");
      expect(second.changes.filter((change) => change.message_ref &&
        (change.change_type === "message_edited" || change.change_type === "message_retracted"))
        .some((change) => change.current_state?.retracted)).toBe(true);
      expect(second.changes.filter((change) => change.current_state?.retracted))
        .toEqual(expect.arrayContaining([expect.not.objectContaining({ text: expect.anything() })]));
      expect(second.changes.find((change) => change.change_type === "reaction_removed")?.current_state)
        .toMatchObject({ reaction_type: 2003, present: false });
      expect(second.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          change_type: "receipt_changed",
          direction: "incoming",
          current_state: expect.objectContaining({ direction: "local", receipt: "read" }),
        }),
        expect.objectContaining({
          change_type: "receipt_changed",
          direction: "outgoing",
          current_state: expect.objectContaining({ direction: "remote", receipt: "delivered" }),
        }),
      ]));
      const created = second.changes.find((change) => change.change_type === "message_created");
      expect(resolveConversationReference(
        context.referenceKey,
        context.lineage,
        created?.conversation_ref ?? "",
      )).toEqual([1, 2]);
      context.close();
    } finally {
      fixture.cleanup();
    }
  });

  it("pages a bounded change set without omission or duplication", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 2, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      const base = appleNanoseconds("2026-08-10T12:00:00Z");
      for (let id = 21; id <= 27; id += 1) {
        const date = base + (id - 21) * 1_000_000_000;
        db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                    VALUES (?,?,'bounded sync',1,?,0,'iMessage')`).run(id, `bounded-${id}`, date);
        db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,?,?,0)")
          .run(id, date);
      }
      db.close();

      let cursor = first.cursor;
      const references: string[] = [];
      let hasMore = true;
      while (hasMore) {
        const page = await syncMessages({ context, contacts, decoder, cursor, limit: 2, allowPartial: false, privacy: "full" });
        references.push(...page.changes
          .filter((change) => change.change_type === "message_created")
          .map((change) => change.message_ref!));
        cursor = page.cursor;
        hasMore = page.hasMore;
      }
      expect(references).toHaveLength(7);
      expect(new Set(references).size).toBe(7);
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("does not emit orphan message rows that are absent from visible conversations", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                  VALUES (21,'orphan-21','not visible',1,?,0,'iMessage')`)
        .run(appleNanoseconds("2026-08-10T12:00:00Z"));
      db.close();
      const next = await syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(next.changes).toEqual([]);
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("fails closed when a reaction change has no parent identifier", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      const date = appleNanoseconds("2026-08-10T12:00:00Z");
      db.prepare(`INSERT INTO message(ROWID,guid,handle_id,date,is_from_me,associated_message_type,service)
                  VALUES (21,'parentless-reaction',1,?,0,2001,'iMessage')`).run(date);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(date);
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("accepts its own bounded sync cursor when recent exact state exceeds normal reference size", async () => {
    const fixture = createFixture();
    appendRecentMessages(fixture.databasePath, 600);
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      expect(first.cursor.length).toBeGreaterThan(MAX_REFERENCE_LENGTH);
      expect(first.cursor.length).toBeLessThanOrEqual(MAX_SYNC_CURSOR_LENGTH);
      const second = await syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      });
      expect(second.changes).toEqual([]);
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("emits reusable bounded cursors while a large live change set is paginated", async () => {
    const fixture = createFixture();
    appendRecentMessages(fixture.databasePath, 1_500);
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 200, allowPartial: false, privacy: "aggregate" });
      appendRecentMessages(fixture.databasePath, 201, 1_521, 60_000);
      const page = await syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 200,
        allowPartial: false,
        privacy: "aggregate",
      });
      expect(page.hasMore).toBe(true);
      expect(page.cursor.length).toBeLessThanOrEqual(MAX_SYNC_CURSOR_LENGTH);
      const final = await syncMessages({
        context,
        contacts,
        decoder,
        cursor: page.cursor,
        limit: 200,
        allowPartial: false,
        privacy: "aggregate",
      });
      expect(final.hasMore).toBe(false);
      expect(final.changes).toHaveLength(1);
      expect(final.cursor.length).toBeLessThanOrEqual(MAX_SYNC_CURSOR_LENGTH);
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: final.cursor,
        limit: 200,
        allowPartial: false,
        privacy: "aggregate",
      })).resolves.toMatchObject({ changes: [], hasMore: false });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("invalidates live sync when chat_lookup changes canonical conversation membership", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      const date = appleNanoseconds(new Date().toISOString());
      db.prepare("INSERT INTO chat(ROWID,guid,chat_identifier,service_name) VALUES (?,?,?,?)")
        .run(6, "chat-guid-6", "linked-new", "RCS");
      db.prepare("INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (?,?)").run(6, 1);
      db.prepare("INSERT INTO chat_lookup(identifier,domain,chat) VALUES (?,?,?)").run("linked-alice", "RCS", 6);
      db.prepare("INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (?,?,?,?,?,0,?)")
        .run(21, "lookup-new", "new linked", 1, date, "RCS");
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (?,?,?,0)")
        .run(6, 21, date);
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("fails closed on an unsupported SQLite message.text storage class", async () => {
      const fixture = createFixture();
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE message SET text=?, attributedBody=NULL WHERE ROWID=1").run(Buffer.from("concealed"));
      db.close();
      const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY);
      const input = {
        context,
        contacts: new UnifiedContactResolver(false),
        decoder: new MessageTextDecoder(),
        chatIds: [1, 2],
        limit: 200,
        bounds: compileDateBounds({ timezone: "UTC" }),
        privacy: "full" as const,
        includeAttachmentPaths: false,
      };
      try {
        await expect(getConversationEvents({ ...input, allowPartial: false }))
          .rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
        const partial = await getConversationEvents({ ...input, allowPartial: true });
        expect(partial.warnings).toContainEqual(expect.objectContaining({
          code: "UNSUPPORTED_SCHEMA",
          skipped_count: 1,
        }));
        expect(partial.events).toContainEqual(expect.objectContaining({
          text_status: "unsupported",
          row_status: "partial",
        }));
      } finally {
        context.close();
        fixture.cleanup();
      }
  });

  it("fails search and live sync closed on unsupported SQLite body storage", async () => {
    const searchFixture = createFixture();
    const searchDb = new Database(searchFixture.databasePath);
    searchDb.prepare("UPDATE message SET text=?, attributedBody=NULL WHERE ROWID=1").run(Buffer.from("concealed"));
    searchDb.close();
    const searchContext = new DatabaseContext(searchFixture.databasePath, REFERENCE_KEY);
    const index = new MemorySearchIndex(searchContext, new MessageTextDecoder(), new UnifiedContactResolver(false));
    try {
      await expect(index.search({
        query: "concealed",
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
      searchContext.close();
      searchFixture.cleanup();
    }

    const syncFixture = createFixture();
    const syncContext = new DatabaseContext(syncFixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context: syncContext, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const syncDb = new Database(syncFixture.databasePath);
      const date = appleNanoseconds(new Date().toISOString());
      syncDb.prepare("INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (?,?,?,?,?,0,?)")
        .run(21, "typed-body", Buffer.from("concealed"), 1, date, "iMessage");
      syncDb.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,?,?,0)")
        .run(21, date);
      syncDb.close();
      await expect(syncMessages({
        context: syncContext,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
    } finally {
      syncContext.close();
      syncFixture.cleanup();
    }
  });

  it("rejects schema-amplified relevant tables before materializing their columns", () => {
    const fixture = createFixture();
    const db = new Database(fixture.databasePath);
    db.exec("DROP TABLE attachment");
    db.exec(`CREATE TABLE attachment(ROWID INTEGER PRIMARY KEY, ${Array.from(
      { length: 512 },
      (_, index) => `column_${index} TEXT`,
    ).join(", ")})`);
    db.close();
    expect(() => new DatabaseContext(fixture.databasePath, REFERENCE_KEY))
      .toThrowError(expect.objectContaining({ reason: "QUERY_BUDGET_EXCEEDED" }));
    fixture.cleanup();
  });

  it("fails closed when the live edit-integrity window exceeds its cursor budget", async () => {
    const fixture = createFixture();
    appendRecentMessages(fixture.databasePath, 2_049);
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "QUERY_BUDGET_EXCEEDED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("fails closed for an append combined with an unclassifiable backdated lifecycle mutation", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      const appended = appleNanoseconds("2026-08-10T12:00:00Z");
      const backdated = appleNanoseconds("2026-03-08T06:31:00Z");
      db.prepare("UPDATE message SET text='unclassifiable current body', date_edited=? WHERE ROWID=1").run(backdated);
      db.prepare(`INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service)
                  VALUES (21,'combined-sync-append','new alongside backdated edit',1,?,0,'iMessage')`).run(appended);
      db.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,21,?,0)").run(appended);
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("rejects a count-preserving relationship mutation even when a valid edit advances", async () => {
    const fixture = createFixture();
    const recent = markMessagesRecentlyMutable(fixture.databasePath, [10]);
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE chat_message_join SET chat_id=2 WHERE chat_id=1 AND message_id=1").run();
      db.prepare("UPDATE message SET text='legitimate current edit', date_edited=? WHERE ROWID=10")
        .run(recent + 60 * 1_000_000_000);
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("does not let one valid edit authorize another recent message body mutation", async () => {
    const fixture = createFixture();
    const recent = markMessagesRecentlyMutable(fixture.databasePath, [10, 12]);
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE message SET text='legitimate current edit', date_edited=? WHERE ROWID=10")
        .run(recent + 60 * 1_000_000_000);
      db.prepare("UPDATE message SET text='unclassified recent body mutation' WHERE ROWID=12").run();
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("does not let a receipt advance authorize an unrelated body mutation", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE message SET text='unauthorized body mutation' WHERE ROWID=1").run();
      db.prepare("UPDATE message SET date_delivered=?, is_delivered=1 WHERE ROWID=4")
        .run(appleNanoseconds("2026-08-10T12:00:00Z"));
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("does not let one receipt advance authorize another receipt mutation", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE message SET date_delivered=?, is_delivered=1 WHERE ROWID=4")
        .run(appleNanoseconds(new Date(Date.now() - 60_000).toISOString()));
      db.prepare("UPDATE message SET date_read=? WHERE ROWID=18")
        .run(appleNanoseconds("2026-03-09T05:01:00Z"));
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("treats copied databases as immutable after a sync checkpoint", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "copy");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      const first = await syncMessages({ context, contacts, decoder, limit: 50, allowPartial: false, privacy: "full" });
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE message SET text='changed copied snapshot', date_edited=? WHERE ROWID=10")
        .run(appleNanoseconds("2026-08-10T12:00:00Z"));
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        cursor: first.cursor,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("rejects a copied database changed after its startup fingerprint", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "copy");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    try {
      await prepareCopiedDatabaseSync(context);
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE message SET text='changed after startup preparation' WHERE ROWID=10").run();
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        limit: 50,
        allowPartial: false,
        privacy: "full",
      })).rejects.toMatchObject({ reason: "DATABASE_CHANGED" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });

  it("invalidates warmed conversation integrity when the database changes", async () => {
    const fixture = createFixture();
    const context = new DatabaseContext(fixture.databasePath, REFERENCE_KEY, "live");
    const contacts = new UnifiedContactResolver(false);
    const decoder = new MessageTextDecoder();
    const catalog = new ConversationCatalog(context);
    try {
      catalog.warm();
      const db = new Database(fixture.databasePath);
      db.prepare(`INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state)
                  SELECT 99,message_id,message_date,index_state
                  FROM chat_message_join WHERE message_id=1 LIMIT 1`).run();
      db.close();
      await expect(syncMessages({
        context,
        contacts,
        decoder,
        limit: 50,
        allowPartial: false,
        privacy: "full",
        catalog,
      })).rejects.toMatchObject({ reason: "UNSUPPORTED_SCHEMA" });
    } finally {
      context.close();
      fixture.cleanup();
    }
  });
});

describe("Foundation fixtures", () => {
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
