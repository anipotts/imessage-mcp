import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnifiedContactResolver } from "../src/contacts.js";
import { DatabaseContext } from "../src/database.js";
import { MessageTextDecoder } from "../src/decoder.js";
import { MemorySearchIndex } from "../src/search-index.js";
import Database from "../src/sqlite.js";
import { compileDateBounds } from "../src/time.js";
import { appleNanoseconds, createFixture, type Fixture } from "./fixture.js";

describe("encrypted index checkpoint", () => {
  let fixture: Fixture;
  let cacheDirectory: string;
  const open: Array<{ index: MemorySearchIndex; context: DatabaseContext }> = [];

  const start = () => {
    const context = new DatabaseContext(fixture.databasePath, "copy");
    const onBuild = vi.fn();
    const index = new MemorySearchIndex(context, new MessageTextDecoder(), new UnifiedContactResolver(false), onBuild, cacheDirectory);
    open.push({ index, context });
    return { index, onBuild };
  };
  const search = (index: MemorySearchIndex, query: string) => index.search({
    query, mode: "substring", scopes: ["text"], order: "newest",
    bounds: compileDateBounds({ timezone: "UTC" }), limit: 50, allowPartial: true, privacy: "full",
  });
  const stop = () => {
    for (const { index, context } of open.splice(0)) {
      index.close();
      context.close();
    }
  };
  const write = (sql: string, ...params: unknown[]) => {
    const writer = new Database(fixture.databasePath);
    try {
      writer.prepare(sql).run(...params);
    } finally {
      writer.close();
    }
  };

  beforeEach(() => {
    fixture = createFixture();
    cacheDirectory = mkdtempSync(path.join(tmpdir(), "imessage-mcp-cache-"));
  });

  afterEach(() => {
    stop();
    fixture.cleanup();
    rmSync(cacheDirectory, { recursive: true, force: true });
  });

  it("restores the index on the next start without rebuilding", async () => {
    const first = start();
    expect((await search(first.index, "hello literal")).total).toBe(1);
    expect(first.onBuild).toHaveBeenCalledTimes(1);
    stop();
    const files = readdirSync(cacheDirectory);
    expect(files).toHaveLength(1);
    expect(statSync(path.join(cacheDirectory, files[0])).mode & 0o777).toBe(0o600);

    const second = start();
    expect((await search(second.index, "hello literal")).total).toBe(1);
    expect(second.onBuild).not.toHaveBeenCalled();
  });

  it("catches up on changes made while no server was running, and keeps sync cursors valid", async () => {
    const first = start();
    await first.index.ensure(true);
    const log = first.index.changeLog();
    stop();

    const date = appleNanoseconds("2026-08-10T12:00:00Z");
    write("INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (40,'while-offline','written while offline',1,?,0,'iMessage')", date);
    write("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,40,?,0)", date);
    write("UPDATE message SET text = 'offline edit' WHERE ROWID = 2");

    const second = start();
    expect((await search(second.index, "written while offline")).total).toBe(1);
    expect((await search(second.index, "reply one")).total).toBe(0);
    expect(second.onBuild).not.toHaveBeenCalled();
    const resumed = second.index.changeLog();
    expect(resumed.logId).toBe(log.logId);
    expect(resumed.read(log.latestSeq, 10).map((row) => [row.type, row.rowid])).toEqual([
      ["message_edited", 2],
      ["message_created", 40],
    ]);
  });

  it("rebuilds when the checkpoint no longer opens for this archive", async () => {
    const first = start();
    await first.index.ensure(true);
    stop();
    // Deleting every row the key was derived from locks the checkpoint.
    write("DELETE FROM chat_message_join");
    write("DELETE FROM message");
    const second = start();
    await second.index.ensure(true);
    expect(second.onBuild).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when no cache directory is configured", async () => {
    const context = new DatabaseContext(fixture.databasePath, "copy");
    const index = new MemorySearchIndex(context, new MessageTextDecoder(), new UnifiedContactResolver(false));
    try {
      await index.ensure(true);
    } finally {
      index.close();
      context.close();
    }
    expect(existsSync(cacheDirectory) ? readdirSync(cacheDirectory) : []).toEqual([]);
  });
});
