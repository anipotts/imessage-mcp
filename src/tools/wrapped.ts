// Wrapped tool — yearly_wrapped (Spotify Wrapped for iMessage)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, MSG_FILTER, REACTION_TYPES, EFFECT_NAMES, repliedToCondition } from "../db.js";
import { lookupContact } from "../contacts.js";

export function registerWrappedTools(server: McpServer) {
  server.tool(
    "yearly_wrapped",
    "Your iMessage Year in Review — like Spotify Wrapped but for texting. Returns a complete summary of a year: total messages, top contacts, busiest day, monthly trends, reactions, group chats, media shared, late-night texting, new contacts, and effects used. By default excludes contacts you've never replied to. Defaults to last year.",
    {
      year: z.number().optional().describe("Year to summarize (default: last year)"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const year = params.year ?? new Date().getFullYear() - 1;
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31 23:59:59`;
      const b = { start: yearStart, end: yearEnd };

      const repliedTo = params.include_all ? '' : `AND ${repliedToCondition()}`;

      // 1. Overview
      const overview = db.prepare(`
        SELECT
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          COUNT(DISTINCT h.id) as unique_contacts,
          ROUND(AVG(LENGTH(m.text)), 1) as avg_message_length
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
      `).get(b) as any;

      if (!overview || overview.total_messages === 0) {
        return { content: [{ type: "text", text: `No messages found for ${year}.` }] };
      }

      // 2. Top 10 contacts
      const topContacts = db.prepare(`
        SELECT h.id as handle, COUNT(*) as messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
        GROUP BY h.id ORDER BY messages DESC LIMIT 10
      `).all(b) as any[];

      const enrichedContacts = topContacts.map((row: any) => {
        const c = lookupContact(row.handle);
        return { handle: row.handle, name: c.name, messages: row.messages, sent: row.sent, received: row.received };
      });

      // 3. Busiest day
      const busiestDay = db.prepare(`
        SELECT strftime('%Y-%m-%d', ${DATE_EXPR}) as day, COUNT(*) as messages
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
        GROUP BY day ORDER BY messages DESC LIMIT 1
      `).get(b) as any;

      // 4. Busiest month
      const busiestMonth = db.prepare(`
        SELECT strftime('%Y-%m', ${DATE_EXPR}) as month, COUNT(*) as messages
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
        GROUP BY month ORDER BY messages DESC LIMIT 1
      `).get(b) as any;

      // 5. Monthly trend
      const monthlyTrend = db.prepare(`
        SELECT strftime('%Y-%m', ${DATE_EXPR}) as month, COUNT(*) as messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
        GROUP BY month ORDER BY month
      `).all(b);

      // 6. Reaction breakdown
      const reactionRows = db.prepare(`
        SELECT m.associated_message_type as type_code, COUNT(*) as count
        FROM message m
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND m.associated_message_type BETWEEN 2000 AND 2005
        GROUP BY type_code ORDER BY count DESC
      `).all(b) as any[];

      const reactions: Record<string, number> = {};
      for (const r of reactionRows) {
        reactions[REACTION_TYPES[r.type_code] || `unknown_${r.type_code}`] = r.count;
      }

      // 7. Top group chats
      const topGroups = db.prepare(`
        SELECT c.display_name, c.chat_identifier, COUNT(*) as messages
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE c.chat_identifier LIKE 'chat%'
          AND ${DATE_EXPR} BETWEEN @start AND @end
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
        GROUP BY c.ROWID ORDER BY messages DESC LIMIT 5
      `).all(b);

      // 8. Media shared
      const mediaRows = db.prepare(`
        SELECT
          CASE
            WHEN a.mime_type LIKE 'image/%' THEN 'images'
            WHEN a.mime_type LIKE 'video/%' THEN 'videos'
            WHEN a.mime_type LIKE 'audio/%' THEN 'audio'
            ELSE 'other'
          END as media_type,
          COUNT(*) as count
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        JOIN message m ON maj.message_id = m.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
        GROUP BY media_type ORDER BY count DESC
      `).all(b) as any[];

      const media: Record<string, number> = {};
      for (const r of mediaRows) media[r.media_type] = r.count;

      // 9. Late-night stats (midnight to 5am)
      const lateNight = db.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND CAST(strftime('%H', ${DATE_EXPR}) AS INTEGER) < 5
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
      `).get(b) as any;

      // 10. New contacts this year (first-ever message is in this year)
      const newContactRows = db.prepare(`
        WITH first_ever AS (
          SELECT h.id as handle, MIN(${DATE_EXPR}) as first_msg
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER} ${repliedTo}
          GROUP BY h.id
        )
        SELECT handle, first_msg
        FROM first_ever
        WHERE first_msg BETWEEN @start AND @end
        ORDER BY first_msg
      `).all(b) as any[];

      const newContacts = newContactRows.map((r: any) => {
        const c = lookupContact(r.handle);
        return { handle: r.handle, name: c.name, first_message: r.first_msg };
      });

      // 11. Effects used
      const effectRows = db.prepare(`
        SELECT m.expressive_send_style_id as effect_id, COUNT(*) as count
        FROM message m
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND m.expressive_send_style_id IS NOT NULL
          AND m.expressive_send_style_id <> ''
        GROUP BY effect_id ORDER BY count DESC
      `).all(b) as any[];

      const effects = effectRows.map((r: any) => ({
        effect: EFFECT_NAMES[r.effect_id] || r.effect_id,
        count: r.count,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            year,
            overview,
            top_contacts: enrichedContacts,
            busiest_day: busiestDay,
            busiest_month: busiestMonth,
            monthly_trend: monthlyTrend,
            reactions,
            top_group_chats: topGroups,
            media_shared: media,
            late_night: lateNight,
            new_contacts: newContacts,
            effects,
          }, null, 2),
        }],
      };
    },
  );
}
