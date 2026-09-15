// End-to-end suite for imessage-mcp 3.0: launches the real built server (stdio
// and HTTP) against synthetic fixture databases and drives it with the actual
// MCP client SDK, the way a real client would. Never points at the user's own
// Messages/Contacts: every server this file launches gets `--database
// <fixture copy>` and `--contacts none`.
//
// Output-schema validation: the v2 `@modelcontextprotocol/client` package
// validates a tool's `structuredContent` against its own advertised
// `outputSchema` inside `callTool()` and throws a `ProtocolError` if it does
// not match (see `Client.prototype.callTool` in
// node_modules/@modelcontextprotocol/client/dist/index.mjs). This suite
// relies on that behavior instead of shipping a second JSON Schema validator:
// any `callTool()` call below that resolves without throwing, for a result
// with `isError` unset, has already been checked against the schema the
// server itself advertised over the wire.
//
// Assumes `npm run build` has already produced dist/. Run with:
//   npm run build && npx vitest run --config vitest.e2e.config.ts

import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Database from "../src/sqlite.js";
import { appleNanoseconds, createFixture, type Fixture } from "./fixture.js";

// ---------------------------------------------------------------------------
// Paths, build guard, and shared fixtures
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const binPath = path.join(repoRoot, "bin", "imessage-mcp.js");
const cliDistPath = path.join(repoRoot, "dist", "cli.js");

if (!existsSync(cliDistPath)) {
  throw new Error(
    `dist/cli.js is missing at ${cliDistPath}. The e2e suite does not build the project itself: ` +
      "run `npm run build` (or `npm run e2e`, which does this for you) before `vitest run --config vitest.e2e.config.ts`.",
  );
}

const packageVersion = (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version;

const TOOL_NAMES = [
  "analyze_communication",
  "get_attachment",
  "get_conversation",
  "list_conversations",
  "resolve_contact",
  "search_messages",
  "server_status",
  "sync_messages",
].sort();

// ---------------------------------------------------------------------------
// Cleanup registry: every child process, client, temp directory, and fixture
// created by a test is tracked here and torn down in afterEach, even when the
// test throws.
// ---------------------------------------------------------------------------

const openClients: Client[] = [];
const openChildren: ChildProcessWithoutNullStreams[] = [];
const tempDirs: string[] = [];
const openFixtures: Fixture[] = [];

function trackFixture(fixture: Fixture): Fixture {
  openFixtures.push(fixture);
  return fixture;
}

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function trackClient(client: Client): Client {
  openClients.push(client);
  return client;
}

function trackChild(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
  openChildren.push(child);
  return child;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  timeout.unref();
  await once(child, "exit").catch(() => undefined);
  clearTimeout(timeout);
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const child of openChildren.splice(0)) await stopChild(child);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const fixture of openFixtures.splice(0)) fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    IMESSAGE_UPDATE_CHECK: "0",
    IMESSAGE_WARM_SEARCH: "0",
    ...extra,
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function connectStdio(args: string[], envExtra: Record<string, string | undefined> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, ...args],
    cwd: repoRoot,
    env: baseEnv(envExtra),
    stderr: "pipe",
  });
  const client = trackClient(new Client({ name: "imessage-mcp-e2e", version: "1.0.0" }));
  await client.connect(transport);
  return client;
}

function structuredData(result: { structuredContent?: unknown; isError?: boolean }): Record<string, unknown> {
  expect(result.isError, "expected a success result").toBeUndefined();
  const structured = result.structuredContent as { data?: unknown } | undefined;
  expect(structured?.data, "expected structuredContent.data").toBeDefined();
  return structured!.data as Record<string, unknown>;
}

function structuredError(result: { structuredContent?: unknown; isError?: boolean }): { reason: string; message: string } {
  expect(result.isError, "expected an error result").toBe(true);
  const structured = result.structuredContent as { error?: { reason: string; message: string } } | undefined;
  expect(structured?.error, "expected structuredContent.error").toBeDefined();
  return structured!.error;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("failed to allocate a free TCP port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHttpReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  const stderr = child.stderr;
  let buffered = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`HTTP server did not report ready in time; stderr: ${buffered.slice(-2000)}`)), 15_000);
    const onExit = () => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited before becoming ready; stderr: ${buffered.slice(-2000)}`));
    };
    child.once("exit", onExit);
    stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (!buffered.includes('"status":"ready"')) return;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve();
    });
  });
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// 1. stdio handshake: server metadata, tools, prompts, resources
// ---------------------------------------------------------------------------

describe("stdio handshake", () => {
  it("advertises server metadata, every tool, every prompt, and the conversation resources", async () => {
    const fixture = trackFixture(createFixture());
    const client = await connectStdio(["--database", fixture.databasePath, "--contacts", "none"]);

    const server = client.getServerVersion();
    expect(server?.name).toBe("imessage-mcp");
    expect(server?.title).toBe("iMessage");
    expect(server?.version).toBe(packageVersion);
    expect(server?.icons?.length ?? 0).toBeGreaterThan(0);

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/untrusted archival data/u);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    for (const tool of tools.tools) {
      expect(tool.title, `${tool.name} needs a title`).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be readOnlyHint`).toBe(true);
      const outputSchema = tool.outputSchema as { type?: string } | undefined;
      expect(outputSchema?.type, `${tool.name} needs an object output schema`).toBe("object");
    }

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual(["catch_up", "draft_reply", "recap"]);
    for (const prompt of prompts.prompts) {
      expect(prompt.arguments ?? [], `${prompt.name} must take no arguments`).toEqual([]);
    }

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain("imessage://conversations");

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain("imessage://conversations/{chat_id}");
  });
});

// ---------------------------------------------------------------------------
// 2. every tool, at every privacy mode, validates against its own schema
// ---------------------------------------------------------------------------

describe("tool outputs at every privacy mode", () => {
  it("returns schema-valid results for every tool at full, redacted, and aggregate, and aggregate carries no fixture identifiers or bodies", async () => {
    const fixture = trackFixture(createFixture());
    const client = await connectStdio(["--database", fixture.databasePath, "--contacts", "none"]);

    // Realistic ids, taken from the tools that produce them, per privacy full.
    const conversations = structuredData(
      await client.callTool({ name: "list_conversations", arguments: { limit: 50, privacy_mode: "full" } }),
    ) as { conversations: Array<{ chat_id: number }> };
    expect(conversations.conversations.length).toBeGreaterThan(0);
    const chatId = conversations.conversations[0].chat_id;
    expect(chatId).toBeTypeOf("number");

    const conversation = structuredData(
      await client.callTool({ name: "get_conversation", arguments: { chat_id: chatId, limit: 20, privacy_mode: "full" } }),
    ) as { events: Array<{ message_id?: number }> };
    const messageEvent = conversation.events.find((event) => typeof event.message_id === "number");
    expect(messageEvent, "fixture conversation must contain at least one message event").toBeDefined();
    const messageId = messageEvent!.message_id!;

    const callsFor = (): Array<[string, Record<string, unknown>]> => [
      ["server_status", {}],
      ["resolve_contact", { query: "+15550000001" }],
      ["list_conversations", { limit: 10 }],
      ["get_conversation", { chat_id: chatId, around_message_id: messageId, limit: 10 }],
      ["search_messages", { query: "hello", mode: "substring", limit: 10 }],
      ["analyze_communication", { metric: "message_count", scope: "global" }],
      ["sync_messages", { limit: 10 }],
    ];

    const allResults: unknown[] = [];
    for (const privacy of ["full", "redacted", "aggregate"] as const) {
      for (const [name, args] of callsFor()) {
        const result = await client.callTool({ name, arguments: { ...args, privacy_mode: privacy } });
        expect(result.isError, `${name} at privacy ${privacy} must succeed`).toBeUndefined();
        if (privacy === "aggregate") allResults.push(result.structuredContent);
      }
    }

    const serializedAggregate = JSON.stringify(allResults);
    for (const needle of [
      "hello literal",
      "reply one",
      "blob exact",
      "thread reply",
      "photo.png",
      "+15550000001",
      "+15550000002",
      "unknown@example.test",
      "Synthetic Group",
    ]) {
      expect(serializedAggregate, `aggregate output must not contain "${needle}"`).not.toContain(needle);
    }
    // Per-record arrays (the actual carriers of message_id/chat_id/attachment_id
    // values) collapse to counts under aggregate privacy; schema_capabilities.tables
    // legitimately lists column *names* like "message_id" as schema metadata, so
    // this checks the per-tool data shapes rather than banning those words outright.
    for (const raw of allResults) {
      const data = (raw as { data?: Record<string, unknown> }).data ?? {};
      for (const key of ["conversations", "events", "results", "changes"]) {
        expect(data[key], `aggregate data.${key} must not be a per-record array`).toBeUndefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. get_attachment: metadata at full, restricted below full
// ---------------------------------------------------------------------------

describe("get_attachment", () => {
  it("returns not_downloaded metadata for the fixture attachment at full privacy", async () => {
    const fixture = trackFixture(createFixture());
    const client = await connectStdio(["--database", fixture.databasePath, "--contacts", "none"]);
    // attachment_id 1 is attached to message 7 in the fixture; its filename
    // points at a path that does not exist on this machine.
    const data = structuredData(await client.callTool({ name: "get_attachment", arguments: { attachment_id: 1 } })) as {
      content: string;
      reason?: string;
    };
    expect(data.content).toBe("metadata");
    expect(data.reason).toBe("not_downloaded");
  });

  it("is PRIVACY_RESTRICTED when the server's privacy ceiling is below full", async () => {
    const fixture = trackFixture(createFixture());
    const client = await connectStdio(["--database", fixture.databasePath, "--contacts", "none", "--privacy", "redacted"]);
    const error = structuredError(await client.callTool({ name: "get_attachment", arguments: { attachment_id: 1 } }));
    expect(error.reason).toBe("PRIVACY_RESTRICTED");
  });
});

// ---------------------------------------------------------------------------
// 4. sync_messages: cursor, then a message_created change after an append
// ---------------------------------------------------------------------------

describe("sync_messages", () => {
  it("returns a cursor on the first call, then reports a message_created change after a message is appended", async () => {
    const fixture = trackFixture(createFixture());
    const client = await connectStdio(["--database", fixture.databasePath, "--contacts", "none"]);

    const first = structuredData(await client.callTool({ name: "sync_messages", arguments: { limit: 50 } })) as { cursor: string };
    expect(first.cursor).toMatch(/^im3_sync_/u);

    const writer = new Database(fixture.databasePath);
    try {
      const date = appleNanoseconds("2026-03-11T00:00:00Z");
      writer.prepare(
        "INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (500,'sync-e2e-append','fresh e2e message',1,?,0,'iMessage')",
      ).run(date);
      writer.prepare("INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,500,?,0)").run(date);
    } finally {
      writer.close();
    }

    const second = structuredData(
      await client.callTool({ name: "sync_messages", arguments: { limit: 50, cursor: first.cursor } }),
    ) as { changes: Array<Record<string, unknown>> };
    const created = second.changes.find((change) => change.change_type === "message_created" && change.message_id === 500);
    expect(created, "expected a message_created change for the appended message").toBeDefined();
    expect(created!.text).toBe("fresh e2e message");
  });
});

// ---------------------------------------------------------------------------
// 5. resources
// ---------------------------------------------------------------------------

describe("resources", () => {
  it("reads imessage://conversations and a templated imessage://conversations/{chat_id}", async () => {
    const fixture = trackFixture(createFixture());
    const client = await connectStdio(["--database", fixture.databasePath, "--contacts", "none"]);

    const list = await client.readResource({ uri: "imessage://conversations" });
    expect(list.contents[0]?.mimeType).toBe("application/json");
    const listParsed = JSON.parse(list.contents[0]?.text as string) as { data: { conversations: Array<{ chat_id: number }> } };
    expect(Array.isArray(listParsed.data.conversations)).toBe(true);
    expect(listParsed.data.conversations.length).toBeGreaterThan(0);
    const chatId = listParsed.data.conversations[0].chat_id;

    const one = await client.readResource({ uri: `imessage://conversations/${chatId}` });
    expect(one.contents[0]?.mimeType).toBe("application/json");
    const oneParsed = JSON.parse(one.contents[0]?.text as string) as { data: { events: unknown[] } };
    expect(Array.isArray(oneParsed.data.events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. invalid arguments: isError INVALID_INPUT, not a protocol error
// ---------------------------------------------------------------------------

describe("invalid input", () => {
  it("returns an isError result with reason INVALID_INPUT instead of a protocol-level error", async () => {
    const fixture = trackFixture(createFixture());
    const client = await connectStdio(["--database", fixture.databasePath, "--contacts", "none"]);
    const error = structuredError(await client.callTool({ name: "server_status", arguments: { unknown_field: true } }));
    expect(error.reason).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 7. unreadable database: stays connected, reports the fix, recovers in place
// ---------------------------------------------------------------------------

describe("unreadable database", () => {
  it("stays connected, reports the fix, and recovers once the database becomes readable, with no restart", async () => {
    const fixture = trackFixture(createFixture());
    const directory = trackDir(mkdtempSync(path.join(tmpdir(), "imessage-mcp-e2e-unreadable-")));
    const databasePath = path.join(directory, "chat.db");
    const client = await connectStdio(["--database", databasePath, "--contacts", "none"]);

    const failed = await client.callTool({ name: "list_conversations", arguments: { limit: 5 } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toMatch(/was not found/u);

    copyFileSync(fixture.databasePath, databasePath);

    const recovered = await client.callTool({ name: "list_conversations", arguments: { limit: 5 } });
    expect(recovered.isError, "the next call after the database becomes readable must succeed without a restart").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. HTTP transport: auth/origin gating before body parsing, authenticated MCP
// ---------------------------------------------------------------------------

describe("http transport", () => {
  it("rejects requests without the token or with a foreign Origin before parsing the body, and serves an authenticated client", async () => {
    const fixture = trackFixture(createFixture());
    const port = await freePort();
    const token = randomToken();

    const child = trackChild(spawn(process.execPath, [
      binPath,
      "--transport", "http",
      "--port", String(port),
      "--database", fixture.databasePath,
      "--contacts", "none",
    ], {
      cwd: repoRoot,
      env: baseEnv({ IMESSAGE_API_TOKEN: token }),
      stdio: ["ignore", "ignore", "pipe"],
    }));
    await waitForHttpReady(child);

    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const invalidJsonBody = "{ this is not valid json";

    const unauthenticated = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: invalidJsonBody,
    });
    expect(unauthenticated.status, "a missing token must be rejected before the body is parsed").toBe(401);

    const foreignOrigin = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: invalidJsonBody,
    });
    expect(foreignOrigin.status, "a foreign Origin must be rejected before the body is parsed").toBe(403);

    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: { token: async () => token },
    });
    const client = trackClient(new Client({ name: "imessage-mcp-e2e-http", version: "1.0.0" }));
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
  });
});

function randomToken(): string {
  // 32 random bytes as base64url is exactly 43 characters, matching what
  // IMESSAGE_API_TOKEN requires (>= 32 bytes) and what an operator would
  // generate for real.
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// 9. Node version floor
// ---------------------------------------------------------------------------

describe("node version floor", () => {
  const oldNodeBinary = path.join(homedir(), ".nvm", "versions", "node", "v22.22.3", "bin", "node");
  const hasOldNode = existsSync(oldNodeBinary);
  const testName = hasOldNode
    ? "refuses to run on Node older than 24.16"
    : `refuses to run on Node older than 24.16 (skipped: no Node binary at ${oldNodeBinary})`;

  it.skipIf(!hasOldNode)(testName, () => {
    const result = spawnSync(oldNodeBinary, [binPath, "--version"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/needs Node 24\.16/u);
  });
});

// ---------------------------------------------------------------------------
// 10. Older protocol clients
//
// The task asked to first check whether the v1 `@modelcontextprotocol/sdk`
// package is installable offline from the npm cache, and if so avoid
// installing it and instead check whether the v2 client can pin an older
// protocolVersion. Rather than probing the npm cache (which would still risk
// a network round trip and leaves stray files if it succeeds), this reads
// node_modules/@modelcontextprotocol/client directly: `ClientOptions` (an
// alias of `ProtocolOptions`) exposes `supportedProtocolVersions: string[]`,
// and `Client.connect()`'s plain-legacy path offers `legacyProtocolVersions
// (this._supportedProtocolVersions)[0]` as the `initialize` request's
// `protocolVersion`. Pinning `supportedProtocolVersions: ["2025-06-18"]`
// therefore makes a real v2 client negotiate exactly that older wire version
// with no dependency installed at all, which is a strictly better test than
// installing the abandoned v1 package.
// ---------------------------------------------------------------------------

describe("older protocol version clients", () => {
  it("accepts a client pinned to protocol version 2025-06-18 and lists tools", async () => {
    const fixture = trackFixture(createFixture());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binPath, "--database", fixture.databasePath, "--contacts", "none"],
      cwd: repoRoot,
      env: baseEnv(),
      stderr: "pipe",
    });
    const client = trackClient(new Client(
      { name: "imessage-mcp-e2e-legacy-protocol", version: "1.0.0" },
      { supportedProtocolVersions: ["2025-06-18"] },
    ));
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion?.()).toBe("2025-06-18");
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
  });
});

// ---------------------------------------------------------------------------
// 11. Concurrency while the first build runs in the background
// ---------------------------------------------------------------------------

describe("concurrency during the first search-index build", () => {
  it("keeps list_conversations fast while a 60,000-message index builds in the background", async () => {
    const fixture = trackFixture(createFixture());
    const writer = new Database(fixture.databasePath);
    try {
      const insertMessage = writer.prepare(
        "INSERT INTO message(ROWID,guid,text,handle_id,date,is_from_me,service) VALUES (@rowid,@guid,@text,1,@date,0,'iMessage')",
      );
      const insertJoin = writer.prepare(
        "INSERT INTO chat_message_join(chat_id,message_id,message_date,index_state) VALUES (1,@rowid,@date,0)",
      );
      const base = appleNanoseconds("2026-04-01T00:00:00Z");
      const insertAll = writer.transaction(() => {
        for (let i = 0; i < 60_000; i += 1) {
          const rowid = 200_000 + i;
          const date = base + i * 1_000_000_000;
          insertMessage.run({ rowid, guid: `bulk-${i}`, text: `bulk message ${i}`, date });
          insertJoin.run({ rowid, date });
        }
      });
      insertAll();
    } finally {
      writer.close();
    }

    // No IMESSAGE_WARM_SEARCH=0 here: the index build starts in the background
    // right after the server opens the database.
    const client = await connectStdio(
      ["--database", fixture.databasePath, "--contacts", "none"],
      { IMESSAGE_WARM_SEARCH: undefined },
    );

    const started = Date.now();
    const listed = await client.callTool({ name: "list_conversations", arguments: { limit: 10 } });
    const elapsed = Date.now() - started;
    expect(listed.isError).toBeUndefined();
    expect(elapsed, "list_conversations must stay fast while the index builds").toBeLessThan(2_000);

    const status = structuredData(await client.callTool({ name: "server_status", arguments: {} })) as {
      index_state: { state: string };
    };
    expect(["building", "ready"]).toContain(status.index_state.state);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 12. Claude Desktop bundle (.mcpb)
// ---------------------------------------------------------------------------

describe("mcpb bundle", () => {
  const bundlePath = path.join(repoRoot, "dist-mcpb", "imessage-mcp.mcpb");
  const hasBundle = existsSync(bundlePath);
  // CI and release set this after build:mcpb, so a missing bundle fails there
  // instead of skipping.
  if (!hasBundle && process.env.IMESSAGE_E2E_REQUIRE_BUNDLE === "1") {
    throw new Error(`IMESSAGE_E2E_REQUIRE_BUNDLE is set but ${bundlePath} does not exist`);
  }
  const testName = hasBundle
    ? "unzips cleanly, ships no native binaries or sources, and launches at every privacy default"
    : `unzips cleanly, ships no native binaries or sources, and launches at every privacy default (skipped: no bundle at ${bundlePath}; run npm run build:mcpb first)`;

  it.skipIf(!hasBundle)(testName, async () => {
    const fixture = trackFixture(createFixture());
    const root = trackDir(mkdtempSync(path.join(tmpdir(), "imessage-mcp-e2e-bundle-")));
    execFileSync("unzip", ["-q", bundlePath, "-d", root]);

    expect(existsSync(path.join(root, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(root, "bin"))).toBe(true);
    expect(existsSync(path.join(root, "dist"))).toBe(true);
    expect(existsSync(path.join(root, "node_modules", "@modelcontextprotocol"))).toBe(true);
    expect(existsSync(path.join(root, "src")), "bundle must not carry sources").toBe(false);
    expect(existsSync(path.join(root, "tests")), "bundle must not carry tests").toBe(false);

    const allFiles = listFilesRecursive(root);
    expect(allFiles.some((file) => file.includes("better-sqlite3")), "bundle must not carry better-sqlite3").toBe(false);
    expect(allFiles.some((file) => file.endsWith(".node")), "bundle must not carry native .node files").toBe(false);

    interface Manifest {
      server: { entry_point: string; mcp_config: { command: string; args: string[] } };
      user_config: Record<string, { type: string; default?: string | boolean }>;
    }
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as Manifest;
    const defaults = Object.fromEntries(
      Object.entries(manifest.user_config).map(([key, setting]) => [key, String(setting.default)]),
    );

    const resolvePlaceholders = (value: string, userConfig: Record<string, string>): string =>
      value
        .replaceAll("${__dirname}", root)
        .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/gu, (_match, key: string) => userConfig[key] ?? "");

    for (const privacy of ["full", "redacted", "aggregate"] as const) {
      const userConfig = { ...defaults, privacy, contacts: "none" };
      const args = manifest.server.mcp_config.args.map((value) => resolvePlaceholders(value, userConfig));
      const transport = new StdioClientTransport({
        command: manifest.server.mcp_config.command,
        args: [...args, "--database", fixture.databasePath, "--contacts", "none"],
        cwd: root,
        env: baseEnv(),
        stderr: "pipe",
      });
      const client = trackClient(new Client({ name: "imessage-mcp-e2e-bundle", version: "1.0.0" }));
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
      await client.close();
      openClients.splice(openClients.indexOf(client), 1);
    }
  });
});
