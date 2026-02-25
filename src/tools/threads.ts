// Thread tools -- get_thread (reply thread reconstruction)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, DATE_EXPR, APPLE_EPOCH_OFFSET, getMessageText } from "../db.js";
import { lookupContact } from "../contacts.js";
import { clamp, MAX_LIMIT } from "../helpers.js";

export function registerThreadTools(server: McpServer) {
  server.tool(
    "get_thread",
    "Reconstruct iMessage reply threads using thread_originator_guid. Returns nested thread trees with parent message and all replies in order.",
    {
      message_guid: z.string().optional().describe("GUID of the thread originator message"),
      contact: z.string().optional().describe("Filter by contact handle or name -- shows threads from conversations with this contact"),
      limit: z.number().optional().describe("Max threads to return (default 10)"),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => {
      const db = getDb();
      const limit = clamp(params.limit ?? 10, 1, MAX_LIMIT);

      if (!params.message_guid && !params.contact) {
        return { content: [{ type: "text", text: "Error: provide either 'message_guid' or 'contact'" }] };
      }

      // If specific thread GUID provided, get that thread
      if (params.message_guid) {
        const thread = getThreadByGuid(db, params.message_guid);
        if (!thread) {
          return { content: [{ type: "text", text: `No thread found for GUID "${params.message_guid}"` }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(thread, null, 2) }],
        };
      }

      // Find threads for a contact
      const conditions: string[] = [
        "m.thread_originator_guid IS NOT NULL",
        "m.thread_originator_guid <> ''",
        "(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)",
      ];
      const bindings: Record<string, any> = {};

      if (params.contact) {
        conditions.push("h.id LIKE @contact");
        bindings.contact = `%${params.contact}%`;
      }

      const where = conditions.join(" AND ");

      // Find top threads by reply count
      const topThreads = db.prepare(`
        SELECT
          m.thread_originator_guid as guid,
          COUNT(*) as reply_count,
          MAX(${DATE_EXPR}) as last_reply
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${where}
        GROUP BY m.thread_originator_guid
        ORDER BY reply_count DESC
        LIMIT @limit
      `).all({ ...bindings, limit }) as any[];

      if (topThreads.length === 0) {
        return { content: [{ type: "text", text: `No reply threads found${params.contact ? ` for "${params.contact}"` : ""}` }] };
      }

      // Reconstruct each thread
      const threads = topThreads.map((t: any) => getThreadByGuid(db, t.guid)).filter(Boolean);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            thread_count: threads.length,
            threads,
          }, null, 2),
        }],
      };
    },
  );
}

function getThreadByGuid(db: any, guid: string): any | null {
  const DATE = `datetime(m.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime')`;

  // Get the parent message
  const parent = db.prepare(`
    SELECT
      m.guid,
      m.text,
      m.attributedBody,
      m.is_from_me,
      ${DATE} as date,
      h.id as handle
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.guid = @guid
  `).get({ guid }) as any;

  if (!parent) return null;

  // Extract text from attributedBody if needed
  parent.text = getMessageText(parent);
  delete parent.attributedBody;

  // Get all replies
  const replies = db.prepare(`
    SELECT
      m.guid,
      m.text,
      m.attributedBody,
      m.is_from_me,
      ${DATE} as date,
      h.id as handle,
      m.thread_originator_guid as parent_guid
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.thread_originator_guid = @guid
    ORDER BY m.date ASC
  `).all({ guid }) as any[];

  // Post-process replies
  for (const reply of replies) {
    reply.text = getMessageText(reply);
    delete reply.attributedBody;
  }

  const parentContact = parent.handle ? lookupContact(parent.handle) : { name: "(me)" };

  return {
    parent: {
      guid: parent.guid,
      text: parent.text,
      is_from_me: parent.is_from_me,
      date: parent.date,
      handle: parent.handle,
      name: parent.is_from_me ? "(me)" : parentContact.name,
    },
    reply_count: replies.length,
    replies: replies.map((r: any) => {
      const contact = r.handle ? lookupContact(r.handle) : { name: "(me)" };
      return {
        guid: r.guid,
        text: r.text,
        is_from_me: r.is_from_me,
        date: r.date,
        handle: r.handle,
        name: r.is_from_me ? "(me)" : contact.name,
      };
    }),
  };
}
