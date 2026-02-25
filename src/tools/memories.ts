// Memory tools — on_this_day, first_last_message

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, MSG_FILTER, getMessageText, repliedToCondition } from "../db.js";
import { lookupContact } from "../contacts.js";
import { clamp } from "../helpers.js";

export function registerMemoryTools(server: McpServer) {
  // -- on_this_day --
  server.tool(
    "on_this_day",
    "Messages from this date in previous years — like 'Memories' for iMessage. Shows what you and your contacts were talking about exactly 1, 2, 3+ years ago today. By default excludes contacts you've never replied to.",
    {
      date: z.string().optional().describe("Date to look up (ISO format, default: today)"),
      month_day: z.string().optional().describe("Month-day to look up (MM-DD format, e.g. '12-25' for Christmas). Defaults to today."),
      contact: z.string().optional().describe("Filter by contact handle or name"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
      limit: z.number().optional().describe("Max messages per year (default 5)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const perYear = clamp(params.limit ?? 5, 1, 50);

      const now = new Date();
      const currentYear = now.getFullYear();

      let monthDay: string;
      if (params.month_day) {
        const match = params.month_day.match(/^(\d{1,2})-(\d{1,2})$/);
        if (!match) {
          return { content: [{ type: "text", text: `Invalid month_day format "${params.month_day}". Use MM-DD (e.g., "12-25").` }] };
        }
        const month = parseInt(match[1]);
        const day = parseInt(match[2]);
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          return { content: [{ type: "text", text: `Invalid month_day "${params.month_day}". Month must be 01-12, day must be 01-31.` }] };
        }
        monthDay = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      } else if (params.date) {
        const d = new Date(params.date + "T12:00:00");
        monthDay = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      } else {
        monthDay = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      }

      const conditions = [
        `strftime('%m-%d', ${DATE_EXPR}) = @month_day`,
        `strftime('%Y', ${DATE_EXPR}) <> @current_year`,
        "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)",
        "m.associated_message_type = 0",
      ];
      const bindings: Record<string, any> = { month_day: monthDay, current_year: String(currentYear) };

      if (params.contact) {
        conditions.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }
      if (!params.include_all && !params.contact) {
        conditions.push(repliedToCondition());
      }

      const where = conditions.join(" AND ");

      // Year breakdown
      const years = db.prepare(`
        SELECT strftime('%Y', ${DATE_EXPR}) as year, COUNT(*) as message_count
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY year ORDER BY year DESC
      `).all(bindings) as any[];

      if (years.length === 0) {
        return { content: [{ type: "text", text: `No messages found for ${monthDay} in previous years.` }] };
      }

      // Add years_ago to each year result
      const yearsEnriched = years.map((y: any) => ({
        ...y,
        years_ago: currentYear - parseInt(y.year),
      }));

      // Fetch messages
      const messages = db.prepare(`
        SELECT m.text, m.attributedBody, m.is_from_me, ${DATE_EXPR} as date,
          h.id as handle, strftime('%Y', ${DATE_EXPR}) as year
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
      `).all(bindings) as any[];

      // Group by year, limit per year, enrich
      const byYear: Record<string, any[]> = {};
      for (const msg of messages) {
        msg.text = getMessageText(msg);
        delete msg.attributedBody;
        if (!msg.text) continue;
        const yr = msg.year;
        if (!byYear[yr]) byYear[yr] = [];
        if (byYear[yr].length < perYear) {
          if (msg.handle) {
            const c = lookupContact(msg.handle);
            msg.contact_name = c.name;
          }
          delete msg.year;
          byYear[yr].push(msg);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            lookup_date: `${currentYear}-${monthDay}`,
            years_with_messages: yearsEnriched,
            messages_by_year: byYear,
          }, null, 2),
        }],
      };
    },
  );

  // -- first_last_message --
  server.tool(
    "first_last_message",
    "The very first and very last message ever exchanged with a contact. People use this for sentimental lookups like 'what was the first text I sent my partner?' or 'what was the last thing my grandparent texted me?'",
    {
      contact: z.string().describe("Contact handle (phone/email) or name"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const pattern = `%${params.contact}%`;

      const first = db.prepare(`
        SELECT m.text, m.attributedBody, m.is_from_me, ${DATE_EXPR} as date, h.id as handle
        FROM message m JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id LIKE @contact ${MSG_FILTER}
        ORDER BY m.date ASC LIMIT 1
      `).get({ contact: pattern }) as any;

      if (!first) {
        return { content: [{ type: "text", text: `No messages found for "${params.contact}"` }] };
      }

      const last = db.prepare(`
        SELECT m.text, m.attributedBody, m.is_from_me, ${DATE_EXPR} as date, h.id as handle
        FROM message m JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id LIKE @contact ${MSG_FILTER}
        ORDER BY m.date DESC LIMIT 1
      `).get({ contact: pattern }) as any;

      const stats = db.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id LIKE @contact ${MSG_FILTER}
      `).get({ contact: pattern }) as any;

      first.text = getMessageText(first);
      delete first.attributedBody;
      last.text = getMessageText(last);
      delete last.attributedBody;

      const contact = lookupContact(first.handle);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            contact: { handle: first.handle, name: contact.name },
            total_messages: stats.total,
            sent: stats.sent,
            received: stats.received,
            first_message: {
              text: first.text,
              date: first.date,
              from: first.is_from_me ? "you" : contact.name,
            },
            last_message: {
              text: last.text,
              date: last.date,
              from: last.is_from_me ? "you" : contact.name,
            },
          }, null, 2),
        }],
      };
    },
  );
}
