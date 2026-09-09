import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { UnifiedContactResolver } from "../src/contacts.js";
import { DatabaseContext } from "../src/database.js";
import { MessageTextDecoder } from "../src/decoder.js";
import { MemorySearchIndex } from "../src/search-index.js";
import { compileDateBounds } from "../src/time.js";
import { createFixture } from "./fixture.js";

it("reports a rebuild after the database changes mid-session and returns fresh results", async () => {
  const fixture = createFixture();
  const writer = new Database(fixture.databasePath);
  const context = new DatabaseContext(fixture.databasePath, Buffer.alloc(32, 0x5a), Buffer.alloc(32, 0x6b));
  const onBuild = vi.fn();
  const index = new MemorySearchIndex(context, new MessageTextDecoder(), new UnifiedContactResolver(false), onBuild);
  const search = (query: string) => index.search({
    query, mode: "exact", scopes: ["text"], order: "newest",
    bounds: compileDateBounds({ timezone: "UTC" }), limit: 50, allowPartial: true, privacy: "full",
  });
  try {
    writer.prepare("UPDATE message SET text = ? WHERE ROWID = 1").run("refresh before");
    expect((await search("refresh before")).total).toBe(1);
    expect(onBuild).toHaveBeenCalledTimes(1);
    writer.prepare("UPDATE message SET text = ? WHERE ROWID = 1").run("refresh after");
    expect((await search("refresh after")).total).toBe(1);
    expect(onBuild).toHaveBeenCalledTimes(2);
    expect((await search("refresh before")).total).toBe(0);
    expect(onBuild).toHaveBeenCalledTimes(2);
  } finally {
    index.close();
    context.close();
    writer.close();
    fixture.cleanup();
  }
});
