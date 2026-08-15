#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LocalToolRuntime } from "../src/tool-local.js";

const REFERENCE_MESSAGES = 1_000_000;

function selectedMessageCount(): number {
  const argument = process.argv.find((value) => value.startsWith("--messages="));
  const value = Number(argument?.slice("--messages=".length) ?? REFERENCE_MESSAGES);
  if (!Number.isInteger(value) || value < 1 || value > REFERENCE_MESSAGES) {
    throw new Error(`--messages must be an integer from 1 through ${REFERENCE_MESSAGES}`);
  }
  return value;
}

function createPerformanceDatabase(databasePath: string, messageCount: number): number {
  const started = performance.now();
  const db = new Database(databasePath);
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, style INTEGER DEFAULT 0,
      chat_identifier TEXT, service_name TEXT, display_name TEXT, group_id TEXT
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, message_date INTEGER DEFAULT 0,
      PRIMARY KEY(chat_id, message_id)
    );
    CREATE INDEX chat_message_join_message ON chat_message_join(message_id);
    CREATE TABLE chat_handle_join (chat_id INTEGER NOT NULL, handle_id INTEGER NOT NULL);
    CREATE TABLE chat_lookup (identifier TEXT NOT NULL, domain TEXT NOT NULL, chat INTEGER NOT NULL);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT, attributedBody BLOB,
      handle_id INTEGER, date INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
      is_system_message INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0,
      date_edited INTEGER DEFAULT 0, service TEXT
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, transfer_name TEXT,
      mime_type TEXT, total_bytes INTEGER
    );
    CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL);
    CREATE INDEX message_attachment_join_message ON message_attachment_join(message_id);
  `);

  const services = ["iMessage", "SMS", "MMS", "RCS", "SyntheticUnknown"] as const;
  const handleCount = 128;
  const chatCount = 128;
  const setup = db.transaction(() => {
    const insertHandle = db.prepare("INSERT INTO handle(ROWID,id,service) VALUES (?,?,?)");
    const insertChat = db.prepare(
      "INSERT INTO chat(ROWID,guid,style,chat_identifier,service_name,display_name,group_id) VALUES (?,?,?,?,?,?,?)",
    );
    const insertChatHandle = db.prepare("INSERT INTO chat_handle_join(chat_id,handle_id) VALUES (?,?)");
    const insertLookup = db.prepare("INSERT INTO chat_lookup(identifier,domain,chat) VALUES (?,?,?)");
    for (let index = 1; index <= handleCount; index += 1) {
      const service = services[index % services.length];
      insertHandle.run(index, `+1555${String(index).padStart(7, "0")}`, service);
      insertChat.run(
        index,
        `perf-chat-${String(index).padStart(4, "0")}`,
        index % 8 === 0 ? 43 : 45,
        `perf-${index}`,
        service,
        index % 8 === 0 ? `Synthetic Group ${index}` : null,
        index % 8 === 0 ? `group-${index}` : null,
      );
      insertChatHandle.run(index, index);
      if (index % 8 === 0) insertChatHandle.run(index, (index % handleCount) + 1);
      insertLookup.run(`perf-${index}`, service, index);
    }
  });
  setup();

  const insertMessage = db.prepare(`
    INSERT INTO message(
      ROWID,guid,text,handle_id,date,is_from_me,cache_has_attachments,service
    ) VALUES (?,?,?,?,?,?,?,?)
  `);
  const insertJoin = db.prepare(
    "INSERT INTO chat_message_join(chat_id,message_id,message_date) VALUES (?,?,?)",
  );
  const insertAttachment = db.prepare(
    "INSERT INTO attachment(ROWID,guid,filename,transfer_name,mime_type,total_bytes) VALUES (?,?,?,?,?,?)",
  );
  const insertAttachmentJoin = db.prepare(
    "INSERT INTO message_attachment_join(message_id,attachment_id) VALUES (?,?)",
  );
  const insertBatch = db.transaction((from: number, to: number) => {
    for (let rowid = from; rowid <= to; rowid += 1) {
      const chatId = ((rowid - 1) % chatCount) + 1;
      const service = services[rowid % services.length];
      const attachmentOnly = rowid % 1000 === 0;
      const marker = rowid % 10_000 === 4242 ? " needle4242" : "";
      const text = attachmentOnly ? null : `synthetic ${rowid % 10_000} ${service}${marker}`;
      const date = 790_000_000_000_000_000 + rowid * 1_000_000_000;
      const guid = `00000000-0000-4000-8000-${String(rowid).padStart(12, "0")}`;
      insertMessage.run(
        rowid,
        guid,
        text,
        rowid % 3 === 0 ? null : chatId,
        date,
        rowid % 3 === 0 ? 1 : 0,
        attachmentOnly ? 1 : 0,
        service,
      );
      insertJoin.run(chatId, rowid, date);
      if (attachmentOnly) {
        const attachmentId = rowid / 1000;
        const name = `synthetic-${attachmentId}.bin`;
        insertAttachment.run(
          attachmentId,
          `perf-attachment-${attachmentId}`,
          `/Users/fake/Library/Messages/Attachments/${name}`,
          name,
          "application/octet-stream",
          4096,
        );
        insertAttachmentJoin.run(rowid, attachmentId);
      }
    }
  });
  for (let start = 1; start <= messageCount; start += 10_000) {
    insertBatch(start, Math.min(messageCount, start + 9_999));
  }
  db.pragma("optimize");
  db.close();
  return performance.now() - started;
}

function structured(result: CallToolResult): Record<string, unknown> {
  if (result.isError || !result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error(`tool call failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

async function timed<T>(operation: () => Promise<T> | T): Promise<{ value: T; duration_ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, duration_ms: performance.now() - started };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
}

async function waitForReady(child: ChildProcess): Promise<string> {
  assert.ok(child.stderr);
  let diagnostics = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("performance HTTP server did not become ready")), 30_000);
    const onExit = () => {
      clearTimeout(timeout);
      reject(new Error("performance HTTP server exited before readiness"));
    };
    child.once("exit", onExit);
    child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
      if (!diagnostics.includes('"status":"ready"')) return;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve();
    });
  });
  return diagnostics;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  timeout.unref();
  await once(child, "exit");
  clearTimeout(timeout);
}

async function verifyHttpConcurrency(databasePath: string): Promise<number> {
  const port = await freePort();
  const token = "synthetic-performance-token-".padEnd(48, "x");
  const child = spawn(process.execPath, [
    "bin/imessage-mcp.js",
    "--transport", "http",
    "--port", String(port),
    "--database", databasePath,
    "--contacts", "none",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      IMESSAGE_API_TOKEN: token,
      IMESSAGE_REFERENCE_KEY: "synthetic-performance-reference-key-".padEnd(48, "x"),
      IMESSAGE_PRIVACY: "redacted",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const transports = [0, 1].map(() => new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => token },
  }));
  const clients = [0, 1].map((index) => new Client({
    name: `imessage-mcp-performance-${index}`,
    version: "1.0.0",
  }));
  try {
    diagnostics = await waitForReady(child);
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
    });
    await Promise.all(clients.map((client, index) => client.connect(transports[index])));
    const concurrent = await timed(() => Promise.all(clients.map((client) => client.callTool({
      name: "list_conversations",
      arguments: { privacy_mode: "aggregate", limit: 50 },
    }))));
    concurrent.value.forEach(structured);
    assert.ok(concurrent.duration_ms < 2_000, `two-client HTTP calls took ${concurrent.duration_ms.toFixed(1)} ms`);
    assert.doesNotMatch(diagnostics, /needle4242|\+1555|Synthetic Group/u);
    return concurrent.duration_ms;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stop(child);
  }
}

async function main(): Promise<void> {
  const messageCount = selectedMessageCount();
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-mcp-performance-"));
  const databasePath = path.join(directory, "chat.db");
  let runtime: LocalToolRuntime | null = null;
  try {
    const fixture_ms = createPerformanceDatabase(databasePath, messageCount);
    const startup = await timed(async () => {
      const preparedRuntime = new LocalToolRuntime({
        database_path: databasePath,
        source_mode: "copy",
        contacts_mode: "none",
        privacy_ceiling: "full",
        transport: "stdio",
        port: 3000,
        attachment_paths_enabled: false,
        reference_key: Buffer.alloc(32, 0x5a).toString("base64"),
      }, Buffer.alloc(32, 7), undefined, 1, true);
      try {
        await preparedRuntime.prepare();
        return preparedRuntime;
      } catch (error) {
        preparedRuntime.close();
        throw error;
      }
    });
    runtime = startup.value;

    const status = await timed(() => runtime!.call("server_status", { privacy_mode: "aggregate" }));
    const conversations = await timed(() => runtime!.call("list_conversations", {
      privacy_mode: "aggregate",
      limit: 50,
    }));
    const syncLatest = await timed(() => runtime!.call("sync_messages", {
      privacy_mode: "aggregate",
      limit: 50,
    }));
    structured(status.value);
    structured(conversations.value);
    structured(syncLatest.value);
    assert.ok(status.duration_ms < 1_000, `server_status took ${status.duration_ms.toFixed(1)} ms`);
    assert.ok(conversations.duration_ms < 1_000, `list_conversations took ${conversations.duration_ms.toFixed(1)} ms`);
    assert.ok(syncLatest.duration_ms < 1_000, `initial sync cursor took ${syncLatest.duration_ms.toFixed(1)} ms`);

    const baselineRss = process.memoryUsage().rss;
    const cold = await timed(() => runtime!.call("search_messages", {
      query: "needle4242",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      limit: 50,
      privacy_mode: "aggregate",
    }));
    const coldContent = structured(cold.value);
    const coldData = coldContent.data as { total_matches?: number };
    assert.equal(coldData.total_matches, Math.floor((messageCount + 5_758) / 10_000));
    const index = runtime.search.state();
    assert.equal(index.state, "ready");
    assert.equal(index.indexed_messages, messageCount);
    assert.ok(index.memory_used_bytes <= index.memory_limit_bytes);
    const rssDelta = Math.max(0, process.memoryUsage().rss - baselineRss);

    const warm = await timed(() => runtime!.call("search_messages", {
      query: "needle4242",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      limit: 50,
      privacy_mode: "aggregate",
    }));
    structured(warm.value);
    const shortSubstring = await timed(() => runtime!.call("search_messages", {
      query: "e",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      limit: 50,
      privacy_mode: "aggregate",
    }));
    structured(shortSubstring.value);

    if (messageCount === REFERENCE_MESSAGES) {
      assert.ok(cold.duration_ms < 60_000, `cold search took ${cold.duration_ms.toFixed(1)} ms`);
      assert.ok(warm.duration_ms < 2_000, `warm search took ${warm.duration_ms.toFixed(1)} ms`);
      assert.ok(shortSubstring.duration_ms < 2_000, `one-character warm search took ${shortSubstring.duration_ms.toFixed(1)} ms`);
    }

    runtime.close();
    runtime = null;
    const http_concurrency_ms = await verifyHttpConcurrency(databasePath);

    process.stdout.write(`${JSON.stringify({
      fixture: "mixed-service synthetic",
      messages: messageCount,
      fixture_ms: Math.round(fixture_ms),
      startup_ms: Math.round(startup.duration_ms),
      metadata_ms: {
        server_status: Math.round(status.duration_ms),
        list_conversations: Math.round(conversations.duration_ms),
        sync_latest: Math.round(syncLatest.duration_ms),
      },
      cold_index_ms: Math.round(cold.duration_ms),
      warm_search_ms: Math.round(warm.duration_ms),
      one_character_search_ms: Math.round(shortSubstring.duration_ms),
      http_two_client_ms: Math.round(http_concurrency_ms),
      index_memory_bytes: index.memory_used_bytes,
      memory_limit_bytes: index.memory_limit_bytes,
      rss_delta_bytes: rssDelta,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    })}\n`);
  } finally {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
