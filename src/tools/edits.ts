// Edit tools -- get_edited_messages (edited + unsent message analytics)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, APPLE_EPOCH_OFFSET, DATE_EXPR, getMessageText } from "../db.js";
import { lookupContact } from "../contacts.js";
import { clamp, DEFAULT_LIMIT, MAX_LIMIT, isoDateSchema } from "../helpers.js";

export function registerEditTools(server: McpServer) {
  server.tool(
    "get_edited_messages",
    "Find edited and unsent (retracted) messages. Queries date_retracted and date_edited columns. Returns message list with timestamps and per-contact stats.",
    {
      contact: z.string().optional().describe("Filter by contact handle or name"),
      type: z.enum(["edited", "unsent", "both"]).optional()
        .describe("Type of edit to search for (default: both)"),
      date_from: isoDateSchema.optional().describe("Start date (ISO)"),
      date_to: isoDateSchema.optional().describe("End date (ISO)"),
      limit: z.number().optional().describe("Max results (default 50, max 500)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
      const editType = params.type ?? "both";

      const DATE = `datetime(m.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;
      const DATE_RETRACTED = `datetime(m.date_retracted/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;
      const DATE_EDITED = `datetime(m.date_edited/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;

      const conditions: string[] = [];
      const bindings: Record<string, any> = {};

      if (editType === "edited") {
        conditions.push("m.date_edited > 0");
      } else if (editType === "unsent") {
        conditions.push("m.date_retracted > 0");
      } else {
        conditions.push("(m.date_edited > 0 OR m.date_retracted > 0)");
      }

      if (params.contact) {
        conditions.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }
      if (params.date_from) {
        conditions.push(`${DATE} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        conditions.push(`${DATE} <= @date_to`);
        bindings.date_to = params.date_to;
      }

      const where = conditions.join(" AND ");

      // Get edited/unsent messages
      const messages = db.prepare(`
        SELECT
          m.ROWID as rowid,
          m.text,
          m.attributedBody,
          m.is_from_me,
          ${DATE} as date,
          CASE WHEN m.date_edited > 0 THEN ${DATE_EDITED} ELSE NULL END as edited_at,
          CASE WHEN m.date_retracted > 0 THEN ${DATE_RETRACTED} ELSE NULL END as retracted_at,
          CASE
            WHEN m.date_retracted > 0 THEN 'unsent'
            WHEN m.date_edited > 0 THEN 'edited'
          END as edit_type,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
        LIMIT @limit
      `).all({ ...bindings, limit }) as any[];

      // Post-process: extract text from attributedBody when text is null
      for (const row of messages) {
        row.text = getMessageText(row);
        delete row.attributedBody;
      }

      // Per-contact stats
      const contactStats = db.prepare(`
        SELECT
          h.id as handle,
          SUM(CASE WHEN m.date_edited > 0 THEN 1 ELSE 0 END) as edited_count,
          SUM(CASE WHEN m.date_retracted > 0 THEN 1 ELSE 0 END) as unsent_count,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as by_me,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as by_them,
          COUNT(*) as total
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY h.id
        ORDER BY total DESC
        LIMIT 20
      `).all(bindings) as any[];

      const enrichedStats = contactStats.map((row: any) => {
        const contact = row.handle ? lookupContact(row.handle) : { name: "(me)", tier: "known" };
        return {
          handle: row.handle || "(me)",
          name: contact.name,
          edited_count: row.edited_count,
          unsent_count: row.unsent_count,
          by_me: row.by_me,
          by_them: row.by_them,
          total: row.total,
        };
      });

      // Overall totals
      const totals = db.prepare(`
        SELECT
          SUM(CASE WHEN m.date_edited > 0 THEN 1 ELSE 0 END) as total_edited,
          SUM(CASE WHEN m.date_retracted > 0 THEN 1 ELSE 0 END) as total_unsent,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as by_me,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as by_others,
          COUNT(*) as total
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
      `).get(bindings) as any;

      // Time-to-edit stats (how long after sending before editing)
      const editTiming = db.prepare(`
        SELECT
          ROUND(AVG((m.date_edited - m.date) / 1000000000.0 / 60.0), 1) as avg_minutes_to_edit,
          ROUND(MIN((m.date_edited - m.date) / 1000000000.0 / 60.0), 1) as min_minutes,
          ROUND(MAX((m.date_edited - m.date) / 1000000000.0 / 60.0), 1) as max_minutes
        FROM message m
        WHERE m.date_edited > 0 AND m.date_edited > m.date
          ${params.contact ? "AND m.handle_id IN (SELECT ROWID FROM handle WHERE id LIKE @contact)" : ""}
      `).get(params.contact ? { contact: `%${params.contact}%` } : {}) as any;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totals,
            edit_timing: editTiming,
            by_contact: enrichedStats,
            messages,
          }, null, 2),
        }],
      };
    },
  );
}
