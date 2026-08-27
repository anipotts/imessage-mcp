#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runtimeConfig } from "./config.js";
import { asImessageMcpError, ImessageMcpError } from "./errors.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

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
