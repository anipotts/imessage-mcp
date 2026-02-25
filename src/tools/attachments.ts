// Attachment tools -- list_attachments

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, getMessageText, safeText } from "../db.js";
import { clamp, DEFAULT_LIMIT, MAX_LIMIT, isoDateSchema } from "../helpers.js";

export function registerAttachmentTools(server: McpServer) {
  // -- list_attachments --
  server.tool(
    "list_attachments",
    "Query message attachments (images, videos, audio, documents) with filtering by contact, MIME type, and date range. Returns file metadata, not file contents.",
    {
      contact: z.string().optional().describe("Filter by contact handle"),
      mime_type: z.string().optional().describe("Filter by MIME type prefix (e.g. 'image/', 'video/', 'audio/')"),
      date_from: isoDateSchema.optional().describe("Start date (ISO)"),
      date_to: isoDateSchema.optional().describe("End date (ISO)"),
      limit: z.number().optional().describe("Max results (default 50, max 500)"),
      offset: z.number().optional().describe("Pagination offset"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
      const offset = params.offset ?? 0;

      const conditions: string[] = [
        "a.filename IS NOT NULL",
      ];
      const bindings: Record<string, any> = {};

      if (params.contact) {
        conditions.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }
      if (params.mime_type) {
        conditions.push("a.mime_type LIKE @mime_type");
        bindings.mime_type = `${params.mime_type}%`;
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

      // Count
      const countSql = `
        SELECT COUNT(*) as total
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        JOIN message m ON maj.message_id = m.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
      `;
      const countRow = db.prepare(countSql).get(bindings) as any;
      const total = countRow?.total ?? 0;

      const sql = `
        SELECT
          a.ROWID as attachment_id,
          a.filename,
          a.mime_type,
          a.total_bytes,
          a.transfer_name,
          ${DATE_EXPR} as date,
          m.is_from_me,
          h.id as handle,
          m.text as message_text,
          m.attributedBody
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        JOIN message m ON maj.message_id = m.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
        LIMIT @limit OFFSET @offset
      `;
      const rows = db.prepare(sql).all({ ...bindings, limit, offset }) as any[];

      // Post-process: extract text from attributedBody when text is null
      for (const row of rows) {
        row.message_text = safeText(getMessageText({ text: row.message_text, attributedBody: row.attributedBody }));
        delete row.attributedBody;
      }

      // MIME type summary
      const typeSummary = db.prepare(`
        SELECT a.mime_type, COUNT(*) as count
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        JOIN message m ON maj.message_id = m.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY a.mime_type
        ORDER BY count DESC
        LIMIT 20
      `).all(bindings);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total,
            showing: `${offset}-${offset + (rows as any[]).length}`,
            type_summary: typeSummary,
            attachments: rows,
          }, null, 2),
        }],
      };
    },
  );
}
