#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runtimeConfig } from "./config.js";
import { asImessageMcpError, ImessageMcpError } from "./errors.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `imessage-mcp ${packageVersion}

Read-only MCP server for your Apple Messages history.

Usage:
  imessage-mcp [options]          start the server over stdio (what MCP clients run)
  imessage-mcp doctor [options]   check access, schema, contacts and updates
  imessage-mcp help

Options:
  -t, --transport <mode>   stdio (default) or http (loopback, bearer token)
  -p, --port <number>      HTTP port (default 3000)
      --database <path>    a copy of chat.db instead of this Mac's Messages
      --contacts <mode>    live (default) names handles from Contacts; none does not
      --privacy <mode>     full (default), redacted, or aggregate
      --json               JSON output for doctor
  -h, --help               show this help
  -v, --version            show the version

The app that starts the server needs Full Disk Access. HTTP also needs
IMESSAGE_API_TOKEN or IMESSAGE_API_TOKEN_FILE. The search index is cached,
encrypted, in ~/Library/Caches/imessage-mcp; deleting it is always safe.
`;

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      transport: { type: "string", short: "t", default: "stdio" },
      port: { type: "string", short: "p", default: "3000" },
      database: { type: "string" },
      contacts: { type: "string" },
      privacy: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = parsed.positionals[0];
  if (parsed.positionals.length > 1) throw new ImessageMcpError("INVALID_INPUT", "only one command may be provided");
  if (parsed.values.version) {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  if (command === "help" || parsed.values.help) {
    process.stdout.write(HELP);
    return;
  }
  const transport = parsed.values.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new ImessageMcpError("INVALID_INPUT", "transport must be stdio or http");
  }
  const config = runtimeConfig({
    databasePath: parsed.values.database,
    contacts: parsed.values.contacts,
    privacy: parsed.values.privacy,
    transport,
    port: Number(parsed.values.port),
  });
  if (command === "doctor") {
    const { doctor } = await import("./commands/doctor.js");
    process.exitCode = await doctor(config, parsed.values.json ?? false);
  } else if (command) {
    throw new ImessageMcpError("INVALID_INPUT", `unknown command "${command}"; run imessage-mcp help`);
  } else if (transport === "http") {
    const [{ startHttp }, { ToolRuntime }] = await Promise.all([import("./transport.js"), import("./server.js")]);
    await startHttp(new ToolRuntime(config));
  } else {
    const { startStdio } = await import("./server.js");
    await startStdio(config);
  }
}

await main().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const normalized = typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")
    ? new ImessageMcpError("INVALID_INPUT", "command-line arguments are invalid; run imessage-mcp help")
    : asImessageMcpError(error);
  process.stderr.write(`${JSON.stringify({ status: "error", reason: normalized.reason, message: normalized.message })}\n`);
  process.exitCode = 1;
});
