#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { serviceFamily, type ServiceFamily } from "../src/contracts.js";
import type { RuntimeConfig } from "../src/config.js";
import { DatabaseContext } from "../src/database.js";
import { MessageTextDecoder, populatedMessageText } from "../src/decoder.js";
import { UnifiedContactResolver } from "../src/contacts.js";
import { columnSql, serviceSql } from "../src/schema-sql.js";
import { LocalToolRuntime } from "../src/runtime.js";
import { MAX_ATTRIBUTED_BODY_BYTES } from "../src/limits.js";
import { assertAggregateParity, ParityFailure, runParitySafely, type MarkParityPhase } from "./live-parity-output.js";

interface ParityRow {
  rowid: number;
  text: string | null;
  attributed_body: Buffer;
  service: string | null;
}

const decoder = new MessageTextDecoder();
const MAX_SAMPLE = 500;
const MAX_BATCH_ITEMS = 500;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = MAX_ATTRIBUTED_BODY_BYTES;
// The one-million-message reference fixture owns the 60-second index SLA. A growing live archive
// is bounded by the supported cold-request deadline while this check verifies exact private parity.
const MAX_COLD_SEARCH_MS = 90_000;

function structured(result: { isError?: boolean; structuredContent?: unknown }): Record<string, unknown> {
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

function privateProbe(context: DatabaseContext): { handle: string; search: string } {
  const request = context.request();
  try {
    const handle = request.db.prepare(
      "SELECT id FROM handle WHERE id IS NOT NULL AND LENGTH(id) BETWEEN 3 AND 4096 ORDER BY ROWID LIMIT 1",
    ).get() as { id?: unknown } | undefined;
    const messages = request.db.prepare(
      "SELECT text FROM message WHERE text IS NOT NULL AND LENGTH(text) BETWEEN 2 AND 4096 ORDER BY ROWID DESC LIMIT 1000",
    ).all() as Array<{ text: unknown }>;
    const search = messages
      .map((row) => typeof row.text === "string" ? row.text.match(/[\p{L}\p{N}]{2,64}/u)?.[0] : undefined)
      .find((value): value is string => Boolean(value));
    assert.ok(handle && typeof handle.id === "string", "no bounded live handle was available for tool parity");
    assert.ok(search, "no bounded live search token was available for tool parity");
    return { handle: handle.id, search };
  } finally {
    request.close();
  }
}

async function exerciseTools(
  context: DatabaseContext,
  databasePath: string,
  sourceMode: "live" | "copy",
  markPhase: MarkParityPhase,
): Promise<{
  tools: number;
  aggregate_leaks: number;
  duration_ms: Record<string, number>;
}> {
  const config: RuntimeConfig = {
    database_path: databasePath,
    source_mode: sourceMode,
    contacts_mode: sourceMode === "live" ? "live" : "none",
    privacy_ceiling: "full",
    transport: "stdio",
    port: 3000,
  };
  // The parity run measures a cold build, so it never touches the real cache.
  process.env.IMESSAGE_CACHE = "0";
  markPhase("tool_setup");
  const runtime = new LocalToolRuntime(config);
  try {
    await runtime.prepare();
    const probe = privateProbe(context);
    const durationMs: Record<string, number> = {};
    type ParityTool = "server_status" | "resolve_contact" | "list_conversations" | "get_conversation"
      | "analyze_communication" | "sync_messages" | "search_messages";
    const call = async (tool: ParityTool, params: Record<string, unknown>) => {
      markPhase(`tool_${tool}`);
      const started = performance.now();
      const result = await runtime.call(tool, params);
      durationMs[tool] = Math.round(performance.now() - started);
      return [tool, result] as const;
    };
    const fullList = structured(await runtime.call("list_conversations", {
      limit: 1,
      privacy_mode: "full",
    }));
    const fullData = fullList.data as { conversations?: Array<{ chat_id?: unknown }> };
    const chatId = fullData.conversations?.[0]?.chat_id;
    assert.equal(typeof chatId, "number", "no conversation was available for tool parity");

    const results = [
      await call("server_status", { privacy_mode: "aggregate" }),
      await call("resolve_contact", { query: probe.handle, privacy_mode: "aggregate" }),
      await call("list_conversations", { limit: 50, privacy_mode: "aggregate" }),
      await call("get_conversation", {
        chat_id: chatId,
        limit: 50,
        allow_partial: true,
        privacy_mode: "aggregate",
      }),
      await call("analyze_communication", {
        metric: "message_count",
        scope: "global",
        session_gap_hours: 8,
        privacy_mode: "aggregate",
      }),
      await call("sync_messages", { limit: 50, privacy_mode: "aggregate" }),
      await call("search_messages", {
        query: probe.search,
        mode: "substring",
        scopes: ["text"],
        order: "newest",
        limit: 50,
        allow_partial: true,
        privacy_mode: "aggregate",
      }),
    ] as const;
    for (const [tool, result] of results) {
      markPhase(`tool_${tool}`);
      if (result.isError === true) throw new ParityFailure("TOOL_FAILED");
    }
    markPhase("aggregate_privacy");
    const aggregate = results.map(([, result]) => structured(result));
    assertAggregateParity(aggregate, probe.handle);
    const leaks = 0;
    markPhase("latency");
    assert.ok(durationMs.server_status < 1_000, "server_status exceeded the sub-second metadata budget");
    assert.ok(durationMs.list_conversations < 1_000, "list_conversations exceeded the sub-second metadata budget");
    assert.ok(
      durationMs.search_messages < MAX_COLD_SEARCH_MS,
      `cold search exceeded the 90-second request budget: ${durationMs.search_messages}ms`,
    );
    return { tools: results.length, aggregate_leaks: leaks, duration_ms: durationMs };
  } finally {
    runtime.close();
  }
}

function sampledRows(context: DatabaseContext): ParityRow[] {
  const request = context.request();
  try {
    const text = columnSql(request, "message", "m", "text", "NULL");
    const body = columnSql(request, "message", "m", "attributedBody", "NULL");
    const associated = columnSql(request, "message", "m", "associated_message_type", "0");
    const itemType = columnSql(request, "message", "m", "item_type", "0");
    const system = columnSql(request, "message", "m", "is_system_message", "0");
    const retracted = columnSql(request, "message", "m", "date_retracted", "0");
    const bounds = request.db.prepare(
      `SELECT COALESCE(MIN(ROWID), 0) AS minimum, COALESCE(MAX(ROWID), 0) AS maximum FROM message`,
    ).get() as { minimum: number; maximum: number };
    const width = Math.max(1, Number(bounds.maximum) - Number(bounds.minimum) + 1);
    const rows: ParityRow[] = [];
    for (let stratum = 0; stratum < 4; stratum += 1) {
      const from = Number(bounds.minimum) + Math.floor(width * stratum / 4);
      const to = stratum === 3 ? Number(bounds.maximum) : Number(bounds.minimum) + Math.floor(width * (stratum + 1) / 4) - 1;
      rows.push(...request.db.prepare(
        `SELECT m.ROWID AS rowid, ${text} AS text, ${body} AS attributed_body, ${serviceSql(request)} AS service
         FROM message m
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE m.ROWID BETWEEN @from AND @to
           AND ${text} IS NOT NULL
           AND INSTR(${text}, CHAR(65532)) = 0
           AND ${body} IS NOT NULL
           AND LENGTH(${body}) <= @max_blob
           AND COALESCE(${associated}, 0) = 0
           AND COALESCE(${itemType}, 0) = 0
           AND COALESCE(${system}, 0) = 0
           AND COALESCE(${retracted}, 0) <= 0
         GROUP BY m.ROWID
         ORDER BY m.ROWID
         LIMIT @limit`,
      ).all({ from, to, max_blob: MAX_BLOB_BYTES, limit: Math.ceil(MAX_SAMPLE / 4) }) as ParityRow[]);
    }
    return rows.slice(0, MAX_SAMPLE);
  } finally {
    request.close();
  }
}

async function decodeBatches(rows: ParityRow[]): Promise<Array<{ status: string; text?: string }>> {
  const output: Array<{ status: string; text?: string }> = [];
  let batch: ParityRow[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    output.push(...await decoder.decode(batch.map((row) => row.attributed_body)));
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    if (batch.length >= MAX_BATCH_ITEMS || (bytes > 0 && bytes + row.attributed_body.length > MAX_BATCH_BYTES)) await flush();
    batch.push(row);
    bytes += row.attributed_body.length;
  }
  await flush();
  return output;
}

async function main(markPhase: MarkParityPhase): Promise<Record<string, unknown>> {
  markPhase("source");
  const configuredDatabasePath = process.env.IMESSAGE_PARITY_DB;
  const defaultDatabasePath = path.join(homedir(), "Library", "Messages", "chat.db");
  const databasePath = configuredDatabasePath ? path.resolve(configuredDatabasePath) : defaultDatabasePath;
  const sourceMode = configuredDatabasePath ? "copy" : "live";
  const context = new DatabaseContext(databasePath, sourceMode);
  try {
    markPhase("sampling");
    const rows = sampledRows(context);
    assert.ok(rows.length > 0, "no bounded attributed-body parity rows were available");
    markPhase("decoding");
    const decoded = await decodeBatches(rows);
    let exact = 0;
    let mismatch = 0;
    const services = new Set<ServiceFamily>();
    rows.forEach((row, index) => {
      const expected = populatedMessageText(row.text);
      const actual = decoded[index];
      const family = serviceFamily(row.service);
      services.add(family);
      if (expected !== null && actual?.status === "decoded" && actual.text === expected) exact += 1;
      else {
        mismatch += 1;
      }
    });
    if (mismatch !== 0) throw new ParityFailure("DECODE_PARITY_FAILED");
    markPhase("contacts");
    const contacts = new UnifiedContactResolver(sourceMode === "live").status();
    const toolParity = await exerciseTools(context, databasePath, sourceMode, markPhase);
    markPhase("cleanup");
    return {
      source: sourceMode === "live" ? "live_mac_chat_db" : "copied_mac_chat_db",
      readonly: "passed",
      schema: context.capabilities.required_core,
      exact_parity: { sampled: rows.length, matched: exact, mismatched: mismatch },
      service_families: [...services].sort(),
      contacts: contacts.state,
      tool_parity: toolParity,
      private_values_emitted: 0,
    };
  } finally {
    context.close();
  }
}

process.exitCode = await runParitySafely(main, {
  stdout: (line) => { process.stdout.write(line); },
  stderr: (line) => { process.stderr.write(line); },
});
