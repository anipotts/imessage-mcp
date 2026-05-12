// MCP resources and prompt templates for faster workflow integration.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DATE_EXPR, MSG_FILTER, getDb, getMessageText, safeText } from "./db.js";
import { lookupContact } from "./contacts.js";
import { getRequestContext } from "./context.js";
import { redactStructuredValue } from "./privacy.js";

function hasScope(granted: string[], required: string): boolean {
  if (granted.includes("*") || granted.includes("admin.*")) return true;
  if (granted.includes(required)) return true;
  const [domain] = required.split(".");
  if (domain && granted.includes(`${domain}.*`)) return true;
  return false;
}

function requireResourceScope(scope: string): void {
  const principal = getRequestContext()?.principal;
  if (!principal) return; // local stdio context
  if (!hasScope(principal.scopes, scope)) {
    throw new Error(`Access denied. Missing scope: ${scope}`);
  }
}

function jsonText(payload: unknown): string {
  return JSON.stringify(redactStructuredValue(payload), null, 2);
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "imessage-contacts",
    "imessage://contacts",
    {
      description: "Contact roster with message counts",
      mimeType: "application/json",
    },
    async () => {
      requireResourceScope("messages.read");
      const db = getDb();
      const rows = db.prepare(`
        SELECT
          h.id as handle,
          COUNT(*) as message_count,
          MAX(${DATE_EXPR}) as last_message
        FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
        GROUP BY h.id
        ORDER BY message_count DESC
        LIMIT 500
      `).all() as any[];

      const payload = rows.map((row) => {
        const c = lookupContact(row.handle);
        return {
          handle: row.handle,
          name: c.name,
          tier: c.tier,
          message_count: row.message_count,
          last_message: row.last_message,
        };
      });

      return {
        contents: [
          {
            uri: "imessage://contacts",
            mimeType: "application/json",
            text: jsonText(payload),
          },
        ],
      };
    },
  );

  const threadTemplate = new ResourceTemplate("imessage://threads/{chat_id}", {
    list: async () => {
      requireResourceScope("messages.read");
      const db = getDb();
      const chats = db.prepare(`
        SELECT chat_identifier, COALESCE(display_name, chat_identifier) as title
        FROM chat
        WHERE chat_identifier IS NOT NULL
        ORDER BY ROWID DESC
        LIMIT 100
      `).all() as any[];

      return {
        resources: chats.map((c: any) => ({
          uri: `imessage://threads/${encodeURIComponent(c.chat_identifier)}`,
          name: c.title,
          mimeType: "application/json",
        })),
      };
    },
  });

  server.registerResource(
    "imessage-thread",
    threadTemplate,
    {
      description: "Thread messages for a specific chat_id",
      mimeType: "application/json",
    },
    async (_uri, vars) => {
      requireResourceScope("messages.read");
      const db = getDb();
      const chatId = decodeURIComponent(String(vars.chat_id ?? ""));

      const rows = db.prepare(`
        SELECT
          m.ROWID as rowid,
          ${DATE_EXPR} as date,
          m.is_from_me,
          m.text,
          m.attributedBody,
          h.id as handle
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        JOIN chat c ON cmj.chat_id = c.ROWID
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE c.chat_identifier = @chat_id
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
        ORDER BY m.date DESC
        LIMIT 200
      `).all({ chat_id: chatId }) as any[];

      const payload = rows.map((row) => ({
        rowid: row.rowid,
        date: row.date,
        is_from_me: row.is_from_me,
        text: safeText(getMessageText(row)),
        handle: row.handle,
        contact_name: row.handle ? lookupContact(row.handle).name : null,
      }));

      return {
        contents: [
          {
            uri: `imessage://threads/${encodeURIComponent(chatId)}`,
            mimeType: "application/json",
            text: jsonText(payload),
          },
        ],
      };
    },
  );

  const wrappedTemplate = new ResourceTemplate("imessage://analytics/wrapped/{year}", {
    list: undefined,
  });

  server.registerResource(
    "imessage-wrapped",
    wrappedTemplate,
    {
      description: "Yearly wrapped summary metrics",
      mimeType: "application/json",
    },
    async (_uri, vars) => {
      requireResourceScope("analytics.read");
      const year = parseInt(String(vars.year ?? new Date().getFullYear() - 1), 10);
      const start = `${year}-01-01`;
      const end = `${year}-12-31 23:59:59`;
      const db = getDb();

      const summary = db.prepare(`
        SELECT
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
          COUNT(DISTINCT h.id) as unique_contacts
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE ${DATE_EXPR} BETWEEN @start AND @end
          AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
      `).get({ start, end }) as any;

      return {
        contents: [
          {
            uri: `imessage://analytics/wrapped/${year}`,
            mimeType: "application/json",
            text: jsonText({ year, summary }),
          },
        ],
      };
    },
  );
}
