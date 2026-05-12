// Workflow-focused tools to support triage, CRM, compliance, and incremental ingestion.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, MSG_FILTER, APPLE_EPOCH_OFFSET, baseMessageConditions, getMessageText, safeText, repliedToCondition } from "../db.js";
import { lookupContact } from "../contacts.js";
import { applyContactFilter, contactModeSchema } from "../contact-filter.js";
import { clamp, DEFAULT_LIMIT, MAX_LIMIT, isoDateSchema } from "../helpers.js";
import { buildEvidenceBundle } from "../evidence.js";
import { getCursor, setCursor } from "../cursors.js";
import { parseSyncMode } from "../watcher.js";
import { getRequestContext } from "../context.js";
import { ensureSearchIndex, getSearchIndexHealth } from "../search-index.js";

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "you", "your", "have", "from",
  "just", "about", "what", "when", "where", "would", "could", "should", "there",
  "been", "were", "will", "they", "them", "their", "into", "than", "then", "also",
  "but", "not", "its", "it's", "our", "out", "are", "was", "did", "has", "had",
]);

function toLocalDateExpr(alias = "m"): string {
  return `datetime(${alias}.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length >= 3 && !STOPWORDS.has(tok));
}

function topTerms(messages: Array<{ text: string | null }>, limit = 12): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    if (!msg.text) continue;
    for (const tok of tokenize(msg.text)) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

function urgencyBucket(hours: number): "high" | "medium" | "low" {
  if (hours >= 72) return "high";
  if (hours >= 24) return "medium";
  return "low";
}

function computeYearOverview(year: number, includeAll: boolean): any {
  const db = getDb();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31 23:59:59`;
  const repliedTo = includeAll ? "" : `AND ${repliedToCondition()}`;

  const overview = db.prepare(`
    SELECT
      COUNT(*) as total_messages,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
      COUNT(DISTINCT h.id) as unique_contacts
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE ${DATE_EXPR} BETWEEN @start AND @end
      AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
  `).get({ start: yearStart, end: yearEnd }) as any;

  const topContacts = db.prepare(`
    SELECT h.id as handle, COUNT(*) as messages
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE ${DATE_EXPR} BETWEEN @start AND @end
      AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
    GROUP BY h.id
    ORDER BY messages DESC
    LIMIT 10
  `).all({ start: yearStart, end: yearEnd }) as any[];

  return {
    year,
    overview,
    top_contacts: topContacts.map((row) => ({
      handle: row.handle,
      name: lookupContact(row.handle).name,
      messages: row.messages,
    })),
  };
}

export function registerWorkflowTools(server: McpServer) {
  server.tool(
    "needs_reply",
    "Find contacts likely waiting on your reply with urgency scoring.",
    {
      contact: z.string().optional().describe("Optional contact filter"),
      contact_mode: contactModeSchema,
      inactive_hours: z.number().optional().describe("Minimum hours since incoming message (default 4)"),
      include_all: z.boolean().optional().describe("Include all contacts, including unreplied senders"),
      limit: z.number().optional().describe("Max contacts to return (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);
      const minHours = params.inactive_hours ?? 4;
      const nowNs = Date.now() * 1_000_000;

      const conditions = baseMessageConditions();
      const bindings: Record<string, unknown> = { limit };

      applyContactFilter(conditions, bindings, {
        contact: params.contact,
        contact_mode: params.contact_mode,
        alias: "h.id",
        prefix: "nr_contact",
      });

      if (!params.include_all && !params.contact) {
        conditions.push(repliedToCondition());
      }

      const where = conditions.join(" AND ");

      const rows = db.prepare(`
        WITH convo AS (
          SELECT
            h.id as handle,
            MAX(CASE WHEN m.is_from_me = 0 THEN m.date END) as last_received_ns,
            MAX(CASE WHEN m.is_from_me = 1 THEN m.date END) as last_sent_ns,
            COUNT(*) as total_messages
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE ${where}
          GROUP BY h.id
        )
        SELECT
          handle,
          last_received_ns,
          last_sent_ns,
          total_messages,
          datetime(last_received_ns/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime') as last_received,
          datetime(last_sent_ns/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime') as last_sent
        FROM convo
        WHERE last_received_ns IS NOT NULL
        ORDER BY last_received_ns DESC
        LIMIT @limit
      `).all(bindings) as any[];

      const queue = rows
        .map((row) => {
          const needsReply = !row.last_sent_ns || row.last_received_ns > row.last_sent_ns;
          const hoursWaiting = (nowNs - row.last_received_ns) / 1_000_000_000 / 3600;
          const contact = lookupContact(row.handle);
          return {
            handle: row.handle,
            name: contact.name,
            total_messages: row.total_messages,
            last_received: row.last_received,
            last_sent: row.last_sent,
            hours_waiting: Math.round(hoursWaiting * 10) / 10,
            needs_reply: needsReply,
            urgency: urgencyBucket(hoursWaiting),
          };
        })
        .filter((item) => item.needs_reply && item.hours_waiting >= minHours)
        .sort((a, b) => b.hours_waiting - a.hours_waiting);

      return {
        content: [{ type: "text", text: JSON.stringify({ min_hours: minHours, queue }, null, 2) }],
      };
    },
  );

  server.tool(
    "follow_up_queue",
    "Build a follow-up queue from dormant conversations with prioritization scores.",
    {
      contact: z.string().optional().describe("Optional contact filter"),
      contact_mode: contactModeSchema,
      inactive_days: z.number().optional().describe("Days since last message to include (default 30)"),
      min_messages: z.number().optional().describe("Minimum relationship depth (default 10)"),
      include_all: z.boolean().optional().describe("Include all contacts, including unreplied senders"),
      limit: z.number().optional().describe("Max contacts to return (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);
      const inactiveDays = params.inactive_days ?? 30;
      const minMessages = params.min_messages ?? 10;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - inactiveDays);
      const cutoffDate = cutoff.toISOString().slice(0, 10);

      const conditions = baseMessageConditions();
      const bindings: Record<string, unknown> = {
        cutoff: cutoffDate,
        min_messages: minMessages,
        limit,
      };

      applyContactFilter(conditions, bindings, {
        contact: params.contact,
        contact_mode: params.contact_mode,
        alias: "h.id",
        prefix: "fu_contact",
      });

      if (!params.include_all && !params.contact) {
        conditions.push(repliedToCondition());
      }

      const where = conditions.join(" AND ");
      const rows = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          MAX(${DATE_EXPR}) as last_message,
          MIN(${DATE_EXPR}) as first_message
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY h.id
        HAVING total_messages >= @min_messages AND MAX(${DATE_EXPR}) < @cutoff
        ORDER BY last_message ASC
        LIMIT @limit
      `).all(bindings) as any[];

      const queue = rows.map((row) => {
        const contact = lookupContact(row.handle);
        const last = new Date(row.last_message).getTime();
        const daysSince = Math.floor((Date.now() - last) / 86400000);
        const score = Math.round((Math.log10(row.total_messages + 1) * 20 + daysSince * 0.9) * 10) / 10;
        return {
          handle: row.handle,
          name: contact.name,
          days_since_last: daysSince,
          total_messages: row.total_messages,
          sent: row.sent,
          received: row.received,
          last_message: row.last_message,
          follow_up_score: score,
        };
      }).sort((a, b) => b.follow_up_score - a.follow_up_score);

      return {
        content: [{ type: "text", text: JSON.stringify({ inactive_days: inactiveDays, queue }, null, 2) }],
      };
    },
  );

  server.tool(
    "compare_wrapped",
    "Compare two years of iMessage wrapped summaries.",
    {
      year_a: z.number().optional().describe("First year (default: last year - 1)"),
      year_b: z.number().optional().describe("Second year (default: last year)"),
      include_all: z.boolean().optional().describe("Include all contacts, including unreplied senders"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const yearB = params.year_b ?? (new Date().getFullYear() - 1);
      const yearA = params.year_a ?? (yearB - 1);
      const includeAll = params.include_all ?? false;

      const a = computeYearOverview(yearA, includeAll);
      const b = computeYearOverview(yearB, includeAll);

      const safeDelta = (next: number, prev: number): number | null => {
        if (!Number.isFinite(next) || !Number.isFinite(prev) || prev === 0) return null;
        return Math.round((((next - prev) / prev) * 100) * 10) / 10;
      };

      const deltas = {
        total_messages_pct: safeDelta(b.overview.total_messages ?? 0, a.overview.total_messages ?? 0),
        sent_pct: safeDelta(b.overview.sent ?? 0, a.overview.sent ?? 0),
        received_pct: safeDelta(b.overview.received ?? 0, a.overview.received ?? 0),
        unique_contacts_pct: safeDelta(b.overview.unique_contacts ?? 0, a.overview.unique_contacts ?? 0),
      };

      return {
        content: [{ type: "text", text: JSON.stringify({ year_a: a, year_b: b, deltas }, null, 2) }],
      };
    },
  );

  server.tool(
    "conversation_brief",
    "Generate a deterministic conversation brief: key terms, open loops, and recent commitments.",
    {
      contact: z.string().optional().describe("Contact filter"),
      contact_mode: contactModeSchema,
      chat_id: z.string().optional().describe("Chat identifier"),
      lookback_days: z.number().optional().describe("Window size in days (default 30)"),
      limit: z.number().optional().describe("Max messages to inspect (default 200)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      if (!params.contact && !params.chat_id) {
        return { content: [{ type: "text", text: "Error: provide either contact or chat_id" }] };
      }

      const db = getDb();
      const limit = clamp(params.limit ?? 200, 1, MAX_LIMIT);
      const lookback = params.lookback_days ?? 30;
      const sinceDate = new Date(Date.now() - lookback * 86400000).toISOString().slice(0, 10);

      const conditions = baseMessageConditions();
      const bindings: Record<string, unknown> = { since_date: sinceDate, limit };
      conditions.push(`${DATE_EXPR} >= @since_date`);

      if (params.chat_id) {
        conditions.push("c.chat_identifier = @chat_id");
        bindings.chat_id = params.chat_id;
      } else {
        applyContactFilter(conditions, bindings, {
          contact: params.contact,
          contact_mode: params.contact_mode,
          alias: "h.id",
          prefix: "cb_contact",
        });
      }

      const where = conditions.join(" AND ");
      const rows = db.prepare(`
        SELECT
          m.ROWID as rowid,
          ${DATE_EXPR} as date,
          m.is_from_me,
          m.text,
          m.attributedBody,
          h.id as handle
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        JOIN chat c ON cmj.chat_id = c.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
        LIMIT @limit
      `).all(bindings) as any[];

      const chronological = rows.reverse().map((row) => ({
        rowid: row.rowid,
        date: row.date,
        is_from_me: row.is_from_me,
        text: safeText(getMessageText(row)),
        handle: row.handle,
      }));

      const terms = topTerms(chronological, 12);
      const commitmentRe = /\b(i('| a)m|i will|we should|let'?s|i can)\b/i;

      const commitments = chronological
        .filter((m) => m.text && commitmentRe.test(m.text))
        .slice(-10)
        .map((m) => ({
          date: m.date,
          from: m.is_from_me ? "you" : (lookupContact(m.handle || "").name || m.handle || "unknown"),
          text: m.text,
        }));

      const openLoops: Array<{ date: string; question: string }> = [];
      for (let i = 0; i < chronological.length; i++) {
        const msg = chronological[i];
        if (!msg.is_from_me || !msg.text || !msg.text.trim().endsWith("?")) continue;
        const next = chronological[i + 1];
        if (!next || next.is_from_me) {
          openLoops.push({ date: msg.date, question: msg.text });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            lookback_days: lookback,
            message_count: chronological.length,
            top_terms: terms,
            open_loops: openLoops.slice(-10),
            commitments,
            last_commitment: commitments.length > 0 ? commitments[commitments.length - 1] : null,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "sync_health",
    "Report iMessage sync and database freshness health.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const db = getDb();
      const row = db.prepare(`
        SELECT
          COUNT(*) as total_messages,
          MIN(${DATE_EXPR}) as first_message,
          MAX(${DATE_EXPR}) as last_message,
          MAX(ROWID) as max_rowid
        FROM message m
      `).get() as any;

      const lastDate = row?.last_message ? new Date(row.last_message) : null;
      const freshnessHours = lastDate ? Math.round(((Date.now() - lastDate.getTime()) / 3600000) * 10) / 10 : null;
      const dbPath = getRequestContext()?.db_path || process.env.IMESSAGE_DB || path.join(homedir(), "Library/Messages/chat.db");
      const walPath = `${dbPath}-wal`;
      const syncMode = parseSyncMode(process.env.IMESSAGE_SYNC);
      const indexHealth = getSearchIndexHealth();

      const status = row.total_messages === 0
        ? "empty"
        : (freshnessHours !== null && freshnessHours > 48 ? "stale" : "healthy");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status,
            db_path: dbPath,
            wal_present: existsSync(walPath),
            sync_mode: typeof syncMode === "string" ? syncMode : `poll:${syncMode.poll}`,
            message_count: row.total_messages,
            first_message: row.first_message,
            last_message: row.last_message,
            max_rowid: row.max_rowid,
            freshness_hours: freshnessHours,
            search_index: indexHealth,
            hint: status === "stale"
              ? "Messages may not be fully synced to this Mac. Verify Messages in iCloud is enabled and currently syncing."
              : undefined,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "search_index_status",
    "Report FTS/semantic index health for the active profile.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const health = getSearchIndexHealth();
      return {
        content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
      };
    },
  );

  server.tool(
    "rebuild_search_index",
    "Rebuild and refresh the FTS/semantic search index.",
    {
      full_rebuild: z.boolean().optional().describe("Drop and rebuild index from scratch"),
      max_rows: z.number().optional().describe("Max rows to process in this run (default 20k)"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const refreshed = ensureSearchIndex({
        rebuild: params.full_rebuild,
        max_rows: params.max_rows,
      });
      const health = getSearchIndexHealth();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ refreshed, health }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "list_changes",
    "Incremental change feed since a cursor. Useful for external ETL and automations.",
    {
      cursor_namespace: z.string().optional().describe("Namespace for persisted cursor (default: default)"),
      sync_cursor: z.object({ after_rowid: z.number().optional() }).optional().describe("Explicit cursor override"),
      include_text: z.boolean().optional().describe("Include message text previews"),
      contact: z.string().optional().describe("Optional contact filter"),
      contact_mode: contactModeSchema,
      limit: z.number().optional().describe("Max records (default 100)"),
      reset: z.boolean().optional().describe("Reset namespace cursor to current max ROWID"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const namespace = params.cursor_namespace?.trim() || "default";
      const key = `list_changes:${namespace}`;
      const limit = clamp(params.limit ?? 100, 1, MAX_LIMIT);
      const currentMax = ((db.prepare("SELECT MAX(ROWID) as max_rowid FROM message").get() as any)?.max_rowid ?? 0) as number;

      if (params.reset) {
        setCursor(key, currentMax);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "baseline_set", sync_cursor: { namespace, after_rowid: currentMax } }, null, 2) }],
        };
      }

      const startingCursor = params.sync_cursor?.after_rowid ?? getCursor(key);
      if (startingCursor === null) {
        setCursor(key, currentMax);
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "baseline_set", sync_cursor: { namespace, after_rowid: currentMax } }, null, 2) }],
        };
      }

      const conditions = baseMessageConditions();
      const bindings: Record<string, unknown> = { after_rowid: startingCursor, limit };
      conditions.push("m.ROWID > @after_rowid");

      applyContactFilter(conditions, bindings, {
        contact: params.contact,
        contact_mode: params.contact_mode,
        alias: "h.id",
        prefix: "lc_contact",
      });

      const where = conditions.join(" AND ");
      const rows = db.prepare(`
        SELECT
          m.ROWID as rowid,
          m.guid,
          ${DATE_EXPR} as date,
          m.is_from_me,
          m.text,
          m.attributedBody,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.ROWID ASC
        LIMIT @limit
      `).all(bindings) as any[];

      const changes = rows.map((row) => ({
        rowid: row.rowid,
        guid: row.guid,
        date: row.date,
        is_from_me: row.is_from_me,
        handle: row.handle,
        contact_name: row.handle ? lookupContact(row.handle).name : "(unknown)",
        text: params.include_text ? safeText(getMessageText(row)) : undefined,
      }));

      if (!params.contact) {
        setCursor(key, currentMax);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "delta",
            since_rowid: startingCursor,
            current_rowid: currentMax,
            count: changes.length,
            changes,
            sync_cursor: {
              namespace,
              after_rowid: params.contact ? startingCursor : currentMax,
            },
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "export_evidence_bundle",
    "Generate an evidence bundle with checksums for legal/compliance workflows.",
    {
      contact: z.string().optional().describe("Optional contact filter"),
      contact_mode: contactModeSchema,
      date_from: isoDateSchema.optional().describe("Start date"),
      date_to: isoDateSchema.optional().describe("End date"),
      since_rowid: z.number().optional().describe("Only include messages with ROWID greater than this"),
      include_text: z.boolean().optional().describe("Include message text in exported records"),
      limit: z.number().optional().describe("Max records (default 100)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const bundle = buildEvidenceBundle({
        contact: params.contact,
        contact_mode: params.contact_mode,
        date_from: params.date_from,
        date_to: params.date_to,
        since_rowid: params.since_rowid,
        include_text: params.include_text,
        limit: params.limit ?? 100,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }],
      };
    },
  );

  server.tool(
    "unknown_sender_analysis",
    "Analyze unknown senders for OTP/promo/scam heuristics.",
    {
      limit: z.number().optional().describe("Max handles to analyze (default 50)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 50, 1, MAX_LIMIT);

      const candidates = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          MAX(${DATE_EXPR}) as last_message
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
        GROUP BY h.id
        HAVING sent = 0 OR sent < 2
        ORDER BY received DESC
        LIMIT @limit
      `).all({ limit }) as any[];

      const otpRe = /\b\d{4,8}\b/;
      const promoRe = /\b(unsubscribe|sale|deal|offer|promo|stop to end)\b/i;
      const scamRe = /\b(urgent|wire|gift card|crypto|verify account|suspended)\b/i;

      const analysis = candidates.map((row) => {
        const sampleRows = db.prepare(`
          SELECT m.text, m.attributedBody
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE h.id = @handle
          ORDER BY m.date DESC
          LIMIT 20
        `).all({ handle: row.handle }) as any[];

        let otpHits = 0;
        let promoHits = 0;
        let scamHits = 0;
        for (const sample of sampleRows) {
          const txt = getMessageText(sample) || "";
          if (otpRe.test(txt) && /\b(code|verification|login|otp)\b/i.test(txt)) otpHits++;
          if (promoRe.test(txt)) promoHits++;
          if (scamRe.test(txt)) scamHits++;
        }

        const category = otpHits > promoHits && otpHits > scamHits
          ? "otp_or_verification"
          : promoHits >= scamHits
            ? "promo_or_marketing"
            : "potential_scam";

        return {
          handle: row.handle,
          received: row.received,
          sent: row.sent,
          total_messages: row.total_messages,
          last_message: row.last_message,
          category,
          signals: { otp_hits: otpHits, promo_hits: promoHits, scam_hits: scamHits },
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ handles_analyzed: analysis.length, analysis }, null, 2) }],
      };
    },
  );

  server.tool(
    "memory_digest",
    "Generate memory digests by same day, same week, or same month across prior years.",
    {
      mode: z.enum(["same_day", "same_week", "same_month"]).optional().describe("Digest mode (default: same_day)"),
      date: isoDateSchema.optional().describe("Anchor date (default: today)"),
      contact: z.string().optional().describe("Optional contact filter"),
      contact_mode: contactModeSchema,
      include_all: z.boolean().optional().describe("Include all contacts in global mode"),
      limit_per_year: z.number().optional().describe("Max samples per year (default 5)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const mode = params.mode ?? "same_day";
      const date = params.date ? new Date(`${params.date}T12:00:00`) : new Date();
      const currentYear = date.getFullYear();
      const limitPerYear = clamp(params.limit_per_year ?? 5, 1, 50);

      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const dd = String(date.getDate()).padStart(2, "0");
      const week = String(date.getDay()); // lightweight weekly anchor

      const conditions = baseMessageConditions();
      const bindings: Record<string, unknown> = { current_year: String(currentYear) };
      conditions.push(`strftime('%Y', ${DATE_EXPR}) <> @current_year`);

      if (mode === "same_day") {
        conditions.push(`strftime('%m-%d', ${DATE_EXPR}) = @anchor`);
        bindings.anchor = `${mm}-${dd}`;
      } else if (mode === "same_week") {
        conditions.push(`strftime('%w', ${DATE_EXPR}) = @anchor`);
        bindings.anchor = week;
      } else {
        conditions.push(`strftime('%m', ${DATE_EXPR}) = @anchor`);
        bindings.anchor = mm;
      }

      applyContactFilter(conditions, bindings, {
        contact: params.contact,
        contact_mode: params.contact_mode,
        alias: "h.id",
        prefix: "md_contact",
      });

      if (!params.include_all && !params.contact) {
        conditions.push(repliedToCondition());
      }

      const where = conditions.join(" AND ");
      const rows = db.prepare(`
        SELECT
          strftime('%Y', ${DATE_EXPR}) as year,
          ${DATE_EXPR} as date,
          m.is_from_me,
          m.text,
          m.attributedBody,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
      `).all(bindings) as any[];

      const byYear: Record<string, any[]> = {};
      for (const row of rows) {
        const text = safeText(getMessageText(row));
        if (!text) continue;
        if (!byYear[row.year]) byYear[row.year] = [];
        if (byYear[row.year].length >= limitPerYear) continue;
        byYear[row.year].push({
          date: row.date,
          from: row.is_from_me ? "you" : lookupContact(row.handle || "").name,
          handle: row.handle,
          text,
        });
      }

      const yearSummary = Object.entries(byYear).map(([year, messages]) => ({
        year,
        years_ago: currentYear - parseInt(year, 10),
        sample_count: messages.length,
      })).sort((a, b) => parseInt(b.year, 10) - parseInt(a.year, 10));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode,
            anchor_date: date.toISOString().slice(0, 10),
            years: yearSummary,
            memories: byYear,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "lead_candidates",
    "Heuristic lead detection from iMessage history for freelancer/creator CRM workflows.",
    {
      lookback_days: z.number().optional().describe("Window in days (default 180)"),
      min_messages: z.number().optional().describe("Minimum messages in window (default 5)"),
      limit: z.number().optional().describe("Max leads to return (default 20)"),
      contact: z.string().optional().describe("Optional contact filter"),
      contact_mode: contactModeSchema,
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const lookbackDays = params.lookback_days ?? 180;
      const minMessages = params.min_messages ?? 5;
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);
      const sinceDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);

      const conditions = baseMessageConditions();
      const bindings: Record<string, unknown> = { since_date: sinceDate, min_messages: minMessages, limit };
      conditions.push(`${DATE_EXPR} >= @since_date`);
      conditions.push(repliedToCondition());

      applyContactFilter(conditions, bindings, {
        contact: params.contact,
        contact_mode: params.contact_mode,
        alias: "h.id",
        prefix: "lead_contact",
      });

      const where = conditions.join(" AND ");

      const rows = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          MAX(${DATE_EXPR}) as last_touch
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY h.id
        HAVING total_messages >= @min_messages
        ORDER BY received DESC
        LIMIT @limit
      `).all(bindings) as any[];

      const keywordWeights: Array<[RegExp, string, number]> = [
        [/\b(invoice|contract|payment)\b/i, "closing", 5],
        [/\b(proposal|quote|budget|pricing)\b/i, "negotiation", 4],
        [/\b(project|brief|scope|meeting|call)\b/i, "discovery", 3],
      ];

      const leads = rows.map((row) => {
        const samples = db.prepare(`
          SELECT m.text, m.attributedBody
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE h.id = @handle
            AND ${toLocalDateExpr("m")} >= @since_date
          ORDER BY m.date DESC
          LIMIT 80
        `).all({ handle: row.handle, since_date: sinceDate }) as any[];

        let score = row.received + row.total_messages * 0.2;
        let stage = "nurture";
        let strongest = 0;

        for (const sample of samples) {
          const txt = getMessageText(sample) || "";
          for (const [re, stageName, weight] of keywordWeights) {
            if (re.test(txt)) {
              score += weight;
              if (weight > strongest) {
                strongest = weight;
                stage = stageName;
              }
            }
          }
        }

        return {
          handle: row.handle,
          name: lookupContact(row.handle).name,
          total_messages: row.total_messages,
          received: row.received,
          sent: row.sent,
          last_touch: row.last_touch,
          pipeline_stage_hint: stage,
          lead_score: Math.round(score * 10) / 10,
        };
      }).sort((a, b) => b.lead_score - a.lead_score);

      return {
        content: [{ type: "text", text: JSON.stringify({ lookback_days: lookbackDays, leads }, null, 2) }],
      };
    },
  );
}
