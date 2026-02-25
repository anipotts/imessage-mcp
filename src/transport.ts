// HTTP transport modes for imessage-mcp
//
// startStreamableHttp — Recommended HTTP mode (Streamable HTTP, MCP 2025-03-26)
// startSse — Legacy SSE mode (deprecated MCP protocol, for older clients)

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./index.js";
import { parseSyncMode, startWatcher, stopWatcher } from "./watcher.js";

// ── Constants ──

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// ── Helpers ──

/**
 * Read the request body with a size limit.
 * Rejects if the body exceeds MAX_BODY_BYTES or the client aborts.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request aborted")));
  });
}

/**
 * Start the watcher exactly once per process for HTTP mode.
 * The watcher uses module-level singletons in watcher.ts, so calling it
 * multiple times would leak file descriptors. We start it once with the
 * first session's server and leave it running for the process lifetime.
 */
let watcherStarted = false;
function startSyncWatcherOnce(server: McpServer): void {
  if (watcherStarted) return;
  const syncMode = parseSyncMode(process.env.IMESSAGE_SYNC);
  if (syncMode === "off") return;
  watcherStarted = true;
  startWatcher(server, syncMode);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── Auth ──

const API_TOKEN = process.env.IMESSAGE_API_TOKEN || "";

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  const token = Buffer.from(header.slice(7));
  const expected = Buffer.from(API_TOKEN);
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

function warnIfExposed(host: string): void {
  if (!API_TOKEN && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    process.stderr.write(
      `\nWARNING: Listening on ${host} without authentication.\n` +
      `  Set IMESSAGE_API_TOKEN to require bearer token auth.\n\n`,
    );
  }
}

// ── Streamable HTTP ──

export async function startStreamableHttp(port: number, host: string): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let shuttingDown = false;

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // No CORS headers — this server exposes private iMessage data.
    // Browser cross-origin requests are intentionally blocked.
    // Non-browser MCP clients (n8n, Lutra, curl) are unaffected by CORS.

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!checkAuth(req, res)) return;

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/mcp") {
        sendJson(res, 404, { error: "Not found. Use POST /mcp" });
        return;
      }

      // POST /mcp — JSON-RPC requests
      if (req.method === "POST") {
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { jsonrpc: "2.0", error: { code: -32000, message: "Request body too large" }, id: null });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
          return;
        }

        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId)!.handleRequest(req, res, parsed);
          return;
        }

        // Handle both single and batch requests — check if the first item is initialize
        const firstMessage = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!sessionId && isInitializeRequest(firstMessage)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) transports.delete(sid);
          };

          const server = createServer();
          await server.connect(transport);
          startSyncWatcherOnce(server);

          await transport.handleRequest(req, res, parsed);
          return;
        }

        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      // GET /mcp — SSE stream for existing session
      if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !transports.has(sessionId)) {
          sendJson(res, 400, { error: "Invalid or missing session ID" });
          return;
        }
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      // DELETE /mcp — session termination
      if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !transports.has(sessionId)) {
          sendJson(res, 400, { error: "Invalid or missing session ID" });
          return;
        }
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method not allowed");
    } catch (err) {
      process.stderr.write(`[http] Request error: ${err}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(`imessage-mcp Streamable HTTP server listening on http://${host}:${port}/mcp\n`);
    if (API_TOKEN) process.stderr.write(`  Bearer token auth: enabled\n`);
    warnIfExposed(host);
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatcher();
    for (const [, transport] of transports) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    httpServer.close(() => process.exit(0));
    // Force exit after 5s if close hangs
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── Legacy SSE ──

export async function startSse(port: number, host: string): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();
  let shuttingDown = false;

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!checkAuth(req, res)) return;

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // GET /sse — establish SSE stream
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        const server = createServer();
        await server.connect(transport);
        startSyncWatcherOnce(server);

        // Only add to map after successful connect
        sessions.set(transport.sessionId, transport);
        transport.onclose = () => {
          sessions.delete(transport.sessionId);
        };
        return;
      }

      // POST /messages?sessionId=<id> — JSON-RPC from client
      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid or missing sessionId");
          return;
        }
        await sessions.get(sessionId)!.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found. Use GET /sse to connect.");
    } catch (err) {
      process.stderr.write(`[sse] Request error: ${err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(`imessage-mcp SSE server listening on http://${host}:${port}/sse\n`);
    if (API_TOKEN) process.stderr.write(`  Bearer token auth: enabled\n`);
    warnIfExposed(host);
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatcher();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
