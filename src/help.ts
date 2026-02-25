// Help system — help tool for imessage-mcp
//
// Provides a comprehensive guide to all 25 tools.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const VERSION = "1.0.0";

function buildHelpText(): string {
  return `# imessage-mcp v${VERSION}

Read-only access to your iMessage database on macOS. 25 tools for searching,
analyzing, and exploring your entire message history.

---

## Tools (25)

### Messages & Conversations
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| search_messages     | Full-text search across all iMessages with filters (query, contact, date, direction, group, attachments) |
| get_conversation    | Full conversation thread with a contact or chat, cursor-based pagination |

### Contacts
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| list_contacts       | All contacts with message counts and date ranges                     |
| get_contact         | Deep info on one contact: stats, yearly breakdown                    |
| resolve_contact     | Fuzzy-match a name/phone/email to a contact record                   |

### Analytics
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| message_stats       | Aggregate stats with time-series grouping (day/week/month/year/hour/dow) |
| contact_stats       | Per-contact deep analytics: volumes, trends, hourly patterns         |
| temporal_heatmap    | 7x24 activity heatmap (day-of-week x hour-of-day)                   |

### Memories
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| on_this_day         | Messages from this date in past years — like "Memories" for iMessage |
| first_last_message  | The very first and very last message exchanged with a contact        |

### Patterns & Insights
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| who_initiates       | Who starts conversations? Initiation ratio per contact               |
| streaks             | Consecutive-day messaging streaks (like Snapchat)                    |
| double_texts        | Detect double-texting and unanswered message patterns                |
| conversation_gaps   | Find the longest silences in a conversation                          |
| forgotten_contacts  | Contacts you used to message but haven't talked to in a long time    |

### Year in Review
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| yearly_wrapped      | Spotify Wrapped for iMessage — complete year summary in one call     |

### Group Chats
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| list_group_chats    | All group chats with member counts and activity                      |
| get_group_chat      | Detailed group info: per-member stats, monthly activity              |

### Attachments
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| list_attachments    | Query attachments (images, videos, audio) by contact, MIME type, date |

### Reactions & Tapbacks
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| get_reactions       | Tapback analytics: love/like/laugh/etc distribution, top reactors    |

### Read Receipts
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| get_read_receipts   | Read/delivery timing: per-contact latency, unread patterns           |

### Reply Threads
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| get_thread          | Reconstruct iMessage reply threads — nested parent/reply trees       |

### Edited & Unsent Messages
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| get_edited_messages | Find edited and unsent (retracted) messages with timing stats        |

### Message Effects
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| get_message_effects | iMessage effects analytics: slam, loud, confetti, fireworks, etc.    |

### System
| Tool                | What it does                                                         |
|---------------------|----------------------------------------------------------------------|
| help                | Show this guide                                                      |

---

## Quick Start Examples

**"How many messages have I sent this year?"**
  → message_stats({ date_from: "2025-01-01", group_by: "month" })

**"Show my conversation with Mom"**
  → get_conversation({ contact: "Mom", limit: 50 })

**"Who reacts to my messages the most?"**
  → get_reactions()

**"What time am I most active?"**
  → temporal_heatmap({ sent_only: true })

**"Show me messages people unsent"**
  → get_edited_messages({ type: "unsent" })

**"What was the first text I sent my partner?"**
  → first_last_message({ contact: "partner name" })

**"What was I texting about on this day last year?"**
  → on_this_day()

**"Do I always text first?"**
  → who_initiates({ contact: "friend name" })

**"What's my longest texting streak?"**
  → streaks()

**"Give me my 2024 iMessage Wrapped"**
  → yearly_wrapped({ year: 2024 })

**"Who have I lost touch with?"**
  → forgotten_contacts()

---

## Tips

- The \`contact\` param does fuzzy matching — "mom", "+1555", or "Jane" all work
- Use \`resolve_contact\` first if you're unsure of the exact handle
- Contact names are resolved from your macOS AddressBook automatically
- All tools are read-only — nothing is modified
- Call \`help()\` anytime to see this guide again

---

## CLI Commands

- \`imessage-mcp\` — Start the MCP server (stdio transport)
- \`imessage-mcp doctor\` — Run setup diagnostics
- \`imessage-mcp dump\` — Export messages to JSON
`;
}

export function registerHelp(server: McpServer) {
  server.tool(
    "help",
    "Show the imessage-mcp guide: all 25 tools and usage examples. Call this when you're unsure what's available.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => ({
      content: [{ type: "text", text: buildHelpText() }],
    }),
  );
}
