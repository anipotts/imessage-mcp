// dump — export iMessage data to JSON
//
// Usage:
//   imessage-mcp dump                          # all messages (last 1000)
//   imessage-mcp dump --contact "+15551234567"  # filter by contact
//   imessage-mcp dump --from 2024-01-01        # date range
//   imessage-mcp dump --to 2024-12-31
//   imessage-mcp dump --limit 5000             # custom limit
//   imessage-mcp dump --contacts               # export contact list instead

import { getDb, DATE_EXPR, MSG_FILTER, baseMessageConditions, getMessageText } from "../db.js";
import { lookupContact } from "../contacts.js";

interface DumpOptions {
  contact?: string;
  from?: string;
  to?: string;
  limit: number;
  contacts: boolean;
}

function parseArgs(): DumpOptions {
  const args = process.argv.slice(3); // skip node, script, "dump"
  const opts: DumpOptions = { limit: 1000, contacts: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--contact":
        opts.contact = args[++i];
        break;
      case "--from":
        opts.from = args[++i];
        break;
      case "--to":
        opts.to = args[++i];
        break;
      case "--limit":
        opts.limit = parseInt(args[++i]) || 1000;
        break;
      case "--contacts":
        opts.contacts = true;
        break;
      case "--help":
      case "-h":
        console.log(`
imessage-mcp dump — export iMessage data to JSON

Usage:
  imessage-mcp dump [options]

Options:
  --contact <handle>   Filter by contact (phone/email)
  --from <date>        Start date (ISO format, e.g. 2024-01-01)
  --to <date>          End date (ISO format)
  --limit <n>          Max messages (default: 1000)
  --contacts           Export contact list instead of messages
  --help               Show this help

Examples:
  imessage-mcp dump > messages.json
  imessage-mcp dump --contact "+15551234567" --limit 5000
  imessage-mcp dump --from 2024-01-01 --to 2024-12-31
  imessage-mcp dump --contacts > contacts.json
`);
        process.exit(0);
    }
  }

  return opts;
}

function dumpContacts() {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      h.id as handle,
      COUNT(*) as message_count,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received,
      MIN(${DATE_EXPR}) as first_message,
      MAX(${DATE_EXPR}) as last_message
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL) ${MSG_FILTER}
    GROUP BY h.id
    ORDER BY message_count DESC
  `).all() as any[];

  const contacts = rows.map((row: any) => {
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

  console.log(JSON.stringify(contacts, null, 2));
}

function dumpMessages(opts: DumpOptions) {
  const db = getDb();

  const conditions: string[] = baseMessageConditions();
  const bindings: Record<string, any> = {};

  if (opts.contact) {
    conditions.push("h.id LIKE @contact");
    bindings.contact = `%${opts.contact}%`;
  }
  if (opts.from) {
    conditions.push(`${DATE_EXPR} >= @date_from`);
    bindings.date_from = opts.from;
  }
  if (opts.to) {
    conditions.push(`${DATE_EXPR} <= @date_to`);
    bindings.date_to = opts.to;
  }

  const where = conditions.join(" AND ");

  const rows = db.prepare(`
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      m.attributedBody,
      m.is_from_me,
      ${DATE_EXPR} as date,
      h.id as handle,
      c.display_name as group_name,
      c.chat_identifier as chat_id,
      m.cache_has_attachments as has_attachment,
      m.service
    FROM message m
    JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    JOIN chat c ON cmj.chat_id = c.ROWID
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT @limit
  `).all({ ...bindings, limit: opts.limit }) as any[];

  // Post-process: extract text from attributedBody when text is null
  for (const row of rows) {
    row.text = getMessageText(row);
    delete row.attributedBody;
  }

  // Enrich with contact names
  const enriched = rows.map((row: any) => {
    const contact = row.handle ? lookupContact(row.handle) : null;
    return {
      ...row,
      contact_name: contact?.name ?? null,
    };
  });

  const output = {
    exported_at: new Date().toISOString(),
    count: enriched.length,
    filters: {
      contact: opts.contact || null,
      from: opts.from || null,
      to: opts.to || null,
      limit: opts.limit,
    },
    messages: enriched,
  };

  console.log(JSON.stringify(output, null, 2));
}

// Run
const opts = parseArgs();

if (opts.contacts) {
  dumpContacts();
} else {
  dumpMessages(opts);
}
