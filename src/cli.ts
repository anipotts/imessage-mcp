#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runtimeConfig } from "./config.js";
import { asImessageMcpError, ImessageMcpError } from "./errors.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `imessage-mcp ${packageVersion}

Private, read-only MCP for Apple Messages history on Mac.

Usage:
  imessage-mcp [options]
  imessage-mcp doctor [options]
  imessage-mcp help

First run (privacy-first):
  imessage-mcp doctor --contacts none --privacy redacted
  imessage-mcp --contacts none --privacy redacted

Options:
  -h, --help                  Show help without opening Messages or Contacts
  -v, --version               Show the package version
  -t, --transport <mode>      stdio (default) or authenticated loopback http
  -p, --port <number>         HTTP port (default: 3000)
      --database <path>       Live Mac chat.db or a faithful Mac database copy
      --contacts <mode>       live unified Contacts (default) or none
      --privacy <mode>        full (runtime default), redacted, or aggregate
      --attachment-paths      Permit absolute attachment paths at a full ceiling
      --json                  JSON output for doctor

Before normal use, set operator-owned 0600 files with at least 32 random bytes:
  IMESSAGE_REFERENCE_KEY_FILE=/secure/path/reference-key
  IMESSAGE_DATABASE_ID_FILE=/secure/path/database-id

HTTP additionally requires IMESSAGE_API_TOKEN or IMESSAGE_API_TOKEN_FILE.
Full Disk Access belongs to the launching MCP client. Start with redacted and
opt into full only when you intend to return message bodies to that client.
`;

const DOCTOR_HELP = `imessage-mcp doctor

Read-only diagnostics for Node, Messages database/WAL access, schema support,
Contacts mode, native decoding, secret files, and transport configuration.

Usage:
  imessage-mcp doctor [--database <path>] [--contacts live|none]
                      [--privacy full|redacted|aggregate] [--json]

Doctor prints remediation and never opens settings or changes permissions.
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
      "attachment-paths": { type: "boolean" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const command = parsed.positionals[0];
  if (parsed.positionals.length > 1) {
    throw new ImessageMcpError("INVALID_INPUT", "only one command may be provided");
  }
  if (parsed.values.version) {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  if (command === "help" || parsed.values.help) {
    if (command && command !== "help" && command !== "doctor") {
      throw new ImessageMcpError("INVALID_INPUT", "unknown command");
    }
    process.stdout.write(command === "doctor" ? DOCTOR_HELP : HELP);
    return;
  }
  const transport = parsed.values.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new ImessageMcpError("INVALID_INPUT", "transport must be stdio or http");
  }
  const port = Number(parsed.values.port);
  const config = runtimeConfig({
    databasePath: parsed.values.database,
    contacts: parsed.values.contacts,
    privacy: parsed.values.privacy,
    transport,
    port,
    attachmentPaths: parsed.values["attachment-paths"],
  });

  if (command === "doctor") {
    const { doctor } = await import("./commands/doctor.js");
    process.exitCode = await doctor(config, parsed.values.json ?? false);
  } else if (command) {
    throw new ImessageMcpError("INVALID_INPUT", "unknown command");
  } else if (transport === "http") {
    const { startHttp } = await import("./transport.js");
    await startHttp(new (await import("./tools.js")).ToolRuntime(config));
  } else {
    const { startStdio } = await import("./index.js");
    await startStdio(config);
  }
}

await main().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const normalized = typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")
    ? new ImessageMcpError("INVALID_INPUT", "command-line arguments are invalid")
    : asImessageMcpError(error);
  process.stderr.write(`${JSON.stringify({ status: "error", reason: normalized.reason })}\n`);
  process.exitCode = 1;
});
