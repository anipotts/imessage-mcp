import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { databaseIdFileName, resolveDatabaseId, resolveReferenceKey, stateDirectory } from "../src/keys.js";

const SECRET_VARIABLES = [
  "IMESSAGE_STATE_DIR",
  "IMESSAGE_REFERENCE_KEY",
  "IMESSAGE_REFERENCE_KEY_FILE",
  "IMESSAGE_DATABASE_ID",
  "IMESSAGE_DATABASE_ID_FILE",
] as const;

const original = new Map(SECRET_VARIABLES.map((name) => [name, process.env[name]]));
const directories: string[] = [];

function scratchState(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-state-test-"));
  directories.push(directory);
  process.env.IMESSAGE_STATE_DIR = path.join(directory, "state");
  for (const name of SECRET_VARIABLES.slice(1)) delete process.env[name];
  return process.env.IMESSAGE_STATE_DIR;
}

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe("zero-config state directory", () => {
  it("generates both values on first run and reuses them afterwards", () => {
    const state = scratchState();
    const database = "/Users/synthetic/Library/Messages/chat.db";
    const firstKey = resolveReferenceKey();
    const firstId = resolveDatabaseId(database, "live");

    expect(firstKey.source).toBe("default file");
    expect(firstId.source).toBe("default file");
    expect(firstKey.value.equals(firstId.value)).toBe(false);
    expect(lstatSync(path.join(state, "reference-key")).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(state, "database-id")).mode & 0o777).toBe(0o600);
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    expect(readdirSync(state).sort()).toEqual(["database-id", "reference-key"]);

    const secondKey = resolveReferenceKey();
    const secondId = resolveDatabaseId(database, "live");
    expect(secondKey.value.equals(firstKey.value)).toBe(true);
    expect(secondId.value.equals(firstId.value)).toBe(true);
    expect(secondKey.source).toBe("default file");
  });

  it("rejects a default file that is not owner-only", () => {
    const state = scratchState();
    resolveReferenceKey();
    chmodSync(path.join(state, "reference-key"), 0o644);
    expect(() => resolveReferenceKey()).toThrow(/0600/u);
  });

  it("keeps a copied database on its own generated lineage", () => {
    const state = scratchState();
    const copy = path.join(state, "..", "synthetic-copy.db");
    const resolved = resolveDatabaseId(copy, "copy");
    const expected = databaseIdFileName(copy, "copy");

    expect(expected).toMatch(/^database-id-[0-9a-f]{16}$/u);
    expect(readdirSync(state)).toEqual([expected]);
    expect(lstatSync(path.join(state, expected)).mode & 0o777).toBe(0o600);
    expect(resolveDatabaseId(copy, "copy").value.equals(resolved.value)).toBe(true);
    expect(databaseIdFileName(copy, "copy")).not.toBe(databaseIdFileName(`${copy}-other`, "copy"));
  });

  it("prefers an explicit environment source over the default file", () => {
    const state = scratchState();
    const generated = resolveReferenceKey().value;
    const pinnedFile = path.join(state, "pinned-reference-key");
    writeFileSync(pinnedFile, `${"p".repeat(44)}\n`, { mode: 0o600 });

    process.env.IMESSAGE_REFERENCE_KEY_FILE = pinnedFile;
    const fromFile = resolveReferenceKey();
    expect(fromFile.source).toBe("environment file");
    expect(fromFile.value.toString("utf8")).toBe("p".repeat(44));

    delete process.env.IMESSAGE_REFERENCE_KEY_FILE;
    process.env.IMESSAGE_REFERENCE_KEY = "d".repeat(44);
    const fromEnvironment = resolveReferenceKey();
    expect(fromEnvironment.source).toBe("environment");
    expect(fromEnvironment.value.toString("utf8")).toBe("d".repeat(44));
    expect(fromEnvironment.value.equals(generated)).toBe(false);
  });

  it("resolves the state directory from IMESSAGE_STATE_DIR only when it is set", () => {
    const state = scratchState();
    expect(stateDirectory()).toBe(state);
    delete process.env.IMESSAGE_STATE_DIR;
    expect(stateDirectory()).toMatch(/Library\/Application Support\/imessage-mcp$/u);
  });
});
