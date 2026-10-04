import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "../src/sqlite.js";
import { DatabaseContext } from "../src/database.js";
import { analyze, type AnalyticsResult, type AnalyticsScope, type Metric } from "../src/repositories/analytics.js";
import { compileDateBounds, type DateBounds } from "../src/time.js";
import { appleNanoseconds } from "./fixture.js";

const fixtures: Array<{ context: DatabaseContext; directory: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.context.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// No live Messages data or Foundation decoding is needed: a linked component
// [1, 2] shares records with independent conversation 3. The same contact also
// participates in group 4, while conversation 5 belongs to someone else.
function createMembershipFixture(options: { lookup?: boolean; services?: boolean } = {}): DatabaseContext {
  const directory = mkdtempSync(path.join(tmpdir(), "imessage-mcp-analytics-memberships-"));
  const databasePath = path.join(directory, "chat.db");
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, style INTEGER, service_name TEXT);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (
        chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id)
      );
      CREATE INDEX chat_message_join_message ON chat_message_join(message_id);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, handle_id INTEGER, date INTEGER,
        is_from_me INTEGER, service TEXT, associated_message_type INTEGER DEFAULT 0,
        item_type INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0
      );
      CREATE TABLE chat_lookup (identifier TEXT NOT NULL, domain TEXT NOT NULL, chat INTEGER);
      INSERT INTO handle VALUES (1, '+15550000001'), (2, '+15550000002'), (3, '+15550000003');
      INSERT INTO chat VALUES
        (1, 'direct-imessage', 45, 'iMessage'), (2, 'direct-sms', 45, 'SMS'),
        (3, 'independent-rcs', 45, 'RCS'), (4, 'group-rcs', 43, 'RCS'),
        (5, 'other-contact', 45, 'SatelliteRelay');
      INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (3, 1), (4, 1), (4, 2), (5, 3);
      INSERT INTO chat_lookup VALUES ('linked-contact', 'iMessage', 1), ('linked-contact', 'SMS', 2);
    `);
    const insert = db.prepare(`
      INSERT INTO message (ROWID, guid, handle_id, date, is_from_me, service,
        associated_message_type, item_type, is_system_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows: Array<[number, string, number, string | null, number, number, number]> = [
      [1, "2026-03-08T10:00:00Z", 0, null, 0, 0, 0],
      [2, "2026-03-08T10:10:00Z", 1, "SMS", 0, 0, 0],
      [3, "2026-03-08T10:20:00Z", 1, "RCS", 0, 0, 0],
      [4, "2026-03-09T11:00:00Z", 0, null, 0, 0, 0],
      [5, "2026-03-09T11:05:00Z", 1, "RCS", 0, 0, 0],
      [6, "2026-03-09T11:10:00Z", 0, null, 2000, 0, 0],
      [7, "2026-03-09T11:15:00Z", 0, "RCS", 0, 1, 1],
      [8, "2026-03-10T12:00:00Z", 0, "RCS", 0, 0, 0],
      [9, "2026-03-10T12:05:00Z", 1, "SatelliteRelay", 0, 0, 0],
      // No recorded membership: diagnostics cover such records separately.
      [10, "2026-03-10T12:10:00Z", 0, "iMessage", 0, 0, 0],
    ];
    for (const [id, date, fromMe, service, reaction, item, system] of rows) {
      insert.run(id, `message-${id}`, fromMe ? null : 1, appleNanoseconds(date), fromMe, service, reaction, item, system);
    }
    db.exec(`
      INSERT INTO chat_message_join VALUES
        (1, 1), (3, 1), (1, 2), (2, 2), (3, 3), (2, 4), (1, 5),
        (1, 6), (2, 6), (3, 6), (1, 7), (3, 7), (4, 8), (5, 9);
    `);
    if (options.lookup === false) db.exec("DROP TABLE chat_lookup");
    if (options.services === false) {
      db.exec("ALTER TABLE message DROP COLUMN service");
      db.exec("ALTER TABLE chat DROP COLUMN service_name");
    }
  } finally {
    db.close();
  }
  const context = new DatabaseContext(databasePath);
  fixtures.push({ context, directory });
  return context;
}

function analytics(
  context: DatabaseContext,
  metric: Metric = "message_count",
  scope: AnalyticsScope = { kind: "global" },
  bounds: DateBounds = compileDateBounds({ timezone: "UTC" }),
): AnalyticsResult {
  return analyze({ context, metric, scope, bounds, sessionGapHours: 8 });
}

function assertPartitionTotals(result: AnalyticsResult): void {
  for (const field of ["messages", "sent", "received", "reaction_events", "system_events"]) {
    expect(result.service_partitions.reduce((total, partition) => total + Number(partition[field]), 0)).toBe(result.overall[field]);
  }
}

describe("analytics with many-to-many conversation membership", () => {
  it("counts unique records globally without inflating events, hours or weekdays", () => {
    const result = analytics(createMembershipFixture());
    expect(result.overall).toMatchObject({ messages: 7, sent: 4, received: 3, reaction_events: 1, system_events: 1 });
    expect((result.overall.by_hour as number[]).reduce((total, count) => total + count, 0)).toBe(7);
    expect(Object.values(result.overall.by_weekday as Record<string, number>).reduce((total, count) => total + count, 0)).toBe(7);
    expect(result.overall.by_weekday).toEqual({ mon: 2, tue: 2, wed: 0, thu: 0, fri: 0, sat: 0, sun: 3 });
    expect(result.applied_parameters).toMatchObject({
      counting_unit: "unique_message",
      shared_membership_policy: "deduplicate_within_requested_scope",
      shared_messages_in_scope: 3,
    });
    expect(result.formula).toContain("unique user message records with recorded chat membership");
    assertPartitionTotals(result);
  });

  it("deduplicates overlapping contact conversations and normalizes the contact handle", () => {
    const context = createMembershipFixture();
    const exact = analytics(context, "message_count", { kind: "contact", handles: ["+15550000001"] });
    const formatted = analytics(context, "message_count", { kind: "contact", handles: ["+1 (555) 000-0001", "+15550000001"] });
    expect(exact.overall).toMatchObject({ messages: 6, sent: 3, received: 3, reaction_events: 1, system_events: 1 });
    expect(formatted.overall).toEqual(exact.overall);
    expect(formatted.service_partitions).toEqual(exact.service_partitions);
    expect(exact.applied_parameters.shared_messages_in_scope).toBe(3);
    assertPartitionTotals(exact);
  });

  it("preserves shared records in each selected conversation and deduplicates linked variants", () => {
    const context = createMembershipFixture();
    const linked = analytics(context, "message_count", { kind: "conversation", chatIds: [1, 2] });
    const independent = analytics(context, "message_count", { kind: "conversation", chatIds: [3] });
    expect(linked.overall).toMatchObject({ messages: 4, sent: 2, received: 2, reaction_events: 1, system_events: 1 });
    expect(independent.overall).toMatchObject({ messages: 2, sent: 1, received: 1, reaction_events: 1, system_events: 1 });
    expect(linked.applied_parameters.shared_messages_in_scope).toBe(0);
    expect(independent.applied_parameters.shared_messages_in_scope).toBe(0);
    // Distinct conversation totals overlap. Selecting their union counts each
    // underlying record once rather than choosing a global owner for it.
    const combined = analytics(context, "message_count", { kind: "conversation", chatIds: [1, 2, 3] });
    expect(combined.overall).toMatchObject({ messages: 5, reaction_events: 1, system_events: 1 });
    expect(combined.applied_parameters.shared_messages_in_scope).toBe(3);
    assertPartitionTotals(linked);
    assertPartitionTotals(independent);
    assertPartitionTotals(combined);
  });

  it("uses unknown for conflicting fallback services globally while respecting scoped evidence", () => {
    const context = createMembershipFixture();
    const global = analytics(context);
    expect(global.service_partitions).toEqual([
      { service_family: "rcs", messages: 3, sent: 2, received: 1, reaction_events: 0, system_events: 1 },
      { service_family: "sms", messages: 2, sent: 1, received: 1, reaction_events: 0, system_events: 0 },
      { service_family: "unknown", messages: 2, sent: 1, received: 1, reaction_events: 1, system_events: 0 },
    ]);
    const linked = analytics(context, "message_count", { kind: "conversation", chatIds: [1, 2] });
    expect(linked.service_partitions.find((partition) => partition.service_family === "imessage")).toMatchObject({ messages: 1, received: 1 });
    const independent = analytics(context, "message_count", { kind: "conversation", chatIds: [3] });
    expect(independent.service_partitions).toEqual([
      { service_family: "rcs", messages: 2, sent: 1, received: 1, reaction_events: 1, system_events: 1 },
    ]);
    assertPartitionTotals(global);
  });

  it("applies date bounds before counting shared records and hourly activity", () => {
    const bounds = compileDateBounds({ date_from: "2026-03-08", date_to: "2026-03-08", timezone: "UTC" });
    const result = analytics(createMembershipFixture(), "message_count", { kind: "global" }, bounds);
    expect(result.overall).toMatchObject({ messages: 3, sent: 2, received: 1, reaction_events: 0, system_events: 0 });
    expect((result.overall.by_hour as number[])[10]).toBe(3);
    expect(result.overall.by_weekday).toEqual({ mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 3 });
    expect(result.applied_parameters.shared_messages_in_scope).toBe(1);
    assertPartitionTotals(result);
  });

  it("calculates response pairs and sessions independently per conversation", () => {
    const context = createMembershipFixture();
    const bounds = compileDateBounds({ date_from: "2026-03-08", date_to: "2026-03-08", timezone: "UTC" });
    const global = analytics(context, "response_time", { kind: "global" }, bounds);
    expect(global.overall).toMatchObject({ samples: 2, average_seconds: 900, my_average_seconds: 900 });
    expect(global.service_partitions).toEqual([
      { service_family: "rcs", samples: 1, average_seconds: 1200, my_average_seconds: 1200, their_average_seconds: null },
      { service_family: "sms", samples: 1, average_seconds: 600, my_average_seconds: 600, their_average_seconds: null },
    ]);
    const contact = analytics(context, "response_time", { kind: "contact", handles: ["+15550000001"] }, bounds);
    expect(contact.overall).toEqual(global.overall);
    const linked = analytics(context, "response_time", { kind: "conversation", chatIds: [1, 2] }, bounds);
    const independent = analytics(context, "response_time", { kind: "conversation", chatIds: [3] }, bounds);
    expect(linked.overall).toMatchObject({ samples: 1, average_seconds: 600 });
    expect(independent.overall).toMatchObject({ samples: 1, average_seconds: 1200 });
    expect(global.applied_parameters).toMatchObject({
      counting_unit: "conversation_membership",
      shared_membership_policy: "include_once_per_conversation",
      shared_messages_in_scope: 1,
    });
    const sessions = analytics(context, "initiation", { kind: "global" }, bounds);
    expect(sessions.overall).toMatchObject({ sessions: 2, initiated_by_me: 0, initiated_by_others: 2, my_initiation_percent: 0 });
    expect(sessions.service_partitions.reduce((total, partition) => total + Number(partition.sessions), 0)).toBe(2);
    expect(sessions.applied_parameters).toMatchObject({
      counting_unit: "conversation_membership",
      shared_membership_policy: "include_once_per_conversation",
      session_gap_hours: 8,
    });
  });

  it("deduplicates service attribution for streaks without losing activity days", () => {
    const context = createMembershipFixture();
    const global = analytics(context, "streaks");
    expect(global.overall).toEqual({ any_activity_longest_days: 3, mutual_exchange_longest_days: 3 });
    expect(global.service_partitions).toHaveLength(3);
    expect(global.service_partitions).toEqual(expect.arrayContaining([
      { service_family: "unknown", any_activity_longest_days: 1, mutual_exchange_longest_days: 0 },
      { service_family: "sms", any_activity_longest_days: 2, mutual_exchange_longest_days: 0 },
      { service_family: "rcs", any_activity_longest_days: 3, mutual_exchange_longest_days: 0 },
    ]));
    const contact = analytics(context, "streaks", { kind: "contact", handles: ["+15550000001"] });
    expect(contact.overall).toEqual({ any_activity_longest_days: 3, mutual_exchange_longest_days: 2 });
    const independent = analytics(context, "streaks", { kind: "conversation", chatIds: [3] });
    expect(independent.overall).toEqual({ any_activity_longest_days: 1, mutual_exchange_longest_days: 1 });
    expect(global.applied_parameters.counting_unit).toBe("unique_message");
    expect(global.applied_parameters.shared_membership_policy).toBe("deduplicate_within_requested_scope");
  });

  it("supports shared messages without chat_lookup without inferring conversation links", () => {
    const context = createMembershipFixture({ lookup: false });
    const counts = analytics(context);
    expect(counts.overall).toMatchObject({ messages: 7, sent: 4, received: 3, reaction_events: 1, system_events: 1 });
    expect(counts.applied_parameters.shared_messages_in_scope).toBe(4);
    const selected = analytics(context, "message_count", { kind: "conversation", chatIds: [2] });
    expect(selected.overall).toMatchObject({ messages: 2, sent: 1, received: 1, reaction_events: 1, system_events: 0 });
    const contact = analytics(context, "message_count", { kind: "contact", handles: ["+15550000001"] });
    expect(contact.overall.messages).toBe(6);
    const bounds = compileDateBounds({ date_from: "2026-03-08", date_to: "2026-03-08", timezone: "UTC" });
    const sessions = analytics(context, "initiation", { kind: "global" }, bounds);
    expect(sessions.overall).toMatchObject({ sessions: 3, initiated_by_me: 1, initiated_by_others: 2 });
    assertPartitionTotals(counts);
  });

  it("uses schema-safe unknown service attribution when both service columns are absent", () => {
    const context = createMembershipFixture({ lookup: false, services: false });
    const result = analytics(context);
    expect(result.service_partitions).toEqual([
      { service_family: "unknown", messages: 7, sent: 4, received: 3, reaction_events: 1, system_events: 1 },
    ]);
    expect(analytics(context, "response_time").overall.samples).toBeGreaterThan(0);
    expect(analytics(context, "streaks").overall).toEqual({ any_activity_longest_days: 3, mutual_exchange_longest_days: 3 });
    assertPartitionTotals(result);
  });
});
