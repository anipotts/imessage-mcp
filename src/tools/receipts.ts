// Read receipt tools -- get_read_receipts (read/delivery timing analytics)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, APPLE_EPOCH_OFFSET, DATE_EXPR } from "../db.js";
import { lookupContact } from "../contacts.js";
import { clamp, MAX_LIMIT, isoDateSchema } from "../helpers.js";

export function registerReceiptTools(server: McpServer) {
  server.tool(
    "get_read_receipts",
    "Read receipt and delivery timing analytics: per-contact read latency stats, unread patterns, fastest/slowest readers. Queries date_read and date_delivered columns.",
    {
      contact: z.string().optional().describe("Filter by contact handle or name"),
      date_from: isoDateSchema.optional().describe("Start date (ISO)"),
      date_to: isoDateSchema.optional().describe("End date (ISO)"),
      limit: z.number().optional().describe("Max contacts to show (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);

      const DATE = `datetime(m.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;
      const DATE_READ = `datetime(m.date_read/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;
      const DATE_DELIVERED = `datetime(m.date_delivered/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;

      const conditions: string[] = [
        "m.date_read > 0",
        "m.is_from_me = 1",  // Read receipts are for messages WE sent
        "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)",
      ];
      const bindings: Record<string, any> = {};

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

      // Per-contact read latency stats
      const latencyStats = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as read_count,
          ROUND(AVG((m.date_read - m.date) / 1000000000.0 / 60.0), 1) as avg_read_minutes,
          ROUND(MIN((m.date_read - m.date) / 1000000000.0 / 60.0), 1) as min_read_minutes,
          ROUND(MAX((m.date_read - m.date) / 1000000000.0 / 60.0), 1) as max_read_minutes
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY h.id
        HAVING read_count >= 5
        ORDER BY avg_read_minutes ASC
        LIMIT @limit
      `).all({ ...bindings, limit }) as any[];

      const enrichedLatency = latencyStats.map((row: any) => {
        const contact = lookupContact(row.handle);
        return {
          handle: row.handle,
          name: contact.name,
          tier: contact.tier,
          messages_read: row.read_count,
          avg_read_minutes: row.avg_read_minutes,
          min_read_minutes: row.min_read_minutes,
          max_read_minutes: row.max_read_minutes,
        };
      });

      // Delivery timing stats (for messages received -- date_delivered on incoming)
      const deliveryStats = db.prepare(`
        SELECT
          COUNT(*) as total_delivered,
          ROUND(AVG((m.date_delivered - m.date) / 1000000000.0), 1) as avg_delivery_seconds,
          SUM(CASE WHEN m.date_delivered > 0 THEN 1 ELSE 0 END) as with_delivery_receipt
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.is_from_me = 0 AND m.date_delivered > 0
          ${params.contact ? "AND h.id LIKE @contact" : ""}
          ${params.date_from ? `AND ${DATE} >= @date_from` : ""}
          ${params.date_to ? `AND ${DATE} <= @date_to` : ""}
      `).get(bindings) as any;

      // Unread message count (sent messages with no date_read)
      const unreadStats = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as unread_count,
          MAX(${DATE}) as last_sent
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.is_from_me = 1
          AND m.date_read = 0
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
          AND m.service = 'iMessage'
          ${params.contact ? "AND h.id LIKE @contact" : ""}
          ${params.date_from ? `AND ${DATE} >= @date_from` : ""}
          ${params.date_to ? `AND ${DATE} <= @date_to` : ""}
        GROUP BY h.id
        HAVING unread_count >= 3
        ORDER BY unread_count DESC
        LIMIT @limit
      `).all(bindings) as any[];

      const enrichedUnread = unreadStats.map((row: any) => {
        const contact = lookupContact(row.handle);
        return {
          handle: row.handle,
          name: contact.name,
          unread_count: row.unread_count,
          last_sent: row.last_sent,
        };
      });

      // Read-to-reply latency: after they read our message, how long until they reply?
      // This uses a self-join: find the next incoming message after each read receipt
      const readToReply = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as sample_count,
          ROUND(AVG(reply_delay_min), 1) as avg_reply_after_read_minutes
        FROM (
          SELECT
            m.handle_id,
            (m.date_read / 1000000000.0) as read_time,
            (
              SELECT MIN(m2.date / 1000000000.0)
              FROM message m2
              WHERE m2.handle_id = m.handle_id
                AND m2.is_from_me = 0
                AND m2.date > m.date_read
                AND m2.date < m.date_read + 86400000000000
            ) as next_reply_time,
            CASE
              WHEN (
                SELECT MIN(m2.date / 1000000000.0)
                FROM message m2
                WHERE m2.handle_id = m.handle_id
                  AND m2.is_from_me = 0
                  AND m2.date > m.date_read
                  AND m2.date < m.date_read + 86400000000000
              ) IS NOT NULL
              THEN ((
                SELECT MIN(m2.date / 1000000000.0)
                FROM message m2
                WHERE m2.handle_id = m.handle_id
                  AND m2.is_from_me = 0
                  AND m2.date > m.date_read
                  AND m2.date < m.date_read + 86400000000000
              ) - (m.date_read / 1000000000.0)) / 60.0
              ELSE NULL
            END as reply_delay_min
          FROM message m
          WHERE m.is_from_me = 1 AND m.date_read > 0
            ${params.contact ? "AND m.handle_id IN (SELECT ROWID FROM handle WHERE id LIKE @contact)" : ""}
        ) sub
        JOIN handle h ON sub.handle_id = h.ROWID
        WHERE reply_delay_min IS NOT NULL AND reply_delay_min > 0
        GROUP BY h.id
        HAVING sample_count >= 3
        ORDER BY avg_reply_after_read_minutes ASC
        LIMIT @limit
      `).all(bindings) as any[];

      const enrichedReadToReply = readToReply.map((row: any) => {
        const contact = lookupContact(row.handle);
        return {
          handle: row.handle,
          name: contact.name,
          sample_count: row.sample_count,
          avg_reply_after_read_minutes: row.avg_reply_after_read_minutes,
        };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            read_latency_by_contact: enrichedLatency,
            delivery_stats: deliveryStats,
            unread_messages: enrichedUnread,
            read_to_reply_latency: enrichedReadToReply,
          }, null, 2),
        }],
      };
    },
  );
}
