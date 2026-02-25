// Message tools -- search_messages, get_conversation

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, baseMessageConditions, getMessageText, repliedToCondition } from "../db.js";
import { formatResults, clamp, DEFAULT_LIMIT, MAX_LIMIT } from "../helpers.js";

export function registerMessageTools(server: McpServer) {
  // -- search_messages --
  server.tool(
    "search_messages",
    "Full-text search across all iMessages with rich filtering. Supports query text, contact, date range, direction, group chat, and attachment filters. By default, only searches contacts you've messaged. Use include_all to search everything.",
    {
      query: z.string().optional().describe("Text to search for (case-insensitive substring match)"),
      contact: z.string().optional().describe("Filter by contact handle (phone/email) or name"),
      date_from: z.string().optional().describe("Start date (ISO format, e.g. 2024-01-01)"),
      date_to: z.string().optional().describe("End date (ISO format, e.g. 2024-12-31)"),
      sent_only: z.boolean().optional().describe("Only messages sent by you"),
      received_only: z.boolean().optional().describe("Only messages received"),
      group_chat: z.string().optional().describe("Filter by group chat name or chat_identifier"),
      has_attachment: z.boolean().optional().describe("Only messages with attachments"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
      limit: z.number().optional().describe("Max results (default 50, max 500)"),
      offset: z.number().optional().describe("Pagination offset"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
      const offset = params.offset ?? 0;

      // Build shared conditions (everything except text search)
      const shared: string[] = baseMessageConditions();
      const bindings: Record<string, any> = {};

      if (!params.include_all && !params.contact) {
        shared.push(repliedToCondition());
      }
      if (params.contact) {
        shared.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }
      if (params.date_from) {
        shared.push(`${DATE_EXPR} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        shared.push(`${DATE_EXPR} <= @date_to`);
        bindings.date_to = params.date_to;
      }
      if (params.sent_only) {
        shared.push("m.is_from_me = 1");
      }
      if (params.received_only) {
        shared.push("m.is_from_me = 0");
      }
      if (params.group_chat) {
        shared.push("(c.display_name LIKE @group_chat OR c.chat_identifier LIKE @group_chat)");
        bindings.group_chat = `%${params.group_chat}%`;
      }
      if (params.has_attachment) {
        shared.push("m.cache_has_attachments = 1");
      }

      const selectCols = `
        m.ROWID as rowid, m.text, m.attributedBody, m.is_from_me,
        ${DATE_EXPR} as date, h.id as handle,
        c.display_name as group_name, c.chat_identifier as chat_id,
        m.cache_has_attachments as has_attachment`;
      const fromJoins = `
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        JOIN chat c ON cmj.chat_id = c.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID`;

      if (params.query) {
        // Two-pass search: text column (fast SQL LIKE) + attributedBody (JS extraction)
        const queryLower = params.query.toLowerCase();

        // Pass 1: Search text column directly
        const textWhere = [...shared, "m.text LIKE @query"].join(" AND ");
        bindings.query = `%${params.query}%`;

        const textTotal = (db.prepare(
          `SELECT COUNT(*) as total ${fromJoins} WHERE ${textWhere}`
        ).get(bindings) as any)?.total ?? 0;

        const textRows = db.prepare(
          `SELECT ${selectCols} ${fromJoins} WHERE ${textWhere} ORDER BY m.date DESC LIMIT @limit OFFSET @offset`
        ).all({ ...bindings, limit, offset }) as any[];

        for (const row of textRows) {
          row.text = getMessageText(row);
          delete row.attributedBody;
        }

        // Pass 2: Stream attributedBody-only messages, extract text, filter
        const abMatches: any[] = [];
        const remaining = limit - textRows.length;

        if (remaining > 0) {
          const abWhere = [...shared, "m.text IS NULL", "m.attributedBody IS NOT NULL"].join(" AND ");
          const abStmt = db.prepare(
            `SELECT ${selectCols} ${fromJoins} WHERE ${abWhere} ORDER BY m.date DESC`
          );
          const MAX_SCAN = 10_000;
          let scanned = 0;
          for (const row of abStmt.iterate(bindings) as Iterable<any>) {
            if (++scanned > MAX_SCAN) break;
            const text = getMessageText(row);
            if (text && text.toLowerCase().includes(queryLower)) {
              row.text = text;
              delete row.attributedBody;
              abMatches.push(row);
              if (abMatches.length >= remaining) break;
            }
          }
        }

        // Merge and sort by date descending
        const merged = [...textRows, ...abMatches];
        merged.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

        return {
          content: [{ type: "text", text: formatResults(merged.slice(0, limit), textTotal, offset, limit) }],
        };
      } else {
        // No query — straightforward fetch
        const where = shared.join(" AND ");

        const total = (db.prepare(
          `SELECT COUNT(*) as total ${fromJoins} WHERE ${where}`
        ).get(bindings) as any)?.total ?? 0;

        const rows = db.prepare(
          `SELECT ${selectCols} ${fromJoins} WHERE ${where} ORDER BY m.date DESC LIMIT @limit OFFSET @offset`
        ).all({ ...bindings, limit, offset }) as any[];

        for (const row of rows) {
          row.text = getMessageText(row);
          delete row.attributedBody;
        }

        return {
          content: [{ type: "text", text: formatResults(rows, total, offset, limit) }],
        };
      }
    },
  );

  // -- get_conversation --
  server.tool(
    "get_conversation",
    "Get a full conversation thread with a specific contact or chat. Supports cursor-based pagination via before_rowid for scrolling through history.",
    {
      contact: z.string().optional().describe("Contact handle (phone/email) or name"),
      chat_id: z.string().optional().describe("Chat identifier (e.g. chat123456789)"),
      limit: z.number().optional().describe("Max messages (default 50, max 500)"),
      before_rowid: z.number().optional().describe("Cursor: only messages before this ROWID (for pagination)"),
      date_from: z.string().optional().describe("Start date filter"),
      date_to: z.string().optional().describe("End date filter"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);

      if (!params.contact && !params.chat_id) {
        return { content: [{ type: "text", text: "Error: provide either 'contact' or 'chat_id'" }] };
      }

      const conditions: string[] = baseMessageConditions();
      const bindings: Record<string, any> = {};

      if (params.chat_id) {
        conditions.push("c.chat_identifier = @chat_id");
        bindings.chat_id = params.chat_id;
      } else if (params.contact) {
        conditions.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }

      if (params.before_rowid) {
        conditions.push("m.ROWID < @before_rowid");
        bindings.before_rowid = params.before_rowid;
      }
      if (params.date_from) {
        conditions.push(`${DATE_EXPR} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        conditions.push(`${DATE_EXPR} <= @date_to`);
        bindings.date_to = params.date_to;
      }

      const where = conditions.join(" AND ");

      const sql = `
        SELECT
          m.ROWID as rowid,
          m.text,
          m.attributedBody,
          m.is_from_me,
          ${DATE_EXPR} as date,
          h.id as handle,
          c.display_name as group_name
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        JOIN chat c ON cmj.chat_id = c.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
        LIMIT @limit
      `;
      const rows = db.prepare(sql).all({ ...bindings, limit }) as any[];

      // Post-process: extract text from attributedBody when text is null
      for (const row of rows) {
        row.text = getMessageText(row);
        delete row.attributedBody;
      }

      // Reverse to chronological order
      rows.reverse();

      const firstRowid = rows.length > 0 ? (rows[0] as any).rowid : null;
      const result = {
        messages: rows,
        count: rows.length,
        cursor: firstRowid ? { before_rowid: firstRowid } : null,
        has_more: rows.length === limit,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
