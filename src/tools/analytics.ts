// Analytics tools -- message_stats, contact_stats, temporal_heatmap

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, MSG_FILTER, baseMessageConditions, repliedToCondition } from "../db.js";
import { lookupContact } from "../contacts.js";

export function registerAnalyticsTools(server: McpServer) {
  // -- message_stats --
  server.tool(
    "message_stats",
    "Aggregate message statistics with flexible time-series grouping. Returns counts, sent/received splits, and averages grouped by day, week, month, year, hour, or day-of-week. By default excludes contacts you've never replied to.",
    {
      contact: z.string().optional().describe("Filter by contact handle"),
      date_from: z.string().optional().describe("Start date (ISO)"),
      date_to: z.string().optional().describe("End date (ISO)"),
      group_by: z.enum(["day", "week", "month", "year", "hour", "dow"]).optional()
        .describe("Time grouping (default: month)"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const groupBy = params.group_by ?? "month";

      const groupExpr = {
        day: `strftime('%Y-%m-%d', ${DATE_EXPR})`,
        week: `strftime('%Y-W%W', ${DATE_EXPR})`,
        month: `strftime('%Y-%m', ${DATE_EXPR})`,
        year: `strftime('%Y', ${DATE_EXPR})`,
        hour: `strftime('%H', ${DATE_EXPR})`,
        dow: `strftime('%w', ${DATE_EXPR})`,
      }[groupBy];

      const conditions: string[] = baseMessageConditions();
      const bindings: Record<string, any> = {};

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

      const sql = `
        SELECT
          ${groupExpr} as period,
          COUNT(*) as total,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          ROUND(AVG(LENGTH(m.text)), 1) as avg_length,
          COUNT(DISTINCT h.id) as unique_contacts
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY period
        ORDER BY period
      `;
      const rows = db.prepare(sql).all(bindings);

      // Overall summary
      const summSql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          ROUND(AVG(LENGTH(m.text)), 1) as avg_length,
          COUNT(DISTINCT h.id) as unique_contacts,
          MIN(${DATE_EXPR}) as earliest,
          MAX(${DATE_EXPR}) as latest
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
      `;
      const summary = db.prepare(summSql).get(bindings);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ summary, by_period: rows }, null, 2),
        }],
      };
    },
  );

  // -- contact_stats --
  server.tool(
    "contact_stats",
    "Deep per-contact analytics: message volumes, response time estimates, conversation patterns, and yearly trends.",
    {
      contact: z.string().describe("Contact handle or name fragment"),
      date_from: z.string().optional().describe("Start date"),
      date_to: z.string().optional().describe("End date"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();

      const dateFilter = [];
      const bindings: Record<string, any> = {};
      bindings.contact = `%${params.contact}%`;

      if (params.date_from) {
        dateFilter.push(`${DATE_EXPR} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        dateFilter.push(`${DATE_EXPR} <= @date_to`);
        bindings.date_to = params.date_to;
      }

      const extraWhere = dateFilter.length > 0 ? "AND " + dateFilter.join(" AND ") : "";

      // Basic stats
      const stats = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as total,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          ROUND(AVG(LENGTH(m.text)), 1) as avg_length,
          ROUND(AVG(CASE WHEN m.is_from_me = 1 THEN LENGTH(m.text) END), 1) as avg_sent_length,
          ROUND(AVG(CASE WHEN m.is_from_me = 0 THEN LENGTH(m.text) END), 1) as avg_received_length,
          MIN(${DATE_EXPR}) as first_message,
          MAX(${DATE_EXPR}) as last_message,
          SUM(m.cache_has_attachments) as attachment_count
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id LIKE @contact AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${extraWhere}
        GROUP BY h.id
        ORDER BY total DESC
      `).all(bindings) as any[];

      if (stats.length === 0) {
        return { content: [{ type: "text", text: `No messages found for "${params.contact}"` }] };
      }

      // Monthly trend for top handle
      const topHandle = stats[0].handle;
      const monthly = db.prepare(`
        SELECT
          strftime('%Y-%m', ${DATE_EXPR}) as month,
          COUNT(*) as total,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id = @handle AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${extraWhere}
        GROUP BY month
        ORDER BY month
      `).all({ ...bindings, handle: topHandle });

      // Hour-of-day distribution
      const hourly = db.prepare(`
        SELECT
          CAST(strftime('%H', ${DATE_EXPR}) AS INTEGER) as hour,
          COUNT(*) as total,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id = @handle AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${extraWhere}
        GROUP BY hour
        ORDER BY hour
      `).all({ ...bindings, handle: topHandle });

      const contact = lookupContact(topHandle);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            contact: { handle: topHandle, name: contact.name, tier: contact.tier },
            stats: stats[0],
            monthly_trend: monthly,
            hourly_distribution: hourly,
            all_matching_handles: stats.length > 1 ? stats : undefined,
          }, null, 2),
        }],
      };
    },
  );

  // -- temporal_heatmap --
  server.tool(
    "temporal_heatmap",
    "Generate a 7x24 activity heatmap (day-of-week x hour-of-day). Returns message counts for each of the 168 weekly time slots. By default excludes contacts you've never replied to.",
    {
      contact: z.string().optional().describe("Filter by contact handle"),
      date_from: z.string().optional().describe("Start date"),
      date_to: z.string().optional().describe("End date"),
      sent_only: z.boolean().optional().describe("Only your messages"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();

      const conditions: string[] = baseMessageConditions();
      const bindings: Record<string, any> = {};

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
      if (params.sent_only) {
        conditions.push("m.is_from_me = 1");
      }
      if (!params.include_all && !params.contact) {
        conditions.push(repliedToCondition());
      }

      const where = conditions.join(" AND ");

      const sql = `
        SELECT
          CAST(strftime('%w', ${DATE_EXPR}) AS INTEGER) as dow,
          CAST(strftime('%H', ${DATE_EXPR}) AS INTEGER) as hour,
          COUNT(*) as count
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY dow, hour
        ORDER BY dow, hour
      `;
      const rows = db.prepare(sql).all(bindings) as any[];

      // Build 7x24 matrix
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const matrix: Record<string, number[]> = {};
      for (let d = 0; d < 7; d++) {
        matrix[dayNames[d]] = new Array(24).fill(0);
      }
      for (const row of rows) {
        matrix[dayNames[row.dow]][row.hour] = row.count;
      }

      // Find peak slots
      const peaks = rows
        .sort((a: any, b: any) => b.count - a.count)
        .slice(0, 5)
        .map((r: any) => ({
          day: dayNames[r.dow],
          hour: `${r.hour}:00`,
          count: r.count,
        }));

      const total = rows.reduce((sum: number, r: any) => sum + r.count, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ total_messages: total, peak_slots: peaks, heatmap: matrix }, null, 2),
        }],
      };
    },
  );
}
