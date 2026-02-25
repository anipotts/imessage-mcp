// Effect tools -- get_message_effects (iMessage animation/effect analytics)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, APPLE_EPOCH_OFFSET, EFFECT_NAMES, DATE_EXPR, getMessageText } from "../db.js";
import { lookupContact } from "../contacts.js";
import { clamp, MAX_LIMIT } from "../helpers.js";

export function registerEffectTools(server: McpServer) {
  server.tool(
    "get_message_effects",
    "iMessage expressive send effects and screen effects analytics: slam, loud, gentle, invisible ink, confetti, fireworks, balloons, lasers, etc. Queries expressive_send_style_id.",
    {
      contact: z.string().optional().describe("Filter by contact handle or name"),
      date_from: z.string().optional().describe("Start date (ISO)"),
      date_to: z.string().optional().describe("End date (ISO)"),
      limit: z.number().optional().describe("Max results for detail lists (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);

      const DATE = `datetime(m.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;

      const conditions: string[] = [
        "m.expressive_send_style_id IS NOT NULL",
        "m.expressive_send_style_id <> ''",
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

      // Effect distribution
      const distribution = db.prepare(`
        SELECT
          m.expressive_send_style_id as effect_id,
          COUNT(*) as count,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY m.expressive_send_style_id
        ORDER BY count DESC
      `).all(bindings) as any[];

      const effectDist = distribution.map((row: any) => ({
        effect_id: row.effect_id,
        effect_name: EFFECT_NAMES[row.effect_id] || row.effect_id,
        count: row.count,
        sent: row.sent,
        received: row.received,
      }));

      // Per-contact effect usage
      const perContact = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as effect_count,
          COUNT(DISTINCT m.expressive_send_style_id) as unique_effects,
          GROUP_CONCAT(DISTINCT m.expressive_send_style_id) as effect_ids
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY h.id
        ORDER BY effect_count DESC
        LIMIT @limit
      `).all({ ...bindings, limit }) as any[];

      const enrichedContacts = perContact.map((row: any) => {
        const contact = lookupContact(row.handle);
        const effectNames = (row.effect_ids || "")
          .split(",")
          .map((id: string) => EFFECT_NAMES[id] || id);
        return {
          handle: row.handle,
          name: contact.name,
          effect_count: row.effect_count,
          unique_effects: row.unique_effects,
          effects_used: effectNames,
        };
      });

      // Timeline: effects per month
      const timeline = db.prepare(`
        SELECT
          strftime('%Y-%m', ${DATE}) as month,
          COUNT(*) as count
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY month
        ORDER BY month
      `).all(bindings) as any[];

      // Total
      const totalRow = db.prepare(`
        SELECT COUNT(*) as total FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
      `).get(bindings) as any;

      // Recent messages with effects
      const recentEffects = db.prepare(`
        SELECT
          m.text,
          m.attributedBody,
          m.is_from_me,
          ${DATE} as date,
          m.expressive_send_style_id as effect_id,
          h.id as handle
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        ORDER BY m.date DESC
        LIMIT @limit
      `).all({ ...bindings, limit }) as any[];

      // Post-process: extract text from attributedBody when text is null
      for (const row of recentEffects) {
        row.text = getMessageText(row);
        delete row.attributedBody;
      }

      const enrichedRecent = recentEffects.map((row: any) => ({
        text: row.text,
        is_from_me: row.is_from_me,
        date: row.date,
        effect: EFFECT_NAMES[row.effect_id] || row.effect_id,
        handle: row.handle,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_effects: totalRow?.total ?? 0,
            distribution: effectDist,
            by_contact: enrichedContacts,
            timeline,
            recent: enrichedRecent,
          }, null, 2),
        }],
      };
    },
  );
}
