// Contact tools -- list_contacts, get_contact, resolve_contact

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, MSG_FILTER, repliedToCondition } from "../db.js";
import { lookupContact } from "../contacts.js";
import { clamp, DEFAULT_LIMIT, MAX_LIMIT } from "../helpers.js";

export function registerContactTools(server: McpServer) {
  // -- list_contacts --
  server.tool(
    "list_contacts",
    "List all contacts with message counts and tier assignments. Supports filtering by tier and minimum message threshold. By default, only shows contacts you've actually messaged (replied to). Use include_all to see all.",
    {
      tier: z.enum(["known", "unknown"]).optional()
        .describe("Filter by contact tier"),
      min_messages: z.number().optional().describe("Minimum message count to include"),
      sort_by: z.enum(["messages", "name", "recent"]).optional().describe("Sort order (default: messages)"),
      include_all: z.boolean().optional().describe("Include messages from all contacts, even those you've never replied to (default: false)"),
      limit: z.number().optional().describe("Max results (default 50, max 500)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
      const minMessages = params.min_messages ?? 0;

      const orderBy = params.sort_by === "name" ? "h.id"
        : params.sort_by === "recent" ? "MAX(m.date) DESC"
        : "COUNT(*) DESC";

      const repliedTo = params.include_all ? '' : `AND ${repliedToCondition()}`;

      const sql = `
        SELECT
          h.id as handle,
          COUNT(*) as message_count,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          MIN(${DATE_EXPR}) as first_message,
          MAX(${DATE_EXPR}) as last_message
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
          ${MSG_FILTER} ${repliedTo}
        GROUP BY h.id
        HAVING COUNT(*) >= @min_messages
        ORDER BY ${orderBy}
        LIMIT @limit
      `;
      const rows = db.prepare(sql).all({ min_messages: minMessages, limit }) as any[];

      // Enrich with contact info and filter by tier
      const enriched = rows.map((row) => {
        const contact = lookupContact(row.handle);
        return {
          handle: row.handle,
          name: contact.name,
          tier: contact.tier,
          message_count: row.message_count,
          sent: row.sent,
          received: row.received,
          first_message: row.first_message,
          last_message: row.last_message,
        };
      });

      const filtered = params.tier
        ? enriched.filter((c) => c.tier === params.tier)
        : enriched;

      return {
        content: [{
          type: "text",
          text: `${filtered.length} contact(s)\n\n${JSON.stringify(filtered, null, 2)}`,
        }],
      };
    },
  );

  // -- get_contact --
  server.tool(
    "get_contact",
    "Deep info on a specific contact: tier, message stats, yearly breakdown, and recent messages.",
    {
      contact: z.string().describe("Contact handle (phone/email) or name fragment"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const handle = params.contact;

      // Find matching handles
      const handles = db.prepare(`
        SELECT DISTINCT h.id FROM handle h WHERE h.id LIKE @pattern
      `).all({ pattern: `%${handle}%` }) as any[];

      if (handles.length === 0) {
        return { content: [{ type: "text", text: `No contact found matching "${handle}"` }] };
      }

      const results: any[] = [];
      for (const { id } of handles) {
        const contact = lookupContact(id);

        // Overall stats
        const stats = db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
            AVG(LENGTH(m.text)) as avg_length,
            MIN(${DATE_EXPR}) as first_message,
            MAX(${DATE_EXPR}) as last_message
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE h.id = @id AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
        `).get({ id }) as any;

        // Yearly breakdown
        const yearly = db.prepare(`
          SELECT
            strftime('%Y', ${DATE_EXPR}) as year,
            COUNT(*) as messages,
            SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE h.id = @id AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
          GROUP BY year
          ORDER BY year
        `).all({ id });

        results.push({
          handle: id,
          name: contact.name,
          tier: contact.tier,
          stats,
          yearly_breakdown: yearly,
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // -- resolve_contact --
  server.tool(
    "resolve_contact",
    "Fuzzy-match a name, phone number, or email to a contact record. Uses multi-level resolution: exact match, digits, fuzzy, and macOS AddressBook.",
    {
      query: z.string().describe("Name, phone number, or email to resolve"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const query = params.query;

      // Try direct lookup via contacts.ts
      const contact = lookupContact(query);

      // Also search handles in the database
      const dbMatches = db.prepare(`
        SELECT h.id, COUNT(*) as msg_count
        FROM handle h
        JOIN message m ON m.handle_id = h.ROWID
        WHERE h.id LIKE @pattern AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
        GROUP BY h.id
        ORDER BY msg_count DESC
        LIMIT 10
      `).all({ pattern: `%${query}%` }) as any[];

      // Search by name via display_name in chats
      const nameMatches = db.prepare(`
        SELECT DISTINCT h.id
        FROM handle h
        JOIN chat_handle_join chj ON h.ROWID = chj.handle_id
        JOIN chat c ON chj.chat_id = c.ROWID
        WHERE c.display_name LIKE @pattern
        LIMIT 10
      `).all({ pattern: `%${query}%` }) as any[];

      const allHandles = new Set<string>();
      if (contact.tier !== "unknown") allHandles.add(contact.id);
      for (const m of dbMatches) allHandles.add(m.id);
      for (const m of nameMatches) allHandles.add(m.id);

      const results = [...allHandles].map((id) => {
        const c = lookupContact(id);
        const match = dbMatches.find((m: any) => m.id === id);
        return {
          handle: id,
          name: c.name,
          tier: c.tier,
          message_count: match?.msg_count ?? 0,
        };
      });

      return {
        content: [{
          type: "text",
          text: results.length > 0
            ? `${results.length} match(es) for "${query}":\n\n${JSON.stringify(results, null, 2)}`
            : `No matches found for "${query}"`,
        }],
      };
    },
  );
}
