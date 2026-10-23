import { describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../src/config.js";
import { UnifiedContactResolver } from "../src/contacts.js";
import { LocalToolRuntime } from "../src/runtime.js";
import { ImessageMcpError } from "../src/errors.js";
import Database from "../src/sqlite.js";
import { createFixture } from "./fixture.js";

function setup() {
  const fixture = createFixture();
  const runtime = new LocalToolRuntime(runtimeConfig({
    transport: "stdio", databasePath: fixture.databasePath, contacts: "none",
  }));
  return { fixture, runtime, close: () => { runtime.close(); fixture.cleanup(); } };
}

function conversationIds(result: Awaited<ReturnType<LocalToolRuntime["call"]>>) {
  expect(result.isError).toBeUndefined();
  const data = result.structuredContent?.data as { conversations: Array<{ chat_id: number }> };
  return data.conversations.map((chat) => chat.chat_id).sort((a, b) => a - b);
}

describe("fact-recovery paths", () => {
  it.each(["identical", "different", "unique"])(
    "scopes an exact address without expanding %s Contacts records",
    async (cards) => {
      const { runtime, close } = setup();
      const resolver = new UnifiedContactResolver(true, [
        { identifier: "home", name: "Riley Home", phones: ["+15550000001"], emails: ["unknown@example.test"] },
        ...(cards === "unique" ? [] : [{ identifier: "work", name: "Riley Work", phones: ["555-000-0001"], emails: cards === "identical" ? ["unknown@example.test"] : ["other@example.test"] }]),
      ]);
      const countArgs = { metric: "message_count", scope: "contact", contact: "5550000001" };
      const unpairedCounts = await runtime.call("analyze_communication", countArgs);
      vi.spyOn(runtime.contacts, "resolve").mockImplementation((query) => resolver.resolve(query));
      vi.spyOn(runtime.contacts, "nameForHandle").mockImplementation((handle) => resolver.nameForHandle(handle));
      try {
        const scopedCounts = await runtime.call("analyze_communication", countArgs);
        expect(scopedCounts.isError).toBeUndefined();
        expect(scopedCounts.structuredContent?.data).toEqual(unpairedCounts.structuredContent?.data);
        const identity = await runtime.call("resolve_contact", { query: "+15550000001" });
        expect(identity.structuredContent?.data).toMatchObject({ status: cards === "unique" ? "unique" : "ambiguous" });
        expect(conversationIds(await runtime.call("list_conversations", { contact: " (555) 000-0001 " }))).toEqual([1, 4]);
        expect(conversationIds(await runtime.call("list_conversations", { contact: "+15550000001", kind: "group" }))).toEqual([4]);
        expect(conversationIds(await runtime.call("list_conversations", { contact: "UNKNOWN@EXAMPLE.TEST" }))).toEqual([3]);
        expect(conversationIds(await runtime.call("list_conversations", { contact: "+15559999999" }))).toEqual([]);
        const direct = await runtime.call("get_conversation", { query: "555-000-0001", around_message_id: 19, limit: 1 });
        expect(direct.isError).toBeUndefined();
        expect(direct.structuredContent?.data).toMatchObject({ events: [{ message_id: 19, row_status: "complete" }] });
        const named = await runtime.call("list_conversations", { contact: "Riley" });
        if (cards === "unique") expect(conversationIds(named)).toEqual([1, 3, 4]);
        else expect(named).toMatchObject({ isError: true, structuredContent: { error: { reason: "AMBIGUOUS_CONTACT" } } });
      } finally { close(); }
    },
  );

  it("uses exact address scope when Contacts is unavailable and preserves privacy", async () => {
    const { runtime, close } = setup();
    try {
      expect(conversationIds(await runtime.call("list_conversations", { contact: "5550000001" }))).toEqual([1, 4]);
      const aggregate = await runtime.call("list_conversations", { contact: "+15550000001", privacy_mode: "aggregate" });
      expect(aggregate.structuredContent?.data).toMatchObject({ conversation_count: 2 });
      expect(JSON.stringify(aggregate)).not.toContain("5550000001");
      const redacted = await runtime.call("get_conversation", { query: "+15550000001", around_message_id: 19, limit: 1, privacy_mode: "redacted" });
      expect(redacted.isError).toBeUndefined();
      expect(JSON.stringify(redacted)).not.toContain("5550000001");
      expect(JSON.stringify(redacted)).not.toContain("exact wildcard");
    } finally { close(); }
  });

  it.each(["full", "redacted"])(
    "offers a usable partial-read retry for a broken reply under %s privacy",
    async (privacy_mode) => {
      const { fixture, runtime, close } = setup();
      const db = new Database(fixture.databasePath);
      db.prepare("UPDATE message SET reply_to_guid='absent-parent' WHERE ROWID=20").run();
      db.close();
      try {
        const args = { chat_id: 1, limit: 200, privacy_mode };
        const aggregate = await runtime.call("get_conversation", { ...args, privacy_mode: "aggregate" });
        expect(aggregate.isError).toBeUndefined();
        expect(aggregate.structuredContent).toMatchObject({ completeness: "complete", data: { event_count: 11 } });
        const strict = await runtime.call("get_conversation", args);
        expect(strict).toMatchObject({ isError: true, structuredContent: { error: { reason: "UNSUPPORTED_SCHEMA", details: { skipped_count: 1 } } } });
        expect((strict.content[0] as { text: string }).text).toContain("allow_partial: true");
        expect((strict.structuredContent?.error as { details: { retry: string } }).details.retry).toContain("row_status");
        expect(JSON.stringify(strict)).not.toContain("absent-parent");
        const partial = await runtime.call("get_conversation", { ...args, allow_partial: true });
        expect(partial.isError).toBeUndefined();
        expect(partial.structuredContent).toMatchObject({ completeness: "partial", warnings: [expect.objectContaining({ code: "UNSUPPORTED_SCHEMA", skipped_count: 1 })] });
        {
          const events = (partial.structuredContent?.data as { events: Array<Record<string, unknown>> }).events;
          expect(events.find((event) => event.message_id === 19)).toMatchObject({ row_status: "complete" });
          expect(events.find((event) => event.message_id === 20)).toMatchObject({ row_status: "partial" });
          expect(events.find((event) => event.message_id === 20)).not.toHaveProperty("reply_to_message_id");
        }
        const focused = await runtime.call("get_conversation", { ...args, around_message_id: 19, limit: 1 });
        expect(focused.isError).toBeUndefined();
        expect(focused.structuredContent).toMatchObject({ completeness: "complete" });
      } finally { close(); }
    },
  );

  it("does not treat an unmatched exact address as a group title", async () => {
    const { fixture, runtime, close } = setup();
    const db = new Database(fixture.databasePath);
    db.prepare("UPDATE chat SET display_name='+15559999999' WHERE ROWID=3").run();
    db.close();
    try {
      const result = await runtime.call("get_conversation", { query: "+15559999999" });
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { reason: "INVALID_INPUT" } } });
      expect(JSON.stringify(result.content)).toContain("conversation_names");
      const found = await runtime.call("search_messages", { query: "+15559999999", scopes: ["conversation_names"], mode: "substring", order: "newest", limit: 5 });
      expect(found.isError).toBeUndefined();
      const hits = (found.structuredContent?.data as { results: Array<{ chat_id: number }> }).results;
      expect(hits[0].chat_id).toBe(3);
      const selected = await runtime.call("get_conversation", { chat_id: hits[0].chat_id });
      expect(selected.isError).toBeUndefined();
    } finally { close(); }
  });

  it("requires conversation selection for distinct direct chats sharing an address", async () => {
    const { fixture, runtime, close } = setup();
    const db = new Database(fixture.databasePath);
    db.exec(`
      INSERT INTO chat(ROWID,guid,chat_identifier,service_name) VALUES (6,'separate-direct','separate-direct','iMessage');
      INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (6,1);
      INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state)
        SELECT 6,ROWID,date,0 FROM message WHERE ROWID=19;
    `);
    db.close();
    try {
      const result = await runtime.call("get_conversation", { query: "+15550000001" });
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { reason: "AMBIGUOUS_CONTACT" } } });
      expect(JSON.stringify(result.content)).toContain("call list_conversations");
      expect(conversationIds(await runtime.call("list_conversations", { contact: "+15550000001", kind: "direct" }))).toEqual([1, 6]);
      const chosen = await runtime.call("get_conversation", { chat_id: 6 });
      expect(chosen.isError).toBeUndefined();
      expect(chosen.structuredContent?.data).toMatchObject({ events: [{ message_id: 19 }] });
    } finally { close(); }
  });

  it.each(["decode", "decodeEditMetadata"] as const)(
    "offers a partial-read retry when %s throws a decoder failure",
    async (method) => {
      const { fixture, runtime, close } = setup();
      const db = new Database(fixture.databasePath);
      if (method === "decode") db.exec("UPDATE message SET text=NULL, attributedBody=x'01' WHERE ROWID=19");
      else db.exec("UPDATE message SET date_edited=date+1000000000, message_summary_info=x'01' WHERE ROWID=19");
      db.close();
      vi.spyOn(runtime.decoder, method).mockRejectedValue(new ImessageMcpError("DECODE_FAILED", "synthetic native decoder failure"));
      try {
        const args = { chat_id: 1, around_message_id: 19, limit: 1 };
        const strict = await runtime.call("get_conversation", args);
        expect(strict).toMatchObject({ isError: true, structuredContent: { error: { reason: "DECODE_FAILED" } } });
        expect(JSON.stringify(strict.content)).toContain("allow_partial: true");
        const partial = await runtime.call("get_conversation", { ...args, allow_partial: true });
        expect(partial.isError).toBeUndefined();
        expect(partial.structuredContent).toMatchObject({ completeness: "partial", data: { events: [{ message_id: 19, row_status: "partial" }] } });
      } finally { close(); }
    },
  );

  it("keeps structural failures strict even when partial reads are requested", async () => {
    const { fixture, runtime, close } = setup();
    const db = new Database(fixture.databasePath);
    db.prepare("UPDATE message SET guid='m19' WHERE ROWID=20").run();
    db.close();
    try {
      for (const allow_partial of [false, true]) {
        const result = await runtime.call("get_conversation", { chat_id: 1, limit: 200, allow_partial });
        expect(result).toMatchObject({ isError: true, structuredContent: { error: { reason: "UNSUPPORTED_SCHEMA" } } });
        expect(JSON.stringify(result)).not.toContain("allow_partial: true");
      }
    } finally { close(); }
  });
});
