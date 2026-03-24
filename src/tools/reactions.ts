// Reaction tools -- get_reactions (tapback analytics)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, APPLE_EPOCH_OFFSET, REACTION_TYPES, getMessageText, safeText } from "../db.js";
import { lookupContact, resolveByName } from "../contacts.js";
import { clamp, DEFAULT_LIMIT, MAX_LIMIT, isoDateSchema } from "../helpers.js";

export function registerReactionTools(server: McpServer) {
  server.tool(
    "get_reactions",
    "Tapback/reaction analytics: distribution by type, top reactors, most-reacted messages, emoji breakdown. Queries associated_message_type 2000-2005 for love/like/dislike/laugh/emphasize/question reactions.",
    {
      contact: z.string().optional().describe("Filter by contact handle or name"),
      reaction_type: z.enum(["love", "like", "dislike", "laugh", "emphasize", "question"]).optional()
        .describe("Filter by specific reaction type"),
      date_from: isoDateSchema.optional().describe("Start date (ISO)"),
      date_to: isoDateSchema.optional().describe("End date (ISO)"),
      sent_only: z.boolean().optional().describe("Only reactions sent by you"),
      limit: z.number().optional().describe("Max results for top lists (default 20)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 20, 1, MAX_LIMIT);

      const DATE = `datetime(m.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;

      const conditions: string[] = [
        "m.associated_message_type BETWEEN 2000 AND 2005",
      ];
      const bindings: Record<string, any> = {};

      if (params.contact) {
        // Check if contact looks like a phone/email (contains @ or starts with +/digit)
        const isHandle = /^[+\d]|@/.test(params.contact.trim());
        if (isHandle) {
          conditions.push("h.id LIKE @contact");
          bindings.contact = `%${params.contact}%`;
        } else {
          // Name-based: reverse-resolve from AddressBook
          const nameKeys = resolveByName(params.contact);
          if (nameKeys.length > 0) {
            const orClauses = nameKeys.map((_, i) => `h.id LIKE @nk${i}`);
            conditions.push(`(${orClauses.join(" OR ")})`);
            nameKeys.forEach((key, i) => {
              bindings[`nk${i}`] = `%${key}%`;
            });
          } else {
            conditions.push("h.id LIKE @contact");
            bindings.contact = `%${params.contact}%`;
          }
        }
      }
      if (params.reaction_type) {
        const typeCode = Object.entries(REACTION_TYPES)
          .find(([_, name]) => name === params.reaction_type)?.[0];
        if (typeCode) {
          conditions.push("m.associated_message_type = @reaction_code");
          bindings.reaction_code = parseInt(typeCode);
        }
      }
      if (params.date_from) {
        conditions.push(`${DATE} >= @date_from`);
        bindings.date_from = params.date_from;
      }
      if (params.date_to) {
        conditions.push(`${DATE} <= @date_to`);
        bindings.date_to = params.date_to;
      }
      if (params.sent_only) {
        conditions.push("m.is_from_me = 1");
      }

      const where = conditions.join(" AND ");

      // Reaction distribution by type
      const distribution = db.prepare(`
        SELECT
          m.associated_message_type as type_code,
          COUNT(*) as count
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY m.associated_message_type
        ORDER BY count DESC
      `).all(bindings) as any[];

      const reactionDist = distribution.map((row: any) => ({
        reaction: REACTION_TYPES[row.type_code] || `unknown_${row.type_code}`,
        count: row.count,
      }));

      // Top reactors (who sends the most reactions)
      const topReactors = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as reaction_count,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY h.id
        ORDER BY reaction_count DESC
        LIMIT @limit
      `).all({ ...bindings, limit }) as any[];

      const enrichedReactors = topReactors.map((row: any) => {
        const contact = row.handle ? lookupContact(row.handle) : { name: "(me)", tier: "known" };
        return {
          handle: row.handle || "(me)",
          name: contact.name,
          reaction_count: row.reaction_count,
          sent: row.sent,
          received: row.received,
        };
      });

      // Most-reacted messages (messages that received the most tapbacks)
      const mostReacted = db.prepare(`
        SELECT
          r.associated_message_guid as parent_guid,
          COUNT(*) as reaction_count,
          GROUP_CONCAT(DISTINCT CASE
            WHEN r.associated_message_type = 2000 THEN 'love'
            WHEN r.associated_message_type = 2001 THEN 'like'
            WHEN r.associated_message_type = 2002 THEN 'dislike'
            WHEN r.associated_message_type = 2003 THEN 'laugh'
            WHEN r.associated_message_type = 2004 THEN 'emphasize'
            WHEN r.associated_message_type = 2005 THEN 'question'
          END) as reaction_types,
          p.text as reacted_to_text,
          p.attributedBody as reacted_to_attributedBody,
          ${DATE_EXPR.replace(/\bm\./g, 'p.')} as date,
          p.is_from_me,
          h2.id as handle
        FROM message r
        JOIN message p ON r.associated_message_guid = p.guid
        LEFT JOIN handle h ON r.handle_id = h.ROWID
        LEFT JOIN handle h2 ON p.handle_id = h2.ROWID
        WHERE r.associated_message_type BETWEEN 2000 AND 2005
          ${params.contact ? (bindings.contact !== undefined
            ? "AND (h.id LIKE @contact OR h2.id LIKE @contact)"
            : `AND (${Object.keys(bindings).filter(k => k.startsWith("nk")).map(k => `h.id LIKE @${k} OR h2.id LIKE @${k}`).join(" OR ")})`) : ""}
          ${params.date_from ? `AND ${DATE.replace(/\bm\./g, 'r.')} >= @date_from` : ""}
          ${params.date_to ? `AND ${DATE.replace(/\bm\./g, 'r.')} <= @date_to` : ""}
        GROUP BY r.associated_message_guid
        ORDER BY reaction_count DESC
        LIMIT @limit
      `).all({ ...bindings, limit }) as any[];

      // Post-process: extract text from attributedBody when text is null
      for (const row of mostReacted) {
        row.reacted_to_text = safeText(getMessageText({ text: row.reacted_to_text, attributedBody: row.reacted_to_attributedBody }));
        delete row.reacted_to_attributedBody;
      }

      // Total count
      const totalRow = db.prepare(`
        SELECT COUNT(*) as total FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
      `).get(bindings) as any;

      // Emoji reactions (associated_message_emoji column if available)
      let emojiBreakdown: any[] = [];
      try {
        emojiBreakdown = db.prepare(`
          SELECT
            m.associated_message_emoji as emoji,
            COUNT(*) as count
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          WHERE m.associated_message_emoji IS NOT NULL
            AND m.associated_message_emoji <> ''
            ${params.contact ? (bindings.contact !== undefined
              ? "AND h.id LIKE @contact"
              : `AND (${Object.keys(bindings).filter(k => k.startsWith("nk")).map(k => `h.id LIKE @${k}`).join(" OR ")})`) : ""}
            ${params.date_from ? `AND ${DATE} >= @date_from` : ""}
            ${params.date_to ? `AND ${DATE} <= @date_to` : ""}
          GROUP BY m.associated_message_emoji
          ORDER BY count DESC
          LIMIT @limit
        `).all({ ...bindings, limit }) as any[];
      } catch {
        // Column may not exist in older macOS versions
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_reactions: totalRow?.total ?? 0,
            distribution: reactionDist,
            top_reactors: enrichedReactors,
            most_reacted_messages: mostReacted,
            emoji_reactions: emojiBreakdown.length > 0 ? emojiBreakdown : undefined,
          }, null, 2),
        }],
      };
    },
  );
}
