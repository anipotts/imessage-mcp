// Names the app macOS should be told to grant Full Disk Access to. When
// chat.db returns EPERM, the fix is granting FDA to whatever process actually
// launched this server, not to node itself. We walk the parent-process chain
// looking for the outermost .app bundle on each ancestor's executable path
// (a helper process nested inside Cursor.app resolves to Cursor, not the
// helper), read that bundle's identifier, and only ever name it in the
// instruction we hand back if it matches a fixed list of known MCP clients
// and terminals. An unrecognized process is never named or path-leaked.

import { execFileSync } from "node:child_process";
import path from "node:path";

const PS_TIMEOUT_MS = 2_000;
const PLUTIL_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_DEPTH = 16;

export interface ResponsibleApp {
  name: string;
  bundleId: string;
  appPath: string;
}

export interface ProcessInfo {
  ppid: number;
  executable: string;
}

// Bundle id -> display name. Verified against a real Info.plist on this Mac
// where noted; the rest are well-known ids for clients not installed here.
// Never add an id without verifying it against a real plist or the plan's
// well-known list.
export const KNOWN_CLIENTS: ReadonlyMap<string, string> = new Map([
  // verified via plutil against an installed Info.plist on this machine
  ["com.anthropic.claudefordesktop", "Claude"],
  ["com.todesktop.230313mzl4w4u92", "Cursor"],
  ["com.apple.Terminal", "Terminal"],
  ["com.mitchellh.ghostty", "Ghostty"],
  // well-known ids, not installed on this machine (per plan section 3.9)
  ["com.microsoft.VSCode", "Visual Studio Code"],
  ["com.microsoft.VSCodeInsiders", "Visual Studio Code - Insiders"],
  ["com.exafunction.windsurf", "Windsurf"],
  ["dev.zed.Zed", "Zed"],
  ["dev.warp.Warp-Stable", "Warp"],
  ["com.googlecode.iterm2", "iTerm"],
]);

// Reads a process's parent pid and executable path via `ps`. Returns null on
// any failure (process gone, ps missing, timeout) rather than throwing: a
// permission-error message is best-effort and must never crash the server.
function defaultReadProcess(pid: number): ProcessInfo | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
    });
    const line = out.trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) return null;
    return { ppid: Number(match[1]), executable: match[2] };
  } catch {
    return null;
  }
}

// Reads CFBundleIdentifier from an app bundle's Info.plist via plutil.
// Returns null when the bundle has no readable Info.plist.
function defaultReadBundleId(appPath: string): string | null {
  try {
    const out = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(appPath, "Contents/Info.plist")],
      { encoding: "utf8", timeout: PLUTIL_TIMEOUT_MS },
    );
    return out.trim();
  } catch {
    return null;
  }
}

// Given an executable path, returns the path up to and including the first
// path component that ends in ".app" (the outermost bundle), or null when
// no component of the path is an app bundle.
export function outermostAppBundle(executable: string): string | null {
  const segments = executable.split(path.sep);
  let prefix = "";
  for (const segment of segments) {
    if (prefix === "") {
      // A leading "/" splits into a "" segment; keep it as the root rather
      // than dropping it, so absolute paths stay absolute.
      prefix = segment === "" ? path.sep : segment;
    } else {
      prefix = prefix === path.sep ? `${path.sep}${segment}` : `${prefix}${path.sep}${segment}`;
    }
    if (segment.endsWith(".app")) return prefix;
  }
  return null;
}

export interface FindResponsibleAppOptions {
  pid?: number;
  readProcess?: (pid: number) => ProcessInfo | null;
  readBundleId?: (appPath: string) => string | null;
  maxDepth?: number;
}

// Walks the parent-process chain from `pid` (default: this server's parent)
// looking for the nearest ancestor whose outermost app bundle has a known
// bundle id. "Nearest" rather than "outermost known": a known client that
// launched another known client (Claude Desktop's node inside a Terminal
// window, say) should be attributed to whichever one is actually the direct
// launcher, and the nearest known ancestor is the one that needs FDA granted
// for this specific process to work. Returns null when no ancestor within
// maxDepth resolves to a known client.
export function findResponsibleApp(options: FindResponsibleAppOptions = {}): ResponsibleApp | null {
  const readProcess = options.readProcess ?? defaultReadProcess;
  const readBundleId = options.readBundleId ?? defaultReadBundleId;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const startPid = options.pid ?? process.ppid;

  const seen = new Set<number>();
  let pid = startPid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (pid <= 1) break;
    if (seen.has(pid)) break; // cycle guard: ps can misreport under odd conditions
    seen.add(pid);

    const info = readProcess(pid);
    if (!info) break;

    const appPath = outermostAppBundle(info.executable);
    if (appPath) {
      const bundleId = readBundleId(appPath);
      if (bundleId && KNOWN_CLIENTS.has(bundleId)) {
        return { name: KNOWN_CLIENTS.get(bundleId)!, bundleId, appPath };
      }
    }

    pid = info.ppid;
  }
  return null;
}

// Builds the user-facing instruction for granting Full Disk Access. Never
// includes a filesystem path or an unrecognized process name: those would
// either leak local layout or mislabel an untrusted process as an
// instruction to grant it access.
export function fullDiskAccessInstruction(app: ResponsibleApp | null): string {
  const link = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
  if (app) {
    return (
      `macOS is blocking access to Messages. Open System Settings > Privacy & Security > ` +
      `Full Disk Access (${link}), turn on ${app.name}, then quit ${app.name} fully and reopen it.`
    );
  }
  return (
    `macOS is blocking access to Messages. Open System Settings > Privacy & Security > ` +
    `Full Disk Access (${link}), turn on the app that runs this server (Claude for Claude Desktop, ` +
    `your terminal for command-line clients, or your editor), then quit that app fully and reopen it.`
  );
}
