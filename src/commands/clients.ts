import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ImessageMcpError } from "../errors.js";

const execFileAsync = promisify(execFile);

export type ClientName = "claude" | "codex" | "desktop" | "cursor";
export type ClientScope = "user" | "project";

export const CLIENT_NAMES: readonly ClientName[] = ["claude", "codex", "desktop", "cursor"];
export const SERVER_KEY = "imessage";

export interface ServerEntry {
  command: string;
  args: string[];
}

export function parseClient(value: string | undefined): ClientName {
  if (value !== undefined && (CLIENT_NAMES as readonly string[]).includes(value)) return value as ClientName;
  throw new ImessageMcpError("INVALID_INPUT", "--client must be claude, codex, desktop, or cursor");
}

export function parseScope(value: string | undefined): ClientScope {
  if (value === undefined) return "user";
  if (value === "user" || value === "project") return value;
  throw new ImessageMcpError("INVALID_INPUT", "--scope must be user or project");
}

export function serverFlags(input: { contacts?: string; privacy?: string }): string[] {
  const flags: string[] = [];
  if (input.contacts !== undefined) {
    if (input.contacts !== "live" && input.contacts !== "none") {
      throw new ImessageMcpError("INVALID_INPUT", "contacts must be live or none");
    }
    flags.push("--contacts", input.contacts);
  }
  if (input.privacy !== undefined) {
    if (input.privacy !== "full" && input.privacy !== "redacted" && input.privacy !== "aggregate") {
      throw new ImessageMcpError("INVALID_INPUT", "privacy mode must be full, redacted, or aggregate");
    }
    flags.push("--privacy", input.privacy);
  }
  return flags;
}

export function serverEntry(majorVersion: string, flags: string[]): ServerEntry {
  return { command: "npx", args: ["-y", `imessage-mcp@${majorVersion}`, ...flags] };
}

export function addArguments(client: "claude" | "codex", entry: ServerEntry, scope: ClientScope): string[] {
  const tail = ["--", entry.command, ...entry.args];
  if (client === "codex") return ["mcp", "add", SERVER_KEY, ...tail];
  return ["mcp", "add", SERVER_KEY, "-s", scope, ...tail];
}

export function removeArguments(client: "claude" | "codex", scope: ClientScope): string[] {
  if (client === "codex") return ["mcp", "remove", SERVER_KEY];
  return ["mcp", "remove", SERVER_KEY, "-s", scope];
}

export function formatCommand(binary: string, args: string[]): string {
  return [binary, ...args].map((part) => (/[\s"'$`\\]/u.test(part) ? `'${part.replace(/'/gu, "'\\''")}'` : part)).join(" ");
}

export type BinaryResult =
  | { outcome: "ran"; stdout: string }
  | { outcome: "missing" }
  | { outcome: "failed"; detail: string };

export async function runBinary(binary: string, args: string[]): Promise<BinaryResult> {
  try {
    const { stdout } = await execFileAsync(binary, args, { shell: false, windowsHide: true });
    return { outcome: "ran", stdout: String(stdout) };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; code?: string | number };
    if (failure.code === "ENOENT") return { outcome: "missing" };
    const detail = String(failure.stderr ?? failure.message ?? "").trim().split(/\r?\n/u)[0] ?? "";
    return { outcome: "failed", detail: detail || `${binary} exited with a non-zero status` };
  }
}

export function processName(client: "desktop" | "cursor"): string {
  return client === "desktop" ? "Claude" : "Cursor";
}

export async function isRunning(name: string): Promise<boolean> {
  const result = await runBinary("pgrep", ["-x", name]);
  return result.outcome === "ran";
}

export function defaultConfigPath(client: "desktop" | "cursor"): string {
  const home = userInfo().homedir;
  if (client === "desktop") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".cursor", "mcp.json");
}

export interface ClientConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readClientConfig(file: string): ClientConfig {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", `${file} could not be read`);
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", `${file} is not valid JSON; fix or move it and run setup again`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ImessageMcpError("INVALID_INPUT", `${file} must contain a JSON object`);
  }
  return parsed as ClientConfig;
}

export interface WriteResult {
  file: string;
  backup: string | null;
}

export function writeClientConfig(file: string, value: ClientConfig): WriteResult {
  const directory = path.dirname(file);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", `${directory} could not be created`);
  }
  let backup: string | null = null;
  if (existsSync(file)) {
    const stamp = `${file}.bak-${Math.floor(Date.now() / 1000)}`;
    for (let attempt = 0; backup === null && attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? stamp : `${stamp}-${attempt}`;
      try {
        copyFileSync(file, candidate, constants.COPYFILE_EXCL);
        backup = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ImessageMcpError("INVALID_INPUT", `${file} could not be backed up; nothing was changed`);
        }
      }
    }
    if (backup === null) {
      throw new ImessageMcpError("INVALID_INPUT", `${file} could not be backed up; nothing was changed`);
    }
  }
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  let descriptor: number;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    throw new ImessageMcpError("INVALID_INPUT", `${directory} is not writable; nothing was changed`);
  }
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // the temporary file is already gone
    }
    throw new ImessageMcpError("INVALID_INPUT", `${file} could not be written; nothing was changed`);
  }
  closeSync(descriptor);
  try {
    renameSync(temporary, file);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // the temporary file is already gone
    }
    throw new ImessageMcpError("INVALID_INPUT", `${file} could not be replaced; nothing was changed`);
  }
  return { file, backup };
}

export function mergeServer(config: ClientConfig, entry: ServerEntry): ClientConfig {
  const servers = typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers)
    ? { ...config.mcpServers }
    : {};
  servers[SERVER_KEY] = { command: entry.command, args: entry.args };
  return { ...config, mcpServers: servers };
}

export function removeServer(config: ClientConfig): { config: ClientConfig; removed: boolean } {
  const servers = typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers)
    ? { ...config.mcpServers }
    : {};
  const removed = Object.hasOwn(servers, SERVER_KEY);
  delete servers[SERVER_KEY];
  return { config: { ...config, mcpServers: servers }, removed };
}
