// Message tools -- search_messages, get_conversation

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, baseMessageConditions, getMessageText } from "../db.js";
import { formatResults, clamp, DEFAULT_LIMIT, MAX_LIMIT } from "../helpers.js";

export function registerMessageTools(server: McpServer) {
  // -- search_messages --
  server.tool(
    "search_messages",
    "Full-text search across all iMessages with rich filtering. Supports query text, contact, date range, direction, group chat, and attachment filters.",
    {
      query: z.string().optional().describe("Text to search for (case-insensitive substring match)"),
      contact: z.string().optional().describe("Filter by contact handle (phone/email) or name"),
      date_from: z.string().optional().describe("Start date (ISO format, e.g. 2024-01-01)"),
      date_to: z.string().optional().describe("End date (ISO format, e.g. 2024-12-31)"),
      sent_only: z.boolean().optional().describe("Only messages sent by you"),
      received_only: z.boolean().optional().describe("Only messages received"),
      group_chat: z.string().optional().describe("Filter by group chat name or chat_identifier"),
      has_attachment: z.boolean().optional().describe("Only messages with attachments"),
      limit: z.number().optional().describe("Max results (default 50, max 500)"),
      offset: z.number().optional().describe("Pagination offset"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
      const offset = params.offset ?? 0;

      const conditions: string[] = baseMessageConditions();
      const bindings: Record<string, any> = {};

      if (params.query) {
        conditions.push("COALESCE(m.text, '') LIKE @query");
        bindings.query = `%${params.query}%`;
      }
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
      if (params.received_only) {
        conditions.push("m.is_from_me = 0");
      }
      if (params.group_chat) {
        conditions.push("(c.display_name LIKE @group_chat OR c.chat_identifier LIKE @group_chat)");
        bindings.group_chat = `%${params.group_chat}%`;
      }
      if (params.has_attachment) {
        conditions.push("m.cache_has_attachments = 1");
      }

      const where = conditions.join(" AND ");

      // Count total
      const countSql = `
        SELECT COUNT(*) as total
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        JOIN chat c ON cmj.chat_id = c.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
      `;
      const countRow = db.prepare(countSql).get(bindings) as any;
      const total = countRow?.total ?? 0;

      // Fetch results
      const sql = `
        SELECT
          m.ROWID as rowid,
          m.text,
          m.attributedBody,
          m.is_from_me,
          ${DATE_EXPR} as date,
          h.id as handle,
          c.display_name as group_name,
          c.chat_identifier as chat_id,
          m.cache_has_attachments as has_attachment
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        JOIN chat c ON cmj.chat_id = c.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
        LIMIT @limit OFFSET @offset
      `;
      const rows = db.prepare(sql).all({ ...bindings, limit, offset }) as any[];

      // Post-process: extract text from attributedBody when text is null
      for (const row of rows) {
        row.text = getMessageText(row);
        delete row.attributedBody;
      }

      return {
        content: [{ type: "text", text: formatResults(rows, total, offset, limit) }],
      };
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
