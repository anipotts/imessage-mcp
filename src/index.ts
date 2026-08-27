import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { RuntimeConfig } from "./config.js";
import { ToolRuntime, createMcpServer } from "./tools.js";

export { ToolRuntime, createMcpServer } from "./tools.js";

export function createServer(config: RuntimeConfig) {
  const runtime = new ToolRuntime(config);
  return { server: createMcpServer(runtime), runtime };
}

export async function startStdio(config: RuntimeConfig): Promise<void> {
  const runtime = new ToolRuntime(config);
  await runtime.initialize();
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
