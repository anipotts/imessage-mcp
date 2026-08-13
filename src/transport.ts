import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  createMcpHandler,
  validateHostHeader,
  validateOriginHeader,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { ToolRuntime } from "./tools.js";
import { createMcpServer } from "./tools.js";
import { ImessageMcpError } from "./errors.js";
import { loadApiToken as readApiToken } from "./secrets.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_ACTIVE_HTTP_REQUESTS = 2;
const MAX_HTTP_CONNECTIONS = 32;
const MAX_TOKEN_BYTES = 4096;
const HEADER_READ_TIMEOUT_MS = 2_000;
const BODY_READ_TIMEOUT_MS = 5_000;

function csv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const values = [...new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean))];
  if (
    !values.length ||
    values.some((part) => part !== "[::1]" && !/^[a-z0-9.-]+$/u.test(part))
  ) {
    throw new ImessageMcpError("INVALID_INPUT", "HTTP allowlists must contain hostnames without ports");
  }
  return values;
}

export function validateHttpConfiguration(): void {
  const token = loadApiToken();
  token.fill(0);
  const allowedHosts = csv(process.env.IMESSAGE_ALLOWED_HOSTS, ["localhost", "127.0.0.1", "[::1]"]);
  csv(process.env.IMESSAGE_ALLOWED_ORIGINS, allowedHosts);
}

export function loadApiToken(): Buffer {
  return readApiToken(true) as Buffer;
}

interface TokenVerifier {
  expected: Buffer;
  length: number;
}

function tokenVerifier(token: Buffer): TokenVerifier {
  const expected = Buffer.alloc(MAX_TOKEN_BYTES);
  token.copy(expected);
  return { expected, length: token.length };
}

function authorize(req: IncomingMessage, verifier: TokenVerifier): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const candidate = Buffer.alloc(MAX_TOKEN_BYTES);
  const withinLimit = supplied.length <= MAX_TOKEN_BYTES;
  if (withinLimit) supplied.copy(candidate);
  const authorized = timingSafeEqual(candidate, verifier.expected) &&
    withinLimit && supplied.length === verifier.length;
  supplied.fill(0);
  candidate.fill(0);
  return authorized;
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length), ...headers });
  res.end(body);
}

function rejectAndClose(req: IncomingMessage, res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  req.resume();
  res.shouldKeepAlive = false;
  res.once("finish", () => req.socket.destroy());
  json(res, status, value, { connection: "close", ...headers });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validateRequestAuthority(
  req: IncomingMessage,
  res: ServerResponse,
  allowedHosts: string[],
  allowedOrigins: string[],
): boolean {
  const host = validateHostHeader(firstHeader(req.headers.host), allowedHosts);
  const origin = validateOriginHeader(firstHeader(req.headers.origin), allowedOrigins);
  const failure = host.ok ? origin.ok ? null : origin : host;
  if (!failure) return true;
  rejectAndClose(req, res, 403, {
    jsonrpc: "2.0",
    error: { code: -32_000, message: failure.message },
    id: null,
  });
  return false;
}

function toWebRequest(req: IncomingMessage, parsedBody: unknown): Request {
  const host = firstHeader(req.headers.host) ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  const body = JSON.stringify(parsedBody);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-length", String(Buffer.byteLength(body)));
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method: req.method ?? "POST",
    headers,
    body,
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new ImessageMcpError("INVALID_INPUT", "HTTP POST requires application/json");
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "HTTP request body exceeds 256 KiB");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    req.destroy();
  }, BODY_READ_TIMEOUT_MS);
  deadline.unref();
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "HTTP request body exceeds 256 KiB");
      chunks.push(chunk);
    }
    if (timedOut) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "HTTP request body exceeded its five-second read deadline");
    }
  } catch (error) {
    if (timedOut) {
      throw new ImessageMcpError("QUERY_BUDGET_EXCEEDED", "HTTP request body exceeded its five-second read deadline");
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", "HTTP request body is not valid JSON");
  }
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers[key] = value;
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        json(res, 413, { error: { reason: "QUERY_BUDGET_EXCEEDED", message: "HTTP response exceeds 4 MiB" } });
        return;
      }
      chunks.push(item.value);
    }
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  headers["content-length"] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(body);
}

class RateLimiter {
  private entries: number[] = [];

  allow(): boolean {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    this.entries = this.entries.filter((time) => time > cutoff);
    if (this.entries.length >= RATE_LIMIT) return false;
    this.entries.push(Date.now());
    return true;
  }
}

class RequestLimiter {
  private active = 0;

  tryAcquire(): (() => void) | null {
    if (this.active >= MAX_ACTIVE_HTTP_REQUESTS) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

export async function startHttp(runtime: ToolRuntime): Promise<void> {
  const allowedHosts = csv(process.env.IMESSAGE_ALLOWED_HOSTS, ["localhost", "127.0.0.1", "[::1]"]);
  const allowedOrigins = csv(process.env.IMESSAGE_ALLOWED_ORIGINS, allowedHosts);
  const token = loadApiToken();
  const verifier = tokenVerifier(token);
  token.fill(0);
  try {
    await runtime.initialize();
  } catch (error) {
    verifier.expected.fill(0);
    throw error;
  }
  const limiter = new RateLimiter();
  const requests = new RequestLimiter();
  const handler = createMcpHandler(() => createMcpServer(runtime), {
    legacy: "stateless",
    responseMode: "json",
    maxSubscriptions: 0,
    onerror: (error) => process.stderr.write(JSON.stringify({ transport: "http", status: "error", reason: error.name }) + "\n"),
  });
  let closing = false;
  const sockets = new Set<Socket>();
  const headerDeadlines = new Map<Socket, NodeJS.Timeout>();

  const server = createHttpServer(async (req, res) => {
    const headerDeadline = headerDeadlines.get(req.socket);
    if (headerDeadline) {
      clearTimeout(headerDeadline);
      headerDeadlines.delete(req.socket);
    }
    if (!authorize(req, verifier)) {
      rejectAndClose(req, res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (!validateRequestAuthority(req, res, allowedHosts, allowedOrigins)) return;
    if (!limiter.allow()) {
      json(res, 429, { error: "rate_limited" }, { "retry-after": "60" });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${firstHeader(req.headers.host) ?? "localhost"}`);
    } catch {
      json(res, 400, { error: "invalid_request" });
      return;
    }
    if (url.pathname !== "/mcp" || req.method !== "POST") {
      json(res, req.method === "POST" ? 404 : 405, { error: "use POST /mcp" }, { allow: "POST" });
      return;
    }

    const release = requests.tryAcquire();
    if (!release) {
      rejectAndClose(req, res, 429, {
        error: { reason: "QUERY_BUDGET_EXCEEDED", message: "two HTTP requests are already active" },
      }, { "retry-after": "1" });
      return;
    }
    try {
      const parsedBody = await readJsonBody(req);
      if (Array.isArray(parsedBody)) {
        throw new ImessageMcpError("INVALID_INPUT", "JSON-RPC batch requests are not supported");
      }
      const webRequest = toWebRequest(req, parsedBody);
      const authInfo: AuthInfo = {
        token: "redacted",
        clientId: "authenticated-operator",
        scopes: ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      };
      const response = await handler.fetch(webRequest, { authInfo, parsedBody });
      await writeResponse(res, response);
    } catch (error) {
      const reason = error instanceof ImessageMcpError ? error.reason : "INVALID_INPUT";
      const status = reason === "QUERY_BUDGET_EXCEEDED" ? 413 : 400;
      process.stderr.write(JSON.stringify({ transport: "http", status: "error", reason }) + "\n");
      if (!res.headersSent) {
        if (reason === "QUERY_BUDGET_EXCEEDED") rejectAndClose(req, res, status, { error: { reason } });
        else json(res, status, { error: { reason } });
      }
    } finally {
      release();
    }
  });

  server.requestTimeout = 95_000;
  server.headersTimeout = HEADER_READ_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.timeout = 95_000;
  server.maxHeadersCount = 64;
  server.maxConnections = MAX_HTTP_CONNECTIONS;
  server.maxRequestsPerSocket = 100;
  server.on("connection", (socket) => {
    if (sockets.size >= MAX_HTTP_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const deadline = setTimeout(() => {
      headerDeadlines.delete(socket);
      socket.destroy();
    }, HEADER_READ_TIMEOUT_MS);
    deadline.unref();
    headerDeadlines.set(socket, deadline);
    socket.once("close", () => {
      const pending = headerDeadlines.get(socket);
      if (pending) clearTimeout(pending);
      headerDeadlines.delete(socket);
      sockets.delete(socket);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => reject(new ImessageMcpError("DATABASE_UNAVAILABLE", "HTTP transport could not bind its loopback port"));
      server.once("error", onError);
      server.listen(runtime.config.port, "127.0.0.1", () => {
        server.off("error", onError);
        process.stderr.write(JSON.stringify({ transport: "http", status: "ready", host: "loopback", port: runtime.config.port, privacy: runtime.config.privacy_ceiling }) + "\n");
        resolve();
      });
    });
  } catch (error) {
    verifier.expected.fill(0);
    await handler.close();
    await runtime.close();
    throw error;
  }

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    verifier.expected.fill(0);
    await handler.close();
    await runtime.close();
    server.close(() => process.exit(0));
  };
  const requestShutdown = () => {
    void shutdown().catch(() => {
      process.stderr.write(`${JSON.stringify({ transport: "http", status: "error", reason: "shutdown_failed" })}\n`);
      process.exit(1);
    });
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
}
