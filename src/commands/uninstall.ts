import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { canonicalPath, environmentSecretFiles, stateDirectory } from "../keys.js";
import {
  configBackups,
  defaultConfigPath,
  formatCommand,
  isRunning,
  processName,
  parseClient,
  parseScope,
  readClientConfig,
  removeArguments,
  removeServer,
  runBinary,
  writeClientConfig,
  type ClientName,
} from "./clients.js";

export interface UninstallOptions {
  client?: string;
  scope?: string;
  config?: string;
  purge?: boolean;
  yes?: boolean;
}

const KEY_FILE = /^(?:reference-key|database-id|database-id-[0-9a-f]{16})$/u;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function purgeState(options: UninstallOptions): number {
  if (options.purge !== true) return 0;
  if (options.yes !== true) {
    write("--purge deletes the generated keys permanently; repeat the command with --yes to confirm");
    return 1;
  }
  // The directory is either the default one or the one IMESSAGE_STATE_DIR names,
  // so containment comes from the checks below: ownership, the generated-name
  // allowlist, and the reserved-file guard.
  const directory = stateDirectory();
  let entries: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) {
      write(`refusing to purge ${directory}: it is not a directory`);
      return 1;
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      write(`refusing to purge ${directory}: it belongs to another user`);
      return 1;
    }
    entries = readdirSync(directory);
  } catch {
    write(`${directory} is already absent; no keys were deleted`);
    return 0;
  }
  const unexpected = entries.filter((entry) => !KEY_FILE.test(entry));
  if (unexpected.length > 0) {
    write(`refusing to purge ${directory}: it holds files this command did not generate`);
    return 1;
  }
  const reserved = environmentSecretFiles();
  if (entries.some((entry) => reserved.has(canonicalPath(path.join(directory, entry))))) {
    write(`refusing to purge ${directory}: a file there is named by an IMESSAGE_*_FILE variable`);
    return 1;
  }
  for (const entry of entries) unlinkSync(path.join(directory, entry));
  rmdirSync(directory);
  write(`deleted ${entries.length} generated key file(s) and removed ${directory}`);
  write("saved conversation references from earlier sessions no longer resolve");
  return 0;
}

async function uninstallThroughCli(client: "claude" | "codex", options: UninstallOptions): Promise<number> {
  const args = removeArguments(client, parseScope(options.scope));
  const result = await runBinary(client, args);
  if (result.outcome === "missing") {
    write(`the ${client} command is not on PATH, so nothing was removed`);
    write("run this yourself:");
    write(`  ${formatCommand(client, args)}`);
    return 0;
  }
  if (result.outcome === "failed") {
    write(`${client} could not remove the server: ${result.detail}`);
    write(`  ${formatCommand(client, args)}`);
    return 1;
  }
  write(`removed imessage from ${client}`);
  return 0;
}

async function uninstallThroughFile(client: "desktop" | "cursor", options: UninstallOptions): Promise<number> {
  const file = options.config ?? defaultConfigPath(client);
  const application = processName(client);
  if (options.config === undefined && (await isRunning(application))) {
    write(`${application} is running and rewrites its configuration while open, so nothing was changed`);
    write(`quit ${application} and run this again`);
    return 1;
  }
  const { config, removed } = removeServer(readClientConfig(file));
  if (!removed) {
    write(`imessage is not configured in ${file}; nothing was changed`);
    return 0;
  }
  const written = writeClientConfig(file, config);
  write(`removed imessage from ${written.file}`);
  if (written.backup) write(`  previous file copied to ${written.backup}`);
  const backups = configBackups(written.file);
  if (backups.length > 0) {
    write(`  ${String(backups.length)} backup file(s) stay behind; --purge never removes them:`);
    for (const backup of backups) write(`    ${backup}`);
  }
  write(`  restart ${application} to drop the running server`);
  return 0;
}

export async function runUninstall(options: UninstallOptions): Promise<number> {
  const client: ClientName = parseClient(options.client);
  const code = client === "claude" || client === "codex"
    ? await uninstallThroughCli(client, options)
    : await uninstallThroughFile(client, options);
  const purged = purgeState(options);
  return code === 0 ? purged : code;
}
