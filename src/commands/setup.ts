import { runtimeConfig } from "../config.js";
import { asImessageMcpError } from "../errors.js";
import {
  addArguments,
  defaultConfigPath,
  formatCommand,
  isRunning,
  mergeServer,
  parseClient,
  parseScope,
  processName,
  readClientConfig,
  runBinary,
  serverEntry,
  serverFlags,
  writeClientConfig,
  type ClientName,
} from "./clients.js";

export interface SetupOptions {
  client?: string;
  scope?: string;
  contacts?: string;
  privacy?: string;
  config?: string;
  majorVersion: string;
  /** Tests disable the in-process doctor summary; the CLI always runs it. */
  runDoctor?: boolean;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function printDoctor(options: SetupOptions): Promise<void> {
  if (options.runDoctor === false) return;
  write("");
  try {
    const config = runtimeConfig({
      contacts: options.contacts,
      privacy: options.privacy,
      transport: "stdio",
    });
    const { doctor } = await import("./doctor.js");
    await doctor(config, false);
  } catch (error) {
    write(`doctor could not run: ${asImessageMcpError(error).message}`);
  }
}

async function setupThroughCli(client: "claude" | "codex", options: SetupOptions): Promise<number> {
  const entry = serverEntry(options.majorVersion, serverFlags(options));
  const scope = parseScope(options.scope);
  if (client === "codex" && options.scope !== undefined) {
    write("note: --scope applies to Claude Code only; Codex registers one user-level server");
  }
  const args = addArguments(client, entry, scope);
  const result = await runBinary(client, args);
  if (result.outcome === "missing") {
    write(`the ${client} command is not on PATH, so nothing was registered`);
    write("run this yourself once the client is installed:");
    write(`  ${formatCommand(client, args)}`);
    return 0;
  }
  if (result.outcome === "failed") {
    write(`${client} could not register the server: ${result.detail}`);
    write(`  ${formatCommand(client, args)}`);
    return 1;
  }
  write(`registered imessage with ${client}`);
  write(`  ${formatCommand(client, args)}`);
  await printDoctor(options);
  return 0;
}

async function setupThroughFile(client: "desktop" | "cursor", options: SetupOptions): Promise<number> {
  const entry = serverEntry(options.majorVersion, serverFlags(options));
  const file = options.config ?? defaultConfigPath(client);
  const application = processName(client);
  if (options.config === undefined && (await isRunning(application))) {
    write(`${application} is running and rewrites its configuration while open, so nothing was changed`);
    write(`quit ${application} and run this again${client === "desktop" ? ", or install the .mcpb bundle instead" : ""}`);
    return 1;
  }
  const merged = mergeServer(readClientConfig(file), entry);
  const written = writeClientConfig(file, merged);
  write(`registered imessage in ${written.file}`);
  if (written.backup) write(`  previous file copied to ${written.backup}`);
  write(`  ${entry.command} ${entry.args.join(" ")}`);
  write(`  restart ${application} and grant it Full Disk Access when macOS asks`);
  await printDoctor(options);
  return 0;
}

export async function runSetup(options: SetupOptions): Promise<number> {
  const client: ClientName = parseClient(options.client);
  serverFlags(options);
  if (client === "claude" || client === "codex") return setupThroughCli(client, options);
  return setupThroughFile(client, options);
}
