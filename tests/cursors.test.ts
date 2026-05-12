import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let cursors: typeof import("../src/cursors.js");

describe("cursor persistence", () => {
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imessage-mcp-cursors-"));
    process.env.IMESSAGE_CURSOR_FILE = path.join(dir, "cursors.json");
    cursors = await import("../src/cursors.js");
  });

  it("set/get cursor round-trips values", () => {
    cursors.setCursor("ns1", 123);
    expect(cursors.getCursor("ns1")).toBe(123);
  });

  it("resetCursor removes a namespace", () => {
    cursors.setCursor("ns2", 999);
    expect(cursors.getCursor("ns2")).toBe(999);
    cursors.resetCursor("ns2");
    expect(cursors.getCursor("ns2")).toBeNull();
  });

  it("listCursors returns stored namespaces", () => {
    cursors.setCursor("ns3", 7);
    const all = cursors.listCursors();
    expect(all.ns3).toBe(7);
  });
});

