#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveDatabaseSelection, runtimeConfig } from "./config.js";
import { asImessageMcpError, ImessageMcpError } from "./errors.js";
import { repairDefaultState, type StateRepair } from "./keys.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `imessage-mcp ${packageVersion}

Private, read-only MCP for Apple Messages history on Mac.

Usage:
  imessage-mcp [options]
  imessage-mcp setup --client claude|codex|desktop|cursor [options]
  imessage-mcp uninstall --client claude|codex|desktop|cursor [options]
  imessage-mcp doctor [options]
  imessage-mcp help

First run (privacy-first):
  imessage-mcp setup --client claude --contacts none --privacy redacted
  imessage-mcp doctor --contacts none --privacy redacted

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
      --fix                   Repair generated key files and modes (doctor)
      --client <name>         claude, codex, desktop, or cursor (setup/uninstall)
      --scope <name>          user (default) or project, for Claude Code
      --config <path>         Client JSON file to edit instead of the default
      --purge                 Delete the generated keys (uninstall, with --yes)
      --yes                   Confirm a destructive uninstall step

The reference key and database identity are generated on first run under
~/Library/Application Support/imessage-mcp, and IMESSAGE_REFERENCE_KEY_FILE or
IMESSAGE_DATABASE_ID_FILE pin either value to a file you control.

HTTP additionally requires IMESSAGE_API_TOKEN or IMESSAGE_API_TOKEN_FILE.
Full Disk Access belongs to the launching MCP client. Start with redacted and
opt into full only when you intend to return message bodies to that client.
`;

const DOCTOR_HELP = `imessage-mcp doctor

Read-only diagnostics for Node, Messages database/WAL access, schema support,
Contacts mode, native decoding, secret files, and transport configuration.

Usage:
  imessage-mcp doctor [--database <path>] [--contacts live|none]
                      [--privacy full|redacted|aggregate] [--json] [--fix]

Doctor prints remediation and never opens settings or changes permissions.

--fix creates missing generated key files, restores mode 0600 on them and 0700
on the state directory, and stops there. It never changes a file named by an
IMESSAGE_*_FILE variable, and it never touches Full Disk Access or Contacts
authorization; grant those in System Settings > Privacy & Security.
`;

const SETUP_HELP = `imessage-mcp setup

Registers this server with one MCP client as imessage.

Usage:
  imessage-mcp setup --client claude|codex|desktop|cursor [--scope user|project]
                     [--contacts live|none] [--privacy full|redacted|aggregate]
                     [--config <path>]

claude and codex run their own mcp add command; when that binary is missing,
setup prints the exact command instead of guessing. desktop and cursor read a
JSON file their application rewrites while it runs, so setup refuses while the
application is open, backs the file up, and replaces it atomically. It then
runs the doctor checks in process and prints the summary.
`;

const UNINSTALL_HELP = `imessage-mcp uninstall

Removes the imessage server from one MCP client.

Usage:
  imessage-mcp uninstall --client claude|codex|desktop|cursor [--scope user|project]
                         [--config <path>] [--purge --yes]

Other servers in a desktop or cursor configuration are preserved. --purge also
deletes the generated key files and their state directory, requires --yes, and
never deletes a file named by an IMESSAGE_*_FILE variable.
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
      fix: { type: "boolean", default: false },
      client: { type: "string" },
      scope: { type: "string" },
      config: { type: "string" },
      purge: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
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
    const topics: Record<string, string> = { doctor: DOCTOR_HELP, setup: SETUP_HELP, uninstall: UNINSTALL_HELP };
    if (command && command !== "help" && !Object.hasOwn(topics, command)) {
      throw new ImessageMcpError("INVALID_INPUT", "unknown command");
    }
    process.stdout.write(command && topics[command] ? topics[command] : HELP);
    return;
  }
  if (command === "setup") {
    const { runSetup } = await import("./commands/setup.js");
    process.exitCode = await runSetup({
      client: parsed.values.client,
      scope: parsed.values.scope,
      contacts: parsed.values.contacts,
      privacy: parsed.values.privacy,
      config: parsed.values.config,
      majorVersion: packageVersion.split(".")[0],
    });
    return;
  }
  if (command === "uninstall") {
    const { runUninstall } = await import("./commands/uninstall.js");
    process.exitCode = await runUninstall({
      client: parsed.values.client,
      scope: parsed.values.scope,
      config: parsed.values.config,
      purge: parsed.values.purge,
      yes: parsed.values.yes,
    });
    return;
  }
  const transport = parsed.values.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new ImessageMcpError("INVALID_INPUT", "transport must be stdio or http");
  }
  const port = Number(parsed.values.port);
  let repairs: StateRepair[] = [];
  if (parsed.values.fix) {
    if (command !== "doctor") {
      throw new ImessageMcpError("INVALID_INPUT", "--fix applies to the doctor command");
    }
    const selection = resolveDatabaseSelection(parsed.values.database);
    repairs = repairDefaultState(selection.path, selection.sourceMode);
  }
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
    process.exitCode = await doctor(config, parsed.values.json ?? false, repairs);
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
