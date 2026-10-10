import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseContext, type DatabaseRequest } from "../src/database.js";
import Database from "../src/sqlite.js";
import { UnifiedContactResolver } from "../src/contacts.js";
import { MessageTextDecoder } from "../src/decoder.js";
import { MemorySearchIndex } from "../src/search-index.js";
import { compileDateBounds } from "../src/time.js";
import { conversationChatIds } from "../src/repositories/conversations.js";
import { conversationMembershipSummary, membershipFields, messageConversationIds, registerConversationTopology } from "../src/repositories/conversation-topology.js";

describe("recorded conversation topology", () => {
  let directory: string;
  let writer: Database;
  let context: DatabaseContext | undefined;
  let request: DatabaseRequest | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "imessage-topology-"));
    writer = new Database(path.join(directory, "chat.db"));
    writer.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_lookup (domain TEXT, identifier TEXT, chat INTEGER);
      INSERT INTO handle VALUES (1, 'synthetic@example.test');
      INSERT INTO chat VALUES (1, 'chat-one'), (2, 'chat-two'), (3, 'chat-three');
      INSERT INTO message VALUES (1, 'message-one', 'synthetic one', 0, 0, 1), (2, 'message-two', 'synthetic two', 0, 0, 1), (3, 'message-three', 'synthetic three', 0, 0, 1);
      INSERT INTO chat_message_join VALUES (1,1), (2,1), (3,2);
      INSERT INTO chat_handle_join VALUES (1,1), (2,1), (3,1);
      INSERT INTO chat_lookup VALUES ('iMessage','alias',1), ('SMS','alias',2), ('iMessage','third',3);
    `);
  });

  afterEach(() => {
    request?.close();
    context?.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
    request = undefined;
    context = undefined;
  });

  const snapshot = () => {
    context = new DatabaseContext(path.join(directory, "chat.db"), "copy");
    request = context.request();
    registerConversationTopology(request);
    return request;
  };

  it("deduplicates raw aliases and duplicate joins within one explicit Apple component", () => {
    writer.exec("INSERT INTO chat_message_join VALUES (1,1), (2,1)");
    const current = snapshot();
    expect(messageConversationIds(current, 1)).toEqual([1]);
    expect(conversationChatIds(current, 2)).toEqual([1, 2]);
    expect(conversationMembershipSummary(current)).toEqual({ total_messages: 3, joined_messages: 2, shared_messages: 0, unlinked_messages: 1 });
  });

  it("supports shared messages when the optional lookup table is absent", () => {
    writer.exec("DROP TABLE chat_lookup");
    const current = snapshot();
    expect(messageConversationIds(current, 1)).toEqual([1, 2]);
    expect(conversationChatIds(current, 1)).toEqual([1]);
    expect(conversationChatIds(current, 2)).toEqual([2]);
    expect(conversationMembershipSummary(current).shared_messages).toBe(1);
  });

  it("uses transitive explicit lookup evidence without inferring links from participants", () => {
    writer.exec("INSERT INTO chat_lookup VALUES ('SMS','third',2)");
    const current = snapshot();
    expect(messageConversationIds(current, 2)).toEqual([1]);
    expect(conversationChatIds(current, 3)).toEqual([1, 2, 3]);
  });

  it("ignores a dangling lookup alias instead of publishing a canonical id for a deleted chat", () => {
    writer.exec("DELETE FROM chat WHERE ROWID = 1");
    const current = snapshot();
    expect(messageConversationIds(current, 1)).toEqual([2]);
    expect(conversationChatIds(current, 2)).toEqual([2]);
    expect(conversationMembershipSummary(current)).toEqual({ total_messages: 3, joined_messages: 2, shared_messages: 0, unlinked_messages: 1 });
  });

  it("classifies dangling joins as unlinked without inventing memberships", () => {
    writer.exec("INSERT INTO chat_message_join VALUES (999,3)");
    const current = snapshot();
    expect(messageConversationIds(current, 3)).toEqual([]);
    expect(conversationMembershipSummary(current).unlinked_messages).toBe(1);
  });

  it("validates existing lookup rows but disregards invalid labels on deleted chats", () => {
    writer.exec("INSERT INTO chat_lookup VALUES ('','',999)");
    expect(messageConversationIds(snapshot(), 1)).toEqual([1]);
  });

  it("does not let a batch of dangling joins hide later searchable messages", async () => {
    writer.exec(`
      DELETE FROM chat_message_join;
      WITH RECURSIVE ids(id) AS (VALUES(4) UNION ALL SELECT id+1 FROM ids WHERE id<220)
      INSERT INTO message SELECT id, 'message-'||id, 'unlinked synthetic', 0, 0, 1 FROM ids;
      INSERT INTO chat_message_join SELECT 999, ROWID FROM message;
      INSERT INTO message VALUES (300, 'surviving-message', 'surviving synthetic needle', 0, 0, 1);
      INSERT INTO chat_message_join VALUES (3,300);
    `);
    const current = snapshot();
    expect(conversationMembershipSummary(current).unlinked_messages).toBe(220);
    const index = new MemorySearchIndex(context!, new MessageTextDecoder(), new UnifiedContactResolver(false));
    try {
      const result = await index.search({
        query: "surviving synthetic needle", mode: "exact", scopes: ["text"], order: "newest",
        bounds: compileDateBounds({ timezone: "UTC" }), limit: 50, allowPartial: false, privacy: "full",
      });
      expect(result.total).toBe(1);
      expect(result.hits[0]).toMatchObject({ message_id: 300, chat_id: 3, chat_ids: [3] });
      expect(index.state().indexed_messages).toBe(1);
    } finally {
      index.close();
    }
  });

  it("returns a singular id only for exactly one distinct membership and bounds fanout", () => {
    expect(membershipFields([3, 1, 3])).toEqual({ chat_ids: [1, 3] });
    expect(membershipFields([2, 2])).toEqual({ chat_ids: [2], chat_id: 2 });
    expect(membershipFields([])).toEqual({ chat_ids: [] });
    expect(() => membershipFields(Array.from({ length: 1001 }, (_, index) => index + 1)))
      .toThrowError(expect.objectContaining({ reason: "QUERY_BUDGET_EXCEEDED" }));
  });
});
