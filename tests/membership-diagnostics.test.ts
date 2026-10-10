import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.js";
import { runtimeConfig } from "../src/config.js";
import { DatabaseContext } from "../src/database.js";
import { ImessageMcpError } from "../src/errors.js";
import { MAX_IDENTITY_TEXT_BYTES } from "../src/repositories/conversation-topology.js";
import * as searchIndex from "../src/search-index.js";
import Database from "../src/sqlite.js";
import * as sqlite from "../src/sqlite.js";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function archive(mutation = ""): string {
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-membership-diagnostics-"));
  directories.push(directory);
  const databasePath = path.join(directory, "synthetic-chat.db");
  const writer = new Database(databasePath);
  try {
    writer.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT,
        date INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, handle_id INTEGER
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY(chat_id, message_id));
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_lookup (identifier TEXT NOT NULL, domain TEXT NOT NULL, chat INTEGER NOT NULL);
      INSERT INTO handle VALUES (1, 'synthetic-private-handle@example.test');
      INSERT INTO chat VALUES (1, 'synthetic-chat-guid-one'), (2, 'synthetic-chat-guid-two'), (3, 'synthetic-chat-guid-three');
      INSERT INTO message(ROWID,guid,text,handle_id) VALUES
        (1,'synthetic-guid-one','synthetic private body one',1),
        (2,'synthetic-guid-two','synthetic private body two',1),
        (3,'synthetic-guid-three','synthetic private body three',1);
      INSERT INTO chat_message_join VALUES (1,1), (2,1), (1,2), (3,3);
      INSERT INTO chat_handle_join VALUES (1,1), (2,1), (3,1);
      INSERT INTO chat_lookup VALUES
        ('synthetic-apple-alias','iMessage',1), ('synthetic-apple-alias','SMS',2),
        ('synthetic-other-identifier','iMessage',3);
      ${mutation}
    `);
  } finally {
    writer.close();
  }
  return databasePath;
}

async function diagnose(
  databasePath: string,
  json = true,
  sourceMode?: "live" | "copy",
): Promise<{ code: number; text: string; checks: Check[] }> {
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const config = runtimeConfig({ transport: "stdio", databasePath, contacts: "none" });
    // Exercise live cache policy while every read still targets this synthetic
    // database, with Contacts disabled. No personal Messages path is selected.
    const code = await doctor({ ...config, ...(sourceMode ? { source_mode: sourceMode } : {}) }, json);
    const text = chunks.join("");
    return { code, text, checks: json ? (JSON.parse(text) as { checks: Check[] }).checks : [] };
  } finally {
    stdout.mockRestore();
  }
}

function membership(checks: Check[]): Check {
  const check = checks.find((entry) => entry.name === "conversation_membership");
  expect(check).toBeDefined();
  return check!;
}

function assertNoSourceDisclosure(text: string, databasePath: string): void {
  for (const value of [
    databasePath, path.dirname(databasePath), 'synthetic-private-handle@example.test',
    'synthetic-chat-guid-one', 'synthetic-guid-one', 'synthetic private body',
    'synthetic-apple-alias', 'synthetic-other-identifier',
  ]) expect(text).not.toContain(value);
}

describe("conversation membership diagnostics", () => {
  it("passes when every message has one canonical conversation, including Apple-linked aliases", async () => {
    const databasePath = archive();
    const result = await diagnose(databasePath);
    expect(result.code).toBe(0);
    expect(membership(result.checks)).toEqual({
      name: "conversation_membership", status: "pass",
      detail: "3 total messages; 3 linked; 0 shared across conversations; 0 unlinked",
    });
    expect(result.checks.find((check) => check.name === "schema")?.status).toBe("pass");
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("reports shared memberships as supported information without failing schema or doctor", async () => {
    const databasePath = archive("INSERT INTO chat_message_join VALUES (3,1);");
    const result = await diagnose(databasePath);
    expect(result.code).toBe(0);
    expect(membership(result.checks)).toMatchObject({ name: "conversation_membership", status: "warn" });
    expect(membership(result.checks).detail).toContain("3 total messages; 3 linked; 1 shared across conversations; 0 unlinked");
    expect(membership(result.checks).detail).toContain("shared memberships are supported");
    expect(result.checks.find((check) => check.name === "schema")?.status).toBe("pass");
    assertNoSourceDisclosure(result.text, databasePath);
    const text = await diagnose(databasePath, false);
    expect(text.code).toBe(0);
    expect(text.text).toMatch(/^warn conversation_membership: 3 total messages; 3 linked; 1 shared across conversations; 0 unlinked;/mu);
  });

  it("counts unlinked messages, including dangling joins, without exposing a source row", async () => {
    const databasePath = archive("DELETE FROM chat_message_join WHERE message_id = 3; INSERT INTO chat_message_join VALUES (999,3);");
    const result = await diagnose(databasePath);
    expect(result.code).toBe(0);
    expect(membership(result.checks).status).toBe("warn");
    expect(membership(result.checks).detail).toContain("3 total messages; 2 linked; 0 shared across conversations; 1 unlinked");
    expect(membership(result.checks).detail).not.toContain("999");
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("fails with a stable reason when an existing lookup namespace blocks conversation tools", async () => {
    const databasePath = archive("UPDATE chat_lookup SET domain = '' WHERE chat = 3;");
    const result = await diagnose(databasePath);
    expect(result.code).toBe(1);
    expect(membership(result.checks)).toEqual({
      name: "conversation_membership", status: "fail",
      detail: "conversation memberships could not be summarized from this archive (UNSUPPORTED_SCHEMA)",
    });
    expect(result.checks.find((check) => check.name === "schema")?.status).toBe("pass");
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("fails with a stable reason when topology exceeds its identity-text budget", async () => {
    const oversizedIdentity = "x".repeat(MAX_IDENTITY_TEXT_BYTES + 1);
    const databasePath = archive(`UPDATE handle SET id = '${oversizedIdentity}';`);
    const result = await diagnose(databasePath);
    expect(result.code).toBe(1);
    expect(membership(result.checks)).toEqual({
      name: "conversation_membership", status: "fail",
      detail: "conversation memberships could not be summarized from this archive (QUERY_BUDGET_EXCEEDED)",
    });
    expect(result.text).not.toContain(oversizedIdentity);
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("preserves the schema failure reason and marks membership unavailable when core tables are missing", async () => {
    const databasePath = archive("DROP TABLE chat_message_join;");
    const result = await diagnose(databasePath);
    expect(result.code).toBe(1);
    expect(result.checks.find((check) => check.name === "schema")).toMatchObject({ status: "fail" });
    expect(result.checks.find((check) => check.name === "schema")?.detail).toContain("UNSUPPORTED_SCHEMA");
    expect(membership(result.checks).detail).toContain("UNSUPPORTED_SCHEMA");
    expect(membership(result.checks).status).toBe("fail");
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("does not forward uncontrolled exception text from a failed summary", async () => {
    const databasePath = archive();
    vi.spyOn(DatabaseContext.prototype, "request").mockImplementation(() => {
      throw new Error(`synthetic private body one at ${databasePath}`);
    });
    const result = await diagnose(databasePath);
    expect(result.code).toBe(0);
    expect(membership(result.checks)).toEqual({
      name: "conversation_membership", status: "warn",
      detail: "conversation memberships could not be summarized from this archive",
    });
    expect(result.checks.find((check) => check.name === "search_index_capacity")?.status).toBe("warn");
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it.each(["UNSUPPORTED_SCHEMA", "QUERY_BUDGET_EXCEEDED", "INDEX_TOO_LARGE"] as const)(
    "fails and preserves %s when a known error blocks search capacity estimation",
    async (reason) => {
      const databasePath = archive();
      vi.spyOn(searchIndex, "estimateSearchIndexFloor").mockImplementation(() => {
        throw new ImessageMcpError(reason, `synthetic private body one at ${databasePath}`);
      });
      const result = await diagnose(databasePath);
      expect(result.code).toBe(1);
      expect(membership(result.checks).status).toBe("pass");
      expect(result.checks.find((check) => check.name === "search_index_capacity")).toEqual({
        name: "search_index_capacity", status: "fail",
        detail: `the search index size could not be estimated from this archive (${reason})`,
      });
      assertNoSourceDisclosure(result.text, databasePath);
    },
  );
});

describe("SQLite checkpoint diagnostics", () => {
  it("warns when enabled live caching lacks checkpoint APIs while search remains available in memory", async () => {
    const databasePath = archive();
    vi.stubEnv("IMESSAGE_CACHE", "1");
    const feature = vi.spyOn(sqlite, "sqliteCheckpointAvailable").mockReturnValue(false);
    const result = await diagnose(databasePath, true, "live");
    expect(feature).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.checks.find((check) => check.name === "index_cache")).toEqual({
      name: "index_cache", status: "warn",
      detail: "this Node runtime lacks SQLite checkpoint support; search works in memory and rebuilds after restart",
    });
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("retains the enabled cache diagnostic when checkpoint APIs are available", async () => {
    const databasePath = archive();
    vi.stubEnv("IMESSAGE_CACHE", "1");
    const feature = vi.spyOn(sqlite, "sqliteCheckpointAvailable").mockReturnValue(true);
    const result = await diagnose(databasePath, true, "live");
    expect(feature).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    const check = result.checks.find((entry) => entry.name === "index_cache");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toMatch(/^(?:encrypted index cache in .+; deleting it only costs one rebuild|no index cache yet; the first search builds it)$/u);
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("reports an explicit cache opt-out without warning about unavailable checkpoint APIs", async () => {
    const databasePath = archive();
    vi.stubEnv("IMESSAGE_CACHE", "0");
    const feature = vi.spyOn(sqlite, "sqliteCheckpointAvailable").mockReturnValue(false);
    const result = await diagnose(databasePath, true, "live");
    expect(feature).not.toHaveBeenCalled();
    expect(result.checks.find((check) => check.name === "index_cache")).toEqual({
      name: "index_cache", status: "pass",
      detail: "encrypted index cache is off (IMESSAGE_CACHE=0); search works in memory and rebuilds after restart",
    });
    assertNoSourceDisclosure(result.text, databasePath);
  });

  it("reports copied archives as intentionally uncached regardless of checkpoint support", async () => {
    const databasePath = archive();
    vi.stubEnv("IMESSAGE_CACHE", "1");
    const feature = vi.spyOn(sqlite, "sqliteCheckpointAvailable").mockReturnValue(false);
    const result = await diagnose(databasePath);
    expect(feature).not.toHaveBeenCalled();
    expect(result.checks.find((check) => check.name === "index_cache")).toEqual({
      name: "index_cache", status: "pass",
      detail: "copied databases keep the search index in memory; search rebuilds after restart",
    });
    assertNoSourceDisclosure(result.text, databasePath);
  });
});
