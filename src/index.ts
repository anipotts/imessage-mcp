import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { RuntimeConfig } from "./config.js";
import { ImessageMcpError } from "./errors.js";
import { ToolRuntime, createMcpServer } from "./tools.js";

export { ToolRuntime, createMcpServer } from "./tools.js";

export function createServer(config: RuntimeConfig) {
  const runtime = new ToolRuntime(config);
  return { server: createMcpServer(runtime), runtime };
}

export async function startStdio(config: RuntimeConfig): Promise<void> {
  const runtime = new ToolRuntime(config);
  try {
    await runtime.initialize();
  } catch (error) {
    // Without Full Disk Access, or before Messages has created its database, an
    // exiting server surfaces in the client as a bare disconnect. Serving anyway
    // lets every tool call retry its worker and return the fix as its error, and
    // the next call after access is granted succeeds without a restart.
    if (!(error instanceof ImessageMcpError) || error.reason !== "DATABASE_UNAVAILABLE") throw error;
    process.stderr.write(`${JSON.stringify({ transport: "stdio", status: "degraded", reason: error.reason })}\n`);
  }
  const handle = serveStdio(() => createMcpServer(runtime), {
    legacy: "serve",
    maxSubscriptions: 0,
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
    onerror: (error) => process.stderr.write(JSON.stringify({ transport: "stdio", status: "error", reason: error.name }) + "\n"),
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
    await runtime.close();
    process.exit(0);
  };
  const requestShutdown = () => {
    void shutdown().catch(() => {
      process.stderr.write(`${JSON.stringify({ transport: "stdio", status: "error", reason: "shutdown_failed" })}\n`);
      process.exit(1);
    });
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.stdin.once("end", requestShutdown);
}
