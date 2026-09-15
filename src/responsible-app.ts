// Names the app macOS should be told to grant Full Disk Access to. When
// chat.db returns EPERM, the fix is granting FDA to whatever process actually
// launched this server, not to node itself. We walk the parent-process chain
// looking for the outermost .app bundle on each ancestor's executable path
// (a helper process nested inside Cursor.app resolves to Cursor, not the
// helper), read that bundle's identifier, and only ever name it in the
// instruction we hand back if it matches a fixed list of known MCP clients
// and terminals. An unrecognized process is never named or path-leaked.
//
// Two wrinkles the plain "walk to the outermost known bundle" rule misses:
// Claude.app hands TCC responsibility for its child process to that child
// through a small "disclaimer" helper it launches first (so the child, not
// Claude.app itself, is the process that actually needs FDA), and a process
// launched directly by launchd (ppid 1) has no further ancestor to blame, so
// an unknown one there is a dead end, not a reason to keep walking.

import { execFileSync } from "node:child_process";
import path from "node:path";

const PS_TIMEOUT_MS = 2_000;
const PLUTIL_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_DEPTH = 16;
// The disclaimer sits at Contents/Helpers/disclaimer inside the app that runs
// it, so it is matched by suffix.
const DISCLAIMER_SUFFIX = `${path.sep}Contents${path.sep}Helpers${path.sep}disclaimer`;
const JETBRAINS_BUNDLE_PREFIX = "com.jetbrains.";

export interface ResponsibleApp {
  name: string;
  bundleId: string;
  appPath: string;
}

export interface ProcessInfo {
  ppid: number;
  executable: string;
}

// Bundle id to display name. Add an id only after checking it against the
// app's Info.plist or its publisher's documentation.
export const KNOWN_CLIENTS: ReadonlyMap<string, string> = new Map([
  // verified against installed Info.plist files
  ["com.anthropic.claudefordesktop", "Claude"],
  ["com.anthropic.claude-code", "Claude Code"],
  ["com.todesktop.230313mzl4w4u92", "Cursor"],
  ["com.apple.Terminal", "Terminal"],
  ["com.mitchellh.ghostty", "Ghostty"],
  // published bundle ids
  ["com.openai.codex", "Codex"],
  ["com.microsoft.VSCode", "Visual Studio Code"],
  ["com.microsoft.VSCodeInsiders", "Visual Studio Code - Insiders"],
  ["com.exafunction.windsurf", "Windsurf"],
  ["dev.zed.Zed", "Zed"],
  ["dev.warp.Warp-Stable", "Warp"],
  ["com.googlecode.iterm2", "iTerm"],
]);

// KNOWN_CLIENTS plus the JetBrains family, which ships one bundle id per IDE
// (com.jetbrains.intellij, .pycharm, .webstorm, ...) under a shared prefix
// rather than a fixed list we'd have to keep adding to.
function resolveClientName(bundleId: string): string | null {
  const exact = KNOWN_CLIENTS.get(bundleId);
  if (exact) return exact;
  if (bundleId.startsWith(JETBRAINS_BUNDLE_PREFIX)) return "your JetBrains IDE";
  return null;
}

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

// findResponsibleApp() with no options at all always resolves the same
// answer for the life of the process (this server's own parent chain does
// not change), so the real ps/plutil walk only ever needs to run once.
// Populated lazily; `undefined` means "not computed yet" (distinct from a
// computed `null`, which means "no known client found").
let defaultResultCache: { value: ResponsibleApp | null } | undefined;

// Walks the parent-process chain from `pid` (default: this server's parent)
// looking for the nearest ancestor whose outermost app bundle has a known
// bundle id. "Nearest" rather than "outermost known": a known client that
// launched another known client (Claude Desktop's node inside a Terminal
// window, say) should be attributed to whichever one is actually the direct
// launcher, and the nearest known ancestor is the one that needs FDA granted
// for this specific process to work. Returns null when no ancestor within
// maxDepth resolves to a known client.
export function findResponsibleApp(options: FindResponsibleAppOptions = {}): ResponsibleApp | null {
  const usingDefaults = Object.keys(options).length === 0;
  if (usingDefaults && defaultResultCache) return defaultResultCache.value;

  const readProcess = options.readProcess ?? defaultReadProcess;
  const readBundleId = options.readBundleId ?? defaultReadBundleId;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const startPid = options.pid ?? process.ppid;

  const seen = new Set<number>();
  let pid = startPid;
  let result: ResponsibleApp | null = null;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (pid <= 1) break; // launchd: no further ancestor exists to blame
    if (seen.has(pid)) break; // cycle guard: ps can misreport under odd conditions
    seen.add(pid);

    const info = readProcess(pid);
    if (!info) break;

    const appPath = outermostAppBundle(info.executable);
    let known: ResponsibleApp | null = null;
    if (appPath) {
      const bundleId = readBundleId(appPath);
      const name = bundleId ? resolveClientName(bundleId) : null;
      if (bundleId && name) known = { name, bundleId, appPath };
    }

    // The disclaimer hands TCC responsibility for this process to its
    // child, so this process (not whatever launched the disclaimer) is the
    // one that needs FDA. Stop the walk here either way: continuing up
    // through the disclaimer to its own launcher (Claude.app) would credit
    // an app that explicitly declined responsibility for this child.
    if (info.ppid > 1) {
      const parentInfo = readProcess(info.ppid);
      if (parentInfo && parentInfo.executable.endsWith(DISCLAIMER_SUFFIX)) {
        result = known;
        break;
      }
    }

    if (known) {
      result = known;
      break;
    }

    pid = info.ppid;
  }

  if (usingDefaults) defaultResultCache = { value: result };
  return result;
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
