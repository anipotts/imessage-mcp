import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findResponsibleApp,
  fullDiskAccessInstruction,
  outermostAppBundle,
  type ProcessInfo,
} from "../src/responsible-app.js";

// The default (no-argument) path shells out to /bin/ps and /usr/bin/plutil;
// mocked here so the memoization test below can count invocations
// deterministically instead of depending on this machine's real process tree.
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const mockExecFileSync = vi.mocked(execFileSync);

describe("outermostAppBundle", () => {
  it("returns null for a plain binary with no .app component", () => {
    expect(outermostAppBundle("/usr/local/bin/node")).toBeNull();
  });

  it("returns the bundle path for a direct app executable", () => {
    expect(outermostAppBundle("/Applications/Ghostty.app/Contents/MacOS/ghostty")).toBe(
      "/Applications/Ghostty.app",
    );
  });

  it("returns the OUTERMOST bundle for a nested helper app", () => {
    expect(
      outermostAppBundle(
        "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
      ),
    ).toBe("/Applications/Cursor.app");
  });

  it("handles path components containing spaces", () => {
    expect(
      outermostAppBundle("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"),
    ).toBe("/Applications/Visual Studio Code.app");
  });

  it("returns null for an empty or root-only path", () => {
    expect(outermostAppBundle("")).toBeNull();
    expect(outermostAppBundle("/")).toBeNull();
  });
});

// Builds a readProcess stub from a pid -> ProcessInfo map, simulating ps.
function processMap(map: Record<number, ProcessInfo>): (pid: number) => ProcessInfo | null {
  return (pid) => map[pid] ?? null;
}

describe("findResponsibleApp", () => {
  it("resolves Claude Desktop launching node directly", () => {
    const readProcess = processMap({
      100: { ppid: 1, executable: "/Applications/AI/Claude.app/Contents/MacOS/Claude" },
    });
    const readBundleId = (appPath: string) =>
      appPath === "/Applications/AI/Claude.app" ? "com.anthropic.claudefordesktop" : null;

    const app = findResponsibleApp({ pid: 100, readProcess, readBundleId });
    expect(app).toEqual({
      name: "Claude",
      bundleId: "com.anthropic.claudefordesktop",
      appPath: "/Applications/AI/Claude.app",
    });
  });

  it("resolves a Cursor helper chain to Cursor", () => {
    const readProcess = processMap({
      300: {
        ppid: 200,
        executable:
          "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
      },
      200: { ppid: 1, executable: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
    });
    const readBundleId = (appPath: string) =>
      appPath === "/Applications/Cursor.app" ? "com.todesktop.230313mzl4w4u92" : null;

    const app = findResponsibleApp({ pid: 300, readProcess, readBundleId });
    expect(app?.name).toBe("Cursor");
    expect(app?.appPath).toBe("/Applications/Cursor.app");
  });

  it("resolves node under zsh under Terminal", () => {
    const readProcess = processMap({
      50: { ppid: 40, executable: "/opt/homebrew/bin/node" },
      40: { ppid: 30, executable: "/bin/zsh" },
      30: { ppid: 1, executable: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
    });
    const readBundleId = (appPath: string) =>
      appPath === "/System/Applications/Utilities/Terminal.app" ? "com.apple.Terminal" : null;

    const app = findResponsibleApp({ pid: 50, readProcess, readBundleId });
    expect(app?.name).toBe("Terminal");
    expect(app?.bundleId).toBe("com.apple.Terminal");
  });

  it("returns null when node runs under an unknown app", () => {
    const readProcess = processMap({
      70: { ppid: 60, executable: "/usr/local/bin/node" },
      60: { ppid: 1, executable: "/Applications/SomeRandomApp.app/Contents/MacOS/SomeRandomApp" },
    });
    const readBundleId = () => "com.example.unknown-app";

    const app = findResponsibleApp({ pid: 70, readProcess, readBundleId });
    expect(app).toBeNull();
  });

  it("stops on a cycle instead of looping forever", () => {
    const readProcess = processMap({
      10: { ppid: 20, executable: "/usr/local/bin/node" },
      20: { ppid: 10, executable: "/usr/local/bin/wrapper" }, // 10 <-> 20 cycle
    });
    const readBundleId = () => null;

    expect(() => findResponsibleApp({ pid: 10, readProcess, readBundleId })).not.toThrow();
    expect(findResponsibleApp({ pid: 10, readProcess, readBundleId })).toBeNull();
  });

  it("stops after maxDepth without finding a known client", () => {
    const map: Record<number, ProcessInfo> = {};
    for (let pid = 2; pid <= 50; pid += 1) {
      map[pid] = { ppid: pid + 1, executable: `/usr/local/bin/proc${pid}` };
    }
    const readProcess = processMap(map);
    const readBundleId = () => null;

    const app = findResponsibleApp({ pid: 2, readProcess, readBundleId, maxDepth: 5 });
    expect(app).toBeNull();
  });

  it("returns null when ps (readProcess) fails immediately", () => {
    const app = findResponsibleApp({ pid: 999, readProcess: () => null, readBundleId: () => null });
    expect(app).toBeNull();
  });

  // Real chain on this Mac: zsh -> Claude Code's claude.app (nested under
  // ~/Library/Application Support/Claude/claude-code/<version>) -> Claude.app's
  // disclaimer helper -> Claude.app. The disclaimer hands TCC responsibility
  // to its child (the claude-code app), so the walk must stop there and name
  // Claude Code, never keep going up through the disclaimer to Claude.app.
  it("stops at the disclaimer and attributes to its known child (Claude Code)", () => {
    const readProcess = processMap({
      400: { ppid: 401, executable: "/bin/zsh" },
      401: {
        ppid: 402,
        executable:
          "/Users/anipotts/Library/Application Support/Claude/claude-code/2.1.270/claude.app/Contents/MacOS/claude",
      },
      402: { ppid: 403, executable: "/Applications/AI/Claude.app/Contents/Helpers/disclaimer" },
      403: { ppid: 1, executable: "/Applications/AI/Claude.app/Contents/MacOS/Claude" },
    });
    const readBundleId = (appPath: string) => {
      if (appPath.endsWith("claude-code/2.1.270/claude.app")) return "com.anthropic.claude-code";
      if (appPath === "/Applications/AI/Claude.app") return "com.anthropic.claudefordesktop";
      return null;
    };

    const app = findResponsibleApp({ pid: 400, readProcess, readBundleId });
    expect(app).toEqual({
      name: "Claude Code",
      bundleId: "com.anthropic.claude-code",
      appPath: "/Users/anipotts/Library/Application Support/Claude/claude-code/2.1.270/claude.app",
    });
  });

  // The disclaimer should also stop the walk (rather than crediting
  // Claude.app) when the child it hands responsibility to is NOT a known
  // client: the walk must return null, not fall through to Claude.app.
  it("stops at the disclaimer and returns null for an unrecognized child", () => {
    const readProcess = processMap({
      500: { ppid: 501, executable: "/usr/local/bin/some-unknown-tool" },
      501: { ppid: 502, executable: "/Applications/AI/Claude.app/Contents/Helpers/disclaimer" },
      502: { ppid: 1, executable: "/Applications/AI/Claude.app/Contents/MacOS/Claude" },
    });
    const readBundleId = (appPath: string) =>
      appPath === "/Applications/AI/Claude.app" ? "com.anthropic.claudefordesktop" : null;

    const app = findResponsibleApp({ pid: 500, readProcess, readBundleId });
    expect(app).toBeNull();
  });

  // An unknown app launched directly by launchd (ppid 1) is a dead end: there
  // is no further ancestor to blame. The stub deliberately makes pid 1 itself
  // resolve to a KNOWN client, so this test only passes if the walk actually
  // stops at ppid 1 rather than examining it as if it were a real ancestor.
  it("stops at launchd (ppid 1) for an unrecognized ancestor instead of examining pid 1", () => {
    const readProcess = processMap({
      600: { ppid: 601, executable: "/usr/local/bin/node" },
      601: { ppid: 1, executable: "/Applications/SomeUnknownApp.app/Contents/MacOS/SomeUnknownApp" },
      // If the walk ever treated pid 1 as an ancestor to inspect, this entry
      // would incorrectly resolve to a known client.
      1: { ppid: 1, executable: "/Applications/AI/Claude.app/Contents/MacOS/Claude" },
    });
    const readBundleId = (appPath: string) =>
      appPath === "/Applications/AI/Claude.app" ? "com.anthropic.claudefordesktop" : null;

    const app = findResponsibleApp({ pid: 600, readProcess, readBundleId });
    expect(app).toBeNull();
  });

  it("matches any com.jetbrains.* bundle id as \"your JetBrains IDE\"", () => {
    const readProcess = processMap({
      700: { ppid: 1, executable: "/Applications/PyCharm.app/Contents/MacOS/pycharm" },
    });
    const readBundleId = (appPath: string) => (appPath === "/Applications/PyCharm.app" ? "com.jetbrains.pycharm" : null);

    const app = findResponsibleApp({ pid: 700, readProcess, readBundleId });
    expect(app).toEqual({ name: "your JetBrains IDE", bundleId: "com.jetbrains.pycharm", appPath: "/Applications/PyCharm.app" });
  });

  it("resolves Codex directly", () => {
    const readProcess = processMap({
      800: { ppid: 1, executable: "/Applications/Codex.app/Contents/MacOS/Codex" },
    });
    const readBundleId = (appPath: string) => (appPath === "/Applications/Codex.app" ? "com.openai.codex" : null);

    const app = findResponsibleApp({ pid: 800, readProcess, readBundleId });
    expect(app).toEqual({ name: "Codex", bundleId: "com.openai.codex", appPath: "/Applications/Codex.app" });
  });

  describe("default-options memoization", () => {
    afterEach(() => {
      mockExecFileSync.mockReset();
    });

    it("calls ps at most once across repeated no-argument calls", () => {
      // A single hop that terminates immediately: ppid 1, no .app component,
      // so no plutil call is needed either. One ps invocation total if the
      // result is memoized; two if it is recomputed on the second call.
      mockExecFileSync.mockImplementation(() => "1 /usr/bin/node\n");

      const first = findResponsibleApp();
      const callsAfterFirst = mockExecFileSync.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      const second = findResponsibleApp();
      expect(second).toEqual(first);
      expect(mockExecFileSync.mock.calls.length).toBe(callsAfterFirst);

      // An explicit-options call is never served from the default cache and
      // must keep working normally, independent of the mocked execFileSync.
      const explicit = findResponsibleApp({ pid: 999, readProcess: () => null, readBundleId: () => null });
      expect(explicit).toBeNull();
    });
  });
});

describe("fullDiskAccessInstruction", () => {
  it("names the app when known, without a path", () => {
    const message = fullDiskAccessInstruction({
      name: "Cursor",
      bundleId: "com.todesktop.230313mzl4w4u92",
      appPath: "/Applications/Cursor.app",
    });
    expect(message).toContain("Cursor");
    expect(message).not.toContain("/");
  });

  it("falls back to a generic instruction when the app is unknown, without a path", () => {
    const message = fullDiskAccessInstruction(null);
    expect(message).toContain("Full Disk Access");
    expect(message).not.toContain("/");
  });
});
