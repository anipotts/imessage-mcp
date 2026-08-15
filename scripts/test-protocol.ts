#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpProxy, request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createFixture, type Fixture } from "../tests/fixture.js";

const TOOL_NAMES = [
  "analyze_communication",
  "get_conversation",
  "list_conversations",
  "resolve_contact",
  "search_messages",
  "server_status",
  "sync_messages",
];

const TEST_REFERENCE_KEY = "synthetic-reference-key-".padEnd(48, "x");
const TEST_DATABASE_ID = "synthetic-database-lineage-".padEnd(48, "x");

function testEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    IMESSAGE_REFERENCE_KEY: TEST_REFERENCE_KEY,
    IMESSAGE_DATABASE_ID: TEST_DATABASE_ID,
    ...extra,
  };
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

async function exercise(client: Client, privacy: "full" | "redacted"): Promise<string> {
  const listedTools = await client.listTools();
  assert.deepEqual(listedTools.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  const listedByName = new Map(listedTools.tools.map((tool) => [tool.name, tool]));
  const statusSchema = listedByName.get("server_status")?.inputSchema as Record<string, unknown> | undefined;
  assert.equal(statusSchema?.type, "object");
  assert.equal(statusSchema?.additionalProperties, false);
  assert.deepEqual(
    ((statusSchema?.properties as Record<string, Record<string, unknown>>).privacy_mode.enum),
    ["full", "redacted", "aggregate"],
  );
  const conversationSchema = listedByName.get("get_conversation")?.inputSchema as Record<string, unknown> | undefined;
  assert.equal(conversationSchema?.type, "object");
  assert.equal(conversationSchema?.additionalProperties, false);
  assert.ok("conversation_ref" in (conversationSchema?.properties as Record<string, unknown>));
  assert.ok("query" in (conversationSchema?.properties as Record<string, unknown>));

  const unknownArgument = await client.callTool({ name: "server_status", arguments: { legacy: true } });
  assert.equal(unknownArgument.isError, true);
  assert.equal((structured(unknownArgument).error as { reason?: string }).reason, "INVALID_INPUT");
  const missingConversation = await client.callTool({ name: "get_conversation", arguments: {} });
  assert.equal(missingConversation.isError, true);
  assert.equal((structured(missingConversation).error as { reason?: string }).reason, "INVALID_INPUT");

  const status = await client.callTool({ name: "server_status", arguments: { privacy_mode: privacy } });
  assert.equal(status.isError, undefined);
  assert.equal(structured(status).api_version, "2.0");

  const contact = await client.callTool({
    name: "resolve_contact",
    arguments: { query: "+15550000001", privacy_mode: privacy },
  });
  assert.equal(contact.isError, undefined);

  const conversations = await client.callTool({
    name: "list_conversations",
    arguments: { limit: 50, privacy_mode: privacy },
  });
  assert.equal(conversations.isError, undefined);
  const conversationData = structured(conversations).data as { conversations: Array<{ conversation_ref: string }> };
  assert.ok(conversationData.conversations.length >= 4);
  const conversationRef = conversationData.conversations[0].conversation_ref;
  assert.match(conversationRef, /^im2_/u);

  const timeline = await client.callTool({
    name: "get_conversation",
    arguments: { conversation_ref: conversationRef, limit: 5, privacy_mode: privacy },
  });
  assert.equal(timeline.isError, undefined);

  const search = await client.callTool({
    name: "search_messages",
    arguments: {
      query: "blob exact",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      limit: 5,
      privacy_mode: privacy,
    },
  });
  assert.equal(search.isError, undefined);

  const analytics = await client.callTool({
    name: "analyze_communication",
    arguments: { metric: "message_count", scope: "global", privacy_mode: privacy },
  });
  assert.equal(analytics.isError, undefined);

  const sync = await client.callTool({
    name: "sync_messages",
    arguments: { limit: 5, privacy_mode: privacy },
  });
  assert.equal(sync.isError, undefined);

  if (privacy === "redacted") {
    const output = JSON.stringify([conversations, timeline, search, sync]);
    assert.doesNotMatch(output, /blob exact|thread reply|photo\.png|\+1555000000/u);
    assert.doesNotMatch(output, /T\d{2}:\d{2}:\d{2}/u);
  }
  return conversationRef;
}

async function exerciseAggregate(client: Client, conversationRef: string): Promise<void> {
  const status = await client.callTool({ name: "server_status", arguments: { privacy_mode: "aggregate" } });
  const contact = await client.callTool({
    name: "resolve_contact",
    arguments: { query: "+15550000001", privacy_mode: "aggregate" },
  });
  const conversations = await client.callTool({
    name: "list_conversations",
    arguments: { limit: 2, privacy_mode: "aggregate" },
  });
  const timeline = await client.callTool({
    name: "get_conversation",
    arguments: { conversation_ref: conversationRef, limit: 5, privacy_mode: "aggregate" },
  });
  const search = await client.callTool({
    name: "search_messages",
    arguments: {
      query: "blob exact",
      mode: "substring",
      scopes: ["text"],
      order: "newest",
      limit: 5,
      privacy_mode: "aggregate",
    },
  });
  const analytics = await client.callTool({
    name: "analyze_communication",
    arguments: { metric: "message_count", scope: "global", privacy_mode: "aggregate" },
  });
  const sync = await client.callTool({
    name: "sync_messages",
    arguments: { limit: 5, privacy_mode: "aggregate" },
  });
  for (const result of [status, contact, conversations, timeline, search, analytics, sync]) {
    assert.equal(result.isError, undefined);
  }
  const syncData = structured(sync).data as { cursor?: string };
  assert.match(syncData.cursor ?? "", /^im2_/u);
  const output = JSON.stringify([status, contact, conversations, timeline, search, analytics, sync]);
  assert.doesNotMatch(output, /blob exact|thread reply|photo\.png|Synthetic Group|\+1555000000|unknown@example/u);
  assert.doesNotMatch(output, /"(?:message|conversation)_ref"/u);
}

export async function runStdio(command: string, args: string[], fixture: Fixture): Promise<void> {
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--database", fixture.databasePath, "--contacts", "none"],
    cwd: process.cwd(),
    env: testEnvironment(),
    stderr: "pipe",
    maxBufferSize: 5 * 1024 * 1024,
  });
  const client = new Client({ name: "imessage-mcp-protocol-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const conversationRef = await exercise(client, "full");
    await exercise(client, "redacted");
    await exerciseAggregate(client, conversationRef);
  } finally {
    await client.close();
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForReady(process: ChildProcess): Promise<void> {
  const stderr = process.stderr;
  assert.ok(stderr);
  let buffered = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HTTP test server did not become ready")), 15_000);
    const onExit = () => {
      clearTimeout(timeout);
      reject(new Error(`HTTP test server exited before readiness: ${buffered.slice(-2000)}`));
    };
    process.once("exit", onExit);
    stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (!buffered.includes('"status":"ready"')) return;
      clearTimeout(timeout);
      process.off("exit", onExit);
      resolve();
    });
  });
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  const timeout = setTimeout(() => process.kill("SIGKILL"), 5_000);
  timeout.unref();
  await once(process, "exit");
  clearTimeout(timeout);
}

async function rawPostStatus(
  port: number,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function slowPost(
  port: number,
  headers: Record<string, string>,
): { request: ReturnType<typeof httpRequest>; status: Promise<number> } {
  let settle!: (status: number) => void;
  const status = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: { ...headers, "content-length": "64" },
  }, (response) => {
    response.resume();
    response.once("end", () => settle(response.statusCode ?? 0));
  });
  request.once("error", () => settle(0));
  request.write("{");
  return { request, status };
}

function declaredOversizedPost(
  port: number,
  headers: Record<string, string>,
): { request: ReturnType<typeof httpRequest>; status: Promise<number> } {
  let settle!: (status: number) => void;
  const status = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: { ...headers, "content-length": String(256 * 1024 + 1) },
  }, (response) => {
    response.resume();
    response.once("end", () => settle(response.statusCode ?? 0));
  });
  request.once("error", () => settle(0));
  request.flushHeaders();
  return { request, status };
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function openHeaderlessConnections(port: number, count: number): Promise<Socket[]> {
  const sockets = Array.from({ length: count }, () => createConnection({ host: "127.0.0.1", port }));
  await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
    const finish = () => resolve();
    socket.once("connect", finish);
    socket.once("close", finish);
  })));
  return sockets;
}

async function runHttp(fixture: Fixture): Promise<void> {
  const port = await freePort();
  const proxyPort = await freePort();
  const token = "synthetic-http-token-".padEnd(48, "x");
  const child = spawn(process.execPath, [
    "bin/imessage-mcp.js",
    "--transport", "http",
    "--port", String(port),
    "--database", fixture.databasePath,
    "--contacts", "none",
  ], {
    cwd: process.cwd(),
    env: testEnvironment({
      IMESSAGE_API_TOKEN: token,
      IMESSAGE_PRIVACY: "redacted",
      IMESSAGE_ALLOWED_HOSTS: "127.0.0.1,mac.tailnet.test",
      IMESSAGE_ALLOWED_ORIGINS: "127.0.0.1,mac.tailnet.test",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  const proxy = createHttpProxy((request, response) => {
    const upstream = httpRequest({
      host: "127.0.0.1",
      port,
      path: request.url,
      method: request.method,
      headers: {
        ...request.headers,
        host: "mac.tailnet.test",
        origin: "https://mac.tailnet.test",
        "x-forwarded-for": request.socket.remoteAddress ?? "127.0.0.1",
        "x-forwarded-proto": "https",
      },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => response.destroy());
    request.pipe(upstream);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString("utf8");
  });
  try {
    await waitForReady(child);
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(proxyPort, "127.0.0.1", resolve);
    });
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const unauthorized = await fetch(url, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    const wrongToken = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${"wrong-token-".padEnd(48, "y")}` },
    });
    assert.equal(wrongToken.status, 401);
    const wrongLengthToken = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${"wrong-length-token-".padEnd(32, "z")}` },
    });
    assert.equal(wrongLengthToken.status, 401);
    const badHost = await rawPostStatus(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      host: "evil.example",
    }, "{}");
    assert.equal(badHost, 403);
    const badOrigin = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(badOrigin.status, 403);
    const batch = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(batch.status, 400);
    const oversized = declaredOversizedPost(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    assert.equal(await oversized.status, 413);
    await wait(100);
    assert.equal(oversized.request.destroyed, true);

    const slowA = slowPost(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    const slowB = slowPost(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    await wait(100);
    const saturated = await rawPostStatus(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, "{}");
    assert.equal(saturated, 400);
    slowA.request.destroy();
    slowB.request.destroy();
    await Promise.all([slowA.status, slowB.status]);
    const afterRelease = await rawPostStatus(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, "{}");
    assert.equal(afterRelease, 400);

    const bodyDeadlineStarted = Date.now();
    const deadlineRequest = slowPost(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    assert.equal(await deadlineRequest.status, 0);
    const bodyDeadlineElapsed = Date.now() - bodyDeadlineStarted;
    assert.ok(bodyDeadlineElapsed >= 4_000 && bodyDeadlineElapsed < 8_000);
    const afterBodyDeadline = await rawPostStatus(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, "{}");
    assert.equal(afterBodyDeadline, 400);

    const rejectedPartial = slowPost(port, {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
    });
    assert.equal(await rejectedPartial.status, 400);
    await wait(100);
    assert.equal(rejectedPartial.request.destroyed, true);

    const headerless = await openHeaderlessConnections(port, 32);
    const duringHeaderPressure = await rawPostStatus(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, "{}");
    assert.equal(duringHeaderPressure, 400);
    await wait(2_500);
    assert.equal(headerless.every((socket) => socket.destroyed), true);
    const afterHeaderDeadline = await rawPostStatus(port, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, "{}");
    assert.equal(afterHeaderDeadline, 400);

    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: { token: async () => token },
    });
    const client = new Client({ name: "imessage-mcp-http-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const conversationRef = await exercise(client, "redacted");
      await exerciseAggregate(client, conversationRef);
    } finally {
      await client.close();
    }
    const proxyTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${proxyPort}/mcp`), {
      authProvider: { token: async () => token },
    });
    const proxyClient = new Client({ name: "imessage-mcp-tailscale-proxy-simulation", version: "1.0.0" });
    try {
      await proxyClient.connect(proxyTransport);
      const proxied = await proxyClient.callTool({ name: "server_status", arguments: { privacy_mode: "redacted" } });
      assert.equal(proxied.isError, undefined);
      assert.equal(structured(proxied).api_version, "2.0");
    } finally {
      await proxyClient.close();
    }
    let limitedAt = 0;
    for (let attempt = 1; attempt <= 61; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      if (response.status === 429) {
        limitedAt = attempt;
        break;
      }
    }
    assert.ok(limitedAt > 0 && limitedAt <= 60);
    assert.doesNotMatch(diagnostics, /blob exact|thread reply|photo\.png|\+1555000000|unknown@example/u);
  } finally {
    if (proxy.listening) {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    await stop(child);
  }
}

async function main(): Promise<void> {
  const fixture = createFixture();
  try {
    const commandArg = process.argv.find((value) => value.startsWith("--stdio-command="));
    const stdioCommand = commandArg ? commandArg.slice("--stdio-command=".length) : process.execPath;
    const stdioArgs = commandArg ? [] : ["bin/imessage-mcp.js"];
    await runStdio(stdioCommand, stdioArgs, fixture);
    if (!process.argv.includes("--skip-http")) await runHttp(fixture);
    process.stdout.write("protocol verification passed: seven tools over stdio and authenticated stateless HTTP\n");
  } finally {
    fixture.cleanup();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
