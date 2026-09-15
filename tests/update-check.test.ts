import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseContext, FULL_DISK_ACCESS_MESSAGE, openReadonlyDatabase } from "../src/database.js";
import { checkForUpdate, isNewer, LATEST_BUNDLE_URL, resetUpdateCheckForTests } from "../src/update-check.js";

const enabled = { IMESSAGE_UPDATE_CHECK: "1" };
const registry = (body: unknown, init: ResponseInit = { status: 200 }) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), init));

describe("update check", () => {
  afterEach(() => resetUpdateCheckForTests());

  it("compares stable versions numerically and never downgrades a prerelease", () => {
    expect(isNewer("2.1.10", "2.1.9")).toBe(true);
    expect(isNewer("2.1.2", "2.1.2")).toBe(false);
    expect(isNewer("2.1.1", "2.2.0")).toBe(false);
    expect(isNewer("3.0.0", "2.9.9")).toBe(true);
    expect(isNewer("2.1.2", "2.2.0-rc.1")).toBe(false);
    expect(isNewer("latest", "2.1.2")).toBe(false);
  });

  it("reports an available release with where to get it, and caches the lookup", async () => {
    const fetch = registry({ name: "imessage-mcp", version: "2.2.0" });
    const first = await checkForUpdate("2.1.3", { env: enabled, fetch });
    expect(first).toEqual({
      status: "available",
      current_version: "2.1.3",
      latest_version: "2.2.0",
      download_url: LATEST_BUNDLE_URL,
      how_to_update: expect.stringContaining("restart the client"),
    });
    expect((await checkForUpdate("2.1.3", { env: enabled, fetch })).status).toBe("available");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/imessage-mcp/latest", expect.anything());
  });

  it("reports current when the running version is the latest", async () => {
    const state = await checkForUpdate("2.2.0", { env: enabled, fetch: registry({ version: "2.2.0" }) });
    expect(state).toEqual({ status: "current", current_version: "2.2.0", latest_version: "2.2.0" });
  });

  it.each([
    ["an HTTP error", registry({ version: "9.9.9" }, { status: 503 })],
    ["malformed JSON", registry("{not json")],
    ["a non-version value", registry({ version: "9.9.9; rm -rf /" })],
    ["an oversized body", registry({ version: "9.9.9", padding: "x".repeat(300 * 1024) })],
    ["a network failure", vi.fn(async () => { throw new TypeError("fetch failed"); })],
  ])("reports unknown on %s", async (_label, fetch) => {
    expect(await checkForUpdate("2.1.3", { env: enabled, fetch })).toEqual({ status: "unknown", current_version: "2.1.3" });
  });

  it("makes no request when disabled", async () => {
    const fetch = registry({ version: "9.9.9" });
    expect(await checkForUpdate("2.1.3", { env: { IMESSAGE_UPDATE_CHECK: "0" }, fetch })).toEqual({
      status: "disabled",
      current_version: "2.1.3",
    });
    expect((await checkForUpdate("2.1.3", { env: { IMESSAGE_UPDATE_CHECK: "false" }, fetch })).status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not hold a tool on a slow registry and reads the answer on the next call", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    expect((await checkForUpdate("2.1.3", { env: enabled, fetch, waitMs: 10 })).status).toBe("unknown");
    release(new Response(JSON.stringify({ version: "2.2.0" })));
    await vi.waitFor(async () => {
      expect((await checkForUpdate("2.1.3", { env: enabled, fetch, waitMs: 10 })).status).toBe("available");
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("blocked Messages access", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const blocked = () => {
    const root = mkdtempSync(path.join(tmpdir(), "imessage-mcp-blocked-"));
    const messages = path.join(root, "Messages");
    mkdirSync(messages);
    writeFileSync(path.join(messages, "chat.db"), "");
    chmodSync(messages, 0o000);
    directories.push(messages, root);
    return path.join(messages, "chat.db");
  };

  it("names the Full Disk Access fix instead of reporting a missing database", () => {
    const databasePath = blocked();
    expect(() => openReadonlyDatabase(databasePath)).toThrow(FULL_DISK_ACCESS_MESSAGE);
    expect(() => new DatabaseContext(databasePath, Buffer.alloc(32, 1), Buffer.alloc(32, 2), "copy"))
      .toThrow(FULL_DISK_ACCESS_MESSAGE);
    expect(FULL_DISK_ACCESS_MESSAGE).toContain("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
  });

  it("still reports a database that does not exist as missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "imessage-mcp-missing-"));
    directories.push(root);
    expect(() => openReadonlyDatabase(path.join(root, "chat.db"))).toThrow(/was not found/u);
  });
});
