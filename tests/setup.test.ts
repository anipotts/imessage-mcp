import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfigPath } from "../src/commands/clients.js";
import { defaultStateDirectory, repairDefaultState } from "../src/keys.js";
import { runSetup } from "../src/commands/setup.js";
import { runUninstall } from "../src/commands/uninstall.js";

const TRACKED = ["HOME", "PATH", "IMESSAGE_STATE_DIR", "IMESSAGE_REFERENCE_KEY", "IMESSAGE_REFERENCE_KEY_FILE", "IMESSAGE_DATABASE_ID", "IMESSAGE_DATABASE_ID_FILE"] as const;
const original = new Map(TRACKED.map((name) => [name, process.env[name]]));
const directories: string[] = [];

const SYNTHETIC_DATABASE = "/Users/synthetic/Library/Messages/chat.db";

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-setup-test-"));
  directories.push(directory);
  return directory;
}

/** Puts recording stand-ins for the client binaries first on PATH. */
function fakeBinaries(names: string[]): { directory: string; argv: (name: string) => string[] } {
  const directory = scratch();
  for (const name of names) {
    const record = path.join(directory, `${name}.argv`);
    writeFileSync(path.join(directory, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${record}\n`, { mode: 0o755 });
  }
  process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
  return {
    directory,
    argv: (name) => {
      const record = path.join(directory, `${name}.argv`);
      if (!existsSync(record)) return [];
      return readFileSync(record, "utf8").split("\n").filter((line) => line !== "");
    },
  };
}

function capture(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return { lines: () => written.join("").split("\n"), restore: () => spy.mockRestore() };
}

function clientConfig(servers: Record<string, unknown>): { file: string; directory: string } {
  const directory = scratch();
  const file = path.join(directory, "config.json");
  writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return { file, directory };
}

function readServers(file: string): Record<string, { command: string; args: string[] }> {
  return (JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers;
}

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("setup and uninstall through a client binary", () => {
  it("invokes claude mcp add with the pinned major version and chosen flags", async () => {
    const binaries = fakeBinaries(["claude"]);
    const output = capture();
    try {
      expect(await runSetup({ client: "claude", contacts: "none", privacy: "redacted", majorVersion: "2", runDoctor: false })).toBe(0);
    } finally {
      output.restore();
    }
    expect(binaries.argv("claude")).toEqual([
      "mcp", "add", "imessage", "-s", "user", "--", "npx", "-y", "imessage-mcp@2", "--contacts", "none", "--privacy", "redacted",
    ]);
  });

  it("passes an explicit project scope to claude and omits scope for codex", async () => {
    const binaries = fakeBinaries(["claude", "codex"]);
    const output = capture();
    try {
      expect(await runSetup({ client: "claude", scope: "project", majorVersion: "2", runDoctor: false })).toBe(0);
      expect(await runSetup({ client: "codex", majorVersion: "2", runDoctor: false })).toBe(0);
    } finally {
      output.restore();
    }
    expect(binaries.argv("claude")).toEqual(["mcp", "add", "imessage", "-s", "project", "--", "npx", "-y", "imessage-mcp@2"]);
    expect(binaries.argv("codex")).toEqual(["mcp", "add", "imessage", "--", "npx", "-y", "imessage-mcp@2"]);
  });

  it("removes the server through each client binary", async () => {
    const binaries = fakeBinaries(["claude", "codex"]);
    const output = capture();
    try {
      expect(await runUninstall({ client: "claude" })).toBe(0);
      expect(await runUninstall({ client: "codex" })).toBe(0);
    } finally {
      output.restore();
    }
    expect(binaries.argv("claude")).toEqual(["mcp", "remove", "imessage", "-s", "user"]);
    expect(binaries.argv("codex")).toEqual(["mcp", "remove", "imessage"]);
  });

  it("prints the exact command and succeeds when the binary is missing", async () => {
    process.env.PATH = scratch();
    const output = capture();
    let code: number;
    try {
      code = await runSetup({ client: "claude", majorVersion: "2", runDoctor: false });
    } finally {
      output.restore();
    }
    expect(code).toBe(0);
    expect(output.lines()).toContain("  claude mcp add imessage -s user -- npx -y imessage-mcp@2");
  });

  it("rejects an unknown client and an invalid privacy mode", async () => {
    await expect(runSetup({ client: "zed", majorVersion: "2", runDoctor: false })).rejects.toThrow(/--client/u);
    await expect(runSetup({ client: "claude", privacy: "everything", majorVersion: "2", runDoctor: false })).rejects.toThrow(/privacy/u);
  });
});

describe("setup and uninstall through a client configuration file", () => {
  it("merges into an existing file, backs it up, and leaves no temporary file", async () => {
    const target = clientConfig({ unrelated: { command: "node", args: ["other-server.js"] } });
    const before = readFileSync(target.file, "utf8");
    const output = capture();
    try {
      expect(await runSetup({ client: "desktop", config: target.file, majorVersion: "2", runDoctor: false })).toBe(0);
    } finally {
      output.restore();
    }

    const servers = readServers(target.file);
    expect(servers.imessage).toEqual({ command: "npx", args: ["-y", "imessage-mcp@2"] });
    expect(servers.unrelated).toEqual({ command: "node", args: ["other-server.js"] });

    const entries = readdirSync(target.directory).sort();
    expect(entries.length).toBe(2);
    expect(entries[0]).toBe("config.json");
    expect(entries[1]).toMatch(/^config\.json\.bak-\d+(?:-\d+)?$/u);
    expect(readFileSync(path.join(target.directory, entries[1]), "utf8")).toBe(before);
  });

  it("creates a cursor configuration that does not exist yet", async () => {
    const directory = scratch();
    const file = path.join(directory, "nested", "mcp.json");
    const output = capture();
    try {
      expect(await runSetup({ client: "cursor", config: file, contacts: "none", majorVersion: "2", runDoctor: false })).toBe(0);
    } finally {
      output.restore();
    }
    expect(readServers(file).imessage).toEqual({ command: "npx", args: ["-y", "imessage-mcp@2", "--contacts", "none"] });
    expect(readdirSync(path.dirname(file))).toEqual(["mcp.json"]);
  });

  it("keeps every backup at 0600 and names the ones uninstall leaves behind", async () => {
    const target = clientConfig({ unrelated: { command: "node", args: ["other-server.js"] } });
    chmodSync(target.file, 0o644);
    const output = capture();
    try {
      expect(await runSetup({ client: "cursor", config: target.file, majorVersion: "2", runDoctor: false })).toBe(0);
      expect(await runUninstall({ client: "cursor", config: target.file })).toBe(0);
    } finally {
      output.restore();
    }
    const backups = readdirSync(target.directory).filter((entry) => entry.startsWith("config.json.bak-")).sort();
    expect(backups.length).toBe(2);
    expect(lstatSync(target.file).mode & 0o777).toBe(0o600);
    for (const backup of backups) {
      expect(lstatSync(path.join(target.directory, backup)).mode & 0o777).toBe(0o600);
      expect(output.lines()).toContain(`    ${path.join(target.directory, backup)}`);
    }
  });

  it("uninstall removes only the imessage entry and keeps the rest of the file", async () => {
    const target = clientConfig({ unrelated: { command: "node", args: ["other-server.js"] } });
    const output = capture();
    try {
      await runSetup({ client: "cursor", config: target.file, majorVersion: "2", runDoctor: false });
      expect(await runUninstall({ client: "cursor", config: target.file })).toBe(0);
    } finally {
      output.restore();
    }
    const servers = readServers(target.file);
    expect(Object.keys(servers)).toEqual(["unrelated"]);
    expect(servers.unrelated).toEqual({ command: "node", args: ["other-server.js"] });
    expect(readdirSync(target.directory).filter((entry) => /^config\.json\.bak-\d+(?:-\d+)?$/u.test(entry)).length).toBe(2);
  });
});

describe("setup and uninstall without an explicit --config", () => {
  it("resolves the default file under $HOME for desktop and cursor", async () => {
    const home = scratch();
    process.env.HOME = home;
    // pgrep has to report the client as closed whatever is open on this Mac.
    const stubs = scratch();
    writeFileSync(path.join(stubs, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${stubs}:${process.env.PATH ?? ""}`;

    for (const client of ["desktop", "cursor"] as const) {
      const file = defaultConfigPath(client);
      expect(file.startsWith(`${home}${path.sep}`)).toBe(true);

      const output = capture();
      try {
        expect(await runSetup({ client, majorVersion: "2", runDoctor: false })).toBe(0);
        expect(readServers(file).imessage).toEqual({ command: "npx", args: ["-y", "imessage-mcp@2"] });
        expect(await runUninstall({ client })).toBe(0);
      } finally {
        output.restore();
      }
      expect(readServers(file).imessage).toBeUndefined();
      expect(output.lines()).toContain(`registered imessage in ${file}`);
      expect(output.lines()).toContain(`removed imessage from ${file}`);
    }
  });

  it("keeps the generated state directory under $HOME", () => {
    const home = scratch();
    process.env.HOME = home;
    delete process.env.IMESSAGE_STATE_DIR;
    expect(defaultStateDirectory()).toBe(path.join(home, "Library", "Application Support", "imessage-mcp"));
  });
});

describe("doctor --fix", () => {
  it("creates missing default files and restores owner-only modes", () => {
    const state = path.join(scratch(), "state");
    process.env.IMESSAGE_STATE_DIR = state;
    for (const name of ["IMESSAGE_REFERENCE_KEY", "IMESSAGE_REFERENCE_KEY_FILE", "IMESSAGE_DATABASE_ID", "IMESSAGE_DATABASE_ID_FILE"]) {
      delete process.env[name];
    }
    mkdirSync(state, { recursive: true, mode: 0o755 });
    chmodSync(state, 0o755);
    const referenceKey = path.join(state, "reference-key");
    writeFileSync(referenceKey, `${"k".repeat(44)}\n`, { mode: 0o644 });
    chmodSync(referenceKey, 0o644);

    const repairs = repairDefaultState(SYNTHETIC_DATABASE, "live");

    expect(lstatSync(referenceKey).mode & 0o777).toBe(0o600);
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(state, "database-id")).mode & 0o777).toBe(0o600);
    expect(readFileSync(referenceKey, "utf8")).toBe(`${"k".repeat(44)}\n`);
    expect(repairs.map((repair) => repair.name)).toEqual(["state_dir", "reference_key", "database_id", "permissions"]);
    expect(repairs.every((repair) => repair.status === "pass")).toBe(true);
  });

  it("never creates a default file for a value the environment already names", () => {
    const directory = scratch();
    const state = path.join(directory, "state");
    const pinned = path.join(directory, "pinned-reference-key");
    writeFileSync(pinned, `${"p".repeat(44)}\n`, { mode: 0o600 });
    process.env.IMESSAGE_STATE_DIR = state;
    process.env.IMESSAGE_REFERENCE_KEY_FILE = pinned;
    delete process.env.IMESSAGE_DATABASE_ID;
    delete process.env.IMESSAGE_DATABASE_ID_FILE;

    repairDefaultState(SYNTHETIC_DATABASE, "live");

    expect(readdirSync(state)).toEqual(["database-id"]);
    expect(lstatSync(pinned).mode & 0o777).toBe(0o600);
  });
});

describe("uninstall --purge", () => {
  it("requires --yes and then deletes only generated key files", async () => {
    const state = path.join(scratch(), "state");
    process.env.IMESSAGE_STATE_DIR = state;
    for (const name of ["IMESSAGE_REFERENCE_KEY", "IMESSAGE_REFERENCE_KEY_FILE", "IMESSAGE_DATABASE_ID", "IMESSAGE_DATABASE_ID_FILE"]) {
      delete process.env[name];
    }
    repairDefaultState(SYNTHETIC_DATABASE, "live");
    const target = clientConfig({});

    const first = capture();
    let refused: number;
    try {
      refused = await runUninstall({ client: "desktop", config: target.file, purge: true });
    } finally {
      first.restore();
    }
    expect(refused).toBe(1);
    expect(readdirSync(state).sort()).toEqual(["database-id", "reference-key"]);

    const second = capture();
    let purged: number;
    try {
      purged = await runUninstall({ client: "desktop", config: target.file, purge: true, yes: true });
    } finally {
      second.restore();
    }
    expect(purged).toBe(0);
    expect(existsSync(state)).toBe(false);
  });

  it("refuses to purge a pinned key file spelled through a symbolic link", async () => {
    const state = path.join(scratch(), "state");
    process.env.IMESSAGE_STATE_DIR = state;
    for (const name of ["IMESSAGE_REFERENCE_KEY", "IMESSAGE_REFERENCE_KEY_FILE", "IMESSAGE_DATABASE_ID", "IMESSAGE_DATABASE_ID_FILE"]) {
      delete process.env[name];
    }
    repairDefaultState(SYNTHETIC_DATABASE, "live");
    const referenceKey = path.join(state, "reference-key");
    // The temporary root lives under a symlinked prefix on macOS, so the two
    // spellings differ by the link alone.
    const pinned = path.join(realpathSync(state), "reference-key");
    expect(pinned).not.toBe(referenceKey);
    process.env.IMESSAGE_REFERENCE_KEY_FILE = pinned;
    const target = clientConfig({});

    const output = capture();
    let code: number;
    try {
      code = await runUninstall({ client: "cursor", config: target.file, purge: true, yes: true });
    } finally {
      output.restore();
    }
    expect(code).toBe(1);
    expect(output.lines()).toContain(`refusing to purge ${state}: a file there is named by an IMESSAGE_*_FILE variable`);
    expect(readdirSync(state).sort()).toEqual(["database-id", "reference-key"]);
  });

  it("refuses to purge a state directory holding files it did not generate", async () => {
    const state = path.join(scratch(), "state");
    process.env.IMESSAGE_STATE_DIR = state;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(state, "notes.txt"), "synthetic\n", { mode: 0o600 });
    const target = clientConfig({});

    const output = capture();
    let code: number;
    try {
      code = await runUninstall({ client: "cursor", config: target.file, purge: true, yes: true });
    } finally {
      output.restore();
    }
    expect(code).toBe(1);
    expect(readdirSync(state)).toEqual(["notes.txt"]);
  });
});
