import { describe, expect, it } from "vitest";
import {
  KNOWN_CLIENTS,
  findResponsibleApp,
  fullDiskAccessInstruction,
  outermostAppBundle,
  type ProcessInfo,
} from "../src/responsible-app.js";

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

  it("is a live smoke test: default options return null or a known client", () => {
    const app = findResponsibleApp();
    if (app !== null) {
      expect(KNOWN_CLIENTS.has(app.bundleId)).toBe(true);
      expect(app.name).toBe(KNOWN_CLIENTS.get(app.bundleId));
    } else {
      expect(app).toBeNull();
    }
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
