import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ImessageMcpError } from "../src/errors.js";
import Database from "../src/sqlite.js";
import {
  assertAggregateParity,
  ParityFailure,
  runParitySafely,
  type MarkParityPhase,
} from "../scripts/live-parity-output.js";
import { createFixture, foundationAttributedBody } from "./fixture.js";

const SYNTHETIC_VALUE = "synthetic-private-probe@example.invalid";
const SYNTHETIC_PATH = "/synthetic-private-home/Library/Messages/chat.db";

function capture() {
  const lines = { stdout: "", stderr: "" };
  const output = {
    stdout: (line: string) => { lines.stdout += line; },
    stderr: (line: string) => { lines.stderr += line; },
  };
  return { lines, output };
}

async function failed(
  operation: (markPhase: MarkParityPhase) => Promise<Record<string, unknown>>,
) {
  const { lines, output } = capture();
  expect(await runParitySafely(operation, output)).toBe(1);
  expect(lines.stdout).toBe("");
  expect(lines.stderr.split("\n")).toHaveLength(2);
  expect(lines.stderr).not.toContain(SYNTHETIC_VALUE);
  expect(lines.stderr).not.toContain(SYNTHETIC_PATH);
  const payload = JSON.parse(lines.stderr);
  expect(Object.keys(payload).sort()).toEqual(["phase", "private_values_emitted", "reason", "status"]);
  expect(payload).toMatchObject({ status: "failed", private_values_emitted: 0 });
  return payload;
}

describe("value-silent release parity failures", () => {
  it("preserves the counts-only success summary", async () => {
    const { lines, output } = capture();
    const summary = {
      source: "copied_mac_chat_db", readonly: "passed", schema: "available",
      exact_parity: { sampled: 2, matched: 2, mismatched: 0 },
      service_families: ["imessage"], contacts: "unavailable",
      tool_parity: { tools: 7, aggregate_leaks: 0, duration_ms: { search_messages: 4 } },
      private_values_emitted: 0,
    };
    expect(await runParitySafely(async () => summary, output)).toBe(0);
    expect(JSON.parse(lines.stdout)).toEqual(summary);
    expect(lines.stderr).toBe("");
  });

  it("does not forward a native assertion's serialized aggregate payload", async () => {
    const payload = await failed(async (markPhase) => {
      markPhase("aggregate_privacy");
      assert.doesNotMatch(JSON.stringify({
        chat_ids: [42], private_handle: SYNTHETIC_VALUE, private_path: SYNTHETIC_PATH,
      }), /chat_ids/u);
      return {};
    });
    expect(payload).toMatchObject({ phase: "aggregate_privacy", reason: "PARITY_FAILED" });
  });

  it("allowlists the reason without forwarding SQLite paths, details or stacks", async () => {
    const payload = await failed(async (markPhase) => {
      markPhase("source");
      throw new ImessageMcpError("DATABASE_UNAVAILABLE", SYNTHETIC_PATH, {
        handle: SYNTHETIC_VALUE, filename: SYNTHETIC_PATH,
      });
    });
    expect(payload).toMatchObject({ phase: "source", reason: "DATABASE_UNAVAILABLE" });
  });

  it("does not serialize thrown objects or their toJSON implementations", async () => {
    const payload = await failed(async (markPhase) => {
      markPhase("tool_search_messages");
      throw { private_value: SYNTHETIC_VALUE, toJSON: () => SYNTHETIC_PATH };
    });
    expect(payload).toMatchObject({ phase: "tool_search_messages", reason: "PARITY_FAILED" });
  });

  it("fails safely if an error object's reason accessor itself throws", async () => {
    const payload = await failed(async () => {
      const error = new ImessageMcpError("DATABASE_UNAVAILABLE", SYNTHETIC_VALUE);
      Object.defineProperty(error, "reason", { get: () => { throw new Error(SYNTHETIC_PATH); } });
      throw error;
    });
    expect(payload.reason).toBe("PARITY_FAILED");
  });

  it("uses a stable reason for an unexpected error and an untrusted phase", async () => {
    const payload = await failed(async (markPhase) => {
      markPhase(SYNTHETIC_VALUE as Parameters<MarkParityPhase>[0]);
      const error = new ParityFailure("TOOL_FAILED");
      Object.assign(error, { reason: SYNTHETIC_VALUE });
      throw error;
    });
    expect(payload).toMatchObject({ phase: "source", reason: "PARITY_FAILED" });
  });

  it("does not expose the original error when the diagnostic stream is closed", async () => {
    const result = await runParitySafely(async () => { throw new Error(SYNTHETIC_VALUE); }, {
      stdout: () => { throw new Error(SYNTHETIC_PATH); },
      stderr: () => { throw new Error(SYNTHETIC_PATH); },
    });
    expect(result).toBe(1);
  });
});

describe("aggregate release parity contract", () => {
  it.each([
    "message_id", "chat_id", "attachment_id", "chat_ids", "previous_chat_ids",
    "conversation_ids", "parent_message_id", "reply_to_message_id", "around_message_id",
  ])("rejects nested %s without forwarding the serialized result", async (field) => {
    const payload = await failed(async (markPhase) => {
      markPhase("aggregate_privacy");
      assertAggregateParity([{ data: { nested: { [field]: [123], other: SYNTHETIC_VALUE } } }], SYNTHETIC_VALUE);
      return {};
    });
    expect(payload).toMatchObject({ phase: "aggregate_privacy", reason: "AGGREGATE_PRIVACY_FAILED" });
  });

  it("rejects the private probe even under an otherwise permitted key", async () => {
    const payload = await failed(async (markPhase) => {
      markPhase("aggregate_privacy");
      assertAggregateParity([{ data: { unexpected: SYNTHETIC_VALUE } }], SYNTHETIC_VALUE);
      return {};
    });
    expect(payload.reason).toBe("AGGREGATE_PRIVACY_FAILED");
  });

  it("rejects a retained query without forwarding its value", async () => {
    const payload = await failed(async (markPhase) => {
      markPhase("aggregate_privacy");
      assertAggregateParity([{ effective_scope: { query: SYNTHETIC_PATH } }], SYNTHETIC_VALUE);
      return {};
    });
    expect(payload.reason).toBe("AGGREGATE_PRIVACY_FAILED");
  });

  it("accepts aggregate counts and safe capability metadata", () => {
    expect(() => assertAggregateParity([{
      data: { total_messages: 20, shared_messages: 2, schema_capabilities: { tables: { message: ["ROWID"] } } },
    }], SYNTHETIC_VALUE)).not.toThrow();
  });
});

function runSyntheticCli(databasePath: string) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/live-parity.ts"], {
    cwd: root,
    env: {
      ...process.env, IMESSAGE_PARITY_DB: databasePath, IMESSAGE_UPDATE_CHECK: "0", NODE_NO_WARNINGS: "1",
    },
    encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
  });
}

describe("synthetic release parity CLI", () => {
  it("covers database startup errors before any real owner database is accessed", () => {
    const result = runSyntheticCli(path.join("/synthetic-private-home", "missing-chat.db"));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      status: "failed", phase: "source", reason: "DATABASE_UNAVAILABLE", private_values_emitted: 0,
    });
    expect(result.stderr).not.toContain("synthetic-private-home");
  });

  it("reports a decoder mismatch without printing synthetic message text or archive paths", () => {
    const fixture = createFixture();
    try {
      const db = new Database(fixture.databasePath);
      try {
        db.prepare("UPDATE message SET text = ?, attributedBody = ? WHERE ROWID = 1")
          .run(SYNTHETIC_VALUE, foundationAttributedBody("different synthetic archive text"));
      } finally { db.close(); }
      const result = runSyntheticCli(fixture.databasePath);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        status: "failed", phase: "decoding", reason: "DECODE_PARITY_FAILED", private_values_emitted: 0,
      });
      expect(result.stderr).not.toContain(SYNTHETIC_VALUE);
      expect(result.stderr).not.toContain(fixture.databasePath);
    } finally { fixture.cleanup(); }
  });

  it("retains the successful tool parity probe with only synthetic database reads", () => {
    const fixture = createFixture();
    try {
      const db = new Database(fixture.databasePath);
      try {
        db.prepare("UPDATE message SET text = ?, attributedBody = ? WHERE ROWID = 1")
          .run(SYNTHETIC_VALUE, foundationAttributedBody(SYNTHETIC_VALUE));
      } finally { db.close(); }
      const result = runSyntheticCli(fixture.databasePath);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const summary = JSON.parse(result.stdout);
      expect(summary).toMatchObject({
        source: "copied_mac_chat_db", readonly: "passed", schema: "available",
        exact_parity: { sampled: 1, matched: 1, mismatched: 0 },
        tool_parity: { tools: 7, aggregate_leaks: 0 }, private_values_emitted: 0,
      });
      expect(result.stdout).not.toContain(SYNTHETIC_VALUE);
      expect(result.stdout).not.toContain(fixture.databasePath);
    } finally { fixture.cleanup(); }
  });
});
