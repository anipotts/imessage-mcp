// Pattern tools — who_initiates, streaks, double_texts, conversation_gaps, forgotten_contacts

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, MSG_FILTER, repliedToCondition, getMessageText } from "../db.js";
import { lookupContact } from "../contacts.js";
import { clamp, MAX_LIMIT, isoDateSchema } from "../helpers.js";

export function registerPatternTools(server: McpServer) {
  // -- who_initiates --
  server.tool(
    "who_initiates",
    "Who starts conversations? After a gap of N hours, the next message is a 'conversation initiation.' Shows per-contact who reaches out first and how often. Answers 'do I always text first?' By default excludes contacts you've never replied to.",
    {
      contact: z.string().optional().describe("Filter by contact (omit for global ranking)"),
      gap_hours: z.number().optional().describe("Hours of silence before a new conversation (default: 8)"),
      min_conversations: z.number().optional().describe("Minimum conversations to include contact (default: 5)"),
      date_from: isoDateSchema.optional().describe("Start date (ISO)"),
      date_to: isoDateSchema.optional().describe("End date (ISO)"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
      limit: z.number().optional().describe("Max contacts to show (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);
      const gapNano = (params.gap_hours ?? 8) * 3600 * 1_000_000_000;

      const conditions = [
        "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)",
        "m.associated_message_type = 0",
      ];
      const bindings: Record<string, any> = { gap_nano: gapNano, min_conversations: params.min_conversations ?? 5, limit };

      if (params.contact) {
        conditions.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }
      if (params.date_from) {
        conditions.push(`${DATE_EXPR} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        conditions.push(`${DATE_EXPR} <= @date_to`);
        bindings.date_to = params.date_to;
      }
      if (!params.include_all && !params.contact) {
        conditions.push(repliedToCondition());
      }

      const where = conditions.join(" AND ");

      const rows = db.prepare(`
        WITH msgs AS (
          SELECT m.is_from_me, m.date, h.id as handle,
            LAG(m.date) OVER (PARTITION BY h.id ORDER BY m.date) as prev_date
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE ${where}
        ),
        initiations AS (
          SELECT handle, is_from_me
          FROM msgs
          WHERE prev_date IS NULL OR (date - prev_date) > @gap_nano
        )
        SELECT handle,
          SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as you_initiate,
          SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as they_initiate,
          COUNT(*) as total_conversations
        FROM initiations
        GROUP BY handle
        HAVING total_conversations >= @min_conversations
        ORDER BY total_conversations DESC
        LIMIT @limit
      `).all(bindings) as any[];

      const enriched = rows.map((row: any) => {
        const contact = lookupContact(row.handle);
        const total = row.you_initiate + row.they_initiate;
        return {
          handle: row.handle,
          name: contact.name,
          you_initiate: row.you_initiate,
          they_initiate: row.they_initiate,
          total_conversations: total,
          you_initiate_pct: total > 0 ? Math.round((row.you_initiate / total) * 100) : 0,
        };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            gap_hours: params.gap_hours ?? 8,
            contacts: enriched,
          }, null, 2),
        }],
      };
    },
  );

  // -- streaks --
  server.tool(
    "streaks",
    "Consecutive-day messaging streaks with contacts. Like Snapchat streaks but for iMessage. Shows longest streak, when it happened, and current streak status. By default excludes contacts you've never replied to.",
    {
      contact: z.string().optional().describe("Filter by contact (omit for top streaks across all contacts)"),
      min_streak: z.number().optional().describe("Minimum streak length in days (default: 3)"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
      limit: z.number().optional().describe("Max contacts (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);

      const contactFilter = params.contact ? "AND h.id LIKE @contact" : "";
      const repliedTo = (!params.include_all && !params.contact) ? `AND ${repliedToCondition()}` : '';
      const bindings: Record<string, any> = { limit };
      if (params.contact) bindings.contact = `%${params.contact}%`;

      const minStreak = params.min_streak ?? 3;
      bindings.min_streak = minStreak;

      const rows = db.prepare(`
        WITH daily AS (
          SELECT DISTINCT h.id as handle, date(${DATE_EXPR}) as day
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
            ${contactFilter} ${repliedTo}
        ),
        streaks AS (
          SELECT handle, day,
            julianday(day) - ROW_NUMBER() OVER (PARTITION BY handle ORDER BY day) as grp
          FROM daily
        ),
        streak_lengths AS (
          SELECT handle, COUNT(*) as days, MIN(day) as start_date, MAX(day) as end_date
          FROM streaks GROUP BY handle, grp
        ),
        best AS (
          SELECT handle, days, start_date, end_date,
            ROW_NUMBER() OVER (PARTITION BY handle ORDER BY days DESC) as rn
          FROM streak_lengths
        )
        SELECT handle, days as longest_streak, start_date, end_date
        FROM best WHERE rn = 1 AND days >= @min_streak
        ORDER BY longest_streak DESC
        LIMIT @limit
      `).all(bindings) as any[];

      // Check current streak for each contact
      const today = new Date().toISOString().slice(0, 10);
      const enriched = rows.map((row: any) => {
        const contact = lookupContact(row.handle);

        // Get current streak (streak ending today or yesterday)
        const currentStreak = db.prepare(`
          WITH daily AS (
            SELECT DISTINCT date(${DATE_EXPR}) as day
            FROM message m
            JOIN handle h ON m.handle_id = h.ROWID
            WHERE h.id = @handle
              AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
          ),
          streaks AS (
            SELECT day, julianday(day) - ROW_NUMBER() OVER (ORDER BY day) as grp
            FROM daily
          ),
          streak_info AS (
            SELECT COUNT(*) as days, MIN(day) as start_date, MAX(day) as end_date
            FROM streaks GROUP BY grp
            ORDER BY end_date DESC LIMIT 1
          )
          SELECT days, start_date, end_date
          FROM streak_info
          WHERE julianday(@today) - julianday(end_date) <= 1
        `).get({ handle: row.handle, today }) as any;

        // Get total active days
        const activeDays = db.prepare(`
          SELECT COUNT(DISTINCT date(${DATE_EXPR})) as days
          FROM message m JOIN handle h ON m.handle_id = h.ROWID
          WHERE h.id = @handle AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
        `).get({ handle: row.handle }) as any;

        return {
          handle: row.handle,
          name: contact.name,
          longest_streak: { days: row.longest_streak, from: row.start_date, to: row.end_date },
          current_streak: currentStreak
            ? { days: currentStreak.days, from: currentStreak.start_date, active: true }
            : { days: 0, active: false },
          total_active_days: activeDays?.days ?? 0,
        };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ streaks: enriched }, null, 2),
        }],
      };
    },
  );

  // -- double_texts --
  server.tool(
    "double_texts",
    "Detect double-texting and unanswered message patterns. Finds when you (or a contact) sent multiple consecutive messages without a reply. Shows frequency, longest bursts, and who does it more. Omit contact for a global ranking of who you double-text the most.",
    {
      contact: z.string().optional().describe("Contact handle or name (omit for global double-text ranking)"),
      min_consecutive: z.number().optional().describe("Minimum consecutive messages to count (default: 2)"),
      date_from: isoDateSchema.optional().describe("Start date (ISO)"),
      date_to: isoDateSchema.optional().describe("End date (ISO)"),
      limit: z.number().optional().describe("Max burst results (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);
      const minConsecutive = params.min_consecutive ?? 2;

      if (!params.contact) {
        // Global ranking: who does the user double-text most?
        const conditions = [
          "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)",
          "m.associated_message_type = 0",
        ];
        const bindings: Record<string, any> = { min_consecutive: minConsecutive, limit };

        // Apply spam filter for global queries
        conditions.push(repliedToCondition());

        if (params.date_from) {
          conditions.push(`${DATE_EXPR} >= @date_from`);
          bindings.date_from = params.date_from;
        }
        if (params.date_to) {
          conditions.push(`${DATE_EXPR} <= @date_to`);
          bindings.date_to = params.date_to;
        }

        const where = conditions.join(" AND ");

        const ranking = db.prepare(`
          WITH msgs AS (
            SELECT m.is_from_me, ${DATE_EXPR} as date, h.id as handle,
              ROW_NUMBER() OVER (PARTITION BY h.id ORDER BY m.date) as rn,
              ROW_NUMBER() OVER (PARTITION BY h.id, m.is_from_me ORDER BY m.date) as part_rn
            FROM message m
            JOIN handle h ON m.handle_id = h.ROWID
            WHERE ${where}
          ),
          runs AS (
            SELECT handle, is_from_me, COUNT(*) as consecutive
            FROM msgs GROUP BY handle, is_from_me, rn - part_rn
            HAVING consecutive >= @min_consecutive
          )
          SELECT handle,
            SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as your_double_texts,
            SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as their_double_texts,
            MAX(consecutive) as max_burst
          FROM runs
          GROUP BY handle
          ORDER BY your_double_texts DESC
          LIMIT @limit
        `).all(bindings) as any[];

        const enriched = ranking.map((row: any) => {
          const c = lookupContact(row.handle);
          return {
            handle: row.handle,
            name: c.name,
            your_double_texts: row.your_double_texts,
            their_double_texts: row.their_double_texts,
            max_burst: row.max_burst,
          };
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ min_consecutive: minConsecutive, ranking: enriched }, null, 2),
          }],
        };
      }

      // Contact-specific mode
      const conditions = [
        "h.id LIKE @contact",
        "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)",
        "m.associated_message_type = 0",
      ];
      const bindings: Record<string, any> = {
        contact: `%${params.contact}%`,
        min_consecutive: minConsecutive,
        limit,
      };

      if (params.date_from) {
        conditions.push(`${DATE_EXPR} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        conditions.push(`${DATE_EXPR} <= @date_to`);
        bindings.date_to = params.date_to;
      }

      const where = conditions.join(" AND ");

      // Find consecutive message bursts using island-and-gaps
      const bursts = db.prepare(`
        WITH msgs AS (
          SELECT m.is_from_me, ${DATE_EXPR} as date,
            ROW_NUMBER() OVER (ORDER BY m.date) as rn,
            ROW_NUMBER() OVER (PARTITION BY m.is_from_me ORDER BY m.date) as part_rn
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE ${where}
        )
        SELECT
          is_from_me,
          COUNT(*) as consecutive,
          MIN(date) as first_msg,
          MAX(date) as last_msg
        FROM msgs
        GROUP BY is_from_me, rn - part_rn
        HAVING consecutive >= @min_consecutive
        ORDER BY consecutive DESC
        LIMIT @limit
      `).all(bindings) as any[];

      // Summary stats
      const summary = db.prepare(`
        WITH msgs AS (
          SELECT m.is_from_me, ${DATE_EXPR} as date,
            ROW_NUMBER() OVER (ORDER BY m.date) as rn,
            ROW_NUMBER() OVER (PARTITION BY m.is_from_me ORDER BY m.date) as part_rn
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE ${where}
        ),
        runs AS (
          SELECT is_from_me, COUNT(*) as consecutive
          FROM msgs GROUP BY is_from_me, rn - part_rn
          HAVING consecutive >= @min_consecutive
        )
        SELECT
          is_from_me,
          COUNT(*) as times,
          ROUND(AVG(consecutive), 1) as avg_burst,
          MAX(consecutive) as max_burst
        FROM runs
        Group BY is_from_me
      `).all(bindings) as any[];

      const contact = lookupContact(params.contact);

      const formattedSummary: Record<string, any> = {};
      for (const s of summary as any[]) {
        formattedSummary[s.is_from_me ? "you" : contact.name] = {
          times: s.times,
          avg_burst: s.avg_burst,
          max_burst: s.max_burst,
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            contact: contact.name,
            min_consecutive: minConsecutive,
            summary: formattedSummary,
            top_bursts: bursts.map((b: any) => ({
              from: b.is_from_me ? "you" : contact.name,
              consecutive_messages: b.consecutive,
              first_msg: b.first_msg,
              last_msg: b.last_msg,
            })),
          }, null, 2),
        }],
      };
    },
  );

  // -- conversation_gaps --
  server.tool(
    "conversation_gaps",
    "Find the longest silences in a conversation. Detects periods where you and a contact stopped talking — falling-outs, busy periods, or drifting apart. Shows gap duration and when it happened.",
    {
      contact: z.string().describe("Contact handle or name"),
      min_gap_days: z.number().optional().describe("Minimum gap in days to include (default: 7)"),
      limit: z.number().optional().describe("Max gaps to return (default 10)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 10, 1, MAX_LIMIT);
      const minGapNano = (params.min_gap_days ?? 7) * 86400 * 1_000_000_000;

      const rows = db.prepare(`
        WITH msg_pairs AS (
          SELECT
            ${DATE_EXPR} as date,
            LAG(${DATE_EXPR}) OVER (ORDER BY m.date) as prev_date,
            m.date as raw_date,
            LAG(m.date) OVER (ORDER BY m.date) as prev_raw_date,
            m.is_from_me as broken_by_me,
            m.text as break_text,
            m.attributedBody as break_body
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE h.id LIKE @contact
            AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
        )
        SELECT
          prev_date as silence_start,
          date as silence_end,
          ROUND((raw_date - prev_raw_date) / 1000000000.0 / 86400.0, 1) as gap_days,
          broken_by_me,
          break_text,
          break_body
        FROM msg_pairs
        WHERE prev_raw_date IS NOT NULL
          AND (raw_date - prev_raw_date) > @min_gap_nano
        ORDER BY gap_days DESC
        LIMIT @limit
      `).all({ contact: `%${params.contact}%`, min_gap_nano: minGapNano, limit }) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No gaps longer than ${params.min_gap_days ?? 7} days found for "${params.contact}"` }] };
      }

      const contact = lookupContact(params.contact);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            contact: contact.name,
            min_gap_days: params.min_gap_days ?? 7,
            gaps: rows.map((r: any) => ({
              gap_days: r.gap_days,
              silence_start: r.silence_start,
              silence_end: r.silence_end,
              broken_by: r.broken_by_me ? "you" : contact.name,
              ice_breaker_text: getMessageText({ text: r.break_text, attributedBody: r.break_body }) || "(attachment)",
            })),
          }, null, 2),
        }],
      };
    },
  );

  // -- forgotten_contacts --
  server.tool(
    "forgotten_contacts",
    "Find dormant relationships — contacts you used to message but haven't talked to in a long time. Great for reconnecting with people you've lost touch with. By default excludes contacts you've never replied to.",
    {
      min_messages: z.number().optional().describe("Minimum past messages to qualify (default: 10)"),
      inactive_days: z.number().optional().describe("Days of inactivity to count as 'forgotten' (default: 365)"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);
      const minMessages = params.min_messages ?? 10;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (params.inactive_days ?? 365));
      const cutoffDate = cutoff.toISOString().slice(0, 10);

      const repliedTo = params.include_all ? '' : `AND ${repliedToCondition()}`;

      const rows = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          MIN(${DATE_EXPR}) as first_message,
          MAX(${DATE_EXPR}) as last_message
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
        GROUP BY h.id
        HAVING total_messages >= @min_messages AND MAX(${DATE_EXPR}) < @cutoff
        ORDER BY total_messages DESC
        LIMIT @limit
      `).all({ min_messages: minMessages, cutoff: cutoffDate, limit }) as any[];

      const enriched = rows.map((row: any) => {
        const contact = lookupContact(row.handle);
        const lastDate = new Date(row.last_message);
        const daysSince = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
        return {
          handle: row.handle,
          name: contact.name,
          total_messages: row.total_messages,
          sent: row.sent,
          received: row.received,
          first_message: row.first_message,
          last_message: row.last_message,
          days_since_last: daysSince,
        };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            inactive_threshold_days: params.inactive_days ?? 365,
            min_messages: minMessages,
            forgotten: enriched,
          }, null, 2),
        }],
      };
    },
  );
}
